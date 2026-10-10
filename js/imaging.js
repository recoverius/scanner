/**
 * imaging.js — image-processing engine for the document scanner.
 *
 * Pure ES module, zero dependencies, no DOM APIs: runs in a module Web Worker
 * and in Node (>= 18). Every image is an ImageData-like plain object
 *   { width, height, data: Uint8ClampedArray }   (RGBA, length = width*height*4)
 * Inputs are never mutated; every function returns a new image with alpha = 255.
 *
 * Coordinate convention for corners: continuous pixel coordinates where the
 * image spans [0, width] x [0, height] (pixel (i, j) covers [i, i+1) x [j, j+1)).
 * A full-frame quad is therefore (0,0) (w,0) (w,h) (0,h).
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const FILTERS = [
  { id: 'original', label: 'Original' },
  { id: 'auto', label: 'Auto' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'invert', label: 'Invert' },
];

export const DEFAULT_ADJUST = Object.freeze({
  brightness: 0, contrast: 0, saturation: 0, sharpness: 0, warmth: 0, threshold: 0,
});

const FILTER_IDS = new Set(FILTERS.map((f) => f.id));

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const ALPHA_MASK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------

/** New blank image (all zero, alpha included — callers set alpha). */
export function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Copy of an image with alpha forced to 255. */
export function cloneImage(img) {
  const data = new Uint8ClampedArray(img.data);
  for (let p = 3; p < data.length; p += 4) data[p] = 255;
  return { width: img.width, height: img.height, data };
}

function u32View(data, n) {
  if (data.byteOffset % 4 === 0) return new Uint32Array(data.buffer, data.byteOffset, n);
  return new Uint32Array(new Uint8ClampedArray(data).buffer, 0, n);
}

/** Luminance (Rec.601) as Uint8Array of length width*height. */
export function toGray(img) {
  const n = img.width * img.height, d = img.data, g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = (77 * d[p] + 150 * d[p + 1] + 29 * d[p + 2] + 128) >> 8;
  }
  return g;
}

/**
 * Box blur (mean filter) of a single-channel Uint8Array with radius r, using
 * running sums (O(1) per pixel, O(width) extra memory). Edges use the mean of
 * the valid part of the window. Returns a new Uint8Array.
 */
export function boxBlur(src, w, h, r) {
  const out = new Uint8Array(w * h);
  if (r < 1) { out.set(src); return out; }
  const col = new Uint32Array(w);
  let rows = 0;
  // prime with rows [0, r-1]
  for (let y = 0; y < Math.min(r, h); y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) col[x] += src[o + x];
    rows++;
  }
  for (let y = 0; y < h; y++) {
    const add = y + r, sub = y - r - 1;
    if (add < h) { const o = add * w; for (let x = 0; x < w; x++) col[x] += src[o + x]; rows++; }
    if (sub >= 0) { const o = sub * w; for (let x = 0; x < w; x++) col[x] -= src[o + x]; rows--; }
    const o = y * w;
    let sum = 0, cnt = 0;
    for (let x = 0; x < Math.min(r, w); x++) { sum += col[x]; cnt++; }
    for (let x = 0; x < w; x++) {
      const a = x + r, s = x - r - 1;
      if (a < w) { sum += col[a]; cnt++; }
      if (s >= 0) { sum -= col[s]; cnt--; }
      out[o + x] = (sum / (cnt * rows) + 0.5) | 0;
    }
  }
  return out;
}

/** Summed-area table (Float64Array, (w+1)*(h+1)) of a single-channel array. */
export function integralImage(src, w, h) {
  const W = w + 1, ii = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + rowSum;
    }
  }
  return ii;
}

function clampNum(v, lo, hi, dflt) {
  v = Number(v);
  if (!Number.isFinite(v)) return dflt;
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeAdjust(adjust) {
  const a = adjust || {};
  return {
    brightness: clampNum(a.brightness, -100, 100, 0),
    contrast: clampNum(a.contrast, -100, 100, 0),
    saturation: clampNum(a.saturation, -100, 100, 0),
    sharpness: clampNum(a.sharpness, 0, 100, 0),
    warmth: clampNum(a.warmth, -100, 100, 0),
    threshold: clampNum(a.threshold, -100, 100, 0),
  };
}

function pctFromHist(hist, total, p) {
  const target = p * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

function histograms(img) {
  const n = img.width * img.height, d = img.data;
  const step = Math.max(1, Math.floor(n / 250000));
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < n; i += step) {
    const p = i * 4, R = d[p], G = d[p + 1], B = d[p + 2];
    r[R]++; g[G]++; b[B]++;
    l[(77 * R + 150 * G + 29 * B + 128) >> 8]++;
    total++;
  }
  return { r, g, b, l, total };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function P(p) { return Array.isArray(p) ? { x: +p[0], y: +p[1] } : { x: +p.x, y: +p.y }; }

/** Order any 4 points as TL, TR, BR, BL (clockwise on screen, starting top-left). */
export function orderCorners(points) {
  const pts = points.slice(0, 4).map(P);
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted by increasing screen angle = clockwise on screen; start at min(x+y)
  let start = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = pts[i].x + pts[i].y;
    if (s < best - 1e-9) { best = s; start = i; }
  }
  return [0, 1, 2, 3].map((k) => pts[(start + k) % 4]);
}

/** True when the 4 points (in order) form a strictly convex, non self-intersecting quad. */
export function isConvexQuad(corners) {
  if (!corners || corners.length !== 4) return false;
  const p = corners.map(P);
  for (const q of p) if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return false;
  let sign = 0;
  let turn = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) return false;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
    let ang = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (ang <= -Math.PI) ang += 2 * Math.PI;
    while (ang > Math.PI) ang -= 2 * Math.PI;
    turn += ang;
  }
  // total turning must be one full revolution (excludes star/bow-tie shapes)
  return Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6;
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], r = q[(i + 1) % 4];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size for a warp: max of opposite edge lengths, rounded, never 0. */
export function estimateOutputSize(corners) {
  const [tl, tr, br, bl] = corners.map(P);
  const w = Math.max(dist(tl, tr), dist(bl, br));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  return {
    width: Math.max(1, Math.round(Number.isFinite(w) ? w : 1)),
    height: Math.max(1, Math.round(Number.isFinite(h) ? h : 1)),
  };
}

/**
 * Homography mapping 4 src points to 4 dst points. Returns a flat 3x3 matrix
 * [h0..h8] (row major, h8 = 1) such that dst ~ H * [x, y, 1]. Returns null for
 * degenerate input.
 */
export function computeHomography(src, dst) {
  const s = src.map(P), t = dst.map(P);
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = s[i], { x: u, y: v } = t[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix
  for (let col = 0; col < 8; col++) {
    let piv = col, max = Math.abs(A[col][col]);
    for (let r = col + 1; r < 8; r++) {
      const v = Math.abs(A[r][col]);
      if (v > max) { max = v; piv = r; }
    }
    if (max < 1e-12) return null;
    if (piv !== col) { const tmp = A[piv]; A[piv] = A[col]; A[col] = tmp; }
    const pr = A[col], inv = 1 / pr[col];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const row = A[r], f = row[col] * inv;
      if (f === 0) continue;
      for (let c = col; c < 9; c++) row[c] -= f * pr[c];
    }
  }
  const h = new Array(9);
  for (let i = 0; i < 8; i++) h[i] = A[i][8] / A[i][i];
  h[8] = 1;
  for (const v of h) if (!Number.isFinite(v)) return null;
  return h;
}

/**
 * Perspective-correct the quad `corners` (TL,TR,BR,BL, pixel coords of img) into
 * an outW x outH image using bilinear sampling (edge-clamped).
 */
export function warpPerspective(img, corners, outW, outH) {
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outH));
  const H = computeHomography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
    corners,
  );
  if (!H) throw new Error('warpPerspective: degenerate corners');
  const w = img.width, h = img.height, src = img.data;
  const out = createImage(outW, outH), dst = out.data;
  const [a, b, c, d, e, f, g, hh, ii] = H;
  const wm1 = w - 1, hm1 = h - 1, stride = w * 4;
  let o = 0;
  for (let j = 0; j < outH; j++) {
    const y = j + 0.5;
    let X = a * 0.5 + b * y + c, Y = d * 0.5 + e * y + f, Z = g * 0.5 + hh * y + ii;
    for (let i = 0; i < outW; i++, o += 4) {
      const iz = 1 / Z;
      let sx = X * iz - 0.5, sy = Y * iz - 0.5;
      X += a; Y += d; Z += g;
      if (!(sx > 0)) sx = 0; else if (sx > wm1) sx = wm1;
      if (!(sy > 0)) sy = 0; else if (sy > hm1) sy = hm1;
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const p00 = y0 * stride + x0 * 4;
      const dx = x0 < wm1 ? 4 : 0, dy = y0 < hm1 ? stride : 0;
      const p10 = p00 + dx, p01 = p00 + dy, p11 = p01 + dx;
      const w11 = fx * fy, w10 = fx - w11, w01 = fy - w11, w00 = 1 - fx - fy + w11;
      dst[o] = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      dst[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      dst[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      dst[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rotate / resize
// ---------------------------------------------------------------------------

/** Rotate clockwise by a multiple of 90 degrees (other values are rounded). */
export function rotate(img, degrees) {
  const q = ((Math.round((Number(degrees) || 0) / 90) % 4) + 4) % 4;
  const w = img.width, h = img.height, n = w * h;
  if (q === 0) return cloneImage(img);
  const src = u32View(img.data, n);
  const ow = q === 2 ? w : h, oh = q === 2 ? h : w;
  const out = createImage(ow, oh);
  const dst = new Uint32Array(out.data.buffer);
  if (q === 1) {
    for (let y = 0; y < h; y++) {
      const col = h - 1 - y, so = y * w;
      for (let x = 0; x < w; x++) dst[x * ow + col] = src[so + x] | ALPHA_MASK;
    }
  } else if (q === 2) {
    for (let i = 0, j = n - 1; i < n; i++, j--) dst[j] = src[i] | ALPHA_MASK;
  } else {
    for (let y = 0; y < h; y++) {
      const so = y * w;
      for (let x = 0; x < w; x++) dst[(w - 1 - x) * ow + y] = src[so + x] | ALPHA_MASK;
    }
  }
  return out;
}

function areaTaps(srcN, dstN) {
  const scale = srcN / dstN;
  const start = new Int32Array(dstN + 1), idx = [], wt = [];
  for (let i = 0; i < dstN; i++) {
    const a = i * scale, b = Math.min(srcN, a + scale);
    start[i] = idx.length;
    for (let s = Math.floor(a); s < b; s++) {
      const lo = Math.max(a, s), hi = Math.min(b, s + 1), v = (hi - lo) / scale;
      if (v > 1e-7) { idx.push(s); wt.push(v); }
    }
  }
  start[dstN] = idx.length;
  return { start, idx: Int32Array.from(idx), wt: Float32Array.from(wt) };
}

/**
 * Downscale so that the longest side is <= maxDim using exact area averaging
 * (box filter). Never upscales; returns a copy when already small enough.
 */
export function resize(img, maxDim) {
  const w = img.width, h = img.height, longest = Math.max(w, h);
  maxDim = Math.max(1, Math.floor(maxDim));
  if (longest <= maxDim) return cloneImage(img);
  const s = maxDim / longest;
  const dw = Math.max(1, Math.min(w, Math.round(w * s))), dh = Math.max(1, Math.min(h, Math.round(h * s)));
  const tx = areaTaps(w, dw), ty = areaTaps(h, dh);
  const src = img.data, out = createImage(dw, dh), dst = out.data;
  const acc = new Float32Array(dw * 3);
  let bufA = new Float32Array(dw * 3), bufB = new Float32Array(dw * 3), rowA = -1, rowB = -1;
  const hrow = (y, buf) => {
    const base = y * w * 4;
    for (let i = 0; i < dw; i++) {
      let r = 0, g = 0, b = 0;
      for (let k = tx.start[i], e = tx.start[i + 1]; k < e; k++) {
        const p = base + tx.idx[k] * 4, v = tx.wt[k];
        r += src[p] * v; g += src[p + 1] * v; b += src[p + 2] * v;
      }
      buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
    }
  };
  for (let j = 0; j < dh; j++) {
    acc.fill(0);
    for (let k = ty.start[j], e = ty.start[j + 1]; k < e; k++) {
      const sy = ty.idx[k], v = ty.wt[k];
      let buf;
      if (sy === rowA) buf = bufA;
      else if (sy === rowB) buf = bufB;
      else { const t = bufA; bufA = bufB; bufB = t; rowA = rowB; hrow(sy, bufB); rowB = sy; buf = bufB; }
      for (let i = 0; i < acc.length; i++) acc[i] += buf[i] * v;
    }
    let o = j * dw * 4;
    for (let i = 0; i < dw; i++, o += 4) {
      dst[o] = acc[i * 3]; dst[o + 1] = acc[i * 3 + 1]; dst[o + 2] = acc[i * 3 + 2]; dst[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document detection
// ---------------------------------------------------------------------------

function morphMax(src, w, h, r) {
  // Separable square max filter, van Herk / Gil-Werman: O(1) per pixel for any r.
  let _t = 0;
  const n = src.length, k = 2 * r + 1, tmp = new Float32Array(n), out = new Float32Array(n);
  const g = new Float32Array(w), hb = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let b0 = 0; b0 < w; b0 += k) {
      const e = Math.min(w, b0 + k);
      let m = src[o + b0]; g[b0] = m;
      for (let i = b0 + 1; i < e; i++) { m = ((_t = src[o + i]) < m ? m : _t); g[i] = m; }
      m = src[o + e - 1]; hb[e - 1] = m;
      for (let i = e - 2; i >= b0; i--) { m = ((_t = src[o + i]) < m ? m : _t); hb[i] = m; }
    }
    for (let i = 0; i < w; i++) {
      const lo = i - r < 0 ? 0 : i - r, hi = i + r >= w ? w - 1 : i + r;
      if (hi - lo + 1 === k) tmp[o + i] = ((_t = g[hi]) < hb[lo] ? hb[lo] : _t);
      else { let m = src[o + lo]; for (let j = lo + 1; j <= hi; j++) m = ((_t = src[o + j]) < m ? m : _t); tmp[o + i] = m; }
    }
  }
  const G = new Float32Array(n), HB = new Float32Array(n);
  for (let b0 = 0; b0 < h; b0 += k) {
    const e = Math.min(h, b0 + k);
    G.set(tmp.subarray(b0 * w, b0 * w + w), b0 * w);
    for (let y = b0 + 1; y < e; y++) { const o = y * w, p = o - w; for (let x = 0; x < w; x++) G[o + x] = ((_t = tmp[o + x]) < G[p + x] ? G[p + x] : _t); }
    HB.set(tmp.subarray((e - 1) * w, e * w), (e - 1) * w);
    for (let y = e - 2; y >= b0; y--) { const o = y * w, p = o + w; for (let x = 0; x < w; x++) HB[o + x] = ((_t = tmp[o + x]) < HB[p + x] ? HB[p + x] : _t); }
  }
  for (let y = 0; y < h; y++) {
    const ylo = y - r < 0 ? 0 : y - r, yhi = y + r >= h ? h - 1 : y + r, o = y * w;
    if (yhi - ylo + 1 === k) {
      const lo = ylo * w, hi = yhi * w;
      for (let x = 0; x < w; x++) out[o + x] = ((_t = G[hi + x]) < HB[lo + x] ? HB[lo + x] : _t);
    } else {
      out.set(tmp.subarray(ylo * w, ylo * w + w), o);
      for (let yy = ylo + 1; yy <= yhi; yy++) { const q = yy * w; for (let x = 0; x < w; x++) out[o + x] = ((_t = tmp[q + x]) < out[o + x] ? out[o + x] : _t); }
    }
  }
  return out;
}

function morphMin(src, w, h, r) {
  // Separable square min filter, van Herk / Gil-Werman: O(1) per pixel for any r.
  let _t = 0;
  const n = src.length, k = 2 * r + 1, tmp = new Float32Array(n), out = new Float32Array(n);
  const g = new Float32Array(w), hb = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let b0 = 0; b0 < w; b0 += k) {
      const e = Math.min(w, b0 + k);
      let m = src[o + b0]; g[b0] = m;
      for (let i = b0 + 1; i < e; i++) { m = ((_t = src[o + i]) > m ? m : _t); g[i] = m; }
      m = src[o + e - 1]; hb[e - 1] = m;
      for (let i = e - 2; i >= b0; i--) { m = ((_t = src[o + i]) > m ? m : _t); hb[i] = m; }
    }
    for (let i = 0; i < w; i++) {
      const lo = i - r < 0 ? 0 : i - r, hi = i + r >= w ? w - 1 : i + r;
      if (hi - lo + 1 === k) tmp[o + i] = ((_t = g[hi]) > hb[lo] ? hb[lo] : _t);
      else { let m = src[o + lo]; for (let j = lo + 1; j <= hi; j++) m = ((_t = src[o + j]) > m ? m : _t); tmp[o + i] = m; }
    }
  }
  const G = new Float32Array(n), HB = new Float32Array(n);
  for (let b0 = 0; b0 < h; b0 += k) {
    const e = Math.min(h, b0 + k);
    G.set(tmp.subarray(b0 * w, b0 * w + w), b0 * w);
    for (let y = b0 + 1; y < e; y++) { const o = y * w, p = o - w; for (let x = 0; x < w; x++) G[o + x] = ((_t = tmp[o + x]) > G[p + x] ? G[p + x] : _t); }
    HB.set(tmp.subarray((e - 1) * w, e * w), (e - 1) * w);
    for (let y = e - 2; y >= b0; y--) { const o = y * w, p = o + w; for (let x = 0; x < w; x++) HB[o + x] = ((_t = tmp[o + x]) > HB[p + x] ? HB[p + x] : _t); }
  }
  for (let y = 0; y < h; y++) {
    const ylo = y - r < 0 ? 0 : y - r, yhi = y + r >= h ? h - 1 : y + r, o = y * w;
    if (yhi - ylo + 1 === k) {
      const lo = ylo * w, hi = yhi * w;
      for (let x = 0; x < w; x++) out[o + x] = ((_t = G[hi + x]) > HB[lo + x] ? HB[lo + x] : _t);
    } else {
      out.set(tmp.subarray(ylo * w, ylo * w + w), o);
      for (let yy = ylo + 1; yy <= yhi; yy++) { const q = yy * w; for (let x = 0; x < w; x++) out[o + x] = ((_t = tmp[q + x]) > out[o + x] ? out[o + x] : _t); }
    }
  }
  return out;
}

/** Separable [1 4 6 4 1]/16 blur on a Float32 plane (edge clamped). */
function blur5(src, w, h) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x > 1 ? x - 2 : 0, xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < w - 1 ? x + 1 : w - 1, xp2 = x < w - 2 ? x + 2 : w - 1;
      tmp[o + x] = (src[o + xm2] + src[o + xp2] + 4 * (src[o + xm1] + src[o + xp1]) + 6 * src[o + x]) * 0.0625;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y > 1 ? y - 2 : 0) * w, ym1 = (y > 0 ? y - 1 : 0) * w;
    const yp1 = (y < h - 1 ? y + 1 : h - 1) * w, yp2 = (y < h - 2 ? y + 2 : h - 1) * w, o = y * w;
    for (let x = 0; x < w; x++) {
      out[o + x] = (tmp[ym2 + x] + tmp[yp2 + x] + 4 * (tmp[ym1 + x] + tmp[yp1 + x]) + 6 * tmp[o + x]) * 0.0625;
    }
  }
  return out;
}

const COS = new Float64Array(180), SIN = new Float64Array(180);
for (let t = 0; t < 180; t++) { COS[t] = Math.cos((t * Math.PI) / 180); SIN[t] = Math.sin((t * Math.PI) / 180); }

function lumaChroma(d, n, L, C) {
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    C[i] = mx - mn;
  }
}

/** Sobel on two planes; per pixel keep the stronger gradient. Returns magnitude histogram. */
function sobel2(L, C, w, h, GX, GY, M) {
  const hist = new Uint32Array(512);
  for (let y = 1; y < h - 1; y++) {
    let i = y * w + 1;
    for (let x = 1; x < w - 1; x++, i++) {
      const a = i - w - 1, b = i - w, c = i - w + 1, dd = i - 1, f = i + 1, g = i + w - 1, k = i + w, l = i + w + 1;
      const lx = L[c] + 2 * L[f] + L[l] - L[a] - 2 * L[dd] - L[g];
      const ly = L[g] + 2 * L[k] + L[l] - L[a] - 2 * L[b] - L[c];
      const cx = C[c] + 2 * C[f] + C[l] - C[a] - 2 * C[dd] - C[g];
      const cy = C[g] + 2 * C[k] + C[l] - C[a] - 2 * C[b] - C[c];
      const ml = lx * lx + ly * ly, mc = cx * cx + cy * cy;
      let m;
      if (ml >= mc) { GX[i] = lx; GY[i] = ly; m = Math.sqrt(ml) * 0.125; }
      else { GX[i] = cx; GY[i] = cy; m = Math.sqrt(mc) * 0.125; }
      M[i] = m;
      let bin = (m * 8) | 0; if (bin > 511) bin = 511;
      hist[bin]++;
    }
  }
  return hist;
}

/** Non-maximum suppression with parabolic sub-pixel offset along the gradient. */
function nonMaxSuppress(GX, GY, M, w, h, low, high, nms, OX, OY) {
  for (let y = 1; y < h - 1; y++) {
    let i = y * w + 1;
    for (let x = 1; x < w - 1; x++, i++) {
      const m = M[i];
      if (m < low) continue;
      const gx = GX[i], gy = GY[i], ax = gx < 0 ? -gx : gx, ay = gy < 0 ? -gy : gy;
      let dx, dy;
      if (ay <= ax * 0.41421356) { dx = 1; dy = 0; }
      else if (ay >= ax * 2.41421356) { dx = 0; dy = 1; }
      else if (gx * gy > 0) { dx = 1; dy = 1; } else { dx = 1; dy = -1; }
      const st = dy * w + dx, m1 = M[i - st], m2 = M[i + st];
      if (m > m1 && m >= m2) {
        nms[i] = m >= high ? 2 : 1;
        const den = m1 - 2 * m + m2;
        let off = den < 0 ? (0.5 * (m1 - m2)) / den : 0;
        if (off > 0.5) off = 0.5; else if (off < -0.5) off = -0.5;
        OX[i] = off * dx; OY[i] = off * dy;
      }
    }
  }
}

function hysteresis(nms, w, n) {
  const edge = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) if (nms[i] === 2) { edge[i] = 1; stack[sp++] = i; }
  // nms is zero on the 1-pixel border, so neighbours of a marked pixel are in range
  const o0 = -w - 1, o1 = -w, o2 = -w + 1, o3 = -1, o4 = 1, o5 = w - 1, o6 = w, o7 = w + 1;
  while (sp > 0) {
    const i = stack[--sp];
    let j;
    j = i + o0; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o1; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o2; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o3; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o4; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o5; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o6; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
    j = i + o7; if (nms[j] && !edge[j]) { edge[j] = 1; stack[sp++] = j; }
  }
  return edge;
}

/** Build the edge context: Canny edges with sub-pixel positions and normals. */
function buildEdges(img) {
  const w = img.width, h = img.height, n = w * h;
  const minDim = Math.min(w, h);
  const L0 = new Float32Array(n), C0 = new Float32Array(n);
  lumaChroma(img.data, n, L0, C0);
  // Remove text/ink: closing on luminance (kills thin dark strokes), opening on chroma.
  const mr = Math.max(2, Math.round(minDim / 90));
  const L = blur5(blur5(morphMin(morphMax(L0, w, h, mr), w, h, mr), w, h), w, h);
  const C = blur5(morphMax(morphMin(C0, w, h, mr), w, h, mr), w, h);

  const GX = new Float32Array(n), GY = new Float32Array(n), M = new Float32Array(n);
  const hist = sobel2(L, C, w, h, GX, GY, M);
  const median = pctFromHist(hist, (w - 2) * (h - 2), 0.5) / 8;
  const high = Math.min(12, Math.max(3, 3.5 * median + 1.5));
  const low = high * 0.45;
  const nms = new Uint8Array(n), OX = new Float32Array(n), OY = new Float32Array(n);
  nonMaxSuppress(GX, GY, M, w, h, low, high, nms, OX, OY);
  const edge = hysteresis(nms, w, n);

  let ne = 0;
  for (let i = 0; i < n; i++) ne += edge[i];
  const EX = new Float32Array(ne), EY = new Float32Array(ne), ENX = new Float32Array(ne), ENY = new Float32Array(ne), EM = new Float32Array(ne);
  const NX = new Float32Array(n), NY = new Float32Array(n);
  let k = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!edge[i]) continue;
      const gx = GX[i], gy = GY[i], m = Math.sqrt(gx * gx + gy * gy) || 1;
      EX[k] = x + 0.5 + OX[i]; EY[k] = y + 0.5 + OY[i];
      ENX[k] = gx / m; ENY[k] = gy / m; EM[k] = M[i];
      NX[i] = ENX[k]; NY[i] = ENY[k];
      k++;
    }
  }
  return { w, h, L, edge, NX, NY, EX, EY, ENX, ENY, EM, ne, high };
}

function houghLines(ctx) {
  const { w, h, EX, EY, ENX, ENY, ne } = ctx;
  const diag = Math.ceil(Math.hypot(w, h)) + 2, RW = 2 * diag + 1;
  const acc = new Float32Array(180 * RW);
  for (let k = 0; k < ne; k++) {
    let phi = (Math.atan2(ENY[k], ENX[k]) * 180) / Math.PI;
    if (phi < 0) phi += 180;
    const t0 = Math.round(phi), x = EX[k], y = EY[k];
    for (let dt = -3; dt <= 3; dt++) {
      let t = t0 + dt;
      if (t < 0) t += 180; else if (t >= 180) t -= 180;
      const r = Math.round(x * COS[t] + y * SIN[t]) + diag;
      acc[t * RW + r] += 1;
    }
  }
  const minDim = Math.min(w, h);
  const minVotes = Math.max(12, 0.12 * minDim);
  const peaks = [];
  for (let t = 0; t < 180; t++) {
    for (let r = 0; r < RW; r++) {
      const v = acc[t * RW + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -2; dt <= 2 && isMax; dt++) {
        let tt = t + dt, rr0 = r;
        if (tt < 0) { tt += 180; rr0 = 2 * diag - r; } else if (tt >= 180) { tt -= 180; rr0 = 2 * diag - r; }
        for (let dr = -3; dr <= 3; dr++) {
          if (dt === 0 && dr === 0) continue;
          const rr = rr0 + dr;
          if (rr < 0 || rr >= RW) continue;
          const u = acc[tt * RW + rr];
          if (u > v || (u === v && (tt * RW + rr) < t * RW + r)) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ t, rho: r - diag, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const lines = [];
  for (const p of peaks) {
    const nx = COS[p.t], ny = SIN[p.t];
    // duplicate suppression (angle within 4 deg and close offset, wrap aware)
    let dup = false;
    for (const q of lines) {
      const dot = nx * q.nx + ny * q.ny;
      if (Math.abs(dot) > Math.cos((4 * Math.PI) / 180)) {
        const rr = dot > 0 ? q.rho : -q.rho;
        if (Math.abs(rr - p.rho) < 6) { dup = true; break; }
      }
    }
    if (dup) continue;
    lines.push({ nx, ny, rho: p.rho, t: p.t, v: p.v });
    if (lines.length >= 18) break;
  }
  return lines;
}

function intersect(l1, l2) {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (l1.rho * l2.ny - l1.ny * l2.rho) / det, y: (l1.nx * l2.rho - l1.rho * l2.nx) / det };
}

function angleDiff(t1, t2) {
  let d = Math.abs(t1 - t2) % 180;
  return d > 90 ? 180 - d : d;
}

function quadsFromLines(lines, w, h) {
  const minDim = Math.min(w, h), cx = w / 2, cy = h / 2;
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (angleDiff(a.t, b.t) > 40) continue;
      // separation measured at the projection of the image centre onto b
      const pb = b.nx * cx + b.ny * cy - b.rho;
      const px = cx - pb * b.nx, py = cy - pb * b.ny;
      const sep = Math.abs(a.nx * px + a.ny * py - a.rho);
      if (sep < 0.2 * minDim) continue;
      const X = intersect(a, b);
      if (X && X.x > -0.1 * w && X.x < 1.1 * w && X.y > -0.1 * h && X.y < 1.1 * h) continue;
      pairs.push([a, b]);
    }
  }
  const quads = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i], [c, d] = pairs[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (Math.min(angleDiff(a.t, c.t), angleDiff(a.t, d.t), angleDiff(b.t, c.t), angleDiff(b.t, d.t)) < 30) continue;
      const p1 = intersect(a, c), p2 = intersect(c, b), p3 = intersect(b, d), p4 = intersect(d, a);
      if (!p1 || !p2 || !p3 || !p4) continue;
      const q = [p1, p2, p3, p4];
      let ok = true;
      for (const p of q) if (p.x < -0.15 * w || p.x > 1.15 * w || p.y < -0.15 * h || p.y > 1.15 * h) { ok = false; break; }
      if (ok) quads.push(q);
    }
  }
  return quads;
}

// Convex hull (Andrew monotone chain), points as flat arrays xs/ys.
function convexHull(pts) {
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Largest-area quad with vertices on a convex polygon (Visvalingam pre-reduction). */
function maxQuadOnHull(hull) {
  let poly = hull.slice();
  if (poly.length < 4) return null;
  const triArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  while (poly.length > 12) {
    let mi = 0, mv = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const v = triArea(poly[(i + poly.length - 1) % poly.length], poly[i], poly[(i + 1) % poly.length]);
      if (v < mv) { mv = v; mi = i; }
    }
    poly.splice(mi, 1);
  }
  const m = poly.length;
  let best = null, ba = -1;
  for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = b + 1; c < m; c++) for (let d = c + 1; d < m; d++) {
    const q = [poly[a], poly[b], poly[c], poly[d]];
    const ar = quadArea(q);
    if (ar > ba) { ba = ar; best = q; }
  }
  return best;
}

function hullQuadFromExtents(minX, maxX, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    if (minX[y] > maxX[y]) continue;
    pts.push({ x: minX[y], y }, { x: minX[y], y: y + 1 }, { x: maxX[y] + 1, y }, { x: maxX[y] + 1, y: y + 1 });
  }
  if (pts.length < 8) return null;
  const hull = convexHull(pts);
  return maxQuadOnHull(hull);
}

/** Label components of `mask` (4- or 8-connected); returns quads for the biggest ones. */
function componentQuads(mask, w, h, conn8, maxComps, minAreaFrac, useBBox) {
  const n = w * h, labels = new Int32Array(n), stack = new Int32Array(n);
  const comps = [];
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let sp = 0, area = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    stack[sp++] = s; labels[s] = next;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const up = y > 0, dn = y < h - 1, lf = x > 0, rt = x < w - 1;
      if (lf && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (rt && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (up && mask[i - w] && !labels[i - w]) { labels[i - w] = next; stack[sp++] = i - w; }
      if (dn && mask[i + w] && !labels[i + w]) { labels[i + w] = next; stack[sp++] = i + w; }
      if (conn8) {
        if (up && lf && mask[i - w - 1] && !labels[i - w - 1]) { labels[i - w - 1] = next; stack[sp++] = i - w - 1; }
        if (up && rt && mask[i - w + 1] && !labels[i - w + 1]) { labels[i - w + 1] = next; stack[sp++] = i - w + 1; }
        if (dn && lf && mask[i + w - 1] && !labels[i + w - 1]) { labels[i + w - 1] = next; stack[sp++] = i + w - 1; }
        if (dn && rt && mask[i + w + 1] && !labels[i + w + 1]) { labels[i + w + 1] = next; stack[sp++] = i + w + 1; }
      }
    }
    const size = useBBox ? (x1 - x0 + 1) * (y1 - y0 + 1) : area;
    if (size >= minAreaFrac * n) comps.push({ label: next, size, y0, y1 });
  }
  comps.sort((a, b) => b.size - a.size);
  const sel = comps.slice(0, maxComps);
  if (!sel.length) return [];
  const slot = new Map(sel.map((c, k) => [c.label, k]));
  const ext = sel.map(() => ({ minX: new Int32Array(h).fill(w), maxX: new Int32Array(h).fill(-1) }));
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const lb = labels[i];
      if (!lb) continue;
      const k = slot.get(lb);
      if (k === undefined) continue;
      const e = ext[k];
      if (x < e.minX[y]) e.minX[y] = x;
      e.maxX[y] = x;
    }
  }
  const quads = [];
  for (const e of ext) {
    const q = hullQuadFromExtents(e.minX, e.maxX, h);
    if (q) quads.push(q);
  }
  return quads;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, t = 0, m0 = 0, m1 = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; m0 = mB; m1 = mF; }
  }
  return { t, m0, m1 };
}

/** 2x2 downsample of a mask (OR) or a Float32 plane (mean). */
function half(src, w, h, isMask) {
  const hw = w >> 1, hh = h >> 1, out = isMask ? new Uint8Array(hw * hh) : new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const r0 = 2 * y * w, r1 = r0 + w, o = y * hw;
    for (let x = 0; x < hw; x++) {
      const a = src[r0 + 2 * x], b = src[r0 + 2 * x + 1], c = src[r1 + 2 * x], d = src[r1 + 2 * x + 1];
      out[o + x] = isMask ? (a | b | c | d) : (a + b + c + d) * 0.25;
    }
  }
  return { data: out, w: hw, h: hh };
}

const scaleQuad = (q, s) => q.map((p) => ({ x: p.x * s, y: p.y * s }));

function segmentationQuads(ctx) {
  const { data: L, w, h } = half(ctx.L, ctx.w, ctx.h, false), n = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { let v = L[i] | 0; if (v > 255) v = 255; else if (v < 0) v = 0; hist[v]++; }
  const { t, m0, m1 } = otsu(hist, n);
  if (m1 - m0 < 20) return [];
  const bright = new Uint8Array(n), dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (L[i] > t) bright[i] = 1; else dark[i] = 1; }
  return componentQuads(bright, w, h, false, 1, 0.1, false)
    .concat(componentQuads(dark, w, h, false, 1, 0.1, false))
    .map((q) => scaleQuad(q, 2));
}

function edgeComponentQuads(ctx) {
  const { data, w, h } = half(ctx.edge, ctx.w, ctx.h, true);
  return componentQuads(data, w, h, true, 3, 0.06, true).map((q) => scaleQuad(q, 2));
}

function scoreQuad(q, ctx, step) {
  const { w, h, edge, NX, NY } = ctx;
  const sup = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const len = dist(a, b);
    if (!(len > 6)) return null;
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len, nx = -dy, ny = dx;
    const ns = Math.max(6, Math.floor((len * 0.9) / step));
    let hits = 0;
    for (let s = 0; s < ns; s++) {
      const tt = (0.05 + (0.9 * (s + 0.5)) / ns) * len;
      const px = a.x + dx * tt, py = a.y + dy * tt;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      for (let o = 0; o <= 4; o++) {
        const off = o === 0 ? 0 : (o & 1 ? (o + 1) >> 1 : -(o >> 1));
        const ix = Math.floor(px + nx * off), iy = Math.floor(py + ny * off);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        const i = iy * w + ix;
        if (edge[i] && Math.abs(NX[i] * nx + NY[i] * ny) > 0.88) { hits++; break; }
      }
    }
    sup[k] = hits / ns;
  }
  const mean = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
  const min = Math.min(sup[0], sup[1], sup[2], sup[3]);
  const conf = mean * Math.sqrt(min);
  const areaFrac = quadArea(q) / (w * h);
  return { conf, score: conf * (0.4 + 0.6 * Math.sqrt(Math.min(1, areaFrac))), sup, areaFrac };
}

function fitLine(ctx, line, a, b, band) {
  const { EX, EY, ENX, ENY, EM, ne } = ctx;
  const len = dist(a, b), dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, cnt = 0;
  for (let k = 0; k < ne; k++) {
    const ex = EX[k], ey = EY[k];
    const dd = line.nx * ex + line.ny * ey - line.rho;
    if (dd > band || dd < -band) continue;
    const t = (ex - a.x) * dx + (ey - a.y) * dy;
    if (t < 0.03 * len || t > 0.97 * len) continue;
    if (Math.abs(ENX[k] * line.nx + ENY[k] * line.ny) < 0.9) continue;
    const wt = EM[k];
    sw += wt; sx += wt * ex; sy += wt * ey; sxx += wt * ex * ex; sxy += wt * ex * ey; syy += wt * ey * ey; cnt++;
  }
  if (cnt < Math.max(8, 0.2 * len)) return line;
  const mx = sx / sw, my = sy / sw;
  const cxx = sxx / sw - mx * mx, cxy = sxy / sw - mx * my, cyy = syy / sw - my * my;
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy); // principal direction
  let nx = -Math.sin(ang), ny = Math.cos(ang);
  if (nx * line.nx + ny * line.ny < 0) { nx = -nx; ny = -ny; }
  return { nx, ny, rho: nx * mx + ny * my };
}

function refineQuad(q, ctx) {
  let lines = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], len = dist(a, b);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    lines.push({ nx, ny, rho: nx * a.x + ny * a.y });
  }
  let cur = q;
  for (const band of [3, 1.5]) {
    lines = lines.map((l, k) => fitLine(ctx, l, cur[k], cur[(k + 1) % 4], band));
    const nq = [];
    for (let k = 0; k < 4; k++) {
      const p = intersect(lines[(k + 3) % 4], lines[k]);
      if (!p) return q;
      nq.push(p);
    }
    if (!isConvexQuad(nq)) return q;
    cur = nq;
  }
  const diag = Math.hypot(ctx.w, ctx.h);
  for (let k = 0; k < 4; k++) if (dist(cur[k], q[k]) > 0.08 * diag) return q;
  return cur;
}

function detectCore(img) {
  const ctx = buildEdges(img);
  const { w, h } = ctx;
  if (ctx.ne < 20) return null;
  const cands = [];
  const add = (q) => {
    if (!q) return;
    const oq = orderCorners(q);
    if (!isConvexQuad(oq)) return;
    const af = quadArea(oq) / (w * h);
    if (af < 0.15 || af > 1.2) return;
    cands.push(oq);
  };
  for (const q of quadsFromLines(houghLines(ctx), w, h)) add(q);
  for (const q of segmentationQuads(ctx)) add(q);
  for (const q of edgeComponentQuads(ctx)) add(q);
  if (!cands.length) return null;

  const coarse = [];
  for (const q of cands) {
    const s = scoreQuad(q, ctx, 4);
    if (s && s.conf > 0.15) coarse.push({ q, s: s.score });
  }
  coarse.sort((a, b) => b.s - a.s);
  let best = null;
  for (const c of coarse.slice(0, 8)) {
    const rq = orderCorners(refineQuad(c.q, ctx));
    const s0 = scoreQuad(c.q, ctx, 1.5), s1 = scoreQuad(rq, ctx, 1.5);
    // prefer the refined (sub-pixel line fit) quad unless it is clearly worse
    const pick = s1 && (!s0 || s1.score >= 0.95 * s0.score) ? { q: rq, ...s1 } : s0 && { q: c.q, ...s0 };
    if (pick && (!best || pick.score > best.score + 0.01)) best = pick;
  }
  if (!best || best.conf < 0.35 || best.areaFrac < 0.15) return null;
  return { corners: best.q, confidence: Math.max(0, Math.min(1, best.conf)) };
}

/**
 * Find the document quadrilateral. Returns { corners: [TL,TR,BR,BL], confidence }
 * in `img` pixel coordinates, or null when nothing plausible is found.
 */
export function detectDocumentCorners(img) {
  if (!img || img.width < 16 || img.height < 16) return null;
  const work = Math.max(img.width, img.height) > 600 ? resize(img, 480) : img;
  const res = detectCore(work);
  if (!res) return null;
  const sx = img.width / work.width, sy = img.height / work.height;
  const corners = res.corners.map((p) => ({
    x: Math.min(img.width, Math.max(0, p.x * sx)),
    y: Math.min(img.height, Math.max(0, p.y * sy)),
  }));
  if (!isConvexQuad(corners) || quadArea(corners) < 0.15 * img.width * img.height) return null;
  return { corners, confidence: res.confidence };
}

/** Convenience: normalised (0..1) corners of the document in img, or null. */
export function autoCrop(img) {
  const small = resize(img, 500);
  const det = detectDocumentCorners(small);
  if (!det) return null;
  return det.corners.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / small.width)),
    y: Math.min(1, Math.max(0, p.y / small.height)),
  }));
}

// ---------------------------------------------------------------------------
// Illumination (background) estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the paper colour/illumination on a coarse grid. Each cell takes the
 * mean colour of its brightest 20% pixels (robust to text), cells much darker
 * than their neighbourhood (covered by ink/photos) are in-painted, then the
 * grid is smoothed. Values are 0..255 floats per channel plus luma.
 */
function estimateBackground(img) {
  const small = resize(img, 400);
  const sw = small.width, sh = small.height, sd = small.data;
  const cs = Math.max(6, Math.round(Math.max(sw, sh) / 36));
  const gw = Math.max(1, Math.round(sw / cs)), gh = Math.max(1, Math.round(sh / cs));
  const gn = gw * gh;
  const R = new Float32Array(gn), G = new Float32Array(gn), B = new Float32Array(gn), Lg = new Float32Array(gn);
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.round((gy * sh) / gh), y1 = Math.round(((gy + 1) * sh) / gh);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.round((gx * sw) / gw), x1 = Math.round(((gx + 1) * sw) / gw);
      hist.fill(0);
      let cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = (y * sw + x) * 4;
        hist[(77 * sd[p] + 150 * sd[p + 1] + 29 * sd[p + 2] + 128) >> 8]++; cnt++;
      }
      const k = Math.max(1, Math.ceil(cnt * 0.2));
      let thr = 255, acc = 0;
      for (; thr > 0; thr--) { acc += hist[thr]; if (acc >= k) break; }
      let r = 0, g = 0, b = 0, m = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = (y * sw + x) * 4;
        const l = (77 * sd[p] + 150 * sd[p + 1] + 29 * sd[p + 2] + 128) >> 8;
        if (l >= thr) { r += sd[p]; g += sd[p + 1]; b += sd[p + 2]; m++; }
      }
      const c = gy * gw + gx;
      m = m || 1;
      R[c] = r / m; G[c] = g / m; B[c] = b / m;
      Lg[c] = 0.299 * R[c] + 0.587 * G[c] + 0.114 * B[c];
    }
  }
  // Global paper level (90th percentile of cell luma)
  const sorted = Float32Array.from(Lg).sort();
  const paper = sorted[Math.min(gn - 1, Math.floor(gn * 0.9))] || 1;
  // Invalidate cells that are much darker than their neighbourhood
  const valid = new Uint8Array(gn);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let mx = 0;
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++)
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) mx = Math.max(mx, Lg[yy * gw + xx]);
    const c = gy * gw + gx;
    valid[c] = Lg[c] >= 0.6 * mx && Lg[c] >= 0.3 * paper ? 1 : 0;
  }
  // In-paint invalid cells from valid neighbours
  for (let iter = 0; iter < gw + gh; iter++) {
    let changed = 0, left = 0;
    const nv = valid.slice();
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const c = gy * gw + gx;
      if (valid[c]) continue;
      let r = 0, g = 0, b = 0, m = 0;
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++)
        for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) {
          const o = yy * gw + xx;
          if (valid[o]) { r += R[o]; g += G[o]; b += B[o]; m++; }
        }
      if (m) { R[c] = r / m; G[c] = g / m; B[c] = b / m; nv[c] = 1; changed++; } else left++;
    }
    valid.set(nv);
    if (!left || !changed) break;
  }
  // Smooth with a [1 2 1] kernel (separable), twice
  const smooth = (A) => {
    const T = new Float32Array(gn);
    for (let pass = 0; pass < 2; pass++) {
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const l = gx > 0 ? gx - 1 : 0, r = gx < gw - 1 ? gx + 1 : gw - 1, o = gy * gw;
        T[o + gx] = (A[o + l] + 2 * A[o + gx] + A[o + r]) * 0.25;
      }
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const u = gy > 0 ? gy - 1 : 0, dn = gy < gh - 1 ? gy + 1 : gh - 1;
        A[gy * gw + gx] = (T[u * gw + gx] + 2 * T[gy * gw + gx] + T[dn * gw + gx]) * 0.25;
      }
    }
  };
  smooth(R); smooth(G); smooth(B);
  const floor = Math.max(10, 0.12 * paper);
  for (let c = 0; c < gn; c++) {
    if (R[c] < floor) R[c] = floor; if (G[c] < floor) G[c] = floor; if (B[c] < floor) B[c] = floor;
    Lg[c] = 0.299 * R[c] + 0.587 * G[c] + 0.114 * B[c];
  }
  // Histogram of normalised luma on the small image (for black-point selection)
  const nh = new Uint32Array(256);
  let ntot = 0;
  {
    const sampler = bgSampler({ gw, gh, R, G, B, L: Lg }, sw, sh);
    const rl = new Float32Array(sw);
    for (let y = 0; y < sh; y++) {
      sampler(y, null, null, null, rl);
      for (let x = 0; x < sw; x++) {
        const p = (y * sw + x) * 4;
        const l = 0.299 * sd[p] + 0.587 * sd[p + 1] + 0.114 * sd[p + 2];
        let v = ((l / rl[x]) * 200) | 0; if (v > 255) v = 255;
        nh[v]++; ntot++;
      }
    }
  }
  return { gw, gh, R, G, B, L: Lg, normHist: nh, normTotal: ntot };
}

/**
 * Returns fn(y, outR, outG, outB, outL) which fills full-resolution row y of
 * the bilinearly-upsampled background (any output may be null).
 */
function bgSampler(bg, w, h) {
  const { gw, gh } = bg;
  const xi = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let f = ((x + 0.5) * gw) / w - 0.5;
    if (f < 0) f = 0; if (f > gw - 1) f = gw - 1;
    let i = Math.floor(f); if (i > gw - 2) i = Math.max(0, gw - 2);
    xi[x] = i; xt[x] = gw > 1 ? f - i : 0;
  }
  const rows = [new Float32Array(gw), new Float32Array(gw), new Float32Array(gw), new Float32Array(gw)];
  const chans = [bg.R, bg.G, bg.B, bg.L];
  return (y, oR, oG, oB, oL) => {
    let f = ((y + 0.5) * gh) / h - 0.5;
    if (f < 0) f = 0; if (f > gh - 1) f = gh - 1;
    let j = Math.floor(f); if (j > gh - 2) j = Math.max(0, gh - 2);
    const t = gh > 1 ? f - j : 0, j1 = gh > 1 ? j + 1 : j;
    const outs = [oR, oG, oB, oL];
    for (let c = 0; c < 4; c++) {
      const o = outs[c];
      if (!o) continue;
      const A = chans[c], row = rows[c];
      for (let i = 0; i < gw; i++) row[i] = A[j * gw + i] + (A[j1 * gw + i] - A[j * gw + i]) * t;
      if (gw === 1) { o.fill(row[0]); continue; }
      for (let x = 0; x < w; x++) { const i = xi[x]; o[x] = row[i] + (row[i + 1] - row[i]) * xt[x]; }
    }
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function saturateInPlace(d, f) {
  if (f === 1) return;
  for (let p = 0; p < d.length; p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2], l = 0.299 * r + 0.587 * g + 0.114 * b;
    d[p] = l + (r - l) * f; d[p + 1] = l + (g - l) * f; d[p + 2] = l + (b - l) * f;
  }
}

function sharpenInPlace(img, amount, radius) {
  if (amount <= 0) return;
  const w = img.width, h = img.height, d = img.data;
  const g = toGray(img);
  const bl = boxBlur(boxBlur(g, w, h, radius), w, h, radius);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const delta = amount * (g[i] - bl[i]);
    if (delta === 0) continue;
    d[p] += delta; d[p + 1] += delta; d[p + 2] += delta;
  }
}

function sharpenGrayInPlace(g, w, h, amount, radius) {
  if (amount <= 0) return;
  const bl = boxBlur(boxBlur(g, w, h, radius), w, h, radius);
  for (let i = 0; i < g.length; i++) {
    const v = g[i] + amount * (g[i] - bl[i]);
    g[i] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5;
  }
}

function lutInPlace(d, lr, lg, lb) {
  for (let p = 0; p < d.length; p += 4) { d[p] = lr[d[p]]; d[p + 1] = lg[d[p + 1]]; d[p + 2] = lb[d[p + 2]]; }
}

function brightnessContrastLUT(brightness, contrast) {
  const lut = new Uint8ClampedArray(256);
  const C = contrast * 1.27;
  const f = (259 * (C + 255)) / (255 * (259 - C));
  for (let v = 0; v < 256; v++) {
    let x = v + brightness * 0.8;
    x = x < 0 ? 0 : x > 255 ? 255 : x;
    lut[v] = f * (x - 128) + 128;
  }
  return lut;
}

function applyAdjustments(img, a) {
  const d = img.data;
  if (a.brightness || a.contrast || a.warmth) {
    const base = brightnessContrastLUT(a.brightness, a.contrast);
    const lr = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) { lr[v] = base[v] + a.warmth * 0.3; lb[v] = base[v] - a.warmth * 0.3; }
    lutInPlace(d, lr, base, lb);
  }
  if (a.saturation) saturateInPlace(d, 1 + a.saturation / 100);
  if (a.sharpness) {
    const radius = Math.max(1, Math.round(Math.max(img.width, img.height) / 1500));
    sharpenInPlace(img, (a.sharpness / 100) * 1.5, radius);
  }
}

function writeGray(g, w, h) {
  const out = createImage(w, h), d = out.data;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) { const v = g[i]; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return out;
}

/** Tone curve for normalised (paper = ~1) values: black point, white point, gamma. */
function normCurveLUT(bp, wp, gamma) {
  const lut = new Uint8ClampedArray(2048);
  for (let k = 0; k < 2048; k++) {
    let v = (k / 1024 - bp) / (wp - bp);
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    lut[k] = 255 * Math.pow(v, gamma);
  }
  return lut;
}

function blackPoint(bg) {
  // 0.5th percentile of normalised luma; histogram bins are n*200
  const p = pctFromHist(bg.normHist, bg.normTotal, 0.005) / 200;
  return Math.min(0.3, Math.max(0.02, p * 0.9));
}

function filterAuto(img) {
  const w = img.width, h = img.height, s = img.data;
  const bg = estimateBackground(img);
  const sample = bgSampler(bg, w, h);
  const lut = normCurveLUT(blackPoint(bg), 0.86, 1.6);
  const out = createImage(w, h), d = out.data;
  const rR = new Float32Array(w), rG = new Float32Array(w), rB = new Float32Array(w);
  const sat = 1.25;
  for (let y = 0; y < h; y++) {
    sample(y, rR, rG, rB, null);
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4) {
      let ir = ((s[p] * 1024) / rR[x]) | 0, ig = ((s[p + 1] * 1024) / rG[x]) | 0, ib = ((s[p + 2] * 1024) / rB[x]) | 0;
      if (ir > 2047) ir = 2047; if (ig > 2047) ig = 2047; if (ib > 2047) ib = 2047;
      const r = lut[ir], g = lut[ig], b = lut[ib];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[p] = l + (r - l) * sat; d[p + 1] = l + (g - l) * sat; d[p + 2] = l + (b - l) * sat; d[p + 3] = 255;
    }
  }
  return out;
}

/** Luma normalised by the illumination estimate: paper ~ 250. Returns Uint8Array. */
function normalizedGray(img, bg) {
  const w = img.width, h = img.height, s = img.data;
  const sample = bgSampler(bg, w, h);
  const rL = new Float32Array(w), g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    sample(y, null, null, null, rL);
    let p = y * w * 4, i = y * w;
    for (let x = 0; x < w; x++, p += 4, i++) {
      const l = 0.299 * s[p] + 0.587 * s[p + 1] + 0.114 * s[p + 2];
      const v = (l / rL[x]) * 255;
      g[i] = v > 255 ? 255 : v + 0.5;
    }
  }
  return g;
}

function filterGray(img) {
  const w = img.width, h = img.height, s = img.data;
  const bg = estimateBackground(img);
  const sample = bgSampler(bg, w, h);
  const lut = normCurveLUT(blackPoint(bg), 0.86, 1.8);
  const out = createImage(w, h), d = out.data;
  const rL = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    sample(y, null, null, null, rL);
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4) {
      const l = 0.299 * s[p] + 0.587 * s[p + 1] + 0.114 * s[p + 2];
      let k = ((l * 1024) / rL[x]) | 0; if (k > 2047) k = 2047;
      const v = lut[k];
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
  }
  return out;
}

function filterBW(img, a) {
  const w = img.width, h = img.height, n = w * h;
  const bg = estimateBackground(img);
  let g = normalizedGray(img, bg);
  if (a.brightness || a.contrast) {
    const lut = brightnessContrastLUT(a.brightness, a.contrast);
    for (let i = 0; i < n; i++) g[i] = lut[g[i]];
  }
  if (a.sharpness) sharpenGrayInPlace(g, w, h, (a.sharpness / 100) * 1.5, Math.max(1, Math.round(Math.max(w, h) / 1500)));
  // light denoise: separable [1 2 1]
  const sm = new Uint8Array(n);
  {
    const t = new Uint16Array(n);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l = x > 0 ? x - 1 : 0, r = x < w - 1 ? x + 1 : w - 1;
        t[o + x] = g[o + l] + 2 * g[o + x] + g[o + r];
      }
    }
    for (let y = 0; y < h; y++) {
      const u = (y > 0 ? y - 1 : 0) * w, dn = (y < h - 1 ? y + 1 : h - 1) * w, o = y * w;
      for (let x = 0; x < w; x++) sm[o + x] = (t[u + x] + 2 * t[o + x] + t[dn + x] + 8) >> 4;
    }
  }
  const radius = Math.max(7, Math.round(Math.max(w, h) / 40));
  const mean = boxBlur(sm, w, h, radius);
  const s = Math.max(-0.5, Math.min(0.5, a.threshold / 100)); // sensitivity, >0 = more black
  const k = Math.max(0.03, 0.15 - s * 0.24);
  const hiCap = 255 * Math.min(0.97, 0.8 + s * 0.3);
  const loFloor = 255 * Math.max(0.1, 0.4 + s * 0.4);
  const out = createImage(w, h), d = out.data;
  // In a thin band along the borders (where a sliver of desk often survives the
  // crop) only clearly dark pixels become black, avoiding dashed frame lines.
  const band = Math.max(2, Math.round(Math.max(w, h) * 0.004));
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = sm[i], x = i % w, y = (i - x) / w;
    const edgeBand = x < band || y < band || x >= w - band || y >= h - band;
    const black = v < loFloor || (!edgeBand && v < hiCap && v < mean[i] * (1 - k));
    const o = black ? 0 : 255;
    d[p] = o; d[p + 1] = o; d[p + 2] = o; d[p + 3] = 255;
  }
  return out;
}

function stretchLUT(lo, hi, maxGain, curve) {
  if (hi - lo < 255 / maxGain) {
    const mid = (hi + lo) / 2, half = 255 / maxGain / 2;
    lo = mid - half; hi = mid + half;
  }
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - lo) / (hi - lo);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    lut[v] = 255 * (curve ? curve(x) : x);
  }
  return lut;
}

function filterEnhance(img) {
  const out = cloneImage(img);
  const H = histograms(img);
  const lL = pctFromHist(H.l, H.total, 0.005), hL = pctFromHist(H.l, H.total, 0.995);
  const luts = [H.r, H.g, H.b].map((hc) => {
    const lo = 0.5 * pctFromHist(hc, H.total, 0.005) + 0.5 * lL;
    const hi = 0.5 * pctFromHist(hc, H.total, 0.995) + 0.5 * hL;
    return stretchLUT(lo, hi, 2.2, (x) => Math.pow(x, 0.95));
  });
  lutInPlace(out.data, luts[0], luts[1], luts[2]);
  saturateInPlace(out.data, 1.15);
  sharpenInPlace(out, 0.45, Math.max(1, Math.round(Math.max(img.width, img.height) / 1500)));
  return out;
}

function filterLighten(img) {
  const out = cloneImage(img);
  const H = histograms(img);
  const hi = Math.max(1, pctFromHist(H.l, H.total, 0.995));
  const gain = Math.min(2.2, Math.max(1, 245 / hi));
  // adaptive gamma: lift the median towards ~0.6 (strong for dark photos, mild for bright ones)
  const med = Math.max(1, pctFromHist(H.l, H.total, 0.5)) * gain / 255;
  const gamma = Math.min(0.9, Math.max(0.45, Math.log(0.62) / Math.log(Math.min(0.95, med))));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.min(1, (v * gain) / 255);
    let y = Math.pow(x, gamma);
    y += 0.2 * y * (1 - y) * (1 - y); // extra shadow lift
    lut[v] = 255 * Math.min(1, y);
  }
  lutInPlace(out.data, lut, lut, lut);
  return out;
}

function filterVivid(img) {
  const out = cloneImage(img);
  const H = histograms(img);
  const lo = pctFromHist(H.l, H.total, 0.01);
  const s = (x) => x + 0.4 * (x * x * (3 - 2 * x) - x);
  // per-channel white point = white balance (removes yellow/blue casts), shared black point
  const luts = [H.r, H.g, H.b].map((hc) => stretchLUT(lo, Math.max(lo + 1, pctFromHist(hc, H.total, 0.99)), 3, s));
  lutInPlace(out.data, luts[0], luts[1], luts[2]);
  saturateInPlace(out.data, 1.55);
  sharpenInPlace(out, 0.5, Math.max(1, Math.round(Math.max(img.width, img.height) / 1500)));
  return out;
}

function filterInvert(img) {
  const out = createImage(img.width, img.height), s = img.data, d = out.data;
  for (let p = 0; p < d.length; p += 4) { d[p] = 255 - s[p]; d[p + 1] = 255 - s[p + 1]; d[p + 2] = 255 - s[p + 2]; d[p + 3] = 255; }
  return out;
}

/**
 * Apply a preset filter then the manual adjustments (brightness, contrast,
 * warmth, saturation, sharpness). Unknown ids behave like 'original'.
 */
export function applyFilter(img, filterId, adjust = DEFAULT_ADJUST) {
  const a = normalizeAdjust(adjust);
  const id = FILTER_IDS.has(filterId) ? filterId : 'original';
  if (id === 'bw') return filterBW(img, a);
  let out;
  switch (id) {
    case 'auto': out = filterAuto(img); break;
    case 'enhance': out = filterEnhance(img); break;
    case 'gray': out = filterGray(img); break;
    case 'lighten': out = filterLighten(img); break;
    case 'vivid': out = filterVivid(img); break;
    case 'invert': out = filterInvert(img); break;
    default: out = cloneImage(img);
  }
  applyAdjustments(out, a);
  return out;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

function isFullFrame(c) {
  const ref = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let i = 0; i < 4; i++) {
    const p = P(c[i]);
    if (Math.abs(p.x - ref[i][0]) > 0.004 || Math.abs(p.y - ref[i][1]) > 0.004) return false;
  }
  return true;
}

/**
 * Full page pipeline: perspective crop (normalised corners) → rotate → filter.
 * page = { corners: null | [{x,y}x4 normalised TL,TR,BR,BL], rotation, filter, adjust }
 */
export function processPage(img, page) {
  const pg = page || {};
  let out = null;
  const c = pg.corners;
  if (Array.isArray(c) && c.length === 4 && !isFullFrame(c)) {
    const px = c.map((q) => { const p = P(q); return { x: p.x * img.width, y: p.y * img.height }; });
    if (isConvexQuad(px) && quadArea(px) >= 1) {
      const { width, height } = estimateOutputSize(px);
      out = warpPerspective(img, px, width, height);
    }
  }
  const rot = ((Math.round((Number(pg.rotation) || 0) / 90) % 4) + 4) % 4;
  if (rot) out = rotate(out || img, rot * 90);
  if (!out) out = img; // applyFilter never mutates its input and always returns a new image
  return applyFilter(out, pg.filter || 'original', { ...DEFAULT_ADJUST, ...(pg.adjust || {}) });
}
