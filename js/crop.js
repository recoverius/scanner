// Crop & flatten editor: drag four corners (or edges) of the page; a loupe magnifies under your finger.
import { $, toast, vibrate } from './ui.js';
import { getSource, imageToCanvas, detectCorners } from './render.js';
import * as store from './store.js';

const PAD = 26;
const FULL = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const SVGNS = 'http://www.w3.org/2000/svg';

const els = {};
let state = null; // { page, src (canvas, unrotated), rotation, corners (orig-normalised), box, onDone }

export function initCrop() {
  Object.assign(els, {
    stage: $('#crop-stage'),
    canvas: $('#crop-canvas'),
    svg: $('#crop-svg'),
    loupe: $('#crop-loupe'),
    hint: $('#crop-hint'),
    done: $('#crop-done'),
    counter: $('#crop-counter'),
  });
  $('#crop-auto').addEventListener('click', autoDetect);
  $('#crop-full').addEventListener('click', () => { if (!state) return; state.corners = FULL.map((p) => ({ ...p })); drawOverlay(); });
  $('#crop-rotate-l').addEventListener('click', () => rotateBy(-90));
  $('#crop-rotate-r').addEventListener('click', () => rotateBy(90));
  els.done.addEventListener('click', save);
  els.svg.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', () => { if (state && !$('#view-crop').hidden) layout(); });
}

// Normalised coordinate transforms between the original image and the rotated display.
function toDisplay(p, r) {
  switch (r) {
    case 90: return { x: 1 - p.y, y: p.x };
    case 180: return { x: 1 - p.x, y: 1 - p.y };
    case 270: return { x: p.y, y: 1 - p.x };
    default: return { x: p.x, y: p.y };
  }
}
function fromDisplay(p, r) {
  switch (r) {
    case 90: return { x: p.y, y: 1 - p.x };
    case 180: return { x: 1 - p.x, y: 1 - p.y };
    case 270: return { x: 1 - p.y, y: p.x };
    default: return { x: p.x, y: p.y };
  }
}

export async function openCrop(page, { onDone, counter = '' } = {}) {
  els.counter.textContent = counter;
  els.canvas.width = 1; els.canvas.height = 1;
  els.svg.innerHTML = '';
  const img = await getSource(page, 1600);
  state = {
    page,
    src: imageToCanvas(img),
    rotation: page.rotation || 0,
    corners: (page.corners || FULL).map((p) => ({ ...p })),
    onDone,
  };
  if (!page.corners) {
    detectCorners(page).then((c) => {
      if (c && state && state.page === page && !state.touched) { state.corners = c; drawOverlay(); }
    }).catch(() => {});
  }
  layout();
}

function rotateBy(deg) {
  if (!state) return;
  state.rotation = (state.rotation + deg + 360) % 360;
  layout();
}

function layout() {
  const { src, rotation } = state;
  const rotated = rotation === 90 || rotation === 270;
  const iw = rotated ? src.height : src.width;
  const ih = rotated ? src.width : src.height;
  const sr = els.stage.getBoundingClientRect();
  const availW = Math.max(50, sr.width - PAD * 2);
  const availH = Math.max(50, sr.height - PAD * 2);
  const scale = Math.min(availW / iw, availH / ih);
  const w = Math.round(iw * scale);
  const h = Math.round(ih * scale);
  const x = Math.round((sr.width - w) / 2);
  const y = Math.round((sr.height - h) / 2);
  // Draw rotated source at display resolution (crisp on high-DPI screens).
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.min(iw, Math.round(w * dpr));
  const ch = Math.round(cw * ih / iw);
  els.canvas.width = cw;
  els.canvas.height = ch;
  const c = els.canvas.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.save();
  c.translate(cw / 2, ch / 2);
  c.rotate((rotation * Math.PI) / 180);
  const dw = rotated ? ch : cw;
  const dh = rotated ? cw : ch;
  c.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  c.restore();
  Object.assign(els.canvas.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  state.box = { x, y, w, h };
  state.displayCanvas = els.canvas;
  drawOverlay();
}

function displayPoints() {
  const { box, corners, rotation } = state;
  return corners.map((p) => {
    const d = toDisplay(p, rotation);
    return { x: box.x + d.x * box.w, y: box.y + d.y * box.h };
  });
}

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function drawOverlay() {
  if (!state?.box) return;
  const pts = displayPoints();
  const { box } = state;
  const valid = isConvex(pts);
  els.done.disabled = !valid;
  els.hint.textContent = valid ? 'Drag the corners to the edges of the page.' : 'The corners cross over. Drag them back into a page shape.';
  const poly = pts.map((p) => `${p.x},${p.y}`).join(' ');
  // Darken the image outside the selected page.
  const shade = `M${box.x},${box.y}h${box.w}v${box.h}h${-box.w}Z M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`;
  const mids = pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, angle: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI };
  });
  els.svg.innerHTML = '';
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    els.svg.append(n);
    return n;
  };
  add('path', { d: shade, class: 'shade' });
  add('polygon', { points: poly, class: `quad${valid ? '' : ' bad'}` });
  mids.forEach((m, i) => {
    add('rect', { x: m.x - 14, y: m.y - 3.5, width: 28, height: 7, rx: 3.5, class: 'handle mid', transform: `rotate(${m.angle} ${m.x} ${m.y})` });
    add('circle', { cx: m.x, cy: m.y, r: 20, class: 'hit', 'data-edge': i });
  });
  pts.forEach((p, i) => {
    add('circle', { cx: p.x, cy: p.y, r: 13, class: 'handle' });
    add('circle', { cx: p.x, cy: p.y, r: 28, class: 'hit', 'data-corner': i });
  });
}

function onPointerDown(e) {
  const target = e.target;
  if (!state || !(target instanceof SVGElement) || !target.classList.contains('hit')) return;
  e.preventDefault();
  state.touched = true;
  const corner = target.dataset.corner != null ? Number(target.dataset.corner) : null;
  const edge = target.dataset.edge != null ? Number(target.dataset.edge) : null;
  const sr = els.stage.getBoundingClientRect();
  const startPts = displayPoints();
  const start = { x: e.clientX - sr.left, y: e.clientY - sr.top };
  // Offset so the corner does not jump to the finger.
  const grabOffset = corner != null ? { x: startPts[corner].x - start.x, y: startPts[corner].y - start.y } : { x: 0, y: 0 };
  els.svg.setPointerCapture(e.pointerId);
  vibrate(8);

  const move = (ev) => {
    const { box, rotation } = state;
    const p = { x: ev.clientX - sr.left, y: ev.clientY - sr.top };
    const clampX = (v) => Math.min(box.x + box.w, Math.max(box.x, v));
    const clampY = (v) => Math.min(box.y + box.h, Math.max(box.y, v));
    const toNorm = (d) => fromDisplay({ x: (d.x - box.x) / box.w, y: (d.y - box.y) / box.h }, rotation);
    if (corner != null) {
      const d = { x: clampX(p.x + grabOffset.x), y: clampY(p.y + grabOffset.y) };
      state.corners[corner] = toNorm(d);
      showLoupe(d, ev);
    } else if (edge != null) {
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      for (const i of [edge, (edge + 1) % 4]) {
        const d = { x: clampX(startPts[i].x + dx), y: clampY(startPts[i].y + dy) };
        state.corners[i] = toNorm(d);
      }
    }
    drawOverlay();
  };
  const up = () => {
    els.svg.removeEventListener('pointermove', move);
    els.svg.removeEventListener('pointerup', up);
    els.svg.removeEventListener('pointercancel', up);
    els.loupe.hidden = true;
  };
  els.svg.addEventListener('pointermove', move);
  els.svg.addEventListener('pointerup', up);
  els.svg.addEventListener('pointercancel', up);
}

function showLoupe(d, ev) {
  const { box } = state;
  const size = 120;
  const zoom = 2.2;
  const src = els.canvas;
  const sx = ((d.x - box.x) / box.w) * src.width;
  const sy = ((d.y - box.y) / box.h) * src.height;
  const ratio = src.width / box.w;
  const span = (size / zoom) * ratio;
  const c = els.loupe.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, size, size);
  c.drawImage(src, sx - span / 2, sy - span / 2, span, span, 0, 0, size, size);
  c.strokeStyle = '#19d3b4';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(size / 2, size / 2 - 14); c.lineTo(size / 2, size / 2 + 14);
  c.moveTo(size / 2 - 14, size / 2); c.lineTo(size / 2 + 14, size / 2);
  c.stroke();
  const sr = els.stage.getBoundingClientRect();
  // Keep the loupe away from the finger: above it, or below when near the top.
  let lx = d.x - size / 2;
  let ly = d.y - size - 50;
  if (ly < 0) ly = d.y + 50;
  lx = Math.min(sr.width - size - 4, Math.max(4, lx));
  Object.assign(els.loupe.style, { left: `${lx}px`, top: `${ly}px` });
  els.loupe.hidden = false;
  void ev;
}

async function autoDetect() {
  if (!state) return;
  const btn = $('#crop-auto');
  btn.disabled = true;
  try {
    const c = await detectCorners(state.page);
    if (c) { state.corners = c; drawOverlay(); toast('Edges found'); } else toast('No page edges found. Drag the corners by hand.');
  } catch (e) {
    toast(`Detection failed: ${e.message}`, { error: true });
  } finally {
    btn.disabled = false;
  }
}

function orderNorm(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Start from the point with the smallest x + y (top-left), keep clockwise order.
  let start = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[start].x + sorted[start].y) start = i; });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

async function save() {
  if (!state) return;
  const { page, rotation } = state;
  // An explicit full-frame quad (rather than null) records that the user chose "no crop".
  const corners = orderNorm(state.corners.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) })));
  await store.updatePage(page.id, { corners, rotation });
  const done = state.onDone;
  state = null;
  done?.();
}

export function cropIsOpen() {
  return !!state;
}
