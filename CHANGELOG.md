# Changelog

All notable changes to SDR to HDR Video. Versions follow the number in `manifest.json`.

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
