const DEFAULTS = {
  enabled: true, peak: 4, strength: 0.5, sat: 1.15, soften: 0.5, sharpen: 0.35, gamut: 0.5, vivid: 0.5,
  perf: 'auto', upscale: 'auto', interp: 'off', poll: true,
  split: false, splitPos: 0.5, badge: true, stats: false, hideOriginal: true, pace: true, cue: 'ping',
  method: 'shader', splitLeft: 'original', splitRight: 'shader', modelInfo: null,
  headroom: 0, sites: {},
};
const NEED_MODEL = ['guided', 'model'];     // methods that need a loaded model
const PICTURE = ['peak', 'strength', 'soften', 'sat', 'gamut', 'vivid', 'sharpen'];
const $ = (id) => document.getElementById(id);

const pct = (v) => `${Math.round(v * 100)}%`;
const fmt = {
  peak: (v) => `${v}x white`,
  strength: pct,
  soften: (v) => (v > 0 ? pct(v) : 'Off'),
  sat: (v) => (v > 1 ? `+${Math.round((v - 1) * 100)}%` : 'Off'),
  gamut: (v) => (v > 0 ? pct(v) : 'Off'),
  vivid: (v) => (v > 0 ? pct(v) : 'Off'),
  sharpen: (v) => (v > 0 ? pct(v) : 'Off'),
};

let state = { ...DEFAULTS };
let site = null;   // hostname of the current tab, if it's a normal web page

const siteCfg = () => (site && state.sites[site]) || {};
const isCustom = () => !!siteCfg().custom;

function saveSite(cfg) {
  const sites = { ...state.sites };
  if (cfg.off || cfg.custom || cfg.unlock) sites[site] = cfg; else delete sites[site];
  state.sites = sites;
  chrome.storage.local.set({ sites });
}

// Paint a slider's value label and its filled portion.
function paint(k, v) {
  const el = $(k);
  $(k + 'Val').textContent = fmt[k](v);
  const p = (v - Number(el.min)) / (Number(el.max) - Number(el.min));
  el.style.setProperty('--p', `${Math.round(p * 1000) / 10}%`);
}

function show() {
  $('enabled').checked = state.enabled;
  // Split view: a switch, and a menu for what each side of the line shows.
  const hasModel = !!state.modelInfo;
  $('split').checked = state.split;
  for (const k of ['splitLeft', 'splitRight']) {
    for (const v of NEED_MODEL) $(k).querySelector(`[value=${v}]`).disabled = !hasModel;
    $(k).value = NEED_MODEL.includes(state[k]) && !hasModel ? 'shader' : state[k];
  }
  $('method').value = hasModel && NEED_MODEL.includes(state.method) ? state.method : 'shader';
  for (const v of NEED_MODEL) $('method').querySelector(`[value=${v}]`).disabled = !hasModel;
  $('modelBtn').textContent = hasModel ? 'Change' : 'Load';
  $('methodRow').title = hasModel
    ? `What decides how bright each part of the picture gets. Shader: the built-in rules. Guided: the shader decides how much, and your trained model where, telling lights from things that are merely white. Your model: the model does it all, truer to a film grade and much tamer. (${describeModel(state.modelInfo)}.)`
    : 'What decides how bright each part of the picture gets. Click Load to add a model made with HDR Trainer.';
  // These three shape the shader's own brightness decisions, so they do
  // nothing while the model is making them.
  const shown = state.split ? [state.splitLeft, state.splitRight] : [state.method];
  const modelOnly = hasModel && shown.includes('model') && !shown.includes('shader') && !shown.includes('guided');
  for (const k of ['strength', 'soften', 'vivid']) {
    $(k).closest('.slider').classList.toggle('unused', modelOnly);
  }
  $('badge').checked = state.badge;
  $('stats').checked = state.stats;
  $('hideOriginal').checked = state.hideOriginal;
  $('perf').value = state.perf;
  $('upscale').value = state.upscale;
  $('interp').value = state.interp;
  $('poll').checked = state.poll;
  $('pace').checked = state.pace;
  $('cue').value = state.cue;

  $('siteBox').hidden = !site;
  if (site) {
    $('siteName').textContent = site;
    $('siteName').title = site;
    $('siteOff').checked = !!siteCfg().off;
    $('siteCustom').checked = isCustom();
    $('siteUnlock').checked = !!siteCfg().unlock;
  }
  $('pictureScope').textContent = isCustom() ? site : 'all sites';

  const src = isCustom() ? { ...state, ...siteCfg() } : state;
  for (const k of PICTURE) {
    $(k).value = src[k];
    paint(k, src[k]);
  }

  $('headroomText').textContent = state.headroom > 0
    ? `Display max: ${state.headroom}x white`
    : 'Display max: not calibrated';
}

$('cue').addEventListener('change', (e) => {
  state.cue = e.target.value;
  chrome.storage.local.set({ cue: state.cue });
  SDR2HDR_CUE.play(state.cue);
});
$('cueTest').addEventListener('click', () => { SDR2HDR_CUE.play(state.cue === 'off' ? 'ping' : state.cue); });
// The cog: settings and diagnostics in place of the picture controls.
$('cog').addEventListener('click', () => {
  const open = $('setView').hidden;
  $('setView').hidden = !open;
  $('mainView').hidden = open;
  $('cog').setAttribute('aria-pressed', String(open));
});
// Colour themes (see theme.js).
const fillColour = (el, hex) => { el.style.background = hex; };
const markTheme = () => {
  const now = document.documentElement.dataset.theme || 'amber';
  for (const b of document.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.theme === now));
  $('customRow').hidden = now !== 'custom';
  $('matchRow').hidden = now !== 'match';
  if (now !== 'custom' && now !== 'match') picker.close();
  fillColour($('matchA'), matchColour);
  $('matchSwatch').style.background = `linear-gradient(135deg, ${matchPair(matchColour).map(hexOf).join(', ')})`;
  fillColour($('customA'), customColours[0]);
  fillColour($('customB'), customColours[1]);
  $('customSwatch').style.background = `linear-gradient(135deg, ${customColours[0]}, ${customColours[1]})`;
};
// The Custom theme's two colours, and the Match theme's one: shown as they are
// picked, saved a moment after.
let colourSave = 0, colourPending = null;
const saveColours = () => { if (colourPending) { chrome.storage.local.set(colourPending); colourPending = null; } };
const queueColours = (o) => { clearTimeout(colourSave); colourPending = o; colourSave = setTimeout(saveColours, 250); };
const pickMatch = (hex) => {
  applyTheme('match', null, hex);
  fillColour($('matchA'), matchColour);
  $('matchSwatch').style.background = `linear-gradient(135deg, ${matchPair(matchColour).map(hexOf).join(', ')})`;
  queueColours({ theme: 'match', themeMatch: matchColour });
};
const pickCustom = (i) => (hex) => {
  const c = customColours.slice();
  c[i] = hex;
  applyTheme('custom', c);
  fillColour($(i ? 'customB' : 'customA'), hex);
  $('customSwatch').style.background = `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
  queueColours({ theme: 'custom', themeColours: c });
};

// The colour picker: a glass panel inside the popup (the browser's own colour
// dialog can't be styled, and can close the popup while it is open). A square
// for how vivid and how bright, a strip for the colour itself, and a box for
// a hex code. It floats over the cards below, so the popup doesn't grow.
const picker = (() => {
  const el = $('picker'), pad = $('pad'), strip = $('hue'), box = $('pickHex');
  let h = 0, s = 1, v = 1, owner = null, onPick = null;
  const rgbOf = () => {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
  };
  const hex = () => '#' + rgbOf().map((x) => x.toString(16).padStart(2, '0')).join('');
  const load = (x) => {
    const [r, g, b] = hexRgb(x).map((n) => n / 255);
    const hi = Math.max(r, g, b), d = hi - Math.min(r, g, b);
    v = hi; s = hi ? d / hi : 0;
    if (d) { h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  };
  const draw = (typing) => {
    pad.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
    $('padKnob').style.cssText = `left:${s * 100}%;top:${(1 - v) * 100}%;background:${hex()}`;
    $('hueKnob').style.cssText = `left:${h / 360 * 100}%;background:hsl(${h} 100% 50%)`;
    strip.setAttribute('aria-valuenow', String(Math.round(h)));
    $('pickChip').style.background = hex();
    if (!typing) box.value = hex();
  };
  const emit = (typing) => { draw(typing); if (onPick) onPick(hex()); };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const drag = (node, move) => {
    node.addEventListener('pointerdown', (e) => { node.setPointerCapture(e.pointerId); move(e); });
    node.addEventListener('pointermove', (e) => { if (node.hasPointerCapture(e.pointerId)) move(e); });
  };
  const at = (node, e) => { const r = node.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]; };
  drag(pad, (e) => { const [x, y] = at(pad, e); s = x; v = 1 - y; emit(); });
  drag(strip, (e) => { h = at(strip, e)[0] * 359.999; emit(); });
  pad.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault(); s = clamp(s + d[0]); v = clamp(v + d[1]); emit();
  });
  strip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d == null) return;
    e.preventDefault(); h = (h + d + 360) % 360; emit();
  });
  box.addEventListener('input', () => {
    const x = box.value.trim();
    if (!/^#?[0-9a-f]{6}$/i.test(x)) return;
    load(x.startsWith('#') ? x : '#' + x); emit(true);
  });
  box.addEventListener('blur', () => draw());
  const close = () => { if (el.hidden) return; el.hidden = true; if (owner) owner.setAttribute('aria-expanded', 'false'); owner = null; onPick = null; };
  const open = (btn, current, pick) => {
    if (owner === btn) { close(); return; }
    close();
    owner = btn; onPick = null; load(current); draw();
    const card = btn.closest('section');
    el.style.top = `${card.offsetTop + card.offsetHeight + 4}px`;
    el.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onPick = pick;
  };
  addEventListener('pointerdown', (e) => { if (!el.hidden && !el.contains(e.target) && !(owner && owner.contains(e.target))) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); const o = owner; close(); if (o) o.focus(); } });
  return { open, close };
})();
$('matchA').addEventListener('click', (e) => picker.open(e.currentTarget, matchColour, pickMatch));
$('customA').addEventListener('click', (e) => picker.open(e.currentTarget, customColours[0], pickCustom(0)));
$('customB').addEventListener('click', (e) => picker.open(e.currentTarget, customColours[1], pickCustom(1)));
// The popup can be closed inside that moment: save at once if so.
for (const ev of ['pagehide', 'blur']) addEventListener(ev, () => { clearTimeout(colourSave); saveColours(); });
for (const b of document.querySelectorAll('.swatch')) {
  b.addEventListener('click', () => {
    picker.close();
    clearTimeout(colourSave);
    colourPending = null;
    applyTheme(b.dataset.theme);
    try { localStorage.setItem('theme', b.dataset.theme); } catch (e) {}
    chrome.storage.local.set(b.dataset.theme === 'custom' ? { theme: 'custom', themeColours: customColours } : b.dataset.theme === 'match' ? { theme: 'match', themeMatch: matchColour } : { theme: b.dataset.theme });
    markTheme();
  });
}
markTheme();
chrome.storage.local.get({ theme: 'amber' }, () => setTimeout(markTheme, 50));
for (const k of ['enabled', 'badge', 'stats', 'split', 'hideOriginal', 'poll', 'pace']) {
  $(k).addEventListener('change', (e) => {
    state[k] = e.target.checked;
    chrome.storage.local.set({ [k]: state[k] });
  });
}

for (const k of PICTURE) {
  $(k).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    paint(k, v);
    if (isCustom()) {
      saveSite({ ...siteCfg(), [k]: v });
    } else {
      state[k] = v;
      chrome.storage.local.set({ [k]: v });
    }
  });
}

function describeModel(m) {
  const bits = [];
  if (m.steps != null) bits.push(`${m.steps.toLocaleString()} training steps`);
  if (m.movies != null) bits.push(`${m.movies} movie${m.movies === 1 ? '' : 's'}`);
  if (m.exported) bits.push(`exported ${m.exported}`);
  return bits.join(', ') || 'loaded';
}

// Choosing what a side shows also turns split view on: that's why you chose.
for (const k of ['splitLeft', 'splitRight']) {
  $(k).addEventListener('change', (e) => {
    state[k] = e.target.value;
    state.split = true;
    chrome.storage.local.set({ [k]: state[k], split: true });
    show();
  });
}
$('split').addEventListener('change', show);

$('modelBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('model.html') });
});

$('perf').addEventListener('change', (e) => {
  state.perf = e.target.value;
  chrome.storage.local.set({ perf: state.perf });
});

$('upscale').addEventListener('change', (e) => {
  state.upscale = e.target.value;
  chrome.storage.local.set({ upscale: state.upscale });
});

$('interp').addEventListener('change', (e) => {
  state.interp = e.target.value;
  chrome.storage.local.set({ interp: state.interp });
});

// Changing the method also puts it on the right of the split, so the split
// keeps showing "the original against what I'm using" unless you set it up
// differently afterwards.
$('method').addEventListener('change', (e) => {
  state.method = state.splitRight = e.target.value;
  chrome.storage.local.set({ method: state.method, splitRight: state.splitRight });
  show();
});

$('siteOff').addEventListener('change', (e) => {
  const cfg = { ...siteCfg() };
  if (e.target.checked) cfg.off = true; else delete cfg.off;
  saveSite(cfg);
});

$('siteUnlock').addEventListener('change', (e) => {
  const cfg = { ...siteCfg() };
  if (e.target.checked) cfg.unlock = true; else delete cfg.unlock;
  saveSite(cfg);
});

$('siteCustom').addEventListener('change', (e) => {
  const cfg = { ...siteCfg() };
  if (e.target.checked) {
    // Start the site's own settings from whatever is on screen now.
    cfg.custom = true;
    for (const k of PICTURE) cfg[k] = state[k];
  } else {
    delete cfg.custom;
    for (const k of PICTURE) delete cfg[k];
  }
  saveSite(cfg);
  show();
});

$('reset').addEventListener('click', () => {
  const picture = {};
  for (const k of PICTURE) picture[k] = DEFAULTS[k];
  if (isCustom()) {
    saveSite({ ...siteCfg(), ...picture });
  } else {
    Object.assign(state, picture);
    chrome.storage.local.set(picture);
  }
  show();
});

// Copy a diagnostic report for the video on this tab to the clipboard.
$('copyReport').addEventListener('click', async () => {
  const btn = $('copyReport');
  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { type: 'sdr2hdr-report' }); } catch {}
  let label = 'No reply';     // nothing on the page answered: see the status line at the top
  if (r && r.text) {
    try { await navigator.clipboard.writeText(r.text); label = 'Copied'; } catch { label = 'Failed'; }
  }
  btn.textContent = label;
  setTimeout(() => { btn.textContent = 'Copy report'; }, 1800);
});

$('calibrate').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('calibrate.html') });
});

// Keyboard shortcuts are shown as tooltips on the controls they work.
chrome.commands.getAll((cmds) => {
  const where = { 'toggle-hdr': 'enabled', 'toggle-split': 'splitLabel', 'toggle-method': 'method' };
  const intro = {
    'toggle-hdr': 'Turn HDR conversion on or off.',
    'toggle-split': 'Split view: a different picture on each side of a line. Pick the two sides with the menus, and drag the line on the video to move it.',
    'toggle-method': 'Go round the methods: the shader, the shader guided by your trained model, the model.',
  };
  for (const c of cmds) {
    if (!where[c.name]) continue;
    const el = $(where[c.name]);
    if (c.name === 'toggle-method') { el.title = `${intro[c.name]} Shortcut: ${c.shortcut || 'not set'}.`; continue; }
    el.title = `${intro[c.name]} Shortcut: ${c.shortcut || 'not set'} (change it at chrome://extensions/shortcuts).`;
  }
});

const problems = [];
if (!navigator.gpu) problems.push('WebGPU is not available in this browser.');
if (!matchMedia('(dynamic-range: high)').matches) {
  problems.push('Display is not in HDR mode. Turn on HDR in Windows display settings.');
}
$('statusText').textContent = problems.length ? problems.join(' ') : 'HDR display detected';
$('status').classList.toggle('bad', problems.length > 0);

// While the popup is open, show live numbers for the video on this tab.
let tabId = null;
async function pollStats() {
  if (tabId == null || problems.length) return;
  let s = null, absent = false;
  try {
    s = await chrome.tabs.sendMessage(tabId, { type: 'sdr2hdr-stats' });
  } catch (e) {
    // Nothing on the page is listening: the extension's script isn't in it.
    absent = /Receiving end does not exist/i.test(String(e && e.message));
  }
  if (absent && site) {
    // The usual reason: the page was already open when the extension was
    // installed, updated or reloaded. (A few pages never allow extensions.)
    $('statusText').textContent = "The extension isn't running on this page. Refresh the page to start it.";
    $('status').title = 'Pages that were already open when the extension was installed, updated or reloaded need a refresh. A few pages, such as the Chrome Web Store, never allow extensions.';
    $('status').classList.add('bad');
    return;
  }
  if (!s) { $('statusText').textContent = 'HDR display detected'; $('status').title = ''; $('status').classList.remove('bad'); return; }
  if (s.locked) {
    $('statusText').textContent = s.unlock
      ? "A video here is locked and couldn't be unlocked."
      : 'A video here is locked against reading. Try "Unlock locked videos" below.';
    $('status').title = 'The video comes from another server that does not allow it to be read.';
    $('status').classList.add('bad');
    return;
  }
  // "1080p" style label: the short side for an upright video, else the height.
  const p = ([w, h]) => `${h > w ? w : h}p`;
  let text = `Converting ${p(s.video)}`;
  const names = ['original', 'shader', 'model', 'guided'];
  if (s.split) text += `, ${names[s.sides[0]]} | ${names[s.sides[1]]}`;
  else if (s.sides[1] === 2) text += ' with your model';
  else if (s.sides[1] === 3) text += ', guided by your model';
  if (s.modelFailed) text += " (model wouldn't load)";
  if (s.drawn[0] * s.drawn[1] < s.video[0] * s.video[1] * 0.9) text += ` at ${p(s.drawn)}`;
  else if (s.up) text += `, upscaled to ${p(s.drawn)}`;
  if (s.paused) text += ', paused';
  else if (s.fps != null) text += `, ${Math.round(s.fps)} fps, ${Math.round(s.drop * 100)}% dropped`;
  if (s.busy) text += ' (busy page)';
  else if (s.eased) text += ' (every other frame)';
  else if (s.limited) text += ' (lost outside the GPU)';
  else if (s.level) text += ' (auto-lowered)';
  $('statusText').textContent = text;
  $('status').title = `Video ${s.video.join('x')}, drawn at ${s.drawn.join('x')}` +
    (s.lite ? ', sharpening and debanding off' : '') +
    (s.up ? `, upscaled from ${s.up.from} (${s.up.kind === 'best' ? s.up.name : `Fast${s.up.want === 'best' && s.up.why ? `, not Best: ${s.up.why}` : ''}`})` : '') +
    (s.gap != null ? `. Longest gap between frames: ${Math.round(s.gap)} ms` : '') +
    `. Drawing on every ${s.poll ? 'new frame, checked every screen refresh' : 'new frame the browser announces'}. GPU: ${s.gpu}.` +
    (s.busy ? ' Lowering quality did not reduce dropped frames, and the page is busy, so full quality was restored.' : '') +
    (s.eased ? ' Every other frame of the video is being taken for the moment: the decoder was falling behind, or the browser\'s screen queue was stuck.' : '') +
    (s.limited ? ' Frames are being lost, but the GPU has time to spare, so lower quality would not help and was not tried. Check that "Hide original" is on; click Report for the details.' : '');
  $('status').classList.toggle('bad', !s.paused && s.drop != null && s.drop > 0.08);
}
setInterval(pollStats, 1000);

// Load settings and work out which site the popup was opened on.
chrome.storage.local.get(DEFAULTS, (s) => {
  state = s;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    tabId = tabs[0] ? tabs[0].id : null;
    pollStats();
    try {
      const u = new URL(tabs[0].url);
      if (u.protocol === 'http:' || u.protocol === 'https:') site = u.hostname;
    } catch {}
    show();
  });
});
