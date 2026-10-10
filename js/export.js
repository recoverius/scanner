// Export sheet: build a PDF, JPEG/PNG images or a ZIP, then save or share it.
import { el, icon, openSheet, toast, downloadBlob, shareFiles, canShareFiles, formatBytes, safeFileName } from './ui.js';
import { exportPage } from './render.js';
import { createPdf } from './pdf.js';
import { createZip } from './zip.js';
import * as store from './store.js';

const QUALITY = {
  small: { label: 'Small', hint: 'email', maxDim: 1600, q: 0.7 },
  balanced: { label: 'Balanced', hint: 'default', maxDim: 2400, q: 0.82 },
  high: { label: 'High', hint: 'print', maxDim: 3400, q: 0.92 },
};
const SIZES = [
  { id: 'fit', label: 'Fit', hint: 'image size' },
  { id: 'a4', label: 'A4', hint: '210×297' },
  { id: 'letter', label: 'Letter', hint: '8.5×11' },
  { id: 'legal', label: 'Legal', hint: '8.5×14' },
];

function seg(options, value, onChange) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  for (const o of options) {
    wrap.append(el('button', {
      type: 'button', 'aria-pressed': String(o.id === value), 'data-id': o.id,
      onclick: () => {
        for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.dataset.id === o.id));
        onChange(o.id);
      },
    }, o.label, o.hint ? el('small', { text: o.hint }) : null));
  }
  return wrap;
}

export function openExport({ name, pageIds, initialFormat = 'pdf' }) {
  if (!pageIds.length) { toast('There are no pages to export.'); return; }
  const opts = { format: initialFormat, size: store.settings.pageSize, quality: store.settings.quality };
  openSheet((sheet, close) => {
    const nameInput = el('input', { class: 'text-input', id: 'export-name', value: name, autocomplete: 'off' });
    const sizeField = el('div', { class: 'field' }, el('span', { text: 'Page size' }), seg(SIZES, opts.size, (v) => { opts.size = v; store.saveSettings({ pageSize: v }); }));
    const progress = el('div', { class: 'progress', hidden: true }, el('div'));
    const status = el('p', { class: 'sub', hidden: true });
    const result = el('div', { hidden: true });
    const go = el('button', { class: 'btn primary block', id: 'export-go' });
    const setGoLabel = () => {
      go.textContent = '';
      go.append(icon(opts.format === 'pdf' ? 'pdf' : 'image'), opts.format === 'pdf' ? 'Create PDF' : pageIds.length > 1 ? `Create ${pageIds.length} images` : 'Create image');
    };
    setGoLabel();

    sheet.append(
      el('h3', { text: 'Export' }),
      el('p', { class: 'sub', text: `${pageIds.length} page${pageIds.length === 1 ? '' : 's'}` }),
      el('label', { class: 'field' }, el('span', { text: 'File name' }), nameInput),
      el('div', { class: 'field' }, el('span', { text: 'Format' }), seg([
        { id: 'pdf', label: 'PDF' }, { id: 'jpeg', label: 'JPEG' }, { id: 'png', label: 'PNG' },
      ], opts.format, (v) => { opts.format = v; sizeField.hidden = v !== 'pdf'; setGoLabel(); result.hidden = true; go.hidden = false; })),
      sizeField,
      el('div', { class: 'field' }, el('span', { text: 'Quality' }), seg(Object.entries(QUALITY).map(([id, q]) => ({ id, label: q.label, hint: q.hint })), opts.quality, (v) => { opts.quality = v; store.saveSettings({ quality: v }); })),
      progress, status, result, go,
    );
    sizeField.hidden = opts.format !== 'pdf';

    go.addEventListener('click', async () => {
      go.disabled = true;
      progress.hidden = false;
      status.hidden = false;
      result.hidden = true;
      const bar = progress.firstChild;
      try {
        const files = await build(pageIds, opts, safeFileName(nameInput.value), (done, total) => {
          bar.style.width = `${Math.round((done / total) * 100)}%`;
          status.textContent = done < total ? `Processing page ${done + 1} of ${total}…` : 'Finishing…';
        });
        progress.hidden = true;
        status.hidden = true;
        go.hidden = true;
        showResult(result, files, close);
      } catch (e) {
        console.error(e);
        status.textContent = `Export failed: ${e.message}`;
      } finally {
        go.disabled = false;
      }
    });
  });
}

async function build(pageIds, opts, baseName, onProgress) {
  const q = QUALITY[opts.quality] || QUALITY.balanced;
  const type = opts.format === 'png' ? 'image/png' : 'image/jpeg';
  const rendered = [];
  for (let i = 0; i < pageIds.length; i++) {
    onProgress(i, pageIds.length);
    const page = store.pages.get(pageIds[i]);
    if (!page) continue;
    rendered.push(await exportPage(page, { maxDim: q.maxDim, type, quality: q.q }));
    await new Promise((r) => setTimeout(r));
  }
  onProgress(pageIds.length, pageIds.length);
  if (opts.format === 'pdf') {
    const pdfPages = await Promise.all(rendered.map(async (r) => ({ jpeg: new Uint8Array(await r.blob.arrayBuffer()), width: r.width, height: r.height })));
    // For "Fit", treat the page as roughly letter/A4 width so viewers open it at a sensible zoom.
    const dpi = Math.max(72, Math.round(Math.max(...rendered.map((r) => Math.min(r.width, r.height))) / 8.27));
    const bytes = createPdf(pdfPages, { pageSize: opts.size, dpi, title: baseName, creator: 'Paperwise Scanner', producer: 'Paperwise Scanner' });
    return [new File([bytes], `${baseName}.pdf`, { type: 'application/pdf' })];
  }
  const ext = opts.format === 'png' ? 'png' : 'jpg';
  return rendered.map((r, i) => new File([r.blob], rendered.length > 1 ? `${baseName} - ${String(i + 1).padStart(2, '0')}.${ext}` : `${baseName}.${ext}`, { type }));
}

function showResult(host, files, close) {
  host.hidden = false;
  host.innerHTML = '';
  const total = files.reduce((n, f) => n + f.size, 0);
  const single = files.length === 1;
  host.append(el('div', { class: 'result-card' },
    icon(files[0].type === 'application/pdf' ? 'pdf' : 'image'),
    el('div', {},
      el('strong', { text: single ? files[0].name : `${files.length} images` }),
      el('small', { text: formatBytes(total) }),
    ),
  ));
  const actions = el('div', { class: 'sheet-actions' });
  if (canShareFiles(files[0].type)) {
    actions.append(el('button', {
      class: 'btn primary',
      onclick: async () => {
        const ok = await shareFiles(files, files[0].name);
        if (!ok) toast('Sharing is not available here. Use Save instead.');
      },
    }, icon('share'), 'Share'));
  }
  actions.append(el('button', {
    class: `btn${actions.children.length ? '' : ' primary'}`,
    onclick: async () => {
      try {
        const saved = single
          ? await downloadBlob(files[0], files[0].name)
          : await downloadBlob(await createZipFromFiles(files), `${files[0].name.replace(/ - \d+\.\w+$/, '')}.zip`);
        if (!saved) return;
        toast('Saved to your downloads');
        setTimeout(close, 400);
      } catch (e) {
        toast(e.message, { error: true });
      }
    },
  }, icon('download'), single ? 'Save' : 'Save as ZIP'));
  host.append(actions);
}

async function createZipFromFiles(files) {
  const entries = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  return new Blob([createZip(entries)], { type: 'application/zip' });
}
