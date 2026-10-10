// Page editor: filter presets, manual adjustments, rotate, compare with original, swipe between pages.
import { $, $$, el, toast } from './ui.js';
import { renderPage, imageToCanvas, filterPreviews, getSource } from './render.js';
import * as store from './store.js';

const ADJ_KEYS = ['brightness', 'contrast', 'saturation', 'warmth', 'sharpness', 'threshold'];
let FILTERS = [
  { id: 'original', label: 'Original' },
  { id: 'auto', label: 'Auto' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'invert', label: 'Invert' },
];
import('./imaging.js').then((m) => { if (Array.isArray(m.FILTERS) && m.FILTERS.length) FILTERS = m.FILTERS; }).catch(() => {});

const els = {};
let current = null; // { pageId, docId }
let renderToken = 0;
let saveTimer = 0;
let previewTimer = 0;
let callbacks = {};

export function filterList() { return FILTERS; }

export function initEditor(cb) {
  callbacks = cb;
  Object.assign(els, {
    canvas: $('#edit-canvas'),
    wrap: $('#edit-canvas-wrap'),
    spinner: $('#edit-spinner'),
    strip: $('#filter-strip'),
    adjust: $('#adjust-panel'),
    adjustBtn: $('#edit-adjust'),
    index: $('#edit-index'),
    total: $('#edit-total'),
    prev: $('#edit-prev'),
    next: $('#edit-next'),
    compare: $('#edit-compare'),
  });
  els.adjustBtn.addEventListener('click', () => {
    const open = els.adjust.hidden;
    els.adjust.hidden = !open;
    els.adjustBtn.setAttribute('aria-expanded', String(open));
  });
  for (const key of ADJ_KEYS) {
    const input = $(`#adj-${key}`);
    const out = input.parentElement.querySelector('output');
    input.addEventListener('input', () => {
      out.textContent = input.value;
      const page = store.pages.get(current?.pageId);
      if (!page) return;
      page.adjust = { ...page.adjust, [key]: Number(input.value) };
      schedulePreview(60);
      scheduleSave();
    });
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
  }
  $('#adj-reset').addEventListener('click', () => {
    const page = store.pages.get(current?.pageId);
    if (!page) return;
    page.adjust = {};
    syncSliders(page);
    schedulePreview(0);
    scheduleSave();
  });
  $('#adj-apply-all').addEventListener('click', applyToAll);
  $('#edit-rotate').addEventListener('click', async () => {
    const page = store.pages.get(current?.pageId);
    if (!page) return;
    await store.updatePage(page.id, { rotation: ((page.rotation || 0) + 90) % 360 });
    refresh();
  });
  els.prev.addEventListener('click', () => step(-1));
  els.next.addEventListener('click', () => step(1));

  // Hold to compare with the unprocessed photo.
  const showOriginal = (on) => {
    els.compare.classList.toggle('active', on);
    if (on) drawOriginal(); else refresh(false);
  };
  els.compare.addEventListener('pointerdown', (e) => { e.preventDefault(); showOriginal(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) els.compare.addEventListener(ev, () => { if (els.compare.classList.contains('active')) showOriginal(false); });
  els.compare.addEventListener('contextmenu', (e) => e.preventDefault());

  // Swipe between pages.
  let sx = null;
  let sy = null;
  els.wrap.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  els.wrap.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  document.addEventListener('keydown', (e) => {
    if ($('#view-edit').hidden || e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

function step(dir) {
  const doc = store.docs.get(current?.docId);
  if (!doc) return;
  const i = doc.pageIds.indexOf(current.pageId) + dir;
  if (i < 0 || i >= doc.pageIds.length) return;
  callbacks.navigate?.(doc.pageIds[i]);
}

export function openEditor(pageId) {
  const page = store.pages.get(pageId);
  if (!page) return false;
  flushSave();
  current = { pageId, docId: page.docId };
  const doc = store.docs.get(page.docId);
  const idx = doc.pageIds.indexOf(pageId);
  els.index.textContent = String(idx + 1);
  els.total.textContent = `of ${doc.pageIds.length}`;
  els.prev.disabled = idx <= 0;
  els.next.disabled = idx >= doc.pageIds.length - 1;
  syncSliders(page);
  buildStrip(page);
  refresh();
  return true;
}

export function currentPageId() { return current?.pageId; }

function syncSliders(page) {
  for (const key of ADJ_KEYS) {
    const input = $(`#adj-${key}`);
    const v = page.adjust?.[key] ?? 0;
    input.value = v;
    input.parentElement.querySelector('output').textContent = String(v);
  }
  const bw = page.filter === 'bw';
  $('.slider-row[data-key="threshold"]').hidden = !bw;
  $('.slider-row[data-key="saturation"]').hidden = bw || page.filter === 'gray';
  $('.slider-row[data-key="warmth"]').hidden = bw || page.filter === 'gray';
}

async function buildStrip(page) {
  const token = ++renderToken;
  els.strip.innerHTML = '';
  const chips = FILTERS.map((f) => {
    const c = el('canvas', { width: 62, height: 62 });
    const chip = el('button', {
      class: 'filter-chip', role: 'radio', 'aria-checked': String(page.filter === f.id), 'data-filter': f.id,
      onclick: () => chooseFilter(f.id),
    }, c, el('span', { text: f.label }));
    els.strip.append(chip);
    return { f, c };
  });
  els.strip.querySelector('[aria-checked="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  try {
    const previews = await filterPreviews(page, FILTERS.map((f) => f.id), 150);
    if (token !== renderToken) return;
    previews.forEach((img, i) => {
      const src = imageToCanvas(img);
      const c = chips[i].c;
      c.width = 124; c.height = 124;
      const ctx = c.getContext('2d');
      const s = Math.max(124 / src.width, 124 / src.height);
      ctx.drawImage(src, (124 - src.width * s) / 2, 0, src.width * s, src.height * s);
    });
  } catch (e) {
    console.warn(e);
  }
}

async function chooseFilter(id) {
  const page = store.pages.get(current?.pageId);
  if (!page) return;
  page.filter = id;
  for (const chip of $$('.filter-chip', els.strip)) chip.setAttribute('aria-checked', String(chip.dataset.filter === id));
  syncSliders(page);
  schedulePreview(0);
  scheduleSave();
}

function schedulePreview(delay) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refresh(false), delay);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

export function flushSave() {
  if (!saveTimer || !current) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  const page = store.pages.get(current.pageId);
  if (page) store.updatePage(page.id, { filter: page.filter, adjust: page.adjust });
}

let refreshToken = 0;
let refreshing = false;
let refreshQueued = false;
export async function refresh(showSpinner = true) {
  if (!current) return;
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  const token = ++refreshToken;
  const page = store.pages.get(current.pageId);
  if (!page) { refreshing = false; return; }
  const spin = setTimeout(() => { if (showSpinner) els.spinner.hidden = false; }, 150);
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = els.wrap.getBoundingClientRect();
    const maxDim = Math.min(2000, Math.max(800, Math.round(Math.max(r.width, r.height) * dpr)));
    const img = await renderPage(page, maxDim);
    if (token === refreshToken && current?.pageId === page.id && !els.compare.classList.contains('active')) imageToCanvas(img, els.canvas);
  } catch (e) {
    toast(`Could not render this page: ${e.message}`, { error: true });
  } finally {
    clearTimeout(spin);
    els.spinner.hidden = true;
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refresh(false); }
  }
}

async function drawOriginal() {
  const page = store.pages.get(current?.pageId);
  if (!page) return;
  const img = await getSource(page, 1400);
  if (els.compare.classList.contains('active')) imageToCanvas(img, els.canvas);
}

async function applyToAll() {
  const page = store.pages.get(current?.pageId);
  if (!page) return;
  flushSave();
  const ids = store.docs.get(page.docId).pageIds.filter((id) => id !== page.id);
  for (const id of ids) await store.updatePage(id, { filter: page.filter, adjust: { ...page.adjust } });
  toast(`Applied to ${ids.length + 1} pages`);
}
