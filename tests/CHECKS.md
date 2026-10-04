# Rigorous checks for a major update

For future sessions (and Jones). A **major update** is any substantial engine work or new feature. Small fixes, theme or layout tweaks and doc corrections only need the light checks (syntax check on every `.js`, a test of the change where one is possible, changelog and version). The rules behind this are in `CLAUDE.md`; this file is the how.

The order matters. Tell the owner **once, at the end**, when every part is done. Not after each part.

## 1. Run the script

```
node tests/check-all.mjs --e2e
```

About a minute. It needs Node, and Playwright with a Chromium for the browser parts (`/opt/node-tools` and `/opt/pw-browsers` in the cloud container; `PLAYWRIGHT_MODULE` and `CHROME` say where they are elsewhere). `--e2e` also needs `ffmpeg`; `--quick` skips the slow parts.

What it checks, and what a FAIL there means:

| Check | What it is |
|---|---|
| syntax | `node --check` on every `.js` and `.mjs` |
| lint | eslint if present: errors fail; other warnings are listed (a name unused in its own file is used by another content script, so those are ignored) |
| manifest paths | every file `manifest.json` names exists; the top `CHANGELOG.md` heading is the manifest's version |
| DEFAULTS | `popup.js` and `content.js` DEFAULTS are the same, key by key |
| theme palettes, Match maths | `theme.js` against `background.js`: the three palettes, and the Match colour maths on 200 random colours |
| tests | `schedule` (timing logic, no GPU), `capture` (zip, colour conversion), `interp` (the shaders on made-up frames, software GPU), `pairs` (the saved-frames tool on a made-up pair) |
| popup height | main view, and the settings view with the Amber, Match and Custom themes, measured with no HDR display (the tallest case). The limit is 600 px; today 466 main, 567 settings, 594 with the Match or Custom row. If it reports more than that, a popup change took the spare room |
| e2e | in headless Chromium with the extension: a real key press saves frames; a key press made by the page does not; with Stats off it does not |

A new feature that has something the script can check should add it to the script (and a test file to `tests/`) as part of the change.

## 2. The three reviews

Spawn **three independent, read-only subagents** (one message, in parallel), each told **not to edit files**, each reading the changed code **and everything it touches in full** (`git diff`, then the files). Paste-ready prompts: replace the part in angle brackets.

**Security**

> Read-only review (do NOT edit files). Repo `<path>`: Chromium MV3 extension, content scripts share one isolated-world global scope. Run `git diff <base>` to see the change: `<one sentence: what it is>`. Read the changed code in full plus what it touches. SECURITY focus: DOM injection; message handlers and their sender checks; anything a page could forge or trigger (shortcuts must need `e.isTrusted`); the unlock rules (only the site's own frames, only the requesting tab); can the page see anything the extension makes (links put in the DOM, blob URLs, events); storage and model-file validation; what private data ends up in anything saved or copied (hostname is fine, page URLs are not); anything leaving the machine; resource exhaustion (memory, GPU buffers, repeated key presses); whether the 1.2.2 fixes are weakened. Report concrete findings only: file:line, how it is reachable, severity. Say plainly where it is clean.

**Logic**

> Read-only review (do NOT edit files). Repo `<path>`: Chromium MV3 extension using WebGPU. Run `git diff <base>` … `<what it is>`. Read the changed code and the surrounding code it depends on in full. LOGIC focus: control flow and races (the order GPU work is submitted in against when a texture is reused or destroyed; async work finishing after the session was destroyed); resource leaks (textures, buffers, timers, blob URLs); load order and shared globals between content scripts (`manifest.json`); settings written but never read, or read but never written; constants kept in step by hand; units (microseconds against seconds, fractions of the frame against pixels, rows padded to 256 bytes); WGSL validity and uniformity; edge cases (first frame, seek, size change, paused, two videos). Report concrete reachable bugs only: file:line, scenario, severity. Say plainly where it is clean.

**Readability and consistency**

> Read-only review (do NOT edit files). Repo `<path>`: … `<what it is>`. READABILITY/CONSISTENCY focus: naming and comment density against the surrounding code; comments that overclaim or no longer match the code; dead code and unused variables; duplicated logic that should be shared; magic numbers with no explanation; things kept in step by hand (`theme.js` against `background.js`, `popup.js` DEFAULTS against `content.js` DEFAULTS); which of `README.md`, `CHANGELOG.md`, `PRIVACY.md`, `CLAUDE.md`, `tests/README.md` now need updating, and whether what they say is true of the code. Report concrete findings with file:line and a suggested fix. Say plainly where it is clean.

For a change that handles pixel data, saves files or downloads, say so in the security prompt. For a shader change, say which rule changed and ask the logic reviewer for the units and the edge cases.

## 3. Verify every finding yourself

Reviewers are wrong sometimes. For each finding, **read the code it names and show it is reachable** (or try it) before acting on it or reporting it. Drop what cannot be shown. Say plainly in the report which findings were false alarms. Where a review suggests a change to how the picture looks, score it (section 5) and keep it only if it is better on real frames. Fix the findings that belong to the change; put small unrelated ones in the changelog's "Found and not changed".

## 4. Run it

In headless Chromium where possible; the script's `--e2e` is the minimum. Things learned the hard way:

- A faked HDR display needs `--force-color-profile=hdr10`; do not use it when measuring the popup.
- Keep the page's tab in front (`bringToFront`) or the browser throttles it to one frame a second; and a key press goes to whichever tab has the focus, so retry it.
- The software GPU is far too slow to play video in real time, so timing is tested apart from the GPU (`tests/schedule.test.mjs`), and Smooth motion does not even turn on in headless (the screen refreshes too slowly). A throwaway copy of the extension with the "too slow, give up" limit raised can show the code paths work; never commit that.
- `getMappedRange` can be called once per buffer. A WGSL variable cannot be called `fn`. Writes to a uniform buffer land before the next submit, so a loop that changes it needs a submit each time. Do not read "queue wait" as GPU cost: use the GPU's own timestamps.
- **For a fix, reproduce the bug on the old code first, then show it gone on the new.** For a change to a picture, save the pictures before and after.

## 5. Real footage (Smooth motion and anything about the picture)

Made-up test pictures are not enough; the swirls in a dark sky (1.3.8) only showed on real frames. Everything below runs here, from files the owner sends.

1. The owner turns Stats on and presses **Alt+Shift+C** (four real frames in a row, as a zip) at the moment that goes wrong, or **Alt+Shift+R** before it and again just after (the last 60 pictures that were put on screen, and a log of each refresh; for judging the order and the made-up pictures). Both only save when Stats is on; the zips show what was playing, so the owner should look before sending. A split `.rar` needs `unrar` (`apt-get install unrar`); `7z` of that age cannot open it.
2. `node tests/pairs.mjs <zip> <out folder> 0.25,0.5,0.75`: for each neighbouring pair, the made-up picture, where it fell back (red), the motion found and the numbers. Look at the pictures.
3. **Score it against the truth.** With four consecutive frames, rebuild frame 2 from frames 1 and 3 and compare with the real frame 2 (and 3 from 2 and 4): `node tests/tune.mjs sets.json variants.json`. It tries many variations of the mixing shader in one run and prints, for each, the mean error out of 255 for the made-up picture against the plain frame. A change should lower it on the hard footage and leave the calm footage as it was.
4. **Mean error hides the worst places** (a swirl scores about the same as a blur). Always look at the pictures too. To find a rule that separates the bad places from the good, score candidate signals per block (the 1.3.8 work did this: the cost of the match had no power; "the local motion differs from the overall one and the two warped pictures disagree" did).
5. Do not change how the picture looks without asking the owner. Show before and after.

## 6. Report, in plain words

For Jones: short, friendly (a "sugar" now and then, never thick), the finding first. In this order:

1. What was checked (the three reviews, the script, the run in a browser, real frames if any).
2. What was found, and **which findings were false alarms**.
3. What was fixed.
4. **What could not be tested** (the owner's machine: Windows 11, AMD RX 9070 XT, 4K HDR 60 Hz, Brave; how it looks and feels in motion; weaker GPUs, 120/144 Hz, macOS, Linux).
5. **Exactly what to try on their machine**, step by step, and what to send back (the report, a zip).
6. The `CHANGELOG.md` text, with its "Tested, and not" section.

And the housekeeping: a `CHANGELOG.md` entry and a `manifest.json` version bump; commit and push to the branch (never to main; do not merge unless asked); a zip of the extension files for the owner (manifest, scripts, pages, `ui.css`, `icons/`, `third_party/`, licences, `PRIVACY.md`; no `tests/`); no stray files in the repository.
