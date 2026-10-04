# Headroom HDR: notes for Claude sessions

Free, open-source Chromium extension (Manifest V3, WebGPU) that converts SDR web video to HDR in real time by drawing an HDR canvas over each `<video>`. MIT licence. Read `README.md` ("How it works", "Performance") and `CHANGELOG.md` first: the changelog explains why almost every mechanism exists, usually with the measurement that led to it.

## Working with the owner (Jones)

- Not a coder. They direct the work and test it on their machine. Explain in plain words, lead with what was found or done, keep replies short.
- Tone: friendly, lightly "Southern belle" conversational, a "sugar" here and there, never laid on thick and never at the cost of being clear.
- Be straight about what was tested and what was not. "Not checked on real video" beats claiming it works.
- When a change needs their eyes, say so and say exactly what to try. The built-in self-test (Alt+Shift+T) produces a report they can paste back.
- Everything was tuned on one machine: Windows 11, AMD RX 9070 XT, 4K HDR at 60 Hz, Brave. That cannot be run in the cloud. Headless Chromium with software WebGPU (and `--force-color-profile=hdr10` to fake an HDR display) can check that shaders compile, settings flow, DOM behaviour and numbers; it cannot judge playback smoothness or how the picture looks.

## Rules

1. Every change gets a `CHANGELOG.md` entry in the existing style (including a "Tested, and not" section) and a version bump in `manifest.json`. Put the changelog text in the reply when finished.
2. Do not change how the picture looks (brightness, colour, sharpening, roll-off) without asking first.
3. Keep the popup under 600 px tall in both views. The main view is 466 px; the settings view is 567 px, or 594 px with the Match or Custom colour row showing, so only about 6 px is spare there. Measure both (headless Chromium, body height) before any popup change.
4. Do not weaken the 1.2.2 security fixes: unlock rules only for the site's own frames and only in the requesting tab; shortcuts only from real key presses (`isTrusted`).
5. Licences: the FSRCNNX files stay unmodified in `third_party/fsrcnnx/` with their LGPL texts. `LICENSE-FSR.txt` stays. Never bundle a trained model in the extension.
6. Work on a branch and give a pull request to merge on the GitHub site. Never push straight to main. Do not merge unless asked.
7. The owner's setup for releases: tag and release are made by them on the GitHub release page (no tool here can create a release); supply the notes and a zip of the extension files (manifest, scripts, pages, `ui.css`, `icons/`, `third_party/`, licences, `PRIVACY.md`).

## Major updates need the full checks

A **major update** is any substantial engine work or new feature. Small fixes, theme or layout tweaks and doc corrections get the light checks (syntax check on every `.js`, a test of the specific change where one is possible, changelog and version).

For a major update, before handing it over, do all of this, and tell the owner **once, when every check is done**, not after each part:

1. **Three independent reviews** (use subagents, read-only) of the changed code and everything it touches, each reading the code in full:
   - security: DOM injection, message handlers and sender checks, page-forgeable actions, the unlock rules, storage and model-file validation, anything leaving the machine;
   - logic: control flow, races, resource leaks, load order and globals, settings written but not read, constants out of step, units;
   - readability and consistency: naming, dead code, hand-synced duplicates (`theme.js` against `background.js`, `popup.js` DEFAULTS against `content.js` DEFAULTS), docs and comments against the code.
2. **Verify every finding yourself** against the code before reporting it. Drop what cannot be shown reachable. Say plainly which were false alarms.
3. **Automated checks**: `node --check` on every `.js`; lint if available (`/opt/node-tools`); `node tests/schedule.test.mjs` and `node tests/interp.test.mjs` (see `tests/README.md`); every path in `manifest.json` exists; the duplicated palettes and colour maths are in step; popup height in both views.
4. **Run it** in headless Chromium where possible (a faked HDR display needs `--force-color-profile=hdr10`; keep the page's tab in front, or the browser throttles it to one frame a second; the software GPU is far too slow to play video in real time, so timing has to be tested apart from the GPU, as `tests/schedule.test.mjs` does). For a fix, reproduce the bug on the old code first, then show it gone on the new.
5. **Report** in plain words: what was checked, what was found, what was fixed, what could not be tested, and exactly what the owner should try on their machine.

Fix the findings that belong to the change; list the small unrelated ones in the changelog's "Found and not changed" section.

## Known and deliberately left alone (do not "fix" without asking)

- At 4K the first analysis pass reads a quarter of the frame's pixels. Fixing it shifts highlight measurements.
- With Shaping on, the centre of a big blown-out area can flatten at the display maximum. Fixing it lowers top highlights slightly.
- The upscaler step-down threshold sits right at the cost of FSRCNNX 16 on 1440p60 on the owner's card (about 6.4 ms against a 6.7 ms limit). Tabled.
- Guided trusts the model fully for anything big enough for it to see. If Guided looks worse than Shader on real scenes, the next step is blending in the shader's own size rule.
- About 1 to 3% of pacing answers arrive late. Unexplained, harmless so far.
- Untested on real hardware: weaker GPUs, 120/144 Hz displays, macOS, Linux.

## Smooth motion (frame interpolation, 1.3.0)

Off by default. It changes how motion looks (a made-up picture on the refreshes between frames) and runs the picture one video frame behind the sound; do not turn it on by default or change its look without asking. The cut and fallback thresholds in `interp.js` were set on made-up frames and are untested on real footage. Its self-check gates it per GPU, and it stops itself if it is too slow. Diagnostics: the report's Smooth motion section, and Alt+Shift+I (with Stats on) for the fallback and motion views.

## Not in this repository

HDR Trainer (the Python program that trains the optional model) lives only on the owner's PC and needs their GPU. If work on the model comes up, say what is needed from it.

## Open ideas, most useful first

1. More tests in `tests/`. There are now: the smooth-motion timing logic (`schedule.test.mjs`) and its shaders on made-up frames (`interp.test.mjs`). Still to do: every other WGSL module compiles; the FSRCNNX translation matches a plain reading of the GLSL; upscaling picks the right mode for each Upscaling/Performance combination; Guided with a fake model; unlock rules; fake key press ignored; self-test restores settings; popup height in both views; and the parts of `content.js` that decide when smooth motion is on, which are not reachable from outside the page script.
2. Split view in the report: log toggles and what each side actually drew, including a silent fall-back from Model/Guided to Shader.
3. Per-site permission mode (optional host permissions, "enable on this site", dynamic content script registration). Big change; only if the Chrome Web Store review requires narrower access. Do not start it unprompted.
