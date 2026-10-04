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
// A pan across a scene (flat sky, sharp horizon, textured ground, posts) with
// noise that is new every frame, as compression leaves. What slides in at the
// side of the picture is in one frame only, and the picture there must be made
// from that one frame (it was smeared from the edge pixels before 1.3.2).
for (const [name, px, pattern] of [['pan 30 px', 30, 1], ['pan -30 px', -30, 1], ['pan 50 px', 50, 1], ['pan 20 px with posts moving twice as far (parallax)', 20, 2]]) {
  const r = await page.evaluate(([a, p]) => window.runSelfTest(a / 512, 0, 0.5, p, 0.02), [px, pattern]);
  const g = await page.evaluate(([a, p]) => window.runSelfTest(a / 512, 0, 0.5, p, 0.02, 3), [px, pattern]);
  const b = r.bands;
  check(`scene: ${name}: picture, sides, and the share that falls back`, r.midErr < 0.025 && b.left < 0.06 && b.right < 0.06 && b.horizon < 0.04 && g.fellBack < 0.05,
    `picture ${(r.midErr * 100).toFixed(2)}%, left side ${(b.left * 100).toFixed(1)}%, right side ${(b.right * 100).toFixed(1)}%, horizon ${(b.horizon * 100).toFixed(1)}%, ${(g.fellBack * 100).toFixed(1)}% fell back to a real frame`);
}

// The motion the whole picture agrees on (what the picture falls back on where
// the motion found at one place is no good). It used to be an average of the
// motions found weighted by how well they matched, which a flat area (it matches
// any shift) pulled toward nothing: on a picture that is mostly sky it found
// +3.5 px for a pan of -28 px.
for (const [name, px, py, pattern] of [['pan across a scene', 30, 0, 1], ['pan the other way', -30, 0, 1], ['fast pan', 50, 0, 1], ['pan across a picture that is mostly flat sky', 30, 0, 3], ['the same, the other way', -30, 0, 3], ['a fast pan of it', 50, 0, 3], ['a vertical pan of it', 0, 20, 3]]) {
  const r = await page.evaluate(([a, b, p]) => window.runSelfTest(a / 512, b / 288, 0.5, p, 0.02), [px, py, pattern]);
  const want = [-px * 480 / 512, -py * 270 / 288];
  const err = Math.hypot(r.globalFlow[0] - want[0], r.globalFlow[1] - want[1]);
  check(`overall motion: ${name}`, err < 2.5, `found ${r.globalFlow[0].toFixed(1)}, ${r.globalFlow[1].toFixed(1)} px; true ${want[0].toFixed(1)}, ${want[1].toFixed(1)}`);
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
