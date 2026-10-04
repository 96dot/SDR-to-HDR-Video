# Tests

Checks that run in headless Chromium or in plain Node. They need no extension install and no real GPU.

| File | What it checks | How to run |
|---|---|---|
| `schedule.test.mjs` | When smooth motion shows which picture (`Sdr2hdrSchedule` in `interp.js`): a pretend screen at 60, 75, 120 and 144 Hz against 30, 25 and 24 fps video, with late frames, dropped frames, seeks and a changed playback speed. No GPU, no browser. | `node tests/schedule.test.mjs` |
| `interp.test.mjs` | The GPU part of smooth motion (`interp.js`): the real shaders on a software GPU, with made-up frames whose motion is known. The flow found, the picture made at the halfway point, the cut fallback, and a pan across a scene (sky, horizon, ground, posts, with noise new each frame, including the sides of the picture and posts moving at twice the speed) are compared with the truth. | `node tests/interp.test.mjs` |

`interp.test.mjs` needs Playwright and a Chromium. It looks for them in the usual places; set `PLAYWRIGHT_MODULE` and `CHROME` to point at them if they are elsewhere. It serves `tests/interp.html` (which loads `shader.js` and `interp.js` as plain scripts) from a local server on 127.0.0.1 while it runs.

These do not replace trying the extension on real video: how smooth playback is and how the picture looks can only be judged on a real display.
