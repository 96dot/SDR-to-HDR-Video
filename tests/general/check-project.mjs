#!/usr/bin/env node
// A general-purpose project check. No dependencies: Node 18 or later. Copy this
// one file into any project (or run it from anywhere with --dir) and it works
// out what the project is and runs what applies:
//
//   git        uncommitted or unpushed work (a warning, not a failure)
//   syntax     JavaScript (node --check), JSON, Python (py_compile), shell (bash -n),
//              TypeScript (tsc --noEmit, if the project has tsc)
//   lint       eslint (if the project has it and a config), ruff or flake8 for Python
//   scripts    package.json "lint", "typecheck", "test" and "build" (with --build)
//   tests      pytest or unittest for Python, go vet and go test, cargo check and test
//   manifest   a browser-extension manifest.json: every file it names exists, and the
//              version matches the newest CHANGELOG.md heading
//   docs       links between Markdown files point at files that exist
//   secrets    private keys and well-known token shapes left in files
//   big files  files over 5 MB in the repository
//   yours      whatever is in .checks.json at the project's top (see below)
//
// Usage: node check-project.mjs [--dir <project>] [--quick] [--build] [--json] [--only a,b] [--skip a,b]
//   --quick   skip the slow tests (runs lint and syntax only)
//   --build   also run the project's "build" script
//   --json    print the results as JSON (for other tools)
//   --only / --skip   by group name: git syntax lint scripts tests manifest docs secrets size yours
// Exit code: 1 if anything FAILED, otherwise 0. WARN is for a human to look at; SKIP says
// what was missing so that nothing passes by not running.
//
// .checks.json (optional) puts the project's own checks in the same run:
//   {
//     "commands": [ { "name": "end to end", "run": "node tests/e2e.mjs", "optional": false, "timeoutMin": 10 } ],
//     "mustExist": [ "LICENSE", "README.md" ],
//     "inStep": [ { "name": "defaults match",
//                   "a": { "file": "a.js", "regex": "DEFAULTS = (\\{[^}]*\\})" },
//                   "b": { "file": "b.js", "regex": "DEFAULTS = (\\{[^}]*\\})" } } ]
//   }
// "inStep" is for two places that must be kept the same by hand: it takes the first
// capture group of each regex and compares them with whitespace ignored.
// A check does not make a project correct: it finds what a machine can find. The
// reviews, running the thing, and looking at the result are still yours.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(name);
const root = path.resolve(opt('--dir') || process.cwd());
const quick = flag('--quick');
const only = opt('--only') ? opt('--only').split(',') : null;
const skip = opt('--skip') ? opt('--skip').split(',') : [];
const asJson = flag('--json');
if (!fs.existsSync(root)) { console.error(`no such folder: ${root}`); process.exit(2); }

const results = [];
let group = '';
const wanted = (g) => (!only || only.includes(g)) && !skip.includes(g);
const emit = (status, name, detail = '') => {
  results.push({ group, status, name, detail });
  if (!asJson) console.log(`${status.padEnd(5)} ${name}${detail ? `  ${detail}` : ''}`);
};
const lines = (text, n = 4) => String(text).trim().split('\n').slice(0, n).join(' | ').slice(0, 300);
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: (o.timeoutMin || 10) * 60000, maxBuffer: 64 * 1024 * 1024, shell: o.shell || false, env: process.env });
const has = (cmd) => sh(cmd, ['--version']).status === 0;
const exists = (...p) => fs.existsSync(path.join(root, ...p));
const readText = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// All files worth looking at: what git tracks, or else a walk that skips the usual heaps.
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.next', '.cache', 'vendor', 'third_party', '.tox']);
const allFiles = (() => {
  const g = sh('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (g.status === 0 && g.stdout) return g.stdout.split('\0').filter((f) => f && exists(f));
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (e.isDirectory()) { if (!IGNORED.has(e.name)) walk(path.join(d, e.name)); } else out.push(path.join(d, e.name));
    }
  };
  walk('');
  return out;
})();
const skipVendor = (f) => !f.split(path.sep).some((p) => IGNORED.has(p));
const files = allFiles.filter(skipVendor);
const ext = (...e) => files.filter((f) => e.includes(path.extname(f).toLowerCase()));

const begin = (g) => { group = g; return wanted(g); };

// ---- git ---------------------------------------------------------------------
if (begin('git')) {
  if (sh('git', ['rev-parse', '--is-inside-work-tree']).status !== 0) {
    emit('SKIP', 'git', 'not a git repository');
  } else {
    const st = sh('git', ['status', '--porcelain']).stdout.trim();
    emit(st ? 'WARN' : 'PASS', 'working tree', st ? `${st.split('\n').length} uncommitted or untracked: ${lines(st, 3)}` : 'clean');
    const up = sh('git', ['rev-list', '--count', '@{u}..HEAD']);
    if (up.status === 0) emit(Number(up.stdout) ? 'WARN' : 'PASS', 'pushed', Number(up.stdout) ? `${up.stdout.trim()} commits not pushed` : 'up to date with its upstream');
    else emit('SKIP', 'pushed', 'no upstream branch');
  }
}

// ---- syntax --------------------------------------------------------------------
if (begin('syntax')) {
  const js = ext('.js', '.mjs', '.cjs');
  if (js.length) {
    const bad = js.filter((f) => sh(process.execPath, ['--check', f]).status !== 0);
    emit(bad.length ? 'FAIL' : 'PASS', 'JavaScript syntax', bad.length ? `broken: ${bad.slice(0, 8).join(', ')}` : `${js.length} files`);
  }
  const json = ext('.json').filter((f) => !/tsconfig|jsconfig|\.vscode|devcontainer/.test(f));
  if (json.length) {
    const bad = json.filter((f) => { try { JSON.parse(readText(f)); return false; } catch { return true; } });
    emit(bad.length ? 'FAIL' : 'PASS', 'JSON files parse', bad.length ? `broken: ${bad.slice(0, 8).join(', ')}` : `${json.length} files`);
  }
  const py = ext('.py');
  if (py.length) {
    const python = ['python3', 'python'].find(has);
    if (!python) emit('SKIP', 'Python syntax', 'no python on this machine');
    else {
      const bad = py.filter((f) => sh(python, ['-m', 'py_compile', f]).status !== 0);
      emit(bad.length ? 'FAIL' : 'PASS', 'Python syntax', bad.length ? `broken: ${bad.slice(0, 8).join(', ')}` : `${py.length} files`);
      for (const f of py) fs.rmSync(path.join(path.dirname(path.join(root, f)), '__pycache__'), { recursive: true, force: true });
    }
  }
  const shs = ext('.sh', '.bash');
  if (shs.length) {
    const bad = shs.filter((f) => sh('bash', ['-n', f]).status !== 0);
    emit(bad.length ? 'FAIL' : 'PASS', 'shell syntax', bad.length ? `broken: ${bad.join(', ')}` : `${shs.length} files`);
  }
  if (exists('tsconfig.json')) {
    const tsc = exists('node_modules', '.bin', 'tsc') ? path.join(root, 'node_modules', '.bin', 'tsc') : null;
    if (!tsc) emit('SKIP', 'TypeScript', 'no local tsc (run npm install)');
    else { const r = sh(tsc, ['--noEmit']); emit(r.status === 0 ? 'PASS' : 'FAIL', 'TypeScript (tsc --noEmit)', r.status === 0 ? '' : lines(r.stdout + r.stderr)); }
  }
  if (!js.length && !json.length && !py.length && !shs.length) emit('SKIP', 'syntax', 'no JavaScript, JSON, Python or shell files found');
}

// ---- lint ------------------------------------------------------------------------
if (begin('lint')) {
  const hasEslintConfig = files.some((f) => /^(eslint\.config\.(js|mjs|cjs)|\.eslintrc(\.\w+)?)$/.test(path.basename(f)) && !f.includes(path.sep));
  const eslint = exists('node_modules', '.bin', 'eslint') ? path.join(root, 'node_modules', '.bin', 'eslint') : null;
  if (hasEslintConfig && eslint) {
    const r = sh(eslint, ['.', '-f', 'json']);
    try {
      const rep = JSON.parse(r.stdout);
      const errors = rep.reduce((a, f) => a + f.errorCount, 0), warnings = rep.reduce((a, f) => a + f.warningCount, 0);
      emit(errors ? 'FAIL' : warnings ? 'WARN' : 'PASS', 'eslint', `${errors} errors, ${warnings} warnings`);
    } catch { emit('FAIL', 'eslint', lines(r.stderr || r.stdout)); }
  } else if (hasEslintConfig) emit('SKIP', 'eslint', 'has a config but no local eslint (run npm install)');
  if (ext('.py').length) {
    if (has('ruff')) { const r = sh('ruff', ['check', '.']); emit(r.status === 0 ? 'PASS' : 'FAIL', 'ruff', r.status === 0 ? '' : lines(r.stdout)); }
    else if (has('flake8')) { const r = sh('flake8', ['.']); emit(r.status === 0 ? 'PASS' : 'FAIL', 'flake8', r.status === 0 ? '' : lines(r.stdout)); }
    else emit('SKIP', 'Python lint', 'no ruff or flake8');
  }
}

// ---- package.json scripts ---------------------------------------------------------------
if (begin('scripts') && exists('package.json')) {
  let scripts = {};
  try { scripts = JSON.parse(readText('package.json')).scripts || {}; } catch { emit('FAIL', 'package.json', 'does not parse'); }
  const manager = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : 'npm';
  const names = ['lint', 'typecheck', 'test', ...(flag('--build') ? ['build'] : [])].filter((n) => scripts[n]);
  if (!names.length) emit('SKIP', 'package scripts', 'no lint, typecheck or test script');
  else if (!exists('node_modules')) emit('SKIP', 'package scripts', `no node_modules (run ${manager} install)`);
  else {
    for (const n of names) {
      if (quick && n === 'test') { emit('SKIP', `${manager} run ${n}`, '--quick'); continue; }
      const r = sh(manager, ['run', n], { timeoutMin: 20 });
      emit(r.status === 0 ? 'PASS' : 'FAIL', `${manager} run ${n}`, r.status === 0 ? '' : lines(r.stdout.split('\n').slice(-12).join('\n') + r.stderr, 4));
    }
  }
}

// ---- tests of other kinds -----------------------------------------------------------------
if (begin('tests')) {
  if (quick) {
    emit('SKIP', 'tests', '--quick');
  } else {
    const py = ext('.py');
    if (py.length && (exists('pytest.ini') || exists('pyproject.toml') || exists('tox.ini') || exists('setup.cfg') || py.some((f) => /(^|\/)(test_.*|.*_test)\.py$/.test(f)))) {
      if (has('pytest')) { const r = sh('pytest', ['-q', '-x'], { timeoutMin: 20 }); emit(r.status === 0 ? 'PASS' : r.status === 5 ? 'SKIP' : 'FAIL', 'pytest', r.status === 5 ? 'no tests collected' : lines(r.stdout.split('\n').slice(-6).join('\n'))); }
      else { const python = ['python3', 'python'].find(has); if (python) { const r = sh(python, ['-m', 'unittest', 'discover', '-q'], { timeoutMin: 20 }); emit(r.status === 0 ? 'PASS' : 'FAIL', 'unittest', lines(r.stderr.split('\n').slice(-6).join('\n'))); } else emit('SKIP', 'Python tests', 'no python'); }
    }
    if (exists('go.mod')) {
      if (!has('go')) emit('SKIP', 'go', 'no go on this machine');
      else for (const a of [['vet', './...'], ['test', './...']]) { const r = sh('go', a, { timeoutMin: 20 }); emit(r.status === 0 ? 'PASS' : 'FAIL', `go ${a[0]}`, r.status === 0 ? '' : lines(r.stdout + r.stderr)); }
    }
    if (exists('Cargo.toml')) {
      if (!has('cargo')) emit('SKIP', 'cargo', 'no cargo on this machine');
      else for (const a of [['check'], ['test']]) { const r = sh('cargo', a, { timeoutMin: 30 }); emit(r.status === 0 ? 'PASS' : 'FAIL', `cargo ${a[0]}`, r.status === 0 ? '' : lines(r.stderr.split('\n').slice(-8).join('\n'))); }
    }
  }
}

// ---- a browser extension's manifest, and the changelog ---------------------------------------------
if (begin('manifest') && exists('manifest.json')) {
  let m = null;
  try { m = JSON.parse(readText('manifest.json')); } catch { emit('FAIL', 'manifest.json', 'does not parse'); }
  if (m && m.manifest_version) {
    const named = [
      ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
      m.background && (m.background.service_worker || null), ...((m.background && m.background.scripts) || []),
      m.action && m.action.default_popup, m.browser_action && m.browser_action.default_popup, m.options_page, m.devtools_page,
      ...Object.values(m.icons || {}), ...Object.values((m.action && m.action.default_icon) || {}),
      ...(m.web_accessible_resources || []).flatMap((w) => (typeof w === 'string' ? [w] : w.resources || [])),
    ].filter((x) => typeof x === 'string');
    const missing = [...new Set(named)].filter((f) => !/[*?]/.test(f) && !exists(f));
    emit(missing.length ? 'FAIL' : 'PASS', 'manifest paths', missing.length ? `missing: ${missing.join(', ')}` : `${new Set(named).size} files named, version ${m.version}`);
    if (exists('CHANGELOG.md')) {
      const top = readText('CHANGELOG.md').match(/^##\s+\[?v?(\d[\w.\-+]*)/m);
      if (top) emit(top[1] === m.version ? 'PASS' : 'FAIL', 'changelog heading matches the manifest version', `${top[1]} against ${m.version}`);
    }
  }
}

// ---- Markdown links -----------------------------------------------------------------------------------
if (begin('docs')) {
  const broken = [];
  for (const f of ext('.md')) {
    const text = readText(f).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const full = target.startsWith('/') ? path.join(root, target) : path.join(root, path.dirname(f), decodeURIComponent(target));
      if (!fs.existsSync(full)) broken.push(`${f} -> ${target}`);
    }
  }
  if (ext('.md').length) emit(broken.length ? 'WARN' : 'PASS', 'Markdown links to files', broken.length ? `${broken.length} broken: ${broken.slice(0, 5).join('; ')}` : `${ext('.md').length} files`);
}

// ---- secrets and size ------------------------------------------------------------------------------------
if (begin('secrets')) {
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['Anthropic or OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
    ['password in a URL', /[a-z]+:\/\/[^\s:@/]+:[^\s:@/]{3,}@[^\s/]+/i],
  ];
  const hits = [];
  for (const f of files) {
    let size = 0;
    try { size = fs.statSync(path.join(root, f)).size; } catch { continue; }
    if (size > 2 * 1024 * 1024 || /\.(png|jpe?g|gif|webp|ico|zip|gz|woff2?|ttf|mp4|webm|pdf|bin|wasm)$/i.test(f)) continue;
    const text = readText(f);
    for (const [name, re] of patterns) if (re.test(text)) hits.push(`${f} (${name})`);
  }
  emit(hits.length ? 'FAIL' : 'PASS', 'secrets left in files', hits.length ? hits.slice(0, 6).join('; ') : `${files.length} files looked at`);
}
if (begin('size')) {
  const big = files.filter((f) => { try { return fs.statSync(path.join(root, f)).size > 5 * 1024 * 1024; } catch { return false; } });
  emit(big.length ? 'WARN' : 'PASS', 'files over 5 MB', big.length ? big.slice(0, 5).join(', ') : 'none');
}

// ---- the project's own checks (.checks.json) ---------------------------------------------------------------
if (begin('yours') && exists('.checks.json')) {
  let cfg = null;
  try { cfg = JSON.parse(readText('.checks.json')); } catch (e) { emit('FAIL', '.checks.json', `does not parse: ${e.message}`); }
  for (const f of (cfg && cfg.mustExist) || []) emit(exists(f) ? 'PASS' : 'FAIL', `exists: ${f}`);
  for (const c of (cfg && cfg.inStep) || []) {
    try {
      const pick = (side) => { const m = new RegExp(side.regex).exec(readText(side.file)); if (!m) throw new Error(`no match for ${side.regex} in ${side.file}`); return (m[1] ?? m[0]).replace(/\s+/g, ' ').trim(); };
      const a = pick(c.a), b = pick(c.b);
      emit(a === b ? 'PASS' : 'FAIL', c.name, a === b ? '' : `${c.a.file}: ${a.slice(0, 80)} | ${c.b.file}: ${b.slice(0, 80)}`);
    } catch (e) { emit('FAIL', c.name || 'in step', e.message); }
  }
  for (const c of (cfg && cfg.commands) || []) {
    if (quick && c.slow) { emit('SKIP', c.name, '--quick'); continue; }
    const r = sh(c.run, [], { shell: true, timeoutMin: c.timeoutMin || 10 });
    const ok = r.status === 0;
    emit(ok ? 'PASS' : c.optional ? 'WARN' : 'FAIL', c.name || c.run, ok ? '' : lines((r.stdout || '').split('\n').slice(-8).join('\n') + (r.stderr || ''), 4));
  }
} else if (wanted('yours')) {
  group = 'yours';
}

// ---- the end ---------------------------------------------------------------------------------------------------
const count = (s) => results.filter((r) => r.status === s).length;
if (asJson) {
  console.log(JSON.stringify({ project: root, passed: count('PASS'), failed: count('FAIL'), warnings: count('WARN'), skipped: count('SKIP'), results }, null, 2));
} else {
  console.log(`\n${path.basename(root)}: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('WARN')} to look at, ${count('SKIP')} skipped`);
  if (!results.length) console.log('Nothing applied: add a .checks.json (see the top of this file) or run from the project folder.');
}
process.exit(count('FAIL') ? 1 : 0);
