// Runs saved frames (the zip from Alt+Shift+C, or a folder of PNGs) through the
// real smooth-motion passes in headless Chromium on a software GPU, so that its
// thresholds can be judged on real footage. For each neighbouring pair it
// writes the picture made between them, where it fell back (red), the motion
// found, and the numbers (see SDR2HDR_CUT and SDR2HDR_STATS in interp.js).
// Run: node tests/pairs.mjs <frames.zip | folder> [out folder] [t,t,...]
//   e.g. node tests/pairs.mjs headroom-frames-youtube.com-20261004.zip out 0.25,0.5,0.75
// The browser is started without its sandbox (as in interp.test.mjs), so use
// frames you saved yourself, not a zip from someone else.
// Needs Playwright and a Chromium (PLAYWRIGHT_MODULE / CHROME if not in the usual place).
// The frames are as saved (never wider than 1920), so a 4K source is judged
// here at a smaller size than the converter sees; the numbers are measured on
// a coarse grid and should hardly change.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [input, outArg, tArg] = process.argv.slice(2);
if (!input) { console.error('usage: node tests/pairs.mjs <frames.zip | folder> [out folder] [t,t,...]'); process.exit(2); }
const out = path.resolve(outArg || 'pairs-out');
const times = (tArg || '0.5').split(',').map(Number);
if (!times.length || times.some((t) => !(t > 0 && t < 1))) { console.error('t must be numbers between 0 and 1'); process.exit(2); }

let dir = path.resolve(input);
let tmp = '';
if (dir.endsWith('.zip')) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-'));
  execFileSync('python3', ['-m', 'zipfile', '-e', dir, tmp]);
  dir = tmp;
}
const frames = fs.readdirSync(dir).filter((f) => /^frame\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
if (frames.length < 2) { console.error('need at least two frameN.png files'); process.exit(2); }
let info = {};
try { info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8')); } catch {}

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const chrome = process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter((x) => x.startsWith('chromium-')).map((x) => `/opt/pw-browsers/${x}/chrome-linux/chrome`)[0];
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'text/javascript');
  res.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1');
const browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/tests/pairs.html`);
await page.evaluate(() => window.ready);

fs.mkdirSync(out, { recursive: true });
const all = [];
for (let i = 0; i + 1 < frames.length; i++) {
  const a = fs.readFileSync(path.join(dir, frames[i])).toString('base64');
  const b = fs.readFileSync(path.join(dir, frames[i + 1])).toString('base64');
  const name = `pair${i + 1}-${i + 2}`;
  let r;
  try {
    r = await page.evaluate(([x, y, t]) => window.runPair(x, y, t), [a, b, times]);
  } catch (e) {
    console.log(`${name}  skipped: ${e.message.split('\n')[0]}`);
    continue;
  }
  fs.mkdirSync(path.join(out, name), { recursive: true });
  for (const im of r.images) fs.writeFileSync(path.join(out, name, im.name), Buffer.from(im.png, 'base64'));
  all.push({ pair: name, ...r.stats });
  const s = r.stats;
  console.log(`${name}  ${s.size.join('x')}  mismatch ${s.cutCoarse.toFixed(3)} coarse / ${s.cutFine.toFixed(3)} fine, fastest ${s.fastestPx.toFixed(1)}, overall motion (${s.globalFlow.map((v) => v.toFixed(1)).join(', ')}), both in pixels of a 480-wide grid, fell back ${(s.fellShare * 100).toFixed(1)}%${s.flowed ? '' : '  (no flow made)'}`);
}
fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify({ source: info, t: times, pairs: all }, null, 2));
console.log(`written to ${out}`);
await browser.close();
server.close();
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
