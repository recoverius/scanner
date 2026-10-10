// Tests for js/imaging.js — run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTERS, DEFAULT_ADJUST, detectDocumentCorners, orderCorners, isConvexQuad, estimateOutputSize,
  computeHomography, warpPerspective, rotate, resize, applyFilter, processPage, autoCrop,
} from '../js/imaging.js';

// ---------------------------------------------------------------------------
// Synthetic image helpers
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4, [r, g, b] = fn(x, y);
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

// "Text": rows of word-like bars with letter gaps, in page coordinates (0..1).
function textAt(u, v) {
  if (u < 0.1 || u > 0.9 || v < 0.1 || v > 0.9) return false;
  const row = (v - 0.1) / 0.05, rf = row - Math.floor(row);
  if (rf > 0.35) return false;
  const word = Math.floor((u - 0.1) / 0.12), wf = (u - 0.1) / 0.12 - word;
  if (wf > 0.8 || (word + Math.floor(row)) % 5 === 4) return false;
  return ((u * 100) % 1) < 0.55;
}

/** Dark noisy desk with a bright page (quad TL,TR,BR,BL) carrying dark text. */
function scene(w, h, quad, { bg = 60, page = 230, noise = 10, seed = 1 } = {}) {
  const r = rng(seed);
  const Hi = computeHomography(quad, UNIT);
  const ss = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  return makeImage(w, h, (x, y) => {
    let acc = 0;
    for (const [ox, oy] of ss) {
      const X = x + ox, Y = y + oy, z = Hi[6] * X + Hi[7] * Y + Hi[8];
      const u = (Hi[0] * X + Hi[1] * Y + Hi[2]) / z, v = (Hi[3] * X + Hi[4] * Y + Hi[5]) / z;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) acc += textAt(u, v) ? 40 : page;
      else acc += bg + 12 * Math.sin(x * 0.05) * Math.cos(y * 0.07);
    }
    const v = acc / 4 + gauss(r) * noise;
    return [v, v, v];
  });
}

/**
 * A flat page photo with strong illumination gradient (bright top-left, dark
 * bottom-right) and a yellowish tint. Returns the image and a text mask.
 */
function litPage(w, h, seed = 7) {
  const r = rng(seed);
  const mask = new Uint8Array(w * h);
  const img = makeImage(w, h, (x, y) => {
    const u = x / w, v = y / h, t = textAt(u, v);
    if (t) mask[y * w + x] = 1;
    const light = 1.0 - 0.5 * (0.6 * u + 0.4 * v); // 1.0 .. 0.5
    const base = t ? 45 : 225;
    const n = gauss(r) * 4;
    return [base * light + n, base * light * 0.93 + n, base * light * 0.75 + n];
  });
  return { img, mask };
}

function lum(d, p) { return 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; }

function assertValidImage(img, w, h) {
  if (w !== undefined) { assert.equal(img.width, w); assert.equal(img.height, h); }
  assert.ok(img.data instanceof Uint8ClampedArray);
  assert.equal(img.data.length, img.width * img.height * 4);
  for (let p = 3; p < img.data.length; p += 4) if (img.data[p] !== 255) assert.fail('alpha must be 255');
}

// Max corner distance, allowing a cyclic shift (TL is ambiguous for a 45° diamond).
function maxCornerErr(found, truth) {
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    best = Math.min(best, Math.max(...found.map((p, i) => Math.hypot(p.x - truth[(i + s) % 4].x, p.y - truth[(i + s) % 4].y))));
  }
  return best;
}

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

test('FILTERS and DEFAULT_ADJUST match the contract', () => {
  assert.deepEqual(FILTERS.map((f) => f.id), ['original', 'auto', 'enhance', 'gray', 'bw', 'lighten', 'vivid', 'invert']);
  for (const f of FILTERS) assert.equal(typeof f.label, 'string');
  assert.deepEqual({ ...DEFAULT_ADJUST }, { brightness: 0, contrast: 0, saturation: 0, sharpness: 0, warmth: 0, threshold: 0 });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const SHAPES = {
  rotated: [400, 300, [{ x: 120, y: 30 }, { x: 350, y: 90 }, { x: 290, y: 280 }, { x: 60, y: 220 }]],
  trapezoid: [400, 300, [{ x: 110, y: 40 }, { x: 290, y: 45 }, { x: 360, y: 270 }, { x: 40, y: 262 }]],
  fill90: [400, 300, [{ x: 12, y: 9 }, { x: 388, y: 12 }, { x: 390, y: 291 }, { x: 9, y: 288 }]],
  portrait: [300, 400, [{ x: 50, y: 60 }, { x: 250, y: 40 }, { x: 270, y: 350 }, { x: 30, y: 370 }]],
  rotated45: [400, 400, [{ x: 200, y: 40 }, { x: 360, y: 200 }, { x: 200, y: 360 }, { x: 40, y: 200 }]],
};

for (const [name, [w, h, quad]] of Object.entries(SHAPES)) {
  test(`detectDocumentCorners finds the page: ${name}`, () => {
    const img = scene(w, h, quad, { seed: name.length });
    const res = detectDocumentCorners(img);
    assert.ok(res, 'expected a detection');
    assert.equal(res.corners.length, 4);
    assert.ok(res.confidence > 0.5 && res.confidence <= 1, `confidence ${res.confidence}`);
    const truth = orderCorners(quad);
    const err = maxCornerErr(res.corners, truth) / Math.hypot(w, h);
    assert.ok(err < 0.02, `corner error ${(err * 100).toFixed(2)}% of diagonal`);
  });
}

test('detectDocumentCorners: lower contrast page on grey desk', () => {
  const quad = [{ x: 80, y: 50 }, { x: 330, y: 60 }, { x: 320, y: 260 }, { x: 70, y: 250 }];
  const res = detectDocumentCorners(scene(400, 300, quad, { bg: 150, page: 205, noise: 6 }));
  assert.ok(res);
  assert.ok(maxCornerErr(res.corners, quad) / 500 < 0.02);
});

test('detectDocumentCorners handles large inputs (internal downscale) in input coordinates', () => {
  const quad = [{ x: 300, y: 150 }, { x: 1350, y: 250 }, { x: 1200, y: 1100 }, { x: 200, y: 1000 }];
  const res = detectDocumentCorners(scene(1600, 1200, quad));
  assert.ok(res);
  assert.ok(maxCornerErr(res.corners, quad) / 2000 < 0.02);
});

test('detectDocumentCorners returns null for uniform and noise-only images', () => {
  const uniform = makeImage(400, 300, () => [128, 128, 128]);
  assert.equal(detectDocumentCorners(uniform), null);
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    const noise = makeImage(400, 300, () => { const v = 100 + gauss(r) * 25; return [v, v, v]; });
    assert.equal(detectDocumentCorners(noise), null);
  }
  assert.equal(detectDocumentCorners(makeImage(8, 8, () => [0, 0, 0])), null);
});

test('autoCrop returns normalised corners', () => {
  const [w, h, quad] = SHAPES.trapezoid;
  const c = autoCrop(scene(w, h, quad));
  assert.ok(c);
  for (let i = 0; i < 4; i++) {
    assert.ok(c[i].x >= 0 && c[i].x <= 1 && c[i].y >= 0 && c[i].y <= 1);
    assert.ok(Math.abs(c[i].x - quad[i].x / w) < 0.02 && Math.abs(c[i].y - quad[i].y / h) < 0.02);
  }
  assert.equal(autoCrop(makeImage(200, 150, () => [90, 90, 90])), null);
});

test('timing: detectDocumentCorners 400x300', () => {
  const [w, h, quad] = SHAPES.rotated;
  const img = scene(w, h, quad);
  for (let i = 0; i < 5; i++) detectDocumentCorners(img); // JIT warm-up
  const n = 10, t0 = performance.now();
  for (let i = 0; i < n; i++) detectDocumentCorners(img);
  const ms = (performance.now() - t0) / n;
  console.log(`detectDocumentCorners 400x300: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 200, `too slow: ${ms} ms`);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('orderCorners orders any permutation as TL, TR, BR, BL', () => {
  const q = [{ x: 10, y: 12 }, { x: 95, y: 5 }, { x: 99, y: 80 }, { x: 4, y: 90 }];
  for (const perm of [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
    assert.deepEqual(orderCorners(perm.map((i) => q[i])), q);
  }
});

test('isConvexQuad', () => {
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), true);
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false); // bow-tie
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 10 }]), false); // concave
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false); // degenerate
});

test('estimateOutputSize uses max of opposite edges and is never 0', () => {
  assert.deepEqual(estimateOutputSize([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 50 }, { x: -10, y: 50 }]), { width: 130, height: 54 });
  const s = estimateOutputSize([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]);
  assert.ok(s.width >= 1 && s.height >= 1);
});

test('computeHomography maps the 4 points exactly', () => {
  const src = [{ x: 12.5, y: 30 }, { x: 1800, y: 95 }, { x: 1700, y: 2600 }, { x: 40, y: 2450 }];
  const dst = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2800 }, { x: 0, y: 2800 }];
  const H = computeHomography(src, dst);
  assert.equal(H.length, 9);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], z = H[6] * x + H[7] * y + H[8];
    assert.ok(Math.abs((H[0] * x + H[1] * y + H[2]) / z - dst[i].x) < 1e-6);
    assert.ok(Math.abs((H[3] * x + H[4] * y + H[5]) / z - dst[i].y) < 1e-6);
  }
});

test('warpPerspective of an axis-aligned rectangle equals the direct crop', () => {
  const r = rng(5);
  const img = makeImage(120, 90, () => [r() * 255, r() * 255, r() * 255]);
  const x0 = 17, y0 = 11, cw = 64, ch = 50;
  const out = warpPerspective(img, [{ x: x0, y: y0 }, { x: x0 + cw, y: y0 }, { x: x0 + cw, y: y0 + ch }, { x: x0, y: y0 + ch }], cw, ch);
  assertValidImage(out, cw, ch);
  let maxDiff = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let c = 0; c < 3; c++) {
    maxDiff = Math.max(maxDiff, Math.abs(out.data[(y * cw + x) * 4 + c] - img.data[((y + y0) * 120 + x + x0) * 4 + c]));
  }
  assert.ok(maxDiff <= 1, `max diff ${maxDiff}`);
});

test('warpPerspective rectifies a perspective page (text rows become horizontal)', () => {
  const [w, h, quad] = SHAPES.trapezoid;
  const img = scene(w, h, quad, { noise: 0 });
  const { width, height } = estimateOutputSize(quad);
  const out = warpPerspective(img, quad, width, height);
  // the output's corners should be page (bright), not desk
  const d = out.data;
  for (const [x, y] of [[3, 3], [width - 4, 3], [width - 4, height - 4], [3, height - 4]]) {
    assert.ok(lum(d, (y * width + x) * 4) > 180);
  }
});

test('timing: warpPerspective to 2000x2800', () => {
  const src = makeImage(2400, 3200, (x, y) => [x & 255, y & 255, (x ^ y) & 255]);
  const corners = [{ x: 100, y: 120 }, { x: 2300, y: 60 }, { x: 2350, y: 3150 }, { x: 40, y: 3000 }];
  warpPerspective(src, corners, 200, 280); // warm-up
  const t0 = performance.now();
  const out = warpPerspective(src, corners, 2000, 2800);
  const ms = performance.now() - t0;
  console.log(`warpPerspective 2000x2800: ${ms.toFixed(0)} ms`);
  assertValidImage(out, 2000, 2800);
  assert.ok(ms < 4000, `too slow: ${ms} ms`);
});

// ---------------------------------------------------------------------------
// Rotate / resize
// ---------------------------------------------------------------------------

test('rotate: dimensions swap, 4x90 is identity, 180 = 90+90, -90 = 270', () => {
  const r = rng(9);
  const img = makeImage(7, 4, () => [r() * 255, r() * 255, r() * 255]);
  const r90 = rotate(img, 90);
  assert.equal(r90.width, 4); assert.equal(r90.height, 7);
  // clockwise: top-left pixel moves to top-right
  assert.deepEqual([...r90.data.slice((0 * 4 + 3) * 4, (0 * 4 + 3) * 4 + 4)], [...img.data.slice(0, 4)]);
  let x = img;
  for (let i = 0; i < 4; i++) x = rotate(x, 90);
  assert.deepEqual(x.data, img.data);
  assert.deepEqual(rotate(img, 180).data, rotate(rotate(img, 90), 90).data);
  assert.deepEqual(rotate(img, -90).data, rotate(img, 270).data);
  const r0 = rotate(img, 0);
  assert.notEqual(r0.data, img.data);
  assert.deepEqual(r0.data, img.data);
});

test('resize: area-average downscale, never upscales, returns copies', () => {
  const img = makeImage(100, 50, (x) => (x < 50 ? [0, 0, 0] : [200, 100, 50]));
  const small = resize(img, 20);
  assertValidImage(small, 20, 10);
  assert.deepEqual([...small.data.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...small.data.slice(19 * 4, 19 * 4 + 3)], [200, 100, 50]);
  const same = resize(img, 500);
  assert.equal(same.width, 100); assert.equal(same.height, 50);
  assert.notEqual(same.data, img.data);
  assert.deepEqual(same.data, img.data);
  // non-integer factor keeps the mean
  const odd = resize(makeImage(97, 61, () => [77, 77, 77]), 40);
  assert.ok(Math.max(odd.width, odd.height) <= 40);
  for (let p = 0; p < odd.data.length; p += 4) assert.ok(Math.abs(odd.data[p] - 77) <= 1);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("applyFilter('original', DEFAULT_ADJUST) is a pixel-identical copy", () => {
  const r = rng(3);
  const img = makeImage(33, 21, () => [r() * 255, r() * 255, r() * 255]);
  const before = new Uint8ClampedArray(img.data);
  const out = applyFilter(img, 'original', DEFAULT_ADJUST);
  assert.notEqual(out, img);
  assert.deepEqual(out.data, img.data);
  assert.deepEqual(applyFilter(img, 'no-such-filter').data, img.data);
  assert.deepEqual(img.data, before, 'input must not be mutated');
});

test("'bw' gives pure 0/255 with white background and black text under a lighting gradient", () => {
  const { img, mask } = litPage(420, 300);
  const out = applyFilter(img, 'bw');
  assertValidImage(out, 420, 300);
  const d = out.data;
  let bgWhite = 0, bgN = 0, txtBlack = 0, txtN = 0;
  const W = 420;
  for (let i = 0; i < mask.length; i++) {
    const v = d[i * 4];
    assert.ok(v === 0 || v === 255);
    assert.ok(d[i * 4 + 1] === v && d[i * 4 + 2] === v);
    if (mask[i]) { txtN++; if (v === 0) txtBlack++; continue; }
    // background: skip pixels touching text (anti-aliased stroke boundaries)
    if (mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W]) continue;
    bgN++; if (v === 255) bgWhite++;
  }
  assert.ok(bgWhite / bgN > 0.97, `background white ${(bgWhite / bgN).toFixed(3)}`);
  assert.ok(txtBlack / txtN > 0.8, `text black ${(txtBlack / txtN).toFixed(3)}`);
  // threshold shifts sensitivity: more black with positive values
  const count = (im) => { let c = 0; for (let p = 0; p < im.data.length; p += 4) if (im.data[p] === 0) c++; return c; };
  const lo = count(applyFilter(img, 'bw', { ...DEFAULT_ADJUST, threshold: -50 }));
  const hi = count(applyFilter(img, 'bw', { ...DEFAULT_ADJUST, threshold: 50 }));
  assert.ok(hi > lo, `threshold +50 (${hi}) should give more black than -50 (${lo})`);
});

function pageStats(out, mask) {
  const d = out.data;
  let s = 0, s2 = 0, n = 0, t = 0, tn = 0;
  const w = out.width, h = out.height;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = lum(d, i * 4);
    // background pixels away from text (3px margin)
    if (mask[i]) { t += v; tn++; continue; }
    let near = false;
    for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) { near = true; break; }
    }
    if (near) continue;
    s += v; s2 += v * v; n++;
  }
  const mean = s / n;
  return { bgMean: mean, bgStd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), textMean: t / tn };
}

test("'auto' removes the lighting gradient and colour cast: white paper, dark text", () => {
  const { img, mask } = litPage(420, 300);
  const before = pageStats(img, mask);
  const out = applyFilter(img, 'auto');
  assertValidImage(out, 420, 300);
  const st = pageStats(out, mask);
  console.log(`auto: input bg mean ${before.bgMean.toFixed(1)} std ${before.bgStd.toFixed(1)} -> bg mean ${st.bgMean.toFixed(1)} std ${st.bgStd.toFixed(1)}, text mean ${st.textMean.toFixed(1)}`);
  assert.ok(st.bgMean > 235, `bg mean ${st.bgMean}`);
  assert.ok(st.bgStd < 8, `bg std ${st.bgStd}`);
  assert.ok(st.textMean < 100, `text mean ${st.textMean}`);
  // white balance: paper should be neutral (yellow cast removed)
  let rb = 0, n = 0;
  for (let i = 0; i < mask.length; i += 7) if (!mask[i]) { rb += out.data[i * 4] - out.data[i * 4 + 2]; n++; }
  assert.ok(Math.abs(rb / n) < 6, `paper R-B difference ${rb / n}`);
});

test("'auto' keeps coloured ink coloured", () => {
  // grey paper with a blue pen line and a red stamp patch, under a gradient
  const img = makeImage(300, 200, (x, y) => {
    const L = 1 - 0.4 * (x / 300);
    let c = [215, 205, 170];
    if (y > 50 && y < 56 && x > 30 && x < 270) c = [40, 60, 170];
    if (x > 200 && x < 240 && y > 120 && y < 160) c = [190, 40, 40];
    return c.map((v) => v * L);
  });
  const out = applyFilter(img, 'auto'), d = out.data;
  const px = (x, y) => [...d.slice((y * 300 + x) * 4, (y * 300 + x) * 4 + 3)];
  const [br, bg, bb] = px(150, 53);
  assert.ok(bb > br + 60 && bb > bg + 40, `blue ink ${[br, bg, bb]}`);
  const [rr, rg, rbb] = px(220, 140);
  assert.ok(rr > rg + 80 && rr > rbb + 80, `red stamp ${[rr, rg, rbb]}`);
  const [pr, pg, pb] = px(100, 120);
  assert.ok(pr > 240 && pg > 240 && pb > 240, `paper ${[pr, pg, pb]}`);
});

test("'gray' outputs neutral grey with normalised illumination", () => {
  const { img, mask } = litPage(420, 300);
  const out = applyFilter(img, 'gray');
  for (let p = 0; p < out.data.length; p += 4) {
    assert.ok(out.data[p] === out.data[p + 1] && out.data[p] === out.data[p + 2]);
  }
  const st = pageStats(out, mask);
  assert.ok(st.bgMean > 235 && st.textMean < 100, JSON.stringify(st));
});

test('every filter and adjustment runs and outputs valid images without mutating input', () => {
  const { img } = litPage(64, 48);
  const before = new Uint8ClampedArray(img.data);
  const adjusts = [
    DEFAULT_ADJUST,
    { brightness: 100, contrast: 100, saturation: 100, sharpness: 100, warmth: 100, threshold: 100 },
    { brightness: -100, contrast: -100, saturation: -100, sharpness: 0, warmth: -100, threshold: -100 },
    { brightness: 'x', contrast: NaN, saturation: undefined }, // garbage → defaults
    {},
  ];
  for (const f of FILTERS) {
    for (const a of adjusts) {
      const out = applyFilter(img, f.id, a);
      assertValidImage(out, 64, 48);
    }
  }
  // tiny and degenerate sizes
  for (const f of FILTERS) {
    assertValidImage(applyFilter(makeImage(1, 1, () => [10, 200, 30]), f.id), 1, 1);
    assertValidImage(applyFilter(makeImage(3, 17, () => [255, 255, 255]), f.id), 3, 17);
    assertValidImage(applyFilter(makeImage(9, 9, () => [0, 0, 0]), f.id), 9, 9);
  }
  assert.deepEqual(img.data, before);
});

test('manual adjustments behave in the expected direction', () => {
  const img = makeImage(40, 30, (x) => [100 + x, 120, 140 - x]);
  const mean = (im, c) => { let s = 0; for (let p = c; p < im.data.length; p += 4) s += im.data[p]; return s / (im.data.length / 4); };
  const base = applyFilter(img, 'original');
  assert.ok(mean(applyFilter(img, 'original', { brightness: 50 }), 1) > mean(base, 1) + 20);
  const warm = applyFilter(img, 'original', { warmth: 60 });
  assert.ok(mean(warm, 0) > mean(base, 0) + 10 && mean(warm, 2) < mean(base, 2) - 10);
  const desat = applyFilter(img, 'original', { saturation: -100 });
  for (let p = 0; p < desat.data.length; p += 4) assert.ok(Math.abs(desat.data[p] - desat.data[p + 2]) <= 1);
  const inv = applyFilter(img, 'invert');
  assert.equal(inv.data[0], 255 - img.data[0]);
});

test("timing: applyFilter('auto') on 1400x1000", () => {
  const img = makeImage(1400, 1000, (x, y) => {
    const t = textAt(x / 1400, y / 1000), L = 1 - 0.4 * (x / 1400);
    const v = (t ? 40 : 220) * L;
    return [v, v * 0.95, v * 0.8];
  });
  applyFilter(img, 'auto');
  const t0 = performance.now();
  const out = applyFilter(img, 'auto');
  const ms = performance.now() - t0;
  console.log(`applyFilter auto 1400x1000: ${ms.toFixed(0)} ms`);
  assertValidImage(out, 1400, 1000);
  assert.ok(ms < 2000);
});

// ---------------------------------------------------------------------------
// processPage
// ---------------------------------------------------------------------------

test('processPage: no corners + rotation 90 swaps dimensions', () => {
  const img = makeImage(50, 30, (x, y) => [x * 5, y * 8, 100]);
  const out = processPage(img, { corners: null, rotation: 90, filter: 'original', adjust: {} });
  assert.equal(out.width, 30); assert.equal(out.height, 50);
  assert.deepEqual(out.data, rotate(img, 90).data);
});

test('processPage: full-frame corners are a no-op crop; missing adjust keys default', () => {
  const img = makeImage(50, 30, (x, y) => [x * 5, y * 8, 100]);
  const full = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const out = processPage(img, { corners: full, rotation: 0, filter: 'original', adjust: { brightness: 0 } });
  assert.deepEqual(out.data, img.data);
  const out2 = processPage(img, { corners: null, rotation: 0, filter: 'original' });
  assert.deepEqual(out2.data, img.data);
});

test('processPage: crops with normalised corners, then rotates and filters', () => {
  const [w, h, quad] = SHAPES.rotated;
  const img = scene(w, h, quad);
  const corners = quad.map((p) => ({ x: p.x / w, y: p.y / h }));
  const size = estimateOutputSize(quad);
  const out = processPage(img, { corners, rotation: 270, filter: 'bw', adjust: { threshold: 10 } });
  assert.equal(out.width, size.height); assert.equal(out.height, size.width);
  assertValidImage(out);
  // mostly white page (no dark desk left)
  let white = 0;
  for (let p = 0; p < out.data.length; p += 4) if (out.data[p] === 255) white++;
  assert.ok(white / (out.data.length / 4) > 0.7);
  // invalid corners fall back to the full image
  const bad = processPage(img, { corners: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }], rotation: 0, filter: 'original' });
  assert.equal(bad.width, w); assert.equal(bad.height, h);
});
