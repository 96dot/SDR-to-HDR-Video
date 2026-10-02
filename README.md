# SDR to HDR Video

A Chromium extension that converts ordinary (SDR) web video to HDR in real time on your GPU. It is a hand-tuned inverse tone mapper written as WebGPU shaders: no machine learning, no driver hooks, and nothing leaves your machine.

It is in the same spirit as Nvidia's RTX Video HDR, but works on any GPU that supports WebGPU. It was built and tuned on an AMD Radeon RX 9070 XT.

<p>
  <img src="docs/popup-light.png" alt="The settings popup, light theme" width="300">
  <img src="docs/popup-dark.png" alt="The settings popup, dark theme" width="300">
</p>

## Requirements

- Chrome, Edge, Brave or another Chromium browser, version 129 or newer
- A display running in HDR mode (on Windows: Settings > System > Display > Use HDR)
- A GPU with WebGPU support

Firefox is not supported: it has no HDR canvas output.

## Install

1. On this page click **Code > Download ZIP**, then unzip it. (Or clone the repository.)
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder, the one that contains `manifest.json`.
4. Play a video. An **HDR** badge appears in its top-right corner when the conversion is active.

To update, replace the folder's contents, click the reload arrow on the extension's card, and refresh any open video tabs.

## First-time setup: calibrate

The extension can't ask the browser how bright your display goes, so it has a calibration page.

1. Open the popup and click **Calibrate**.
2. Drag the slider right until the cross just disappears into the square.
3. Nudge it back until you can barely see the cross, then **Save**.

Until you calibrate, the extension assumes your display's maximum equals the **Peak brightness** slider. After calibrating, you can set Peak above your display's maximum and highlights will ease into it rather than clip.

If your monitor does its own tone mapping, the cross may never vanish completely. Pick the point where it becomes hard to see.

## Controls

### Picture

| Slider | Range | Default | What it does |
|---|---|---|---|
| Peak brightness | 1.5x to 12x | 4x | How bright the brightest highlights get, as a multiple of normal SDR white. |
| Reach | 0 to 100% | 50% | How far down the tonal range the brightening extends. Higher lifts more of the picture. |
| Shaping | Off to 100% | 50% | Gives big blown-out areas a gradient (dimmer rim, brighter middle) so they look like light instead of a flat patch. |
| Colour boost | Off to +50% | +15% | Extra saturation, reaching into the wider Display P3 gamut. Skin tones are mostly excluded. |
| Wide colour | Off to 100% | 50% | Stretches already-vivid colours out toward the edge of the P3 gamut. Muted colours, greys and skin stay put. |
| Colour lights | Off to 100% | 50% | Lets coloured highlights (neon, brake lights, fire) get a brightness boost closer to what white ones get. |
| Sharpness | Off to 100% | 35% | Contrast-adaptive sharpening. |

**Reset** restores the picture defaults.

### Per-site settings

When the popup is opened on a web page it shows that site's hostname with two switches:

- **Turn off here** disables the extension on that site only.
- **Unlock locked videos** is for sites where the popup reports a locked video; see the next section.
- **Own settings** gives the site its own copy of the picture sliders. With it off, the sliders change the settings for all sites.

Embedded players follow the page they're embedded in, not the player's own domain.

### Unlocking locked videos

On some sites nothing gets converted and the popup says "A video here is locked against reading". The video file is coming from a different server than the page, and that server hasn't said the page may read it. The browser will still play such a video, but refuses to hand its pixels to anything, this extension included.

Switching on **Unlock locked videos** for that site adds the missing permission to video the site loads, then reloads the video so it takes effect. Your place in the video, the speed and whether it was playing are kept. If the video won't load that way, it is put back as it was and stays unconverted.

What you are agreeing to when you switch it on: on that site, the page's own scripts gain the same ability to read the video that the extension gets. For a site you'd watch video on anyway that is rarely a concern, but it is why this is off by default and set per site. It affects video and audio requests made by that site's pages only, lasts until the browser is closed, and is removed as soon as you switch it off.

It does not work on DRM-protected video; nothing does.

### Other

- **Enabled** (top-right switch): master on/off for all sites.
- **Performance**: how hard the extension works your GPU.
  - *Auto* (default) starts at full quality and steps down if it measures frames being dropped: to 1440p rendering, then to 1080p with sharpening and debanding off. Steps that would change nothing on your screen are skipped. If the lowest level drops just as many frames as full quality did, the GPU was never the problem, so it goes back to full quality and stops adjusting. It starts afresh for each new video.
  - *Best quality* always renders at your screen's resolution with everything on.
  - *Fastest* always renders at 1080p with sharpening and debanding off.
- **Frame timing**: when the picture is redrawn.
  - *Each video frame* (default) draws once when the browser reports a new video frame. It is the least work.
  - *Every screen refresh* draws on every refresh of your display, whether or not the video has a new frame, so the overlay updates at one steady rhythm. It is there for stutter that only shows up in fullscreen, particularly with FreeSync or G-Sync on. It costs more GPU: on a 144 Hz display a 30 fps video is drawn almost five times as often. Whether it helps on a given setup is something to try; see Troubleshooting.
- **Split**: split view. Shows the original on the left and the HDR result on the right. Drag the line on the video to move it.
- **Badge**: shows or hides the HDR badge.
- **Stats**: turns the badge into a live readout that stays visible, so it can be read in fullscreen where the popup can't be opened. For example `HDR · 60 fps · 0% dropped · longest gap 18 ms · 3440x1440 · video timing`: new video frames drawn per second, the share of the video's frames that were never drawn, the longest wait between two frames, the size drawn at, and the frame timing in use. The numbers refresh about every three seconds and read "measuring" until the first clean stretch of playback.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+H | Turn HDR conversion on or off |
| Alt+Shift+S | Turn split view on or off |

Chrome may not assign these automatically when an unpacked extension is reloaded. Set or change them at `chrome://extensions/shortcuts`.

## What it won't convert

- **DRM-protected video** (Netflix, Disney+, Prime Video and similar). The browser does not let extensions read those frames.
- **Video that is already HDR.** It is detected and left alone. A switch between an SDR and an HDR stream in the middle of a video can take about five seconds to notice.
- **Locked video, unless you unlock it.** Some sites serve their video from another server that doesn't permit it to be read, and the browser then blocks reading its frames. The popup says when this is the case, and **Unlock locked videos** can usually get round it; see below.
- **Small videos** under 200 px wide, such as thumbnails and hover previews.
- **Pages that aren't served over HTTPS**, where WebGPU is unavailable.

## How it works

For each eligible `<video>`, the extension places a canvas exactly over it and redraws that canvas on every video frame. The canvas is a 16-bit float WebGPU surface in Display P3 with extended tone mapping, which is what lets pixel values above 1.0 show up brighter than SDR white.

Each frame goes through six shader passes:

1. **Analyse.** The frame is shrunk to 480x270, recording brightness, which pixels are highlights, and which are clipped (blown out).
2. **Shrink, three times,** down to 8x5. These small copies tell the main pass what the neighbourhood around each pixel looks like at several scales.
3. **Scene average.** One number for the whole frame's brightness, eased over about 0.7 seconds so the picture doesn't pump, and snapping faster on a scene cut.
4. **Convert.** The main pass, at full resolution. For every pixel it:
   - sharpens, backing off where there is already a strong edge;
   - debands, filling in the in-between shades that 8-bit video can't store, so smooth gradients don't show steps once stretched;
   - expands brightness. Shadows, midtones and skin are left alone; only the top of the range is pushed up. Small isolated highlights get the full peak, large bright areas get less than half, and bright scenes get less than dark ones;
   - shapes blown-out areas with a rim-to-centre gradient;
   - widens colour: vivid colours are stretched toward the P3 edge, and coloured lights get more of the brightness boost;
   - boosts colour, skipping skin tones;
   - rolls off anything brighter than the display can show.

### Performance

By default the extension draws each frame from the page's own scripting thread, when the browser tells it a new video frame is ready. (With **Frame timing** set to *Every screen refresh* it draws on each display refresh instead.) Two things can make it miss frames: the GPU not finishing in time (4K at 60 fps is a lot of pixels), or the page being too busy to run the callback at all. A missed frame shows as a stutter, because the overlay keeps showing the previous one.

To keep GPU cost down it never draws the picture with more pixels than the video has (unless Performance is set to Best quality), and Auto lowers the render resolution when it measures drops. The browser scales the smaller picture back up to fit.

The extension also keeps its background work light while a video plays: looking for new video players happens in the browser's idle time, and the check for an HDR stream happens every few seconds.

### Where a neural net would go

There is no ML in this extension. If you want to add some, `expansionGain()` in `shader.js` is the one function that decides how much brighter each pixel gets. A small network that outputs a per-pixel gain map can replace it: write the map to a texture in its own pass, bind it in the main pass, and return the sampled value from `expansionGain()`.

## Known limitations

- **Bright text baked into the video** (burned-in subtitles, logos) is toned down but still brighter than ideal. Captions drawn by the site itself, such as YouTube's, are not affected.
- **White-background content** such as screen recordings may show a visible gradient near the edges of white areas. Lower **Shaping** or turn it off for that site.
- **Skin protection is by colour**, so wood, sand and other skin-coloured things also miss out on the colour boost.
- **Blown-out detail stays lost.** The extension shapes clipped areas but cannot recover what was in them.
- **Native fullscreen.** When a site fullscreens the bare video element with the browser's built-in controls, the bottom strip of the picture shows the unconverted video while those controls are visible.
- **Closed shadow roots** are searched through an extension-only browser API; this path has had little testing.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| Video stutters | Open the popup while it plays. The line under the title shows the frame rate and the share of frames dropped; hover it for the render size and which GPU is in use. Try **Performance: Fastest**. On a laptop with two GPUs, Chrome on Windows uses one for everything, usually the integrated one: set Chrome to "High performance" in Windows graphics settings, or enable `chrome://flags/#force-high-performance-gpu`, and restart it. If the status line says "busy page", lowering quality made no difference: the page itself is keeping the extension from drawing on time, and a lower video resolution is the remaining option. |
| Stutter only in fullscreen | Switch on **Stats** and read the badge in fullscreen. If it shows frames being dropped or a long gap, the extension is falling behind there: try **Performance: Fastest**. If it shows 0% dropped and a gap close to one frame (17 ms at 60 fps, 42 ms at 24 fps), the extension is drawing every frame on time and the stutter comes from how the browser and display present them. Try **Frame timing: Every screen refresh**; if you use FreeSync or G-Sync, also try turning it off for your browser. This case is not fully understood yet, so reports with the stats line are welcome. |
| The popup says a video is locked | Switch on **Unlock locked videos** for that site. If it then says the video couldn't be unlocked, that site's server refuses, and the video can't be converted. |
| No HDR badge appears | HDR is off in your OS display settings, the video is DRM-protected or already HDR, or the extension is off for this site. The popup's status line reports a missing HDR display or WebGPU. |
| Picture looks washed out or far too bright | **Peak brightness** is above what your display can show and it hasn't been calibrated. Run **Calibrate**. |
| Faces look orange | Lower **Colour boost**. |
| Colours look neon or cartoonish | Lower **Wide colour** and **Colour lights**. |
| Halos or crunchy edges | Lower **Sharpness**, especially on low-bitrate video. |
| Shortcuts do nothing | Assign them at `chrome://extensions/shortcuts`. |
| Overlay is misaligned on one site | The site positions its video unusually. Use **Turn off here** for that site. |

Messages from the extension appear in the page's DevTools console, prefixed `[SDR to HDR]`.

## Permissions

- **Access to all sites**: the content script has to run on any page that might contain a video.
- **declarativeNetRequest**: used only by **Unlock locked videos**, and only on sites where you switch that on, to add the response headers that let a video be read.
- **storage**: saves your settings locally. Nothing is synced or sent anywhere.
- **activeTab**: lets the popup read the current tab's hostname for per-site settings.

The extension makes no network requests.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3). |
| `content.js` | Finds videos, manages the overlay canvas, badge and split handle, and runs the render loop. |
| `shader.js` | All WGSL shader code. |
| `background.js` | Handles the keyboard shortcuts, and the header rules for unlocking videos. |
| `popup.html`, `popup.js` | The settings popup. |
| `calibrate.html`, `calibrate.js` | The display calibration page. |
| `ui.css` | Shared styling for the popup and calibration page. |
| `icons/` | Extension icons, with their SVG sources. |
| `CHANGELOG.md` | What changed in each version. |
| `docs/` | Screenshots used in this README. |

## Testing status

The pipeline was verified numerically in headless Chromium with software rendering: synthetic test frames in, measured pixel values out, for every feature. It has been used on a real HDR display with an RX 9070 XT, but picture tuning on real footage is by eye and limited to that one setup. Other GPUs and displays may need different settings.

## License

[MIT](LICENSE)
