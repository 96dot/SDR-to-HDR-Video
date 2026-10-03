// The colour theme, chosen in the popup's settings. Put on <html> as early as
// it can be, on every page of the extension, so the page doesn't flash in
// another one first.
const HEADROOM_THEMES = { amber: 'Amber', ocean: 'Ocean', rose: 'Rose', aurora: 'Aurora' };
// These palettes and the pixel transform match background.js so the popup
// and browser toolbar show the same themed glass icon.
const HEADROOM_ICON_PALETTES = {
  amber: [[255, 197, 102], [255, 157, 60]],
  ocean: [[95, 240, 220], [58, 160, 255]],
  rose: [[255, 143, 192], [192, 107, 255]],
  aurora: [[168, 146, 238], [242, 154, 198]],
};
const themeName = (name) => Object.hasOwn(HEADROOM_THEMES, name) ? name : 'amber';
let themeRevision = 0;
let logoSource = null;
const themeLogos = new Map();

function colourThemeLogo(image, name) {
  const [a, b] = HEADROOM_ICON_PALETTES[name];
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
  if (!themeLogos.has(name)) {
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
    themeLogos.set(name, logo);
    logo.catch(() => { themeLogos.delete(name); logoSource = null; });
  }
  return themeLogos.get(name);
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

function applyTheme(name) {
  name = themeName(name);
  document.documentElement.dataset.theme = name;
  const revision = ++themeRevision;
  try { localStorage.setItem('theme', name); } catch (e) {}
  void applyThemeLogo(name, revision);
}
// This script runs in <head>, before the popup's header has been parsed.
document.addEventListener('DOMContentLoaded', () => {
  void applyThemeLogo(themeName(document.documentElement.dataset.theme), themeRevision);
}, { once: true });

let remembered = 'amber';
try { remembered = localStorage.getItem('theme'); } catch (e) {}
applyTheme(remembered);
try {
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.theme) applyTheme(c.theme.newValue); });
  const beforeRead = themeRevision;
  chrome.storage.local.get({ theme: 'amber' }, (o) => {
    if (beforeRead === themeRevision && o) applyTheme(o.theme);
  });
} catch (e) {}
