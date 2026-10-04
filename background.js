// Keyboard shortcuts. Each one just flips a stored setting; every tab's
// content script is already listening for storage changes and reacts.
const TOGGLES = { 'toggle-hdr': 'enabled', 'toggle-split': 'split' };

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-method') {
    // Go round the methods, if a trained model is loaded: the shader, the
    // shader guided by the model, the model.
    const cur = await chrome.storage.local.get({ method: 'shader', modelInfo: null });
    if (cur.modelInfo) {
      const round = ['shader', 'guided', 'model'];
      const method = round[(round.indexOf(cur.method) + 1) % round.length];
      await chrome.storage.local.set({ method, splitRight: method });   // the split's right side follows the method
    }
    return;
  }
  const key = TOGGLES[command];
  if (!key) return;
  const cur = await chrome.storage.local.get({ enabled: true, split: false });
  await chrome.storage.local.set({ [key]: !cur[key] });
});

// ---- Unlocking videos the browser won't let a page read --------------------
//
// A video served from another site can be read only if that site's response
// carries headers saying so. For sites where the user has switched unlocking
// on, we add those headers ourselves, to media requests made by that page
// only. Rules live for the browser session and are made on demand.

const dnr = chrome.declarativeNetRequest;

// One rule per page origin and tab: "media loaded by pages of this origin in
// this tab may be read by this origin, cookies included". Made one at a time,
// so two videos asking at once can't be given the same rule number.
let ruleQueue = Promise.resolve();
const ensureRule = (origin, tabId) => (ruleQueue = ruleQueue.then(() => makeRule(origin, tabId), () => makeRule(origin, tabId)));
const ruleOrigin = (r) => ((r.action.responseHeaders || []).find((h) => h.header === 'access-control-allow-origin') || {}).value || '';
async function makeRule(origin, tabId) {
  const rules = await dnr.getSessionRules();
  const mine = (r) => ruleOrigin(r) === origin && (r.condition.tabIds || []).includes(tabId);
  if (rules.some(mine)) return;
  const id = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  await dnr.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'access-control-allow-origin', operation: 'set', value: origin },
          { header: 'access-control-allow-credentials', operation: 'set', value: 'true' },
        ],
      },
      condition: { initiatorDomains: [new URL(origin).hostname], resourceTypes: ['media'], tabIds: [tabId] },
    }],
  });
}

// The text of one of the upscaling network's files (see upnet.js), for a page
// that is about to use it. Only the two files there are can be asked for.
const UPNET_FILES = {
  x16: 'third_party/fsrcnnx/FSRCNNX_x2_16-0-4-1.glsl',
  x8: 'third_party/fsrcnnx/FSRCNNX_x2_8-0-4-1.glsl',
};
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'sdr2hdr-upnet' || !Object.hasOwn(UPNET_FILES, msg.key)) return;
  fetch(chrome.runtime.getURL(UPNET_FILES[msg.key])).then((r) => {
    if (!r.ok) throw new Error(`the file could not be read (${r.status})`);
    return r.text();
  }).then((text) => respond({ ok: true, text }), (e) => respond({ ok: false, error: String(e.message || e) }));
  return true;   // the reply comes later
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'sdr2hdr-unlock') return;
  (async () => {
    // Only for a site the user has switched this on for. The site is taken
    // from the tab itself, not from the message, so a page can't ask for it.
    const site = new URL(sender.tab.url).hostname;
    const { sites = {} } = await chrome.storage.local.get({ sites: {} });
    if (!(sites[site] && sites[site].unlock)) throw new Error('unlocking is not switched on for ' + site);
    // And only for the site's own frames. A frame from somewhere else inside
    // the page (an advert, an embed) is not what the user switched this on
    // for: a rule for its origin would let that other site read media with
    // the user's cookies.
    const origin = sender.origin || new URL(sender.url).origin;
    const host = new URL(origin).hostname;
    if (host !== site && !host.endsWith('.' + site)) throw new Error(`this video is in a frame from ${host}, not from ${site}`);
    await ensureRule(origin, sender.tab.id);
  })().then(() => respond({ ok: true }), (e) => respond({ ok: false, error: String(e.message || e) }));
  return true;   // the reply comes later
});

// A change to the per-site settings: drop the rules of sites that no longer
// have unlocking switched on. The others stay, because a video that is
// playing through one stops loading the moment its rule goes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.sites) return;
  const sites = changes.sites.newValue || {};
  const on = (host) => Object.keys(sites).some((s) => sites[s] && sites[s].unlock && (host === s || host.endsWith('.' + s)));
  ruleQueue = ruleQueue.then(async () => {
    const rules = await dnr.getSessionRules();
    const gone = rules.filter((r) => { try { return !on(new URL(ruleOrigin(r)).hostname); } catch (e) { return true; } });
    if (gone.length) await dnr.updateSessionRules({ removeRuleIds: gone.map((r) => r.id) });
  }).catch(() => {});
});
// A closed tab's rules are of no more use.
chrome.tabs.onRemoved.addListener((tabId) => {
  ruleQueue = ruleQueue.then(async () => {
    const rules = await dnr.getSessionRules();
    const gone = rules.filter((r) => (r.condition.tabIds || []).includes(tabId));
    if (gone.length) await dnr.updateSessionRules({ removeRuleIds: gone.map((r) => r.id) });
  }).catch(() => {});
});

// The toolbar uses the same glass icon as the popup, coloured for the saved
// theme. Only the icon's coloured pixels change: its transparency, dark
// shading and white highlights remain intact. Keep these palettes and the
// pixel transform in step with theme.js, which draws the popup's logo.
const ICON_PALETTES = {
  amber: [[255, 197, 102], [255, 157, 60]],
  ocean: [[95, 240, 220], [58, 160, 255]],
  aurora: [[168, 146, 238], [242, 154, 198]],
};
const iconTheme = (name) => (name === 'custom' || name === 'match' || Object.hasOwn(ICON_PALETTES, name) ? name : 'amber');
// The Custom theme's two colours (see theme.js).
let iconCustom = [[124, 240, 192], [77, 124, 255]];
const iconHex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const setIconCustom = (c) => { if (Array.isArray(c) && c.length === 2 && iconHex(c[0]) && iconHex(c[1])) iconCustom = [iconHex(c[0]), iconHex(c[1])]; };
// The Match theme's one colour, and the second one worked out from it. Keep
// this in step with matchPair in theme.js.
let iconMatch = [255, 143, 192];
const setIconMatch = (h) => { if (iconHex(h)) iconMatch = iconHex(h); };
const iconMatchPair = () => {
  const [r, g, b] = iconMatch.map((v) => v / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  let h = 0;
  if (d) h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 35 + 360) % 360;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const l2 = Math.max(0, l - 0.06);
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => Math.round(255 * (l2 - s * Math.min(l2, 1 - l2) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [iconMatch, [f(0), f(8), f(4)]];
};
const iconPair = (name) => (name === 'custom' ? iconCustom : name === 'match' ? iconMatchPair() : ICON_PALETTES[name]);
let iconBitmap = null;
const iconVariants = new Map();

function colourIcon(image, name) {
  const [a, b] = iconPair(name);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const r = pixels[i], g = pixels[i + 1], blue = pixels[i + 2];
    const high = Math.max(r, g, blue), low = Math.min(r, g, blue);
    const chroma = high - low;
    if (chroma < 6 || !high) continue;
    let hue;
    if (high === r) hue = ((g - blue) / chroma) % 6;
    else if (high === g) hue = (blue - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    // The source's cyan-to-violet glass maps to the theme's two accents.
    const mix = Math.max(0, Math.min(1, (hue - 165) / 115));
    const saturation = chroma / high;
    for (let channel = 0; channel < 3; channel++) {
      const tint = (a[channel] + (b[channel] - a[channel]) * mix) / 255;
      pixels[i + channel] = Math.round(high * (1 - saturation + saturation * tint));
    }
  }
  return image;
}

async function themedIcon(name) {
  const key = name === 'custom' || name === 'match' ? `${name}:${iconPair(name).join('|')}` : name;
  if (!iconVariants.has(key)) {
    const variant = (async () => {
      if (!iconBitmap) {
        iconBitmap = fetch(chrome.runtime.getURL('icons/icon128.png'))
          .then((response) => {
            if (!response.ok) throw new Error('The icon could not be loaded.');
            return response.blob();
          }).then((blob) => createImageBitmap(blob));
      }
      const bitmap = await iconBitmap;
      const images = {};
      for (const size of [16, 24, 32, 48]) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('The toolbar icon could not be drawn.');
        ctx.drawImage(bitmap, 0, 0, size, size);
        images[size] = colourIcon(ctx.getImageData(0, 0, size, size), name);
      }
      return images;
    })();
    iconVariants.set(key, variant);
    if (iconVariants.size > 12) iconVariants.delete(iconVariants.keys().next().value);
    variant.catch(() => {
      iconVariants.delete(key);
      iconBitmap = null;
    });
  }
  return iconVariants.get(key);
}

let wantedIconTheme = 'amber';
let iconRevision = 0, appliedIconRevision = 0;
let settingIcon = false;

// Serialize writes so a slow image load or an older storage read cannot
// overwrite the theme the user chose most recently.
async function setThemedIcon() {
  if (settingIcon) return;
  settingIcon = true;
  try {
    while (appliedIconRevision < iconRevision) {
      const revision = iconRevision, name = wantedIconTheme;
      try {
        const imageData = await themedIcon(name);
        if (revision !== iconRevision) continue;
        await chrome.action.setIcon({ imageData });
      } catch (e) {
        if (revision !== iconRevision) continue;
        // The packaged icon is always available if canvas decoding fails.
        try {
          await chrome.action.setIcon({ path: {
            16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png',
          } });
        } catch (fallbackError) {}
        console.warn('Headroom HDR could not colour its toolbar icon:', e);
      }
      appliedIconRevision = revision;
    }
  } finally {
    settingIcon = false;
  }
}

function chooseIconTheme(name) {
  wantedIconTheme = iconTheme(name);
  iconRevision++;
  void setThemedIcon();
}

async function restoreIconTheme() {
  const beforeRead = iconRevision;
  try {
    const stored = await chrome.storage.local.get({ theme: 'amber', themeColours: null, themeMatch: null });
    setIconCustom(stored.themeColours);
    setIconMatch(stored.themeMatch);
    if (beforeRead === iconRevision) chooseIconTheme(stored.theme);
  } catch (e) {
    if (beforeRead === iconRevision) chooseIconTheme('amber');
  }
}

let iconRestored = Promise.resolve();
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(changes.theme || changes.themeColours || changes.themeMatch)) return;
  if (changes.themeColours) setIconCustom(changes.themeColours.newValue);
  if (changes.themeMatch) setIconMatch(changes.themeMatch.newValue);
  if (changes.theme) { chooseIconTheme(changes.theme.newValue); return; }
  // Only the colours changed, so the theme is whatever it was. If this event
  // is what woke the worker, that isn't known yet: wait for the stored theme
  // to be read first, or the icon would be redrawn as the default one.
  await iconRestored;
  chooseIconTheme(wantedIconTheme);
});
chrome.runtime.onInstalled.addListener(() => { iconRestored = restoreIconTheme(); });
chrome.runtime.onStartup.addListener(() => { iconRestored = restoreIconTheme(); });
// A service worker can be stopped between events: restore on every new wake.
iconRestored = restoreIconTheme();
