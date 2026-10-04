# Tests

Checks that run in headless Chromium or in plain Node. They need no extension install and no real GPU.

| File | What it checks | How to run |
|---|---|---|
| `check-all.mjs` | **Everything automated in one go**, for a major update: syntax, lint, manifest paths, the settings and theme tables kept in step by hand, all the tests below, popup height, and (with `--e2e`) a key-press run in a browser. The procedure around it (the three reviews, real footage, the report) is `CHECKS.md`. | `node tests/check-all.mjs --e2e` |
| `general/check-project.mjs` | A **general** version of the checks, for any project (not just this one): works out what the project is (JavaScript, Python, Go, Rust, a browser extension) and runs syntax, lint, its test scripts, manifest and changelog, Markdown links, secrets left in files, and whatever the project lists in `.checks.json` (here: `check-all.mjs`). `general/GENERAL-CHECKS.md` is the procedure around it, written to be pasted into any chat. | `node tests/general/check-project.mjs` |
| `schedule.test.mjs` | When smooth motion shows which picture (`Sdr2hdrSchedule` in `interp.js`): a pretend screen at 60, 75, 120 and 144 Hz against 30, 25 and 24 fps video, with late frames, dropped frames, seeks and a changed playback speed. No GPU, no browser. | `node tests/schedule.test.mjs` |
| `interp.test.mjs` | The GPU part of smooth motion (`interp.js`): the real shaders on a software GPU, with made-up frames whose motion is known. The flow found, the picture made at the halfway point, the cut fallback, and a pan across a scene (sky, horizon, ground, posts, with noise new each frame, including the sides of the picture and posts moving at twice the speed) are compared with the truth. | `node tests/interp.test.mjs` |
| `capture.test.mjs` | The frame saver's file making (`capture.js`): the CRC, the zip (read back by Python's zipfile), and the 10-bit to 8-bit conversion. The PNG making and the download need a browser and are covered only by `pairs.test.mjs` and by running the extension. | `node tests/capture.test.mjs` (needs python3) |
| `pairs.test.mjs` | `pairs.mjs` on a made-up pair of PNGs (as a zip) with a known shift: the overall motion, the picture made at the halfway point against the truth, nothing falling back. | `node tests/pairs.test.mjs` |

`pairs.mjs` is a tool, not a test: `node tests/pairs.mjs <frames.zip or folder> [out folder] [0.25,0.5,0.75]` runs the real smooth-motion passes on the frames the extension's Alt+Shift+C saved, in headless Chromium on a software GPU, and writes the picture made, where it fell back (red), the motion found and the numbers for each neighbouring pair. It serves `tests/pairs.html`, which loads `shader.js`, `interp.js` and `capture.js`.

`interp.test.mjs`, `pairs.test.mjs` and `pairs.mjs` need Playwright and a Chromium. It looks for them in the usual places; set `PLAYWRIGHT_MODULE` and `CHROME` to point at them if they are elsewhere. It serves `tests/interp.html` (which loads `shader.js` and `interp.js` as plain scripts) from a local server on 127.0.0.1 while it runs.

The recorder (Alt+Shift+R) and its shrink pass are not covered by an automated test: they were run end to end in headless Chromium by hand (a real key press, the zip checked), and need a screen that refreshes fast enough for Smooth motion to turn on, which the software GPU does not.

`tune.mjs` is a tool too: `node tests/tune.mjs sets.json variants.json` replays the picture-mixing shader with variations on real frames saved with Alt+Shift+C, and scores each against the true frame (it makes the picture between frames 1 and 3 and compares it with frame 2, against the plain frame). It serves `tests/tune.html`. See its header for the two JSON files and the options. Only run it on frames you saved yourself (the browser is started without its sandbox).

These do not replace trying the extension on real video: how smooth playback is and how the picture looks can only be judged on a real display.
