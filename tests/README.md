# Tests

Checks that run in plain Node or in headless Chromium. They need no extension install and no real GPU.

| File | What it checks | How to run |
|---|---|---|
| `check-all.mjs` | **Everything automated in one go**, for a major update: syntax, lint, manifest paths, the settings and theme tables kept in step by hand, every test below, popup height, and (with `--e2e`) a run in a browser: a real key press saves frames, a key press made by the page does not, and the badge stays a small pill under hostile page styles. The procedure around it (the three reviews, real footage, the report) is `CHECKS.md`. | `node tests/check-all.mjs --e2e` |
| `general/check-project.mjs` | A **general** version of the checks, for any project (not just this one): works out what the project is (JavaScript, Python, Go, Rust, a browser extension) and runs syntax, lint, its test scripts, manifest and changelog, Markdown links, secrets left in files, and whatever the project lists in `.checks.json` (here: `check-all.mjs`). `general/GENERAL-CHECKS.md` is the procedure around it, written to be pasted into any chat. | `node tests/general/check-project.mjs` |
| `capture.test.mjs` | The frame saver's file making (`capture.js`): the CRC, the zip (read back by Python's zipfile), and the 10-bit to 8-bit conversion. The PNG making and the download need a browser and are covered by `check-all.mjs --e2e`. | `node tests/capture.test.mjs` (needs python3) |

`check-all.mjs --e2e` needs Playwright and a Chromium (and ffmpeg, for a test video). It looks for them in the usual places; set `PLAYWRIGHT_MODULE` and `CHROME` to point at them if they are elsewhere.

These do not replace trying the extension on real video: how smooth playback is and how the picture looks can only be judged on a real display.
