// Finds <video> elements, and for each one draws an HDR canvas on top of it.
// Frames go: video -> WebGPU external texture -> shaders -> rgba16float canvas
// with extended tone mapping (values above 1.0 light up the HDR headroom).
(() => {
  if (window.__sdr2hdrLoaded) return;
  window.__sdr2hdrLoaded = true;

  const DEFAULTS = { enabled: true, peak: 4, strength: 0.5, sat: 1.15, soften: 0.5, sharpen: 0.35, gamut: 0.5, vivid: 0.5,
    perf: 'auto',  // 'auto', 'best' or 'fast'
    upscale: 'auto',  // 'auto', 'off', 'fast' or 'best': how a video smaller than the screen is made bigger (see Session.upChoice)
    poll: true,        // look at the video on every screen refresh and draw when its frame has changed, not only when the browser says so (see Session.pump)
    split: false, splitPos: 0.5, badge: true,
    stats: false,  // show live numbers in the badge, for diagnosing stutter
    hideOriginal: true,  // make the original video invisible while the overlay covers it (see syncHide)
    pace: true,          // have the browser hand each redraw to Windows a few ms into the screen refresh (see pacer.js)
    cue: 'ping',         // the sound that says when to wiggle the mouse during the A/B test, or 'off' (see cue.js)
    method: 'shader',        // what decides the brightness: 'shader', 'model' (a model from HDR Trainer) or 'guided' (the shader, with the model saying where)
    splitLeft: 'original',   // what split view shows on each side of the line:
    splitRight: 'shader',    // 'original', 'shader', 'model' or 'guided'
    modelInfo: null,         // details of the loaded model; the model itself is stored under 'model'
    headroom: 0,   // display maximum from the calibration page; 0 = not calibrated
    sites: {},     // per-site overrides, keyed by hostname
  };
  const MIN_SIZE = 200;   // ignore thumbnails / tiny previews (CSS px)
  const MAX_DIM = 3840;   // cap canvas backing size
  // Performance levels. Auto starts at 0 and steps down if frames are being
  // dropped; each step shrinks the canvas we render to (the browser scales it
  // back up), and the last also skips sharpening and debanding.
  const LEVELS = [
    { maxDim: MAX_DIM, lite: false },
    { maxDim: 2560, lite: false },
    { maxDim: 1920, lite: true },
  ];
  // Auto doesn't wait to find out the hard way that a video is too much: it
  // starts at the highest level that keeps the pixels drawn per second under
  // this. 4K at 60 frames a second fits (498 million pixels a second), with
  // room for the frame rate being measured a little high; 4K at 120 doesn't,
  // and starts at 1440p. Where the GPU can be asked how long a frame's work
  // takes, that decides from then on (see perfTick): on a Radeon RX 9070 XT
  // it is under a millisecond at 4K, and a slower GPU finds its own level.
  const PIXEL_BUDGET = 560e6;
  // The 'best' upscaler is only worth its cost where the picture is made at
  // least this much bigger (the files' own rule for mpv is the same).
  const UP_BEST_FROM = 1.3;
  // Guided method, for a model that doesn't say (see Session.draw).
  const GUIDE_ROUGH = { lo: 0.15, hi: 0.9 };
  // What this page has found out about the upscaling networks: { tier, load }
  // = a video of this many pixels a second had to step down to this tier
  // (see Session.upPlan and perfTick).
  const upLearned = [];
  // The GPU taking longer than this to finish a frame means frames are
  // queuing up behind each other: it can't keep up.
  const BACKLOG_MS = 100;
  // The stuck screen queue, and what is done about it.
  //
  // With the extension off, a fullscreen video goes to the screen on a path
  // of its own and the browser hardly redraws the page. With it on, the
  // browser redraws the whole page for every frame, because the picture is
  // now a canvas on the page. A browser trace (Brave 154 on Windows, Radeon
  // RX 9070 XT, 4K 60 on YouTube) shows what goes wrong with that:
  //
  // Normally each redraw is handed to Windows in about 0.1 ms. But once one
  // is handed over late (the player's controls coming up, going fullscreen,
  // any hiccup), the next arrives while the last is still queued, and has to
  // wait for the next screen refresh: about 15 ms. (The browser draws the
  // page into a pair of buffers, one on screen and one being handed over;
  // there is no third for another to go into.) The browser then starts
  // the following redraw the moment that wait ends, so it waits too, and so
  // on: every redraw now takes a whole refresh, for as long as there is
  // something to draw every refresh. That wait happens on the one thread in
  // the browser's GPU process that also runs the video decoder and WebGPU.
  // They are left about 1.5 ms in every 16.7: decoding takes seven to twelve
  // frame times instead of three, frames are thrown away for being late, and
  // the player stalls. In the trace it lasted nine seconds and ended at the
  // first refresh in which the page happened to have nothing to redraw.
  //
  // So the cure is one whole refresh in which no redraw is handed over, and
  // a page can make one: hold its main thread, so that nothing it draws
  // (this canvas, the player's controls) reaches the browser. How long was
  // read off the same trace. While stuck, a frame of the page reaches the
  // browser's display side just after each refresh, one already waits there
  // to be drawn, and one is waiting to be handed over. For a refresh to pass
  // with no hand-over, two frames of the page in a row have to stay away,
  // and the next must not come before the third refresh after the hold
  // began: when the trouble ended by itself in the trace, the gap between
  // two frames of the page was 54 ms, three and a quarter refreshes. So the
  // hold is BEAT_HOLD refreshes. That is "holding a beat". It costs a
  // freeze of about four refreshes and three frames of the video, once.
  // (0.10.4 held for 2.3 refreshes: one short. The page's next frame then
  // arrived in the middle of the refresh that had to stay empty, and the
  // queue was stuck again at once; six of seven first beats did nothing.)
  //
  // A second trace, of 0.10.5, showed the beat doing its part every time:
  // the first redraw after it was handed over in 0.1 ms. But six times in
  // ten the queue was stuck again a tenth of a second later, after one
  // hand-over that took 66 ms, four refreshes. That comes two or three
  // redraws after the hold, as the decoder, free again, works through what
  // it had fallen behind on. So a beat is never held alone: every other
  // frame of the video is let go by from the same moment, which leaves
  // every other refresh empty, and a queue that fills again empties again
  // by itself. In that trace the beats held while every other frame was
  // being taken were the ones that lasted.
  //
  // The signs it goes by: a copy handed to the GPU more than BEAT_AGE frame
  // times ago and still not done although the GPU has little to do (in good
  // running that takes one or two); or copies taking well over twice as long
  // as usual while the decoder takes five frame times over a frame; or the
  // decoder in trouble (below). In the second trace the queue got stuck by
  // itself four times with nothing unusual before it, each time on a redraw
  // handed over 0.8 ms after a screen refresh like the hundreds before it,
  // and the decoder's signs took 0.4 to 0.5 s to show. A beat is judged
  // BEAT_GRACE later, and another held if it didn't clear things. After
  // BEAT_TRIES beats in a row that changed nothing, beats are left off for a
  // while, longer each time: whatever is wrong is something else.
  //
  // The decoder's own signs: how long it says each frame took it (normally
  // about three frame times at 60 a second; EASE_SLOW frame times on
  // average and twice what is usual for this video, or EASE_FAST for a
  // single frame, means trouble if frames are being lost too), and how many
  // frames it is throwing away (EASE_DROPS in 0.6 s). Taking every other
  // frame stays until the decoder has been well for EASE_DWELL (twice as
  // long each time full rate turns out to have been too soon); if it has
  // not been well for a single moment in EASE_GIVE_UP, it is given up and
  // tried again a little later.
  //
  // All of that is the cure. Since 0.10.10 there is also an attempt at
  // keeping it from happening, and a way of seeing it directly: both are in
  // pacer.js.
  const BEAT_AGE = 5;
  const BEAT_HOLD = 3.3;
  const BEAT_GRACE = 700;
  const BEAT_TRIES = 3;
  const DIRECT_MS = 250;
  const EASE_SLOW = 4;
  const EASE_FAST = 6;
  const EASE_DROPS = 4;
  const EASE_DWELL = 600;
  const EASE_MOUSE = 3500;
  const EASE_MOUSE_MAX = 60000;     // ... but not for longer than this, once the decoder has been well throughout
  const EASE_GIVE_UP = 8000;
  const REST_MS = 150;
  const FMT = 'rgba16float';

  // Per-site settings follow the top-level page, so an embedded player uses
  // the settings of the site you're actually on.
  const SITE = (() => {
    try {
      const ao = location.ancestorOrigins;
      return new URL(ao && ao.length ? ao[ao.length - 1] : location.href).hostname;
    } catch {
      return location.hostname;
    }
  })();

  let stored = { ...DEFAULTS };     // exactly what's in storage
  let settings = { ...DEFAULTS };   // stored + this site's overrides
  let siteOff = false;
  let siteUnlock = false;          // this site's "unlock locked videos" switch
  let lastPointer = 0;
  const mouseLog = [];             // [when, pacing on] each time the mouse started moving
  let gpuPromise = null;
  let gpuFailed = false;
  let gpuError = '';
  let gpuTries = 0;
  const sessions = new Map();      // video -> Session
  const probes = new Map();        // video -> Probe: videos measured without being converted (Stats on)
  // Videos we've given up on: video -> { src, until, tries }. A video the
  // browser won't let us read is given up on until its source changes. Any
  // other failure might be a passing one (the site switching streams), so
  // it's tried again a few seconds later, a handful of times.
  const blocked = new WeakMap();
  const isBlocked = (v) => {
    const b = blocked.get(v);
    return !!b && b.src === v.currentSrc && performance.now() < b.until;
  };
  const lastWhy = new WeakMap();   // video -> the last reason noted for not converting it
  const locked = new Set();        // videos the browser won't let us read (see tryUnlock)
  const unlockTried = new WeakMap();   // video -> currentSrc we've already tried to unlock
  const hdrDisplay = matchMedia('(dynamic-range: high)');

  // Everything worth knowing goes two places: the page's console, and a short
  // history kept in memory that the popup's Report button copies out. The
  // history is what answers "why didn't it convert this video?".
  const events = [];
  function note(text) {
    const last = events[events.length - 1];
    if (last && last.text === text) { last.n++; last.t = Date.now(); return; }
    events.push({ t: Date.now(), text, n: 1 });
    if (events.length > 150) events.shift();
  }
  const log = (...a) => { console.info('[Headroom HDR]', ...a); note(a.join(' ')); };

  // Short names for videos in the history: "video 1", "video 2", ...
  const videoIds = new WeakMap();
  let videoCount = 0;
  const nameOf = (v) => {
    if (!videoIds.has(v)) videoIds.set(v, ++videoCount);
    return `video ${videoIds.get(v)}`;
  };

  // Total time the page's own thread has spent stuck in long tasks (anything
  // over 50 ms: the page's scripts, layout, and so on). The overlay is drawn
  // from that thread, so while it's stuck the overlay can't update. Kept for
  // the diagnostic report.
  let longTotal = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTotal += e.duration;
    }).observe({ type: 'longtask', buffered: false });
  } catch {}

  // A second measure of the same thing, which also catches a page kept busy by
  // many shorter tasks: a timer that should fire every 100 ms, and how late
  // its latest firing was. Only runs while a video is being converted.
  let lagMax = 0;
  let lagTimer = 0;
  let lagDue = 0;
  let lagHidden = false;
  function watchLag(on) {
    if (on && !lagTimer) {
      lagDue = performance.now() + 100;
      lagTimer = setInterval(() => {
        const t = performance.now();
        // Timers are slowed right down in a hidden tab, so those firings (and
        // the first one after coming back) say nothing.
        if (document.hidden) lagHidden = true;
        else if (lagHidden) lagHidden = false;
        else lagMax = Math.max(lagMax, t - lagDue);
        lagDue = t + 100;
      }, 100);
    } else if (!on && lagTimer) {
      clearInterval(lagTimer);
      lagTimer = 0;
    }
  }

  async function initGpu() {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this page');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    // With this the GPU itself can be asked how long a frame's work took,
    // which the report uses (Stats on). Not every browser offers it.
    const canTime = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice(canTime ? { requiredFeatures: ['timestamp-query'] } : {});
    device.addEventListener('uncapturederror', (e) => log('GPU error:', e.error.message));
    // Which GPU the browser gave us. On laptops with two GPUs, Chrome on
    // Windows uses one for everything, usually the integrated one, so this
    // is the first thing to check when 4K playback stutters.
    const info = adapter.info || {};
    const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown';
    log('rendering on GPU:', name);

    const make = (code, vsEntry, format = FMT) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: vsEntry },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-strip' },
      });
    };
    const [copy, down1, down, scene, main, up] = await Promise.all([
      make(SDR2HDR_COPY, 'vsFull', SDR2HDR_FRAME_FORMAT),
      make(SDR2HDR_DOWN1, 'vsFull'),
      make(SDR2HDR_DOWN, 'vsFull'),
      make(SDR2HDR_SCENE, 'vsFull'),
      make(SDR2HDR_MAIN, 'vs'),
      make(SDR2HDR_UP, 'vsFull', SDR2HDR_FRAME_FORMAT),
    ]);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    device.lost.then((info) => {
      log('GPU device lost:', info.message);
      gpuPromise = null;
      modelLoading = modelFailed = null;
      for (const s of [...sessions.values()]) s.destroy('the GPU device was lost');
    });
    return { device, sampler, copy, down1, down, scene, main, up, name, canTime };
  }

  // ---- Upscaling network ----------------------------------------------------
  //
  // The 'best' upscaler's pipelines (see upnet.js), made the first time a
  // video wants them and kept on the GPU (gpu.nets) for every video on the
  // page. Until one is ready, and if it can't be made, 'fast' draws instead.
  function ensureNet(gpu, key) {
    const nets = gpu.nets || (gpu.nets = {});
    if (nets[key]) return nets[key].ready ? nets[key] : null;
    const net = nets[key] = { ready: false, failed: null };
    const name = SDR2HDR_UPNETS.find((n) => n.key === key).name;
    (async () => {
      const got = await chrome.runtime.sendMessage({ type: 'sdr2hdr-upnet', key });
      if (!got || !got.ok) throw new Error(got ? got.error : 'no answer from the extension');
      Object.assign(net, await sdr2hdrBuildUpnet(gpu.device, got.text));
      net.ready = true;
      log(`upscaling network ready: ${name} (${net.passes.length} passes)`);
      for (const s of sessions.values()) { s.needsDraw = true; s.layout(); }
    })().catch((e) => {
      net.failed = String(e.message || e);
      log(`could not set up the upscaling network ${name}, using Fast instead:`, net.failed);
    });
    return null;
  }

  // ---- Trained model -------------------------------------------------------
  //
  // The model file is large next to the other settings, so it is only read
  // from storage when something is going to use it, and then kept on the GPU
  // (gpu.model) for every video on the page.
  let modelLoading = null;   // id of the model being loaded
  let modelFailed = null;    // id of a model that wouldn't load, so it isn't retried every second

  // What each side of the picture shows, as [left, right]. With split view
  // off both are the chosen method.
  const sidesWanted = () => (settings.split ? [settings.splitLeft, settings.splitRight] : [settings.method, settings.method]);
  const modelWanted = () => !!settings.modelInfo && sidesWanted().some((s) => s === 'model' || s === 'guided');

  async function ensureModel(gpu) {
    const info = settings.modelInfo;
    if (!info || (gpu.model && gpu.model.id === info.id) || modelLoading === info.id || modelFailed === info.id) return;
    modelLoading = info.id;
    try {
      const got = await new Promise((resolve) => chrome.storage.local.get({ model: null }, resolve));
      if (!got.model) throw new Error('no model is stored');
      const built = await sdr2hdrBuildModel(gpu.device, gpu.sampler, got.model);
      built.id = info.id;
      const old = gpu.model;
      gpu.model = built;
      for (const s of sessions.values()) s.dropRun();
      if (old) old.destroy();
      log(`model loaded (${built.info.params} weights)`);
    } catch (e) {
      modelFailed = info.id;
      log('could not load the model, using the shader instead:', e.message);
    }
    modelLoading = null;
    for (const s of sessions.values()) { s.updateBadge(); s.render(); }
  }

  function getGpu() {
    if (!gpuPromise) {
      gpuPromise = initGpu().then((gpu) => { gpuTries = 0; return gpu; }, (e) => {
        // Starting the GPU can fail for a passing reason (the browser's GPU
        // process restarting), so try again later: after 5 s, then 10, 20,
        // up to a minute apart.
        gpuFailed = true;
        gpuError = e.message;
        gpuPromise = null;
        if (!navigator.gpu) {
          // Not a passing fault: the page has no WebGPU at all (it isn't
          // served over HTTPS, or the browser has it switched off).
          log('WebGPU is not available on this page, so nothing here can be converted');
          throw e;
        }
        const wait = Math.min(60, 5 * 2 ** gpuTries++);
        log(`WebGPU could not start (${e.message}); trying again in ${wait} s`);
        setTimeout(() => { gpuFailed = false; }, wait * 1000);
        throw e;
      });
    }
    return gpuPromise;
  }

  // True if the video is already HDR (PQ / HLG), in which case we leave it alone.
  // Looking means grabbing a frame, so the answer is remembered for a few
  // seconds per video; a new source or a change of resolution (a quality
  // switch) asks again straight away.
  const HDR_RECHECK_MS = 5000;
  const hdrSeen = new WeakMap();   // video -> { key, at, hdr }
  function isHdrSource(video) {
    const key = `${video.currentSrc}|${video.videoWidth}x${video.videoHeight}`;
    const now = performance.now();
    const seen = hdrSeen.get(video);
    if (seen && seen.key === key && now - seen.at < HDR_RECHECK_MS) return seen.hdr;
    let hdr;
    try {
      const f = new VideoFrame(video);
      const t = f.colorSpace && f.colorSpace.transfer;
      f.close();
      hdr = t === 'pq' || t === 'hlg';
    } catch {
      return false;                // no frame to look at yet: not an answer, so don't remember it
    }
    hdrSeen.set(video, { key, at: now, hdr });
    return hdr;
  }

  // Why a video is not being converted, in words, or '' if it should be.
  // starting: also apply the checks that only matter before conversion
  // starts. This is the one place that decides, and its answers are what the
  // report shows.
  function whyNot(v, starting) {
    if (!settings.enabled) return 'the extension is switched off';
    if (siteOff) return 'the extension is switched off for this site';
    if (!hdrDisplay.matches) return 'the browser says this display is not in HDR mode';
    if (gpuFailed) return `WebGPU could not start (${gpuError})`;
    if (!v.isConnected) return 'it was removed from the page';
    if (!v.videoWidth) return 'it has no picture yet';
    if (v.offsetWidth < MIN_SIZE) return `it is too small on the page (${v.offsetWidth} px wide; the minimum is ${MIN_SIZE})`;
    if (v.mediaKeys) return 'it is DRM-protected, so its frames cannot be read';
    if (isBlocked(v)) {
      const b = blocked.get(v);
      return b.until === Infinity
        ? `${b.what}: ${b.error}`
        : `${b.what} just now (${b.error}); trying again shortly`;
    }
    if (starting && document.hidden) return 'the tab is hidden';
    // readyState 2 = there is a current frame, which the HDR check needs:
    // without one it can't tell, and would wave an HDR video through.
    if (starting && v.readyState < 2) return `it has no frame ready yet (ready state ${v.readyState})`;
    if (isHdrSource(v)) return 'the video is already HDR';
    return '';
  }

  // Write a line in the history when a video's situation changes.
  function noteWhy(v, why) {
    if (lastWhy.get(v) === why) return;
    lastWhy.set(v, why);
    note(why ? `${nameOf(v)} (${v.videoWidth}x${v.videoHeight}): not converting, because ${why}` : `${nameOf(v)}: nothing in the way of converting it`);
  }

  // Small "HDR" pill for the top-right corner. Built node by node (no
  // innerHTML) so it works on sites that enforce Trusted Types.
  function makeBadge() {
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElement('div');
    el.dataset.sdr2hdr = 'badge';
    el.style.cssText =
      'position:absolute;pointer-events:none;display:flex;align-items:center;gap:5px;' +
      'padding:5px 10px 5px 8px;border-radius:999px;color:#fff;' +
      // No frosted glass (backdrop-filter) on anything drawn over the video:
      // it makes the browser re-filter the picture behind it on every frame.
      'background:rgba(40,32,70,.55);border:1px solid rgba(255,255,255,.32);' +
      'box-shadow:0 4px 14px rgba(30,20,60,.28),inset 0 1px 0 rgba(255,255,255,.28);' +
      'text-shadow:0 1px 2px rgba(30,20,60,.5);box-sizing:border-box;' +
      'font:700 11px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.08em;white-space:nowrap;' +
      'transform:translateX(-100%);transition:opacity .6s;opacity:.95;';

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    const sun = document.createElementNS(NS, 'circle');
    sun.setAttribute('cx', '8'); sun.setAttribute('cy', '8'); sun.setAttribute('r', '3');
    sun.setAttribute('fill', '#ffd9a8');
    const rays = document.createElementNS(NS, 'path');
    rays.setAttribute('d',
      'M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15M3.05 3.05l1.55 1.55M11.4 11.4l1.55 1.55' +
      'M3.05 12.95l1.55-1.55M11.4 4.6l1.55-1.55');
    rays.setAttribute('stroke', '#ffc4dd');
    rays.setAttribute('stroke-width', '1.4');
    rays.setAttribute('stroke-linecap', 'round');
    rays.setAttribute('fill', 'none');
    svg.append(sun, rays);

    const text = document.createElement('span');
    text.textContent = 'HDR';
    el.append(svg, text);
    el.label = text;
    return el;
  }

  // Round grab handle shown on the split line.
  function makeKnob() {
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElement('div');
    el.dataset.sdr2hdr = 'knob';
    el.style.cssText =
      'position:absolute;pointer-events:none;display:none;align-items:center;justify-content:center;' +
      'width:30px;height:30px;border-radius:50%;box-sizing:border-box;' +
      'background:rgba(255,255,255,.82);border:1px solid rgba(255,255,255,.9);' +
      'box-shadow:0 4px 14px rgba(30,20,60,.35),inset 0 1px 0 #fff;transform:translate(-50%,-50%);';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    const arrows = document.createElementNS(NS, 'path');
    arrows.setAttribute('d', 'M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5');
    arrows.setAttribute('stroke', '#5b4f8a');
    arrows.setAttribute('stroke-width', '1.8');
    arrows.setAttribute('stroke-linecap', 'round');
    arrows.setAttribute('stroke-linejoin', 'round');
    arrows.setAttribute('fill', 'none');
    svg.append(arrows);
    el.append(svg);
    return el;
  }

  // What a video being converted and one that is only being watched have in
  // common: counting its frames, the three-second measurement windows, and
  // the hitch log (see diag.js).
  class Meter {
    initMeter() {
      const video = this.video;
      this.born = performance.now();
      this.lastPresented = null;  // the browser's running count of frames presented
      this.history = [];          // one line per measurement window, for the diagnostic report
      this.frameAt = 0;           // when the last new video frame was drawn
      this.srcFps = 0;            // the video's own frame rate, once known
      this.mediaAt = null;        // media time of the last frame seen
      this.gaps = [];             // the first few gaps between frames, for working out srcFps
      this.hitches = new Sdr2hdrHitches(this.born);
      this.hitches.mark(markLabel(this));
      this.win = this.newWindow(this.born, true);   // first window is warm-up

      this.onDisturb = (e) => {
        this.win.dirty = true;
        this.win.ev[e.type] = (this.win.ev[e.type] || 0) + 1;
        this.hitches.event(e.type);
        if (e.type === 'pause') setTimeout(() => saveRuns(true), 300);
      };
      this.disturbances = ['pause', 'play', 'seeking', 'waiting', 'ratechange', 'loadedmetadata'];
      for (const e of this.disturbances) video.addEventListener(e, this.onDisturb);
      // A change of resolution (the site switching quality). Noted for the
      // report; it doesn't spoil a measurement.
      this.onResize = () => { this.win.ev.resize = (this.win.ev.resize || 0) + 1; };
      video.addEventListener('resize', this.onResize);
      document.addEventListener('visibilitychange', this.onDisturb);
    }

    stopMeter() {
      if (this.onDisturb) {
        for (const e of this.disturbances) this.video.removeEventListener(e, this.onDisturb);
        document.removeEventListener('visibilitychange', this.onDisturb);
      }
      if (this.onResize) this.video.removeEventListener('resize', this.onResize);
    }

    // The browser has handed over a new frame of the video.
    noteFrame(now, meta) {
      this.noteFrameTime(meta.mediaTime);
      // The first frame we hear about sets where counting starts.
      if (this.win.p0 == null) this.win.p0 = meta.presentedFrames - 1;
      this.lastPresented = meta.presentedFrames;
      // How long after the frame went on screen we got to hear about it.
      this.win.late = Math.max(this.win.late, performance.now() - meta.expectedDisplayTime);
      if (Number.isFinite(meta.processingDuration)) this.win.proc = Math.max(this.win.proc, meta.processingDuration * 1000);
      this.frameSeen(now, meta);
    }

    // A frame for the hitch log.
    frameSeen(now, meta) {
      this.hitches.frame(now, meta, this.video, this.srcFps);
    }

    // The video's frame rate became known, or turned out different.
    rateChanged() {}

    // The size the picture is drawn at, for the report.
    drawnSize() { return '-'; }

    // A new video frame has just been drawn: count it, and keep the longest
    // wait between two of them.
    countFrame() {
      const t = performance.now(), w = this.win;
      w.rendered++;
      if (this.frameAt) w.gap = Math.max(w.gap, t - this.frameAt);
      this.frameAt = t;
    }

    // A fresh measurement window, starting from the browser's running counts
    // as they stand now.
    newWindow(t, dirty) {
      const v = this.video;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      lagMax = 0;
      return {
        t0: t, rendered: 0, gap: 0, dirty,
        p0: this.lastPresented,                 // frames presented so far (null until the first one is seen)
        q0: q ? q.totalVideoFrames : 0,         // frames the decoder has produced so far
        d0: q ? q.droppedVideoFrames : 0,       // ... and how many of those it dropped
        long0: longTotal, late: 0, draw: 0, gpu: -1, proc: 0, ev: {},
      };
    }

    // Common frame rates. A measured rate within 7% of one of these is taken
    // to be the nearest, so wobbles in the measurement can't flip a decision.
    // The margin has to be that wide: YouTube's timestamps are in whole
    // milliseconds, so a 60 fps video's frames are 16 or 17 ms apart, and 16
    // reads as 62.5.
    static snapFps(f) {
      let best = 0;
      for (const std of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]) {
        if (Math.abs(f / std - 1) < Math.abs(f / (best || 1e-9) - 1)) best = std;
      }
      return Math.abs(f / best - 1) < 0.07 ? best : Math.round(f);
    }

    // Work out the video's frame rate from the timestamps of its first few
    // frames. The second-smallest gap is used: frames that were skipped make
    // gaps too long, never too short.
    noteFrameTime(mediaTime) {
      if (this.srcFps) return;
      if (this.mediaAt != null) {
        const d = mediaTime - this.mediaAt;
        if (d > 0.004 && d < 0.25) this.gaps.push(d);
      }
      this.mediaAt = mediaTime;
      if (this.gaps.length >= 9) {
        this.srcFps = Meter.snapFps(1 / [...this.gaps].sort((x, y) => x - y)[1]);
        this.rateChanged();
      }
    }

    // Close the current three-second window: add a line to the history and
    // return the numbers, or null if it's too soon or the window says nothing
    // about performance.
    //
    // "Frames we should have drawn" is the larger of two counts the browser
    // keeps: frames it presented, and frames the decoder produced. This runs
    // from the once-a-second scan rather than from the frame callback, so it
    // still runs when callbacks have all but stopped.
    measure() {
      const v = this.video, w = this.win, t = performance.now();
      if (t - w.t0 < 3000) return null;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const decoded = q ? q.totalVideoFrames : 0;
      const presented = w.p0 == null || this.lastPresented == null ? 0 : this.lastPresented - w.p0;
      const expected = Math.max(presented, decoded - w.q0, w.rendered);
      // A window with a pause, seek, buffering or a hidden tab in it says
      // nothing about performance, so it's thrown away. So is anything played
      // faster than normal speed, where skipping frames is expected.
      const clean = !w.dirty && !v.paused && !v.seeking && !document.hidden && v.playbackRate <= 1;
      const decoderDropped = q ? q.droppedVideoFrames : 0;
      // Include a firing that's overdue right now: after a long stall this
      // check can run before the timer gets its turn.
      const lag = Math.max(lagMax, lagTimer && !document.hidden && !lagHidden ? t - lagDue : 0);
      this.win = this.newWindow(t, false);

      const drop = expected > 0 ? 1 - w.rendered / expected : 0;
      const fps = w.rendered / ((t - w.t0) / 1000);
      const busy = (longTotal - w.long0) / (t - w.t0);
      // Keep a line for the report, whether or not the window was clean.
      let ahead = 0;
      try {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime;
        }
      } catch {}
      // A paused video with nothing going on gets no line.
      if (!(v.paused && !w.rendered && !Object.keys(w.ev).length)) this.history.push({
        at: (t - this.born) / 1000, pos: v.currentTime, fps, expected, drop, gap: w.gap,
        late: w.late, draw: w.draw, gpu: w.gpu, busy, lag, proc: w.proc,
        decoderDrop: decoderDropped - w.d0, ahead,
        video: `${v.videoWidth}x${v.videoHeight}`, canvas: this.drawnSize(), full: !!document.fullscreenElement,
        ev: Object.entries(w.ev).map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(' ') + (v.paused ? ' (paused)' : ''),
      });
      if (this.history.length > 100) this.history.shift();
      if (!clean || expected < 30) return null;

      // The decoder's count is the better measure of the video's frame rate
      // (it includes frames that were never shown).
      const produced = (decoded - w.q0) / ((t - w.t0) / 1000);
      // A rate already known is only changed when two windows running say
      // the same: a decoder catching up after a stall counts more than there are.
      if (produced > 5 && Math.abs(produced / (this.srcFps || 1e-9) - 1) > 0.1) {
        const f = Meter.snapFps(produced);
        if (!this.srcFps || this.fpsVote === f) { this.srcFps = f; this.fpsVote = 0; this.rateChanged(); }
        else this.fpsVote = f;
      } else this.fpsVote = 0;
      return { t, w, drop, fps, busy, lag };
    }

    // The measurement windows as lines of a table, then the hitch log.
    rows() {
      const n = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');
      const cell = (s, w) => String(s).padStart(w);
      const lines = ['  time    pos  fps  drop    gap   late   draw    gpu   proc  busy    lag  dec  ahead  video      drawn      fs  events'];
      for (const h of this.history) {
        lines.push([
          cell(n(h.at) + 's', 6), cell(n(h.pos) + 's', 6), cell(n(h.fps), 4), cell(n(h.drop * 100) + '%', 5),
          cell(n(h.gap), 6), cell(n(h.late), 6), cell(h.canvas === '-' ? '-' : n(h.draw, 1), 6), cell(h.gpu < 0 ? '-' : n(h.gpu), 6), cell(h.proc ? n(h.proc) : '-', 6),
          cell(n(h.busy * 100) + '%', 5), cell(n(h.lag), 6), cell(h.decoderDrop, 4), cell(n(h.ahead) + 's', 6),
          ' ' + h.video.padEnd(10), h.canvas.padEnd(10), h.full ? 'y ' : 'n ', h.ev,
        ].join(' '));
      }
      if (!this.history.length) lines.push('  (nothing measured yet: play the video for a few seconds first)');
      return [...lines, '', ...this.hitches.report()];
    }
  }

  class Session extends Meter {
    // Setting up can fail part-way (the GPU refusing something, the page
    // changing under us). Whatever was already put on the page is then taken
    // off again, and the video is left alone for a few seconds before another
    // try, with the reason in the history.
    constructor(video, gpu) {
      super();
      this.video = video;
      this.gpu = gpu;
      this.dead = false;
      try {
        this.start(video, gpu);
      } catch (e) {
        log(`could not start converting ${nameOf(video)}: ${e.name}: ${e.message}`);
        this.block(`${e.name}: ${e.message}`, false, 'converting it could not be started');
      }
    }

    start(video, gpu) {
      this.reset = true;        // snap the scene average on the first frame
      this.box = null;          // last laid-out size: { w, h, sx, sy }
      this.needsDraw = false;   // canvas was resized and hasn't been redrawn at the new size yet
      this.resetAuto();
      this.initMeter();
      this.failAt = 0;          // when reading the video's frame started failing, if it is
      this.submits = 0;
      this.raf = 0;
      this.slots = null;        // copies of video frames as ordinary textures (see ensureFrame)
      this.queue = [];          // copies waiting to be put on screen, oldest first
      this.cur = null;          // the copy on screen
      this.seenTs = null;       // timestamp of the video frame last copied
      this.held = 0;            // frames of the video handed to the GPU and not yet finished with
      this.heldSeen = new Array(9).fill(0);   // how many were waiting each time a frame was taken (8 = eight or more)
      // Easing off for the decoder (see EASE_SLOW).
      this.ease = { half: false, at: 0, fullAt: -1e9, okSince: 0, okSeen: false, dwell: EASE_DWELL, rested: false, offUntil: 0, fails: 0, worked: false, now: null };
      this.procBase = 0;        // what the decoder usually takes over a frame of this video (ms)
      this.steerAt = 0;         // when steer last ran
      this.tickMs = 0;          // the screen's refresh interval, as steer sees it (ms)
      this.tickGaps = [];
      this.eases = [];          // each time that was done, for the report
      // Holding a beat for the screen queue (see BEAT_AGE).
      this.beat = { at: -1e9, fails: 0, offUntil: 0, now: null, due: false };
      this.beats = [];          // each beat, for the report
      this.copies = [];         // when each copy still waiting on the GPU was handed over
      // What happened with pacing on [1] and off [0] (see pacer.js), for the report.
      this.paceFits = false;    // this video has frames enough to be paced (see pace)
      this.paceMs = [0, 0];     // time playing
      this.paceBeats = [0, 0];  // beats held
      this.paceDrops = [0, 0];  // frames the decoder dropped
      this.dropSeen = -1;       // the decoder's count of dropped frames at the last refresh
      this.gpuUsual = 0;        // how long the GPU usually takes to finish a copy (ms)
      this.gpuRecent = [];
      this.gpuCount = 0;
      this.gpuAt = 0;           // when the GPU last finished a copy
      this.restUntil = 0;       // no frames are taken until then
      this.dropLog = [];        // the decoder's count of dropped frames over the last moments
      this.procNow = NaN;       // how long the decoder is taking over a frame at the moment (ms)
      this.procLast = NaN;      // how long it took over the latest frame (ms)
      this.procAt = 0;          // when that was heard
      this.recentWork = [];     // the last few timings of a frame's work on the GPU (ms)
      this.covers = false;      // the overlay is on the page and has a size
      this.hidden = null;       // set while the original video is made invisible (see syncHide)
      this.drawnOk = false;     // the last attempt to draw a frame worked
      this.run = null;          // this video's copy of the model's working memory (see model.js)
      this.netAt = 0;           // when the model last ran
      this.stats = null;
      this.top = false;         // true while living in the top layer (see setTopLayer)
      this.pop = null;
      this.clip = '';
      this.last = performance.now();
      this.scale = [1, 1];
      const { device, sampler } = gpu;

      const canvas = (this.canvas = document.createElement('canvas'));
      canvas.dataset.sdr2hdr = 'canvas';
      canvas.style.cssText =
        'position:absolute;pointer-events:none;margin:0;padding:0;border:0;display:block;';
      video.insertAdjacentElement('afterend', canvas);

      this.badge = makeBadge();
      canvas.insertAdjacentElement('afterend', this.badge);
      this.badgeTimer = setTimeout(() => { this.badgeDim = true; this.updateBadge(); }, 3000);

      this.knob = makeKnob();
      this.badge.insertAdjacentElement('afterend', this.knob);

      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({
        device,
        format: FMT,
        colorSpace: 'display-p3',
        toneMapping: { mode: 'extended' },
        alphaMode: 'opaque',
      });

      // Analysis textures: four shrinking levels plus a 1x1 scene average
      // that ping-pongs between two textures so it can blend with last frame.
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const tex = (w, h) => device.createTexture({ size: [w, h], format: FMT, usage });
      this.textures = [...SDR2HDR_LEVELS.map(([w, h]) => tex(w, h)), tex(1, 1), tex(1, 1)];
      const views = this.textures.map((t) => t.createView());
      const n = SDR2HDR_LEVELS.length;
      this.lv = views.slice(0, n);
      this.sv = views.slice(n);
      this.si = 0;              // which scene texture holds the current value
      // Where the model writes its brightness curves. Always exists, because
      // the main pass is always given it; it's only read when a model is in use.
      this.curves = device.createTexture({
        size: SDR2HDR_MODEL_MAP, format: FMT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.textures.push(this.curves);
      this.curvesView = this.curves.createView();
      this.updateBadge();

      this.udata = new Float32Array(24);
      this.sdata = new Float32Array(4);
      const ub = (data) => device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.ubuf = ub(this.udata);
      this.sbuf = ub(this.sdata);

      const group = (pipeline, resources) => device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
      this.group = group;
      // bgDown[i] shrinks level i into level i + 1.
      this.bgDown = this.lv.slice(0, -1).map((view) => group(gpu.down, [sampler, view]));
      // bgScene[i] reads the previous value from scene texture i.
      this.bgScene = [0, 1].map((i) =>
        group(gpu.scene, [this.lv[2], this.sv[i], { buffer: this.sbuf }]));

      this.ro = new ResizeObserver(() => { this.layout(); this.render(); });
      this.ro.observe(video);

      this.onMeta = () => { this.reset = true; this.resetAuto(); this.ease.offUntil = 0; this.ease.fails = 0; this.beat.offUntil = 0; this.beat.fails = 0; this.procBase = 0; this.layout(); };
      // After a seek, draw the new frame even if the browser doesn't announce
      // it (a paused video may not).
      this.onSeek = () => { this.reset = true; this.queue.length = 0; setTimeout(() => this.render(), 60); };
      video.addEventListener('loadedmetadata', this.onMeta);
      video.addEventListener('seeked', this.onSeek);
      // Pausing stops the loop that draws, with the last frame or two still
      // waiting their turn: draw the frame the video actually stopped on.
      this.onPaused = () => { this.queue.length = 0; setTimeout(() => { if (!this.dead && this.video.paused) this.render(); }, 60); };
      video.addEventListener('pause', this.onPaused);
      // When to draw. The browser offers a callback for each new frame of a
      // video, and drawing used to hang on that alone. But the callback can
      // come a screen refresh late, and by then the frame it was about has
      // been replaced by the next. Measured with the original hidden: up to
      // one frame in three lost that way for seconds at a time, though the
      // browser had shown every one. So while the video plays, it is looked
      // at on every screen refresh: a frame not seen before is copied into a
      // short queue, and the oldest in the queue is put on screen. One per
      // refresh, in order, so a frame that turns up a moment late still gets
      // its turn. The callback is kept for what it reports about each frame,
      // and it does the drawing when the loop isn't running (a paused video
      // that is seeked, or "Every refresh" switched off).
      // Both ask for their next call before doing anything else, so a fault
      // while drawing one frame can't stop the frames after it.
      this.polling = false;     // the video's current frame can be told apart (see grab)
      this.onFrame = (now, meta) => {
        if (this.dead) return;
        this.video.requestVideoFrameCallback(this.onFrame);
        if (meta) this.noteFrame(now, meta);
        if (!(this.raf && this.polling)) this.pump(now);
      };
      this.onTick = (now) => {
        this.raf = 0;
        if (this.dead || !settings.poll || this.video.paused) return;
        this.raf = requestAnimationFrame(this.onTick);
        this.pace(now);
        this.steer();
        // A beat is held before the video is looked at, so that what is drawn
        // after it is the frame the video is showing then.
        if (this.beat.due) { this.holdBeat(); now = performance.now(); }
        this.check();
        if (!this.polling) return;             // frames can't be told apart: the callback draws
        this.presentNext(now);
        // The video moves to its next frame at about the moment this runs,
        // sometimes just before and sometimes just after. A second look half
        // a refresh later catches a frame that arrived just after; it waits
        // in the queue for the next refresh. Without it that frame would be
        // replaced before it was ever seen. (Not needed on a fast display.)
        const dt = now - (this.tickAt || 0);
        this.tickAt = now;
        if (dt > 11 && dt < 50 && !this.mid) {
          this.mid = setTimeout(() => { this.mid = 0; if (this.raf) this.check(); }, dt * 0.45);
        }
      };
      this.onPlaying = () => this.syncLoop();
      video.addEventListener('playing', this.onPlaying);

      this.layout();
      this.render();
      if (!this.dead) video.requestVideoFrameCallback(this.onFrame);
      this.syncLoop();
    }

    // Start the every-refresh loop if it should be running. It stops by
    // itself when the video pauses or the setting is switched off.
    syncLoop() {
      if (!this.dead && settings.poll && !this.raf && !this.video.paused) this.raf = requestAnimationFrame(this.onTick);
    }

    // The timestamp of the frame the video is showing right now, or null if
    // that can't be told.
    frameTime() {
      const f = this.grab();
      if (!f) return null;
      const t = f.timestamp;
      f.close();
      return t;
    }

    // The frame the video is showing right now, to be closed by the caller,
    // or null if it can't be had.
    grab() {
      if (!settings.poll || this.noPoll) { this.polling = false; return null; }
      try {
        const f = new VideoFrame(this.video);
        this.polling = true;
        return f;
      } catch (e) {
        if (e.name === 'SecurityError') this.noPoll = true;    // never readable: don't keep trying
        this.polling = false;
        return null;
      }
    }

    // With the every-refresh loop not running (paused, or switched off): draw
    // the frame the video is showing, unless it has been drawn already.
    pump(now) {
      const ts = this.frameTime();
      if (ts != null && ts === this.seenTs && !this.needsDraw) return;
      const fresh = ts == null || ts !== this.seenTs;
      if (this.render(fresh)) {
        if (!fresh) return;
        this.countFrame();
        if (ts != null) {
          this.seenTs = ts;
          const m = this.meta;
          this.hitches.frame(now, {
            expectedDisplayTime: now, mediaTime: ts / 1e6, presentedFrames: this.lastPresented || 0,
            processingDuration: m ? m.processingDuration : NaN,
          }, this.video, this.srcFps);
        }
      } else if (fresh) {
        this.hitches.undrawn++;
      }
    }

    // While frames can be told apart, the hitch log follows the frames drawn
    // (see pump). Otherwise it follows the browser's callbacks.
    frameSeen(now, meta) {
      this.meta = meta;
      const p = meta.processingDuration * 1000;
      if (Number.isFinite(p)) {
        this.procNow = Number.isFinite(this.procNow) ? this.procNow * 0.8 + p * 0.2 : p;
        this.procLast = p;
        this.procAt = performance.now();
      }
      if (!this.polling) super.frameSeen(now, meta);
    }

    // Auto-quality state, started afresh for every new video.
    resetAuto() {
      this.level = 0;           // index into LEVELS when perf is 'auto'
      this.upTier = 0;          // which upscaling network 'best' means: index into SDR2HDR_UPNETS, past its end = none (see upChoice)
      this.bad = 0;             // consecutive measurement windows with too many drops
      this.holdUntil = 0;       // no judging until this time, after a level change
      this.baseline = null;     // { drop, fps } at full quality, before the first step down
      this.autoDone = false;    // nothing further to try for this video
      this.busy = false;        // lowering quality didn't help, and the page is measurably busy: it is the limit
      this.limited = false;     // lowering quality didn't help, and the page isn't busy: something in the browser is
      this.srcFps = 0;          // the video's own frame rate, once known
      this.mediaAt = null;      // media time of the last frame seen
      this.gaps = [];           // the first few gaps between frames, for working out srcFps
      this.effWas = 0;          // the level last drawn at, to notice when the budget changes it
    }

    rateChanged() {
      this.layout();             // the budget may put it at a different level now
    }

    drawnSize() {
      return `${this.canvas.width}x${this.canvas.height}`;
    }

    // The highest level that keeps pixels drawn per second within budget, for
    // this video's frame rate and the size it's shown at. Auto never draws
    // above it. It used to start at full quality and back off only after
    // falling behind, and that overload is where the worst stutter came from.
    budgetLevel() {
      if (!this.box || !(this.srcFps > 0)) return 0;
      for (let l = 0; l < LEVELS.length; l++) {
        const [bw, bh] = this.backingSize(LEVELS[l]);
        if (bw * bh * this.srcFps <= PIXEL_BUDGET) return l;
      }
      return LEVELS.length - 1;
    }

    // The level Auto is drawing at: the lower quality of what the budget
    // allows and what measured trouble has pushed it down to (this.level).
    effLevel() {
      return Math.max(this.level, this.budgetLevel());
    }

    quality() {
      if (settings.perf === 'best') return LEVELS[0];
      if (settings.perf === 'fast') return LEVELS[2];
      return LEVELS[this.effLevel()];
    }

    // Upscaling: which way a video smaller than the screen is made bigger.
    //
    // Without it the picture is drawn with as many pixels as the video has
    // and the browser stretches it over the screen, which is soft. With it
    // the picture is drawn with as many pixels as the screen has, and a pass
    // of our own (UP in shader.js) does the stretching with regard for edges.
    //
    // 'fast' is that pass. 'best' is a small trained network (FSRCNNX, as in
    // mpv; see upnet.js), which costs many times more. Auto uses it and
    // steps down if the GPU's timing says it is too much; Performance "Best
    // quality" uses the bigger network whatever it costs.
    // The network doubles the picture, so where it is drawn more than twice
    // as big, 'fast' takes it the rest of the way.
    //
    // There are two sizes of the network. The bigger is used first; when the
    // GPU says a frame's work is taking too much of a frame's time (perfTick,
    // Performance on Auto only), the smaller, and then 'fast' (this.upTier).
    //
    // This is the choice before sizes are looked at: 'off' when the setting
    // says so, when Performance is Fastest, when Auto has had to lower the
    // quality because the GPU fell behind, or when the screen's worth of
    // pixels at this frame rate is over Auto's pixel budget.
    upChoice() {
      const s = settings.upscale;
      if (s === 'off' || settings.perf === 'fast' || !this.box) return 'off';
      if (settings.perf === 'auto') {
        if (this.level > 0) return 'off';
        const [bw, bh] = this.backingSize(LEVELS[0], true);
        if (bw * bh * (this.srcFps || 0) > PIXEL_BUDGET) return 'off';
      }
      if (s !== 'auto') return s;
      if (settings.perf === 'best') return 'best';
      // Auto goes for the best and lets the GPU's own timing say when that
      // is too much (perfTick). Measured on a Radeon RX 9070 XT: the bigger
      // network on 1080p at 60 frames a second, drawn at 4K, is 3.7 ms of
      // the 16.7 a frame has. Where the GPU can't be asked for timings there
      // is nothing to step down by, so there it is kept for video under 45
      // frames a second, which has twice the time for each frame.
      if (this.gpu.canTime) return 'best';
      return this.srcFps > 0 && this.srcFps < 45 ? 'best' : 'fast';
    }

    // What the upscaling pass has to make for the frame about to be drawn:
    // null when there is nothing to do (upscaling off, or the video already
    // has as many pixels as it is drawn with), else the kind and the size.
    upPlan() {
      const want = this.upChoice();
      if (want === 'off' || !this.slots) return null;
      const c = this.canvas, t = this.slots[0].tex;
      const max = this.gpu.device.limits.maxTextureDimension2D;
      const w = Math.min(max, Math.round(c.width * this.scale[0]));
      const h = Math.min(max, Math.round(c.height * this.scale[1]));
      if (w < t.width * 1.1 && h < t.height * 1.1) return null;
      // A frame that was copied smaller than the video, for a canvas that has
      // since grown: it is drawn once more as it is, and the next frame is
      // copied at full size. Upscaling it would mean making the network's
      // textures for one frame of the wrong size.
      if (t.width < Math.min(max, this.video.videoWidth) && t.height < Math.min(max, this.video.videoHeight)) return null;
      const plan = { want, kind: 'fast', w, h, net: null, stretch: true, why: '' };
      if (want !== 'best') return plan;
      if (Math.max(w / t.width, h / t.height) < UP_BEST_FROM) { plan.why = 'the picture is made less than 1.3 times bigger'; return plan; }
      if (t.width * 2 > max || t.height * 2 > max) { plan.why = 'the doubled picture would be too big for the GPU'; return plan; }
      // Performance "Best quality" means the bigger network, whatever it costs.
      // Otherwise the one this video has been stepped down to, or the one an
      // earlier video on this page at least as heavy was (upLearned), so the
      // next video doesn't start with the same stutter.
      const load = t.width * t.height * (this.srcFps || 60);
      const tier = Math.max(this.upTier, ...upLearned.filter((l) => load >= l.load * 0.95).map((l) => l.tier));
      const which = SDR2HDR_UPNETS[settings.perf === 'best' ? 0 : tier];
      if (!which) { plan.why = 'the network took the GPU too long'; return plan; }
      const net = ensureNet(this.gpu, which.key);
      if (!net) {
        const n = this.gpu.nets[which.key];
        plan.why = n.failed ? `the network could not be set up: ${n.failed}` : 'the network is still being set up';
        return plan;
      }
      plan.kind = 'best';
      plan.net = net;
      plan.name = which.name;
      plan.key = which.key;
      // Doubled is enough, or more than enough (the main pass shrinks it)?
      // Then there is no second step.
      plan.stretch = w > t.width * 2.2 || h > t.height * 2.2;
      return plan;
    }

    // The network's textures for this video: one for each thing a pass
    // saves, the size of the frame, and one twice that for the result.
    ensureNN(plan) {
      const t = this.slots[0].tex, g = this.gpu;
      if (this.nn && this.nn.net === plan.net && this.nn.w === t.width && this.nn.h === t.height) return this.nn;
      this.dropNN();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const tex = {};
      for (const n of plan.net.names) {
        const x = g.device.createTexture({ size: [t.width, t.height], format: SDR2HDR_UPNET_FORMAT, usage });
        tex[n] = { tex: x, view: x.createView() };
      }
      const big = g.device.createTexture({ size: [t.width * 2, t.height * 2], format: SDR2HDR_FRAME_FORMAT, usage });
      const view = big.createView();
      this.nn = {
        net: plan.net, w: t.width, h: t.height, tex, big, view,
        bgMain: [0, 1].map((i) => this.group(g.main, [
          { buffer: this.ubuf }, g.sampler, view, ...this.lv, this.sv[i], this.curvesView,
        ])),
        bgUp: this.group(g.up, [view]),
        groups: new Map(),      // for each frame slot, the bind groups of the passes
      };
      return this.nn;
    }

    // The network's passes for the frame in this slot, into nn.big.
    encodeNN(pass, sl) {
      const nn = this.nn, net = nn.net, g = this.gpu;
      let bg = nn.groups.get(sl);
      if (!bg) {
        const view = (n) => (n === 'LUMA' ? sl.view : nn.tex[n].view);
        bg = {
          passes: net.passes.map((p) => this.group(p.pipeline, p.bind.map(view))),
          out: this.group(net.out, [g.sampler, sl.view, nn.tex[net.last].view]),
        };
        nn.groups.set(sl, bg);
      }
      net.passes.forEach((p, i) => pass(nn.tex[p.save].view, p.pipeline, bg.passes[i]));
      pass(nn.view, net.out, bg.out);
    }

    dropNN() {
      if (!this.nn) return;
      for (const n in this.nn.tex) this.nn.tex[n].tex.destroy();
      this.nn.big.destroy();
      this.nn = null;
    }

    // The texture the upscaled frame goes into, made when first needed and
    // remade when its size changes. There is one, not one per waiting frame:
    // a frame is upscaled as it is drawn.
    ensureUp(plan) {
      if (this.up && this.up.tex.width === plan.w && this.up.tex.height === plan.h) return this.up;
      this.dropUp();
      const g = this.gpu;
      const tex = g.device.createTexture({
        size: [plan.w, plan.h], format: SDR2HDR_FRAME_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = tex.createView();
      this.up = {
        tex, view,
        bgMain: [0, 1].map((i) => this.group(g.main, [
          { buffer: this.ubuf }, g.sampler, view, ...this.lv, this.sv[i], this.curvesView,
        ])),
      };
      return this.up;
    }

    dropUp() {
      if (this.up) this.up.tex.destroy();
      this.up = null;
    }

    // Everything the upscaling for this frame needs, and the texture the
    // main pass is to read: { plan, src: { bgMain, w, h }, run(pass, sl) },
    // or null when the frame is drawn as it is.
    upSetup() {
      const plan = this.upPlan();
      if (!plan) { this.dropUp(); this.dropNN(); return null; }
      const nn = plan.kind === 'best' ? this.ensureNN(plan) : (this.dropNN(), null);
      const up = plan.stretch ? this.ensureUp(plan) : (this.dropUp(), null);
      const src = up ? { bgMain: up.bgMain, w: plan.w, h: plan.h } : { bgMain: nn.bgMain, w: nn.w * 2, h: nn.h * 2 };
      const run = (pass, sl) => {
        if (nn) this.encodeNN(pass, sl);
        if (up) pass(up.view, this.gpu.up, nn ? nn.bgUp : sl.bgUp);
      };
      return { plan, src, run };
    }

    // For the badge (with Stats on): which upscaler is drawing right now.
    upWord() {
      const now = this.upNow;
      if (!now) return this.upChoice() === 'off' ? 'off' : 'not needed';
      if (now.kind === 'best') return `Best (${now.name})${now.stretch ? ' + Fast' : ''}`;
      return now.want === 'best' ? 'Fast (Best not in use)' : 'Fast';
    }

    // For the report and the popup.
    upLine() {
      const want = this.upChoice(), now = this.upNow;
      if (settings.upscale === 'off') return 'off';
      if (want === 'off') {
        return settings.perf === 'fast' ? 'off (Performance is Fastest)'
          : (this.level > 0 ? 'off (the GPU fell behind, so Auto lowered the quality)' : 'off (over the pixel budget at this frame rate)');
      }
      if (!now) return `${want}, not in use (the video has as many pixels as it is drawn with)`;
      if (now.kind === 'best') return `best (${now.name}), ${now.from} to ${now.mid}${now.stretch ? `, then fast to ${now.w}x${now.h}` : (now.mid !== `${now.w}x${now.h}` ? `, drawn at ${now.w}x${now.h}` : '')}`;
      return `fast${now.want === 'best' ? ` (not best: ${now.why})` : ''}, ${now.from} to ${now.w}x${now.h}`;
    }

    // Canvas backing size, in real pixels, for a given quality level.
    backingSize(q, up = this.upChoice() !== 'off') {
      const { w, h, sx, sy } = this.box;
      const v = this.video;
      const dpr = window.devicePixelRatio || 1;
      const bw = w * dpr, bh = h * dpr;
      let k = Math.min(1, q.maxDim / Math.max(bw, bh));
      if (settings.perf !== 'best' && !up) {
        // No point drawing the picture with more pixels than the video has:
        // a 1080p video on a 4K screen is drawn at 1080p and scaled up by the
        // browser, which looks the same for a quarter of the work. This is
        // measured on the picture itself, not the player's box, so a video
        // with bars beside it (or one cropped to fill) still gets its full
        // resolution. Never below 1280 on the long side.
        const want = Math.max(v.videoWidth, v.videoHeight, 1280);
        k = Math.min(k, want / Math.max(bw * sx, bh * sy));
      }
      return [Math.max(1, Math.round(bw * k)), Math.max(1, Math.round(bh * k))];
    }

    // The next lower level that would actually change something. On a 1440p
    // screen the 1440p level changes nothing, so it's skipped.
    nextLevel() {
      const c = this.canvas, now = this.effLevel();
      for (let l = now + 1; l < LEVELS.length; l++) {
        // Sized without upscaling: any level below the top one switches it off (upChoice).
        const [bw, bh] = this.backingSize(LEVELS[l], false);
        if (LEVELS[l].lite !== LEVELS[now].lite || bw * bh < c.width * c.height * 0.9) return l;
      }
      return -1;
    }

    // Work out how many of the video's frames we failed to draw, about every
    // three seconds, and in auto mode act on it.
    //
    // "Frames we should have drawn" is the larger of two counts the browser
    // keeps: frames it presented, and frames the decoder produced. This runs
    // from the once-a-second scan rather than from the frame callback, so it
    // still runs when callbacks have all but stopped.
    perfTick() {
      const t = performance.now();
      const m = this.measure();
      if (!m) return;
      const { w, drop, fps } = m;
      this.stats = { fps, drop, gap: w.gap };
      if (settings.stats) this.updateBadge();
      const backlog = w.gpu > BACKLOG_MS;
      if (drop < 0.03 && !backlog) this.limited = false;
      if (settings.perf !== 'auto' || this.autoDone || !this.box || t < this.holdUntil) return;
      // The upscaling network is the first thing to go, its smaller size
      // and then none (see upChoice), and it goes before anything else is
      // looked at: the GPU's timing of a frame means the same whether or not
      // frames are being let go by for the decoder, and the decoder shares
      // the GPU with it. (1.1.2 on a Radeon RX 9070 XT, 1440p at 60: the
      // bigger network took 9.2 ms a frame, and this waited 28 seconds behind
      // the easing below before saying so.) It goes at four tenths of a
      // frame's time, not the half that lowers the quality level.
      {
        const frameMs = 1000 / (this.srcFps || 60);
        const work = this.gpuWork();
        if (this.upNow && this.upNow.kind === 'best' && work > 0.4 * frameMs) {
          const sl = this.slots && this.slots[0].tex;
          const key = this.upNow.key;
          this.upTier = SDR2HDR_UPNETS.findIndex((n) => n.key === key) + 1;
          if (sl) upLearned.push({ tier: this.upTier, load: sl.width * sl.height * (this.srcFps || 60) });
          this.holdUntil = t + 6000;
          this.recentWork.length = 0;
          this.bad = 0;
          const to = SDR2HDR_UPNETS[this.upTier];
          log(`a frame's work takes the GPU ${work.toFixed(1)} ms with the upscaling network ${this.upNow.name}; ${to ? `trying ${to.name}` : 'using Fast upscaling instead'}`);
          this.needsDraw = true;
          return;
        }
      }
      // Frames let go by for the decoder's sake (see EASE_SLOW) are not a sign
      // of anything, and nor are the moments either side of that.
      if (this.ease.half || t - this.ease.fullAt < 4000) { this.bad = 0; return; }

      // Where the GPU can be asked how long a frame's work takes, that
      // settles whether drawing fewer pixels would help. A big share of a
      // frame's time: yes, at once, without waiting for frames to be lost.
      // A small share: no, whatever is being lost is being lost somewhere
      // else in the browser. (Measured: 0.7 ms a frame at 4K on a Radeon RX
      // 9070 XT while frames were being dropped, and lowering quality changed
      // nothing.) Where it can't be asked, frames queuing up on the GPU or
      // being dropped are the only signs there are, and either has to show in
      // two windows in a row, so a one-off hitch doesn't cost quality for the
      // rest of the video.
      const frameMs = 1000 / (this.srcFps || 60);
      const work = this.gpuWork();
      const heavy = work > 0.5 * frameMs;
      this.bad = backlog || drop > 0.08 ? this.bad + 1 : 0;
      const losing = this.bad >= 2;
      if (!heavy && !losing) return;
      this.bad = 0;
      if (work >= 0 && work < 0.35 * frameMs) {
        this.limited = true;
        this.holdUntil = t + 30000;
        log(`frames are being lost (${Math.round(drop * 100)}% dropped), but the GPU spends only ${work.toFixed(1)} ms on a frame, so lower quality would not help. Leaving quality as it is.`);
        return;
      }

      const next = this.nextLevel();
      if (next >= 0) {
        if (!this.baseline) this.baseline = { drop, fps };
        this.level = next;
        this.holdUntil = t + 6000;       // give the new level time to show its effect
        log(heavy
          ? `a frame's work takes the GPU ${work.toFixed(1)} ms, lowering quality to level ${next}`
          : (backlog
            ? `the GPU is ${Math.round(w.gpu)} ms behind, lowering quality to level ${next}`
            : `dropping ${Math.round(drop * 100)}% of frames, lowering quality to level ${next}`));
        this.layout();
        return;
      }

      // Already at the lowest level: nothing further to try for this video.
      this.autoDone = true;
      if (!losing) return;
      // Still dropping frames there, so the GPU work this extension asks for
      // isn't what's limiting things.
      const b = this.baseline;
      if (b && (drop <= b.drop * 0.7 || fps >= b.fps * 1.15)) return;   // it did help; stay here
      const pageBusy = m.busy > 0.15 || m.lag > 250;
      if (pageBusy) {
        // The page's own scripts are keeping our frame callback from running
        // on time. Lower quality buys nothing, so go back to full quality.
        this.busy = true;
        this.level = 0;          // back to whatever the budget allows
        log('lower quality did not reduce dropped frames, and the page is busy; restoring quality');
        this.layout();
      } else {
        // The page isn't busy either: the browser itself is showing the video
        // at a reduced rate. Going back up would only add load, so stay low.
        this.limited = true;
        log('lower quality did not reduce dropped frames, and the page is not busy: the browser itself is showing fewer frames. Staying at the lowest quality.');
      }
    }

    // What each side of the picture shows, as [left, right] with 0 = the
    // original, 1 = shader, 2 = model. A side set to the model shows the
    // shader until a model is loaded and ready. This only reports; it changes
    // nothing, so it's safe to call from anywhere.
    sides() {
      const m = this.gpu.model;
      const ready = !!m && !m.destroyed && !!settings.modelInfo && this.noRun !== m;
      return sidesWanted().map((s) => (s === 'original' ? 0 : (s === 'model' && ready ? 2 : (s === 'guided' && ready ? 3 : 1))));
    }

    // Get the model's working memory for this video ready (see model.js).
    // Called just before drawing with the model.
    // Returns false if it couldn't be done, in which case this video carries
    // on with the shader (and doesn't try again with the same model).
    prepareRun() {
      const m = this.gpu.model;
      if (this.run && this.run.model !== m) this.dropRun();
      if (!this.run) {
        try {
          this.run = m.createRun(this.curvesView);
        } catch (e) {
          this.noRun = m;
          log(`could not set the model up for ${nameOf(this.video)}, using the shader: ${e.name}: ${e.message}`);
          this.updateBadge();
          return false;
        }
        this.netAt = 0;
      }
      return true;
    }

    dropRun() {
      if (this.run) this.run.destroy();
      this.run = null;
    }

    // What the badge says. With "Stats on video" on it carries live numbers,
    // so they can be read in fullscreen, where the popup can't be opened:
    // new video frames drawn per second, the share of the video's frames that
    // were never drawn, the longest wait between two frames, the size drawn
    // at, and the frame timing in use.
    badgeText() {
      const [l, r] = this.sides();
      const name = settings.split
        ? `${['ORIGINAL', 'SHADER', 'MODEL', 'GUIDED'][l]} | ${['ORIGINAL', 'SHADER', 'MODEL', 'GUIDED'][r]}`
        : (r === 2 ? 'HDR \u00b7 MODEL' : (r === 3 ? 'HDR \u00b7 GUIDED' : 'HDR'));
      if (!settings.stats) return name;
      const st = this.stats, c = this.canvas;
      const parts = [selfTest ? `SELF-TEST (${selfTest.phase}) \u00b7 ${name}` : name];
      if (st) {
        parts.push(`${Math.round(st.fps)} fps`, `${Math.round(st.drop * 100)}% dropped`, `longest gap ${Math.round(st.gap)} ms`);
      } else {
        parts.push(this.video.paused ? 'paused' : 'measuring');
      }
      parts.push(`${c.width}x${c.height}`, `upscale: ${this.upWord()}`, `drawing: ${drawMode()}${this.ease && this.ease.half ? ', every other frame' : ''}${paceHere ? `, pacing ${paceState(this)}${abOn ? ' (A/B test)' : ''}` : ''}`, `original ${hideMode() === 'off' ? 'shown' : hideMode()}`);
      return parts.join(' \u00b7 ');
    }

    updateBadge() {
      const b = this.badge, stats = settings.stats;
      b.style.display = settings.badge || stats ? 'flex' : 'none';
      // With stats on, the badge stays readable instead of fading.
      const dim = this.badgeDim && !stats;
      b.style.opacity = dim ? '.4' : '.95';
      b.style.background = stats ? 'rgba(24,18,44,.78)' : 'rgba(40,32,70,.55)';
      b.style.letterSpacing = stats ? '.02em' : '.08em';
      const text = this.badgeText();
      if (b.label.textContent !== text) b.label.textContent = text;
      this.knob.style.display = settings.split ? 'flex' : 'none';
    }

    // Keep the canvas glued to the video's box, and work out object-fit scaling.
    // When a site fullscreens the bare <video> (rather than a wrapper around
    // it), nothing next to the video is visible any more. A popover is the one
    // thing that can sit above a fullscreen element, so the overlay moves into
    // one for the duration and moves back afterwards.
    setTopLayer(on) {
      this.top = on;
      const parts = [this.canvas, this.badge, this.knob];
      if (on) {
        const pop = (this.pop = document.createElement('div'));
        pop.dataset.sdr2hdr = 'top';
        pop.setAttribute('popover', 'manual');
        pop.style.cssText =
          'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;' +
          'margin:0;padding:0;border:0;background:transparent;overflow:hidden;pointer-events:none;';
        (document.body || document.documentElement).append(pop);
        pop.append(...parts);
        try { pop.showPopover(); } catch (e) { log('top layer unavailable:', e.message); }
      } else {
        let after = this.video;
        for (const el of parts) { after.insertAdjacentElement('afterend', el); after = el; }
        if (this.pop) this.pop.remove();
        this.pop = null;
      }
    }

    // In that bare-video fullscreen case the browser's own controls are drawn
    // under our canvas, so uncover the bottom strip while they'd be showing.
    updateClip() {
      const v = this.video;
      const show = this.top && v.controls &&
        (v.paused || performance.now() - lastPointer < 3200);
      const clip = show ? 'inset(0 0 96px 0)' : '';
      if (clip !== this.clip) { this.clip = clip; this.canvas.style.clipPath = clip; }
    }

    layout() {
      const v = this.video, c = this.canvas, b = this.badge;
      const w = v.offsetWidth, h = v.offsetHeight;
      if (!w || !h || !v.videoWidth) return;

      // getRootNode() so this also works for a video inside a shadow root.
      const isTop = v.getRootNode().fullscreenElement === v;
      if (isTop !== this.top) this.setTopLayer(isTop);
      this.updateClip();
      const left = isTop ? 0 : v.offsetLeft, top = isTop ? 0 : v.offsetTop;

      const cs = getComputedStyle(v);
      const z = isTop ? '' : cs.zIndex;
      c.style.left = left + 'px';
      c.style.top = top + 'px';
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      c.style.zIndex = z;
      c.style.transform = isTop || cs.transform === 'none' ? '' : cs.transform;
      c.style.transformOrigin = cs.transformOrigin;

      b.style.left = (left + w - 12) + 'px';
      b.style.top = (top + 12) + 'px';
      b.style.zIndex = z;

      // How the picture sits in the player's box: sx, sy are its size as a
      // fraction of the box (below 1 = bars on that axis, above 1 = cropped).
      const va = v.videoWidth / v.videoHeight, ea = w / h;
      let sx = 1, sy = 1;
      if (cs.objectFit === 'cover') {
        if (va > ea) sx = va / ea; else sy = ea / va;
      } else if (cs.objectFit !== 'fill') {      // contain (the default)
        if (va > ea) sy = ea / va; else sx = va / ea;
      }
      this.scale = [sx, sy];
      this.box = { w, h, sx, sy };

      // Say so when the pixel budget moves Auto to a different level (the
      // video's frame rate became known, or it went fullscreen), and give the
      // new level a few seconds before judging it.
      if (settings.perf === 'auto') {
        const eff = this.effLevel();
        if (eff !== this.effWas) {
          if (eff > this.level || this.effWas > this.level) {
            const [fw, fh] = this.backingSize(LEVELS[0]);
            const [dw, dh] = this.backingSize(LEVELS[eff]);
            log(`${nameOf(v)}: ${fw}x${fh} at ${Math.round(this.srcFps)} frames a second is ${eff > this.level ? 'over' : 'within'} the pixel budget; drawing at ${dw}x${dh}`);
            this.holdUntil = performance.now() + 6000;
          }
          this.effWas = eff;
        }
      }

      // After a resize the canvas is left holding a stale picture at the old
      // size until something draws again (see needsDraw).
      const [bw, bh] = this.backingSize(this.quality());
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
        this.needsDraw = true;
        this.recentWork.length = 0;      // timings at the old size say nothing about this one
        if (this.sized) this.hitches.resized(`${bw}x${bh}`);
        this.sized = true;      // the first sizing isn't a change
      }

      // Split handle sits on the line, halfway down the video.
      const kn = this.knob;
      kn.style.left = (left + w * (0.5 + (settings.splitPos - 0.5) * sx)) + 'px';
      kn.style.top = (top + h / 2) + 'px';
      kn.style.zIndex = z;
      this.covers = c.isConnected && c.offsetWidth > 0 && c.offsetHeight > 0;
      this.syncHide();
    }

    // Screen x of the split line, plus the canvas box, for hit testing.
    splitGeometry() {
      const r = this.canvas.getBoundingClientRect();
      const x = r.left + r.width * (0.5 + (settings.splitPos - 0.5) * this.scale[0]);
      return { r, x };
    }

    // Convert a pointer x to a split position in video space.
    splitFromPointer(clientX) {
      const r = this.canvas.getBoundingClientRect();
      const fx = (clientX - r.left) / r.width;
      return Math.min(0.98, Math.max(0.02, 0.5 + (fx - 0.5) / this.scale[0]));
    }

    // Give up on this video: for good if the browser forbids reading it,
    // otherwise for a few seconds, up to five times.
    block(error, forGood, what = 'its frames could not be read') {
      const v = this.video, was = blocked.get(v);
      const tries = was && was.src === v.currentSrc ? was.tries + 1 : 1;
      const until = forGood || tries > 5 ? Infinity : performance.now() + 3000;
      blocked.set(v, { src: v.currentSrc, until, tries, error, what });
      this.destroy(what);
    }

    // The video frame as an ordinary texture, which every pass after the
    // first reads from (see COPY in shader.js). It's the video's resolution,
    // or the size the picture is drawn at if that's smaller: there's no point
    // keeping detail the canvas can't show. Remade when either changes.
    ensureFrame() {
      const v = this.video, c = this.canvas;
      const k = Math.min(1, Math.max(c.width * this.scale[0] / v.videoWidth, c.height * this.scale[1] / v.videoHeight));
      const max = this.gpu.device.limits.maxTextureDimension2D;
      const w = Math.min(max, Math.max(16, Math.round(v.videoWidth * k)));
      const h = Math.min(max, Math.max(16, Math.round(v.videoHeight * k)));
      if (this.slots && this.slots[0].tex.width === w && this.slots[0].tex.height === h) return;
      for (const sl of this.slots || []) sl.tex.destroy();
      this.dropNN();          // its bind groups are of the old frames
      const g = this.gpu;
      // Three, so that a frame can be on screen, another waiting its turn,
      // and a third being copied in (see check and presentNext).
      this.slots = [0, 1, 2].map(() => {
        const tex = g.device.createTexture({
          size: [w, h], format: SDR2HDR_FRAME_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const view = tex.createView();
        return {
          tex, view, ts: null,
          // The passes that read it. The main pass has two versions, one for
          // each of the two scene textures it alternates between.
          bgDown1: this.group(g.down1, [g.sampler, view]),
          bgUp: this.group(g.up, [view]),
          bgMain: [0, 1].map((i) => this.group(g.main, [
            { buffer: this.ubuf }, g.sampler, view, ...this.lv, this.sv[i], this.curvesView,
          ])),
        };
      });
      this.queue = [];
      this.cur = null;
    }

    // A copy that is neither on screen nor waiting. If there is none, the
    // oldest one waiting is given up.
    freeSlot() {
      for (const sl of this.slots) if (sl !== this.cur && !this.queue.includes(sl)) return sl;
      this.hitches.undrawn++;
      return this.queue.shift();
    }

    // "Hide original": make the video itself invisible while the overlay is
    // covering it. With the original left showing, the browser goes on
    // preparing it for the screen as well, and that takes frames from the
    // decoder that it needs: measured on YouTube, 134 hitches
    // in 52 seconds with it showing, 3 in 26 with it hidden. Its frames still
    // reach us, clicks still land on it, and it keeps its place on the page.
    // It is only done once a frame has actually been drawn and the overlay is
    // on the page with a size, never for a video using the browser's own
    // controls (they are part of the video and would vanish with it), and it
    // is undone the moment drawing fails or stops.
    syncHide() {
      const v = this.video;
      const mode = hideMode();
      const want = mode !== 'off' && !this.dead && this.drawnOk && this.covers && !this.top && !v.controls ? mode : '';
      const now = this.hidden ? this.hidden.mode : '';
      if (want === now) return;
      if (this.hidden) {
        for (const p of ['opacity', 'clip-path']) {
          const was = this.hidden[p];
          if (was.value) v.style.setProperty(p, was.value, was.priority);
          else v.style.removeProperty(p);
        }
        this.hidden = null;
        if (!want) note(`${nameOf(v)}: original shown again`);
      }
      if (want) {
        const keep = (p) => ({ value: v.style.getPropertyValue(p), priority: v.style.getPropertyPriority(p) });
        this.hidden = { mode: want, opacity: keep('opacity'), 'clip-path': keep('clip-path') };
        v.style.setProperty('opacity', '0', 'important');
        note(`${nameOf(v)}: original ${want} under the overlay`);
      }
    }

    // Something about how the picture should look has changed. A playing
    // video picks that up with its next frame; a paused one is redrawn now.
    refresh() {
      if (this.raf && !this.video.paused) this.needsDraw = true;
      else this.render();
    }

    // Draw the frame the video is showing, now. Returns true if it was drawn.
    // newFrame: false when the same video frame is being drawn again (after a
    // resize), so the model's last answer is reused.
    render(newFrame = true) {
      const v = this.video;
      if (this.dead || v.readyState < 2 || !v.videoWidth) return false;
      const began = performance.now();
      this.updateClip();
      // Taken as a frame of its own where the browser allows, so that it can
      // be handed back the moment it has been copied (see capture).
      let f = null;
      try { f = new VideoFrame(v); } catch {}
      const sl = this.capture(f ? f.timestamp : null, f || v);
      if (f) {
        if (sl) this.seenTs = f.timestamp;
        f.close();
      }
      if (!sl) return false;
      this.queue.length = 0;
      return this.present(sl, newFrame, began);
    }

    // Copy a frame of the video into a texture of our own. This is the one
    // pass that reads the video itself, and it is sent to the GPU at once.
    // source is the frame to copy, which the caller closes straight after:
    // that is what hands it back to the decoder. Read from the <video>
    // element instead, the browser keeps it
    // until the video has moved on to its next frame, one frame longer.
    // Returns the copy, or null if the frame couldn't be read.
    capture(ts, source = this.video) {
      const v = this.video;
      const began = performance.now();
      const { device } = this.gpu;
      let ext;
      try {
        ext = device.importExternalTexture({ source });
      } catch (e) {
        const what = `${e.name}: ${e.message}`;
        if (e.name === 'SecurityError') {
          // Cross-origin video without CORS, or protected content: the
          // browser will never let this one be read as it is.
          log(`cannot read ${nameOf(v)}: ${what}`);
          this.block(what, true);
          locked.add(v);
          if (siteUnlock) tryUnlock(v);
          return null;
        }
        // Anything else may be a passing fault (the site switching streams):
        // skip this frame, and only give up if it goes on for two seconds.
        // Frames lost this way say nothing about performance.
        this.drawnOk = false;
        this.syncHide();
        this.win.dirty = true;
        this.win.ev.unreadable = (this.win.ev.unreadable || 0) + 1;
        if (!this.failAt) {
          this.failAt = began;
          log(`could not read a frame of ${nameOf(v)} (${what}); skipping it`);
        } else if (began - this.failAt > 2000) {
          log(`still cannot read ${nameOf(v)} after two seconds: ${what}`);
          this.block(what, false);
        }
        return null;
      }
      this.failAt = 0;
      try {
        this.ensureFrame();
        const sl = this.freeSlot();
        const enc = device.createCommandEncoder();
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: sl.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        });
        rp.setPipeline(this.gpu.copy);
        // Made afresh each time, because the video frame is new each time.
        rp.setBindGroup(0, this.group(this.gpu.copy, [this.gpu.sampler, ext]));
        rp.draw(4);
        rp.end();
        device.queue.submit([enc.finish()]);
        // Until the GPU has done that, the decoder can't have this frame
        // back.
        this.heldSeen[Math.min(8, this.held)]++;
        this.held++;
        const at = performance.now();
        this.copies.push(at);
        const done = () => {
          this.held = Math.max(0, this.held - 1);
          const i = this.copies.indexOf(at);
          if (i >= 0) this.copies.splice(i, 1);
        };
        device.queue.onSubmittedWorkDone().then(() => {
          done();
          const ms = performance.now() - at;
          this.win.gpu = Math.max(this.win.gpu, ms);
          this.hitches.gpuSample(at, ms);
          // What is usual: the middle one of the last 64.
          const r = this.gpuRecent;
          r.push(ms);
          this.gpuAt = performance.now();
          if (r.length > 64) r.shift();
          if (!this.gpuUsual || ++this.gpuCount % 16 === 0) this.gpuUsual = [...r].sort((x, y) => x - y)[r.length >> 1];
        }, done);
        sl.ts = ts;
        return sl;
      } catch (e) {
        this.drawFailed(e);
        return null;
      }
    }

    // Put a copied frame on screen. Returns true if it was drawn.
    present(sl, newFrame, began) {
      this.cur = sl;
      try {
        this.draw(sl, newFrame, began);
      } catch (e) {
        this.drawFailed(e);
        return false;
      }
      this.drawnOk = true;
      this.syncHide();
      return true;
    }

    // Nothing in drawing is expected to fail. If something does, say so once
    // per kind of failure rather than on every frame.
    drawFailed(e) {
      const what = `${e.name}: ${e.message}`;
      if (this.drawError !== what) {
        this.drawError = what;
        log(`drawing ${nameOf(this.video)} failed: ${what}`);
      }
      this.drawnOk = false;
      this.syncHide();
    }

    // While playing: copy the frame the video is showing, if it is one not
    // seen before, and put it in the queue for the screen.
    check() {
      const v = this.video;
      if (this.dead || v.readyState < 2 || !v.videoWidth) return;
      if (performance.now() < this.restUntil) return;
      const f = this.grab();
      if (!f) return;
      const ts = f.timestamp;
      let sl = null;
      if (ts !== this.seenTs) {
        if (this.ease.half && (Math.round(ts / 1e6 * (this.srcFps || 60)) & 1)) {
          // Easing off: every other frame is let go by (see EASE_SLOW).
          this.seenTs = ts;
          this.hitches.event('ease');
        } else {
          // Copied from the very frame whose timestamp was read, so the two
          // can't disagree.
          sl = this.capture(ts, f);
        }
      }
      f.close();
      if (!sl) return;
      this.seenTs = ts;
      this.queue.push(sl);
    }

    // Once per screen refresh while playing: keep the pacing and the asking
    // of the GPU thread going (see pacer.js). Only for a video with a new
    // frame for every refresh of the screen, or nearly: with fewer, every
    // other refresh has nothing to hand over and the queue can't get stuck.
    pace(now) {
      const frameMs = 1000 / (this.srcFps || 60);
      const fits = this.srcFps >= 45 && this.polling && !(this.tickMs && this.tickMs < frameMs * 0.75);
      if (fits !== this.paceFits) {
        this.paceFits = fits;
        if (this.hitches) this.hitches.mark(markLabel(this));
        this.updateBadge();
      }
      if (!fits) return;
      // Whatever goes wrong in there must not stop the drawing.
      try {
        SDR2HDR_PACER.tick(now, paceOn(), paceHere || !!settings.stats);
      } catch (e) {
        if (!paceError) log(`pacing failed: ${e.name}: ${e.message}`);
        paceError = `${e.name}: ${e.message}`;
      }
    }

    // Once per screen refresh while playing: is the decoder in trouble, and
    // what to do about it (see EASE_SLOW).
    steer() {
      const t = performance.now(), v = this.video, e = this.ease;
      const frameMs = 1000 / (this.srcFps || 60);
      const gap = t - this.steerAt;
      this.steerAt = t;
      // The screen's refresh interval: the middle one of the last few gaps.
      if (gap > 2 && gap < 200) {
        this.tickGaps.push(gap);
        if (this.tickGaps.length >= 31) {
          this.tickMs = this.tickGaps.sort((x, y) => x - y)[15];
          this.tickGaps = [];
        }
      }
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const dl = this.dropLog;
      if (q) {
        dl.push([t, q.droppedVideoFrames]);
        while (dl.length > 2 && t - dl[0][0] > 600) dl.shift();
      }
      const drops = dl.length > 1 ? dl[dl.length - 1][1] - dl[0][1] : 0;
      // Kept apart for pacing on and off, for the report.
      const paced = !paceError && SDR2HDR_PACER.pacing() ? 1 : 0;
      if (gap > 2 && gap < 200) this.paceMs[paced] += gap;
      if (q) {
        if (this.dropSeen >= 0 && q.droppedVideoFrames > this.dropSeen) this.paceDrops[paced] += q.droppedVideoFrames - this.dropSeen;
        this.dropSeen = q.droppedVideoFrames;
      }
      // Frames are thrown away as a matter of course when there are more of
      // them than the screen can show: that says nothing about the decoder.
      const surplus = v.playbackRate > 1.01 || this.tickMs > frameMs * 1.1;
      const dropping = !surplus && drops >= EASE_DROPS;
      // Slow for this video: some decoders always run several frames behind
      // and lose nothing by it.
      const slow = this.procNow > Math.max(EASE_SLOW * frameMs, 2 * this.procBase);
      // The first frames after starting or seeking are slow by nature.
      const settling = t - this.hitches.evAt < 1000 && ['play', 'seeking', 'loadedmetadata', 'ratechange', 'pause'].includes(this.hitches.evName);
      // One frame, just now, that took far longer than they ever do.
      const spike = t - this.procAt < 250 && this.procLast > Math.max(EASE_FAST * frameMs, 2.5 * this.procBase);
      // Trouble, to ease off: slow and losing frames, or losing a lot of them.
      // Well, to go back: neither slow nor losing a lot.
      const trouble = !settling && (dropping || (slow && (surplus || drops >= 1)) || (spike && !surplus && drops >= 1));
      // The screen queue stuck a frame ahead (see BEAT_AGE): a copy handed to
      // the GPU long ago and still not done, though the GPU has little to do.
      while (this.copies.length && t - this.copies[0] > 3000) this.copies.shift();   // never answered
      const oldest = this.copies.length ? t - this.copies[0] : 0;
      const light = !settling && t - this.born > 1500 && !(this.gpuWork() > 0.35 * frameMs);
      const waiting = light && oldest > Math.max(BEAT_AGE * frameMs, 3 * this.gpuUsual);
      // The earlier sign, which needs two things at once because either alone
      // happens in good running: the last six copies took the GPU well over
      // twice as long as usual, and the decoder has just taken five frame
      // times or more over a frame. (In the traces the decoder's other signs
      // came 0.4 to 0.5 s after the queue got stuck.)
      const six = this.gpuRecent.slice(-6).sort((x, y) => x - y);
      const copySlow = six.length === 6 && t - this.gpuAt < 300 ? six[3] : 0;
      const early = light && copySlow > Math.max(2.7 * frameMs, 2.2 * this.gpuUsual) &&
        t - this.procAt < 250 && this.procLast > Math.max(4.9 * frameMs, 2 * this.procBase);
      // And the direct sign (Windows): the browser's GPU thread showing the
      // hand-over stuck, for a quarter of a second now. (Shorter ones pass by
      // themselves; a stuck one was seen this way seconds before the other
      // signs showed it.)
      const direct = !settling && !paceError && SDR2HDR_PACER.stuckFor() >= DIRECT_MS;
      // While the GPU thread is being asked, its word is the one that counts:
      // the two signs above are guesses at the same thing, and they are wrong
      // when copies are late for another reason. (Measured: going fullscreen
      // made a copy wait 136 ms, the GPU thread showed nothing stuck and the
      // decoder was at its usual pace, and the guess cost 7.8 s at half rate.)
      const asked = !paceError && SDR2HDR_PACER.asking();
      // Where it is not being asked (not Windows, or a screen much faster than
      // the video), the same thing applies and there is nobody to say
      // otherwise, so the guesses are not acted on in the second and a half
      // after a fullscreen change.
      const resizing = t - this.hitches.evAt < 1500 && this.hitches.evName === 'fullscreen';
      const stuck = asked ? direct : ((waiting || early) && !resizing);
      if (direct && e.half) e.sawStuck = true;
      const unwell = !settling && (dropping || slow || stuck);
      const bad = e.half ? unwell : (trouble || stuck);
      if (bad) e.okSince = 0; else e.okSince = e.okSince || t;

      const k = this.beat;
      if (k.now && t - k.at > BEAT_GRACE) {
        // Did the last beat clear it?
        const cleared = !(trouble || stuck);
        k.now.cleared = cleared;
        k.now.procAfter = this.procNow;
        k.fails = cleared ? 0 : k.fails + 1;
        let off = 0;
        if (k.fails >= BEAT_TRIES) {
          off = Math.min(5000 * 2 ** (k.fails - BEAT_TRIES), 60000);
          k.offUntil = t + off;
        }
        note(`${nameOf(v)}: held one refresh for the screen queue (${k.now.why}); ${cleared ? 'that cleared it' : 'that did not clear it'}${off ? `, not trying that for ${Math.round(off / 1000)} s` : ''}`);
        k.now = null;
      }
      const fast = this.srcFps >= 45;
      // One beat as an episode begins. No more of them while the mouse has
      // just moved: the player is redrawing the page every refresh, the
      // queue is stuck again within a tenth of a second, and each beat is a
      // freeze for nothing (measured: nine of them in one seven-second
      // stretch). Once the mouse has been still a while they count again.
      // ... unless the GPU thread itself shows the hand-over still stuck: then
      // one every two seconds, rather than seconds on end of it starving the
      // decoder (measured: 5.8 s with no beat while the mouse was moving).
      const mouseBusy = e.half && t - lastPointer <= EASE_MOUSE && !(direct && t - k.at > 2000);
      if ((bad || stuck) && !mouseBusy && !k.now && t - k.at > BEAT_GRACE && t >= k.offUntil && fast) {
        k.at = t;
        k.due = true;
        this.paceBeats[paced]++;
        k.now = {
          at: t, oldest, procBefore: this.procNow, procAfter: NaN, cleared: null, half: e.half, paced: !!paced,
          seen: paceError || !SDR2HDR_PACER.asking() ? '-' : (SDR2HDR_PACER.stuck() ? 'stuck' : 'not stuck'),
          why: direct ? 'the GPU thread showing the hand-over stuck' : waiting ? `a copy waiting ${Math.round(oldest)} ms on the GPU` : early ? `copies taking ${Math.round(copySlow)} ms and a frame ${Math.round(this.procLast)} ms to decode` : (slow ? `decoding at ${Math.round(this.procNow)} ms a frame` : (spike ? `${Math.round(this.procLast)} ms to decode one frame` : 'frames being dropped')),
        };
        this.beats.push(k.now);
        if (this.beats.length > 60) this.beats.shift();
      }
      // What is usual for this video: followed while all frames are taken
      // and none are being lost.
      if (!e.half && !settling && drops === 0 && this.procNow > 0 && gap > 2 && gap < 100) {
        this.procBase = this.procBase ? this.procBase + (this.procNow - this.procBase) * Math.min(1, gap / 5000) : this.procNow;
      }

      if (!e.half) {
        // Only for video fast enough that half its frames is still watchable.
        if (!bad || t < e.offUntil || !fast) return;
        e.dwell = e.worked && t - e.fullAt < 4000 ? Math.min(e.dwell * 2, 60000) : EASE_DWELL;
        e.half = true;
        e.at = t;
        e.okSeen = false;
        e.rested = false;
        e.sawStuck = direct;
        e.now = { at: t, procBefore: slow || !spike ? this.procNow : this.procLast, dropping: !slow && !spike && !stuck, ms: NaN, procAfter: NaN, rested: false, worked: null };
        this.eases.push(e.now);
        if (this.eases.length > 40) this.eases.shift();
        note(`${nameOf(v)}: the decoder is falling behind (${slow ? `${Math.round(this.procNow)} ms a frame` : (spike ? `${Math.round(this.procLast)} ms over one frame` : (direct ? 'the hand-over to Windows is stuck' : stuck ? 'a copy waiting on the GPU' : 'dropping frames'))}); taking every other frame`);
        this.updateBadge();
        return;
      }

      if (!bad) e.okSeen = true;
      const leave = (worked) => {
        e.half = false;
        e.fullAt = t;
        e.worked = worked;
        e.now.ms = t - e.at;
        e.now.procAfter = this.procNow;
        e.now.worked = worked;
        if (worked) {
          e.fails = 0;
          note(`${nameOf(v)}: the decoder has caught up after ${((t - e.at) / 1000).toFixed(1)} s; taking every frame again`);
        } else {
          e.fails++;
          const off = Math.min(4000 * 2 ** e.fails, 60000);
          e.offUntil = t + off;
          note(`${nameOf(v)}: taking every other frame did not help the decoder; taking every frame again, and not trying that for ${Math.round(off / 1000)} s`);
        }
        this.updateBadge();
      };
      // Not while the mouse has just moved: a player shows its controls for
      // a few seconds after, and redraws the page every refresh while it
      // does, so the queue would be stuck again at once. (Measured: three
      // episodes one after another, with stutter between, each time the
      // mouse was moved; taken as one stretch they are a few seconds at half
      // rate and nothing else.)
      // (Only where the hand-over was stuck, or can't be seen: an episode in
      // which the GPU thread never showed it stuck has nothing to fear from
      // the player's controls.)
      const calm = t - lastPointer > EASE_MOUSE || (asked && !e.sawStuck);
      if (!bad && calm && t - e.okSince >= e.dwell) { leave(true); return; }
      // The mouse can keep moving for as long as someone is reading the page
      // under the video, and half rate was waiting on it without limit. Well
      // for a whole minute is well: go back, and come here again if not.
      if (!bad && t - e.okSince >= EASE_MOUSE_MAX) { leave(true); return; }
      if (bad && !e.okSeen && t - e.at > 1000 && !e.rested) {
        // Not better after a second: give it a moment with nothing asked of it.
        e.rested = e.now.rested = true;
        this.restUntil = t + REST_MS;
        this.hitches.event('rest');
        return;
      }
      // Never well for a moment, or never well for long enough to go back.
      if ((!e.okSeen && t - e.at > EASE_GIVE_UP) || (calm && t - e.at > 30000 + e.dwell)) leave(false);
    }

    // Hold the page for a little over three screen refreshes, so that the
    // browser has one whole refresh with no redraw to hand over (see
    // BEAT_AGE).
    holdBeat() {
      this.beat.due = false;
      const f = this.tickMs > 3 && this.tickMs < 40 ? this.tickMs : 16.7;
      const until = performance.now() + f * BEAT_HOLD;
      this.hitches.event('beat');
      while (performance.now() < until) { /* held */ }
    }

    // While playing, once per screen refresh: put the oldest waiting copy on
    // screen. One per refresh, in order, so none is skipped.
    presentNext(now) {
      const began = performance.now();
      this.updateClip();
      const sl = this.queue.shift();
      if (!sl) {
        if (this.needsDraw && this.cur) this.present(this.cur, false, began);
        return;
      }
      if (!this.present(sl, true, began)) { this.hitches.undrawn++; return; }
      this.countFrame();
      const m = this.meta;
      this.hitches.frame(now, {
        expectedDisplayTime: now, mediaTime: sl.ts / 1e6, presentedFrames: this.lastPresented || 0,
        processingDuration: m ? m.processingDuration : NaN,
      }, this.video, this.srcFps);
    }

    draw(sl, newFrame, began) {
      const v = this.video;
      const { device } = this.gpu;
      const now = performance.now();
      const s = this.sdata;
      s[0] = this.reset ? 1 : 0;
      s[1] = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      const wasReset = this.reset;
      this.reset = false;
      let [left, right] = this.sides();
      let mode = left >= 2 || right >= 2;       // the model is on screen somewhere, on its own or as the shader's guide
      if (mode && !this.prepareRun()) {
        [left, right] = this.sides();           // now says shader wherever it said model
        mode = false;
      }
      device.queue.writeBuffer(this.sbuf, 0, s);

      const u = this.udata;
      u[0] = this.scale[0];
      u[1] = this.scale[1];
      u[2] = 1 / sl.tex.width;
      u[3] = 1 / sl.tex.height;
      u[4] = settings.peak;
      u[5] = settings.strength;
      u[6] = settings.sat;
      u[7] = settings.split ? 1 : 0;
      u[8] = Math.random();
      u[9] = settings.splitPos;
      // Not calibrated: assume the display can show whatever Peak is set to.
      u[10] = settings.headroom > 0 ? settings.headroom : settings.peak;
      u[11] = settings.soften;
      // Sharpening taps sit one pixel apart, in whichever of frame or screen
      // pixels is bigger: frame pixels when the video is being upscaled,
      // screen pixels when it's being shrunk.
      u[12] = Math.max(u[2], 1 / (this.canvas.width * this.scale[0]));
      u[13] = Math.max(u[3], 1 / (this.canvas.height * this.scale[1]));
      // Upscaling (see upChoice): the main pass then reads a frame of the
      // size it draws, so one pixel of that is the sharpening step.
      const big = this.upSetup();
      this.upNow = big && {
        want: big.plan.want, kind: big.plan.kind, name: big.plan.name, key: big.plan.key, why: big.plan.why, stretch: big.plan.stretch,
        w: big.plan.w, h: big.plan.h, from: `${sl.tex.width}x${sl.tex.height}`, mid: `${sl.tex.width * 2}x${sl.tex.height * 2}`,
      };
      // The badge names the upscaler, so it is told when that changes.
      const word = settings.stats ? this.upWord() : '';
      if (word !== this.upWordWas) { this.upWordWas = word; if (word) this.updateBadge(); }
      if (big) {
        u[12] = Math.max(1 / big.src.w, 1 / (this.canvas.width * this.scale[0]));
        u[13] = Math.max(1 / big.src.h, 1 / (this.canvas.height * this.scale[1]));
      }
      u[14] = settings.sharpen;
      u[15] = settings.gamut;
      u[16] = settings.vivid;
      u[17] = this.quality().lite ? 1 : 0;
      u[18] = left;
      u[19] = right;
      const fit = sdr2hdrModelFit(v.videoWidth, v.videoHeight);
      u[20] = fit[0];
      u[21] = fit[1];
      // Guided: the levels of the model's gain that count as "not a light"
      // and "a light" (see lightLike in shader.js). HDR Trainer measures them
      // for the model; for a model exported before it did, rough ones.
      const guide = (mode && this.gpu.model && this.gpu.model.info.guide) || GUIDE_ROUGH;
      u[22] = guide.lo;
      u[23] = guide.hi;
      device.queue.writeBuffer(this.ubuf, 0, u);

      const enc = device.createCommandEncoder();
      // Now and then a frame is timed on the GPU itself, from the start of
      // its first pass to the end of its last: one in six for the first few
      // seconds at a size, then one in four with Stats on and one in thirty
      // otherwise. Auto goes by it (see perfTick).
      const every = this.recentWork.length < 20 ? 6 : (settings.stats ? 4 : 30);
      const tq = this.gpu.canTime && this.submits % every === 0 ? this.timer() : null;
      const pass = (view, pipeline, bind, timestampWrites) => {
        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
          ...(timestampWrites ? { timestampWrites } : {}),
        });
        rp.setPipeline(pipeline);
        rp.setBindGroup(0, bind);
        rp.draw(4);
        rp.end();
      };

      const g = this.gpu;
      // The model next, so the main pass reads this frame's curves. Its
      // answer is eased over about a tenth of a second to stop flicker; after
      // a seek or a new video it's taken as is.
      if (mode && (newFrame || !this.netAt)) {
        const dt = (now - this.netAt) / 1000;
        this.run.encode(enc, sl.view, wasReset || !this.netAt ? 1 : 1 - Math.exp(-Math.min(dt, 0.25) / 0.1), fit);
        this.netAt = now;
      }
      pass(this.lv[0], g.down1, sl.bgDown1, tq && { querySet: tq.set, beginningOfPassWriteIndex: 0 });
      for (let i = 0; i < this.bgDown.length; i++) pass(this.lv[i + 1], g.down, this.bgDown[i]);
      pass(this.sv[1 - this.si], g.scene, this.bgScene[this.si]);
      this.si = 1 - this.si;
      if (big) big.run(pass, sl);
      pass(this.ctx.getCurrentTexture().createView(), g.main, (big ? big.src : sl).bgMain[this.si], tq && { querySet: tq.set, endOfPassWriteIndex: 1 });
      let readback = null;
      if (tq) {
        readback = tq.free.pop() || device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        enc.resolveQuerySet(tq.set, 0, 2, tq.resolve, 0);
        enc.copyBufferToBuffer(tq.resolve, 0, readback, 0, 16);
      }
      device.queue.submit([enc.finish()]);
      if (readback) {
        tq.out++;
        readback.mapAsync(GPUMapMode.READ).then(() => {
          const ns = new BigInt64Array(readback.getMappedRange().slice(0));
          readback.unmap();
          tq.out--;
          if (this.dead) { readback.destroy(); return; }
          tq.free.push(readback);
          const ms = Number(ns[1] - ns[0]) / 1e6;
          if (!(ms >= 0 && ms < 2000)) return;
          this.hitches.gpuWork(ms);
          this.recentWork.push(ms);
          if (this.recentWork.length > 20) this.recentWork.shift();
        }, () => { tq.out--; try { readback.destroy(); } catch (e) {} });
      }
      this.needsDraw = false;
      this.drawError = '';

      // For the report: how long issuing the frame took.
      this.win.draw = Math.max(this.win.draw, performance.now() - began);
      this.submits++;
    }

    // The GPU time a frame's work takes at the size now being drawn (ms): the
    // middle one of the last few timings, so one slow frame doesn't decide
    // anything. -1 if it isn't known.
    gpuWork() {
      const w = this.recentWork;
      return w.length >= 5 ? [...w].sort((x, y) => x - y)[w.length >> 1] : -1;
    }

    // What's needed to time a frame on the GPU, made on first use. Returns
    // null while too many answers are still outstanding.
    timer() {
      if (!this.tq) {
        const { device } = this.gpu;
        this.tq = {
          set: device.createQuerySet({ type: 'timestamp', count: 2 }),
          resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          free: [], out: 0,
        };
      }
      return this.tq.out < 8 ? this.tq : null;
    }

    // A plain-text account of the last few minutes, for pasting into a bug
    // report: one line per three-second measurement window, then the hitches.
    report() {
      const v = this.video, c = this.canvas;
      return [
        `Timings for ${nameOf(v)} while CONVERTING: ${v.videoWidth}x${v.videoHeight}, player ${v.offsetWidth}x${v.offsetHeight}, drawn at ${c.width}x${c.height}` +
          (settings.perf === 'auto'
            ? `, auto level ${this.effLevel()} (budget allows ${this.budgetLevel()})${this.busy ? ' (busy page)' : ''}${this.limited ? ' (frames lost outside the GPU)' : ''}`
            : `, performance fixed at ${settings.perf}`) +
          `, video frame rate ${this.srcFps ? this.srcFps.toFixed(1) : 'not known yet'}, upscaling ${this.upLine()}` +
          `, original ${this.hidden ? this.hidden.mode : 'visible'}, GPU: ${this.gpu.name}, measuring began ${(this.born / 1000).toFixed(0)} s after the page loaded`,
        ...this.rows(),
        ...this.easeLines(),
      ];
    }

    // The times the extension eased off for the decoder (see EASE_SLOW).
    easeLines() {
      const n = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
      const lines = [`Frames of the video still waiting on the GPU each time a new one was taken: ${this.heldSeen.map((c, i) => `${i}${i === 8 ? '+' : ''}: ${c}`).join(', ')}.`];
      if (!this.eases.length) {
        lines.push(`Easing off for the decoder: not needed. Decode time now: ${n(this.procNow)} ms a frame (usual for this video: ${n(this.procBase || NaN)}).`);
        lines.push(...this.beatLines(), ...this.paceLines());
        return lines;
      }
      const t = performance.now();
      lines.push(`Easing off for the decoder: ${this.eases.length} time${this.eases.length === 1 ? '' : 's'}. Decode time now: ${n(this.procNow)} ms a frame (usual for this video: ${n(this.procBase || NaN)}).`,
        '    time   at half rate  decode time before  at the end  rested  outcome');
      for (const r of this.eases.slice(-25)) {
        const live = r.worked == null;
        lines.push(`${(((r.at - this.born) / 1000).toFixed(1) + 's').padStart(8)}${(((live ? Math.max(0, (this.steerAt || t) - r.at) : r.ms) / 1000).toFixed(1) + ' s').padStart(15)}` +
          `${((r.dropping ? 'drops, ' : '') + n(r.procBefore) + ' ms').padStart(20)}${(n(live ? this.procNow : r.procAfter) + ' ms').padStart(12)}` +
          `${(r.rested ? 'yes' : 'no').padStart(8)}  ${live ? 'still going' : (r.worked ? 'the decoder caught up' : 'did not help')}`);
      }
      lines.push(...this.beatLines(), ...this.paceLines());
      return lines;
    }

    // Pacing, what the GPU thread's answers showed, and how the two kinds of
    // running compare (see pacer.js).
    paceLines() {
      const secs = (i) => (this.paceMs[i] / 1000).toFixed(0);
      const times = (c) => `${c} time${c === 1 ? '' : 's'}`;
      const off = !paceHere ? ' (it is only used on Windows)' : (!settings.pace ? ' (switched off in the popup)' : (abOn ? ' for the A/B test just now' : ''));
      if (paceError) return [`Pacing the browser's drawing: failed (${paceError}).`];
      const lines = [SDR2HDR_PACER.paceLine(paceOn(), off)];
      if (this.paceMs[1] > 1000) {
        lines.push(`  With pacing on: ${secs(1)} s of playing, a beat held ${times(this.paceBeats[1])}, the decoder dropped ${this.paceDrops[1]}. ` +
          `With pacing off: ${secs(0)} s, a beat held ${times(this.paceBeats[0])}, the decoder dropped ${this.paceDrops[0]}.`);
      }
      lines.push(...SDR2HDR_PACER.askLines(this.born, this.beats));
      const moves = mouseLog.filter((m) => m[0] >= this.born);
      if (moves.length) {
        const on = moves.filter((m) => m[1]).length;
        lines.push(`The mouse started moving ${moves.length} time${moves.length === 1 ? '' : 's'} (${on} with pacing on, ${moves.length - on} with it off): ` +
          moves.slice(-60).map((m) => `${((m[0] - this.born) / 1000).toFixed(0)}s${m[1] ? '' : ' off'}`).join(', ') + '.');
      }
      return lines;
    }

    // The times one refresh was held for the screen queue (see BEAT_AGE).
    beatLines() {
      const n = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
      const usual = `The GPU usually has a copy done in ${n(this.gpuUsual || NaN)} ms.`;
      if (!this.beats.length) return [`Holding a beat for the screen queue: not needed. ${usual}`];
      const done = this.beats.filter((r) => r.cleared != null);
      const lines = [`Holding a beat for the screen queue: ${this.beats.length} time${this.beats.length === 1 ? '' : 's'}, ${done.filter((r) => r.cleared).length} of ${done.length} cleared it. ${usual}`,
        '    time  copy waiting  decode time before   after  at half rate  pacing  GPU thread showed  outcome'];
      for (const r of this.beats.slice(-30)) {
        lines.push(`${(((r.at - this.born) / 1000).toFixed(1) + 's').padStart(8)}${(n(r.oldest) + ' ms').padStart(14)}${(n(r.procBefore) + ' ms').padStart(20)}${(n(r.procAfter) + ' ms').padStart(8)}` +
          `${(r.half ? 'yes' : 'no').padStart(14)}${(r.paced ? 'on' : 'off').padStart(8)}${(r.seen || '-').padStart(19)}  ${r.cleared == null ? 'too soon to say' : (r.cleared ? 'cleared' : 'did not clear')}`);
      }
      return lines;
    }

    destroy(reason = '') {
      if (this.dead) return;
      this.dead = true;
      note(`${nameOf(this.video)}: stopped converting${reason ? `, because ${reason}` : ''}`);
      keepRun('converting', this);
      // Written to cope with a session that never finished setting up, where
      // some of these don't exist yet.
      clearTimeout(this.badgeTimer);
      if (this.raf) cancelAnimationFrame(this.raf);
      clearTimeout(this.mid);
      if (this.onPlaying) this.video.removeEventListener('playing', this.onPlaying);
      if (this.ro) this.ro.disconnect();
      if (this.onMeta) this.video.removeEventListener('loadedmetadata', this.onMeta);
      if (this.onSeek) this.video.removeEventListener('seeked', this.onSeek);
      this.video.removeEventListener('pause', this.onPaused);
      this.stopMeter();
      this.drawnOk = false;
      this.syncHide();                 // dead now, so this puts the original back
      try { this.ctx.unconfigure(); } catch {}
      this.dropRun();
      for (const sl of this.slots || []) sl.tex.destroy();
      this.dropUp();
      this.dropNN();
      for (const t of this.textures || []) t.destroy();
      for (const b of [this.ubuf, this.sbuf]) if (b) b.destroy();
      if (this.tq) {
        this.tq.set.destroy();
        for (const b of [this.tq.resolve, ...this.tq.free]) b.destroy();
      }
      for (const el of [this.canvas, this.badge, this.knob, this.pop]) if (el) el.remove();
      if (sessions.get(this.video) === this) sessions.delete(this.video);
      syncDiag();
    }
  }

  // A video that isn't being converted, measured the same way, so that what
  // the browser does on its own can be set beside what happens with the
  // overlay. Only while Stats is on: it costs a callback per frame.
  class Probe extends Meter {
    constructor(video, why) {
      super();
      this.video = video;
      this.why = why;
      this.dead = false;
      this.initMeter();
      this.onFrame = (now, meta) => {
        if (this.dead) return;
        video.requestVideoFrameCallback(this.onFrame);
        if (meta) this.noteFrame(now, meta);
        this.countFrame();
      };
      // A new video in the same player: its frame rate has to be found again.
      this.onMeta = () => { this.srcFps = 0; this.mediaAt = null; this.gaps = []; };
      video.addEventListener('loadedmetadata', this.onMeta);
      video.requestVideoFrameCallback(this.onFrame);
      note(`${nameOf(video)}: measuring it without converting`);
    }

    report() {
      const v = this.video;
      return [
        `Timings for ${nameOf(v)} while NOT converting (${this.why}): ${v.videoWidth}x${v.videoHeight}, player ${v.offsetWidth}x${v.offsetHeight}` +
          `, video frame rate ${this.srcFps ? this.srcFps.toFixed(1) : 'not known yet'}, measuring began ${(this.born / 1000).toFixed(0)} s after the page loaded`,
        ...this.rows(),
      ];
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      keepRun('plain', this);
      this.stopMeter();
      this.video.removeEventListener('loadedmetadata', this.onMeta);
      if (probes.get(this.video) === this) probes.delete(this.video);
      syncDiag();
    }
  }

  // Runs that have ended stay in the report for a while, so that "play it
  // with the extension off, then on" gives one report with both in it.
  const ended = [];
  function keepRun(kind, m) {
    try {
      if (!m.hitches) return;
      const sum = m.hitches.summary();
      if (sum.playS < 5) return;
      ended.push({ kind, at: Date.now(), sum, lines: m.report() });
      if (ended.length > 4) ended.shift();
    } catch {}
  }

  // With Stats on, the runs measured on this page are also saved every few
  // seconds, and runs saved by the page before a reload are read back. The
  // start of a video, straight after the page loads, is where the stutter
  // has been, and comparing that with and without converting takes a reload
  // in between.
  const pageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let carried = [];
  let savedAt = 0;
  try {
    chrome.storage.local.get({ diagRuns: [] }, (r) => {
      const all = Array.isArray(r.diagRuns) ? r.diagRuns : [];
      carried = all.filter((x) => x && x.site === SITE && x.page !== pageId && Date.now() - x.at < 30 * 60000).slice(-4);
    });
  } catch {}
  // Rarely, and in the page's idle time: putting the report together and
  // storing it takes a few milliseconds, and done every few seconds in the
  // middle of playback it cost a frame each time (seen as a hitch every six
  // seconds in a report). It is also done when the video pauses and when the
  // page is left, which is when it matters.
  function saveRuns(now = false) {
    const t = performance.now();
    if (!settings.stats || window !== top) return;
    if (!now) {
      if (t - savedAt < 20000) return;
      savedAt = t;
      requestIdleCallback(() => saveRuns(true), { timeout: 4000 });
      return;
    }
    savedAt = t;
    const mine = ended.map((e) => ({ ...e }));
    for (const [kind, map] of [['converting', sessions], ['plain', probes]]) {
      for (const m of map.values()) {
        try {
          if (m.dead || !m.hitches) continue;
          const sum = m.hitches.summary();
          if (sum.playS >= 5) mine.push({ kind, at: Date.now(), ver: chrome.runtime.getManifest().version, sum, lines: m.report() });
        } catch {}
      }
    }
    if (!mine.length) return;
    for (const x of mine) { x.site = SITE; x.page = pageId; }
    try { chrome.storage.local.set({ diagRuns: [...carried, ...mine].slice(-8) }); } catch {}
  }

  window.addEventListener('pagehide', () => { saveRuns(true); if (selfTest) selfTestStop('abandoned: the page was closed'); });
  // A self-test that never got to put its settings back (the browser was
  // closed, or crashed): its first half-minute has converting switched off
  // for every site, and that must not be how things are left. Anything still
  // switched off 40 seconds after a self-test began was abandoned.
  if (window === top) {
    try {
      chrome.storage.local.get({ selfTestWas: null, enabled: true }, (g) => {
        const w = g && g.selfTestWas;
        if (!w || selfTest) return;
        const age = Date.now() - (w.at || 0);
        if ((g.enabled === false && age > 40000) || age > 300000) {
          chrome.storage.local.set({ enabled: w.enabled !== false, stats: !!w.stats });
          chrome.storage.local.remove('selfTestWas');
        }
      });
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveRuns(true); });

  // Whether the browser decodes 4K 60 on the graphics card or on the
  // processor, for the two kinds of video YouTube sends at that size. Asked
  // once; the answer is for the report.
  let decodeCaps = '';
  function askDecoding() {
    if (decodeCaps || !navigator.mediaCapabilities) return;
    decodeCaps = 'no answer yet';
    const kinds = [['VP9', 'video/webm; codecs="vp09.00.51.08"'], ['AV1', 'video/mp4; codecs="av01.0.13M.08"']];
    Promise.all(kinds.map(([name, type]) => navigator.mediaCapabilities
      .decodingInfo({ type: 'media-source', video: { contentType: type, width: 3840, height: 2160, bitrate: 25e6, framerate: 60 } })
      .then((r) => `${name} ${!r.supported ? 'not supported' : (r.powerEfficient ? 'on the graphics card' : 'on the PROCESSOR')}${r.supported && !r.smooth ? ', not smoothly' : ''}`,
        () => `${name} unknown`)))
      .then((a) => { decodeCaps = a.join('; '); });
  }

  // The deeper measuring (diag.js) and the timer-lag watch only run while
  // there is a video to measure.
  function syncDiag() {
    const any = sessions.size + probes.size > 0;
    watchLag(any);
    if (any) askDecoding();
    SDR2HDR_DIAG.setDeep(any && !!settings.stats && !document.hidden);
  }

  // A video file served from another site, without that site's say-so, can be
  // played but not read: the browser marks it "tainted". The say-so is a pair
  // of response headers. When the user has switched on unlocking for this
  // site, the background script adds those headers to media this page loads,
  // and the video is reloaded in the mode that asks for them. Position, speed
  // and play state are carried across the reload. If the video won't load that
  // way, it's put back exactly as it was.
  async function tryUnlock(v) {
    const src = v.currentSrc;
    if (!v.isConnected || !src || unlockTried.get(v) === src) return;
    unlockTried.set(v, src);

    let reply = null;
    try { reply = await chrome.runtime.sendMessage({ type: 'sdr2hdr-unlock' }); } catch (e) { reply = { error: e.message }; }
    if (!reply || !reply.ok) { log('could not unlock this video:', reply && reply.error); return; }

    const was = { time: v.currentTime, paused: v.paused, rate: v.playbackRate, attr: v.getAttribute('crossorigin') };
    const resume = () => {
      try { v.currentTime = was.time; } catch {}
      v.playbackRate = was.rate;
      if (!was.paused) v.play().catch(() => {});
    };
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('error', onError, true);
    };
    const onLoaded = () => {
      done();
      resume();
      blocked.delete(v);
      locked.delete(v);
      log('video unlocked');
      scan();
    };
    const onError = () => {
      done();
      log('this video will not load in readable mode; putting it back as it was');
      if (was.attr == null) v.removeAttribute('crossorigin'); else v.setAttribute('crossorigin', was.attr);
      v.addEventListener('loadedmetadata', resume, { once: true });
      v.load();
    };
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('error', onError, true);     // capture: errors on <source> children don't bubble
    timer = setTimeout(onError, 15000);
    v.crossOrigin = 'use-credentials';              // keep cookies, so logged-in video still loads
    v.load();
  }

  const hideMode = () => (settings.hideOriginal ? 'invisible' : 'off');
  // With Stats on, Alt+Shift+O switches it without leaving fullscreen.
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !settings.stats || !e.altKey || !e.shiftKey || e.code !== 'KeyO' || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { chrome.storage.local.set({ hideOriginal: !settings.hideOriginal }); } catch {}
  }, true);
  // ... and Alt+Shift+P switches checking on every refresh.
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !settings.stats || !e.altKey || !e.shiftKey || e.code !== 'KeyP' || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { chrome.storage.local.set({ poll: !settings.poll }); } catch {}
  }, true);
  // With Stats on, Alt+Shift+A starts a test of pacing (see pacer.js): it is
  // switched off and on again in 30-second turns, so a few minutes of playing
  // compares the two under the same conditions, and the report adds up each
  // one's share.
  let abOn = false;
  let abFlip = false;
  let abTimer = 0;
  // Only on Windows: the hand-over it is about is Windows' own.
  const paceHere = /Windows/.test(navigator.userAgent);
  const paceOn = () => paceHere && !!settings.pace && !(abOn && abFlip);
  let paceError = '';
  const drawMode = () => (settings.poll ? 'queue' : 'callbacks');
  const abMark = () => {
    for (const s of sessions.values()) {
      if (s.hitches) s.hitches.mark(markLabel(s));
      s.updateBadge();
    }
  };
  // So that the mouse gets moved the same in every turn of the test, a sound
  // says when to wiggle it: twice a turn, 8 and 19 seconds in (the player's
  // controls stay up for a few seconds after, and a jam it sets off needs
  // time to play out before the turn ends).
  let cueTimers = [];
  const abCues = () => {
    for (const t of cueTimers) clearTimeout(t);
    cueTimers = [];
    if (!abOn) return;
    for (const at of [8000, 19000]) {
      cueTimers.push(setTimeout(() => {
        if (!abOn || document.hidden) return;
        let ok = false;
        try { ok = settings.cue !== 'off' && SDR2HDR_CUE.play(settings.cue); } catch (err) {}
        if (selfTest) fakeWiggle();
        let w = 'off';
        for (const s of sessions.values()) w = paceWord(s);
        note(`wiggle cue ${at / 1000} s into the turn${ok ? '' : ' (no sound)'}, pacing ${w}`);
      }, at));
    }
  };
  // Start or stop the A/B test.
  const abSet = (on) => {
    abOn = on;
    // Which comes first is left to chance, so that the start of a run doesn't always count against the same one.
    abFlip = abOn && Math.random() < 0.5;
    clearInterval(abTimer);
    if (abOn) abTimer = setInterval(() => { abFlip = !abFlip; abMark(); abCues(); }, 30000);
    note(`A/B test ${abOn ? `started: pacing on and off, 30 seconds each in turn, ${abFlip ? 'off' : 'on'} first` : 'stopped'}`);
    abMark();
    // The key press is what lets the page make the sound later.
    try { SDR2HDR_CUE.wake(); } catch (err) {}
    abCues();
  };

  // The whole test, run by itself (Alt+Shift+T, top page only): half a
  // minute with converting off for comparison, then six turns of the A/B
  // test, with the mouse moved for you at every cue; a bell when it is done,
  // and the report on the clipboard if the browser allows it (the popup's
  // Report button otherwise). Go fullscreen and start the video first.
  //
  // The mouse it moves is a made-up one: mouse events sent to the player, so
  // that its controls come up as they do for a real one. Whether they did is
  // noted each time (on YouTube, by looking at the player).
  let selfTest = null;
  const fakeWiggle = () => {
    const v = [...sessions.keys(), ...probes.keys()][0] || document.querySelector('video');
    if (!v) return;
    const r = v.getBoundingClientRect();
    let i = 0;
    const step = () => {
      const x = r.left + r.width * (0.3 + 0.04 * i), y = r.top + r.height * (0.5 + 0.02 * (i % 3));
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, movementX: 8, movementY: 3, view: window };
      for (let el = document.elementFromPoint(x, y) || v, n = 0; el && n < 1; n++) {
        try { el.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse', pointerId: 1 })); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousemove', init)); } catch (e) {}
      }
      if (++i < 10) setTimeout(step, 150);
      else {
        const p = v.closest('.html5-video-player');
        note(`made-up mouse moved${p ? `; the player's controls ${p.classList.contains('ytp-autohide') ? 'did NOT come up' : 'came up'}` : ''}`);
      }
    };
    step();
  };
  const selfTestStop = (why) => {
    if (!selfTest) return;
    for (const t of selfTest.timers) clearTimeout(t);
    const was = selfTest.was || { stats: true, enabled: true };
    selfTest = null;
    if (abOn) abSet(false);
    // Finished: Stats stays on, because the report it was all for is deeper
    // with it on and has yet to be copied. Stopped or abandoned: as it was.
    try {
      chrome.storage.local.set(why === 'finished' ? { enabled: was.enabled } : { enabled: was.enabled, stats: was.stats });
      chrome.storage.local.remove('selfTestWas');
    } catch (e) {}
    note(`self-test ${why}${why === 'finished' && !was.stats ? '; Stats is left on for the report, switch it off in the settings when done' : ''}`);
    for (const s of sessions.values()) s.updateBadge();
  };
  const selfTestStart = () => {
    selfTest = { timers: [], phase: 'converting off, for comparison' };
    const at = (ms, f) => selfTest.timers.push(setTimeout(() => { if (selfTest) f(); }, ms));
    note('self-test started: 30 s with converting off, then six 30-second turns of the A/B test');
    try { SDR2HDR_CUE.wake(); SDR2HDR_CUE.play('double'); } catch (e) {}
    // What the two settings it changes were, kept in storage too, so that
    // they can be put back even if this page is closed part-way (selfTestUndo).
    selfTest.was = { stats: !!stored.stats, enabled: stored.enabled !== false };
    try { chrome.storage.local.set({ stats: true, enabled: false, selfTestWas: { at: Date.now(), ...selfTest.was } }); } catch (e) {}
    at(10000, fakeWiggle);
    at(20000, fakeWiggle);
    at(30000, () => {
      selfTest.phase = 'A/B test';
      try { chrome.storage.local.set({ enabled: true }); } catch (e) {}
    });
    at(33000, () => abSet(true));
    at(33000 + 6 * 30000 + 500, () => {
      selfTestStop('finished');
      try { SDR2HDR_CUE.play('bell'); setTimeout(() => SDR2HDR_CUE.play('bell'), 700); } catch (e) {}
      measureRefresh().then((hz) => {
        const text = buildReport(hz);
        try { chrome.storage.local.set({ selfTestReport: { at: Date.now(), text } }); } catch (e) {}
        try { navigator.clipboard.writeText(text).then(() => note('self-test: report copied to the clipboard'), () => note('self-test: could not copy the report by itself; use the Report button')); } catch (e) {}
      });
    });
  };
  window.addEventListener('keydown', (e) => {
    // Only keys the user pressed: a page can make up key events of its own,
    // and these shortcuts change settings for every site.
    if (!e.isTrusted || !e.altKey || !e.shiftKey || e.repeat) return;
    if (e.code === 'KeyT' && window === top) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (selfTest) selfTestStop('stopped by hand'); else selfTestStart();
      return;
    }
    // (A test that is running can always be stopped, Stats on or not.)
    if (e.code !== 'KeyA' || !(settings.stats || abOn)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    abSet(!abOn);
  }, true);
  // What pacing is doing for a video at this moment. It counts as on only
  // while its worker is really at it: wanted and not (yet) running is not on,
  // and neither is a video with too few frames a second to be paced.
  const paceWord = (s) => {
    if (!paceOn()) return 'off';
    if (paceError || SDR2HDR_PACER.why()) return 'not possible';
    if (s && !s.paceFits) return 'not used';
    return SDR2HDR_PACER.pacing() ? 'on' : 'not running';
  };
  // What the report files hitches under while settings are being tried.
  const markLabel = (s) => `original ${hideMode()}, ${drawMode()}, pacing ${paceWord(s)}`;
  // For the badge.
  const paceState = (s) => { const w = paceWord(s); return w === 'not possible' ? 'NOT POSSIBLE HERE' : w; };
  // Pacing starting, stopping or turning out not to be possible on this page
  // shows in the badge and changes what the report files things under.
  try {
    SDR2HDR_PACER.onChange(() => { for (const s of sessions.values()) { if (s.hitches) s.hitches.mark(markLabel(s)); s.updateBadge(); } });
  } catch (e) {
    paceError = `${e.name}: ${e.message}`;
  }

  const isActive = () => settings.enabled && !siteOff && hdrDisplay.matches && !gpuFailed;
  let lastVideoCount = -1;

  // Videos can hide inside shadow roots (custom player elements), which a
  // plain querySelectorAll doesn't reach. Finding the roots means visiting
  // every element on the page, which on a big page is long enough to cost a
  // video frame if done in one go. So it's done in the browser's idle time, a
  // slice at a time, and the roots found are kept until the next pass.
  const shadowOf = (el) => {
    try {
      return chrome.dom && chrome.dom.openOrClosedShadowRoot
        ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };
  let roots = [];
  let walking = false;
  let lastWalk = -Infinity;
  function refreshRoots() {
    walking = true;
    const found = [];
    const todo = [document];        // documents / shadow roots still to look through
    let list = null, i = 0;
    const slice = (deadline) => {
      // Normally use what idle time there is. If the page never goes idle the
      // browser calls us anyway after the timeout; take a few ms then.
      const until = performance.now() + (deadline.didTimeout ? 4 : Math.max(1, deadline.timeRemaining() - 1));
      for (;;) {
        if (!list) {
          const node = todo.pop();
          if (!node) break;
          list = node.querySelectorAll('*');
          i = 0;
        }
        while (i < list.length) {
          if ((i & 63) === 0 && performance.now() > until) {
            requestIdleCallback(slice, { timeout: 2000 });
            return;
          }
          const sr = shadowOf(list[i++]);
          if (sr) { found.push(sr); todo.push(sr); }
        }
        list = null;
      }
      roots = found;
      walking = false;
      lastWalk = performance.now();
    };
    requestIdleCallback(slice, { timeout: 2000 });
  }
  function allVideos() {
    // Less often once a video is being converted: new players rarely appear
    // mid-playback.
    if (!walking && performance.now() - lastWalk > (sessions.size ? 30000 : 5000)) refreshRoots();
    const vids = [...document.querySelectorAll('video')];
    for (const r of roots) vids.push(...r.querySelectorAll('video'));
    return vids;
  }

  function scan() {
    scanVideos();
    syncDiag();
    saveRuns();
  }

  function scanVideos() {
    const active = isActive();
    for (const v of [...locked]) if (!v.isConnected) locked.delete(v);     // gone from the page: let it go
    for (const [v, s] of [...sessions]) {
      if (s.dead) { sessions.delete(v); continue; }
      const why = whyNot(v, false);
      if (why) { lastWhy.set(v, why); s.destroy(why); continue; }
      // The page has taken the overlay off (some rebuild the player around
      // the video). Start again; the original is put back meanwhile.
      if (!s.canvas.isConnected) { s.destroy('the page removed the overlay'); continue; }
      // The page has moved the video somewhere else and left the overlay
      // behind, where it would go on drawing while the video sat invisible in
      // its new place. Start again beside it.
      if (s.canvas.parentNode !== v.parentNode) { s.destroy('the page moved the video'); continue; }
      s.layout();
      s.perfTick();
      // A video that has been drawing fine for a while gets a clean slate: an
      // earlier passing failure shouldn't count against it for ever.
      if (s.submits > 300 && blocked.has(v)) blocked.delete(v);
      if (modelWanted()) ensureModel(s.gpu);
      s.syncLoop();
      // After a resize the canvas needs drawing again. During playback the
      // next frame does that, but a paused video has no next frame.
      if (s.needsDraw) s.render();
    }
    for (const [v, p] of [...probes]) {
      if (!settings.stats || !v.isConnected || sessions.has(v) || v.offsetWidth < MIN_SIZE) p.destroy();
      else p.measure();
    }
    // Nothing to find in a tab nobody is looking at. With the extension off
    // there's nothing to do either, unless Stats is on: then videos are
    // measured as they are.
    if (document.hidden || (!active && !settings.stats)) return;

    const vids = allVideos();
    if (vids.length !== lastVideoCount) {
      lastVideoCount = vids.length;
      note(`${vids.length} video element${vids.length === 1 ? '' : 's'} on the page`);
    }
    for (const v of vids) {
      if (sessions.has(v)) continue;
      const why = whyNot(v, true);
      noteWhy(v, why);
      if (why) {
        // Not for a reason that's about to pass, or a video too small to matter.
        const p = probes.get(v);
        if (p) p.why = why;
        else if (settings.stats && v.requestVideoFrameCallback && v.videoWidth && v.offsetWidth >= MIN_SIZE && !/ yet|hidden|shortly|removed/.test(why)) {
          probes.set(v, new Probe(v, why));
        }
        continue;
      }
      getGpu().then((gpu) => {
        if (sessions.has(v)) return;
        const late = whyNot(v, true);
        if (late) { noteWhy(v, late); return; }
        // The first draw happens inside the constructor. If the video turns
        // out to be unreadable it gives up there and then, so only keep a
        // session that survived it.
        const s = new Session(v, gpu);
        if (!s.dead) {
          sessions.set(v, s);
          if (probes.has(v)) probes.get(v).destroy();
          syncDiag();
          lastWhy.delete(v);
          note(`${nameOf(v)}: converting (${v.videoWidth}x${v.videoHeight}, shown at ${v.offsetWidth}x${v.offsetHeight})`);
        }
        if (modelWanted()) ensureModel(gpu);
      }).catch(() => {});
    }
  }

  function applySettings(next) {
    stored = { ...stored, ...next };
    const site = (stored.sites && stored.sites[SITE]) || {};
    settings = { ...stored };
    if (site.custom) {
      for (const k of ['peak', 'strength', 'sat', 'soften', 'sharpen', 'gamut', 'vivid']) if (typeof site[k] === 'number') settings[k] = site[k];
    }
    siteOff = !!site.off;
    const unlockWas = siteUnlock;
    siteUnlock = !!site.unlock;
    if (siteUnlock && !unlockWas) for (const v of [...locked]) tryUnlock(v);
    if (modelFailed && !(settings.modelInfo && settings.modelInfo.id === modelFailed)) modelFailed = null;
    // The model was removed: let go of the copy on the GPU.
    if (!settings.modelInfo && gpuPromise) {
      gpuPromise.then((gpu) => {
        if (settings.modelInfo || !gpu.model) return;
        for (const s of sessions.values()) s.dropRun();
        gpu.model.destroy();
        gpu.model = null;
      }, () => {});
    }
    scan();
    for (const s of sessions.values()) {
      if (s.hitches) s.hitches.mark(markLabel(s));
      s.updateBadge();
      s.layout();
      s.refresh();
      s.syncHide();
      s.syncLoop();
    }
  }

  // Dragging the split line. Hit testing is done by geometry on window-level
  // capture listeners rather than on an element, so it works even when the
  // site stacks its own layers on top of the video.
  const GRAB = 14;   // px either side of the line
  let drag = null;
  let swallowClick = false;
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  window.addEventListener('pointerdown', (e) => {
    if (!settings.split || e.button !== 0) return;
    for (const s of sessions.values()) {
      const { r, x } = s.splitGeometry();
      if (Math.abs(e.clientX - x) <= GRAB && e.clientY >= r.top && e.clientY <= r.bottom &&
          e.clientX >= r.left - GRAB && e.clientX <= r.right + GRAB) {
        drag = s;
        document.documentElement.style.cursor = 'ew-resize';
        stop(e);
        return;
      }
    }
  }, true);

  window.addEventListener('pointermove', (e) => {
    const pt = performance.now();
    // For the report: when the mouse started moving after being still, and what pacing was doing.
    if (pt - lastPointer > 1500) {
      mouseLog.push([pt, !paceError && SDR2HDR_PACER.pacing()]);
      if (mouseLog.length > 120) mouseLog.shift();
    }
    lastPointer = pt;
    if (!drag) return;
    stop(e);
    settings.splitPos = stored.splitPos = drag.splitFromPointer(e.clientX);
    for (const s of sessions.values()) { s.layout(); s.refresh(); }
  }, true);

  const endDrag = (e) => {
    if (!drag) return;
    stop(e);
    drag = null;
    document.documentElement.style.cursor = '';
    chrome.storage.local.set({ splitPos: settings.splitPos });
    // The release would otherwise count as a click and pause the video.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 100);
  };
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);
  window.addEventListener('click', (e) => { if (swallowClick) stop(e); }, true);

  // The popup asks for live numbers on the video being converted.
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg && msg.type === 'sdr2hdr-report') {
        // Every frame of the tab hears this, and the first answer wins. So
        // the frame with the most to say answers first: one that's converting
        // a video at once, one that has a video shortly after, and the main
        // page as a last resort.
        const delay = sessions.size + probes.size ? 0 : (allVideos().length ? 150 : (window === top ? 400 : -1));
        if (delay < 0) return;
        // A frame with a video in it takes a moment to time the screen first.
        const refresh = sessions.size + probes.size ? measureRefresh() : Promise.resolve(0);
        refresh.then((hz) => setTimeout(() => respond({ text: buildReport(hz) }), delay));
        return true;
      }
      if (!msg || msg.type !== 'sdr2hdr-stats') return;
      if (!sessions.size) {
        // Nothing being converted. If that's because a video here is locked,
        // say so, so the popup can point at the unlock switch.
        for (const v of [...locked]) if (!v.isConnected) locked.delete(v);
        if (locked.size) respond({ locked: true, unlock: siteUnlock });
        return;
      }
      const s = [...sessions.values()].sort((a, b) => b.canvas.width - a.canvas.width)[0];
      // Size the picture itself is drawn at (the canvas also covers any bars).
      const drawn = [0, 1].map((i) => Math.round([s.canvas.width, s.canvas.height][i] * Math.min(1, s.scale[i])));
      respond({
        video: [s.video.videoWidth, s.video.videoHeight],
        drawn,
        fps: s.stats ? s.stats.fps : null,
        drop: s.stats ? s.stats.drop : null,
        gap: s.stats ? s.stats.gap : null,
        poll: settings.poll,
        sides: s.sides(),
        split: settings.split,
        modelFailed: modelWanted() && !!modelFailed,
        level: settings.perf === 'auto' ? s.effLevel() : null,
        busy: settings.perf === 'auto' && s.busy,
        limited: settings.perf === 'auto' && s.limited,
        eased: !!(s.ease && s.ease.half),
        lite: s.quality().lite,
        up: s.upNow ? { kind: s.upNow.kind, want: s.upNow.want, from: s.upNow.from, name: s.upNow.name, why: s.upNow.why } : null,
        paused: s.video.paused,
        gpu: s.gpu.name,
      });
    });
  }

  // The whole report: what the extension can see, every video on the page and
  // why it is or isn't being converted, timings for the ones that are, and
  // the recent history.
  // How often the screen refreshes, by timing a few animation frames. 0 if it
  // can't be told (a hidden tab gets none).
  function measureRefresh() {
    return new Promise((resolve) => {
      const times = [];
      const giveUp = setTimeout(() => resolve(0), 600);
      const tick = (t) => {
        times.push(t);
        if (times.length < 14) { requestAnimationFrame(tick); return; }
        clearTimeout(giveUp);
        const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
        resolve(1000 / gaps[gaps.length >> 1]);
      };
      requestAnimationFrame(tick);
    });
  }

  // The graphics card as WebGL names it, which is usually the full name.
  // WebGPU often gives only the maker, or nothing.
  let glName = null;
  function graphicsCard() {
    if (glName != null) return glName;
    glName = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) glName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {}
    return glName;
  }

  // The latest run with converting set beside the latest without (runs under
  // ten seconds don't count, unless there's nothing else).
  function comparison() {
    const runs = [...carried, ...ended];
    for (const m of sessions.values()) if (!m.dead && m.hitches) runs.push({ kind: 'converting', sum: m.hitches.summary() });
    for (const m of probes.values()) runs.push({ kind: 'plain', sum: m.hitches.summary() });
    const latest = (kind) => {
      const of = runs.filter((r) => r.kind === kind);
      return of.filter((r) => r.sum.playS >= 10).pop() || of.pop();
    };
    const a = latest('converting'), b = latest('plain');
    const secs = (r) => (r ? r.sum.playS.toFixed(0) : '0');
    if (!a || !b || a.sum.playS < 10 || b.sum.playS < 10) {
      return [`Comparison: not possible yet. It needs 10 seconds of the video playing both ways with Stats on; so far ${secs(a)} s converting and ${secs(b)} s not converting.`];
    }
    const per = (r, x) => (x / (r.sum.playS / 60)).toFixed(1);
    const row = (label, f) => `  ${label.padEnd(44)}${String(f(a)).padStart(12)}${String(f(b)).padStart(16)}`;
    return [
      'Comparison, the latest run each way:',
      row('', (r) => (r === a ? 'converting' : 'not converting')),
      row('seconds of playing measured', (r) => r.sum.playS.toFixed(0)),
      row('hitches a minute', (r) => r.sum.hitchesMin.toFixed(1)),
      row('frames the page was never handed', (r) => r.sum.lostPct.toFixed(2) + '%'),
      row('frames that never reached the screen', (r) => r.sum.neverPct.toFixed(2) + '%'),
      row('frames held too long, a minute', (r) => per(r, r.sum.late)),
      row('decoder drops a minute', (r) => r.sum.decoderMin.toFixed(1)),
      row('longest a frame was held (ms)', (r) => r.sum.worst.toFixed(0)),
      '  Only a fair comparison if both runs covered the same stretch of the same video, in the same window size.',
    ];
  }

  // What the decoder has done with this video so far.
  function decoderLine(v) {
    try {
      const q = v.getVideoPlaybackQuality();
      return q.totalVideoFrames ? `, decoded ${q.totalVideoFrames} frames and dropped ${q.droppedVideoFrames}` : '';
    } catch {
      return '';
    }
  }

  function buildReport(refreshHz = 0) {
    const lines = [
      `Headroom HDR ${chrome.runtime.getManifest().version} report, ${new Date().toLocaleString()}`,
      `page: ${SITE}${window === top ? '' : ` (in a frame from ${location.hostname})`}, fullscreen: ${document.fullscreenElement ? 'yes' : 'no'}, tab hidden: ${document.hidden ? 'yes' : 'no'}`,
      `extension: ${settings.enabled ? 'on' : 'OFF'}${siteOff ? ', OFF for this site' : ''}${siteUnlock ? ', unlocking on for this site' : ''}`,
      `display: ${screen.width}x${screen.height}, pixel ratio ${window.devicePixelRatio}${refreshHz ? `, refreshing ${Math.round(refreshHz)} times a second` : ''}, HDR as the browser sees it: ${hdrDisplay.matches ? 'yes' : 'NO'}`,
      `WebGPU: ${!navigator.gpu ? 'NOT AVAILABLE on this page' : (gpuFailed ? `FAILED (${gpuError})` : 'available')}`,
      `graphics card: ${graphicsCard() || 'not named by the browser'}`,
      `decoding 4K at 60 frames a second, as the browser describes it: ${decodeCaps || 'not asked yet'}`,
      `machine: ${navigator.hardwareConcurrency || '?'} processor threads${navigator.deviceMemory ? `, ${navigator.deviceMemory} GB of memory or more` : ''}` +
        `, screen ${Math.round(screen.width * devicePixelRatio)}x${Math.round(screen.height * devicePixelRatio)} in real pixels, window ${Math.round(innerWidth * devicePixelRatio)}x${Math.round(innerHeight * devicePixelRatio)}`,
      `deep measuring (the Stats switch): ${settings.stats ? 'on' : 'off'}; ${SDR2HDR_DIAG.screenLine()}`,
      `settings: performance ${settings.perf}, upscaling ${settings.upscale}, drawing ${drawMode()}, pacing ${settings.pace ? (paceHere ? 'on' : 'on (not used: only for Windows)') : 'off'}${abOn ? ' (A/B test running: on and off in turns)' : ''}, hide original ${hideMode()}, method ${settings.method}` +
        `${settings.split ? `, split ${settings.splitLeft}|${settings.splitRight}` : ''}, sharpness ${settings.sharpen}, peak ${settings.peak}` +
        `, model ${settings.modelInfo ? 'loaded' : 'none'}`,
      `browser: ${navigator.brave ? 'Brave. ' : ''}${navigator.userAgent}`,
      '',
      'Videos on the page:',
    ];
    const vids = allVideos();
    for (const v of vids) {
      const s = sessions.get(v);
      const state = s && !s.dead ? 'CONVERTING' : `not converting, because ${whyNot(v, true) || 'it is about to start'}`;
      let transfer = '';
      try {
        const f = new VideoFrame(v);
        transfer = `, colour: ${f.colorSpace.primaries || '?'}/${f.colorSpace.transfer || '?'}, frames: ${f.format || 'opaque'} ${f.codedWidth}x${f.codedHeight}`;
        f.close();
      } catch {}
      lines.push(`  ${nameOf(v)}: ${v.videoWidth}x${v.videoHeight}, shown at ${v.offsetWidth}x${v.offsetHeight}, ` +
        `${v.paused ? 'paused' : 'playing'} at ${v.currentTime.toFixed(0)} s, ready state ${v.readyState}${transfer}` +
        `${v.mediaKeys ? ', DRM' : ''}, source ${(v.currentSrc || 'none').split(':')[0]}${decoderLine(v)}: ${state}`);
    }
    if (!vids.length) lines.push('  none found');
    let measured = 0;
    for (const m of [...sessions.values(), ...probes.values()]) {
      if (m.dead) continue;
      lines.push('', ...m.report());
      measured++;
    }
    for (const e of ended) {
      lines.push('', `Earlier run, ended ${new Date(e.at).toLocaleTimeString()}:`, ...e.lines);
      measured++;
    }
    for (const e of carried) {
      lines.push('', `Earlier run, from before this page was loaded (last saved ${new Date(e.at).toLocaleTimeString()}, ${e.ver ? `version ${e.ver}` : 'version not recorded'}):`, ...e.lines);
      measured++;
    }
    lines.push('', ...comparison());
    if (measured) {
      lines.push(
        '',
        'time: seconds since measuring started. pos: place in the video. fps: new frames drawn a second.',
        'drop: share of the video\'s frames never drawn. gap: longest wait between two drawn frames (ms).',
        'late: longest delay between a frame going on screen and the page being told (ms).',
        'draw: longest time the extension took to issue one frame (ms). gpu: longest time the GPU took to finish copying a frame of the video (ms).',
        'proc: longest time the browser took to decode a frame (ms), where it says.',
        'busy: share of the time the page was stuck in long tasks. lag: longest the page kept a 100 ms timer waiting (ms).',
        'dec: frames the video decoder itself dropped.',
        'ahead: seconds of video buffered. fs: fullscreen.',
        ...Sdr2hdrHitches.legend(),
      );
    }
    lines.push('', 'History (newest last):');
    for (const e of events) {
      lines.push(`  ${new Date(e.t).toLocaleTimeString()}  ${e.text}${e.n > 1 ? `  (x${e.n})` : ''}`);
    }
    if (!events.length) lines.push('  nothing yet');
    return lines.join('\n');
  }

  note(`started on ${SITE}${window === top ? '' : ' (in a frame)'}`);
  chrome.storage.local.get(DEFAULTS, applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = {};
    for (const k in changes) if (k in DEFAULTS) next[k] = changes[k].newValue;
    // Other things are kept in storage too (the model, saved reports), and a
    // change to those is no reason to redraw every video on every page.
    if (Object.keys(next).length) applySettings(next);
  });

  document.addEventListener('fullscreenchange', () => {
    for (const m of [...sessions.values(), ...probes.values()]) if (m.hitches) m.hitches.event('fullscreen');
    scan();
  });
  document.addEventListener('visibilitychange', scan);
  hdrDisplay.addEventListener('change', scan);   // window moved to another monitor
  setInterval(scan, 1000);
})();
