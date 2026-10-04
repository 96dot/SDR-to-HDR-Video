// Scores variations of the smooth-motion picture-mixing shader (SDR2HDR_MIX in
// interp.js) on real frames saved with Alt+Shift+C. For each folder of four
// consecutive frames it makes the picture halfway between frames 1 and 3 and
// compares it with the real frame 2 (and frames 2 and 4 with frame 3), against
// what showing the plain nearer frame would score: the mean difference, out of
// 255, at 960 wide. The motion work is done once per pair; each variation only
// redoes the mixing, so many can be tried in one run.
// Run: node tests/tune.mjs sets.json variants.json [list]
//   sets.json:     [{ "name": "a", "dir": "folder holding frame1.png .. frame4.png" }, ...]
//   variants.json: { "label": [["text in the mix shader", "its replacement"], ...], ... }
//                  ("current": [] is the shader as it is)
//   list:          anything here prints each pair's score too, made-up / plain
// One line per variation: the mean over all pairs (made-up, plain, and the
// mean of made-up / plain), how many pairs came out more than 2% worse than
// the plain frame, and each pair's made-up score.
// Mean error hides the worst places (swirls in a dark sky score low): look at
// the pictures too (tests/pairs.mjs). Needs Playwright and a Chromium
// (PLAYWRIGHT_MODULE and CHROME if they are not in the usual places). The
// browser is started without its sandbox: use frames you saved yourself.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [setsFile, variantsFile, list] = process.argv.slice(2);
if (!setsFile || !variantsFile) { console.error('usage: node tests/tune.mjs sets.json variants.json [list]'); process.exit(2); }
const sets = JSON.parse(fs.readFileSync(setsFile, 'utf8'));
const variants = JSON.parse(fs.readFileSync(variantsFile, 'utf8'));

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const chrome = process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter((x) => x.startsWith('chromium-')).map((x) => `/opt/pw-browsers/${x}/chrome-linux/chrome`)[0];
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'text/javascript');
  res.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1');
const browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/tests/tune.html`);
  await page.evaluate(() => window.ready);
  for (const s of sets) {
    for (const [i, j, k] of [[1, 2, 3], [2, 3, 4]]) {
      const b64 = (n) => fs.readFileSync(`${s.dir}/frame${n}.png`).toString('base64');
      await page.evaluate(([name, a, t, c]) => window.addTriple(name, a, t, c), [`${s.name}:${i}${k}>${j}`, b64(i), b64(j), b64(k)]);
    }
  }
  for (const [label, subs] of Object.entries(variants)) {
    const r = await page.evaluate((x) => window.runVariant(x), subs);
    const mean = (f) => r.reduce((a, x) => a + f(x), 0) / r.length;
    const worse = r.filter((x) => x.made > x.plain * 1.02).length;
    console.log(label.padEnd(34), 'made', mean((x) => x.made).toFixed(2), ' plain', mean((x) => x.plain).toFixed(2), ' ratio', mean((x) => x.made / x.plain).toFixed(3), ' worse-than-plain', `${worse}/${r.length}`, ' | ', r.map((x) => x.made.toFixed(0)).join(' '));
    if (list) console.log(r.map((x) => `  ${x.name} ${x.made.toFixed(1)} / ${x.plain.toFixed(1)}`).join('\n'));
  }
} finally {
  await browser.close();
  server.close();
}
