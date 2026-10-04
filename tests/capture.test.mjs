// Checks of the frame saver's file making (capture.js), with no GPU or
// browser: the CRC, the zip (read back with the system's own unzip or Python's
// zipfile), and the turning of the GPU's 10-bit frames into 8-bit pictures.
// Run: node tests/capture.test.mjs
import fs from 'fs';
import os from 'os';
import vm from 'vm';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ TextEncoder, Blob, Uint8Array, Uint32Array, Uint8ClampedArray, Date });
vm.runInContext(fs.readFileSync(path.join(root, 'capture.js'), 'utf8'), ctx, { filename: 'capture.js' });
const { sdr2hdrCrc32, sdr2hdrZip, sdr2hdrFrameToRgba } = vm.runInContext('({ sdr2hdrCrc32, sdr2hdrZip, sdr2hdrFrameToRgba })', ctx);

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

// the standard test value for CRC-32
check('crc of "123456789"', sdr2hdrCrc32(new TextEncoder().encode('123456789')) === 0xCBF43926);
check('crc of nothing', sdr2hdrCrc32(new Uint8Array(0)) === 0);

// a zip with odd contents, read back by Python's zipfile (which checks the CRCs)
const big = new Uint8Array(300000).map((_, i) => (i * 31 + (i >> 8)) & 255);
const files = [
  { name: 'frame1.png', data: big },
  { name: 'info.json', data: new TextEncoder().encode('{"é":"ü"}') },
  { name: 'empty.txt', data: new Uint8Array(0) },
];
const blob = sdr2hdrZip(files, new Date(2026, 9, 4, 12, 30, 10));
const bytes = Buffer.from(await blob.arrayBuffer());
const file = path.join(os.tmpdir(), `capture-test-${process.pid}.zip`);
fs.writeFileSync(file, bytes);
const py = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
print(z.testzip())
print(','.join(i.filename for i in z.infolist()))
print(z.read('info.json').decode('utf8'))
print(len(z.read('frame1.png')), sum(z.read('frame1.png')) & 0xFFFFFFFF, len(z.read('empty.txt')))
print(z.infolist()[0].date_time)
`;
const out = execFileSync('python3', ['-c', py, file]).toString().trim().split('\n');
fs.unlinkSync(file);
check('zip passes the CRC test', out[0] === 'None', out[0]);
check('zip has the files in order', out[1] === 'frame1.png,info.json,empty.txt', out[1]);
check('UTF-8 content survives', out[2] === '{"é":"ü"}');
check('big file intact', out[3] === `${big.length} ${big.reduce((a, b) => a + b, 0)} 0`, out[3]);
check('time is recorded', out[4] === '(2026, 10, 4, 12, 30, 10)', out[4]);
check('blob type', blob.type === 'application/zip');

// 10-bit frame to 8-bit: red lowest, row padding skipped
const w = 3, h = 2, rowBytes = 256, stride = rowBytes / 4;
const words = new Uint32Array(stride * h).fill(0xDEADBEEF);   // padding must never be read
const px = (r, g, b) => (r | (g << 10) | (b << 20)) >>> 0;
words[0] = px(1023, 0, 0); words[1] = px(0, 1023, 0); words[2] = px(0, 0, 1023);
words[stride] = px(512, 256, 4); words[stride + 1] = px(3, 2, 1); words[stride + 2] = px(1020, 600, 8);
const rgba = sdr2hdrFrameToRgba(words, w, h, rowBytes);
const exp = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 64, 1, 255, 0, 0, 0, 255, 255, 150, 2, 255];
check('10-bit to 8-bit, red first, padding skipped', exp.every((v, i) => rgba[i] === v) && rgba.length === exp.length, Array.from(rgba).join(','));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
