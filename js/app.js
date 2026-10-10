// Paperwise Scanner: app shell, routing, library and document views, import flows.
import { $, $$, el, icon, toast, menu, confirmDialog, promptDialog, openSheet, closeAllSheets, hasOpenSheet, busy, formatDate, formatBytes, vibrate, downloadBlob, safeFileName } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { normalizeImport, detectCorners, warmUp, exportPage, renderPageCanvas } from './render.js';
import { initCamera, openCamera, closeCamera, cameraSupported } from './camera.js';
import { initCrop, openCrop } from './crop.js';
import { initEditor, openEditor, flushSave, filterList, refresh as refreshEditor } from './editor.js';
import { openExport } from './export.js';

/* ---------- theme ---------- */
function applyTheme() {
  const t = store.settings.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

/* ---------- routing ---------- */
let currentView = null;
let currentDocId = null;
let cropQueue = null; // { ids: [], index, docId }
let pendingImportTarget = null; // docId or 'new'

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'library', id: parts[1] || null };
}

function go(hash, { replace = false } = {}) {
  const depth = (history.state?.depth || 0) + (replace ? 0 : 1);
  if (replace) history.replaceState({ depth }, '', hash);
  else history.pushState({ depth }, '', hash);
  route();
}

function back(fallback = '#/') {
  if ((history.state?.depth || 0) > 0) history.back();
  else go(fallback, { replace: true });
}

function parentOf() {
  const { name, id } = parseHash();
  if (name === 'page') return `#/doc/${store.pages.get(id)?.docId || ''}`;
  if (name === 'crop') return cropQueue?.docId ? `#/doc/${cropQueue.docId}` : `#/doc/${store.pages.get(id)?.docId || ''}`;
  if (name === 'camera' && id && id !== 'new') return `#/doc/${id}`;
  return '#/';
}

function showView(name) {
  for (const v of $$('.view')) {
    const on = v.dataset.view === name;
    if (on && v.hidden) {
      v.hidden = false;
      v.classList.remove('entering');
      void v.offsetWidth;
      v.classList.add('entering');
    } else if (!on) v.hidden = true;
  }
  currentView = name;
}

function route() {
  const { name, id } = parseHash();
  if (currentView === 'camera' && name !== 'camera') closeCamera();
  if (currentView === 'edit' && name !== 'edit') flushSave();
  closeAllSheets();
  switch (name) {
    case 'doc': {
      if (!store.docs.has(id)) return go('#/', { replace: true });
      currentDocId = id;
      exitDocSelection();
      showView('doc');
      renderDoc();
      break;
    }
    case 'page': {
      const page = store.pages.get(id);
      if (!page) return go('#/', { replace: true });
      currentDocId = page.docId;
      showView('edit');
      openEditor(id);
      break;
    }
    case 'crop': {
      const page = store.pages.get(id);
      if (!page) return go('#/', { replace: true });
      showView('crop');
      const counter = cropQueue && cropQueue.ids.length > 1 ? `${cropQueue.index + 1} of ${cropQueue.ids.length}` : '';
      openCrop(page, { counter, onDone: afterCrop });
      break;
    }
    case 'camera': {
      showView('camera');
      startCamera(id === 'new' || !store.docs.has(id) ? null : id);
      break;
    }
    default: {
      exitLibSelection();
      showView('library');
      renderLibrary();
    }
  }
}

function afterCrop() {
  const { id } = parseHash();
  if (cropQueue && cropQueue.index < cropQueue.ids.length - 1) {
    cropQueue.index++;
    go(`#/crop/${cropQueue.ids[cropQueue.index]}`, { replace: true });
    return;
  }
  const docId = cropQueue?.docId || store.pages.get(id)?.docId;
  const fromEditor = !cropQueue;
  cropQueue = null;
  // The crop screen was pushed on top of the page editor or the document, so going back lands there.
  back(fromEditor ? `#/page/${id}` : `#/doc/${docId}`);
}

/* ---------- thumbnails ---------- */
const thumbUrls = new Map(); // pageId -> { blob, url }
function thumbUrl(page) {
  if (!page?.thumb) return null;
  const cached = thumbUrls.get(page.id);
  if (cached && cached.blob === page.thumb) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(page.thumb);
  thumbUrls.set(page.id, { blob: page.thumb, url });
  return url;
}

/* ---------- library ---------- */
const libSel = new Set();
let libSelecting = false;

function renderLibrary() {
  const grid = $('#doc-grid');
  const query = $('#lib-search').value;
  const list = store.sortedDocs($('#lib-sort').value, query);
  const empty = store.docs.size === 0;
  $('#lib-empty').hidden = !empty;
  $('#lib-fabs').hidden = empty || libSelecting;
  $('.lib-tools').hidden = empty;
  $('#lib-select-btn').hidden = empty;
  grid.innerHTML = '';
  grid.classList.toggle('selecting', libSelecting);
  if (!empty && !list.length) {
    grid.append(el('p', { class: 'hint', style: 'grid-column:1/-1', text: `No documents match “${query}”.` }));
  }
  for (const doc of list) {
    const first = store.pages.get(doc.pageIds[0]);
    const url = thumbUrl(first);
    const card = el('button', { class: `doc-card${libSel.has(doc.id) ? ' selected' : ''}`, 'data-doc': doc.id },
      el('div', { class: `doc-thumb${doc.pageIds.length > 1 ? ' stack' : ''}` },
        url ? el('img', { src: url, alt: '', 'data-thumb': first.id, draggable: 'false' }) : el('div', { style: 'width:100%;height:100%;border-radius:14px;background:var(--surface-2)' }),
        el('span', { class: 'doc-badge', text: `${doc.pageIds.length} ${doc.pageIds.length === 1 ? 'page' : 'pages'}` }),
        el('span', { class: 'check' }, icon('check')),
      ),
      el('div', { class: 'doc-info' },
        el('span', { class: 'doc-name', text: doc.name }),
        el('span', { class: 'doc-date', text: formatDate(doc.updatedAt) }),
      ),
    );
    attachPress(card, {
      tap: () => {
        if (libSelecting) toggleLibSel(doc.id);
        else go(`#/doc/${doc.id}`);
      },
      long: () => { if (!libSelecting) enterLibSelection(); toggleLibSel(doc.id, true); },
    });
    grid.append(card);
  }
  updateLibSelBar();
}

function enterLibSelection() {
  libSelecting = true;
  libSel.clear();
  renderLibrary();
}
function exitLibSelection() {
  libSelecting = false;
  libSel.clear();
  $('#lib-selbar').hidden = true;
}
function toggleLibSel(id, force) {
  const on = force ?? !libSel.has(id);
  if (on) libSel.add(id); else libSel.delete(id);
  $(`.doc-card[data-doc="${CSS.escape(id)}"]`)?.classList.toggle('selected', on);
  updateLibSelBar();
}
function updateLibSelBar() {
  $('#lib-selbar').hidden = !libSelecting;
  $('#lib-fabs').hidden = libSelecting || store.docs.size === 0;
  $('#doc-grid').classList.toggle('selecting', libSelecting);
  $('#lib-sel-count').textContent = `${libSel.size} selected`;
  $('#lib-sel-merge').disabled = libSel.size < 2;
  $('#lib-sel-export').disabled = libSel.size < 1;
  $('#lib-sel-delete').disabled = libSel.size < 1;
}

/* ---------- press helper (tap vs long-press) ---------- */
function attachPress(node, { tap, long, onDragStart }) {
  let timer = 0;
  let start = null;
  let longFired = false;
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, e };
    longFired = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      longFired = true;
      vibrate(20);
      if (onDragStart) onDragStart(start.e);
      else long?.();
    }, e.pointerType === 'mouse' ? 450 : 380);
  });
  node.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
      clearTimeout(timer);
      if (e.pointerType === 'mouse' && onDragStart && !longFired) { longFired = true; onDragStart(start.e); }
      start = null;
    }
  });
  const end = () => { clearTimeout(timer); start = null; };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('click', (e) => {
    if (longFired) { e.preventDefault(); longFired = false; return; }
    tap?.(e);
  });
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ---------- document view ---------- */
const docSel = new Set();
let docSelecting = false;
let dragging = null;

function renderDoc() {
  const doc = store.docs.get(currentDocId);
  if (!doc) return;
  $('#doc-title-text').textContent = doc.name;
  $('#doc-meta').textContent = `${doc.pageIds.length} ${doc.pageIds.length === 1 ? 'page' : 'pages'} · ${formatBytes(store.docSize(doc.id))} · edited ${formatDate(doc.updatedAt).toLowerCase()}`;
  const grid = $('#page-grid');
  grid.innerHTML = '';
  grid.classList.toggle('selecting', docSelecting);
  doc.pageIds.forEach((pid, i) => {
    const page = store.pages.get(pid);
    const url = thumbUrl(page);
    const card = el('div', { class: `page-card${docSel.has(pid) ? ' selected' : ''}`, 'data-page': pid, role: 'button', tabindex: '0', 'aria-label': `Page ${i + 1}` },
      el('div', { class: 'page-thumb' },
        url ? el('img', { src: url, alt: '', 'data-thumb': pid, draggable: 'false' }) : el('div', { class: 'spinner' }),
        el('span', { class: 'check' }, icon('check')),
      ),
      el('span', { class: 'page-num', text: String(i + 1).padStart(2, '0') }),
    );
    attachPress(card, {
      tap: () => {
        if (docSelecting) toggleDocSel(pid);
        else go(`#/page/${pid}`);
      },
      onDragStart: (e) => startDrag(card, pid, e),
    });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
    grid.append(card);
  });
  const add = el('button', { class: 'add-tile', onclick: () => addPagesMenu() }, icon('plus'), el('span', { text: 'Add pages' }));
  grid.append(el('div', { class: 'page-card' }, add, el('span', { class: 'page-num', html: '&nbsp;' })));
  $('#doc-hint').hidden = doc.pageIds.length < 2;
  updateDocSelBar();
}

async function addPagesMenu() {
  const choice = await menu('Add pages', [
    { label: 'Scan with camera', icon: 'camera', value: 'scan' },
    { label: 'Import photos', icon: 'image', value: 'import' },
  ]);
  if (choice === 'scan') scan(currentDocId);
  if (choice === 'import') pickFiles(currentDocId);
}

function startDrag(card, pid, e) {
  if (docSelecting) { toggleDocSel(pid); return; }
  const img = card.querySelector('img');
  const ghost = el('div', { class: 'drag-ghost' }, img ? el('img', { src: img.src, alt: '' }) : null);
  document.body.append(ghost);
  card.classList.add('dragging');
  dragging = { pid, card, ghost, target: null, after: false, moved: false, pointerId: e.pointerId };
  const scroller = card.closest('.scroll');
  let scrollTimer = 0;
  const place = (x, y) => {
    ghost.style.left = `${x - 60}px`;
    ghost.style.top = `${y - 80}px`;
    const under = document.elementFromPoint(x, y)?.closest('.page-card[data-page]');
    for (const c of $$('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
    if (under && under !== card) {
      const r = under.getBoundingClientRect();
      const after = x > r.left + r.width / 2;
      under.classList.add(after ? 'drop-after' : 'drop-before');
      dragging.target = under.dataset.page;
      dragging.after = after;
    } else dragging.target = null;
    const sr = scroller.getBoundingClientRect();
    clearInterval(scrollTimer);
    if (y < sr.top + 60) scrollTimer = setInterval(() => { scroller.scrollTop -= 12; }, 16);
    else if (y > sr.bottom - 120) scrollTimer = setInterval(() => { scroller.scrollTop += 12; }, 16);
  };
  place(e.clientX, e.clientY);
  const preventScroll = (ev) => ev.preventDefault();
  const move = (ev) => { dragging.moved = true; place(ev.clientX, ev.clientY); };
  const up = async () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', preventScroll);
    clearInterval(scrollTimer);
    ghost.remove();
    card.classList.remove('dragging');
    for (const c of $$('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
    const d = dragging;
    dragging = null;
    if (d.target) {
      const doc = store.docs.get(currentDocId);
      const ids = doc.pageIds.filter((x) => x !== d.pid);
      let idx = ids.indexOf(d.target);
      if (d.after) idx++;
      ids.splice(idx, 0, d.pid);
      await store.reorderPages(currentDocId, ids);
      renderDoc();
    } else if (!d.moved) {
      // Long-press without moving: start selecting pages.
      enterDocSelection();
      toggleDocSel(d.pid, true);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  document.addEventListener('touchmove', preventScroll, { passive: false });
}

function enterDocSelection() {
  docSelecting = true;
  docSel.clear();
  renderDoc();
}
function exitDocSelection() {
  docSelecting = false;
  docSel.clear();
  $('#doc-selbar').hidden = true;
  $('#doc-bottombar').hidden = false;
  $('#page-grid')?.classList.remove('selecting');
  for (const c of $$('#page-grid .selected')) c.classList.remove('selected');
}
function toggleDocSel(id, force) {
  const on = force ?? !docSel.has(id);
  if (on) docSel.add(id); else docSel.delete(id);
  $(`.page-card[data-page="${CSS.escape(id)}"]`)?.classList.toggle('selected', on);
  updateDocSelBar();
}
function updateDocSelBar() {
  $('#doc-selbar').hidden = !docSelecting;
  $('#doc-bottombar').hidden = docSelecting;
  $('#page-grid').classList.toggle('selecting', docSelecting);
  $('#doc-sel-count').textContent = `${docSel.size} selected`;
  for (const b of ['#doc-sel-rotate', '#doc-sel-move', '#doc-sel-export', '#doc-sel-delete']) $(b).disabled = !docSel.size;
}
function selectedPagesInOrder() {
  const doc = store.docs.get(currentDocId);
  return doc ? doc.pageIds.filter((id) => docSel.has(id)) : [];
}

async function pickDocument(title, excludeId) {
  return new Promise((resolve) => {
    openSheet((sheet, close) => {
      sheet.append(el('h3', { text: title, style: 'margin-bottom:10px' }));
      const list = el('div', { class: 'doc-pick' });
      list.append(el('button', { onclick: () => close('__new') }, el('span', { class: 'new' }, icon('plus')), el('strong', { text: 'New document' })));
      for (const d of store.sortedDocs('updated')) {
        if (d.id === excludeId) continue;
        const url = thumbUrl(store.pages.get(d.pageIds[0]));
        list.append(el('button', { onclick: () => close(d.id) },
          url ? el('img', { src: url, alt: '' }) : el('span', { class: 'ph' }),
          el('span', { style: 'display:flex;flex-direction:column;min-width:0' }, el('strong', { text: d.name }), el('small', { style: 'color:var(--fg-muted)', text: `${d.pageIds.length} pages` }))));
      }
      sheet.append(list);
    }, { onClose: (v) => resolve(v || null) });
  });
}

/* ---------- import & scan ---------- */
function scan(docId) {
  if (cameraSupported() && window.isSecureContext) go(`#/camera/${docId || 'new'}`);
  else nativeCapture(docId);
}

function nativeCapture(docId) {
  pendingImportTarget = docId || 'new';
  $('#capture-input').click();
}

function pickFiles(docId) {
  pendingImportTarget = docId || 'new';
  $('#file-input').click();
}

async function importFiles(files, target) {
  const images = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name));
  if (!images.length) {
    toast('Choose image files (JPEG, PNG, HEIC or WebP).', { error: true });
    return;
  }
  const b = busy(`Importing ${images.length === 1 ? 'photo' : `1 of ${images.length}`}…`);
  let doc = target && target !== 'new' ? store.docs.get(target) : null;
  const added = [];
  try {
    if (!doc) doc = await store.createDoc(images.length === 1 && images[0].name && !/^image\.\w+$/i.test(images[0].name) ? images[0].name.replace(/\.\w+$/, '') : undefined);
    for (let i = 0; i < images.length; i++) {
      b.update(images.length === 1 ? 'Finding page edges…' : `Importing ${i + 1} of ${images.length}…`);
      try {
        const n = await normalizeImport(images[i]);
        const page = await store.addPage(doc.id, { blob: n.blob, width: n.width, height: n.height, corners: null });
        try {
          const corners = await detectCorners(page);
          if (corners) await store.updatePage(page.id, { corners });
        } catch { /* keep uncropped */ }
        added.push(page.id);
      } catch (e) {
        toast(`${images[i].name || 'A file'} could not be imported: ${e.message}`, { error: true });
      }
    }
  } finally {
    b.done();
  }
  if (!added.length) {
    if (!doc.pageIds.length) await store.deleteDocs([doc.id]);
    return;
  }
  toast(`Added ${added.length} ${added.length === 1 ? 'page' : 'pages'} to “${doc.name}”`);
  db.requestPersistence();
  if (store.settings.reviewCrop) {
    if (parseHash().name !== 'doc' || currentDocId !== doc.id) go(`#/doc/${doc.id}`, { replace: parseHash().name === 'camera' });
    startCropReviewPush(added, doc.id);
  } else if (parseHash().name !== 'doc' || currentDocId !== doc.id) {
    go(`#/doc/${doc.id}`, { replace: parseHash().name === 'camera' });
  } else renderDoc();
}

function startCropReviewPush(pageIds, docId) {
  cropQueue = { ids: pageIds, index: 0, docId };
  go(`#/crop/${pageIds[0]}`);
}

let cameraDocId = null;
function startCamera(docId) {
  cameraDocId = docId;
  openCamera({
    ensureDoc: async () => {
      if (!cameraDocId) {
        const doc = await store.createDoc();
        cameraDocId = doc.id;
      }
      return cameraDocId;
    },
    onDone: async (ids) => {
      if (!ids.length) { back(cameraDocId ? `#/doc/${cameraDocId}` : '#/'); return; }
      db.requestPersistence();
      // Pages captured without a detected outline get a second, full-resolution detection pass.
      for (const id of ids) {
        const p = store.pages.get(id);
        if (p && !p.corners) detectCorners(p).then((c) => c && store.updatePage(id, { corners: c })).catch(() => {});
      }
      if (store.settings.reviewCrop) {
        go(`#/doc/${cameraDocId}`, { replace: true });
        startCropReviewPush(ids, cameraDocId);
      } else {
        go(`#/doc/${cameraDocId}`, { replace: true });
      }
    },
    onImport: (files) => importFiles(files, cameraDocId || 'new'),
    onNativeCapture: () => nativeCapture(cameraDocId),
  });
}

/* ---------- OCR ---------- */
let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { tesseractPromise = null; reject(new Error('The text recognition engine could not be downloaded. Check your connection.')); };
      document.head.append(s);
    });
  }
  return tesseractPromise;
}

async function runOcr(pageId) {
  const page = store.pages.get(pageId);
  if (!page) return;
  let cancelled = false;
  openSheet((sheet, close) => {
    const bar = el('div', { class: 'progress' }, el('div'));
    const status = el('p', { class: 'sub', text: 'Loading text recognition…' });
    const body = el('div', {}, bar, status);
    sheet.append(el('h3', { text: 'Text on this page' }), body);
    (async () => {
      try {
        const T = await loadTesseract();
        const canvas = await renderPageCanvas(page, 2200, { filter: page.filter === 'original' ? 'gray' : page.filter });
        const res = await T.recognize(canvas, 'eng', {
          logger: (m) => {
            if (cancelled) return;
            if (m.status === 'recognizing text') { status.textContent = `Reading text… ${Math.round(m.progress * 100)}%`; bar.firstChild.style.width = `${m.progress * 100}%`; } else status.textContent = `${m.status[0].toUpperCase()}${m.status.slice(1)}…`;
          },
        });
        if (cancelled) return;
        const text = res.data.text.trim();
        body.innerHTML = '';
        const ta = el('textarea', { class: 'ocr-text', id: 'ocr-text' });
        ta.value = text || '';
        body.append(
          text ? ta : el('p', { class: 'sub', text: 'No text was found on this page.' }),
          el('div', { class: 'sheet-actions' },
            el('button', { class: 'btn', onclick: () => close() }, 'Close'),
            text ? el('button', {
              class: 'btn primary',
              onclick: async () => {
                try { await navigator.clipboard.writeText(ta.value); toast('Text copied'); } catch { ta.select(); toast('Select the text and copy it'); }
              },
            }, icon('copy'), 'Copy text') : null,
          ),
        );
      } catch (e) {
        status.textContent = e.message;
      }
    })();
  }, { onClose: () => { cancelled = true; } });
}

/* ---------- settings ---------- */
function openSettings() {
  openSheet((sheet) => {
    const s = store.settings;
    const filterSel = el('select', { class: 'text-input', id: 'set-filter' }, filterList().map((f) => el('option', { value: f.id, text: f.label, selected: f.id === s.defaultFilter })));
    filterSel.onchange = () => store.saveSettings({ defaultFilter: filterSel.value });
    const themeSel = el('select', { class: 'text-input', id: 'set-theme' }, [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => el('option', { value: v, text: l, selected: (s.theme || 'system') === v })));
    themeSel.onchange = () => { store.saveSettings({ theme: themeSel.value }); applyTheme(); };
    const sw = (id, label, hint, key) => {
      const input = el('input', { type: 'checkbox', class: 'switch', id, checked: !!s[key] });
      input.onchange = () => store.saveSettings({ [key]: input.checked });
      return el('label', { class: 'switch-row', for: id }, el('div', {}, el('span', { text: label }), el('small', { text: hint })), input);
    };
    const storageNote = el('p', { class: 'storage-note', text: 'Your scans are stored only in this browser.' });
    db.estimate().then((e) => {
      if (e?.usage != null) storageNote.textContent = `Your scans are stored only in this browser. ${formatBytes(e.usage)} used.`;
    });
    sheet.append(
      el('h3', { text: 'Settings', style: 'margin-bottom:14px' }),
      el('label', { class: 'field' }, el('span', { text: 'Default filter for new scans' }), filterSel),
      el('label', { class: 'field' }, el('span', { text: 'Appearance' }), themeSel),
      sw('set-auto', 'Auto capture', 'Take the photo when a page is held steady', 'autoCapture'),
      sw('set-review', 'Review edges after scanning', 'Check the crop of each new page', 'reviewCrop'),
      storageNote,
      el('div', { class: 'sheet-actions' }, el('button', {
        class: 'btn danger',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Delete all scans?', message: `This removes ${store.docs.size} documents from this device. It cannot be undone.`, confirm: 'Delete everything', danger: true });
          if (!ok) return;
          await store.deleteDocs([...store.docs.keys()]);
          closeAllSheets();
          toast('All scans deleted');
          route();
        },
      }, icon('trash'), 'Delete all scans')),
    );
  });
}

/* ---------- wiring ---------- */
function wire() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      if (act === 'scan-new') scan(null);
      if (act === 'import-new') pickFiles(null);
      if (act === 'scan-add') scan(currentDocId);
      if (act === 'import-add') pickFiles(currentDocId);
    }
    const nav = e.target.closest('[data-nav="back"]');
    if (nav) back(parentOf());
  });

  for (const id of ['#file-input', '#capture-input']) {
    $(id).addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) importFiles(files, pendingImportTarget);
    });
  }

  $('#try-sample').addEventListener('click', async () => {
    const b = busy('Preparing a sample page…');
    try {
      const { makeSamplePhoto } = await import('./sample.js');
      const s = await makeSamplePhoto();
      b.done();
      await importFiles([new File([s.blob], 'Sample invoice.jpg', { type: 'image/jpeg' })], 'new');
    } catch (e) {
      b.done();
      toast(`The sample could not be created: ${e.message}`, { error: true });
    }
  });

  // Library
  $('#lib-search').addEventListener('input', renderLibrary);
  $('#lib-sort').addEventListener('change', renderLibrary);
  $('#lib-select-btn').addEventListener('click', () => (libSelecting ? (exitLibSelection(), renderLibrary()) : enterLibSelection()));
  $('#lib-sel-cancel').addEventListener('click', () => { exitLibSelection(); renderLibrary(); });
  $('#lib-settings-btn').addEventListener('click', openSettings);
  $('#lib-sel-merge').addEventListener('click', async () => {
    const ids = store.sortedDocs('created').reverse().map((d) => d.id).filter((id) => libSel.has(id));
    const name = await promptDialog({ title: `Merge ${ids.length} documents`, value: store.docs.get(ids[0]).name, confirm: 'Merge' });
    if (!name) return;
    const merged = await store.mergeDocs(ids, name);
    exitLibSelection();
    toast(`Merged into “${merged.name}”`);
    renderLibrary();
  });
  $('#lib-sel-export').addEventListener('click', () => {
    const ids = store.sortedDocs($('#lib-sort').value).filter((d) => libSel.has(d.id));
    const pageIds = ids.flatMap((d) => d.pageIds);
    openExport({ name: ids.length === 1 ? ids[0].name : `${ids.length} documents`, pageIds });
  });
  $('#lib-sel-delete').addEventListener('click', async () => {
    const n = libSel.size;
    const undo = await store.deleteDocs([...libSel]);
    exitLibSelection();
    renderLibrary();
    toast(`Deleted ${n} ${n === 1 ? 'document' : 'documents'}`, { action: 'Undo', onAction: async () => { await undo(); renderLibrary(); } });
  });

  // Document
  $('#doc-title').addEventListener('click', renameCurrentDoc);
  $('#doc-select-btn').addEventListener('click', () => (docSelecting ? (exitDocSelection(), renderDoc()) : enterDocSelection()));
  $('#doc-sel-cancel').addEventListener('click', () => { exitDocSelection(); renderDoc(); });
  $('#doc-export').addEventListener('click', () => {
    const doc = store.docs.get(currentDocId);
    openExport({ name: doc.name, pageIds: [...doc.pageIds] });
  });
  $('#doc-filter-all').addEventListener('click', async () => {
    const doc = store.docs.get(currentDocId);
    if (!doc.pageIds.length) return;
    const f = await menu('Filter for all pages', filterList().map((x) => ({ label: x.label, value: x.id, icon: 'sliders' })));
    if (!f) return;
    for (const id of doc.pageIds) await store.updatePage(id, { filter: f });
    toast(`${filterList().find((x) => x.id === f)?.label} applied to ${doc.pageIds.length} pages`);
  });
  $('#doc-more-btn').addEventListener('click', async () => {
    const doc = store.docs.get(currentDocId);
    const choice = await menu(null, [
      { label: 'Rename', icon: 'edit', value: 'rename' },
      { label: 'Save as images', icon: 'image', value: 'images' },
      { label: 'Duplicate document', icon: 'copy', value: 'dup' },
      { label: 'Delete document', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'rename') renameCurrentDoc();
    if (choice === 'images') openExport({ name: doc.name, pageIds: [...doc.pageIds], initialFormat: 'jpeg' });
    if (choice === 'dup') {
      const copy = await store.duplicateDoc(doc.id);
      toast(`Created “${copy.name}”`);
      go(`#/doc/${copy.id}`, { replace: true });
    }
    if (choice === 'delete') {
      const undo = await store.deleteDocs([doc.id]);
      go('#/', { replace: true });
      toast(`Deleted “${doc.name}”`, { action: 'Undo', onAction: async () => { await undo(); renderLibrary(); } });
    }
  });
  $('#doc-sel-rotate').addEventListener('click', async () => {
    for (const id of docSel) {
      const p = store.pages.get(id);
      await store.updatePage(id, { rotation: ((p.rotation || 0) + 90) % 360 });
    }
  });
  $('#doc-sel-move').addEventListener('click', async () => {
    const ids = selectedPagesInOrder();
    let target = await pickDocument(`Move ${ids.length} ${ids.length === 1 ? 'page' : 'pages'} to`, currentDocId);
    if (!target) return;
    if (target === '__new') target = (await store.createDoc()).id;
    await store.movePages(ids, target);
    const name = store.docs.get(target).name;
    exitDocSelection();
    const src = store.docs.get(currentDocId);
    if (!src.pageIds.length) {
      await store.deleteDocs([src.id]);
      go(`#/doc/${target}`, { replace: true });
    } else renderDoc();
    toast(`Moved to “${name}”`, { action: 'Open', onAction: () => go(`#/doc/${target}`) });
  });
  $('#doc-sel-export').addEventListener('click', () => {
    const doc = store.docs.get(currentDocId);
    openExport({ name: doc.name, pageIds: selectedPagesInOrder() });
  });
  $('#doc-sel-delete').addEventListener('click', async () => {
    const ids = selectedPagesInOrder();
    const undo = await store.deletePages(ids);
    exitDocSelection();
    renderDoc();
    toast(`Deleted ${ids.length} ${ids.length === 1 ? 'page' : 'pages'}`, { action: 'Undo', onAction: async () => { await undo(); renderDoc(); } });
  });

  // Editor
  $('#edit-crop').addEventListener('click', () => { flushSave(); cropQueue = null; go(`#/crop/${parseHash().id}`); });
  $('#edit-delete').addEventListener('click', () => deleteCurrentPage());
  $('#edit-ocr').addEventListener('click', () => runOcr(parseHash().id));
  $('#edit-more').addEventListener('click', async () => {
    const pid = parseHash().id;
    const page = store.pages.get(pid);
    flushSave();
    const choice = await menu(null, [
      { label: 'Copy text (OCR)', icon: 'text', value: 'ocr' },
      { label: 'Save this page as image', icon: 'download', value: 'save' },
      { label: 'Move to another document', icon: 'folder', value: 'move' },
      { label: 'Duplicate page', icon: 'copy', value: 'dup' },
      { label: 'Delete page', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'ocr') runOcr(pid);
    if (choice === 'save') {
      const b = busy('Preparing image…');
      try {
        const r = await exportPage(page, { maxDim: 3400, quality: 0.9 });
        const doc = store.docs.get(page.docId);
        downloadBlob(r.blob, `${safeFileName(doc.name)} - page ${doc.pageIds.indexOf(pid) + 1}.jpg`);
        toast('Saved to your downloads');
      } finally { b.done(); }
    }
    if (choice === 'move') {
      let target = await pickDocument('Move page to', page.docId);
      if (!target) return;
      if (target === '__new') target = (await store.createDoc()).id;
      const srcId = page.docId;
      await store.movePages([pid], target);
      const src = store.docs.get(srcId);
      if (!src.pageIds.length) await store.deleteDocs([srcId]);
      toast(`Moved to “${store.docs.get(target).name}”`);
      go(`#/doc/${src.pageIds.length ? srcId : target}`, { replace: true });
    }
    if (choice === 'dup') {
      const np = await store.addPage(page.docId, { blob: page.original, width: page.width, height: page.height, corners: page.corners, filter: page.filter, rotation: page.rotation });
      await store.updatePage(np.id, { adjust: { ...page.adjust } });
      const doc = store.docs.get(page.docId);
      doc.pageIds = doc.pageIds.filter((x) => x !== np.id);
      doc.pageIds.splice(doc.pageIds.indexOf(pid) + 1, 0, np.id);
      await store.reorderPages(doc.id, doc.pageIds);
      toast('Page duplicated');
      go(`#/page/${np.id}`, { replace: true });
    }
    if (choice === 'delete') deleteCurrentPage();
  });

  // Keyboard: Escape leaves selection or goes back.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || hasOpenSheet()) return;
    if (libSelecting) { exitLibSelection(); renderLibrary(); return; }
    if (docSelecting) { exitDocSelection(); renderDoc(); return; }
    if (currentView !== 'library' && !e.target.matches('input, textarea')) back(parentOf());
  });

  // Drag & drop and paste to import.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    importFiles([...e.dataTransfer.files], currentView === 'doc' ? currentDocId : 'new');
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || e.target.matches?.('input, textarea')) return;
    e.preventDefault();
    importFiles(files, currentView === 'doc' ? currentDocId : 'new');
  });

  // React to data changes.
  store.onChange((what) => {
    if (what && typeof what === 'object' && what.thumb) {
      const page = store.pages.get(what.thumb);
      const url = thumbUrl(page);
      let found = false;
      for (const img of $$(`img[data-thumb="${CSS.escape(what.thumb)}"]`)) { img.src = url; found = true; }
      if (!found) {
        if (currentView === 'doc' && page?.docId === currentDocId && !dragging) renderDoc();
        if (currentView === 'library') renderLibrary();
      }
      return;
    }
    if (what && typeof what === 'object' && what.page) {
      if (currentView === 'edit' && what.page === parseHash().id) refreshEditor(false);
      return;
    }
    if (currentView === 'library') renderLibrary();
    if (currentView === 'doc' && !dragging) renderDoc();
  });
}

async function renameCurrentDoc() {
  const doc = store.docs.get(currentDocId);
  const name = await promptDialog({ title: 'Rename document', value: doc.name });
  if (name && name !== doc.name) await store.renameDoc(doc.id, name);
}

async function deleteCurrentPage() {
  const pid = parseHash().id;
  const page = store.pages.get(pid);
  if (!page) return;
  const doc = store.docs.get(page.docId);
  const idx = doc.pageIds.indexOf(pid);
  const undo = await store.deletePages([pid]);
  const next = doc.pageIds[Math.min(idx, doc.pageIds.length - 1)];
  if (next) go(`#/page/${next}`, { replace: true });
  else go(`#/doc/${doc.id}`, { replace: true });
  toast('Page deleted', { action: 'Undo', onAction: async () => { await undo(); go(`#/page/${pid}`, { replace: true }); } });
}

/* ---------- boot ---------- */
async function boot() {
  initCamera();
  initCrop();
  initEditor({ navigate: (pid) => go(`#/page/${pid}`, { replace: true }) });
  wire();
  warmUp();
  await store.load();
  if (!history.state) history.replaceState({ depth: 0 }, '', location.hash || '#/');
  const { name } = parseHash();
  // Never resume straight into the camera or crop after a reload.
  if (name === 'camera' || name === 'crop') history.replaceState({ depth: 0 }, '', '#/');
  window.addEventListener('popstate', route);
  route();
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch((e) => {
  console.error(e);
  toast(`Paperwise could not start: ${e.message}`, { error: true, duration: 10000 });
});
