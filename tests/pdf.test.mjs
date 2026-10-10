// Run: cd /home/user/scanner && node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdf, createPdfBlob, readJpegInfo, PAGE_SIZES } from '../js/pdf.js';

// Tiny JPEG fixtures generated with Python PIL (quality 60).
// RGB 40x30 baseline: red left half, blue right half, green top bar.
const RGB_40x30 = b64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCn58X979DR58X979DVKivK5Een/qxhP5pfev8AIuNdQr958fgab9st/wDnp+hrPn/hqKvoMFk9CvQjUk3d37d/Q+ex2XUsPXlSi3ZW/K/Y1ftlv/z0/Q0VlUV1f2Bhv5pfev8AI5PqsO7LdFFFfMH6eQz/AMNRVLP/AA1FX2WVf7pD5/mz4vN/98n8vyQUUUV6J5p//9k=',
);
// Grayscale 20x50 baseline (portrait).
const GRAY_20x50 = b64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//wAALCAAyABQBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AOJoooooooor17xFJ4V8OWS3OoaXZZdtscUdrGXkPfAOOB3J4/EgHl9E8ZeFb+9W21Hw5ZWAkYKkpjjdAefvHaNo6c8jnnAGa77+wdF/6BFh/wCAyf4V498TriWbxvdxyvuW3SOOMYA2rsDY9+WY/jXJ1738P7iW68EaZJO+5lRowcAfKrsqjj0AAqn468Fr4lWK6tJVh1CFQgMhOx0yTg4zgjJIIHsexHE6J8M9Zur1f7XRbG1VhvIkV3cc8LtyM8Yyemc89K9ftbeK0tYbW3TZDCixxrknCgYAyeegqWiiv//Z',
);
// Adobe CMYK 16x12 baseline.
const CMYK_16x12 = b64(
  '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/8AAFAgADAAQBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwDzCvTq9Or06vp2iiivmKiiivp2iiiv/9k=',
);
// Progressive (SOF2) RGB 40x30.
const RGB_PROG = b64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wgARCAAeACgDASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAIDBAH/xAAXAQEBAQEAAAAAAAAAAAAAAAAFBAMG/9oADAMBAAIQAxAAAAHFgkp2855QP6nK1x1BnURNSyKFE3//xAAaEAACAgMAAAAAAAAAAAAAAAAAAQISEBEg/9oACAEBAAEFAto2iyLxLxy+Xy8//8QAHREAAQQCAwAAAAAAAAAAAAAAAQACAwQQExUzUf/aAAgBAwEBPwHjIvSp67Y3loWoYt9xx//EAB0RAAIBBAMAAAAAAAAAAAAAAAECAAMEEBEUM1H/2gAIAQIBAT8B1KNmjoGM4FP04teoY//EABcQAAMBAAAAAAAAAAAAAAAAAAAQMUD/2gAIAQEABj8CdLg//8QAGhAAAQUBAAAAAAAAAAAAAAAAAQAQIEFhMf/aAAgBAQABPyHZbIj6YgVjWNX/AP/aAAwDAQACAAMAAAAQP6z8oC//xAAcEQABBAMBAAAAAAAAAAAAAAABABARsVFh0fH/2gAIAQMBAT8Q9wcRajAipwtparQb/8QAHBEAAQUAAwAAAAAAAAAAAAAAAQAQEVGxcdHx/9oACAECAQE/EIo3BkzV8L3B02/S3//EABkQAQEBAAMAAAAAAAAAAAAAAAEA8EBBgf/aAAgBAQABPxDYbYboHxsBsB4FX//Z',
);

function b64(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

const latin1 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('latin1');

/** Parse the structural parts of a PDF we produced and verify the xref. */
function inspect(u8) {
  const s = latin1(u8);
  assert.ok(s.startsWith('%PDF-1.4\n'), 'header');
  // Binary comment line: '%' followed by 4 bytes >= 128.
  const second = u8.subarray(9, 15);
  assert.equal(second[0], 0x25);
  for (let i = 1; i <= 4; i++) assert.ok(second[i] >= 128, 'binary comment byte');
  assert.ok(s.endsWith('%%EOF\n'), 'ends with %%EOF');

  const m = /startxref\n(\d+)\n%%EOF\n$/.exec(s);
  assert.ok(m, 'startxref');
  const xrefPos = Number(m[1]);
  assert.equal(s.slice(xrefPos, xrefPos + 5), 'xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefPos));
  assert.ok(head, 'xref subsection header');
  const size = Number(head[1]);
  const entriesStart = xrefPos + head[0].length;
  const entries = s.slice(entriesStart, entriesStart + size * 20);
  assert.equal(entries.slice(0, 20), '0000000000 65535 f\r\n');
  for (let n = 1; n < size; n++) {
    const e = entries.slice(n * 20, n * 20 + 20);
    assert.match(e, /^\d{10} 00000 n\r\n$/, `xref entry ${n} is 20 bytes`);
    const off = Number(e.slice(0, 10));
    const marker = `${n} 0 obj\n`;
    assert.equal(s.slice(off, off + marker.length), marker, `xref offset for object ${n}`);
  }
  assert.equal(s.slice(entriesStart + size * 20, entriesStart + size * 20 + 8), 'trailer\n');
  const trailer = s.slice(entriesStart + size * 20);
  assert.match(trailer, new RegExp(`/Size ${size}\\b`));
  assert.match(trailer, /\/Root 1 0 R/);
  assert.match(trailer, /\/Info 3 0 R/);
  assert.match(trailer, /\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);

  const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)[1]);
  const mediaBoxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((x) => [
    Number(x[1]),
    Number(x[2]),
  ]);
  const cms = [...s.matchAll(/\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n/g)].map((x) =>
    x.slice(1, 5).map(Number),
  );
  // Image stream lengths must match the bytes between stream/endstream.
  for (const im of s.matchAll(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g)) {
    const start = im.index + im[0].length;
    const len = Number(im[1]);
    assert.equal(s.slice(start + len, start + len + 10), '\nendstream');
    assert.equal(u8[start], 0xff);
    assert.equal(u8[start + 1], 0xd8);
  }
  return { s, size, count, mediaBoxes, cms };
}

const close = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('PAGE_SIZES contract', () => {
  assert.deepEqual(Object.keys(PAGE_SIZES).sort(), ['a4', 'a5', 'legal', 'letter']);
  assert.equal(PAGE_SIZES.a4.width, 595.28);
  assert.equal(PAGE_SIZES.a4.height, 841.89);
  assert.equal(PAGE_SIZES.letter.label, 'Letter');
});

test('readJpegInfo: RGB, gray, CMYK, progressive', () => {
  assert.deepEqual(readJpegInfo(RGB_40x30), { width: 40, height: 30, components: 3 });
  assert.deepEqual(readJpegInfo(GRAY_20x50), { width: 20, height: 50, components: 1 });
  assert.deepEqual(readJpegInfo(CMYK_16x12), { width: 16, height: 12, components: 4 });
  assert.deepEqual(readJpegInfo(RGB_PROG), { width: 40, height: 30, components: 3 });
  // ArrayBuffer input is accepted too.
  assert.deepEqual(readJpegInfo(RGB_40x30.slice().buffer), { width: 40, height: 30, components: 3 });
});

test('readJpegInfo: throws on non-JPEG / truncated input', () => {
  assert.throws(() => readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), /Not a JPEG/);
  assert.throws(() => readJpegInfo(new Uint8Array(0)), /Not a JPEG/);
  assert.throws(() => readJpegInfo(new TextEncoder().encode('%PDF-1.4 hello')), /Not a JPEG/);
  assert.throws(() => readJpegInfo(RGB_40x30.subarray(0, 100)), /no SOF/);
});

test('createPdf: throws on empty pages', () => {
  assert.throws(() => createPdf([]), /at least one page/);
  assert.throws(() => createPdf(), /at least one page/);
  assert.throws(() => createPdf([{ jpeg: new Uint8Array([1, 2, 3, 4]) }]), /page 1.*Not a JPEG/);
  assert.throws(() => createPdf([{ jpeg: RGB_40x30 }], { pageSize: 'b5' }), /Unknown pageSize/);
});

test("createPdf 'fit', 1 page @150dpi: 40x30px -> 19.2x14.4pt", () => {
  const pdf = createPdf([{ jpeg: RGB_40x30 }]);
  assert.ok(pdf instanceof Uint8Array);
  const r = inspect(pdf);
  assert.equal(r.count, 1);
  assert.equal(r.size, 1 + 3 + 3);
  assert.deepEqual(r.mediaBoxes, [[19.2, 14.4]]);
  assert.deepEqual(r.cms, [[19.2, 14.4, 0, 0]]);
  assert.match(r.s, /\/Width 40 \/Height 30 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.match(r.s, /\/Creator \(Scanner\)/);
});

test("createPdf 'fit', 3 mixed pages, custom dpi", () => {
  const pdf = createPdf([{ jpeg: RGB_40x30 }, { jpeg: GRAY_20x50 }, { jpeg: CMYK_16x12 }], { dpi: 72 });
  const r = inspect(pdf);
  assert.equal(r.count, 3);
  assert.equal(r.size, 1 + 3 + 9);
  assert.deepEqual(r.mediaBoxes, [[40, 30], [20, 50], [16, 12]]);
  assert.match(r.s, /\/ColorSpace \/DeviceGray /);
  assert.match(r.s, /\/ColorSpace \/DeviceCMYK \/Decode \[1 0 1 0 1 0 1 0\] /);
});

test("createPdf 'a4', 1 landscape page -> landscape A4, centred, 18pt margin", () => {
  const r = inspect(createPdf([{ jpeg: RGB_40x30 }], { pageSize: 'a4' }));
  assert.equal(r.count, 1);
  assert.deepEqual(r.mediaBoxes, [[841.89, 595.28]]);
  const [w, h, x, y] = r.cms[0];
  // Height-limited: 595.28 - 36 = 559.28 tall, aspect 4:3.
  assert.ok(close(h, 559.28), `h=${h}`);
  assert.ok(close(w, 559.28 * 4 / 3), `w=${w}`);
  assert.ok(close(y, 18));
  assert.ok(close(x, (841.89 - w) / 2));
  assert.ok(close(w / h, 40 / 30, 0.001), 'aspect preserved');
});

test("createPdf 'a4', 3 mixed pages -> auto orientation per page", () => {
  const r = inspect(
    createPdf([{ jpeg: RGB_40x30 }, { jpeg: GRAY_20x50 }, { jpeg: RGB_PROG }], { pageSize: 'a4', margin: 0 }),
  );
  assert.equal(r.count, 3);
  assert.deepEqual(r.mediaBoxes, [
    [841.89, 595.28],
    [595.28, 841.89],
    [841.89, 595.28],
  ]);
  // Portrait gray 20x50 on portrait A4 with no margin: height-limited.
  const [w, h, x, y] = r.cms[1];
  assert.ok(close(h, 841.89));
  assert.ok(close(w, 841.89 * 20 / 50));
  assert.ok(close(y, 0));
  assert.ok(close(x, (595.28 - w) / 2));
});

test('createPdf: forced orientation and other paper sizes', () => {
  const r = inspect(createPdf([{ jpeg: RGB_40x30 }], { pageSize: 'letter', orientation: 'portrait' }));
  assert.deepEqual(r.mediaBoxes, [[612, 792]]);
  const [w, h] = r.cms[0];
  assert.ok(close(w, 612 - 36)); // width-limited
  assert.ok(close(h, (612 - 36) * 30 / 40));
  const r2 = inspect(createPdf([{ jpeg: GRAY_20x50 }], { pageSize: 'legal', orientation: 'landscape' }));
  assert.deepEqual(r2.mediaBoxes, [[1008, 612]]);
  const r3 = inspect(createPdf([{ jpeg: GRAY_20x50 }], { pageSize: 'a5' }));
  assert.deepEqual(r3.mediaBoxes, [[419.53, 595.28]]);
});

test('createPdf: Info dictionary escaping, Unicode as UTF-16BE hex, date format', () => {
  const date = new Date(2024, 0, 2, 3, 4, 5);
  const r = inspect(
    createPdf([{ jpeg: RGB_40x30 }], {
      title: 'Résumé – 日本',
      author: 'A (B) \\ C',
      subject: 'plain',
      creator: 'MyApp',
      producer: 'pdf.js',
      creationDate: date,
    }),
  );
  // "Résumé – 日本" in UTF-16BE with BOM
  const expected =
    '<FEFF' +
    [...'Résumé – 日本']
      .map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
      .join('') +
    '>';
  assert.ok(r.s.includes(`/Title ${expected}`), 'unicode title hex');
  assert.ok(r.s.includes('/Title <FEFF005200E9'), 'BOM then R, é');
  assert.ok(r.s.includes('/Author (A \\(B\\) \\\\ C)'), 'escaped author');
  assert.ok(r.s.includes('/Subject (plain)'));
  assert.ok(r.s.includes('/Creator (MyApp)'));
  assert.ok(r.s.includes('/Producer (pdf.js)'));
  assert.match(r.s, /\/CreationDate \(D:20240102030405(Z|[+-]\d\d'\d\d')\)/);
});

test('createPdf: emoji (surrogate pairs) encoded as UTF-16 code units', () => {
  const r = inspect(createPdf([{ jpeg: GRAY_20x50 }], { title: 'Scan 📄' }));
  assert.ok(r.s.includes('/Title <FEFF005300630061006E0020D83DDCC4>'));
});

test('createPdf: explicit width/height are used for layout', () => {
  const r = inspect(createPdf([{ jpeg: RGB_40x30, width: 40, height: 30 }]));
  assert.deepEqual(r.mediaBoxes, [[19.2, 14.4]]);
});

test('createPdf: many pages is linear and offsets stay exact', () => {
  const pages = Array.from({ length: 200 }, (_, i) => ({ jpeg: i % 2 ? GRAY_20x50 : RGB_40x30 }));
  const pdf = createPdf(pages, { pageSize: 'a4' });
  const r = inspect(pdf);
  assert.equal(r.count, 200);
  assert.equal(r.size, 1 + 3 + 600);
});

test('createPdf: large image bytes copied verbatim', () => {
  // Fake "large" JPEG: valid header followed by padding (layout only, not rendered).
  const big = new Uint8Array(3 * 1024 * 1024);
  big.set(RGB_40x30.subarray(0, RGB_40x30.length - 2));
  big[big.length - 2] = 0xff;
  big[big.length - 1] = 0xd9;
  const pdf = createPdf([{ jpeg: big }, { jpeg: big }]);
  inspect(pdf);
  assert.ok(pdf.length > 2 * big.length);
});

test('createPdfBlob returns application/pdf Blob', async () => {
  const blob = createPdfBlob([{ jpeg: RGB_40x30 }], { pageSize: 'a4' });
  assert.equal(blob.type, 'application/pdf');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(latin1(bytes.subarray(0, 8)), '%PDF-1.4');
});
