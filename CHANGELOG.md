# Changelog

All notable changes to SDR to HDR Video. Versions follow the number in `manifest.json`.

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
