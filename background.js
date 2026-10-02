// Keyboard shortcuts. Each one just flips a stored setting; every tab's
// content script is already listening for storage changes and reacts.
const TOGGLES = { 'toggle-hdr': 'enabled', 'toggle-split': 'split' };

chrome.commands.onCommand.addListener(async (command) => {
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
