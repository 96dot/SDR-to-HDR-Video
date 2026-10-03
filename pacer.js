// Two helpers, both to do with the moment the browser hands a redraw of the
// page to Windows (see BEAT_AGE in content.js for what goes wrong at that
// moment). Each is a worker (pacer-worker.js).
//
// 1. Pacing: getting the browser to hand each redraw over a few milliseconds
// into the screen refresh, instead of right at its start.
//
// Why. Left to itself the browser hands a redraw over about 0.8 ms after each
// screen refresh, which is the very moment Windows is taking the last one. In
// two browser traces, every time the hand-over got stuck it was on a redraw
// handed over at that moment; and in the one stretch where the page's redraws
// happened to reach the browser about 5 ms into each refresh, 36 seconds of
// it, nothing got stuck at all. The aim is to make that late hand-over the
// rule. And if it gets stuck all the same, a hand-over that starts 6 ms into
// the refresh keeps the browser's GPU thread waiting for 10 ms of every 17,
// not 16: the decoder, which runs on that thread, is no longer starved.
//
// How. Before the browser draws a refresh, it waits (for up to two thirds of
// the refresh) for everything in the window that has been told a refresh has
// begun and hasn't answered yet. A canvas drawn from a worker is one of those
// things, even a canvas that is never shown. So a worker draws one dot into
// such a canvas, which makes the browser ask that canvas at the next refresh,
// and then sleeps until LEAD milliseconds into that refresh before letting
// the answer go. The browser draws the page the moment the answer arrives.
// Nothing of this touches the page's own thread, and the canvas, not being
// shown, gives the browser nothing to redraw: when the page has nothing new,
// nothing is drawn, with or without it. (Checked in browser traces on Linux:
// the browser's drawing moved from 0.1 ms to 5.8 ms into the refresh, a page
// with nothing to redraw stayed undrawn, an answer that came too late cost
// that one refresh nothing but the wait, and a worker that hung was ignored
// by the browser after ten refreshes.)
//
// 2. Asking the GPU thread: a worker asks the browser's
// GPU process a question that takes no work to answer, some thirty times a
// second, and times the answer. The answer has to come from the one thread
// that also hands redraws to Windows, so while a hand-over is stuck the
// answer comes when the next screen refresh does, and not before. That shows
// a stuck hand-over directly, the moment it starts, where everything else the
// extension goes by (the decoder slowing, copies coming back late) shows it
// half a second later and at second hand. Every other ask is at the same
// moment of the refresh, to tell stuck from not stuck; the rest go round the
// whole refresh, which shows at what moment the hand-over starts.
//
// Where the workers live. 0.10.10 started them from the page itself, and on
// YouTube that is not allowed: the page's own rules (its content security
// policy) forbid it, so neither ran there. They now run in a frame of the
// extension's own (pacer.html), which is put into the page the first time
// one is wanted: a page's rules don't reach into it, and it belongs to the
// same browser window, which is what pacing needs. The frame is one dot big
// and see-through, in the corner of the window. It is not hidden outright
// (display: none), because the browser treats a process all of whose frames
// are hidden as being in the background, and on Windows gives a background
// process the lowest priority there is and its slowest clock speed: no place
// for workers that have to wake to the millisecond. (Seen in a browser
// trace: hidden, the frame's process was told it was in the background; one
// dot big, it was not.) This file is the page's side: it makes the frame,
// tells the workers how long a screen refresh is and whether they are wanted
// (tick), and keeps what they report. Each worker stops by itself a moment
// after it stops being told.
const SDR2HDR_PACER = (() => {
  const LEAD = 5;          // ms into the refresh at which the browser is let go
  const SHARE = 0.3;       // ... but never later than this share of a refresh (fast displays)
  const WORD = 8;          // the workers are told every this many screen refreshes
  const QUIET = 6000;      // ms: a worker said to be at work reports more often than this (about every two seconds)
  const RETRY = 20000;     // ms: a worker that has given up is started again after this long ...
  const GIVE_UP = 3;       // ... until it has given up this many times

  // The frame: one dot big, see-through, in the corner, out of everything's way.
  const DOT = 'display:block !important;visibility:visible !important;position:fixed !important;left:0 !important;top:0 !important;' +
    'width:1px !important;height:1px !important;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;' +
    'margin:0 !important;padding:0 !important;border:0 !important;opacity:0 !important;pointer-events:none !important;z-index:-1 !important;' +
    'transform:none !important;clip:auto !important;clip-path:none !important;content-visibility:visible !important;';
  let frame = null;        // the frame's element
  let port = null;         // to the frame
  let ready = false;       // the frame has answered
  let made = 0;            // when the frame was made
  let tries = 0;
  let frameWhy = '';       // why there can be no frame, once known

  const helper = (job) => ({ job, why: '', running: false, on: false, word: 0, last: 0, fails: 0, until: 0, note: '' });
  const pacer = helper('pace'), asker = helper('ask');
  let lastNow = 0, tickN = 0;
  let interval = 0;        // the screen's refresh interval (ms), or 0 while it can't be told
  let times = [];
  let changed = null;      // called when what is possible here changes

  // Pacing, as the worker reports it.
  const fresh = () => ({ cycles: 0, late: 0, missed: 0, worst: 0, at: null, over: null, awake: 0, margin: 0, runs: 0, how: '' });
  let tot = fresh();

  // The GPU thread's answers, kept apart for pacing on (1) and off (0).
  const BINS = 17;
  const arm = () => ({
    n: 0, held: 0, fixed: [],
    bins: Array.from({ length: BINS }, () => []),                    // answer times by moment in the refresh, not stuck
    stuckBins: Array.from({ length: BINS }, () => [0, 0]),           // while stuck: asks, and how many waited
  });
  let arms = [arm(), arm()];
  // When pacing started and stopped, so that each answer is counted under what was running when it was asked, not when it was heard.
  let runLog = [[0, false]];
  const pacedAt = (t) => { let r = false; for (const [at, on] of runLog) { if (at <= t) r = on; else break; } return r; };
  let jams = [];           // each time the hand-over was stuck: { at, end, paced, hi, quick }, times as performance.now()
  let open = null;
  const keepSome = (a, x, max) => { if (a.length < max) a.push(x); else a[Math.floor(Math.random() * max)] = x; };

  // A worker has given up. What made it may pass (the computer busy for a
  // moment, a laptop back on mains power): it is started again after a while,
  // and only when it has given up a few times is that the end of it.
  function fail(h, text, final) {
    h.note = text;
    h.fails++;
    if (final || h.fails >= GIVE_UP) h.why = text; else h.until = performance.now() + RETRY;
    if (h === pacer && h.running) runLog.push([performance.now(), false]);
    h.running = false;
    h.on = false;
    if (h === asker && open) { open.end = performance.now(); open = null; }
    if (changed) changed();
  }
  function failFrame(text) {
    frameWhy = text;
    if (frame) { try { frame.remove(); } catch (e) {} }
    frame = port = null;
    ready = false;
    for (const h of [pacer, asker]) { h.running = false; h.on = false; }
    if (open) { open.end = performance.now(); open = null; }
    if (changed) changed();
  }

  function heard(d) {
    if (d.ready) { ready = true; return; }
    const h = d.job === 'pace' ? pacer : d.job === 'ask' ? asker : null;
    if (!h) return;
    h.last = performance.now();
    if (d.fail) { fail(h, d.fail, d.final === true); return; }
    if (d.noFrames) { fail(h, 'screen refreshes do not reach its worker'); return; }
    if ('running' in d) {
      if (h === pacer && d.running && !h.running) tot.runs++;
      const was = h.running;
      h.running = !!d.running;
      if (h === pacer && was !== h.running) { runLog.push([performance.now(), h.running]); if (runLog.length > 40) runLog.shift(); }
      if (was !== h.running && changed) changed();
    }
    const s = d.stats;
    if (s && s.cycles) {
      tot.cycles += s.cycles; tot.late += s.late; tot.missed += s.missed;
      tot.worst = Math.max(tot.worst, s.worst);
      // The picture of how it is going comes from a full batch, not from the few left over when it stops.
      if (s.cycles >= 60 || !tot.at) { tot.at = s.at; tot.over = s.over; tot.awake = s.awake; tot.margin = s.margin; }
      if (typeof s.how === 'string' && s.how) tot.how = s.how;
    }
    const now = performance.now();
    if (d.asks) {
      for (const [age, phase, wait, held, fixed] of d.asks) {
        const a = arms[pacedAt(now - age) ? 1 : 0];
        const bin = Math.max(0, Math.min(BINS - 1, Math.floor(phase)));
        a.n++;
        if (held) a.held++;
        if (fixed) keepSome(a.fixed, wait, 600);
        if (open) {
          a.stuckBins[bin][0]++;
          if (held) a.stuckBins[bin][1]++;
          if (!fixed) { if (held) open.hi = Math.min(open.hi, phase); else if (wait < 1.5 && open.quick.length < 200) open.quick.push(phase); }
        } else if (!held) {
          keepSome(a.bins[bin], wait, 240);
        }
      }
    }
    if ('stuck' in d) {
      const at = now - (d.ago > 0 ? d.ago : 0);
      if (d.stuck && !open) {
        open = { at, end: 0, paced: pacer.running, hi: Infinity, quick: [] };
        jams.push(open);
        if (jams.length > 60) jams.shift();
      } else if (!d.stuck && open) {
        open.end = at;
        open = null;
      }
    }
  }

  // Put the frame into the page.
  function makeFrame() {
    tries++;
    made = performance.now();
    ready = false;
    try {
      const url = chrome.runtime.getURL('pacer.html');
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = DOT;
      f.addEventListener('load', () => {
        if (frame !== f) return;
        try {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => { if (frame === f) heard(e.data || {}); };
          port = ch.port1;
          f.contentWindow.postMessage({ sdr2hdr: 'pacer' }, new URL(url).origin, [ch.port2]);
        } catch (e) {
          failFrame(`its frame could not be reached (${e.name}: ${e.message})`);
        }
      });
      f.src = url;
      (document.documentElement || document.body).appendChild(f);
      frame = f;
    } catch (e) {
      failFrame(`its frame could not be made (${e.name}: ${e.message})`);
    }
  }

  // Tell a worker to stop now, rather than a moment after it stops being told to run.
  function quiet(h) {
    if (!h.on) return;
    h.on = false;
    if (port && ready) port.postMessage({ job: h.job, run: false });
  }

  // Called once per screen refresh while a video fast enough to matter is
  // being converted, with the animation frame's time: pace says whether
  // pacing is wanted now, ask whether the GPU thread is to be asked.
  function tick(now, pace, ask) {
    if (now === lastNow) return;
    const gap = now - lastNow;
    lastNow = now;
    tickN++;
    if (!(gap > 0 && gap < 1000)) { times = []; interval = 0; }      // a pause: measure the screen afresh
    times.push(now);
    if (times.length > 64) times.shift();
    if (times.length >= 16 && tickN % (interval ? 16 : 4) === 0) {
      // The refresh interval: the middle one of the gaps between the last
      // ticks, sharpened by averaging the gaps close to it. Only if the
      // ticks are steady, four in five of them a refresh apart: when the
      // page can't keep up with the screen there is no telling the screen's
      // refreshes from its ticks, and a worker that sleeps through refreshes
      // it should have answered would hold the browser up, not pace it.
      const gaps = [];
      for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > 2 && g < 100) gaps.push(g); }
      const med = gaps.length ? gaps.slice().sort((x, y) => x - y)[gaps.length >> 1] : 0;
      const near = gaps.filter((g) => Math.abs(g - med) < med * 0.12);
      interval = gaps.length >= 12 && near.length >= gaps.length * 0.8 && med > 3.5 && med < 34
        ? near.reduce((x, y) => x + y, 0) / near.length : 0;
    }
    if (frameWhy || !(pace || ask)) { quiet(pacer); quiet(asker); return; }
    if (frame && !frame.isConnected) {
      // The page has taken the frame out. Put it back, a few times.
      frame = port = null;
      ready = false;
      for (const h of [pacer, asker]) { h.running = false; h.on = false; }
      if (tries >= 4) { failFrame('the page keeps removing its frame'); return; }
    }
    if (!frame) { makeFrame(); return; }
    if (!ready) {
      if (performance.now() - made > 5000) failFrame('its frame did not load (the page or the browser does not allow it)');
      return;
    }
    // A worker that says it is at work and has gone quiet is not at work
    // (the process its frame lives in is gone, say): start over with a new frame.
    if ([pacer, asker].some((h) => h.running && performance.now() - h.last > QUIET)) {
      try { frame.remove(); } catch (e) {}
      frame = port = null;
      ready = false;
      for (const h of [pacer, asker]) { h.running = false; h.on = false; }
      if (open) { open.end = performance.now(); open = null; }
      if (changed) changed();
      if (tries >= 4) failFrame('its frame stopped answering');
      return;
    }
    for (const [h, wanted] of [[pacer, pace], [asker, ask]]) {
      if (!wanted || h.why || performance.now() < h.until) { quiet(h); continue; }
      if (!interval) continue;        // not steady: the worker stops by itself if that lasts
      if (h.on && tickN - h.word < WORD) continue;
      h.on = true;
      h.word = tickN;
      port.postMessage({ job: h.job, clock: { interval, lead: Math.min(LEAD, interval * SHARE) } });
    }
  }

  function stop() {
    times = [];
    interval = 0;
    quiet(pacer);
    quiet(asker);
  }

  const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
  const midOf = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
  const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const whyNot = (h) => frameWhy || h.why;

  // For the report: how the pacing itself went.
  function paceLine(wanted, note) {
    const lead = interval ? Math.min(LEAD, interval * SHARE) : LEAD;
    if (whyNot(pacer)) return `Pacing the browser's drawing: not possible here, because ${whyNot(pacer)}.`;
    const gaveUp = pacer.fails ? ` Its worker has given up ${pacer.fails} time${pacer.fails === 1 ? '' : 's'}, the last time because ${pacer.note} (it is started again 20 seconds later, and left alone after the third time).` : '';
    const idle = !frame ? 'on, not started yet' : !ready ? 'on, its frame is still loading'
      : interval ? 'on, not running at this moment' : 'on, but not running: the page\'s animation frames are not steady enough to tell the screen\'s refreshes by';
    if (!tot.cycles) return `Pacing the browser's drawing: ${wanted ? (pacer.running ? 'on, nothing measured yet' : idle) : `off${note}`}.${gaveUp}`;
    return `Pacing the browser's drawing: ${wanted ? (pacer.running ? 'on' : idle) : `off${note}`}. ` +
      `Its worker answered ${tot.cycles} screen refreshes, lately ${n1(tot.at[1])} ms into the refresh (asked for: ${n1(lead)}; 8 in 10 between ${n1(tot.at[0])} and ${n1(tot.at[2])}), ` +
      `late ${tot.late} time${tot.late === 1 ? '' : 's'}, of which too late for the browser to wait ${tot.missed}; ` +
      `its sleeps ran over by ${n1(tot.over[0])} ms as a rule (9 in 10 by less than ${n1(tot.over[1])}), and it was awake for ${n1(tot.awake)} ms of each refresh` +
      `${tot.how ? `; its clock was matched to the time-keeper's ${tot.how}` : ''}.${gaveUp}`;
  }

  // For the report: what the GPU thread's answers showed. t0 is the time
  // (performance.now) that the times in the table count from.
  function askLines(t0, beats) {
    if (whyNot(asker)) return [`Asking the browser's GPU thread: not possible here, because ${whyNot(asker)}.`];
    const gaveUp = asker.fails ? ` Its worker has given up ${asker.fails} time${asker.fails === 1 ? '' : 's'}, the last time because ${asker.note}.` : '';
    if (!arms[0].n && !arms[1].n) return [`Asking the browser's GPU thread: nothing asked yet (it is asked on Windows, or with Stats on, while a video of 45 frames a second or more is being converted).${gaveUp}`];
    const lines = [`The browser's GPU thread, asked for an answer that takes no work, about 30 times a second:${gaveUp}`];
    for (const i of [1, 0]) {
      const a = arms[i];
      if (!a.n) continue;
      lines.push(`  pacing ${i ? 'on ' : 'off'}: asked ${a.n} times; answered in ${n1(midOf(a.fixed, 0.5))} ms as a rule, 19 in 20 within ${n1(midOf(a.fixed, 0.95))} ms; ` +
        `the answer waited for a screen refresh ${a.held} time${a.held === 1 ? '' : 's'} (${(a.held / a.n * 100).toFixed(1)}%)`);
    }
    const head = '  ms into the refresh:      ' + Array.from({ length: BINS - 1 }, (_, b) => String(b).padStart(5)).join('');
    const any = arms.some((a) => a.bins.some((b) => b.length >= 5));
    if (any) {
      lines.push('  How long the answer took by the moment of asking, while the hand-over was not stuck (ms; where the thread is busy at the same moment of every refresh, it shows):', head);
      for (const i of [1, 0]) {
        const a = arms[i];
        if (!a.bins.some((b) => b.length >= 5)) continue;
        for (const [name, f] of [['on average', meanOf], ['9 in 10 within', (b) => midOf(b, 0.9)]]) {
          lines.push(`  pacing ${i ? 'on ' : 'off'}, ${name.padEnd(15)}` + a.bins.slice(0, BINS - 1).map((b) => (b.length >= 5 ? n1(f(b)) : '-').padStart(5)).join(''));
        }
      }
    }
    if (arms.some((a) => a.stuckBins.some((b) => b[0]))) {
      lines.push('  While the hand-over was stuck: of the asks at each moment, how many in ten waited for the next refresh (they wait from the moment the hand-over starts):', head);
      for (const i of [1, 0]) {
        const a = arms[i];
        if (!a.stuckBins.some((b) => b[0])) continue;
        lines.push(`  pacing ${i ? 'on ' : 'off'}${''.padEnd(17)}` + a.stuckBins.slice(0, BINS - 1).map((b) => (b[0] ? String(Math.round(b[1] / b[0] * 10)) : '-').padStart(5)).join(''));
      }
    }
    if (!jams.length) {
      lines.push('  The hand-over stuck, as the GPU thread showed it: never.');
      return lines;
    }
    lines.push(`  The hand-over stuck, as the GPU thread showed it: ${jams.length} time${jams.length === 1 ? '' : 's'}.`,
      '      time    lasted  pacing  hand-over starts  a beat was held');
    for (const j of jams.slice(-30)) {
      const end = j.end || performance.now();
      const lo = Math.max(-1, ...j.quick.filter((p) => p < j.hi));
      const where = Number.isFinite(j.hi) ? `${lo >= 0 ? `${n1(lo)} to ` : 'before '}${n1(j.hi)} ms in` : 'not seen';
      const beat = (beats || []).find((b) => b.at >= j.at - 100 && b.at <= end + 100);
      lines.push(`${(((j.at - t0) / 1000).toFixed(1) + 's').padStart(10)}${(((end - j.at) / 1000).toFixed(1) + ' s' + (j.end ? '' : '+')).padStart(10)}${(j.paced ? 'on' : 'off').padStart(8)}` +
        `${where.padStart(18)}  ${beat ? `${((beat.at - j.at) / 1000).toFixed(2)} s after it began` : 'no'}`);
    }
    return lines;
  }

  return {
    tick,
    stop,
    paceLine,
    askLines,
    pacing: () => pacer.running,
    asking: () => asker.running,
    stuck: () => !!open,
    // For how long the GPU thread has been showing the hand-over stuck (ms), or 0.
    stuckFor: () => (open ? performance.now() - open.at : 0),
    // Why pacing can't be done here, or '' if it can (as far as is known).
    why: () => whyNot(pacer),
    // Was the hand-over stuck, as the GPU thread showed it, at any moment between two times (performance.now)?
    stuckBetween: (a, b) => jams.some((j) => j.at <= b && (j.end || Infinity) >= a),
    onChange: (f) => { changed = f; },
    state: () => ({ frameWhy, ready, pacer, asker, tot, arms, jams: jams.length, interval }),
  };
})();
