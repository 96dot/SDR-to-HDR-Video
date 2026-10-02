// Finds <video> elements, and for each one draws an HDR canvas on top of it.
// Frames go: video -> WebGPU external texture -> shaders -> rgba16float canvas
// with extended tone mapping (values above 1.0 light up the HDR headroom).
(() => {
  if (window.__sdr2hdrLoaded) return;
  window.__sdr2hdrLoaded = true;

  const DEFAULTS = { enabled: true, peak: 4, strength: 0.5, sat: 1.15, soften: 0.5, sharpen: 0.35, gamut: 0.5, vivid: 0.5,
    perf: 'auto',  // 'auto', 'best' or 'fast'
    timing: 'video',   // when to draw: 'video' = once per video frame, 'screen' = on every screen refresh
    split: false, splitPos: 0.5, badge: true,
    stats: false,  // show live numbers in the badge, for diagnosing stutter
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
  let gpuPromise = null;
  let gpuFailed = false;
  const sessions = new Map();      // video -> Session
  const blocked = new WeakMap();   // video -> currentSrc we refused to process
  const locked = new Set();        // videos the browser won't let us read (see tryUnlock)
  const unlockTried = new WeakMap();   // video -> currentSrc we've already tried to unlock
  const hdrDisplay = matchMedia('(dynamic-range: high)');

  const log = (...a) => console.info('[SDR to HDR]', ...a);

  async function initGpu() {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this page');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => log('GPU error:', e.error.message));
    // Which GPU the browser gave us. On laptops with two GPUs, Chrome on
    // Windows uses one for everything, usually the integrated one, so this
    // is the first thing to check when 4K playback stutters.
    const info = adapter.info || {};
    const name = [info.vendor, info.architecture].filter(Boolean).join(' ') || info.description || 'unknown';
    log('rendering on GPU:', name);

    const make = (code, vsEntry) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: vsEntry },
        fragment: { module, entryPoint: 'fs', targets: [{ format: FMT }] },
        primitive: { topology: 'triangle-strip' },
      });
    };
    const [down1, down, scene, main] = await Promise.all([
      make(SDR2HDR_DOWN1, 'vsFull'),
      make(SDR2HDR_DOWN, 'vsFull'),
      make(SDR2HDR_SCENE, 'vsFull'),
      make(SDR2HDR_MAIN, 'vs'),
    ]);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    device.lost.then((info) => {
      log('GPU device lost:', info.message);
      gpuPromise = null;
      for (const s of [...sessions.values()]) s.destroy();
    });
    return { device, sampler, down1, down, scene, main, name };
  }

  function getGpu() {
    if (!gpuPromise) {
      gpuPromise = initGpu().catch((e) => {
        gpuFailed = true;
        log('disabled:', e.message);
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

  function eligible(v) {
    return v.videoWidth > 0 &&
      v.offsetWidth >= MIN_SIZE &&
      !v.mediaKeys &&                       // DRM: frames are not readable
      blocked.get(v) !== v.currentSrc;
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
      'background:rgba(40,32,70,.38);border:1px solid rgba(255,255,255,.32);' +
      'backdrop-filter:blur(10px) saturate(1.4);-webkit-backdrop-filter:blur(10px) saturate(1.4);' +
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
      'background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);' +
      'backdrop-filter:blur(10px) saturate(1.4);-webkit-backdrop-filter:blur(10px) saturate(1.4);' +
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

  class Session {
    constructor(video, gpu) {
      this.video = video;
      this.gpu = gpu;
      this.dead = false;
      this.reset = true;        // snap the scene average on the first frame
      this.box = null;          // last laid-out size: { w, h, sx, sy }
      this.needsDraw = false;   // canvas was resized and hasn't been redrawn at the new size yet
      this.resetAuto();
      this.lastPresented = null;  // the browser's running count of frames presented
      this.win = { t0: performance.now(), rendered: 0, gap: 0, p0: 0, q0: 0, dirty: true };   // first window is warm-up
      this.frameAt = 0;         // when the last new video frame was drawn
      this.fresh = false;       // screen timing: a new video frame is waiting to be drawn
      this.raf = 0;
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
      this.updateBadge();

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

      this.udata = new Float32Array(20);
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

      this.onMeta = () => { this.reset = true; this.resetAuto(); this.layout(); };
      this.onSeek = () => { this.reset = true; };
      video.addEventListener('loadedmetadata', this.onMeta);
      video.addEventListener('seeked', this.onSeek);
      this.onDisturb = () => { this.win.dirty = true; };
      this.disturbances = ['pause', 'play', 'seeking', 'waiting', 'ratechange', 'loadedmetadata'];
      for (const e of this.disturbances) video.addEventListener(e, this.onDisturb);
      document.addEventListener('visibilitychange', this.onDisturb);

      // Two ways to time the drawing (the "Frame timing" setting).
      // 'video': draw when the browser says a new video frame is up. Least
      // work, but the canvas then updates at the video's rhythm, a beat after
      // the video itself.
      // 'screen': draw on every screen refresh, new frame or not, so the
      // canvas updates at one steady rhythm. The video-frame callback then
      // only notes that a new frame has arrived.
      this.onFrame = (now, meta) => {
        if (this.dead) return;
        if (meta) this.lastPresented = meta.presentedFrames;
        if (settings.timing === 'screen') {
          this.fresh = true;
        } else {
          this.render();
          this.countFrame();
        }
        if (!this.dead) this.video.requestVideoFrameCallback(this.onFrame);
      };
      this.onTick = () => {
        this.raf = 0;
        if (this.dead || settings.timing !== 'screen') return;
        // A paused video is only redrawn when it shows a new frame (a seek).
        if (!this.video.paused || this.fresh) {
          this.render();
          if (this.fresh) { this.fresh = false; this.countFrame(); }
        }
        if (!this.dead) this.raf = requestAnimationFrame(this.onTick);
      };

      this.layout();
      this.render();
      if (!this.dead) video.requestVideoFrameCallback(this.onFrame);
      this.syncLoop();
    }

    // Start the every-refresh loop if the setting asks for it. It stops by
    // itself when the setting changes back.
    syncLoop() {
      if (!this.dead && settings.timing === 'screen' && !this.raf) this.raf = requestAnimationFrame(this.onTick);
    }

    // A new video frame has just been drawn: count it, and keep the longest
    // wait between two of them.
    countFrame() {
      const t = performance.now(), w = this.win;
      w.rendered++;
      if (this.frameAt) w.gap = Math.max(w.gap, t - this.frameAt);
      this.frameAt = t;
    }

    // Auto-quality state, started afresh for every new video.
    resetAuto() {
      this.level = 0;           // index into LEVELS when perf is 'auto'
      this.bad = 0;             // consecutive measurement windows with too many drops
      this.holdUntil = 0;       // no judging until this time, after a level change
      this.baseline = null;     // { drop, fps } at full quality, before the first step down
      this.autoDone = false;    // nothing further to try for this video
      this.busy = false;        // lowering quality didn't help: the page, not the GPU, is the limit
    }

    quality() {
      if (settings.perf === 'best') return LEVELS[0];
      if (settings.perf === 'fast') return LEVELS[2];
      return LEVELS[this.level];
    }

    // Canvas backing size, in real pixels, for a given quality level.
    backingSize(q) {
      const { w, h, sx, sy } = this.box;
      const v = this.video;
      const dpr = window.devicePixelRatio || 1;
      const bw = w * dpr, bh = h * dpr;
      let k = Math.min(1, q.maxDim / Math.max(bw, bh));
      if (settings.perf !== 'best') {
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
      const c = this.canvas;
      for (let l = this.level + 1; l < LEVELS.length; l++) {
        const [bw, bh] = this.backingSize(LEVELS[l]);
        if (LEVELS[l].lite !== LEVELS[this.level].lite || bw * bh < c.width * c.height * 0.9) return l;
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
      const v = this.video, w = this.win, t = performance.now();
      if (t - w.t0 < 3000) return;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const decoded = q ? q.totalVideoFrames : 0;
      const presented = this.lastPresented == null ? w.p0 : this.lastPresented;
      const expected = Math.max(presented - w.p0, decoded - w.q0, w.rendered);
      // A window with a pause, seek, buffering or a hidden tab in it says
      // nothing about performance, so it's thrown away. So is anything played
      // faster than normal speed, where skipping frames is expected.
      const clean = !w.dirty && !v.paused && !v.seeking && !document.hidden && v.playbackRate <= 1;
      this.win = { t0: t, rendered: 0, gap: 0, p0: presented, q0: decoded, dirty: false };
      if (!clean || expected < 30) return;

      const drop = 1 - w.rendered / expected;
      const fps = w.rendered / ((t - w.t0) / 1000);
      this.stats = { fps, drop, gap: w.gap };
      if (settings.stats) this.updateBadge();
      if (settings.perf !== 'auto' || this.autoDone || !this.box || t < this.holdUntil) return;

      // Two bad windows in a row, so a one-off hitch doesn't cost quality for
      // the rest of the video.
      this.bad = drop > 0.08 ? this.bad + 1 : 0;
      if (this.bad < 2) return;
      this.bad = 0;

      const next = this.nextLevel();
      if (next >= 0) {
        if (!this.baseline) this.baseline = { drop, fps };
        this.level = next;
        this.holdUntil = t + 6000;       // give the new level time to show its effect
        log(`dropping ${Math.round(drop * 100)}% of frames, lowering quality to level ${next}`);
        this.layout();
        return;
      }

      // Already at the lowest level and still dropping frames. If it's no
      // better than where we started, the GPU was never the problem: the page
      // is too busy to run our frame callback on time. Lower quality buys
      // nothing then, so go back to full quality and leave it there.
      this.autoDone = true;
      const b = this.baseline;
      if (b && !(drop <= b.drop * 0.7 || fps >= b.fps * 1.15)) {
        this.busy = true;
        this.level = 0;
        log('lower quality did not reduce dropped frames; restoring full quality (the page is the bottleneck)');
        this.layout();
      }
    }

    // What the badge says. With "Stats on video" on it carries live numbers,
    // so they can be read in fullscreen, where the popup can't be opened:
    // new video frames drawn per second, the share of the video's frames that
    // were never drawn, the longest wait between two frames, the size drawn
    // at, and the frame timing in use.
    badgeText() {
      if (!settings.stats) return 'HDR';
      const st = this.stats, c = this.canvas;
      const parts = ['HDR'];
      if (st) {
        parts.push(`${Math.round(st.fps)} fps`, `${Math.round(st.drop * 100)}% dropped`, `longest gap ${Math.round(st.gap)} ms`);
      } else {
        parts.push(this.video.paused ? 'paused' : 'measuring');
      }
      parts.push(`${c.width}x${c.height}`, settings.timing === 'screen' ? 'screen timing' : 'video timing');
      return parts.join(' \u00b7 ');
    }

    updateBadge() {
      const b = this.badge, stats = settings.stats;
      b.style.display = settings.badge || stats ? 'flex' : 'none';
      // With stats on, the badge stays readable instead of fading.
      const dim = this.badgeDim && !stats;
      b.style.opacity = dim ? '.4' : '.95';
      b.style.background = stats ? 'rgba(24,18,44,.78)' : 'rgba(40,32,70,.38)';
      b.style.letterSpacing = stats ? '.02em' : '.08em';
      // The frosted-glass blur makes the browser re-filter what's behind the
      // badge on every video frame. Once the badge has faded it's barely
      // visible anyway, so drop it for the rest of playback.
      const glass = this.badgeDim || stats ? 'none' : 'blur(10px) saturate(1.4)';
      b.style.backdropFilter = glass;
      b.style.webkitBackdropFilter = glass;
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

      // After a resize the canvas is left holding a stale picture at the old
      // size until something draws again (see needsDraw).
      const [bw, bh] = this.backingSize(this.quality());
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
        this.needsDraw = true;
      }

      // Split handle sits on the line, halfway down the video.
      const kn = this.knob;
      kn.style.left = (left + w * (0.5 + (settings.splitPos - 0.5) * sx)) + 'px';
      kn.style.top = (top + h / 2) + 'px';
      kn.style.zIndex = z;
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

    block() {
      blocked.set(this.video, this.video.currentSrc);
      this.destroy();
    }

    render() {
      const v = this.video;
      if (this.dead || v.readyState < 2 || !v.videoWidth) return;
      this.updateClip();

      const { device, sampler } = this.gpu;
      let ext;
      try {
        ext = device.importExternalTexture({ source: v });
      } catch (e) {
        // Cross-origin video without CORS, or protected content.
        log('cannot read this video:', e.message);
        this.block();
        if (e.name === 'SecurityError') {
          locked.add(v);
          if (siteUnlock) tryUnlock(v);
        }
        return;
      }

      const now = performance.now();
      const s = this.sdata;
      s[0] = this.reset ? 1 : 0;
      s[1] = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      this.reset = false;
      device.queue.writeBuffer(this.sbuf, 0, s);

      const u = this.udata;
      u[0] = this.scale[0];
      u[1] = this.scale[1];
      u[2] = 1 / v.videoWidth;
      u[3] = 1 / v.videoHeight;
      u[4] = settings.peak;
      u[5] = settings.strength;
      u[6] = settings.sat;
      u[7] = settings.split ? 1 : 0;
      u[8] = Math.random();
      u[9] = settings.splitPos;
      // Not calibrated: assume the display can show whatever Peak is set to.
      u[10] = settings.headroom > 0 ? settings.headroom : settings.peak;
      u[11] = settings.soften;
      // Sharpening taps sit one pixel apart, in whichever of source or screen
      // pixels is bigger: source pixels when the video is being upscaled,
      // screen pixels when it's being shrunk.
      u[12] = Math.max(u[2], 1 / (this.canvas.width * this.scale[0]));
      u[13] = Math.max(u[3], 1 / (this.canvas.height * this.scale[1]));
      u[14] = settings.sharpen;
      u[15] = settings.gamut;
      u[16] = settings.vivid;
      u[17] = this.quality().lite ? 1 : 0;
      device.queue.writeBuffer(this.ubuf, 0, u);

      const enc = device.createCommandEncoder();
      const draw = (view, pipeline, bind) => {
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(4);
        pass.end();
      };

      const g = this.gpu;
      draw(this.lv[0], g.down1, this.group(g.down1, [sampler, ext]));
      for (let i = 0; i < this.bgDown.length; i++) draw(this.lv[i + 1], g.down, this.bgDown[i]);
      draw(this.sv[1 - this.si], g.scene, this.bgScene[this.si]);
      this.si = 1 - this.si;
      draw(this.ctx.getCurrentTexture().createView(), g.main, this.group(g.main, [
        { buffer: this.ubuf }, sampler, ext, ...this.lv, this.sv[this.si],
      ]));
      device.queue.submit([enc.finish()]);
      this.needsDraw = false;
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      clearTimeout(this.badgeTimer);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.ro.disconnect();
      this.video.removeEventListener('loadedmetadata', this.onMeta);
      this.video.removeEventListener('seeked', this.onSeek);
      for (const e of this.disturbances) this.video.removeEventListener(e, this.onDisturb);
      document.removeEventListener('visibilitychange', this.onDisturb);
      try { this.ctx.unconfigure(); } catch {}
      for (const t of this.textures) t.destroy();
      this.ubuf.destroy();
      this.sbuf.destroy();
      this.canvas.remove();
      this.badge.remove();
      this.knob.remove();
      if (this.pop) this.pop.remove();
      sessions.delete(this.video);
    }
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

  const isActive = () => settings.enabled && !siteOff && hdrDisplay.matches && !gpuFailed;

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
    const active = isActive();
    for (const [v, s] of [...sessions]) {
      if (s.dead) { sessions.delete(v); continue; }
      if (!active || !v.isConnected || !eligible(v) || isHdrSource(v)) { s.destroy(); continue; }
      s.layout();
      s.perfTick();
      // After a resize the canvas needs drawing again. During playback the
      // next frame does that, but a paused video has no next frame.
      if (s.needsDraw) s.render();
    }
    // Nothing to find in a tab nobody is looking at.
    if (!active || document.hidden) return;

    for (const v of allVideos()) {
      // readyState 2 = there is a current frame, which the HDR check needs:
      // without one it can't tell, and would wave an HDR video through.
      if (sessions.has(v) || !eligible(v) || v.readyState < 2 || isHdrSource(v)) continue;
      getGpu().then((gpu) => {
        if (sessions.has(v) || !isActive() || !v.isConnected || !eligible(v) || isHdrSource(v)) return;
        // The first draw happens inside the constructor. If the video turns
        // out to be unreadable it gives up there and then, so only keep a
        // session that survived it.
        const s = new Session(v, gpu);
        if (!s.dead) sessions.set(v, s);
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
    scan();
    for (const s of sessions.values()) {
      s.updateBadge();
      s.layout();
      s.render();   // repaint paused videos too
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
    lastPointer = performance.now();
    if (!drag) return;
    stop(e);
    settings.splitPos = stored.splitPos = drag.splitFromPointer(e.clientX);
    for (const s of sessions.values()) { s.layout(); s.render(); }
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
        timing: settings.timing,
        level: settings.perf === 'auto' ? s.level : null,
        busy: settings.perf === 'auto' && s.busy,
        lite: s.quality().lite,
        paused: s.video.paused,
        gpu: s.gpu.name,
      });
    });
  }

  chrome.storage.local.get(DEFAULTS, applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = {};
    for (const k in changes) if (k in DEFAULTS) next[k] = changes[k].newValue;
    applySettings(next);
  });

  document.addEventListener('fullscreenchange', scan);
  document.addEventListener('visibilitychange', scan);
  hdrDisplay.addEventListener('change', scan);   // window moved to another monitor
  setInterval(scan, 1000);
})();
