// Finds <video> elements, and for each one draws an HDR canvas on top of it.
// Frames go: video -> WebGPU external texture -> shaders -> rgba16float canvas
// with extended tone mapping (values above 1.0 light up the HDR headroom).
(() => {
  if (window.__sdr2hdrLoaded) return;
  window.__sdr2hdrLoaded = true;

  const DEFAULTS = { enabled: true, peak: 4, strength: 0.5, sat: 1.15, soften: 0.5, sharpen: 0.35, gamut: 0.5, vivid: 0.5,
    split: false, splitPos: 0.5, badge: true,
    headroom: 0,   // display maximum from the calibration page; 0 = not calibrated
    sites: {},     // per-site overrides, keyed by hostname
  };
  const MIN_SIZE = 200;   // ignore thumbnails / tiny previews (CSS px)
  const MAX_DIM = 3840;   // cap canvas backing size
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
  let lastPointer = 0;
  let gpuPromise = null;
  let gpuFailed = false;
  const sessions = new Map();      // video -> Session
  const blocked = new WeakMap();   // video -> currentSrc we refused to process
  const hdrDisplay = matchMedia('(dynamic-range: high)');

  const log = (...a) => console.info('[SDR to HDR]', ...a);

  async function initGpu() {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this page');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => log('GPU error:', e.error.message));

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
    return { device, sampler, down1, down, scene, main };
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
  function isHdrSource(video) {
    try {
      const f = new VideoFrame(video);
      const t = f.colorSpace && f.colorSpace.transfer;
      f.close();
      return t === 'pq' || t === 'hlg';
    } catch {
      return false;
    }
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

      this.onMeta = () => { this.reset = true; this.layout(); };
      this.onSeek = () => { this.reset = true; };
      video.addEventListener('loadedmetadata', this.onMeta);
      video.addEventListener('seeked', this.onSeek);

      this.onFrame = () => {
        if (this.dead) return;
        this.render();
        if (!this.dead) this.video.requestVideoFrameCallback(this.onFrame);
      };

      this.layout();
      this.render();
      if (!this.dead) video.requestVideoFrameCallback(this.onFrame);
    }

    updateBadge() {
      this.badge.style.display = settings.badge ? 'flex' : 'none';
      this.badge.style.opacity = this.badgeDim ? '.4' : '.95';
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

      const dpr = window.devicePixelRatio || 1;
      let bw = w * dpr, bh = h * dpr;
      const k = Math.min(1, MAX_DIM / Math.max(bw, bh));
      bw = Math.max(1, Math.round(bw * k));
      bh = Math.max(1, Math.round(bh * k));
      if (c.width !== bw) c.width = bw;
      if (c.height !== bh) c.height = bh;

      const va = v.videoWidth / v.videoHeight, ea = w / h;
      let sx = 1, sy = 1;
      if (cs.objectFit === 'cover') {
        if (va > ea) sx = va / ea; else sy = ea / va;
      } else if (cs.objectFit !== 'fill') {      // contain (the default)
        if (va > ea) sy = ea / va; else sx = va / ea;
      }
      this.scale = [sx, sy];

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
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      clearTimeout(this.badgeTimer);
      this.ro.disconnect();
      this.video.removeEventListener('loadedmetadata', this.onMeta);
      this.video.removeEventListener('seeked', this.onSeek);
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

  const isActive = () => settings.enabled && !siteOff && hdrDisplay.matches && !gpuFailed;

  // Videos can hide inside shadow roots (custom player elements), which a
  // plain querySelectorAll doesn't reach. Walking the whole page for shadow
  // roots is the slow part, so that's refreshed every few seconds and the
  // roots are cached in between.
  const shadowOf = (el) => {
    try {
      return chrome.dom && chrome.dom.openOrClosedShadowRoot
        ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };
  let roots = [];
  let rootsAt = -Infinity;
  function findRoots(node, out) {
    for (const el of node.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (sr) { out.push(sr); findRoots(sr, out); }
    }
  }
  function allVideos() {
    const now = performance.now();
    if (now - rootsAt > 3000) {
      rootsAt = now;
      roots = [];
      findRoots(document, roots);
    }
    const vids = [...document.querySelectorAll('video')];
    for (const r of roots) vids.push(...r.querySelectorAll('video'));
    return vids;
  }

  function scan() {
    const active = isActive();
    for (const [v, s] of [...sessions]) {
      // The HDR check runs every scan, so switching quality to or from an
      // HDR stream mid-video is picked up within a second.
      if (!active || !v.isConnected || !eligible(v) || isHdrSource(v)) s.destroy();
      else s.layout();
    }
    if (!active) return;

    for (const v of allVideos()) {
      if (sessions.has(v) || !eligible(v) || isHdrSource(v)) continue;
      getGpu().then((gpu) => {
        if (sessions.has(v) || !isActive() || !v.isConnected || !eligible(v) || isHdrSource(v)) return;
        sessions.set(v, new Session(v, gpu));
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
    scan();
    for (const s of sessions.values()) {
      s.updateBadge();
      s.layout();
      s.render();   // repaint paused videos too
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

  chrome.storage.local.get(DEFAULTS, applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = {};
    for (const k in changes) if (k in DEFAULTS) next[k] = changes[k].newValue;
    applySettings(next);
  });

  document.addEventListener('fullscreenchange', scan);
  hdrDisplay.addEventListener('change', scan);   // window moved to another monitor
  setInterval(scan, 1000);
})();
