// The colour theme, chosen in the popup's settings. Put on <html> as early as
// it can be, on every page of the extension, so the page doesn't flash in
// another one first.
const HEADROOM_THEMES = { amber: 'Amber', ocean: 'Ocean', aurora: 'Aurora', match: 'Match', custom: 'Custom' };
// These palettes and the pixel transform match background.js so the popup
// and browser toolbar show the same themed glass icon.
const HEADROOM_ICON_PALETTES = {
  amber: [[255, 197, 102], [255, 157, 60]],
  ocean: [[95, 240, 220], [58, 160, 255]],
  aurora: [[168, 146, 238], [242, 154, 198]],
};
const themeName = (name) => Object.hasOwn(HEADROOM_THEMES, name) ? name : 'amber';

// The Custom and Match themes: colours of the user's own, from which everything
// else is worked out (glow, the light behind the glass, a dark page tinted
// with the first, and whether text on the accent should be dark or light).
const HEADROOM_CUSTOM_DEFAULT = ['#7cf0c0', '#4d7cff'];
let customColours = HEADROOM_CUSTOM_DEFAULT.slice();
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const validColours = (c) => (Array.isArray(c) && c.length === 2 && hexRgb(c[0]) && hexRgb(c[1]) ? [c[0], c[1]] : null);
// The Match theme: one colour of the user's own; the second is worked out
// from it (turned 75 degrees round the colour wheel, about as far as Aurora
// does, at the same lightness), so the pair always goes together. Keep this in
// step with background.js.
const HEADROOM_MATCH_DEFAULT = '#ff8fc0';
let matchColour = HEADROOM_MATCH_DEFAULT;
const matchPair = (hex) => {
  const [r, g, b] = (hexRgb(hex) || hexRgb(HEADROOM_MATCH_DEFAULT)).map((v) => v / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  let h = 0;
  if (d) h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 75 + 360) % 360;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const l2 = l;
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => Math.round(255 * (l2 - s * Math.min(l2, 1 - l2) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [hexRgb(hex) || hexRgb(HEADROOM_MATCH_DEFAULT), [f(0), f(8), f(4)]];
};
const hexOf = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const pairOf = (name) => (name === 'custom' ? customColours.map(hexRgb) : name === 'match' ? matchPair(matchColour) : null);
const paletteOf = (name) => pairOf(name) || HEADROOM_ICON_PALETTES[name];
const CUSTOM_VARS = ['--ink-a', '--ink-b', '--accent-a', '--accent-b', '--glow', '--on-accent', '--focus', '--blob1', '--blob2', '--blob3', '--blob4', '--page', '--edge', '--shine'];
function applyCustomVars(pair) {
  const st = document.documentElement.style;
  if (!pair) { for (const v of CUSTOM_VARS) st.removeProperty(v); return; }
  const [a, b] = pair;
  const mix = (x, y, t) => x.map((v, i) => Math.round(v + (y[i] - v) * t));
  const css = (c, alpha) => (alpha == null ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${alpha})`);
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const mid = mix(a, b, 0.5);
  // The accent is also used for writing (the "HDR" in the title, the
  // "recommended" tags), on a dark page. A dark colour is lifted toward
  // white until it can be read there; a bright one is left as it is.
  const readable = (c) => { let t = 0, r = c; while (lum(r) < 0.42 && t < 1) { t += 0.05; r = mix(c, [255, 255, 255], t); } return r; };
  st.setProperty('--ink-a', css(readable(a)));
  st.setProperty('--ink-b', css(readable(b)));
  // A colour too dark to show as a filled slider or a switched-on switch is
  // drawn there with some of the other mixed in (the icon and the page
  // behind keep it as it was picked).
  const fill = (c, other) => (lum(c) < 0.08 ? mix(c, lum(other) < 0.08 ? [150, 150, 160] : other, 0.4) : c);
  st.setProperty('--accent-a', css(fill(a, b)));
  st.setProperty('--accent-b', css(fill(b, a)));
  st.setProperty('--glow', css(lum(mid) < 0.12 ? readable(lum(a) > lum(b) ? a : b) : mid, 0.55));
  st.setProperty('--on-accent', lum(mid) > 0.5 ? '#16120c' : '#ffffff');
  st.setProperty('--focus', css(mix(readable(a), [255, 255, 255], 0.3)));
  st.setProperty('--blob1', css(a));
  st.setProperty('--blob2', css(b));
  st.setProperty('--blob3', css(mix(b, [30, 40, 90], 0.5)));
  st.setProperty('--blob4', css(mix(a, [255, 255, 255], 0.4)));
  st.setProperty('--page', `radial-gradient(120% 90% at 85% 0%, ${css(mix(a, [0, 0, 0], 0.78))} 0%, ${css(mix(b, [8, 10, 22], 0.86))} 45%, #090c18 100%)`);
  st.setProperty('--edge', css(mix(a, [255, 255, 255], 0.75), 0.22));
  st.setProperty('--shine', css(mix(a, [255, 255, 255], 0.8), 0.18));
}
let themeRevision = 0;
let logoSource = null;
const themeLogos = new Map();

function colourThemeLogo(image, name) {
  const [a, b] = paletteOf(name);
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
    const mix = Math.max(0, Math.min(1, (hue - 165) / 115));
    const saturation = chroma / high;
    for (let channel = 0; channel < 3; channel++) {
      const tint = (a[channel] + (b[channel] - a[channel]) * mix) / 255;
      pixels[i + channel] = Math.round(high * (1 - saturation + saturation * tint));
    }
  }
  return image;
}

function themeLogo(name) {
  const key = pairOf(name) ? `${name}:${pairOf(name).join('|')}` : name;
  if (!themeLogos.has(key)) {
    const logo = (async () => {
      if (!logoSource) {
        logoSource = new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('The icon could not be loaded.'));
          image.src = new URL('icons/icon128.png', document.baseURI).href;
        });
      }
      const source = await logoSource;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('The themed icon could not be drawn.');
      ctx.drawImage(source, 0, 0, 128, 128);
      ctx.putImageData(colourThemeLogo(ctx.getImageData(0, 0, 128, 128), name), 0, 0);
      return canvas.toDataURL('image/png');
    })();
    themeLogos.set(key, logo);
    if (themeLogos.size > 12) themeLogos.delete(themeLogos.keys().next().value);
    logo.catch(() => { themeLogos.delete(key); logoSource = null; });
  }
  return themeLogos.get(key);
}

async function applyThemeLogo(name, revision) {
  const logos = document.querySelectorAll('img.logo');
  if (!logos.length) return;
  try {
    const url = await themeLogo(name);
    if (revision !== themeRevision) return;
    for (const logo of logos) logo.src = url;
  } catch (e) {
    // The original packaged image stays visible if colouring is unavailable.
  }
}

function applyTheme(name, colours, match) {
  name = themeName(name);
  const c = validColours(colours);
  if (c) { customColours = c; try { localStorage.setItem('themeColours', JSON.stringify(c)); } catch (e) {} }
  if (hexRgb(match)) { matchColour = match; try { localStorage.setItem('themeMatch', match); } catch (e) {} }
  document.documentElement.dataset.theme = name;
  applyCustomVars(pairOf(name));
  const revision = ++themeRevision;
  try { localStorage.setItem('theme', name); } catch (e) {}
  void applyThemeLogo(name, revision);
}
// This script runs in <head>, before the popup's header has been parsed.
document.addEventListener('DOMContentLoaded', () => {
  void applyThemeLogo(themeName(document.documentElement.dataset.theme), themeRevision);
}, { once: true });

let remembered = 'amber';
try {
  remembered = localStorage.getItem('theme');
  customColours = validColours(JSON.parse(localStorage.getItem('themeColours'))) || customColours;
  const m = localStorage.getItem('themeMatch');
  if (hexRgb(m)) matchColour = m;
} catch (e) {}
applyTheme(remembered);
try {
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !(c.theme || c.themeColours || c.themeMatch)) return;
    applyTheme(c.theme ? c.theme.newValue : document.documentElement.dataset.theme, c.themeColours ? c.themeColours.newValue : null, c.themeMatch ? c.themeMatch.newValue : null);
  });
  const beforeRead = themeRevision;
  chrome.storage.local.get({ theme: 'amber', themeColours: null, themeMatch: null }, (o) => {
    if (beforeRead === themeRevision && o) applyTheme(o.theme, o.themeColours, o.themeMatch);
  });
} catch (e) {}
