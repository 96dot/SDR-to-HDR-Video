const DEFAULTS = {
  enabled: true, peak: 4, strength: 0.5, sat: 1.15, soften: 0.5, sharpen: 0.35, gamut: 0.5, vivid: 0.5,
  perf: 'auto', timing: 'video',
  split: false, splitPos: 0.5, badge: true, stats: false,
  headroom: 0, sites: {},
};
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
  $('split').checked = state.split;
  $('badge').checked = state.badge;
  $('stats').checked = state.stats;
  $('perf').value = state.perf;
  $('timing').value = state.timing;

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

for (const k of ['enabled', 'split', 'badge', 'stats']) {
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

for (const k of ['perf', 'timing']) {
  $(k).addEventListener('change', (e) => {
    state[k] = e.target.value;
    chrome.storage.local.set({ [k]: state[k] });
  });
}

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

$('calibrate').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('calibrate.html') });
});

chrome.commands.getAll((cmds) => {
  const label = { 'toggle-hdr': 'HDR on/off', 'toggle-split': 'split view' };
  const box = $('keys');
  for (const c of cmds) {
    if (!label[c.name]) continue;
    const item = document.createElement('span');
    const key = document.createElement('kbd');
    key.textContent = c.shortcut || 'not set';
    item.append(key, ` ${label[c.name]}`);
    box.append(item);
  }
  box.title = 'Change shortcuts at chrome://extensions/shortcuts';
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
  let s = null;
  try { s = await chrome.tabs.sendMessage(tabId, { type: 'sdr2hdr-stats' }); } catch {}
  if (!s) { $('statusText').textContent = 'HDR display detected'; $('status').classList.remove('bad'); return; }
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
  if (s.drawn[0] * s.drawn[1] < s.video[0] * s.video[1] * 0.9) text += ` at ${p(s.drawn)}`;
  if (s.paused) text += ', paused';
  else if (s.fps != null) text += `, ${Math.round(s.fps)} fps, ${Math.round(s.drop * 100)}% dropped`;
  if (s.busy) text += ' (busy page)';
  else if (s.level) text += ' (auto-lowered)';
  $('statusText').textContent = text;
  $('status').title = `Video ${s.video.join('x')}, drawn at ${s.drawn.join('x')}` +
    (s.lite ? ', sharpening and debanding off' : '') +
    (s.gap != null ? `. Longest gap between frames: ${Math.round(s.gap)} ms` : '') +
    `. Drawing on every ${s.timing === 'screen' ? 'screen refresh' : 'video frame'}. GPU: ${s.gpu}.` +
    (s.busy ? ' Lowering quality did not reduce dropped frames, so the page itself is too busy; full quality was restored.' : '');
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
