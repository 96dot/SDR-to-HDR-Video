// Diagnostics for tracking down stutter. Nothing here draws anything.
//
// Two parts. SDR2HDR_DIAG watches the page as a whole: when its thread was
// stuck in long tasks and, in deep mode, whether the page's screen updates
// arrived on time. Sdr2hdrHitches watches one video: every frame the browser
// hands over is compared with the one before it, and anything that would be
// seen as a stutter is written down along with whatever else was going on at
// that moment. The report puts the two together.

const SDR2HDR_DIAG = (() => {
  // ---- Long tasks: stretches over 50 ms when the page's thread was busy ----
  const longTasks = [];            // { start, end }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({ start: e.startTime, end: e.startTime + e.duration });
        if (longTasks.length > 400) longTasks.shift();
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {}

  // Total time in [a, b] covered by the spans in a list.
  const overlap = (spans, a, b) => {
    let ms = 0;
    for (const s of spans) {
      const lo = Math.max(a, s.start), hi = Math.min(b, s.end);
      if (hi > lo) ms += hi - lo;
    }
    return ms;
  };

  // ---- Deep mode: time every screen update the page gets ----
  //
  // The page is offered one animation frame per screen refresh. When they
  // arrive late, the whole page's picture is late (not just the video), and
  // the cause is outside the video: the page's thread, or the browser's
  // compositor and graphics process. When they keep arriving on time while
  // the video's frames go missing, the cause is in the video's own path.
  let deep = false;
  let rafId = 0;
  let prev = 0;
  let skip = true;                 // the next gap says nothing (just started, or the tab was hidden)
  let interval = 0;                // ms between refreshes, once measured
  let sample = [];
  const stalls = [];               // { start, end }: gaps well over one refresh
  const totals = { refreshes: 0, late: 0, worst: 0, since: 0 };

  const tick = (t) => {
    rafId = requestAnimationFrame(tick);
    if (prev && !skip) {
      const gap = t - prev;
      totals.refreshes++;
      sample.push(gap);
      if (sample.length >= 61) {
        // Near the short end of a second's worth: the screen's own rhythm is
        // the fastest steady one, and late frames can't drag this up.
        interval = sample.sort((x, y) => x - y)[6];
        sample = [];
      }
      if (interval && gap > interval * 1.7) {
        totals.late++;
        totals.worst = Math.max(totals.worst, gap);
        stalls.push({ start: prev + interval, end: t });
        if (stalls.length > 400) stalls.shift();
      }
    }
    skip = document.hidden;
    prev = t;
  };
  document.addEventListener('visibilitychange', () => { skip = true; });

  // When the mouse last moved. Players show their controls for a few seconds
  // after that, drawn over the video, which is extra work for the browser.
  let pointerAt = -1e9;
  window.addEventListener('pointermove', () => { pointerAt = performance.now(); }, { capture: true, passive: true });

  function setDeep(on) {
    if (on === deep) return;
    deep = on;
    if (on) {
      skip = true;
      prev = 0;
      sample = [];
      Object.assign(totals, { refreshes: 0, late: 0, worst: 0, since: performance.now() });
      stalls.length = 0;
      rafId = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafId);
    }
  }

  return {
    setDeep,
    get deep() { return deep; },
    get interval() { return deep ? interval : 0; },
    get pointerAt() { return pointerAt; },
    busyBetween: (a, b) => overlap(longTasks, a, b),
    stalledBetween: (a, b) => (deep ? overlap(stalls, a, b) : NaN),
    screenLine() {
      if (!deep) return 'screen updates: not watched (switch on Stats in the popup to watch them)';
      if (!interval) return 'screen updates: watching, nothing measured yet';
      const secs = (performance.now() - totals.since) / 1000;
      return `screen updates: ${totals.refreshes} watched over ${secs.toFixed(0)} s, one every ${interval.toFixed(1)} ms; ` +
        `${totals.late} arrived late${totals.late ? ` (longest wait ${totals.worst.toFixed(0)} ms)` : ''}`;
    },
  };
})();

// One video's frames, watched one by one.
//
// Words used here and in the report:
//   held   how long a frame stayed on screen before the next one (ms)
//   lost   frames of the video that the page was never handed
//   shown  how many of those the browser itself did put on screen. For a
//          video that isn't being converted those were seen as normal. For a
//          converted video they were not: the overlay can only draw frames
//          it is told about.
class Sdr2hdrHitches {
  constructor(born) {
    this.born = born;
    this.clear();
  }

  clear() {
    this.last = null;
    this.list = [];                // hitches, explained
    this.pending = [];             // hitches waiting for the facts around them to come in
    this.frames = 0;
    this.lost = 0;
    this.shown = 0;
    this.decoder = 0;
    this.playMs = 0;
    this.spacing = [0, 0, 0, 0, 0]; // frames held for 1, 2, 3, 4-5, 6+ frame times
    this.worst = 0;
    this.count = 0;
    this.causes = {};
    this.evAt = -1e9;
    this.evName = '';
    this.sizeAt = -1e9;
    this.sizeWhat = '';
    this.gpu = [];                 // { at, ms }: how long until the GPU said frames submitted at `at` were done
    this.work = [];                // ms of GPU work per frame, timed on the GPU itself
    this.nearMouse = 0;            // hitches within 4 s of the mouse moving
    // The same tallies again, per setting being tried (see mark).
    this.seg = { label: '', playMs: 0, count: 0, lost: 0, shown: 0, dec: 0, near: 0 };
    this.segs = [this.seg];
    this.undrawn = 0;
  }

  // Something happened to the video that explains irregular frames around it.
  event(name) {
    this.evAt = performance.now();
    this.evName = name;
  }

  // A setting under test has changed: what follows is counted separately, so
  // one run can try several settings one after another.
  mark(label) {
    if (this.seg.label === label) return;
    this.settle(performance.now(), true);
    if (!this.seg.label && !this.seg.playMs) this.seg.label = label;   // nothing measured yet
    else {
      this.seg = { label, playMs: 0, count: 0, lost: 0, shown: 0, dec: 0, near: 0 };
      this.segs.push(this.seg);
      this.list.push({ marker: label });
    }
  }

  // The picture is now being drawn at a different size.
  resized(what) {
    this.sizeAt = performance.now();
    this.sizeWhat = what;
  }

  gpuSample(at, ms) {
    this.gpu.push({ at, ms });
    this.gpuAll = (this.gpuAll || 0) + 1;
    this.gpuMax = Math.max(this.gpuMax || 0, ms);
    if (this.gpu.length > 1200) this.gpu.shift();
  }

  gpuWork(ms) {
    this.work.push(ms);
    this.workAll = (this.workAll || 0) + 1;
    this.workMax = Math.max(this.workMax || 0, ms);
    if (this.work.length > 1200) this.work.shift();
  }

  // Called for every frame the browser hands over. fps is the video's own
  // frame rate, 0 while it isn't known.
  frame(now, md, video, fps) {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const cur = {
      now, disp: md.expectedDisplayTime, media: md.mediaTime, pres: md.presentedFrames,
      dropped: q ? q.droppedVideoFrames : 0,
    };
    const last = this.last;
    this.last = cur;
    this.frames++;
    this.settle(now);
    if (!last || !(fps > 0)) return;

    const held = cur.disp - last.disp;
    const dm = cur.media - last.media;
    // A jump in the video's own clock is a seek or a new video, and the
    // frames just after pausing, playing or seeking are irregular by nature.
    const ev = now - this.evAt < (this.evName === 'ease' ? Math.max(120, 2500 / fps) : this.evName === 'beat' ? Math.max(150, 4000 / fps) : this.evName === 'rest' ? 400 : 1500) ? this.evName : '';
    const quiet = ev && !['waiting', 'fullscreen', 'rest', 'ease', 'beat'].includes(ev);
    if (dm <= 0 || dm > 2 || quiet || !(held > 0)) return;

    const frameMs = 1000 / fps;
    const unit = Math.max(frameMs, SDR2HDR_DIAG.interval);
    const lost = Math.max(0, Math.round(dm * fps) - 1);
    const shown = Math.min(lost, Math.max(0, cur.pres - last.pres - 1));
    const dec = Math.max(0, cur.dropped - last.dropped);
    this.lost += lost;
    this.shown += shown;
    this.decoder += dec;
    this.playMs += Math.min(held, 2000);
    const seg = this.seg;
    seg.lost += lost;
    seg.shown += shown;
    seg.dec += dec;
    seg.playMs += Math.min(held, 2000);
    const k = Math.round(held / unit);
    this.spacing[k <= 1 ? 0 : k === 2 ? 1 : k === 3 ? 2 : k <= 5 ? 3 : 4]++;
    if (!lost && held <= unit * 1.6) return;

    this.worst = Math.max(this.worst, held);
    this.pending.push({
      a: last.now, b: now, pos: cur.media, held, lost, shown, dec, ev, frameMs, seg,
      mouse: (now - SDR2HDR_DIAG.pointerAt) / 1000,
      size: now - this.sizeAt < 700 ? this.sizeWhat : '',
      proc: Number.isFinite(md.processingDuration) ? md.processingDuration * 1000 : NaN,
    });
  }

  // Explain hitches once the facts around them are in: a long task is only
  // reported after it ends, and the GPU's answer for a frame comes later.
  settle(now, all = false) {
    while (this.pending.length && (all || now - this.pending[0].b > 1200)) {
      const h = this.pending.shift();
      h.busy = SDR2HDR_DIAG.busyBetween(h.a, h.b);
      h.stall = SDR2HDR_DIAG.stalledBetween(h.a - 20, h.b + 20);
      h.gpuMs = -1;
      for (const g of this.gpu) if (g.at > h.a - 150 && g.at < h.b + 50) h.gpuMs = Math.max(h.gpuMs, g.ms);
      // The browser's hand-over to Windows stuck at that moment, as its GPU thread showed it (pacer.js).
      h.jam = typeof SDR2HDR_PACER !== 'undefined' && SDR2HDR_PACER.stuckBetween(h.a - 100, h.b + 100);
      // The first that applies. Things that cause the others come first: a
      // busy page or a GPU that's behind makes the decoder drop frames, not
      // the other way round. The columns still show everything measured.
      h.cause =
        h.ev === 'beat' ? 'held a beat' :
        h.ev === 'ease' || h.ev === 'rest' ? 'eased off for the decoder' :
        h.ev === 'waiting' ? 'video stalled' :
        h.ev === 'fullscreen' ? 'fullscreen change' :
        h.size ? `size change to ${h.size}` :
        h.busy > 20 ? 'page busy' :
        h.gpuMs > Math.max(80, h.frameMs * 3) ? 'GPU behind' :
        h.stall > 0 ? 'screen stalled' :
        h.dec ? 'decoder dropped frames' :
        h.lost && h.shown === h.lost ? 'page not told' :
        h.lost ? 'browser skipped' : 'frame held';
      if (h.jam) h.cause += ', hand-over stuck';
      this.count++;
      if (h.mouse < 4) { this.nearMouse++; h.seg.near++; }
      h.seg.count++;
      this.causes[h.cause] = (this.causes[h.cause] || 0) + 1;
      // Hitches one after another with the same cause are one line.
      const p = this.list[this.list.length - 1];
      if (p && !p.marker && p.cause === h.cause && h.a - p.b < 300) {
        p.b = h.b;
        p.n++;
        p.held = Math.max(p.held, h.held);
        p.lost += h.lost;
        p.shown += h.shown;
        p.dec += h.dec;
        p.busy = SDR2HDR_DIAG.busyBetween(p.a, p.b);
        p.stall = SDR2HDR_DIAG.stalledBetween(p.a - 20, p.b + 20);
        p.gpuMs = Math.max(p.gpuMs, h.gpuMs);
        if (Number.isFinite(h.proc)) p.proc = Number.isFinite(p.proc) ? Math.max(p.proc, h.proc) : h.proc;
      } else {
        h.n = 1;
        this.list.push(h);
        if (this.list.length > 150) this.list.shift();
      }
    }
  }

  // Numbers for comparing one run with another.
  summary() {
    this.settle(performance.now(), true);
    const mins = this.playMs / 60000;
    const all = this.frames + this.lost;
    const g = this.gpu.map((x) => x.ms).sort((x, y) => x - y);
    return {
      playS: this.playMs / 1000, frames: this.frames, lost: this.lost, shown: this.shown,
      lostPct: all ? this.lost / all * 100 : 0,
      neverPct: all ? (this.lost - this.shown) / all * 100 : 0,
      hitchesMin: mins ? this.count / mins : 0,
      decoderMin: mins ? this.decoder / mins : 0,
      late: this.spacing.slice(1).reduce((x, y) => x + y, 0),
      onTime: this.spacing[0],
      worst: this.worst,
      gpu: g.length ? { n: g.length, mid: g[g.length >> 1], p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1] } : null,
    };
  }

  report() {
    const s = this.summary();
    const n = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');
    const cell = (x, w) => String(x).padStart(w);
    const spaced = s.onTime + s.late;
    const lines = [
      `Hitches: ${this.count} in ${n(s.playS)} s of playing${s.playS >= 5 ? ` (${n(s.hitchesMin, 1)} a minute)` : ''}. ` +
        `Frames handed over: ${s.frames}. Lost: ${s.lost}, of which the browser itself showed ${s.shown}. Decoder dropped: ${this.decoder}.` +
        (this.undrawn ? ` Handed over but not drawn: ${this.undrawn}.` : ''),
      `Frame spacing: ${spaced ? n(s.onTime / spaced * 100, 1) : '-'}% on time; held for 2 frame times: ${this.spacing[1]}, 3: ${this.spacing[2]}, 4 to 5: ${this.spacing[3]}, longer: ${this.spacing[4]}. Longest hold ${n(s.worst)} ms.`,
    ];
    if (s.gpu) {
      lines.push(`Time until the GPU had copied a frame of the video: typical ${n(s.gpu.mid)} ms, 95 in 100 under ${n(s.gpu.p95)} ms, longest ${n(s.gpu.max)} ms (the latest ${s.gpu.n} frames timed; over all ${this.gpuAll || s.gpu.n} of the run the longest was ${n(Math.max(this.gpuMax || 0, s.gpu.max))} ms).`);
    }
    if (this.work.length) {
      const w = [...this.work].sort((x, y) => x - y);
      lines.push(`GPU work per frame, timed on the GPU itself: typical ${n(w[w.length >> 1], 1)} ms, 95 in 100 under ${n(w[Math.floor(w.length * 0.95)], 1)} ms, longest ${n(w[w.length - 1], 1)} ms (the latest ${w.length} frames timed; over all ${this.workAll || w.length} of the run the longest was ${n(Math.max(this.workMax || 0, w[w.length - 1]), 1)} ms).`);
    }
    if (this.count) lines.push(`${this.nearMouse} of the ${this.count} hitches came within 4 seconds of the mouse moving.`);
    if (this.segs.length > 1 || this.seg.label) {
      lines.push('By setting:', '  ' + 'setting'.padEnd(46) + 'seconds  hitches   lost  of which shown  decoder dropped  near mouse');
      const sums = new Map();
      for (const g of this.segs) {
        const t = sums.get(g.label) || { label: g.label, playMs: 0, count: 0, lost: 0, shown: 0, dec: 0, near: 0, turns: 0 };
        for (const k of ['playMs', 'count', 'lost', 'shown', 'dec', 'near']) t[k] += g[k];
        t.turns++;
        sums.set(g.label, t);
      }
      // A setting that was in force for a moment only (pacing while it is
      // starting, say) and saw nothing is left out.
      const rows = [...sums.values()];
      const worth = rows.filter((g) => g.playMs >= 1000 || g.count || g.lost || g.dec);
      for (const g of worth.length ? worth : rows) {
        lines.push('  ' + (g.label || '(before)').padEnd(46) + cell(n(g.playMs / 1000), 7) + cell(g.count, 9) + cell(g.lost, 7) +
          cell(g.shown, 16) + cell(g.dec, 17) + cell(g.near, 12) + (g.turns > 1 ? `   (${g.turns} turns)` : ''));
      }
    }
    const causes = Object.entries(this.causes).sort((x, y) => y[1] - x[1]);
    if (causes.length) lines.push('Causes: ' + causes.map(([k, c]) => `${c} ${k}`).join(', ') + '.');
    if (this.list.length) {
      const show = this.list.slice(-80);
      if (show.length < this.list.length) lines.push(`The latest ${show.length}:`);
      lines.push('    time     pos    for    n   held  lost  shown  dec   busy  stall    gpu   proc  mouse  cause');
      for (let i = 0; i < show.length; i++) {
        const h = show[i];
        if (h.marker) {
          // Of settings changed one straight after another, only the last is told.
          if (!(show[i + 1] && show[i + 1].marker)) lines.push(`    ---- ${h.marker} ----`);
          continue;
        }
        lines.push([
          cell(n((h.a - this.born) / 1000, 1) + 's', 8), cell(n(h.pos, 1) + 's', 7), cell(n(h.b - h.a), 6), cell(h.n, 4), cell(n(h.held), 6), cell(h.lost, 5),
          cell(h.shown, 6), cell(h.dec, 4), cell(n(h.busy), 6), cell(n(h.stall), 6), cell(h.gpuMs < 0 ? '-' : n(h.gpuMs), 6),
          cell(n(h.proc), 6), cell(h.mouse > 99 ? '-' : n(h.mouse, 1), 6), ' ' + h.cause,
        ].join(' '));
      }
    }
    return lines;
  }

  static legend() {
    return [
      'Hitches: a hitch is a frame of the video that was lost, or one that stayed on screen too long. Each line is one hitch,',
      '  or a run of them one after another with the same cause. for: how long it went on (ms). n: how many hitches are in the line.',
      'held: the longest a frame stayed on screen (ms). lost: frames of the video the page was never handed.',
      'shown: how many of those the browser itself put on screen (seen as normal when not converting; not seen when converting).',
      'dec: frames the decoder dropped in that moment. busy: time the page was stuck in long tasks during it (ms).',
      'stall: time the page\'s own screen updates were late during it (ms; only with Stats on). gpu: longest the GPU took over a frame then (ms).',
      'proc: time the browser took to decode the frame (ms), where it says. mouse: seconds since the mouse last moved (players show their controls for a few seconds after).',
      'cause: held a beat = the screen queue was stuck a frame ahead, so the page was held for one refresh on purpose to let it empty;',
      '  eased off for the decoder = the decoder was falling behind, so every other frame was let go by on purpose;',
      '  video stalled = the player ran dry or the decoder stopped; page not told = the browser showed the frame but did not hand it to the page;',
      '  browser skipped = the frame never reached the screen and nothing else was out of line; frame held = no frame lost, but one stayed up too long;',
      '  ", hand-over stuck" after any of them = at that moment the browser\'s GPU thread showed the hand-over to Windows stuck.',
    ];
  }
}
