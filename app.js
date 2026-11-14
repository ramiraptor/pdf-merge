'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const input = $('files'), drop = $('drop'), list = $('list'), info = $('info'), merge = $('merge');
  const items = []; // { name, size, doc }
  let note = '', busy = false;

  const human = n => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const action = (label, text, disabled, fn) => {
    const b = el('button', '', text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', () => { note = ''; fn(); render(); });
    return b;
  };

  const render = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = el('li'), name = el('span', 'name', it.name);
      name.title = it.name;
      li.append(
        name,
        el('span', 'meta', `${it.doc.pages.length} pág. · ${human(it.size)}`),
        action(`Subir ${it.name}`, '▲', i === 0, () => items.splice(i - 1, 2, items[i], items[i - 1])),
        action(`Bajar ${it.name}`, '▼', i === items.length - 1, () => items.splice(i, 2, items[i + 1], items[i])),
        action(`Quitar ${it.name}`, '✕', false, () => items.splice(i, 1)));
      return li;
    }));
    merge.disabled = busy || items.length < 2;
    const pages = items.reduce((n, it) => n + it.doc.pages.length, 0);
    info.textContent = note || (
      items.length > 1 ? `${items.length} archivos · ${pages} páginas · se unen en este orden` :
      items.length ? 'Añade al menos otro PDF' : '');
  };

  const add = async files => {
    const errors = [];
    for (const f of files) {
      info.textContent = `Leyendo ${f.name}…`;
      try {
        items.push({ name: f.name, size: f.size, doc: pdfParse(new Uint8Array(await f.arrayBuffer())) });
      } catch (e) {
        errors.push(`${f.name}: ${e.message}`);
      }
    }
    note = errors.length ? '⚠ ' + errors.join(' · ') : '';
    render();
  };

  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  // Soltar en cualquier parte de la página (y evitar que el navegador abra el PDF)
  addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) add([...e.dataTransfer.files]);
  });

  merge.addEventListener('click', () => {
    busy = true;
    note = 'Uniendo…';
    render();
    setTimeout(() => { // deja pintar el estado antes de trabajar
      try {
        const blob = pdfMerge(items.map(it => it.doc));
        const a = document.createElement('a'), url = URL.createObjectURL(blob);
        a.href = url;
        a.download = 'cleanpdf-unido.pdf';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        const pages = items.reduce((n, it) => n + it.doc.pages.length, 0);
        note = `✔ ${items.length} archivos → ${pages} páginas · ${human(blob.size)}`;
      } catch (e) {
        note = `⚠ No se pudo unir: ${e.message}`;
      }
      busy = false;
      render();
    }, 30);
  });
  render();
})();
