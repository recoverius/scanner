import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32 } from '../js/zip.js';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('createZip produces an archive that standard tools can read', () => {
  const files = [
    { name: 'page 01.jpg', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'Résumé – 02.txt', data: new TextEncoder().encode('hello zip') },
  ];
  const zip = createZip(files);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const path = join(dir, 'out.zip');
  writeFileSync(path, zip);
  let out;
  try {
    out = execFileSync('python3', ['-I', '-c', `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({n: list(z.read(n)) for n in z.namelist()}))`, path]).toString();
  } catch (e) {
    if (e.code === 'ENOENT') return; // python not available: skip the external check
    throw e;
  }
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed['page 01.jpg'], [1, 2, 3, 4, 5]);
  assert.equal(new TextDecoder().decode(new Uint8Array(parsed['Résumé – 02.txt'])), 'hello zip');
});
