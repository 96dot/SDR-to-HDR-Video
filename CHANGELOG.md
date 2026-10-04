# Changelog

All notable changes to Headroom HDR (called SDR to HDR Video before 0.11). Versions follow the number in `manifest.json`.

## 1.2.6 - 2026-10-04

Fixes from a review of the whole extension for logic, security and readability problems, each checked against the code before it was changed.

### Fixed

- **Fullscreen on a bare video rebuilt the overlay about twice a second.** When a site fullscreens the `<video>` itself, the overlay is moved into a box above it (the top layer). The once-a-second check for "the page moved the video" then found the overlay was not beside the video, took that for a move, and destroyed the session; the next scan made a new one, and so on. Each rebuild discarded the stats and the half-rate and beat state. It now checks that the box is still on the page. This is the 1.2.2 "moved video" check going wrong, so 1.2.2 to 1.2.5 are affected. Measured in headless Chromium with a made-up video: about 7 new elements a second added to the page before, none after the first move.
- **Half rate stuck when "Every refresh" was switched off during an episode.** Nothing steers without Every refresh, so the episode stayed on record: the badge said "every other frame", Auto quality could not step down, and when Every refresh came back the stale episode could be judged as having failed and counted against trying again. Switching it off now ends the episode (every frame is taken then anyway), without counting it as a failed try; the report lists it as "stopped (Every refresh was switched off)".
- **A failed unlock rule stopped the clean-up after it.** If making a rule failed, the queue was left failed, and the next "switch unlock off" or "tab closed" clean-up was skipped, so rules stayed until the browser was closed. Checked with a made-up failure: the queue was rejected before, fine after.
- **A colour picked and a theme clicked within a quarter of a second** could end up with the first theme saved over the second. The pending save is cancelled by the click.

### Changed

- README: the Alt+Shift+M row says it goes round shader, guided and model; "three switches" for the site card; the permission is named `declarativeNetRequestWithHostAccess`; the Files table covers `theme.js`, what `ui.css` and `background.js` do, and what `icons/` holds; the model has a preparation step and eleven passes. Comments in `background.js`, `pacer.html` and `ui.css` that no longer matched the code are corrected, and the 1.2.5 entry's popup heights agree with each other.

### Found and not changed (low)

- Unlock rules cover any media the unlocked site asks for, not only the one video's host (it could be narrowed to the video's host).
- The split-line drag accepts made-up pointer events from a page (cosmetic: the split position).
- A GPU device is left behind when starting fails part-way; a model removed while it was loading stays on the GPU until the device is lost; small pacing-worker clean-up gaps; `selfTestReport` is saved and never read; a model file with a layer missing its shape shows a raw error.
- `docs/themes.png` still shows Rose.

### Tested, and not

- Checked here, in headless Chromium with the extension loaded and an HDR display faked: the fullscreen rebuild reproduced with the 1.2.5 code and gone with this one; the failed-rule queue and the colour-versus-theme race reproduced with 1.2.5 and fixed.
- Not checked: the half-rate fix (an episode can't be provoked without a real decoder under load; it was made by reading the code), and none of it on real video, Windows or a real display. For fullscreen, try a video file opened straight in the browser: it should now stay steady.

## 1.2.5 - 2026-10-04

### Changed

- **The Rose theme is replaced by Match**, placed second to last, just before Custom. Pick one colour and the second is worked out from it (turned 75 degrees round the colour wheel, about as far as Aurora turns its two, at the same lightness, for a bolder pair), so the pair always goes together. The glow, the light behind the glass, the popup's logo and the toolbar icon are all made from the pair, the same way as for Custom. Its colour is kept separately from Custom's two, so changing one doesn't touch the other. Match starts on pink.
- Anyone who had Rose chosen is moved to Amber.
- The two keyboard shortcut lines at the bottom of the settings no longer touch: there is a few pixels of air between their key boxes. The settings view is 567 px (594 px with the Match or Custom row showing) of the 600 a browser allows, so about 6 px is left.
- **A glass colour picker for Match and Custom**, in place of the browser's own colour dialog (which can't be styled, and can close the popup while it is open). Click a colour box and a glass panel opens under the Colours card with a square for how vivid and how bright, a strip for the colour, and a box for a hex code. It floats over the cards below, so the popup does not grow (594 px at most with it open, the same as with the colour row alone). Works with the keyboard (arrow keys, Shift for bigger steps); Esc, a click outside, or choosing another theme closes it.
- Only the extension's own colours change. The picture is as it was.
- README updated for the new theme. Its theme screenshot (`docs/themes.png`) still shows Rose.

### Tested, and not

- Checked here, in headless Chromium with the extension loaded: the swatches are Amber, Ocean, Aurora, Match, Custom in that order; choosing Match shows its one-colour row, and a picked colour (dragged, typed as a hex code, or from the keyboard) is applied, saved, and gives the toolbar icon (the service worker) the same pair as the popup; a saved Rose falls back to Amber; no errors; the settings view was 559 px with other themes and 586 px with Match or Custom, before the shortcut lines were spaced out (see above for the final figures).
- Not checked: how the picker feels under a real mouse and how the glass looks in Brave (headless Chromium does not blur what is behind it, so the panel is made dense enough not to need it); the picker in the Aurora theme; how the Match colours look to you across the range of colours you might pick (very dark or very pale ones especially), and the toolbar icon in a real toolbar. The 75 degree turn is my choice, taken from how far Aurora's two colours sit apart; it's one number, easy to change.

## 1.2.4 - 2026-10-04

### Changed

- Files put back where the code and the README expect them. Nothing about how the extension works or how the picture looks changes; only the packaged icon does.
  - The FSRCNNX shader files and their licence texts (`COPYING`, `COPYING.LESSER`) are in `third_party/fsrcnnx/`, with their notice, unchanged. They had been uploaded to the top level, where the Best upscaler (`upnet.js`, `background.js`) could not find them.
  - `README.md` is the Headroom HDR README again; the FSRCNNX notice had overwritten it, leaving the real one as `README (1).md`.
  - The README's screenshots are in `docs/`, where it points to them.
  - The packaged icon (`icons/icon16.png` to `icon128.png`) is the blue "H" artwork that had been uploaded to the top level. The extensions page and the store listing now show it; the toolbar icon still follows the chosen theme. The old purple-sun PNGs are gone.
  - The two old popup screenshots (`popup-dark.png`, `popup-light.png`, in two places) are removed. Nothing used them.
  - The uploaded `download` file is `.gitignore`, and the two `icon` SVGs that were copied at the top level (identical to the ones in `icons/`) are removed.

### Tested, and not

- Checked here: every path named in `manifest.json`, `upnet.js`, `background.js` and the README points at a file that exists, and the two shader files are byte-for-byte what they were.
- Not checked: loading the Best upscaler in a browser. It reads the same files from a different folder.

## 1.2.3 - 2026-10-04

### Changed

- The `activeTab` permission is no longer asked for. It did nothing that access to all sites, which the extension needs to see video wherever it is, doesn't already cover: the popup still reads the current tab's site name for per-site settings.
- The screenshots in the README are of the current popup.

### Added

- `PRIVACY.md`, the privacy policy a store listing links to: nothing is collected and nothing is sent.

## 1.2.2 - 2026-10-04

Fixes from a review of the whole extension by a second model, each one checked against the code before it was changed.

### Security

- **"Unlock locked videos" could be used by a frame from another site.** Permission was checked against the site in the address bar, but the rule was made for whichever frame asked. An advert or embed from another site inside an unlocked page could so get a rule for its own origin, good in every tab until the browser closed, letting that site read video and audio from anywhere with your cookies. Now only the site's own frames (the site itself or a subdomain of it) are given a rule, and a rule only applies in the tab that asked. It is removed when that tab closes. A locked video inside a frame from another site now stays locked.
- **A page could press the extension's shortcuts for you.** Alt+Shift+T, A, O and P were accepted from key events a page made up. A page could start the self-test, which switches converting off on every site for half a minute and Stats on, and keep doing it. Only real key presses count now.

### Fixed

- **The self-test could leave the extension switched off.** Closing or reloading the page in its first 30 seconds left converting off for every site until you found the switch. The settings it changes are now remembered and put back when the page closes, when the test is stopped by hand, and by the next page to load if the browser itself was closed or crashed. A test that is stopped or abandoned also puts Stats back as it was; one that finishes leaves Stats on for the report, and says so.
- Changing any per-site setting (dragging a slider with "Own settings" on, switching a site off) removed every unlock rule, so an unlocked video that was playing stopped loading. Only the rules of sites that no longer have unlocking on are removed now. Two locked videos asking at once could also be given the same rule number, and one would fail.
- A video the page moved into another container was left invisible there while the overlay went on drawing in the old place. The overlay now starts again beside the video.
- Half rate (every other frame, to let the decoder catch up) could go on for as long as the mouse kept moving anywhere on the page. After a minute of the decoder being well it now goes back to every frame.
- Where the browser's GPU thread is not being asked (not Windows, or a 120 or 144 Hz screen), going fullscreen could be taken for a stuck screen queue and cost a held beat and a spell at half rate. The guesses are not acted on in the second and a half after a fullscreen change.
- Auto quality, with upscaling on and a screen smaller than 4K, skipped the level that would only have switched upscaling off and went straight to the lowest, losing sharpening and debanding for nothing.
- The upscaling network's textures could be made for a single frame of the wrong size after the canvas grew (about 300 MB, thrown away at the next frame).
- With a model on screen a bind group was made anew for every video frame. They are kept now.
- The A/B test could not be stopped once Stats was switched off.
- The toolbar icon could turn amber when a Custom theme colour was changed after the extension had been idle; a colour picked just as the popup closed could be lost.
- Videos the browser would not let the extension read were remembered until the popup was next opened, even after the page had removed them.
- The FSRCNNX reader refused unknown lines in a pass but ignored directions it didn't know (another size, an offset, another plane). It refuses those too. The two files shipped have none.
- The "Copy report" button read "Report" after its first use. The settings view can no longer grow past the popup's height limit if the shortcut lines wrap in another font. README, tooltip and shortcut descriptions brought up to date with Guided and with the controls that moved into the settings.

### Found and left alone, because they change the picture

- At 4K the first analysis pass reads only a quarter of the frame's pixels, so a very small bright thing can be counted or missed depending on where it sits. Fixing it changes the highlight and scene measurements slightly.
- The highlight roll-off works out the brightest value the pipeline can make without counting Shaping, so with Shaping on the very middle of a big blown-out area can flatten at the display's maximum. Fixing it lowers the top highlights a little (about 3.92 to 3.85 times white at the defaults).

### Tested, and not

- Checked here: the unlock rules (own frame and subdomain given, another site's frame refused, two at once, kept through a settings change, removed when switched off); a made-up key press does nothing and a real one works; the self-test puts settings back when the page closes, after a simulated crash, and when stopped by hand; the FSRCNNX files still read and bad ones are refused; the network's numbers, upscaling, Guided and the popup give the same results as before.
- Not checked: the playback fixes (half rate cap, fullscreen guard, moved video, auto quality) on real video. They were made by reading the code.

## 1.2.1 - 2026-10-03

### Fixed

- **Guided made pinpoint lights dimmer than the shader does.** Measured on an HDR screenshot of a concert, split Shader | Guided: tiny white stage lights were 4.4 times white on the shader's side and every small light on the guided side stopped at 3.2. The model looks at a 480x270 copy of the frame and answers on a 120x68 grid, so a light a few pixels across is too small for it to have an opinion about; it gave the whole area a middling answer and the lights a middling boost. Now, where a bright thing is too small for the model to see (little of its cell on that grid is highlight), the shader's own rule decides, as it does without a model: small and on its own means a light. Anything bigger (faces, windows, sky, walls) is still the model's call.

### Tested, and not

- Checked here with made-up models, in software rendering: with a model that calls nothing a light, a 5-pixel white dot now gets the shader's full boost while a big white area and a 60-pixel square still get the least; the 1.2.0 checks give the same numbers as before.
- Not checked on real video. Where exactly "too small to see" ends (a light around 15 to 30 pixels across at 4K is in between) is a judgment made from the grid's size, not from footage.

## 1.2.0 - 2026-10-03

### Added

- **Guided**, a third Method (in the settings, with a model loaded): the shader guided by your trained model. The shader still decides how much brighter highlights get, with every slider working as before. The model decides where: how light-like the bright things in each part of the picture are.
  - Why: used by itself the model is tame. It is trained to be right on average, so where it can't tell a lamp from a white shirt it gives both a little, and only pure white gets a clear boost. But it still gives the lamp more than the shirt, and that ordering is what the shader lacks: the shader tells lights from white things by the size of the bright area, which dims a big light (a window, a sky, an explosion) and boosts a small white thing (lettering, a collar).
  - How: the model's gain for bright things at each spot takes the place of the shader's size rule. A bright thing the model takes for a light gets the full boost whatever its size; one it doesn't gets the least. The rest of the shader (the reach down the tonal range, less for bright scenes, the shaping of blown-out areas, colour, roll-off) is unchanged.
  - Where "a light" and "not a light" sit on the model's scale is measured for each model by HDR Trainer 0.5 at export, on scenes the model wasn't trained on, and saved in the model file. A model exported before that still works as a guide, with rough levels.
- Loading a model now switches on Guided, and sets the split view to Shader | Guided, the comparison that shows whether the model is helping. "Your model" (the model doing the whole job) is still there.
- The model page shows how well the model's ordering of bright regions agrees with real HDR, as measured by HDR Trainer.
- The method shortcut goes round all three: shader, guided, model. The badge says HDR · GUIDED.

### Tested, and not

- Checked here with made-up models, in software rendering: with a model that calls everything a light, a big white area gets the same full boost as a small one (5.2 times white at Peak 8, where the shader alone gives the big one 2.9); with one that calls nothing a light, both get the least (2.9); Guided chosen with no model loaded is the shader exactly; split view, the shortcut, the popup and the model page all follow.
- Not checked: how it looks with a real trained model on real video. Whether the model's ordering is good enough to beat the shader's size rule is exactly what the Shader | Guided split is for, and the agreement figure on the model page is the first hint: near zero means it won't be.

## 1.1.6 - 2026-10-03

### Changed

- The margin around the popup is the same on every side: 10 pixels. Top and bottom were 8, from when the popup was short of height, which showed at the corners as a wider gap beside the cards than under them.

### Not possible

- Rounding the popup's own corners. Its outline is a window the browser draws, and an extension can neither change that window's shape nor make its background see-through.

## 1.1.5 - 2026-10-03

### Changed

- **Display max (Calibrate), Method and Split moved to the settings** (the cog), as the first card there. The main view under the sliders is now just Performance, Upscaling and Badge on the video, with 36 pixels a row.
- **"Badge on the video" is back on the main view.**
- To fit the three rows, the settings view is a little tighter (its switches are 35 pixels a row where they were 38), and the line "On the page, with a video playing:" above the keyboard shortcuts became their tooltip. Worst case it is 581 pixels of the 600 a browser allows; the main view is 520.

## 1.1.4 - 2026-10-03

### Changed

- **More room between the controls** under the sliders (Display max, Method, Split, Performance, Upscaling): each row is 34 pixels high where it was 29, so the dropdowns no longer nearly touch, and the card has a little more space above and below.
- To make that room, **"Badge on the video" moved to the settings** (the cog), into the card with the colour themes, now headed "Look". A browser gives a popup 600 pixels of height and no more, and with the Upscaling row added there were 20 left.

## 1.1.3 - 2026-10-03

### Fixed

- **The upscaling network steps down sooner.** In the 1.1.2 report (1440p at 60, fullscreen at 4K) the bigger network took the GPU 9.2 ms a frame, and it was 28 seconds before the extension switched to the smaller one: the check sat behind the one that waits while frames are being let go by for the decoder, which was happening the whole time. It is now made first, as soon as there are timings to go by (a few seconds), and at four tenths of a frame's time where it was a half.

### Seen working

- The step down itself, for the first time on a real GPU: "a frame's work takes the GPU 9.2 ms with the upscaling network FSRCNNX 16; trying FSRCNNX 8", after which a frame's work was 3.4 ms.

### Not tested

- The earlier step down was checked only by reading the code and loading the extension; software rendering here is too slow to trigger it.

## 1.1.2 - 2026-10-03

### Changed

- **Upscaling on Auto now uses Best (FSRCNNX) at any frame rate**, not only under 45 frames a second, and leaves it to the GPU's own timing to say when that is too much. Measured on a Radeon RX 9070 XT (1.1.1 report): the bigger network on 1080p at 60 frames a second, drawn at 4K in fullscreen, took 3.7 ms of the 16.7 a frame has (7.3 at worst), with 6 hitches in 184 seconds and no frames dropped by the decoder.
- When the GPU does say it is too much (a frame's work over half a frame's time, Performance on Auto), the step down is remembered for the page: the next video at least as heavy (pixels times frame rate) starts at the smaller network or Fast, where the last one ended up, and doesn't stutter through the same discovery again. Reloading the page forgets it.
- In a browser that doesn't let the GPU be timed there is nothing to step down by, so there Auto keeps the old rule: Best under 45 frames a second, Fast from there up.

### Not tested

- The step down still has not been seen to happen on a real GPU: this one never needed it. Its remembering was not tested at all.

## 1.1.1 - 2026-10-03

### Added

- With Stats on, the badge on the video says which upscaler is drawing right now, after the drawn size: "upscale: Best (FSRCNNX 16)", "Best (FSRCNNX 8)", "Best (...) + Fast" when Fast takes the doubled picture the rest of the way, "Fast", "Fast (Best not in use)" when Best was wanted but isn't drawing (the report says why), "not needed" when the video has as many pixels as it is drawn with, or "off". It changes the moment the upscaler does, so a step down is seen as it happens.

## 1.1 - 2026-10-03

### Added

- **Upscaling**, a new setting under Performance, for video with fewer pixels than your screen (1080p on a 4K screen, say). Until now such a video was drawn with as many pixels as it has and the browser stretched it over the screen, which is soft. Now the picture is drawn with as many pixels as the screen has, and the extension does the stretching itself.
  - **Fast**: an edge-aware upscale, the upscaling half of AMD's FidelityFX Super Resolution 1 (EASU) written out for WebGPU. It looks at the 12 nearest pixels, finds which way the edge runs and blends along it, so lines stay thin and don't turn into staircases.
  - **Best (FSRCNNX)**: the small trained network mpv users know, by igv. It doubles the picture's brightness detail (colour is stretched the plain way and shifted to match, as in mpv); where the picture is drawn more than twice as big, Fast takes it the rest of the way. Both published sizes are included: the 16-channel one is used first, and the 8-channel one if the GPU can't fit the bigger in. It is only used where the picture is made at least 1.3 times bigger, the same rule the files have for mpv.
  - **Auto** (the default): Fast for video of 45 frames a second or more, Best below that, Fast until the frame rate is known. With Performance on **Best quality**, Best (the bigger network) is used whatever the frame rate.
  - **Off**: as before.
- Upscaling steps down by itself when Performance is Auto and the GPU says a frame's work takes more than half a frame's time: the bigger network, then the smaller, then Fast, then off with the rest of the quality levels. It is off when Performance is Fastest, when a screen's worth of pixels at the video's frame rate is over Auto's pixel budget (4K at 120), and when the video already has as many pixels as it is drawn with.
- The Sharpness control works on the upscaled picture, one screen pixel wide.
- The report says which upscaling is in use and from what size to what (and, when Best was wanted and Fast is drawing, why), on the "Timings" line and in the settings line. The popup's status line says "upscaled to 2160p", and its tooltip which upscaler.
- `third_party/fsrcnnx/`: the two FSRCNNX shader files exactly as igv published them, with their licence (LGPL 3, not the MIT licence of the rest). The extension reads a file as text and turns its passes into the browser's shader language as it loads (`upnet.js`), refusing any line it doesn't know. `LICENSE-FSR.txt`: AMD's MIT licence for the Fast pass.

### Changed

- With upscaling on, a 1080p video on a 4K screen is drawn at 4K, where it used to be drawn at 1080p. That is about four times the GPU work for the main pass, the same as a 4K video has always been, before the upscaler's own work. Set Upscaling to Off to have the old behaviour.
- In split view the Original side is upscaled the same way as the other side, so the two differ only in brightness and colour.

### Tested, and not

- Checked here, in software rendering (headless Chromium): the network as the extension runs it gives the same numbers as a separate plain reading of the shader files, to within one step of the 10-bit picture, for both sizes. Shrinking a photo and upscaling it again, it comes closer to the original than bicubic does (about 36 dB against 33 on one photo; on another, very detailed one, no better than bicubic unless the photo was shrunk the way the network was trained for). Fast and Best both give visibly thinner, cleaner lines than the browser's stretch on a test pattern; 2x, 3x and 1.5x all draw; every combination of Upscaling and Performance picks what it should; the smaller network and the fall-back to Fast work when forced.
- Not checked: anything on a real GPU. What either network costs at 1080p on a Radeon RX 9070 XT, whether the bigger one fits in a 60 frames a second video with Performance on Best quality (nothing steps it down there: that is what Best quality means), and whether drawing 1080p 60 at 4K brings back any stutter. The automatic step-down itself could not be made to trigger here, because software rendering is too slow for the frame measurements it goes by; only the steps it leads to were checked.
- The network's textures take GPU memory: about 315 MB for a 1080p video with the bigger network, 180 MB with the smaller.

## 1.0 - 2026-10-03

### Changed

- Improved spacing and card styling in the popup.
- Replaced the purple icon with generated highlight artwork, sized for the browser toolbar and popup header.
- The toolbar and header icons follow the selected Amber, Ocean, Rose or Aurora theme. The browser's extensions list uses the default icon.

### Added

- **A Custom colour theme**: a fifth swatch in the settings, with two colours of your own. The glow, the light behind the glass, the page behind it and the icon (in the popup and the toolbar) are all made from the two. The calibration and model pages follow it too.

### Fixed

- **The popup fits.** On a real site it also shows the "This site" card, and with that and a two-line status it came to about 615 pixels, where a browser gives a popup 600 and adds a scrollbar. Spacing is tightened: the worst case is now 551.
- A dark colour in the Custom theme (black, say) no longer makes the "HDR" in the title and the "recommended" tags unreadable, or the filled part of a slider invisible: writing in the accent is lifted toward white until it can be read, and fills take on some of the other colour.
- The Split dropdowns are a little wider, so "Original" is not squeezed.

Playback is the same code as 0.10.16, which is the build the last report from a real machine was made with.

## 0.11.0 - 2026-10-03

The 0.10.16 report, from the self-test: 184 seconds of 4K 60 in fullscreen with 24 hitches (18 of them one moment as converting came back on), nothing dropped by the decoder, and the longest hold 84 ms. Going in and out of fullscreen four times no longer set off half rate. Thirty seconds with the extension off, for comparison, had 36 hitches a minute to converting's 8. Playback is unchanged in this release; it is about the name and the popup.

### Changed

- **A new name: Headroom HDR.** Headroom is what the extension uses: the brightness above white that an HDR display has to spare.
- **A new look for the popup**: dark glass with a warm glow, and the extension's icon in the header.
- **Settings behind a cog.** The popup opens on the picture controls, method, split, performance and the badge. The cog swaps them for settings: colours, the three playback switches (Pacing, Hide original, Every refresh) and diagnostics (Stats, Copy report, wiggle sound, and the keys for the tests).
- **What is recommended is written beside each switch** ("recommended: on" for the three playback switches, "recommended: off" for Stats), and Performance says "Auto (recommended)".

### Added

- **Colour themes**: Amber (the new look), Ocean, Rose, and Aurora, which is the pastel look from before and follows the system's light or dark. The calibration and model pages follow the choice.

### Not known

- How the new popup looks on a real 4K HDR screen at 150% scaling: it was checked in a test browser only.
- The icon is still the purple one, which sits a little oddly on Amber.

## 0.10.16 - 2026-10-03

A testing aid only; nothing about playback has changed since 0.10.15.

### Added

- **Self-test (Alt+Shift+T on the page, in fullscreen too).** Runs the whole test by itself in about three and a half minutes: 30 seconds with converting switched off, for comparison, then six 30-second turns of the A/B test, with a made-up mouse moved over the player at every cue. Stats is switched on for it. A double beep when it starts, a bell when it is done; the report is then copied to the clipboard if the browser allows that (otherwise the popup's Report button). The same key stops it. The badge says SELF-TEST while it runs.
- The made-up mouse is mouse events sent to the player, so its controls come up as for a real one. Whether they did is noted in the history each time (on YouTube).

### Not known

- Whether YouTube's player answers a made-up mouse as it does a real one, and whether a made-up one sets off a stuck hand-over the way a real one does. The first run will show: the history says whether the controls came up.
- It cannot go in or out of fullscreen by itself (a page is not allowed to), so it does not test that.
- While its first 30 seconds run, converting is switched off everywhere, not just on this page; it is switched back on after, or when the test is stopped with the same key.

## 0.10.15 - 2026-10-03

No new report. A review of 0.10.13 by ChatGPT found the two faults 0.10.14 had already fixed (a late copy taken for a stuck hand-over; half rate kept on by the mouse), and several things in the report that did not say what they seemed to. Those are fixed here.

### Changed

- **The Pacing switch has moved**: it now shows only while Stats is on, beside the wiggle sound. Pacing is on by default and is meant to stay on; the switch is for testing and for a machine where it turns out to do harm.
- **The A/B test (Alt+Shift+A) starts with pacing on or off by chance**, and says which in the history. It always started with pacing on, so the start of a run always counted against pacing.

### Fixed (diagnostics)

- The GPU thread's answers were counted under whatever pacing was doing when they were heard, in batches of half a second; near a turn of the A/B test some landed on the wrong side. Each is now counted under what was running when it was asked.
- "Time until the GPU had copied a frame" and "GPU work per frame" are worked out from the latest 1,200 frames only. They now say so, and give the longest over the whole run as well.
- An easing-off still going when the video was paused kept counting through the pause ("495.2 s"). It now counts only while playing.
- Earlier runs carried over in a report say which version they were made with.
- A GPU timing read-back that failed was not released.

### Not done

- From the same review: a limit on copies outstanding on the GPU (five or more were waiting 3 times in 11,700 frames, so little to gain), and timing the copy and model passes too (it changes what Auto goes by).

## 0.10.14 - 2026-10-03

The 0.10.13 report. The mouse log shows it was moved in every turn (7 times with pacing on, 6 with it off). With pacing on, after the first 20 seconds: three turns, 6 wiggles, 5 single-frame hitches, nothing stuck, nothing dropped by the decoder. With pacing off: one of 6 wiggles set off a jam of 8.6 seconds and 194 frames dropped by the decoder, and three beats held 0.25, 2 and 4 seconds into it did not clear it. The one jam with pacing on (17 s, right after going fullscreen) had a beat 0.26 s after it began and was over in 0.4 s.

But the first 20 seconds, in and out of fullscreen, cost 268 frames with pacing on, and that was the extension's own doing: a copy waited 136 ms on the GPU while the window was changing size, that was taken for a stuck hand-over, and every other frame was let go by for 7.8 seconds. The GPU thread showed nothing stuck and the decoder was at its usual 23 ms. (The same in a short run before it: 10.8 seconds.)

### Fixed

- **A late copy is no longer taken for a stuck hand-over while the GPU thread can be asked.** Its answer is the one that counts; the older signs (a copy waiting long, copies slow while a frame is slow to decode) are guesses at the same thing, and are now used only where the GPU thread is not being asked.
- **Half rate is left as soon as things are well, unless the hand-over was really seen stuck.** Waiting for the mouse to be still is for a stuck hand-over, which the player's controls set off again; an episode in which the GPU thread never showed one has no need of it.

### Not known

- Whether going in and out of fullscreen is now clean. Not something that can be tried here.
- With pacing off, a jam set off by the mouse is still not cleared by beats. Pacing is what prevents it, and pacing is on by default.

## 0.10.13 - 2026-10-03

The 0.10.12 report, with the mouse wiggled at a sound in every turn: **with pacing on, 122 seconds, 2 hitches, 1 frame lost, nothing dropped by the decoder, no beat needed, and the GPU thread's answer waited for a screen refresh once in 3,632 asks. With pacing off, 104 seconds: 233 hitches, 415 frames lost, 163 dropped by the decoder, the hand-over stuck 5 times.** Over this run and the last, seven turns with pacing on had no jam set off by the mouse; seven with it off had five. Pacing stays on by default.

What pacing did not prevent in 0.10.11 was a jam at the start of a video and one on going fullscreen, and those were only cleared seconds later, because a beat waited for the decoder to show trouble. The GPU thread shows a jam within a third of a second.

### Changed

- **A beat is held as soon as the GPU thread has shown the hand-over stuck for a quarter of a second**, instead of when the decoder's own signs show it (which took 2.6, 4.1 and 7.8 seconds in the last reports). For that, the GPU thread is now asked whenever fast video is being converted on Windows, not only with Stats on. It costs the thread nothing measurable: its answers took 0.0 ms as a rule.
- While the mouse has just moved, beats were held back (they did nothing while the player's controls were up). If the GPU thread itself shows the hand-over still stuck, one is now held every two seconds all the same; without that a jam ran 5.8 seconds with the decoder dropping frames.

### Fixed

- **Pausing could leave the picture a frame or two behind the video.** The loop that draws stops on pause, with the last frame or two still waiting their turn. The frame the video stopped on is now drawn. (Found in a review of 0.10.10 by ChatGPT.)
- The video's frame rate could be read as 65 instead of 60 after a stall, from one stretch in which the decoder was catching up. A rate already known is now changed only when two measurements running agree.

### Diagnostics

- The report lists each time the mouse started moving, and whether pacing was on, so it can be checked that the turns of the A/B test got the same.

### Not known

- Whether the quicker beat clears the jams at the start of a video and on going fullscreen as well as it should. Tried here only on a made-up jam (the beat came 0.26 s after it began).
- Not taken from the ChatGPT review: timing the GPU's copy and model passes as well as the final ones. Worth doing, but it changes what Auto goes by, so not in the build that may become 1.0.

## 0.10.12 - 2026-10-03

The 0.10.11 report: pacing ran on YouTube for the first time. Its worker answered 5,766 screen refreshes at 5.1 ms into the refresh, its sleeps ran over by 0.8 ms (the fine-timer fix held on Windows), and the GPU thread showed the hand-over stuck 7 times, matching every long stutter in the hitch log. With pacing on: 96 s, 51 hitches, the decoder dropped 15. With pacing off: 89 s, 322 hitches, the decoder dropped 183. But the mouse was moved almost only in the off turns (2 hitches near the mouse against 247), so the turns can't be compared fairly yet.

### Added

- **Wiggle sound** (a testing aid; shown in the popup while Stats is on). During the A/B test (Alt+Shift+A) a sound plays twice in every 30-second turn, 8 and 19 seconds in: wiggle the mouse each time, so every turn gets the same. Five sounds to choose from (Ping, Double beep, Chirp, Knock, Bell) or Off, and a **Test** button. Each cue goes into the report's history with the state of pacing at that moment.

### Changed

- While the wiggle-sound row shows, the popup's status line is kept to one line and its rows sit a little closer, to stay under the 600 pixels a browser gives a popup.

## 0.10.11 - 2026-10-03

The 0.10.10 report: **pacing never ran, and neither did the asking of the GPU thread.** Both lines say so: "not possible here, because its worker could not be started (the page does not allow it)". YouTube's own rules (its content security policy) forbid a worker started from the page, and 0.10.10 started its two from there. So that run's "pacing on" and "pacing off" rows compare nothing: it was 0.10.9 with the mouse moved more. (It shows the mouse stretches well enough: 7.7, 6.9 and 17.7 seconds at half rate.)

This build is about getting the two to run where they are needed. Going over how they would behave on Windows, in the browser's source and in traces, turned up three more things that would have stopped them there, none of which show on Linux.

### Fixed

- **Pacing and the GPU-thread check now run on YouTube** and on any page with rules like it. The workers live in a frame of the extension's own (`pacer.html`), which is put into the page the first time one is wanted; a page's rules don't reach into it, and it belongs to the same browser window, which is what pacing needs. Checked on a test page with stricter rules than YouTube's (no frames, no workers, trusted types).
- **The frame is one dot big and see-through, not hidden.** The browser treats a process all of whose frames are hidden as being in the background, and on Windows gives a background process the lowest priority and its slowest clock speed. Seen in a browser trace: with the frame hidden its process was told it was in the background; one dot big, it was not, in fullscreen too.
- **Fine timers.** On Windows a sleep ends on a tick of the system timer, 15.6 ms apart unless the process has asked for 1 ms ticks, and the browser asks only on behalf of a thread that is idle with a short timer pending (read in its source). The two workers that sleep are never idle in that sense, so their sleeps would have run over by up to 15 ms. Two other workers now keep a short timer pending each, which keeps the request standing. And each sleeper tries a few sleeps before it starts: if they run over, it doesn't start, and the report says so.
- **The workers' clocks.** Each worker counts time from its own start, and 0.10.10 lined them up by the computer's calendar clock, which gets nudged about; two workers started minutes apart could disagree by milliseconds. A sleeper now works the difference out from the same screen refresh seen on both clocks.
- A worker that has just handed the browser a frame is not given its own animation frames (measured: 4 in 297 refreshes), so the pacing worker can't see the refreshes for itself. A third worker keeps time for it.
- Putting the tab away could switch pacing off for good ("screen refreshes do not reach its worker"), because the refreshes stop a moment before the worker is told to. It now waits much longer before saying that.

### Changed

- A worker that gives up (sleeps running over, a lost context) is started again 20 seconds later, and left alone only after the third time. Things it can never do without are final at once.
- If the frame stops answering (the extension was reloaded under an open page, say), that is noticed within 6 seconds and a new frame is made.
- The Stats badge says what pacing is doing: **on**, **off**, **not running**, **not used** (video under 45 frames a second) or **NOT POSSIBLE HERE**.
- "By setting" counts pacing as on only while its worker is really at it, with rows of their own for "not running", "not used" and "not possible". Rows of under a second with nothing in them are left out, and of settings changed one straight after another the hitch log tells only the last.

### Diagnostics

- The pacing line adds how far 9 in 10 sleeps ran over, how the clocks were matched, and how many times the worker gave up and why.

### Not known

- **Whether pacing helps.** Still only this: in headless Chromium on Linux the browser's drawing moves to between 5 and 6 ms into each refresh and back, a page with nothing to redraw stays undrawn, and late answers, a hung worker and coarse timers are all survived. Nothing of this build has run on Windows.
- Whether the fine-timer request holds on Windows as the browser's source says it should. If not, the report will say "its sleeps ran over by ... the browser's timers are too coarse here".
- On battery power the browser keeps timers at 8 ms, so pacing will say it is not possible there.

## 0.10.10 - 2026-10-03

The 0.10.9 report: the best run yet. The queue got stuck by itself three times in the first 45 seconds, each time one short freeze and 0.7 seconds at half rate, every beat cleared it, and then 100 seconds ran clean. The decoder dropped 21 frames in 150 seconds. (The change in 0.10.9 itself was not put to the test: the mouse was hardly moved.)

Everything since 0.10.4 has been about clearing the stuck queue faster. This is the first attempt at keeping it from getting stuck, and the first way of seeing it directly.

What the browser's own source says about that hand-over, read for this: the page is drawn into a pair of buffers, one on screen and one being handed to Windows. There is no third. So once a redraw has been handed over, the next has nowhere to go until Windows has taken the first, which it does at a screen refresh. One hand-over that Windows takes a refresh late is enough: from then on every hand-over finds the one before still waiting, and waits for the next refresh itself. That is the stuck queue, and it explains why it never clears while there is something to draw every refresh. The number of buffers is set inside the browser, out of an extension's reach.

### Added

- **Pacing** (on by default, Windows only, for video of 45 frames a second or more; a switch in the popup). The browser hands a redraw over about 0.8 ms after each screen refresh, the very moment Windows is taking the last one. In both traces every hand-over that got stuck was made at that moment, and in the one stretch where the page's redraws happened to reach the browser about 5 ms into the refresh (36 seconds in the first trace) nothing got stuck at all. Pacing makes the late hand-over the rule. Before the browser draws a refresh it waits a while for everything on the page that has been told the refresh has begun and has not answered; so a worker keeps a canvas that is never put on the page, and holds its answer back until 5 ms into each refresh. The browser draws the moment the answer comes. It costs the page's own thread nothing, and a canvas that is not on the page gives the browser nothing to redraw.
- If the hand-over gets stuck all the same, pacing should still take most of the harm out of it: a hand-over that starts 6 ms into the refresh keeps the browser's GPU thread waiting for 10 ms of every 17, not 16, and the decoder runs on that thread.
- **Asking the browser's GPU thread** (with Stats on). A second worker puts a question to the browser's GPU process that takes no work to answer, about thirty times a second, and times the answer. The answer has to come from the thread that hands redraws to Windows, so while a hand-over is stuck it arrives with the next screen refresh and not before. That shows a stuck hand-over as it happens; everything the extension has gone by until now (the decoder slowing, copies coming back late) shows it half a second later and at second hand. It is only measured in this version, not acted on.

### Changed

- **Alt+Shift+A** (with Stats on) now switches pacing off and on in 30-second turns, so one run compares the two. The test of easing off that it used to run is gone; easing off and beats are always allowed.
- The popup's status line is kept to two lines ("every other frame" and "lost outside the GPU" are said more briefly, with the rest in the tooltip): a third line made the popup 603 pixels tall, and a browser gives a popup 600.

### Diagnostics

- How the pacing itself went: how many refreshes its worker answered, how far into the refresh, how often it was late, how far its sleeps ran over.
- Beats held and frames dropped by the decoder, counted separately for pacing on and off; the table of beats says which each was held under, and whether the GPU thread showed the hand-over stuck at that moment; "By setting" has a row for each.
- The hitch log adds ", hand-over stuck" to the cause of any hitch that came while the GPU thread showed the hand-over stuck.
- What the GPU thread's answers showed: how often an answer waited for a screen refresh with pacing on and off; each time the hand-over was stuck, when, for how long, at what moment of the refresh the hand-over starts, and how soon a beat followed; and how long the answer took at each moment of the refresh, which shows when in the refresh the browser is busy handing over (it should move from the start of the refresh to about 5 ms in when pacing is on).

### Not known

- **Whether it works.** That the browser's drawing moves is checked (headless Chromium on Linux, with browser traces: from 0.1 ms to between 5 and 6 ms into each refresh, and back when switched off). Whether a later hand-over keeps Windows from getting stuck can only show on Windows. The evidence for it is one stretch of 36 seconds in one trace.
- Whether the worker keeps time on Windows. It sleeps to within a fraction of a millisecond on Linux. If the browser's timers are too coarse it notices, stops pacing and says so in the report.
- Whether the extra 5 ms before the browser draws can be seen or felt. It should not be: it is a third of one frame.
- What a stuck hand-over looks like to the GPU thread on a real machine. The test for it is built from the traces (an answer that waited and came with a screen refresh, three times running), and tried on a made-up one.

## 0.10.9 - 2026-10-03

The 0.10.8 report. The six times the queue got stuck by itself each cost one short freeze and 0.7 to 0.8 seconds at half rate, and every beat cleared it. Moving the mouse now gives one stretch at half rate (6.9 and 5.1 seconds) where it gave three, as intended.

But inside those stretches the extension went on holding beats, one every 0.7 seconds, nine in the longer one: while the player's controls show, the queue is stuck again a moment after each beat, so each was a freeze for nothing, and the picture was worse for them.

### Changed

- **No further beats while the mouse has just moved.** An episode still begins with one. After that, while it is at half rate and the mouse has moved in the last 3.5 seconds, no more are held; once the mouse has been still that long, they count again if things are still not right.

### Not known

- How the picture looks through a mouse movement now: it should be an even half rate for as long as the controls show and nothing else, but the decoder was still not quite well at half rate in those stretches (decode times of 70 to 80 ms, some frames dropped), so it may not be perfectly even.

## 0.10.8 - 2026-10-03

The 0.10.7 report, and the best run so far: eight beats, eight cleared, 33 frames dropped by the decoder in 133 seconds (it was 190 to 230 a few versions ago). The two times the queue got stuck by itself cost 0.7 and 0.8 seconds at half rate each, after one short freeze, and that was all.

What was left was the mouse. Each time it was moved there were three episodes one after another (0.7, 1.8 and 3.0 seconds at half rate, with stutter and a freeze before each): while the player's controls are showing, YouTube redraws the page every refresh, so the queue was stuck again the moment full rate came back.

### Changed

- **Full rate does not come back while the mouse has moved in the last 3.5 seconds.** An episode that starts around a mouse movement is now one stretch at half rate until the controls have gone, not three with stutter between. It only applies once an episode has begun: moving the mouse does not by itself cost anything.

### Not known

- The earlier sign added in 0.10.7 did not set off a single beat in this run; the decoder's signs or a waiting copy got there first every time. It stays, since it costs nothing, but it has not shown that it helps.
- One beat (at 69 s) was set off by a waiting copy while the decoder was fine. It came 0.1 s after the mouse moved and trouble followed two seconds later, so it may have been real; it may also have been the first false alarm.

## 0.10.7 - 2026-10-02

A closer look at the second trace, with nothing new from the test machine: 0.10.6 has not been run yet, and this builds on it.

What the trace says, beyond what 0.10.6 already acted on:

- The queue got stuck by itself four times in 75 seconds, with the player's controls hidden and the mouse still. Nothing leads up to it: redraws had been handed over 0.7 to 0.9 ms after each screen refresh, hundreds in a row, each taking 0.1 ms, and then one handed over at the same moment as all the others takes a whole refresh, and so does every one after it. Nothing in the browser's GPU process is busy at that moment. Whatever decides it is below the browser, in Windows or the graphics driver, where a trace of the browser does not reach.
- From that moment to the decoder's first sign of trouble took 0.40 to 0.47 seconds, all four times. That is how long the stutter ran before anything was done about it, and it is most of what is left to see of an episode.
- After a hold, the relapse comes 40 to 110 ms later whether the first redraw after the hold was handed over early or late in a refresh, and the decoder, though it does catch up during the hold (11 to 17 frames), is doing nothing unusual when it happens. So the explanation given in 0.10.6 ("as the decoder catches up") is not supported; the remedy, taking every other frame from the moment of the beat, does not depend on it.

### Added

- **An earlier sign.** The time the GPU takes to finish a copy roughly triples when the queue is stuck, but it also jumps about in good running, so it could not be used alone. It now counts together with a second sign: when the last six copies took well over twice as long as usual and the decoder has just taken five frame times or more over a frame, the extension acts, without waiting for frames to be dropped. Either sign alone happens in good running; the two together have not been seen there.
- The report says which sign set off each beat.

### Not known

- Whether the earlier sign comes earlier in practice, and by how much. It is built from what the reports show of the two measurements, not from a run.
- Why the queue gets stuck, and why in some stretches not at all (80 seconds without it at the end of the 0.10.5 run, 77 in the 0.10.3 run). In the 0.10.5 run it stopped at about the moment the trace recording ended, which may mean the recording itself made it more likely, or nothing.

## 0.10.6 - 2026-10-02

The 0.10.5 report and a trace taken with it. Twelve beats, eight "cleared", but of the first beats, the ones held alone at full rate, only two of six.

The trace shows why, and it is not the length of the hold this time. Every one of the fifteen holds in it did what it was for: the first redraw after it was handed over in 0.1 ms instead of 15. But in most cases the queue was stuck again a tenth of a second later, after one hand-over that took 66 ms, four screen refreshes, always two or three redraws after the hold ended. That is when the decoder, with the thread to itself again, is working through everything it had fallen behind on. The beats that lasted were the ones held while every other frame was already being taken: with a redraw only every other refresh, a queue that fills again empties again by itself.

### Changed

- **A beat is no longer held alone.** At the first sign of trouble the extension holds a beat and takes every other frame from the same moment, where 0.10.5 waited 0.7 seconds to see whether the beat alone had worked. In the report, that pair cleared things four times out of four.
- **Full rate comes back after 0.6 seconds of the decoder being well**, not 1. As before, the wait doubles if that turns out too soon.
- A copy waiting too long on the GPU now counts as trouble by itself, where before it only set off a beat.

### Not known

- What the 66 ms hand-over is. It follows the hold too regularly to be chance, and the decoder catching up is the likeliest reason, but the trace was not taken with enough detail to say.
- Whether 0.6 seconds is long enough to be past it. If full rate comes back too soon the report will show the same episode twice in a row.
- Each episode still costs a freeze of about four refreshes and then roughly a second at half rate. That is much less than before and still not nothing; preventing the queue from getting stuck at all is inside the browser.

## 0.10.5 - 2026-10-02

The 0.10.4 report. Beats were held nineteen times, and the ones that mattered did nothing: of the first beats, held at full rate, six of seven changed nothing, and the trouble was ended, as before, by taking every other frame 0.7 seconds later.

The hold was one refresh too short. Going back to the trace: while the queue is stuck, a frame of the page reaches the browser's display side just after every refresh, one more already waits there, and one is waiting to be handed over. For a refresh to pass with no hand-over, two of the page's frames in a row have to stay away, and the third must not come until the refresh after. When the trouble ended by itself in the trace, the gap between two frames of the page was 54 ms, three and a quarter refreshes. 0.10.4 held for 2.3: the page's next frame then arrived in the middle of the one refresh that had to stay empty, was handed over at once, had to wait, and the queue was stuck again.

### Changed

- **A beat now holds for 3.3 refreshes** (55 ms at 60 Hz), not 2.3. The cost goes up with it: a freeze of about four refreshes and three frames of the video, once per beat.
- The hold now comes before the video is looked at in that refresh, so that the first thing drawn after it is the frame the video is showing then, not one from before.

### Fixed

- "The GPU usually has a copy done in" was far too low (5 ms where the typical time was 35): it followed short times quickly and long ones hardly at all. It is now the middle one of the last 64.

### Not known

- Whether 3.3 refreshes is right. It comes from one moment in one trace; 0.10.4's figure came from a headless browser, which turned out not to behave like the stuck one. The report will show it in the first line of each episode: "cleared" with no half rate after it.
- Why the queue gets stuck as often as it did in this run (nine times in 142 seconds, about half of them nowhere near a mouse movement).

## 0.10.4 - 2026-10-02

A browser trace of the stutter, and with it the cause. Until now the extension could only see the decoder suffering; the trace shows what makes it suffer.

With the extension on, Brave redraws the whole page for every frame of the video, and hands each redraw to Windows. That normally takes about 0.1 ms. In the trace, as the player's controls came up, one redraw was handed over late, and from then on every one of them had to wait about 15 ms for the next screen refresh, because the one before it was still queued. That wait is on the one thread in the browser's GPU process that also runs the video decoder and WebGPU. For nine seconds that thread was busy 99.9% of the time, nearly all of it waiting, and the decoder got what was left. It ended at the first refresh in which the page had nothing new to draw: one refresh without a redraw, and the hand-over was back to 0.1 ms.

That explains what the earlier reports showed without explaining it: why the trouble starts with a disturbance and then keeps itself going, why it never happens with the extension off (the video then has its own path to the screen and the page is hardly redrawn), why the GPU's own work had nothing to do with it, why taking every other frame cured it at once when the player's controls were hidden (30 redraws a second leave empty refreshes) and not while they were showing (YouTube itself then redraws the page every refresh).

### Added

- **Holding a beat.** When a frame handed to the GPU is still waiting after five frame times although the GPU has little to do (in good running it takes one or two), or the decoder shows trouble, the extension holds the page for a little over two screen refreshes, so that the browser gets one whole refresh with nothing to redraw and its queue empties. It costs one frame staying up for three refreshes and one frame lost, once, in place of a second or more at half rate. It works whether or not the player's controls are showing, since it holds everything the page draws.
- A beat is judged 0.7 seconds later. If it did not clear things, every other frame is taken as before, with further beats. After three beats in a row that changed nothing, beats are left off for 5 seconds, then 10, up to 60.

### Changed

- Taking every other frame is now the second remedy, not the first, and is not left while a frame is still waiting too long on the GPU.

### Diagnostics

- The report lists each beat: what set it off, how long a copy had been waiting, the decode time before and after, and whether it cleared things. The hitch log has a cause of its own for it, "held a beat".
- The report gives how long the GPU usually takes to finish a copy.

### Not known

- Whether a beat clears the stuck queue on a real machine. The trace shows the queue clearing after one refresh without a redraw, and a headless browser shows that holding the page for 2.3 refreshes gives the display such a refresh (and that 1.25 does not), but the two have not been seen together.
- Whether the "frame still waiting" sign fires early enough to act before the decoder drops anything, and whether it ever fires in good running. In the reports so far a copy waited up to about 76 ms in good running and 95 ms or more when stuck; the sign is 83 ms. That is not a wide margin.
- Why one redraw is handed over late in the first place. That is inside the browser, and it is what would have to change for this not to need a cure at all.

## 0.10.3 - 2026-10-02

The 0.10.2 report: five minutes at 4K 60 in fullscreen. The decoder fell behind eleven times, and easing off brought it back every time. Nine of the eleven times it was well again within about half a second; the other two, both while the mouse was moving, took between four and five seconds. Nothing like the nine seconds to a minute of trouble in earlier versions happened, and the last 75 seconds and the first 30 were clean.

So the cure works. What is left is how much of it shows. Each time cost a few hundred milliseconds of real stutter before the extension acted, then two seconds at half rate that the decoder no longer needed. And eleven times in five minutes is far more often than the run before (twice in two and a half minutes): the trouble starts on its own, not only when the mouse moves, and how often varies from run to run for reasons the report cannot see.

### Changed

- **Acts sooner.** A single frame that took the decoder six frame times or more (and two and a half times what is usual), with a frame lost, is enough to ease off at once. In good running a frame takes three frame times and was never seen to take five; in trouble, seven to twelve. The 0.12 seconds of waiting for the trouble to be confirmed is gone as well.
- **Goes back sooner.** Full rate returns after one second of the decoder being well, not two. If that turns out too soon, the next wait doubles, as before. In the report, full rate held ten times out of eleven after two seconds; whether it holds as often after one is not known.
- **Auto quality no longer counts frames let go by on purpose as frames lost.** It was noting "frames are being lost ... lower quality would not help" after each easing off, and showing that in the popup.

### Diagnostics

- The report says whether the browser decodes 4K 60 on the graphics card or on the processor (VP9 and AV1), and what kind of frames the video hands over. Both bear on why the decoder is so easily upset, which is still not known.

### Not known

- Why the decoder falls behind in the first place, and so how to stop it happening rather than cure it. The report shows what happens in the page; the cause is inside the browser's GPU process, which only a browser trace (brave://tracing) can show.
- Whether acting sooner shortens the stutter at the start of each episode as much as hoped: tested with made-up decoder numbers on a software GPU only.

## 0.10.2 - 2026-10-02

The 0.10.1 report, and the first sign that easing off does what it was meant to. The decoder fell behind at 24 seconds (27 to 38% of frames dropped, two stalls) and stayed behind for nearly nine seconds at full rate. The extension then took every other frame, the decoder was well again within about 0.7 seconds, full rate came back two seconds later, and the remaining 116 seconds ran at 60 with nothing dropped and four single lost frames, mouse movement included. One occurrence, so not proof.

The nine seconds were 0.10.1's own doing. At the very start of the run the decoder was also behind; easing off was tried, judged a failure after 2.5 seconds although decode time had fallen from 119 to 38 ms, and then not allowed for 30 seconds. The real trouble began inside those 30 seconds.

### Changed

- **Easing off is no longer given up on after 2.5 seconds.** Every other frame is taken for as long as the decoder is unwell and for two seconds after. Only if the decoder has not been well for a single moment in eight seconds is it given up on.
- **After giving up, it is tried again after 8 seconds** (then 16, 32, 60), not after 30 (then 60, 120, up to 300).
- **Slow decoding alone no longer counts as trouble.** Frames must be being lost as well (one in the last 0.6 seconds), or a lot of them lost (four). And slow now also means at least twice what is usual for the video being played, so a decoder that always runs several frames behind and loses nothing is left alone. Going back to full rate still needs both signs gone.
- **Frames dropped as a matter of course are not counted**: when the video has more frames than the screen can show (a 60 fps video on a 50 Hz screen, or played faster than normal speed), the decoder throws the surplus away and that says nothing about its health.

### Diagnostics

- The report gives the decode time that is usual for the video next to the current one, and says when easing off began on dropped frames.

### Not known

- Whether easing off ends the trouble every time. It did the one time it was allowed to act on it.
- Whether it helps at the very start of a video, where the decoder is often behind for a few seconds anyway.
- Everything in "Changed" was tested with made-up decoder numbers on a software GPU, not on a real 4K 60 video.

## 0.10.1 - 2026-10-02

The 0.10.0 report. The first 55 seconds at 4K 60 were clean, and so was the storage fix: the six-second hitch is gone. Then the decoder fell behind when the player's controls came up and stayed behind for 48 seconds (17 to 44% of frames dropped, three stalls), until the video went down to 1440p, after which it was clean again. "Making room for the decoder" did nothing for it, for a reason that is 0.10.0's own fault: five frames waiting on the GPU, the number it rested at, turned out to be reached now and then in normal running. Four such rests in twenty seconds, each costing a frame or two for nothing, used up its allowance, and it switched itself off for a minute, one second before the real trouble began.

The report also shows that the count of frames waiting on the GPU is a poor sign of trouble (2 to 3 in good running, 3 to 6 in bad), while the decoder's own numbers are a clear one: it takes about 24 ms over a frame when all is well and well over 100 ms when it isn't, and it drops no frames when all is well.

### Changed

- **The extension now goes by the decoder's health, and eases off instead of resting.** When the decoder says frames are taking it more than four frame times, or it throws away four frames in 0.6 seconds, every other frame of the video is let go by. That halves what is asked of the browser, and the picture runs at half the frame rate, evenly, until the decoder has caught up and stayed caught up for two seconds. If full rate then turns out to have been too soon, the next wait is twice as long. If easing off hasn't helped after a second, one 150 ms rest is tried; if the decoder is still behind after 2.5 seconds, it isn't the answer, and it is not tried again for 30 seconds, then longer. Only for video of 45 frames a second or more.
- The count of frames waiting on the GPU no longer decides anything. It stays in the report.

### Diagnostics

- The report lists each time the extension eased off: when, for how long, the decode time before and at the end, and whether the decoder caught up.
- The badge (Stats on) and the popup's status line say when every other frame is being taken.
- **Alt+Shift+A** now tests easing off: allowed and not allowed, 30 seconds each.

### Not known

- Whether taking half the frames lets the decoder recover. It should if the load the extension puts on the browser is what keeps the decoder behind, which is what everything so far points to, but it has not been seen to work. The report will say.
- What inside the browser gives way. The 0.10.0 notes blamed the decoder's fixed set of frames; that fits less well than it seemed, since a stall, which lets the decoder refill, did not end the trouble this time.
- Whether 1440p is safe from this or was simply not put to the test: nothing disturbed it in that run.

## 0.10.0 - 2026-10-02

Release candidate for 1.0. The stutter at 4K 60 was gone over again from the start, with every report side by side, and it comes down to one thing that the earlier versions were treating piecemeal.

**What the stutter is.** A hardware video decoder works with a small, fixed set of frames: its reference frames, about four decoded ahead of time, and the one on screen. A frame handed to WebGPU is not given back until the browser's graphics process has dealt with it. Every frame the extension is holding is one the decoder can't decode ahead into, and it has about four to spare. Hold one or two and nothing shows. Hold five or six, because the graphics process got behind for a moment (the page loading, the player's controls being drawn, going fullscreen), and the decoder has no lead left: frames come out late and are thrown away, and since the extension goes on taking every frame, it never gets its lead back. Every report fits this: decoding taking three times as long as usual in step with the GPU's reports arriving late, one frame in ten dropped for seconds or minutes, the GPU's own work under a millisecond throughout, lowering the picture size changing nothing, hiding the original helping at once (the browser was holding frames for the screen as well), a stall curing it (the player stops and refills), and none of it with the extension off.

### Changed

- **Room is made for the decoder.** The extension counts how many of the video's frames are still waiting on the GPU. At five it takes no more until they have been dealt with. That shows as the picture holding still for about a tenth of a second, and it lets the decoder get ahead again. If it is needed four times in twenty seconds it isn't working, and it is left off for a while, longer each time. The report lists each time, with how long decoding was taking before and a second after.
- **Frames are handed back to the decoder sooner on every path.** Since 0.9.8 the playing video's frames were taken in a way that returns them the moment they have been copied; redraws after a resize or a change of settings, and drawing with Every refresh off, still read the video element directly, which keeps a frame until the video has moved on to the next. They now do the same as the rest.
- **The 15-second soft start is gone.** It drew 4K 60 video at 1080p to begin with, on the belief that the amount of drawing was the problem. It never was (0.3 to 0.9 ms a frame), and the change of size in the middle of the first seconds was itself a disturbance.
- **Auto goes by the GPU's own timings where it can.** If a frame's work takes more than half the time between frames, it steps down at once, without waiting for frames to be lost. If frames are being lost and the work is light, it leaves quality alone, says so, and looks again later (it used to give up on the video for good).
- **No frosted glass over the video.** The badge had it for its first three seconds and the split handle always: it makes the browser re-filter the picture behind it on every frame.

### Fixed

- **Every video on every open page was redrawn whenever anything was saved to the extension's storage,** including the report that Stats saves in the background. That was the hitch every six seconds in the 0.9.8 report (0.9.9 made it rarer without finding the cause), and with Stats on it also meant an extra read of the video every few seconds. Only a change to a setting does it now, and a playing video picks a change up with its next frame without losing one.
- **A video could be left invisible if the page removed the overlay** (some sites rebuild the player around the video). The overlay being gone is now noticed within a second: the original is put back and conversion starts again. The original is also only hidden while the overlay is on the page and has a size.
- Auto judged the GPU's workload by the slowest of the last twenty timings, so one slow frame could decide. It now takes the middle one, and starts afresh when the picture size changes.

### Diagnostics

- The report shows how many frames were waiting on the GPU each time a new one was taken, and every time room was made.
- **Alt+Shift+A** (Stats on) now tests making room: off and on in 30-second turns, counted separately. The drawing comparison it used to run is gone, along with the older way of drawing it compared against.
- The GPU is timed on every frame copied, with Stats on or off, since the count above depends on it.

### Not known

- Whether this is enough. It was worked out from reports and tested where it can be tested (the logic, with the thresholds lowered so that it triggers), not on a real GPU at 60 frames a second.
- The count is of frames whose copying the GPU hasn't reported finished, which is later than the moment the decoder gets them back, so it runs a little high.
- A video at 120 frames a second holds twice as many frames for the same delay, and may hit the limit in normal running.

## 0.9.9 - 2026-10-02

The 0.9.8 report had two halves. The last 52 seconds were close to clean: 60 frames a second, and the only hitches single frames, most of them exactly six seconds apart. The first 50 seconds were not: the decoder was dropping frames again (201 in all, against 17 in the 0.9.7 run), in bursts, with the same signs as before (frames taking three times as long to decode). One run each cannot say whether 0.9.8's way of drawing brought that back or whether it was that start's bad luck.

### Fixed

- **A hitch every six seconds, caused by the diagnostics.** With Stats on, the report was being put together and stored every few seconds in the middle of playback, and it cost a frame each time. It is now stored every 20 seconds in the page's idle time, when the video pauses, and when the page is left.

### Added

- **An A/B test of the two ways of drawing.** With Stats on, Alt+Shift+A starts it: the queue of 0.9.8 and the direct drawing of 0.9.7 take 30-second turns, and the report adds up frames lost and decoder drops for each. A few minutes of one video then compares them under the same conditions. Press it again to stop; it also stops when the page is reloaded.

### Changed

- The report no longer adds a line every three seconds for a paused video.

## 0.9.8 - 2026-10-02

The 0.9.7 report, same run, both ways: checking every refresh lost 43 frames in 45 seconds, and went the first 34 seconds of the video without a single hitch; relying on the browser's announcements lost 268 in 24 seconds. So the change was right, but not complete. What was left came in bursts of a few seconds in which frames were alternately held for two refreshes and skipped. The video moves to its next frame at about the same instant the page looks at it, so a look sometimes lands just before the change and the next one lands after two.

### Changed

- **Frames are copied into a short queue and put on screen one per refresh, in order.** A look that lands just before the video changes no longer costs a frame: the video is looked at a second time half a refresh later, and a frame found then waits its turn. This can put the picture one or two frames (17 to 33 ms) behind the sound, which is below what can be noticed.
- **The copy of the video frame is sent to the GPU by itself, at once,** and taken from the exact frame that was checked.
- Three copies of the frame are kept where there was one (about 100 MB of graphics memory at 4K).

### Notes

- Tested in headless Chromium with a slow clip: every frame shown once, in order, through a pause, a seek and a resume. At 60 frames a second on a real GPU it is untested.
- Two short bursts of decoder drops (5 and 23 frames in 93 seconds) remain in the 0.9.7 report with nothing measured to explain them.

## 0.9.7 - 2026-10-02

The 0.9.6 report: with the original hidden, the decoder dropped 10 frames in 65 seconds (it was 125 in 72, and 492 in 137, with the original showing). That part worked. But 165 frames were lost another way in the first half minute of playing, up to one in three for five seconds at a stretch: the browser showed them, and never handed them to the extension. The page's own screen updates were on time throughout, so the page was not busy. The likeliest reading is that the browser's announcement of a new frame arrives one screen refresh late, and by the time drawing happens that frame has been replaced by the next.

### Changed

- **Drawing no longer depends on the browser announcing each frame.** The video is looked at on every screen refresh and drawn whenever the frame it is showing has changed; the announcement still triggers a draw too, and whichever comes first wins. Nothing is drawn twice. The **Every refresh** switch now controls this and is on by default (it used to be an experiment that redrew on every refresh regardless).
- The hitch log now follows the frames actually drawn.

### Added

- Alt+Shift+P (Stats on) switches Every refresh on and off in fullscreen, and the report counts hitches separately for each setting.

### Notes

- That the lost frames were late announcements is an inference from the report, not something seen directly. If they were lost some other way, this won't recover them, and the per-setting table in the report will show no difference.

## 0.9.6 - 2026-10-02

The 0.9.5 report tried four ways of treating the original video under the overlay, in one run of a 4K 60 video on YouTube, moving the mouse in each to bring up the player's controls:

| Original | Seconds | Hitches | Frames lost |
|---|---|---|---|
| Shown | 52 | 134 | 172 |
| Invisible | 26 | 3 | 3 |
| Tiny | 32 | 127 | 159 |
| Faint | 27 | 173 | 192 |

With the original showing, the controls appearing put the browser into a state where the decoder dropped about one frame in ten, and it did not always come out of it. With the original invisible that did not happen. In the same run the GPU spent 0.3 ms on a frame, and Auto lowering the quality twice changed nothing.

### Changed

- **The original video is now hidden under the overlay by default** ("Hide original", a switch again, on). It is put back at once if drawing fails or the extension is switched off. The Tiny and Faint settings are gone: they did not help.
- **Auto no longer lowers quality when the GPU has time to spare.** Where the browser lets the GPU be asked how long a frame takes, and that is a small part of a frame's time, dropped frames are not a reason to draw fewer pixels. The report and the popup say that frames are being lost outside the GPU.

### Notes

- This rests on one run on one machine, in Brave. An earlier, shorter test with the original hidden showed frames being handed over unevenly in the first seconds of a video; that did not happen this time, and the hitch log will show it if it does.
- Alt+Shift+O (Stats on) now switches Hide original on and off.

## 0.9.5 - 2026-10-02

The 0.9.4 report settled two things. The GPU spends 0.7 ms on a frame, even at full 4K, so the amount of drawing is not what makes it stutter. And 64 of 107 hitches came within four seconds of the mouse moving: five seconds of dropped frames and a stall each time the player's controls appeared, and the same at the start of the video, where the controls are also showing. With the extension off the controls cost nothing. So the trouble is in how the browser puts the picture together when the player draws over the overlay, with the original video still underneath. This build is for finding out which arrangement the browser copes with.

### Changed

- **"Hide original" is now "Original", with four settings:** Shown, Invisible (what the switch did), Tiny (only a 2-pixel corner of the original is drawn) and Faint (drawn almost see-through). An earlier test with Invisible stopped the decoder dropping frames but made the browser hand over frames irregularly; Tiny and Faint keep the video being drawn, which may avoid that.

### Added

- **Alt+Shift+O steps through the Original settings** while Stats is on. It works in fullscreen, and the badge shows the setting in use.
- **The report counts hitches per setting**, so one run can try all four: seconds played, hitches, frames lost, decoder drops and hitches near a mouse move, for each.

## 0.9.4 - 2026-10-02

Diagnostics again; conversion is unchanged. The first 0.9.3 report compared the same 40 seconds of a 4K 60 video with and without converting. Without: no frame failed to reach the screen and the decoder dropped none. With: 1.4% never reached the screen, nearly all of it in the first five seconds, then about one frame every eight seconds. In both places the decoder was dropping frames while it took two to three times as long as usual to decode one. Drawing at 1080p during the soft start did not prevent it, so the amount of drawing is not the whole story. This build measures the two things that report could not tell apart.

### Added

- **GPU work timed on the GPU itself** (Stats on, where the browser allows it): how long a frame's passes actually take to run. The existing number is the wait until the GPU reports a frame done, which also includes queueing behind everything else the browser is doing.
- **Mouse column in the hitch log**: seconds since the mouse last moved, and a count of hitches within four seconds of it. Players draw their controls over the video for a few seconds after the mouse moves, which is extra compositing work.
- The report says when the browser is Brave, and how long after the page loaded each run began.

### Fixed

- The hitch log blamed the first hitches of a run on a "size change" that was only the overlay being given its first size.

## 0.9.3 - 2026-10-02

Diagnostics only: nothing about how video is converted has changed. The reports so far average over three seconds, which shows that something stuttered but not what. This adds what's needed to say what.

### Added

- **Hitch log** in the report. One line for each time a frame of the video was lost or stayed on screen too long, with what was going on at that moment: how long the page was stuck in its own scripts, how far behind the GPU was, frames the decoder dropped, whether the picture size had just changed, whether the browser showed the frame but never handed it to the page. Each gets a likeliest cause, and hitches one after another with the same cause share a line. Above it: how many hitches a minute, how evenly frames were spaced, and a tally of causes.
- **Measuring a video that isn't being converted.** With **Stats** on and the extension switched off, the video is measured the same way, and the report sets the two runs side by side: hitches a minute, frames lost, frames that never reached the screen, decoder drops.
- **Runs survive a reload.** With Stats on, measured runs are kept for half an hour across reloads of the page, so the first seconds after a page loads can be compared with and without converting in one report.
- **Stats now also switches on deeper measuring** while a video is playing: the GPU is timed on every frame (not one in five), and the page's own screen updates are watched, which tells stutter in the video's path from the whole page being late.
- The report names the graphics card (as WebGL reports it; WebGPU gave "unknown"), the processor threads, the screen and window in real pixels, how many frames the decoder has produced and dropped for each video, and the time the browser took to decode frames where it says.

### Changed

- The report keeps five minutes of three-second lines, up from three.

## 0.9.2 - 2026-10-02

Stutter in the first 10 to 15 seconds of a 4K 60 fps video. Three reports on a Radeon RX 9070 XT pinned it down: there is none with the extension off, the video stalls and drops up to 60% of its frames when drawn at full 4K from the start, and it is smooth from the first second when drawn at 1080p. After those seconds, full 4K is fine.

### Changed

- **Auto gives heavy video a soft start.** A video that needs more than 300 million pixels a second at full size (in practice 4K at 60) is drawn at 1080p, without sharpening and debanding, for its first 15 seconds, then goes up to what the budget allows. The popup's status line says "soft start" meanwhile. **Best quality** is not affected and still draws at full resolution from the first frame.

### Fixed

- **Auto in 0.9.1 still drew 4K 60 at 1440p.** YouTube's timestamps are in whole milliseconds, so a 60 fps video measured as 62 or 63 frames a second, which put it just over the new budget. Measured rates are now matched to the nearest common frame rate within 7% (it was 3%), and the budget has more room (560 million pixels a second).

### Known

- One report showed a single three-second stretch with a quarter of frames dropped, 21 seconds in, with **Hide original** on and nothing else out of line. Not explained.

## 0.9.1 - 2026-10-02

A report from 0.9.0 on Best quality: 4K 60 fps in fullscreen, drawn at full 3840x2160, held 59 to 60 fps with 0 to 2% of frames dropped and the GPU 20 to 60 ms behind. In 0.8.4 the same card was 130 to 170 ms behind. The cheaper pipeline is enough, so Auto no longer needs to hold 4K 60 back.

### Changed

- **Auto draws 4K at 60 frames a second at full resolution.** The pixel budget is raised from 300 to 520 million pixels a second. 4K at 120 still starts at 1440p.
- **Auto waits for two slow measurements in a row before lowering quality,** for a GPU backlog as well as for dropped frames. The first seconds of a 4K video are often rough, and one slow measurement there was enough to lower quality for the rest of the video. A GPU that really can't keep up is now caught after about six seconds, not three.

### Known

- The first 10 to 15 seconds of a 4K 60 video can still stutter, with the video itself stalling although plenty is buffered. The cause isn't known yet. (Addressed in 0.9.2.)

## 0.9.0 - 2026-10-02

Fullscreen stutter on 4K 60 fps video, worked out from two diagnostic reports taken on a Radeon RX 9070 XT. They showed two things: at full 4K quality the GPU fell 130 to 170 ms behind, and the browser could settle into showing exactly every other frame, which lowering quality afterwards did not undo. At 1440p the same video ran at a clean 60.

### Changed

- **The video frame is now converted once per frame, not nine times per pixel.** A new first pass copies the frame into an ordinary texture and every later pass reads that. Reading straight from a video costs two fetches and a colour conversion each time, and the main pass did it nine times for every pixel drawn. The picture is unchanged.
- **Auto works to a pixel budget from the first frame.** It no longer starts at full quality and backs off after falling behind. 4K at 30 frames a second and 1440p at 60 are drawn at full size; 4K at 60 is drawn at 1440p. The budget follows the video's frame rate and the size it is shown at, so going fullscreen applies it at once. **Best quality** still draws at full resolution.
- **Auto reacts to the GPU falling behind directly.** A queue of unfinished frames now lowers quality after one measurement, without waiting for a second.
- **Auto no longer blames the page without evidence.** When the lowest quality doesn't help, it used to conclude the page was busy and go back to full quality, which in this case made things worse. It now does that only when the page is measurably busy. Otherwise it stays at the lowest quality and reports that the browser is skipping frames.
- **"Frame timing" is now a switch, "Every refresh",** in a row of experiments. It has not been found to help.

### Added

- **Hide original** (experiment, off by default): makes the original video invisible under the overlay, so the browser stops compositing a picture nobody sees. It is undone at once if drawing fails or the extension is switched off.
- The report now gives the video's frame rate, the screen's refresh rate, what the pixel budget allows, and whether the original is hidden.
- After a seek, the new frame is drawn even if the browser doesn't announce it.

## 0.8.4 - 2026-10-02

A review of the code since trained models were added. One real bug, one mismatch with how models are trained, and a round of hardening.

### Fixed

- **With a trained model in use, conversion could fail to start.** It worked for the first video on a page, but any conversion started after the model was loaded (the next video on YouTube, or after switching the extension off and on) failed, was retried every second, and left stray "HDR" badges on the page. Present since 0.8.0.
- **Videos that aren't 16:9 were shown to the model stretched.** The trainer never does that: it shows a wide or narrow film with black bars. The extension now does the same, and each pixel reads the model's answer for its own place in the picture. 16:9 video is unchanged.
- **The first line of a report** counted frames from the start of the page instead of from when conversion started, so it showed a large false drop.

### Changed

- **A fault while starting to convert a video is cleaned up**, written to the history with its cause, and retried a few seconds later. Before, the cause was discarded and whatever had already been added to the page was left there.
- **A fault while drawing one frame can't stop the frames after it**, and is written to the history once.
- **A frame that can't be read is skipped** and conversion carries on; it only stops, to be retried, if frames stay unreadable for two seconds. A video that then runs normally gets a clean slate.
- **The popup says when the extension isn't running on the page**, which happens when the page was open before the extension was installed, updated or reloaded: "Refresh the page to start it."
- The report has a second measure of how busy the page was (`lag`: how late a regular timer ran).
- On a page with no WebGPU at all, this is said once in the history instead of being retried.
- Removing the model frees its memory on the GPU straight away.

## 0.8.3 - 2026-10-02

For working out why the extension sometimes doesn't engage on a video.

### Added

- **The report now explains itself.** The popup's **Report** button works on any page, converting or not, and lists every video on the page with the reason it isn't being converted (too small, already HDR, DRM, unreadable, no frame yet, extension or site switched off, no HDR display, WebGPU failed).
- **A history of what the extension did** on the page is kept and included in the report: videos found, conversions started and stopped with the reason, errors and quality changes. The last 150 entries, until the page is reloaded.

### Fixed

- **A passing failure no longer switches a video off for good.** If reading a video's frame failed for any reason, the extension gave up on that video until its source changed. Now only a video the browser forbids reading is given up on; anything else is retried after three seconds, up to five times.
- **WebGPU failing to start is retried.** It used to disable the extension on that page until reload. It now tries again after 5 seconds, then at growing intervals up to a minute.

## 0.8.2 - 2026-10-02

More tools for the fullscreen stutter report. A tester found it is worst at the start of a freshly loaded video and gone after seeking back, which the on-video stats alone can't explain.

### Added

- **Report** button in the popup. It copies a plain-text diagnostic report for the video on the current tab: GPU, screen, settings, and a line for every three seconds of the last few minutes with frames drawn and dropped, the longest gap, how late the page heard about frames, how long drawing and the GPU took, how busy the page was, frames the decoder dropped, seconds buffered, and video events such as buffering or a quality change. It is recorded continuously, so it can be copied after the problem has happened. Nothing leaves your computer except by you pasting it.

## 0.8.1 - 2026-10-02

### Changed

- **Split view has a menu for each side.** Choose Original, Shader or Model for the left and for the right of the line, in any pairing: the model against the untouched original, the shader against the model, and so on. This replaces the fixed "Original | HDR" and "Shader | Model" choices from 0.8.0. A switch next to the menus turns split view on and off.
- Changing **Method** (in the popup or with Alt+Shift+M) also sets the right-hand side of the split to that method.
- The badge names both sides while split view is on, for example **ORIGINAL | MODEL**.

## 0.8.0 - 2026-10-02

Trained models. A model made with HDR Trainer can now decide the brightness in place of the shader.

### Added

- **Trained model support.** Load the `hdr-model.json` that HDR Trainer exports (popup: **Load**, next to **Method**) and the extension runs it on the GPU for every video frame. Everything stays on your computer.
- **Method** setting in the popup: **Shader** or **Your model**.
- **Split view: Shader | Model**, which shows the shader's result left of the line and the model's on the right.
- **Alt+Shift+M** switches between the shader and the model.
- The badge reads **HDR · MODEL** while the model is in use, and **SHADER | MODEL** in the comparison split.
- A page for loading, replacing and removing the model, showing its training steps, number of movies and score.

### Changed

- **Split view** is now a menu (Off, Original | HDR, Shader | Model) instead of a switch.
- While the model is in use, **Reach**, **Shaping** and **Colour lights** are greyed out, since they only tune the shader, and **Peak brightness** acts as a ceiling the model's highlights ease into.
- Keyboard shortcuts moved from a line at the bottom of the popup to tooltips on the controls they work.
- The popup is a little wider and more compact.

### Notes

- The model is extra GPU work per frame and the Performance setting does not reduce it.
- The GPU version of the network matches the PyTorch original in testing, but how a real trained model looks and performs on real hardware is untested in this release.

## 0.7.1 - 2026-10-02

Tools for a report of heavy stutter in fullscreen only, on a system where the GPU has plenty of headroom. The cause is not confirmed; this release is for finding it.

### Added

- **Stats** switch in the popup. The HDR badge becomes a live readout that stays visible in fullscreen: frames drawn per second, share of frames dropped, the longest gap between two frames, the size drawn at and the frame timing in use.
- **Frame timing** setting: *Each video frame* (the default, and how it has always worked) or *Every screen refresh*. The second draws on every refresh of the display so the overlay updates at one steady rhythm, as an experiment for fullscreen stutter with FreeSync or G-Sync. It uses more GPU.
- The popup's status tooltip now includes the longest gap between frames and the frame timing.

### Changed

- **Split view**, **HDR badge** and the new **Stats** share one row in the popup, labelled Split, Badge and Stats.

## 0.7.0 - 2026-10-02

### Added

- **Unlock locked videos**, a per-site switch in the popup. Some sites serve their video from another server that doesn't permit it to be read, so the browser blocks the extension from converting it. Switching this on adds the missing permission to video that site loads and reloads the video, keeping your place. It is off by default, because it also lets the site's own scripts read that video. If a video won't load that way it is put back as it was.
- The popup now says when a video on the page is locked, instead of showing nothing.

### Changed

- New permission: `declarativeNetRequest`, used only for the switch above and only on sites where it is on.

### Fixed

- A video that couldn't be read left a dead entry behind, which the popup's status line then reported as a video being converted.

## 0.6.1 - 2026-10-02

A performance release, prompted by a report of stutter on 4K YouTube video.

### Added

- **Performance setting** in the popup: *Auto*, *Best quality* or *Fastest*.
  - *Auto* (the default) measures dropped frames and, if there are too many, lowers the render resolution to 1440p, then to 1080p with sharpening and debanding off. Levels that would change nothing on your screen are skipped. If the lowest level drops as many frames as full quality did, it restores full quality and stops, since the GPU was not the cause.
  - *Fastest* always renders at 1080p with sharpening and debanding off, which cuts the per-pixel video reads from nine to one.
- **Live status in the popup.** While a video plays, the line under the title shows its resolution, the frame rate being drawn and the share of frames dropped. Hover it for the render size and the GPU in use.
- The GPU in use is also written to the page's console at start-up.

### Changed

- The picture is never drawn with more pixels than the video has. A 1080p video on a 4K screen is drawn at 1080p and scaled up by the browser. *Best quality* turns this off.
- Looking for video players inside shadow DOM now runs in the browser's idle time, a slice at a time. It used to walk the whole page in one go every three seconds, which on a large page could cost a video frame. It runs less often once a video is playing and not at all in a hidden tab.
- The check for whether a video is already HDR now runs about every five seconds per video, down from every second. A change of source or resolution still triggers it straight away. A switch between an SDR and an HDR stream mid-video can therefore take a few seconds longer to notice.
- The HDR badge drops its frosted-glass blur once it has faded, so the browser no longer re-filters the area behind it on every frame.
- The popup's "This site" card is now a single row, and "Separate picture settings" is labelled "Own settings".

### Fixed

- A video that was already HDR could be converted for a moment if it was found before its first frame had loaded.
- A video that was already HDR had a frame grabbed every second to re-check it. This now follows the same five-second schedule as everything else.
- A paused video is now redrawn when the overlay changes size, instead of keeping the picture from before the change.

## 0.6.0 - 2026-10-02

### Added

- **Wide colour.** Stretches already-vivid colours toward the edge of the P3 gamut. Greys, muted colours and skin tones are left alone.
- **Colour lights.** Lets coloured highlights such as neon, brake lights and fire get a brightness boost closer to what white highlights get.

### Changed

- Both new controls default to 50%, so the default picture is more colourful than in 0.5. Setting both to Off gives the 0.5 picture.
- The popup's picture sliders are laid out in two columns. "Highlight reach" is now "Reach" and "Highlight shaping" is now "Shaping".

## 0.5.1 - 2026-10-01

### Added

- Extension icon.
- README, MIT license and screenshots.

## 0.5.0 - 2026-10-01

### Added

- **Skin-safe colour boost.** Colour boost now leaves skin tones, from pale to deep, almost untouched.
- **Highlight shaping.** Large blown-out areas get a gradient, dimmer at the rim and brighter in the middle, instead of one flat brightness.
- **Sharpening**, contrast-adaptive.

### Changed

- New popup and calibration page design.
- Mid-sized lights now brighten evenly and get more boost than before. A small light next to a large bright area gets less.

### Fixed

- Mid-sized lights were brighter at the rim than in the centre.
- A light's brightness could pulse as it moved across the frame.

## 0.4.0 - 2026-10-01

### Added

- **Display calibration page**, to find the brightest white your display can show.
- **Highlight roll-off.** Highlights ease into the display's maximum instead of clipping.
- **Keyboard shortcuts**: Alt+Shift+H toggles HDR conversion, Alt+Shift+S toggles split view.
- **Per-site settings**: turn the extension off for a site, or give a site its own picture settings.
- Support for sites that fullscreen the bare video element.
- Support for video players inside shadow DOM.

## 0.3.0 - 2026-10-01

### Added

- The split view line can be dragged.

### Changed

- A switch to or from an HDR stream in the middle of a video is now detected.
- Settings are stored locally instead of in synced storage. Settings from earlier versions are reset once.

## 0.2.0 - 2026-10-01

### Added

- **Scene-adaptive strength.** Dark scenes get stronger highlights and bright scenes get less, smoothed over time.
- **Highlight detection by area.** Small highlights get the full boost; large bright areas get much less.
- **Debanding**, so gradients don't show steps once their brightness is stretched.
- "HDR" badge on converted videos.

## 0.1.0 - 2026-10-01

First version.

- Real-time SDR to HDR conversion of web video with WebGPU, drawn on an HDR canvas over the player.
- Popup with peak brightness, highlight reach and colour boost.
- Split view comparing the original with the result.
- Skips DRM-protected video and video that is already HDR.
