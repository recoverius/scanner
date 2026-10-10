/**
 * pdf.js — a tiny, dependency-free PDF writer for JPEG page images.
 *
 * Pure ES module with no DOM access: works on the browser main thread, in a
 * Web Worker and in Node 22. Each page embeds one JPEG as-is (DCTDecode
 * pass-through, no re-encoding), so output size ~= sum of the JPEG sizes.
 *
 *   import { createPdf, createPdfBlob, readJpegInfo, PAGE_SIZES } from './pdf.js';
 *   const bytes = createPdf([{ jpeg }], { pageSize: 'a4', title: 'Receipt' });
 */

/** Paper sizes in PDF points (1/72 in), portrait. */
export const PAGE_SIZES = Object.freeze({
  a4: Object.freeze({ width: 595.28, height: 841.89, label: 'A4' }),
  letter: Object.freeze({ width: 612, height: 792, label: 'Letter' }),
  legal: Object.freeze({ width: 612, height: 1008, label: 'Legal' }),
  a5: Object.freeze({ width: 419.53, height: 595.28, label: 'A5' }),
});

const DEFAULT_DPI = 150;
const DEFAULT_NAMED_MARGIN = 18;

/* ------------------------------------------------------------------------ */
/* JPEG header parsing                                                       */
/* ------------------------------------------------------------------------ */

function toUint8(data, what) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`${what} must be a Uint8Array (got ${data === null ? 'null' : typeof data})`);
}

/**
 * Read the dimensions and component count of a JPEG by scanning its markers
 * for the first SOFn segment (C0..CF except C4 DHT, C8 JPG, CC DAC).
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, components: number }}
 */
export function readJpegInfo(bytes) {
  const b = toUint8(bytes, 'JPEG data');
  const n = b.length;
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    throw new Error('Not a JPEG: missing SOI marker (FF D8)');
  }
  let i = 2;
  while (i < n) {
    if (b[i] !== 0xff) {
      throw new Error(`Invalid JPEG: expected marker at byte ${i}`);
    }
    // Skip fill bytes (any number of 0xFF before the marker code).
    while (i < n && b[i] === 0xff) i++;
    if (i >= n) break;
    const marker = b[i++];
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9) break; // EOI
    if (i + 2 > n) break;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2) throw new Error(`Invalid JPEG: bad segment length at byte ${i}`);
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (i + 8 > n) break;
      // [len:2][precision:1][height:2][width:2][components:1]
      const height = (b[i + 3] << 8) | b[i + 4];
      const width = (b[i + 5] << 8) | b[i + 6];
      const components = b[i + 7];
      if (width === 0 || height === 0) {
        throw new Error('Unsupported JPEG: zero width/height (DNL marker) in SOF header');
      }
      return { width, height, components };
    }
    if (marker === 0xda) {
      throw new Error('Invalid JPEG: start of scan reached before SOF header');
    }
    i += len;
  }
  throw new Error('Invalid JPEG: no SOF (frame header) found');
}

/* ------------------------------------------------------------------------ */
/* Low-level PDF serialisation helpers                                       */
/* ------------------------------------------------------------------------ */

/** Encode an ASCII-only string to bytes (all PDF syntax we emit is ASCII). */
function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Format a number for PDF: max 4 decimals, no exponent, no trailing zeros. */
function num(x) {
  if (!Number.isFinite(x)) throw new Error(`Invalid number in PDF output: ${x}`);
  const r = Math.round(x * 10000) / 10000;
  if (r === 0) return '0';
  let s = r.toFixed(4);
  s = s.replace(/\.?0+$/, '');
  return s;
}

function hex2(v) {
  return (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
}

/**
 * Encode a JS string as a PDF text string. ASCII → escaped literal string;
 * anything else → UTF-16BE hex string with BOM.
 */
export function pdfTextString(str) {
  const s = String(str);
  let isAscii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7e) { isAscii = false; break; }
  }
  if (isAscii) {
    let out = '(';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ch = s[i];
      if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 0x20) out += '\\' + c.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out + ')';
  }
  let out = '<FEFF';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i); // UTF-16 code unit; surrogate pairs pass through
    out += hex2(c >> 8) + hex2(c & 0xff);
  }
  return out + '>';
}

function pad2(v) {
  return String(v).padStart(2, '0');
}

/** Date → "D:YYYYMMDDHHmmSS+HH'mm'" (local time with UTC offset). */
export function pdfDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid creationDate');
  const base =
    'D:' + String(d.getFullYear()).padStart(4, '0') + pad2(d.getMonth() + 1) +
    pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  if (off === 0) return base + 'Z';
  const a = Math.abs(off);
  return base + (off > 0 ? '+' : '-') + pad2(Math.floor(a / 60)) + "'" + pad2(a % 60) + "'";
}

function randomIdHex() {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  let s = '';
  for (let i = 0; i < 16; i++) s += hex2(bytes[i]);
  return s;
}

/** Collects output chunks and tracks the running byte offset. */
class ChunkWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  bytes(u8) {
    this.chunks.push(u8); // no copy; concatenated once at the end
    this.length += u8.length;
  }
  str(s) {
    this.bytes(ascii(s));
  }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const c of this.chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

/* ------------------------------------------------------------------------ */
/* Layout                                                                    */
/* ------------------------------------------------------------------------ */

function layoutPage(imgW, imgH, opts) {
  const { pageSize, dpi, margin, orientation } = opts;
  if (pageSize === 'fit') {
    const w = (imgW * 72) / dpi;
    const h = (imgH * 72) / dpi;
    return {
      pageW: w + 2 * margin,
      pageH: h + 2 * margin,
      x: margin, y: margin, w, h,
    };
  }
  const paper = PAGE_SIZES[pageSize];
  let landscape;
  if (orientation === 'portrait') landscape = false;
  else if (orientation === 'landscape') landscape = true;
  else landscape = imgW > imgH;
  const pageW = landscape ? paper.height : paper.width;
  const pageH = landscape ? paper.width : paper.height;
  const availW = pageW - 2 * margin;
  const availH = pageH - 2 * margin;
  if (availW <= 0 || availH <= 0) {
    throw new RangeError(`margin ${margin}pt is too large for page size '${pageSize}'`);
  }
  const scale = Math.min(availW / imgW, availH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

function normaliseOptions(options) {
  const o = options || {};
  const pageSize = o.pageSize == null ? 'fit' : String(o.pageSize).toLowerCase();
  if (pageSize !== 'fit' && !Object.prototype.hasOwnProperty.call(PAGE_SIZES, pageSize)) {
    throw new Error(
      `Unknown pageSize '${o.pageSize}' (expected 'fit', ${Object.keys(PAGE_SIZES).map((k) => `'${k}'`).join(', ')})`,
    );
  }
  const dpi = o.dpi == null ? DEFAULT_DPI : Number(o.dpi);
  if (!(dpi > 0) || !Number.isFinite(dpi)) throw new RangeError(`Invalid dpi: ${o.dpi}`);
  const margin = o.margin == null ? (pageSize === 'fit' ? 0 : DEFAULT_NAMED_MARGIN) : Number(o.margin);
  if (!(margin >= 0) || !Number.isFinite(margin)) throw new RangeError(`Invalid margin: ${o.margin}`);
  const orientation = o.orientation === 'portrait' || o.orientation === 'landscape' ? o.orientation : 'auto';
  return { pageSize, dpi, margin, orientation };
}

const COLOR_SPACES = {
  1: '/ColorSpace /DeviceGray',
  3: '/ColorSpace /DeviceRGB',
  // Adobe (Photoshop / libjpeg-with-APP14) CMYK JPEGs store inverted values.
  4: '/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0]',
};

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Build a complete PDF file with one JPEG image per page.
 *
 * @param {Array<{ jpeg: Uint8Array, width?: number, height?: number }>} pages
 * @param {{
 *   pageSize?: 'fit'|'a4'|'letter'|'legal'|'a5',
 *   dpi?: number,
 *   orientation?: 'auto'|'portrait'|'landscape',
 *   margin?: number,
 *   title?: string, author?: string, subject?: string,
 *   creator?: string, producer?: string,
 *   creationDate?: Date,
 * }} [options]
 * @returns {Uint8Array}
 */
export function createPdf(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('createPdf: at least one page is required');
  }
  const opts = normaliseOptions(options);

  // Validate every page up front so we fail before doing any work.
  const prepared = pages.map((p, idx) => {
    if (!p || p.jpeg == null) throw new Error(`createPdf: page ${idx + 1} has no jpeg data`);
    const jpeg = toUint8(p.jpeg, `page ${idx + 1} jpeg`);
    let info;
    try {
      info = readJpegInfo(jpeg);
    } catch (e) {
      throw new Error(`createPdf: page ${idx + 1}: ${e.message}`);
    }
    const colorSpace = COLOR_SPACES[info.components];
    if (!colorSpace) {
      throw new Error(`createPdf: page ${idx + 1}: unsupported JPEG component count ${info.components}`);
    }
    // Layout uses caller-supplied px dims if given (both), else the JPEG's own.
    const lw = p.width > 0 && p.height > 0 ? Number(p.width) : info.width;
    const lh = p.width > 0 && p.height > 0 ? Number(p.height) : info.height;
    return { jpeg, info, colorSpace, layout: layoutPage(lw, lh, opts) };
  });

  // Object numbering: 1 Catalog, 2 Pages, 3 Info, then 3 objects per page.
  const pageObj = (i) => 4 + i * 3;
  const contentObj = (i) => 5 + i * 3;
  const imageObj = (i) => 6 + i * 3;
  const objCount = 3 + prepared.length * 3;
  const offsets = new Array(objCount + 1);

  const w = new ChunkWriter();
  // Header + binary comment so transfer tools treat the file as binary.
  w.str('%PDF-1.4\n');
  w.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const beginObj = (n) => {
    offsets[n] = w.length;
    w.str(`${n} 0 obj\n`);
  };

  // 1: Catalog
  beginObj(1);
  w.str('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages tree (flat)
  beginObj(2);
  const kids = prepared.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  w.str(`<< /Type /Pages /Kids [${kids}] /Count ${prepared.length} >>\nendobj\n`);

  // 3: Info dictionary
  const o = options || {};
  const info = [];
  const addInfo = (key, val) => {
    if (val != null && val !== '') info.push(`/${key} ${pdfTextString(val)}`);
  };
  addInfo('Title', o.title);
  addInfo('Author', o.author);
  addInfo('Subject', o.subject);
  addInfo('Creator', o.creator == null ? 'Scanner' : o.creator);
  addInfo('Producer', o.producer);
  const date = pdfDate(o.creationDate == null ? new Date() : o.creationDate);
  info.push(`/CreationDate (${date})`, `/ModDate (${date})`);
  beginObj(3);
  w.str(`<< ${info.join(' ')} >>\nendobj\n`);

  // Pages
  prepared.forEach((pg, i) => {
    const { pageW, pageH, x, y, w: dw, h: dh } = pg.layout;

    beginObj(pageObj(i));
    w.str(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageW)} ${num(pageH)}]` +
        ` /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> /ProcSet [/PDF /ImageB /ImageC] >>` +
        ` /Contents ${contentObj(i)} 0 R >>\nendobj\n`,
    );

    const content = `q\n${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm\n/Im0 Do\nQ\n`;
    beginObj(contentObj(i));
    w.str(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    beginObj(imageObj(i));
    w.str(
      `<< /Type /XObject /Subtype /Image /Width ${pg.info.width} /Height ${pg.info.height}` +
        ` ${pg.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`,
    );
    w.bytes(pg.jpeg);
    w.str('\nendstream\nendobj\n');
  });

  // Cross-reference table: every entry is exactly 20 bytes.
  const xrefOffset = w.length;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f\r\n`;
  for (let n = 1; n <= objCount; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  }
  w.str(xref);

  const id = randomIdHex();
  w.str(
    `trailer\n<< /Size ${objCount + 1} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return w.toUint8Array();
}

/**
 * Convenience wrapper returning a Blob of type application/pdf.
 * @returns {Blob}
 */
export function createPdfBlob(pages, options) {
  if (typeof Blob === 'undefined') {
    throw new Error('createPdfBlob: Blob is not available in this environment; use createPdf()');
  }
  return new Blob([createPdf(pages, options)], { type: 'application/pdf' });
}
