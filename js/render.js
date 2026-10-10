// Rendering pipeline: decode stored originals, run the imaging engine (in a worker when possible),
// and turn results into canvases and blobs for the UI and exports.

let worker = null;
let workerFailed = false;
let seq = 0;
const pending = new Map();
let imagingModule = null;

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      // A module worker that fails to load (old browser) — fall back to the main thread.
      e.preventDefault?.();
      workerFailed = true;
      worker = null;
      for (const [id, p] of pending) { pending.delete(id); p.fallback(); }
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

async function imaging() {
  if (!imagingModule) imagingModule = await import('./imaging.js');
  return imagingModule;
}

async function runLocal(type, payload) {
  const m = await imaging();
  switch (type) {
    case 'process': return m.processPage(payload.img, payload.page);
    case 'detect': return m.detectDocumentCorners(payload.img);
    case 'autocrop': return m.autoCrop(payload.img);
    case 'filters': {
      const base = m.resize(payload.img, payload.size || 160);
      return payload.filters.map((f) => m.applyFilter(base, f, payload.adjust));
    }
    default: throw new Error(`Unknown task ${type}`);
  }
}

function run(type, payload) {
  const w = getWorker();
  if (!w) return runLocal(type, payload);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => runLocal(type, payload).then(resolve, reject) });
    w.postMessage({ id, type, payload });
  });
}

/* ---------- decoding ---------- */

async function decodeToCanvas(blob, maxDim) {
  let source;
  let w;
  let h;
  try {
    source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    w = source.width; h = source.height;
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image.')); };
      img.src = url;
    });
    w = source.naturalWidth; h = source.naturalHeight;
  }
  const scale = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (scale < 0.5) {
    // Two-step downscale avoids aliasing on browsers with poor single-pass resampling.
    const mid = document.createElement('canvas');
    mid.width = Math.round(w * scale * 2); mid.height = Math.round(h * scale * 2);
    const mctx = mid.getContext('2d');
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(source, 0, 0, mid.width, mid.height);
    ctx.drawImage(mid, 0, 0, cw, ch);
  } else {
    ctx.drawImage(source, 0, 0, cw, ch);
  }
  source.close?.();
  return canvas;
}

export function canvasToImage(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: id.width, height: id.height, data: id.data };
}

export function imageToCanvas(img, canvas = document.createElement('canvas')) {
  canvas.width = img.width;
  canvas.height = img.height;
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer || img.data);
  canvas.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

/* ---------- import ---------- */

const MAX_STORED = 4000;

// Normalises any image file: applies EXIF rotation, caps the size, re-encodes as JPEG.
export async function normalizeImport(blob) {
  const canvas = await decodeToCanvas(blob, MAX_STORED);
  const out = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { blob: out, width: canvas.width, height: canvas.height, canvas };
}

/* ---------- cache of decoded sources ---------- */

const cache = new Map();
const CACHE_MAX = 8;

export async function getSource(page, maxDim) {
  const key = `${page.id}:${maxDim}`;
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const p = decodeToCanvas(page.original, maxDim).then(canvasToImage);
  cache.set(key, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  try {
    return await p;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

export function forget(pageId) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${pageId}:`)) cache.delete(key);
}

export async function getSourceCanvas(page, maxDim) {
  return imageToCanvas(await getSource(page, maxDim));
}

function pageParams(page) {
  return { corners: page.corners, rotation: page.rotation || 0, filter: page.filter || 'original', adjust: page.adjust || {} };
}

export async function renderPage(page, maxDim = 1400, overrides = {}) {
  const img = await getSource(page, maxDim);
  return run('process', { img, page: { ...pageParams(page), ...overrides } });
}

export async function renderPageCanvas(page, maxDim, overrides) {
  return imageToCanvas(await renderPage(page, maxDim, overrides));
}

export async function filterPreviews(page, filters, size = 140) {
  const img = await renderPage(page, Math.max(400, size * 2), { filter: 'original', adjust: {} });
  return run('filters', { img, filters, adjust: {}, size });
}

export async function detectCorners(page) {
  const img = await getSource(page, 500);
  return run('autocrop', { img });
}

export function detectInFrame(img) {
  return run('detect', { img });
}

export async function makeThumb(page) {
  const img = await renderPage(page, 900);
  const canvas = imageToCanvas(img);
  const scale = Math.min(1, 420 / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * scale);
  t.height = Math.round(canvas.height * scale);
  const ctx = t.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  return canvasToBlob(t, 'image/jpeg', 0.82);
}

export async function exportPage(page, { maxDim = 2400, type = 'image/jpeg', quality = 0.85 } = {}) {
  const img = await renderPage(page, maxDim);
  const canvas = imageToCanvas(img);
  const blob = await canvasToBlob(canvas, type, quality);
  return { blob, width: canvas.width, height: canvas.height };
}

export function warmUp() {
  getWorker();
}
