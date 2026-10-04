// The automated half of the checks for a major update (see tests/CHECKS.md).
// Run from anywhere: node tests/check-all.mjs [--e2e] [--quick]
//
//   syntax      node --check on every .js and .mjs
//   lint        eslint, if /opt/node-tools has it (errors fail; warnings are listed,
//               except "defined but never used" for names other scripts use)
//   manifest    every file named in manifest.json exists
//   in step     popup.js DEFAULTS against content.js DEFAULTS; the theme palettes and
//               the Match colour maths in theme.js against background.js
//   tests       schedule, capture, interp and pairs (the last two need Chromium)
//   popup       height of the main view and both flavours of the settings view, in
//               headless Chromium with the extension loaded (the limit is 600 px)
//   --e2e       the extension run in headless Chromium: a real key press saves
//               frames, a made-up one does not, Stats off does not (needs ffmpeg)
//   --quick     skip the slow tests (interp, pairs) and the popup and e2e runs
//
// Exit code 0 only if nothing failed. A SKIP says what was missing. This does not
// replace the three reviews or trying it on real video (tests/CHECKS.md).
import fs from 'fs';
import os from 'os';
import vm from 'vm';
import path from 'path';
import http from 'http';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const results = [];
const out = (status, name, detail = '') => {
  results.push(status);
  console.log(`${status.padEnd(5)} ${name}${detail ? `  ${detail}` : ''}`);
};
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, encoding: 'utf8', timeout: 600000, ...opts });

// ---- syntax --------------------------------------------------------------
const files = [
  ...fs.readdirSync(root).filter((f) => f.endsWith('.js')),
  ...fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.mjs')).map((f) => `tests/${f}`),
];
const bad = files.filter((f) => run(process.execPath, ['--check', f]).status !== 0);
out(bad.length ? 'FAIL' : 'PASS', 'syntax', bad.length ? bad.join(', ') : `${files.length} files`);

// ---- lint ----------------------------------------------------------------
const eslint = '/opt/node-tools/node_modules/.bin/eslint';
if (!fs.existsSync(eslint)) {
  out('SKIP', 'lint', 'no eslint in /opt/node-tools');
} else {
  const globals = Object.fromEntries('window document chrome navigator self location console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame performance Worker MessageChannel URL Image OffscreenCanvas createImageBitmap fetch localStorage matchMedia addEventListener parent top GPUBufferUsage GPUTextureUsage GPUShaderStage GPUMapMode MutationObserver ResizeObserver IntersectionObserver AudioContext queueMicrotask Promise MediaStream getComputedStyle HTMLVideoElement Event CSS TextDecoder TextEncoder Blob structuredClone requestIdleCallback PerformanceObserver BroadcastChannel globalThis postMessage importScripts ImageData VideoFrame CustomEvent DOMException AbortController WebAssembly Float32Array'.split(' ').map((g) => [g, 'readonly']));
  const config = path.join(os.tmpdir(), `headroom-eslint-${process.pid}.mjs`);
  fs.writeFileSync(config, `export default [{files:["**/*.js"],languageOptions:{ecmaVersion:2024,sourceType:"script",globals:${JSON.stringify({ ...globals, onmessage: 'writable' })}},rules:{"no-unused-vars":["warn",{args:"none",caughtErrors:"none"}],"no-undef":"off","no-redeclare":"error","no-empty":"off","no-dupe-keys":"error","no-unreachable":"warn","no-shadow-restricted-names":"error","no-useless-escape":"warn","no-cond-assign":"warn","no-fallthrough":"warn"}}];`);
  const r = run(eslint, ['-c', config, '-f', 'json', ...files.filter((f) => f.endsWith('.js'))]);
  fs.rmSync(config, { force: true });
  try {
    const rep = JSON.parse(r.stdout);
    const msgs = rep.flatMap((f) => f.messages.map((m) => ({ ...m, file: path.basename(f.filePath) })));
    const errors = msgs.filter((m) => m.severity === 2);
    // Top-level names are shared between the content scripts, so one file's
    // "never used" is another's use.
    const other = msgs.filter((m) => m.severity === 1 && m.ruleId !== 'no-unused-vars');
    out(errors.length ? 'FAIL' : 'PASS', 'lint', `${errors.length} errors, ${other.length} other warnings`);
    for (const m of [...errors, ...other]) console.log(`        ${m.file}:${m.line} ${m.ruleId}: ${m.message}`);
  } catch {
    out('FAIL', 'lint', 'eslint did not run: ' + (r.stderr || r.stdout).slice(0, 200));
  }
}

// ---- manifest ------------------------------------------------------------
{
  const m = JSON.parse(read('manifest.json'));
  const named = [
    ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    m.background && m.background.service_worker,
    m.action && m.action.default_popup,
    ...Object.values(m.icons || {}),
    ...Object.values((m.action && m.action.default_icon) || {}),
    ...(m.web_accessible_resources || []).flatMap((w) => w.resources || []),
  ].filter(Boolean);
  const missing = [...new Set(named)].filter((f) => !f.includes('*') && !fs.existsSync(path.join(root, f)));
  out(missing.length ? 'FAIL' : 'PASS', 'manifest paths', missing.length ? `missing: ${missing.join(', ')}` : `${new Set(named).size} files, version ${m.version}`);
  const log = read('CHANGELOG.md').match(/^## (\S+)/m);
  out(log && log[1] === m.version ? 'PASS' : 'FAIL', 'changelog heading matches the version', `${log ? log[1] : 'none'} against ${m.version}`);
}

// ---- things kept in step by hand -------------------------------------------
// The text of the { ... } that follows `marker`, found by counting braces.
const braced = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`no "${marker}"`);
  let i = src.indexOf('{', at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced after "${marker}"`);
};
const literal = (text) => vm.runInNewContext(`(${text})`);
try {
  const a = literal(braced(read('popup.js'), 'const DEFAULTS ='));
  const b = literal(braced(read('content.js'), 'const DEFAULTS ='));
  const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  out(diffs.length ? 'FAIL' : 'PASS', 'popup.js DEFAULTS = content.js DEFAULTS', diffs.length ? diffs.map((k) => `${k}: popup ${JSON.stringify(a[k])}, content ${JSON.stringify(b[k])}`).join('; ') : `${Object.keys(a).length} keys`);
} catch (e) {
  out('FAIL', 'DEFAULTS comparison', e.message);
}
try {
  const t = literal(braced(read('theme.js'), 'const HEADROOM_ICON_PALETTES ='));
  const bg = literal(braced(read('background.js'), 'const ICON_PALETTES ='));
  out(JSON.stringify(t) === JSON.stringify(bg) ? 'PASS' : 'FAIL', 'theme palettes: theme.js = background.js', Object.keys(t).join(', '));
  // The Match colour maths: run both, on many colours.
  const themeSrc = read('theme.js'), bgSrc = read('background.js');
  const grab = (src, re) => { const m = re.exec(src); if (!m) throw new Error(`no ${re}`); return m[0]; };
  const hexRgb = grab(themeSrc, /const hexRgb = .*\n/);
  const themeCtx = vm.createContext({});
  vm.runInContext(`${hexRgb}\nconst HEADROOM_MATCH_DEFAULT = '#ff8fc0';\n${grab(themeSrc, /const matchPair = \(hex\) => \{[\s\S]*?\n\};/)}`, themeCtx);
  const bgCtx = vm.createContext({});
  vm.runInContext(`${grab(bgSrc, /const iconHex = .*\n/)}\nlet iconMatch = [255, 143, 192];\n${grab(bgSrc, /const setIconMatch = .*\n/)}\n${grab(bgSrc, /const iconMatchPair = \(\) => \{[\s\S]*?\n\};/)}`, bgCtx);
  let wrong = 0;
  for (let n = 0; n < 200; n++) {
    const hex = '#' + [0, 0, 0].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
    bgCtx.hex = hex;
    vm.runInContext('setIconMatch(hex)', bgCtx);
    const x = JSON.stringify(vm.runInContext(`matchPair(${JSON.stringify(hex)})`, themeCtx));
    const y = JSON.stringify(vm.runInContext('iconMatchPair()', bgCtx));
    if (x !== y) wrong++;
  }
  out(wrong ? 'FAIL' : 'PASS', 'Match colour maths: theme.js = background.js', wrong ? `${wrong} of 200 colours differ` : '200 random colours');
} catch (e) {
  out('FAIL', 'theme comparison', e.message);
}

// ---- the test files ---------------------------------------------------------
const haveChrome = (() => {
  if (process.env.CHROME) return fs.existsSync(process.env.CHROME);
  try { return fs.readdirSync('/opt/pw-browsers').some((x) => x.startsWith('chromium-')); } catch { return false; }
})();
for (const [t, needs] of [['schedule', ''], ['capture', 'python3'], ['interp', 'chrome'], ['pairs', 'chrome']]) {
  if ((needs === 'chrome' && !haveChrome) || (quick && needs === 'chrome')) { out('SKIP', `tests/${t}.test.mjs`, quick ? '--quick' : 'no Chromium found'); continue; }
  const r = run(process.execPath, [`tests/${t}.test.mjs`]);
  const fails = (r.stdout.match(/^FAIL .*/gm) || []);
  out(r.status === 0 ? 'PASS' : 'FAIL', `tests/${t}.test.mjs`, r.status === 0 ? `${(r.stdout.match(/^PASS/gm) || []).length} checks` : (fails[0] || r.stderr.split('\n').slice(0, 2).join(' ')).slice(0, 200));
  for (const f of fails.slice(1, 6)) console.log(`        ${f.slice(0, 200)}`);
}

// ---- the extension in a browser -----------------------------------------------
// hdr: pretend the screen is HDR (the e2e needs it). The popup is measured
// without: with no HDR display its status line is two lines, the tallest case.
async function withExtension(body, hdr = true) {
  const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
  const chrome = process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter((x) => x.startsWith('chromium-')).map((x) => `/opt/pw-browsers/${x}/chrome-linux/chrome`)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-profile-'));
  const ctx = await pw.chromium.launchPersistentContext(dir, {
    headless: false, acceptDownloads: true, executablePath: chrome,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(hdr ? ['--force-color-profile=hdr10'] : [])],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    return await body(ctx, sw.url().split('/')[2]);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const setStore = (page, o) => page.evaluate((v) => new Promise((x) => chrome.storage.local.set(v, x)), o);

if (quick || !haveChrome) {
  out('SKIP', 'popup height', quick ? '--quick' : 'no Chromium found');
} else {
  try {
    await withExtension(async (ctx, id) => {
      const pop = await ctx.newPage();
      await pop.goto(`chrome-extension://${id}/popup.html`);
      const height = () => pop.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      const measured = {};
      for (const theme of ['amber', 'match', 'custom']) {
        await setStore(pop, { theme });
        await pop.reload();
        await pop.waitForTimeout(400);
        const main = await height();
        await pop.click('#cog');
        await pop.waitForTimeout(150);
        measured[`settings (${theme})`] = await height();
        measured[`main (${theme})`] = main;
      }
      await setStore(pop, { theme: 'amber' });
      // CLAUDE.md: main 466, settings 567, 594 with the Match or Custom row.
      for (const [k, v] of Object.entries(measured)) out(v < 600 ? 'PASS' : 'FAIL', `popup height ${k}`, `${v} px (limit 600)`);
    }, false);
  } catch (e) {
    out('FAIL', 'popup height', e.message.split('\n')[0]);
  }
}

if (!args.has('--e2e')) {
  out('SKIP', 'end to end', 'add --e2e');
} else if (!haveChrome || run('ffmpeg', ['-version']).status !== 0) {
  out('SKIP', 'end to end', 'needs Chromium and ffmpeg');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-e2e-'));
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=224x126:rate=10', '-t', '12', '-c:v', 'libvpx', '-b:v', '1M', path.join(tmp, 't.webm')]);
    const server = http.createServer((q, r) => {
      if (q.url.endsWith('.webm')) { r.setHeader('content-type', 'video/webm'); r.end(fs.readFileSync(path.join(tmp, 't.webm'))); return; }
      r.setHeader('content-type', 'text/html');
      r.end('<body style="margin:0"><video id=v muted autoplay loop src="/t.webm" style="width:224px;height:126px"></video>');
    }).listen(0);
    await withExtension(async (ctx) => {
      const page = await ctx.newPage();
      const pop = await ctx.newPage();
      await pop.goto(`chrome-extension://${(await ctx.serviceWorkers())[0].url().split('/')[2]}/popup.html`);
      const url = `http://localhost:${server.address().port}`;
      await page.goto(url);
      await page.bringToFront();
      await page.waitForTimeout(5000);
      let downloads = 0;
      page.on('download', () => downloads++);
      await page.click('#v').catch(() => {});
      // 1. Stats off: the key does nothing.
      await page.keyboard.press('Alt+Shift+KeyC');
      await page.waitForTimeout(2500);
      out(downloads === 0 ? 'PASS' : 'FAIL', 'e2e: Alt+Shift+C with Stats off saves nothing', `${downloads} downloads`);
      await setStore(pop, { stats: true });
      await page.waitForTimeout(1500);
      await page.bringToFront();
      // 2. A made-up key press (not a real one) does nothing.
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', altKey: true, shiftKey: true, bubbles: true })));
      await page.waitForTimeout(2500);
      out(downloads === 0 ? 'PASS' : 'FAIL', 'e2e: a key press made by the page is ignored', `${downloads} downloads`);
      // 3. A real one saves a zip (tried a few times: the tab can lose the keyboard focus).
      let dl = null;
      for (let k = 0; k < 4 && !dl; k++) {
        const wait = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        await page.bringToFront();
        await page.click('#v').catch(() => {});
        await page.keyboard.press('Alt+Shift+KeyC');
        dl = await wait;
      }
      if (!dl) { out('FAIL', 'e2e: a real Alt+Shift+C saves frames', 'no download'); return; }
      const zip = path.join(tmp, 'got.zip');
      await dl.saveAs(zip);
      const listing = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(",".join(z.namelist()))', zip], { encoding: 'utf8' }).trim().split('\n');
      const names = listing[1].split(',');
      const ok = listing[0] === 'None' && ['frame1.png', 'frame2.png', 'frame3.png', 'frame4.png', 'info.json', 'report.txt'].every((n) => names.includes(n));
      out(ok ? 'PASS' : 'FAIL', 'e2e: a real Alt+Shift+C saves four frames, the info and the report', listing.join(' | ').slice(0, 160));
    });
    server.close();
  } catch (e) {
    out('FAIL', 'end to end', e.message.split('\n')[0]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const fail = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.filter((r) => r === 'PASS').length} passed, ${fail} failed, ${results.filter((r) => r === 'SKIP').length} skipped`);
process.exit(fail ? 1 : 0);
