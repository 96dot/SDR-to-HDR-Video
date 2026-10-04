// Headless checks of the frame interpolator (interp.js) on a software GPU.
// Run: node tests/interp.test.mjs   (needs Playwright and a Chromium; set
// PLAYWRIGHT_MODULE / CHROME to point at them if they are not in the usual place)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const chrome = process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter((x) => x.startsWith('chromium-')).map((x) => `/opt/pw-browsers/${x}/chrome-linux/chrome`)[0];

const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'text/javascript');
  res.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1');
const browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/tests/interp.html`);
await page.evaluate(() => window.ready);

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

const cases = [
  ['small shift (12, 5 px of 512)', 12 / 512, 5 / 288],
  ['no motion', 0, 0],
  ['large shift (40, -22 px)', 40 / 512, -22 / 288],
  ['fractional shift (7.5, 3.25 px)', 7.5 / 512, 3.25 / 288],
];
for (const [name, mx, my] of cases) {
  const r = await page.evaluate(([a, b]) => window.runSelfTest(a, b), [mx, my]);
  check(`flow and picture: ${name}`, r.ok, `flow error ${r.flowMedian.toFixed(2)} px typical, ${r.flowErr.toFixed(2)} mean, ${(r.flowGood * 100).toFixed(0)}% within 1 px; picture error ${(r.midErr * 100).toFixed(2)}%; ${r.ms.toFixed(0)} ms`);
}
// A cut: the second frame is the first moved far beyond what can be matched.
// The picture between them should be one frame or the other as it is, not a
// blend of the two.
{
  const r = await page.evaluate(() => window.runSelfTest(0.37, 0.51, 0.3));
  check('scene cut: the nearer frame is used, not a blend (t = 0.3)', r.errA < 0.02 && r.errB > 0.1, `differs from the nearer frame by ${(r.errA * 100).toFixed(2)}%, from the other by ${(r.errB * 100).toFixed(2)}%`);
  const q = await page.evaluate(() => window.runSelfTest(0.37, 0.51, 0.8));
  check('scene cut: the nearer frame is used, not a blend (t = 0.8)', q.errB < 0.02 && q.errA > 0.1, `differs from the nearer frame by ${(q.errB * 100).toFixed(2)}%, from the other by ${(q.errA * 100).toFixed(2)}%`);
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
