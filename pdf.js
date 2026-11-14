'use strict';
/* cleanPDF — lector y unificador de PDF propio. Cero dependencias.
   pdfParse(bytes) → documento { pages, get }   ·   pdfMerge(docs) → Blob */
const { pdfParse, pdfMerge } = (() => {
  class Ref { constructor(n) { this.n = n; } }
  class Name { constructor(s) { this.s = s; } }
  class Raw { constructor(s) { this.s = s; } }        // números, cadenas, true/false/null tal cual
  class Stream { constructor(dict, data) { this.dict = dict; this.data = data; } }

  // Clase de carácter: 1 = espacio en blanco, 2 = delimitador, 0 = regular
  const CT = new Uint8Array(256);
  for (const c of [0, 9, 10, 12, 13, 32]) CT[c] = 1;
  for (const c of '()<>[]{}/%') CT[c.charCodeAt(0)] = 2;

  const latin1 = (b, s, e) => {
    let r = '';
    for (; s < e; s += 8192) r += String.fromCharCode.apply(null, b.subarray(s, Math.min(e, s + 8192)));
    return r;
  };
  const bytesOf = s => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };
  const startsWith = (b, p, s) => {
    for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  const indexOf = (b, s, from) => {
    const c = s.charCodeAt(0);
    for (let i = from, e = b.length - s.length; i <= e; i++) if (b[i] === c && startsWith(b, i, s)) return i;
    return -1;
  };
  const lastIndexOf = (b, s) => {
    for (let i = b.length - s.length; i >= 0; i--) if (startsWith(b, i, s)) return i;
    return -1;
  };
  const num = v => v instanceof Raw ? Number(v.s) : NaN;
  const isName = (v, s) => v instanceof Name && v.s === s;
  const INT = /^\d+$/;

  // ---------- Analizador léxico / sintáctico ----------
  class Lexer {
    constructor(b, p) { this.b = b; this.p = p; }
    skip() {
      const b = this.b;
      for (;;) {
        const c = b[this.p];
        if (CT[c] === 1) this.p++;
        else if (c === 37) while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
        else return;
      }
    }
    token() {
      this.skip();
      const b = this.b, s = this.p;
      while (CT[b[this.p]] === 0) this.p++;
      return latin1(b, s, this.p);
    }
    name() {
      return this.token().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    value(depth = 0) {
      if (depth > 200) throw new Error('anidamiento excesivo');
      this.skip();
      const b = this.b, c = b[this.p], s = this.p;
      if (c === 47) { this.p++; return new Name(this.name()); }
      if (c === 40) { // (cadena literal)
        let d = 0;
        do {
          const ch = b[this.p++];
          if (ch === 92) this.p++; else if (ch === 40) d++; else if (ch === 41) d--;
        } while (d && this.p < b.length);
        return new Raw(latin1(b, s, this.p));
      }
      if (c === 60) {
        if (b[s + 1] !== 60) { // <cadena hex>
          while (this.p < b.length && b[this.p] !== 62) this.p++;
          return new Raw(latin1(b, s, ++this.p));
        }
        this.p += 2;
        const d = new Map();
        for (;;) {
          this.skip();
          if (b[this.p] === 62 && b[this.p + 1] === 62) { this.p += 2; return d; }
          if (b[this.p] !== 47) throw new Error('diccionario inválido');
          this.p++;
          const k = this.name();
          d.set(k, this.value(depth + 1));
        }
      }
      if (c === 91) {
        this.p++;
        const a = [];
        for (;;) {
          this.skip();
          if (b[this.p] === 93) { this.p++; return a; }
          a.push(this.value(depth + 1));
        }
      }
      const t = this.token();
      if (!t) throw new Error('objeto inválido');
      if (INT.test(t)) { // ¿referencia "n g R"?
        const save = this.p, g = this.token();
        if (INT.test(g)) {
          this.skip();
          if (b[this.p] === 82 && CT[b[this.p + 1]] !== 0) { this.p++; return new Ref(+t); }
        }
        this.p = save;
      }
      return new Raw(t);
    }
  }

  // ---------- Inflate (RFC 1950/1951) ----------
  const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const CLORD = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  const huff = lens => {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lens.length);
    for (const l of lens) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < lens.length; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
    return { count, sym };
  };
  let FIXL, FIXD;
  const inflate = src => {
    if ((src[0] & 15) !== 8) throw new Error('flujo zlib inválido');
    let out = new Uint8Array(Math.max(1024, src.length * 4)), n = 0, p = 2, buf = 0, cnt = 0;
    const bits = k => {
      while (cnt < k) {
        if (p >= src.length) throw new Error('flujo comprimido truncado');
        buf |= src[p++] << cnt; cnt += 8;
      }
      const v = buf & ((1 << k) - 1);
      buf >>>= k; cnt -= k;
      return v;
    };
    const decode = h => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = h.count[len];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first = (first + c) << 1; code <<= 1;
      }
      throw new Error('código Huffman inválido');
    };
    const room = k => {
      if (n + k <= out.length) return;
      const o = new Uint8Array(Math.max(out.length * 2, n + k));
      o.set(out.subarray(0, n)); out = o;
    };
    for (let last = 0; !last;) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        buf = cnt = 0;
        const len = src[p] | src[p + 1] << 8;
        p += 4;
        if (p + len > src.length) throw new Error('flujo comprimido truncado');
        room(len);
        out.set(src.subarray(p, p + len), n);
        n += len; p += len;
        continue;
      }
      if (type === 3) throw new Error('bloque deflate inválido');
      let hl, hd;
      if (type === 1) {
        if (!FIXL) {
          const l = new Uint8Array(288);
          l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280);
          FIXL = huff(l); FIXD = huff(new Uint8Array(30).fill(5));
        }
        hl = FIXL; hd = FIXD;
      } else {
        const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < nc; i++) cl[CLORD[i]] = bits(3);
        const hc = huff(cl), lens = new Uint8Array(nl + nd);
        for (let i = 0; i < nl + nd;) {
          const s = decode(hc);
          if (s < 16) { lens[i++] = s; continue; }
          const prev = s === 16 ? lens[i - 1] : 0;
          let rep = s === 16 ? 3 + bits(2) : s === 17 ? 3 + bits(3) : 11 + bits(7);
          if (i + rep > nl + nd) throw new Error('bloque deflate inválido');
          while (rep--) lens[i++] = prev;
        }
        hl = huff(lens.subarray(0, nl)); hd = huff(lens.subarray(nl));
      }
      for (;;) {
        const s = decode(hl);
        if (s === 256) break;
        if (s < 256) { room(1); out[n++] = s; continue; }
        if (s > 285) throw new Error('bloque deflate inválido');
        const len = LBASE[s - 257] + bits(LEXT[s - 257]);
        const ds = decode(hd);
        if (ds > 29) throw new Error('bloque deflate inválido');
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > n) throw new Error('bloque deflate inválido');
        room(len);
        for (let i = 0; i < len; i++, n++) out[n] = out[n - dist];
      }
    }
    return out.subarray(0, n);
  };

  // Predictores PNG (los usan las tablas xref comprimidas)
  const unpredict = (data, parms, resolve) => {
    const val = (k, def) => { const v = num(resolve(parms.get(k))); return v > 0 ? v : def; };
    const pred = val('Predictor', 1);
    if (pred === 1) return data;
    if (pred < 10) throw new Error('predictor no soportado');
    const bits = val('Colors', 1) * val('BitsPerComponent', 8);
    const bpp = Math.ceil(bits / 8), row = Math.ceil(bits * val('Columns', 1) / 8);
    const rows = Math.floor(data.length / (row + 1)), out = new Uint8Array(rows * row);
    for (let y = 0; y < rows; y++) {
      const f = data[y * (row + 1)], s = y * (row + 1) + 1, o = y * row;
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o + x - row] : 0;
        const c = x >= bpp && y ? out[o + x - row - bpp] : 0;
        let v = 0;
        if (f === 1) v = a;
        else if (f === 2) v = b;
        else if (f === 3) v = (a + b) >> 1;
        else if (f === 4) {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[o + x] = data[s + x] + v;
      }
    }
    return out;
  };

  // ---------- Lectura de un documento ----------
  const INHERIT = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  const pdfParse = b => {
    const head = indexOf(b.subarray(0, 1024), '%PDF-', 0);
    if (head < 0) throw new Error('no es un PDF');
    const xref = new Map(), cache = new Map(), stms = new Map();
    let root = null, encrypted = false;

    const resolve = v => {
      for (let i = 0; v instanceof Ref && i < 64; i++) v = get(v.n);
      return v instanceof Ref ? null : v;
    };
    const indirect = (off, n) => {
      const lx = new Lexer(b, off);
      const id = lx.token(), gen = lx.token();
      if (!INT.test(id) || !INT.test(gen) || lx.token() !== 'obj' || (n !== undefined && +id !== n))
        throw new Error('objeto mal ubicado');
      const v = lx.value();
      lx.skip();
      if (!(v instanceof Map) || !startsWith(b, lx.p, 'stream')) return v;
      let s = lx.p + 6;
      if (b[s] === 13) s++;
      if (b[s] === 10) s++;
      const len = num(resolve(v.get('Length')));
      let e = s + len, ok = false;
      if (Number.isInteger(len) && len >= 0 && e <= b.length) {
        let q = e;
        while (CT[b[q]] === 1) q++;
        ok = startsWith(b, q, 'endstream');
      }
      if (!ok) { // /Length incorrecto: buscar el final real
        e = indexOf(b, 'endstream', s);
        if (e < 0) throw new Error('stream sin final');
        if (b[e - 1] === 10) e--;
        if (b[e - 1] === 13) e--;
      }
      return new Stream(v, b.subarray(s, e));
    };
    const decode = st => {
      let f = resolve(st.dict.get('Filter')), pm = resolve(st.dict.get('DecodeParms'));
      f = f == null ? [] : Array.isArray(f) ? f : [f];
      pm = Array.isArray(pm) ? pm : [pm];
      let data = st.data;
      f.forEach((x, i) => {
        x = resolve(x);
        if (!isName(x, 'FlateDecode') && !isName(x, 'Fl')) throw new Error('filtro no soportado');
        data = inflate(data);
        const parms = resolve(pm[i]);
        if (parms instanceof Map) data = unpredict(data, parms, resolve);
      });
      return data;
    };
    const objStm = sn => {
      let c = stms.get(sn);
      if (!c) {
        const st = get(sn);
        if (!(st instanceof Stream)) throw new Error('flujo de objetos inválido');
        const data = decode(st), first = num(st.dict.get('First')), count = num(st.dict.get('N'));
        const lx = new Lexer(data, 0), at = new Map();
        for (let i = 0; i < count; i++) {
          const n = +lx.token(), o = +lx.token();
          if (!at.has(n)) at.set(n, first + o);
        }
        stms.set(sn, c = { data, at });
      }
      return c;
    };
    const get = n => {
      if (cache.has(n)) return cache.get(n);
      cache.set(n, null); // corta ciclos
      const e = xref.get(n);
      let v = null;
      if (e) {
        if (e.s !== undefined) {
          const c = objStm(e.s), o = c.at.get(n);
          if (o !== undefined) v = new Lexer(c.data, o).value();
        } else v = indirect(e.o, n);
      }
      cache.set(n, v);
      return v;
    };
    const trailer = (t, force) => {
      if (t.has('Encrypt')) encrypted = true;
      if (t.get('Root') instanceof Ref && (force || !root)) root = t.get('Root');
    };

    const readXref = () => {
      const sx = lastIndexOf(b, 'startxref');
      if (sx < 0) throw new Error('sin startxref');
      const todo = [+new Lexer(b, sx + 9).token()], seen = new Set();
      while (todo.length) {
        const off = todo.shift();
        if (!(off >= 0) || seen.has(off)) continue;
        seen.add(off);
        const lx = new Lexer(b, off + head);
        lx.skip();
        let t;
        if (startsWith(b, lx.p, 'xref')) { // tabla clásica
          lx.p += 4;
          for (;;) {
            lx.skip();
            if (!(b[lx.p] >= 48 && b[lx.p] <= 57)) break;
            const start = +lx.token(), count = +lx.token();
            for (let i = 0; i < count; i++) {
              const o = +lx.token();
              lx.token();
              const used = lx.token() === 'n';
              if (!xref.has(start + i)) xref.set(start + i, used && o ? { o: o + head } : null);
            }
          }
          if (lx.token() !== 'trailer') throw new Error('sin trailer');
          t = lx.value();
          if (!(t instanceof Map)) throw new Error('trailer inválido');
          todo.unshift(num(t.get('XRefStm')));
        } else { // xref comprimida
          const st = indirect(off + head);
          if (!(st instanceof Stream)) throw new Error('xref inválida');
          t = st.dict;
          const data = decode(st), W = t.get('W').map(num);
          const idx = t.has('Index') ? t.get('Index').map(num) : [0, num(t.get('Size'))];
          let q = 0;
          const rd = w => { let v = 0; while (w--) v = v * 256 + data[q++]; return v; };
          for (let j = 0; j < idx.length; j += 2)
            for (let i = 0; i < idx[j + 1] && q < data.length; i++) {
              const type = W[0] ? rd(W[0]) : 1, f2 = rd(W[1]), f3 = rd(W[2]), n = idx[j] + i;
              if (!xref.has(n)) xref.set(n, type === 1 ? { o: f2 + head } : type === 2 ? { s: f2, i: f3 } : null);
            }
        }
        trailer(t, false);
        todo.push(num(t.get('Prev')));
      }
    };

    // Reconstrucción cuando la tabla xref está dañada: localizar cada "n g obj"
    const rebuild = () => {
      for (let i = 1; i < b.length - 2; i++) {
        if (b[i] !== 111 || b[i + 1] !== 98 || b[i + 2] !== 106 || CT[b[i - 1]] !== 1 || CT[b[i + 3]] === 0) continue;
        let q = i - 1;
        while (CT[b[q]] === 1) q--;
        const ge = q;
        while (b[q] >= 48 && b[q] <= 57) q--;
        if (q === ge || CT[b[q]] !== 1) continue;
        while (CT[b[q]] === 1) q--;
        const ne = q;
        while (b[q] >= 48 && b[q] <= 57) q--;
        if (q === ne) continue;
        xref.set(+latin1(b, q + 1, ne + 1), { o: q + 1 });
      }
      const nums = [...xref.keys()];
      let catalog = null;
      for (const n of nums) {
        let o;
        try { o = get(n); } catch { continue; }
        const d = o instanceof Stream ? o.dict : o;
        if (!(d instanceof Map)) continue;
        const t = d.get('Type');
        if (isName(t, 'Catalog')) catalog = new Ref(n);
        else if (isName(t, 'XRef')) trailer(d, true);
        else if (isName(t, 'ObjStm')) try {
          for (const k of objStm(n).at.keys()) if (!xref.has(k)) { xref.set(k, { s: n }); nums.push(k); }
        } catch { /* flujo ilegible: se ignora */ }
      }
      for (let i = indexOf(b, 'trailer', 0); i >= 0; i = indexOf(b, 'trailer', i + 7)) try {
        const t = new Lexer(b, i + 7).value();
        if (t instanceof Map) trailer(t, true);
      } catch { /* trailer ilegible */ }
      if (!(resolve(root) instanceof Map)) root = catalog;
      cache.clear();
    };

    const collect = () => {
      const pages = [], seen = new Set();
      const walk = (v, inh, depth) => {
        const node = resolve(v);
        if (!(node instanceof Map) || depth > 100) return;
        if (v instanceof Ref) { if (seen.has(v.n)) return; seen.add(v.n); }
        const kids = resolve(node.get('Kids'));
        if (Array.isArray(kids)) {
          const h = { ...inh };
          for (const k of INHERIT) if (node.has(k)) h[k] = node.get(k);
          for (const kid of kids) walk(kid, h, depth + 1);
        } else {
          const d = new Map(node);
          for (const k of INHERIT) if (!d.has(k) && inh[k] !== undefined) d.set(k, inh[k]);
          pages.push({ n: v instanceof Ref ? v.n : 0, dict: d });
        }
      };
      const cat = resolve(root);
      if (!(cat instanceof Map)) throw new Error('sin catálogo');
      walk(cat.get('Pages'), {}, 0);
      if (!pages.length) throw new Error('sin páginas');
      return pages;
    };

    let pages;
    try {
      try { readXref(); pages = collect(); }
      catch {
        xref.clear(); cache.clear(); stms.clear(); root = null;
        rebuild(); pages = collect();
      }
    } catch (e) {
      throw new Error(encrypted ? 'protegido con contraseña' : 'PDF dañado o no soportado');
    }
    if (encrypted) throw new Error('protegido con contraseña');
    return { pages, get };
  };

  // ---------- Escritura del PDF unificado ----------
  const escName = s => s.replace(/[^!-~]|[()<>[\]{}/%#]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  const pdfMerge = docs => {
    const parts = [], offs = [], kids = [];
    let pos = 0, next = 3; // 1 = catálogo, 2 = árbol de páginas
    const put = x => { const u = typeof x === 'string' ? bytesOf(x) : x; parts.push(u); pos += u.length; };
    put('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

    for (const doc of docs) {
      const map = new Map(), queue = []; // nº de objeto original → nuevo
      const ser = v => {
        if (v instanceof Ref) {
          let m = map.get(v.n);
          if (!m) {
            let o;
            try { o = doc.get(v.n); } catch { o = null; }
            // Nunca arrastrar el árbol de páginas original
            if (o == null || (o instanceof Map && isName(o.get('Type'), 'Pages'))) return 'null';
            map.set(v.n, m = next++);
            queue.push(v.n);
          }
          return m + ' 0 R';
        }
        if (v instanceof Name) return '/' + escName(v.s);
        if (v instanceof Raw) return v.s;
        if (Array.isArray(v)) return '[' + v.map(ser).join(' ') + ']';
        if (v instanceof Map) {
          let s = '<<';
          for (const [k, x] of v) s += '/' + escName(k) + ' ' + ser(x);
          return s + '>>';
        }
        return 'null';
      };
      const emit = (m, o) => {
        offs[m] = pos;
        if (o instanceof Stream) {
          const d = new Map(o.dict);
          d.set('Length', new Raw(String(o.data.length)));
          put(`${m} 0 obj\n${ser(d)}\nstream\n`);
          put(o.data);
          put('\nendstream\nendobj\n');
        } else put(`${m} 0 obj\n${ser(o)}\nendobj\n`);
      };

      const own = doc.pages.map(pg => {
        const m = next++;
        if (pg.n) map.set(pg.n, m);
        kids.push(m);
        return m;
      });
      doc.pages.forEach((pg, i) => {
        const d = new Map(pg.dict);
        d.set('Parent', new Raw('2 0 R'));
        emit(own[i], d);
      });
      while (queue.length) {
        const n = queue.pop();
        emit(map.get(n), doc.get(n));
      }
    }

    offs[1] = pos;
    put('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
    offs[2] = pos;
    put(`2 0 obj\n<</Type/Pages/Count ${kids.length}/Kids[${kids.map(k => k + ' 0 R').join(' ')}]>>\nendobj\n`);
    const xpos = pos;
    let x = `xref\n0 ${next}\n0000000000 65535 f \n`;
    for (let i = 1; i < next; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    put(`${x}trailer\n<</Size ${next}/Root 1 0 R>>\nstartxref\n${xpos}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  };

  return { pdfParse, pdfMerge };
})();
