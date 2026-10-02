// Keyboard shortcuts. Each one just flips a stored setting; every tab's
// content script is already listening for storage changes and reacts.
const TOGGLES = { 'toggle-hdr': 'enabled', 'toggle-split': 'split' };

chrome.commands.onCommand.addListener(async (command) => {
  const key = TOGGLES[command];
  if (!key) return;
  const cur = await chrome.storage.local.get({ enabled: true, split: false });
  await chrome.storage.local.set({ [key]: !cur[key] });
});
