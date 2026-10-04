// Checks of tests/pairs.mjs (saved frames run through the real smooth-motion
// passes) on a made-up pair of PNG files whose motion is known: the picture
// moves 12 px right and 5 px down between the two frames, so the picture
// made at t = 0.5 should be the same picture moved 6 and 2.5 px, and the
// numbers should say so. Also that the saved-frames route (a zip) works.
// Run: node tests/pairs.test.mjs   (needs python3 for the zip, and what pairs.mjs needs)
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

// PNG writing and reading (8-bit RGBA, not interlaced), enough for this.
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const h = Buffer.alloc(4); h.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([h, t, data, c]); };
function writePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function readPng(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) { const n = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + n); if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); } if (type === 'IDAT') idat.push(d); p += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let pr = 0;
      if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = (v + pr) & 255;
    }
  }
  return { w, h, data: out };
}

// A picture that is the same wherever it is moved to: smooth blobs and
// ridges, as a function of the position, so a shift of whole pixels is exact.
const W = 480, H = 270, MX = 12, MY = 5;
const scene = (x, y) => {
  const g = (a, b, c) => 0.5 + 0.5 * Math.sin(a * x * 0.043 + b * y * 0.051 + c);
  return [g(1.0, 0.7, 0.2) * g(0.6, -1.1, 1.3), g(-0.8, 0.9, 2.1) * 0.7 + 0.2 * g(2.3, 1.7, 0.4), g(1.4, 1.3, 4.0) * g(-1.9, 0.5, 0.6)].map((v) => Math.round(Math.min(1, v) * 255));
};
function frame(sx, sy) {
  const b = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = scene(x - sx, y - sy); b.set([...c, 255], (y * W + x) * 4); }
  return b;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-test-'));
fs.writeFileSync(path.join(dir, 'frame1.png'), writePng(W, H, frame(0, 0)));
fs.writeFileSync(path.join(dir, 'frame2.png'), writePng(W, H, frame(MX, MY)));
// the same pair as a zip, the way Alt+Shift+C makes it
const zip = path.join(os.tmpdir(), `pairs-test-${process.pid}.zip`);
execFileSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor f in ("frame1.png","frame2.png"): z.write(sys.argv[2]+"/"+f,f)\nz.writestr("info.json","{}")\nz.close()', zip, dir]);

const out = path.join(dir, 'out');
const log = execFileSync('node', [path.join(root, 'tests', 'pairs.mjs'), zip, out, '0.5'], { encoding: 'utf8' });
const stats = JSON.parse(fs.readFileSync(path.join(out, 'stats.json'), 'utf8')).pairs[0];
check('zip route made the pair', fs.existsSync(path.join(out, 'pair1-2', 'mid-t50.png')) && fs.existsSync(path.join(out, 'pair1-2', 'fallback-t50.png')) && fs.existsSync(path.join(out, 'pair1-2', 'motion-t50.png')));
check('overall motion is the known shift', Math.abs(stats.globalFlow[0] + MX) < 1 && Math.abs(stats.globalFlow[1] + MY) < 1, `found (${stats.globalFlow.map((v) => v.toFixed(1))}), expected (${-MX}, ${-MY})`);
// the fastest motion is the largest anywhere, edges included (where what slides in has no match), so it is only checked to be at least the shift
check('fastest motion is at least the shift', stats.fastestPx >= Math.hypot(MX, MY) - 2, `${stats.fastestPx.toFixed(1)} px, shift ${Math.hypot(MX, MY).toFixed(1)}`);
check('nothing falls back on a clean shift', stats.fellShare < 0.05, `${(stats.fellShare * 100).toFixed(1)}%`);

// the picture made is the scene moved half of the way
const mid = readPng(fs.readFileSync(path.join(out, 'pair1-2', 'mid-t50.png')));
const truth = frame(MX / 2, MY / 2);
let d = 0, n = 0;
for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 40; x++) for (let c = 0; c < 3; c++) { d += Math.abs(mid.data[(y * W + x) * 4 + c] - truth[(y * W + x) * 4 + c]); n++; }
const plain = readPng(fs.readFileSync(path.join(dir, 'frame1.png')));
let dp = 0;
for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 40; x++) for (let c = 0; c < 3; c++) dp += Math.abs(plain.data[(y * W + x) * 4 + c] - truth[(y * W + x) * 4 + c]);
check('picture made is close to the truth, and far closer than the plain frame', mid.w === W && d / n < 3 && d < dp / 3, `off by ${(d / n).toFixed(2)} of 255 on average; the plain frame ${(dp / n).toFixed(2)}`);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
