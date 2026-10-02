// The page for loading a model exported by HDR Trainer. The whole file is
// kept in the extension's local storage under 'model'; a few facts about it
// go in 'modelInfo', which is what the popup and the video pages watch.
const $ = (id) => document.getElementById(id);

function say(text, bad = false) {
  $('msg').textContent = text;
  $('msg').classList.toggle('bad', bad);
}

function showInfo(info) {
  $('current').hidden = !info;
  $('remove').hidden = !info;
  const dl = $('facts');
  dl.textContent = '';
  if (!info) return;
  const rows = [];
  if (info.name) rows.push(['File', info.name]);
  if (info.steps != null) rows.push(['Training steps', info.steps.toLocaleString()]);
  if (info.movies != null) rows.push(['Movies it learned from', String(info.movies)]);
  if (info.error != null && info.baseline) {
    rows.push(['Error removed', `${Math.round((1 - info.error / info.baseline) * 100)}% on held-back scenes, against plain SDR`]);
  }
  if (info.exported) rows.push(['Exported', info.exported]);
  if (info.params) rows.push(['Size', `${info.params.toLocaleString()} weights`]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';            // so choosing the same file again still counts as a change
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('That file is too big to be a model from HDR Trainer.');
    let json;
    try { json = JSON.parse(await file.text()); } catch { throw new Error("That file isn't readable as a model (it isn't valid JSON)."); }
    const checked = sdr2hdrCheckModel(json);
    const modelInfo = { ...checked.info, name: file.name, id: Date.now() };
    // Only what's needed to run it is kept.
    const model = { format: json.format, version: json.version, input: json.input, output: json.output, trained: json.trained,
      exported: json.exported, trainer_version: json.trainer_version, layers: json.layers };
    await chrome.storage.local.set({ model, modelInfo, method: 'model', splitRight: 'model' });
    showInfo(modelInfo);
    say('Loaded, and switched on. Videos that are already playing pick it up within a second.');
  } catch (err) {
    say(err.message || String(err), true);
  }
});

$('remove').addEventListener('click', async () => {
  const cur = await chrome.storage.local.get({ splitLeft: 'original', splitRight: 'shader' });
  await chrome.storage.local.set({
    modelInfo: null, method: 'shader',
    splitLeft: cur.splitLeft === 'model' ? 'original' : cur.splitLeft,
    splitRight: cur.splitRight === 'model' ? 'shader' : cur.splitRight,
  });
  await chrome.storage.local.remove('model');
  showInfo(null);
  say('Model removed. The shader is back in charge.');
});

chrome.storage.local.get({ modelInfo: null }, (s) => showInfo(s.modelInfo));
chrome.commands.getAll((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-method');
  $('keyMethod').textContent = c && c.shortcut
    ? `${c.shortcut} does the same from the keyboard, which is the quickest way to flip back and forth while watching.`
    : 'You can also give it a keyboard shortcut at chrome://extensions/shortcuts.';
});
