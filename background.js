// Keyboard shortcuts. Each one just flips a stored setting; every tab's
// content script is already listening for storage changes and reacts.
const TOGGLES = { 'toggle-hdr': 'enabled', 'toggle-split': 'split' };

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-method') {
    // Flip between the shader and the trained model, if one is loaded.
    const cur = await chrome.storage.local.get({ method: 'shader', modelInfo: null });
    if (cur.modelInfo) {
      const method = cur.method === 'model' ? 'shader' : 'model';
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

// One rule per page origin: "media loaded by pages of this origin may be read
// by this origin, cookies included".
async function ensureRule(origin) {
  const rules = await dnr.getSessionRules();
  const mine = (r) => r.action.responseHeaders.some((h) => h.value === origin);
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
      condition: { initiatorDomains: [new URL(origin).hostname], resourceTypes: ['media'] },
    }],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'sdr2hdr-unlock') return;
  (async () => {
    // Only for a site the user has switched this on for. The site is taken
    // from the tab itself, not from the message, so a page can't ask for it.
    const site = new URL(sender.tab.url).hostname;
    const { sites = {} } = await chrome.storage.local.get({ sites: {} });
    if (!(sites[site] && sites[site].unlock)) throw new Error('unlocking is not switched on for ' + site);
    await ensureRule(sender.origin || new URL(sender.url).origin);
  })().then(() => respond({ ok: true }), (e) => respond({ ok: false, error: String(e.message || e) }));
  return true;   // the reply comes later
});

// Any change to the per-site settings: drop every rule. Sites still switched
// on get theirs back the next time one of their videos needs it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.sites) return;
  const rules = await dnr.getSessionRules();
  if (rules.length) await dnr.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
});

// The toolbar uses the same glass icon as the popup, coloured for the saved
// theme. Only the icon's coloured pixels change: its transparency, dark
// shading and white highlights remain intact. Keep these palettes and the
// pixel transform in step with theme.js, which draws the popup's logo.
const ICON_PALETTES = {
  amber: [[255, 197, 102], [255, 157, 60]],
  ocean: [[95, 240, 220], [58, 160, 255]],
  rose: [[255, 143, 192], [192, 107, 255]],
  aurora: [[168, 146, 238], [242, 154, 198]],
};
const iconTheme = (name) => Object.hasOwn(ICON_PALETTES, name) ? name : 'amber';
let iconBitmap = null;
const iconVariants = new Map();

function colourIcon(image, name) {
  const [a, b] = ICON_PALETTES[name];
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
  if (!iconVariants.has(name)) {
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
    iconVariants.set(name, variant);
    variant.catch(() => {
      iconVariants.delete(name);
      iconBitmap = null;
    });
  }
  return iconVariants.get(name);
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
    const stored = await chrome.storage.local.get({ theme: 'amber' });
    if (beforeRead === iconRevision) chooseIconTheme(stored.theme);
  } catch (e) {
    if (beforeRead === iconRevision) chooseIconTheme('amber');
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) chooseIconTheme(changes.theme.newValue);
});
chrome.runtime.onInstalled.addListener(() => { void restoreIconTheme(); });
chrome.runtime.onStartup.addListener(() => { void restoreIconTheme(); });
// A service worker can be stopped between events: restore on every new wake.
void restoreIconTheme();
