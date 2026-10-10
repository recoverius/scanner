// Live camera scanning: viewfinder with real-time edge detection, auto-capture and batch shooting.
import { $, toast, vibrate } from './ui.js';
import { detectInFrame, canvasToBlob, makeThumb } from './render.js';
import * as store from './store.js';

const STABLE_MS = 1100;
const DETECT_SIZE = 360;

let stream = null;
let track = null;
let running = false;
let ctx = null; // { docId, onDone, ensureDoc }
let raf = 0;
let detectBusy = false;
let lastDetectAt = 0;
let smooth = null; // smoothed corners, normalised to frame
let stableSince = 0;
let lastQuad = null;
let needsMoveAway = false;
let lastCaptureAt = 0;
let captured = [];
let capturing = false;
let frameCanvas = null;
let frameCtx = null;
let missCount = 0;

const els = {};

export function initCamera() {
  Object.assign(els, {
    view: $('#view-camera'),
    video: $('#cam-video'),
    overlay: $('#cam-overlay'),
    flash: $('#cam-flash'),
    message: $('#cam-message'),
    status: $('#cam-status'),
    auto: $('#cam-auto'),
    torch: $('#cam-torch'),
    shutter: $('#cam-shutter'),
    ring: $('#shutter-ring'),
    thumb: $('#cam-thumb'),
    thumbImg: $('#cam-thumb-img'),
    count: $('#cam-count'),
    done: $('#cam-done'),
    close: $('#cam-close'),
    importInput: $('#cam-import-input'),
  });
  els.shutter.addEventListener('click', () => capture('manual'));
  els.auto.addEventListener('click', () => {
    const on = els.auto.getAttribute('aria-pressed') !== 'true';
    els.auto.setAttribute('aria-pressed', String(on));
    store.saveSettings({ autoCapture: on });
    resetStability();
    toast(on ? 'Auto capture on: hold steady over a page' : 'Auto capture off: tap the shutter');
  });
  els.torch.addEventListener('click', async () => {
    const on = els.torch.getAttribute('aria-pressed') !== 'true';
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      els.torch.setAttribute('aria-pressed', String(on));
    } catch {
      toast('The light could not be switched on.');
    }
  });
  els.done.addEventListener('click', () => finish());
  els.thumb.addEventListener('click', () => finish());
  els.close.addEventListener('click', () => finish());
  els.importInput.addEventListener('change', async () => {
    const files = [...els.importInput.files];
    els.importInput.value = '';
    if (!files.length) return;
    stopStream();
    ctx?.onImport?.(files);
  });
  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) els.video.pause();
    else els.video.play().catch(() => {});
  });
  window.addEventListener('resize', () => { if (running) sizeOverlay(); });
}

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

export async function openCamera(options) {
  ctx = options;
  captured = [];
  updateCount();
  els.auto.setAttribute('aria-pressed', String(store.settings.autoCapture));
  els.message.hidden = true;
  els.status.hidden = false;
  els.status.textContent = 'Starting camera…';
  els.status.classList.remove('locked');
  resetStability();
  running = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  } catch (err) {
    if (!running) return;
    showError(err);
    return;
  }
  if (!running) { stopStream(); return; }
  track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* optional */ }
  const caps = track.getCapabilities?.() || {};
  els.torch.hidden = !caps.torch;
  els.torch.setAttribute('aria-pressed', 'false');
  els.video.srcObject = stream;
  try { await els.video.play(); } catch { /* autoplay may need the muted attr, already set */ }
  await new Promise((r) => (els.video.videoWidth ? r() : els.video.addEventListener('loadedmetadata', r, { once: true })));
  sizeOverlay();
  els.status.textContent = 'Point at a document';
  loop();
}

function showError(err) {
  els.status.hidden = true;
  const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
  const none = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
  els.message.hidden = false;
  els.message.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = denied ? 'Camera access is blocked' : none ? 'No camera found' : 'The camera could not start';
  const p = document.createElement('p');
  p.textContent = denied
    ? 'Allow camera access for this site in your browser settings, or take a photo with your camera app instead.'
    : 'You can still take a photo with your camera app or import pictures you already have.';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:10px;width:100%;max-width:280px';
  const shoot = document.createElement('button');
  shoot.className = 'btn primary';
  shoot.textContent = 'Use camera app';
  shoot.onclick = () => ctx?.onNativeCapture?.();
  const imp = document.createElement('button');
  imp.className = 'btn';
  imp.textContent = 'Import photos';
  imp.onclick = () => els.importInput.click();
  row.append(shoot, imp);
  els.message.append(h, p, row);
}

function sizeOverlay() {
  const r = els.overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.overlay.width = Math.round(r.width * dpr);
  els.overlay.height = Math.round(r.height * dpr);
}

// Maps normalised frame coordinates to overlay pixels, honouring object-fit: cover.
function frameToOverlay(pt) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const ow = els.overlay.width;
  const oh = els.overlay.height;
  const scale = Math.max(ow / vw, oh / vh);
  const dx = (ow - vw * scale) / 2;
  const dy = (oh - vh * scale) / 2;
  return { x: pt.x * vw * scale + dx, y: pt.y * vh * scale + dy };
}

function resetStability() {
  stableSince = 0;
  lastQuad = null;
  els.ring?.classList.remove('arming');
}

function quadDelta(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

function loop() {
  if (!running) return;
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  if (!detectBusy && now - lastDetectAt > 90 && els.video.readyState >= 2 && !capturing) {
    detectBusy = true;
    lastDetectAt = now;
    detectFrame().finally(() => { detectBusy = false; });
  }
  draw();
}

async function detectFrame() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return;
  const scale = DETECT_SIZE / Math.max(vw, vh);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas');
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (frameCanvas.width !== w || frameCanvas.height !== h) { frameCanvas.width = w; frameCanvas.height = h; }
  frameCtx.drawImage(els.video, 0, 0, w, h);
  const id = frameCtx.getImageData(0, 0, w, h);
  let res = null;
  try {
    res = await detectInFrame({ width: w, height: h, data: id.data });
  } catch {
    res = null;
  }
  if (!running) return;
  const now = performance.now();
  if (res && res.corners && res.confidence > 0.3) {
    missCount = 0;
    const norm = res.corners.map((c) => ({ x: c.x / w, y: c.y / h }));
    if (!smooth) smooth = norm;
    else {
      const jump = quadDelta(smooth, norm) > 0.12;
      smooth = jump ? norm : smooth.map((p, i) => ({ x: p.x * 0.45 + norm[i].x * 0.55, y: p.y * 0.45 + norm[i].y * 0.55 }));
    }
    const steady = lastQuad && quadDelta(lastQuad, norm) < 0.025;
    lastQuad = norm;
    if (needsMoveAway) {
      if (!steady && now - lastCaptureAt > 900) needsMoveAway = false;
      setStatus('Move to the next page', false);
      els.ring.classList.remove('arming');
      stableSince = 0;
      if (now - lastCaptureAt > 4000) needsMoveAway = false;
      return;
    }
    if (steady) {
      if (!stableSince) stableSince = now;
      const auto = els.auto.getAttribute('aria-pressed') === 'true';
      if (auto) {
        setStatus('Hold steady…', true);
        if (!els.ring.classList.contains('arming')) {
          els.ring.style.setProperty('--arm-ms', `${STABLE_MS}ms`);
          els.ring.classList.add('arming');
        }
        if (now - stableSince > STABLE_MS) capture('auto');
      } else {
        setStatus('Document found. Tap to capture', true);
      }
    } else {
      stableSince = 0;
      els.ring.classList.remove('arming');
      setStatus('Document found', true);
    }
  } else {
    missCount++;
    if (missCount > 3) {
      smooth = null;
      lastQuad = null;
      stableSince = 0;
      needsMoveAway = false;
      els.ring.classList.remove('arming');
      setStatus(captured.length ? `${captured.length} captured. Point at the next page` : 'Point at a document', false);
    }
  }
}

function setStatus(text, locked) {
  if (els.status.textContent !== text) els.status.textContent = text;
  els.status.classList.toggle('locked', locked);
}

function draw() {
  const c = els.overlay.getContext('2d');
  c.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!smooth || !els.video.videoWidth) return;
  const pts = smooth.map(frameToOverlay);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  c.fillStyle = 'rgba(25, 211, 180, 0.18)';
  c.fill();
  c.lineWidth = 3 * dpr;
  c.strokeStyle = '#19d3b4';
  c.shadowColor = 'rgba(25, 211, 180, 0.8)';
  c.shadowBlur = 10 * dpr;
  c.stroke();
  c.shadowBlur = 0;
  c.fillStyle = '#ffffff';
  for (const p of pts) {
    c.beginPath();
    c.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2);
    c.fill();
  }
}

async function capture(kind) {
  if (capturing || !running || !els.video.videoWidth) return;
  capturing = true;
  els.ring.classList.remove('arming');
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  canvas.getContext('2d').drawImage(els.video, 0, 0, vw, vh);
  const corners = smooth ? smooth.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })) : null;
  els.flash.classList.remove('go');
  void els.flash.offsetWidth;
  els.flash.classList.add('go');
  vibrate(kind === 'auto' ? [10, 40, 10] : 15);
  try {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const docId = await ctx.ensureDoc();
    const page = await store.addPage(docId, { blob, width: vw, height: vh, corners });
    captured.push(page.id);
    updateCount();
    makeThumb(page).then((t) => {
      const url = URL.createObjectURL(t);
      const old = els.thumbImg.src;
      els.thumbImg.src = url;
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    }).catch(() => {});
  } catch (e) {
    toast(`Capture failed: ${e.message}`, { error: true });
  }
  lastCaptureAt = performance.now();
  needsMoveAway = true;
  stableSince = 0;
  capturing = false;
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

function updateCount() {
  els.count.textContent = String(captured.length);
  els.count.hidden = !captured.length;
  els.thumb.disabled = !captured.length;
  els.done.disabled = false;
  els.done.textContent = captured.length ? `Done (${captured.length})` : 'Cancel';
  if (!captured.length) els.thumbImg.removeAttribute('src');
}

function stopStream() {
  running = false;
  cancelAnimationFrame(raf);
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  track = null;
  els.video.srcObject = null;
  smooth = null;
  resetStability();
}

function finish() {
  const ids = [...captured];
  stopStream();
  ctx?.onDone?.(ids);
}

export function closeCamera() {
  stopStream();
}
