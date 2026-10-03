// The worker behind pacer.js. Four of these run in the extension's own frame
// (pacer.html): one paces the browser's drawing, one asks the browser's GPU
// thread, one keeps time for those two, and one does nothing but keep the
// timers of the process fine. What the first two are for is told in pacer.js.
//
// Those two sleep for most of every screen refresh and have to wake at a
// chosen moment of it. Where the refreshes are, they hear from the third,
// whose only work is to take an animation frame for every refresh and pass
// its time on. (The pacing worker can't do that for itself: a worker that
// has just handed a frame of a canvas to the browser and not yet heard back
// is not given its animation frame, and the pacing worker is nearly always
// in that state. Measured: 4 animation frames in 297 refreshes.) How long a
// refresh lasts, and whether to run at all, the page tells them (the frame
// passes that on). Each stops by itself a moment after the page stops
// telling it.
//
// Fine timers. On Windows a sleep ends on a tick of the system's timer, and
// the ticks are 15.6 ms apart unless the process has asked for finer ones
// (1 ms). The browser asks on behalf of a thread only while that thread is
// idle with a short timer pending, and takes the request back the moment the
// thread wakes: so never for a thread in the middle of its work, which is
// where the two sleepers always are (read in the browser's source,
// thread_controller_with_message_pump_impl.cc). Left at that, their sleeps
// would run over by up to 15 ms and they would be of no use. So two other
// threads each keep a short timer pending, which keeps the request standing:
// the time-keeper and a worker that does nothing else. Two, because each
// lets go of it for an instant whenever it wakes. And before a sleeper
// starts, it tries a few sleeps and looks how far they ran over.
'use strict';

const STALE = 1000;      // ms without word from the page: stop (longer than the page is ever held up while a video plays)
const TICK = 3;          // ms: the timer kept pending. Under 4, so the browser counts it as one that needs fine timers whichever of its two rules is in force.
const COARSE = 2.5;      // ms: sleeps that run over by more than this, as a rule, are no use
let ia = null;           // something to sleep on
try { ia = new Int32Array(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer); } catch (e) {}
// The next cycle is asked for through this, so it comes after whatever is
// waiting to be handled. Never more than one is on its way.
const next = new MessageChannel();
let queued = false, timer = 0;
const kick = () => { if (!queued) { queued = true; next.port2.postMessage(0); } };
const again = (ms) => { if (!timer) timer = setTimeout(() => { timer = 0; kick(); }, ms); };
let job = '', ctx = null, gl = null;
let lead = 0, interval = 0, heard = -1e9, running = false, n = 0, keep = 0;
let grid = 0;            // a moment at which a refresh began, as the times heard taken together put it
let seen = -1e9;         // when the time of a refresh was last heard
let looping = false;     // (time-keeper) animation frames are being asked for
let waiting = 0;         // since when no time has been heard, while running
let told = false;        // ... and the page has been told so
let tried = 0;           // how many times the sleeps have been tried, this start
let going = false;       // the sleeps were fine and the page has been told that this worker is at work
const listeners = [];    // (time-keeper) where the times go
// How long before the moment the sleep is asked to end: sleeps run over, by
// up to a millisecond or two, and the rest is waited out awake.
let margin = 1.5;
let overs = [];
const mid = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const sorted = (a) => a.slice().sort((x, y) => x - y);

// Sleeps until the moment given. Returns how long of that was spent awake.
function sleepTo(target) {
  const t = performance.now(), wake = target - margin;
  if (wake - t > 0.3) {
    Atomics.wait(ia, 0, 0, wake - t);
    overs.push(performance.now() - wake);
  }
  const t1 = performance.now();
  while (performance.now() < target) { /* the last moment, awake */ }
  return performance.now() - t1;
}
// Sleeps that run over more than the margin make the worker late; sleeps
// that never do leave time waited out awake for nothing.
function tune() {
  if (overs.length >= 30) margin = Math.max(0.5, Math.min(3, mid(sorted(overs), 0.9) + 0.4));
  if (overs.length > 240) overs = overs.slice(-120);
}
const stale = () => performance.now() - heard > STALE || !(interval > 3);

// ---- keeping the timers fine (see the top of the file) ----
function hold() {
  if (!keep) keep = setInterval(() => { if (stale()) { clearInterval(keep); keep = 0; } }, TICK);
}

// ---- keeping time ----
// Every animation frame says when its screen refresh began. That goes out to
// the two sleepers, together with the moment it is sent.
function onFrame(t) {
  if (!running || stale()) { running = false; looping = false; return; }
  requestAnimationFrame(onFrame);
  const sent = performance.now();
  for (const p of listeners) p.postMessage([t, sent]);
}
// A sleeper hears it here. Every worker has a clock of its own, counting
// from when it was started, so the first thing is how far this one's is from
// the time-keeper's. (performance.timeOrigin would give that without
// measuring, but each worker takes it from the computer's calendar clock
// when it starts, and the calendar clock is nudged about.) It is worked out
// once, before this worker has anything else to do, and never changes after:
// both clocks run off the same one underneath. Two ways, the first if it can
// be had:
// 1. This worker takes a few animation frames of its own. The same refresh
//    is then known on both clocks, and the difference is the answer, give or
//    take whole refreshes, which don't matter here. (The pacing worker can
//    do this now, with nothing drawn yet.)
// 2. Each time heard says when it was sent. It is heard a moment after, or
//    later if this worker was busy, never sooner: so one of the smallest of
//    a dozen differences (not the very smallest: with a rounded clock that
//    would be half a millisecond out). The first moments don't count: what
//    was sent before this worker was up is all heard at once then.
let offset = 0, synced = false, how = '';
let born = 0;            // when this worker was ready to listen
let lastHeard = null;    // the time last heard, on the time-keeper's clock
let framing = false;     // animation frames of this worker's own are being asked for
const pairs = [], lags = [];
function heardFrom(m) {
  const [t, sent] = m.data;
  if (synced) { heardTime(t + offset); return; }
  const now = performance.now();
  lastHeard = t;
  if (now - born < 60) return;
  lags.push(now - sent);
  // The second way, if the first has brought nothing by the time a dozen are in and a second and a half has gone by.
  if (lags.length >= 12 && now - born > 1500 && pairs.length < 3) { offset = sorted(lags)[2]; synced = true; how = 'by the times heard'; }
}
function ownFrame(t) {
  framing = false;
  if (synced) return;
  if (lastHeard !== null && interval > 3) {
    let d = t - lastHeard;
    if (pairs.length) d -= Math.round((d - pairs[0]) / interval) * interval;
    pairs.push(d);
    if (pairs.length >= 8) { offset = mid(sorted(pairs), 0.5); synced = true; how = 'by its own animation frames'; return; }
  }
  frames();
}
function frames() {
  if (framing || synced) return;
  try { requestAnimationFrame(ownFrame); framing = true; } catch (err) {}
}
// A browser may round its clock (Brave can, to a whole millisecond), so the
// times are taken together: the grid of refreshes is moved a fifth of the
// way to each, and all the way if it is far out.
function heardTime(t) {
  seen = performance.now();
  if (!grid || !(interval > 3)) grid = t;
  else {
    const on = grid + Math.round((t - grid) / interval) * interval;
    grid = Math.abs(t - on) > interval * 0.25 ? t : on + (t - on) * 0.2;
  }
}
// True once this worker may set to work: the times are coming, and its
// sleeps are fine. While the times are not coming (the frame these workers
// live in has just been made, or screen refreshes don't reach it), there is
// nothing to go by: look again shortly, and say so if it lasts. (It has to
// last well beyond STALE: when the tab is put away the times stop and so
// does the page's word, and that is no fault.)
function ready() {
  const t = performance.now();
  if (!(synced && grid && t - seen < 250)) {
    if (!waiting) waiting = t;
    if (t - waiting > 2500 && !told) { told = true; postMessage({ noFrames: true }); }
    again(30);
    return false;
  }
  waiting = 0;
  told = false;
  if (going) return true;
  // A few short sleeps, before anything is asked of the browser.
  const over = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    Atomics.wait(ia, 0, 0, 2);
    over.push(performance.now() - t0 - 2);
  }
  const as = sorted(over);
  if (mid(as, 0.5) > COARSE) {
    // Coarse. The threads that keep the timers fine may have only just been started: try a few times more.
    if (++tried >= 6) halt({ fail: `its sleeps ran over by ${mid(as, 0.5).toFixed(1)} ms as a rule: the browser's timers are too coarse here` });
    else again(250);
    return false;
  }
  margin = Math.max(0.5, Math.min(3, as[as.length - 1] + 0.4));
  overs = [];
  going = true;
  postMessage({ running: true });
  return true;
}

// ---- pacing ----
const fresh = () => ({ cycles: 0, late: 0, missed: 0, worst: 0, at: [], awake: 0 });
let st = fresh();
function tell(more) {
  const at = sorted(st.at), over = sorted(overs);
  postMessage({ stats: { cycles: st.cycles, late: st.late, missed: st.missed, worst: st.worst, at: [mid(at, 0.1), mid(at, 0.5), mid(at, 0.9)], over: [mid(over, 0.5), mid(over, 0.9)], awake: st.cycles ? st.awake / st.cycles : 0, margin, how }, ...more });
  st = fresh();
}
// One screen refresh: draw the dot, which makes the browser ask this canvas
// when the next refresh begins; sleep until `lead` into that refresh; then
// let go of the thread, and the answer goes out.
function pace() {
  if (!running) return;
  if (stale() || !(lead > 0)) { halt({}); return; }
  if (!ready()) return;
  const t = performance.now();
  const cur = grid + Math.floor((t - grid) / interval) * interval;      // the refresh we are in began then
  const target = t < cur + lead - 0.3 ? cur + lead : cur + interval + lead;
  ctx.fillStyle = (++n & 1) ? '#000' : '#010101';
  ctx.fillRect(0, 0, 1, 1);
  st.awake += sleepTo(target);
  const end = performance.now();
  const at = end - (target - lead);          // ms into the refresh
  st.cycles++;
  st.at.push(at);
  if (end - target > 1.5) st.late++;
  if (at > interval * 0.62) st.missed++;     // past the point where the browser stops waiting
  if (end - target > st.worst) st.worst = end - target;
  if (st.cycles >= 120) {
    // Sleeping can't be relied on after all (a laptop gone onto its battery,
    // say): better not to pace at all than to hold the browser to its limit
    // on every refresh.
    if (st.missed > st.cycles * 0.25) { halt({ fail: `its sleeps ran over by ${mid(sorted(overs), 0.5).toFixed(1)} ms as a rule: the browser's timers are too coarse here` }); return; }
    tune();
    tell({ running: true });
  }
  kick();
}

// ---- asking the GPU thread ----
let run = 0, clean = 0, stuck = false, runAt = 0, batch = [];
// Times go out as ages (how long ago), so the page needn't know this clock.
function flush(more) {
  const t = performance.now();
  if ('at' in more) more.ago = t - more.at;
  postMessage({ asks: batch.map((a) => [t - a[0], a[1], a[2], a[3], a[4]]), ...more });
  batch = [];
}
function ask() {
  if (!running) return;
  if (stale()) { halt({}); return; }
  if (!ready()) return;
  n++;
  const fixed = n & 1;
  const steps = Math.max(4, Math.floor(interval - 1.5));          // at 60 a second: 0.5, 1.5, ... 14.5 ms
  const phase = fixed ? interval * 0.62 : 0.5 + ((n >> 1) % steps);
  // In the first refresh whose moment for it is at least a refresh and a half away.
  const v = grid + Math.ceil((performance.now() + interval * 1.5 - phase - grid) / interval) * interval;
  sleepTo(v + phase);
  const t0 = performance.now();
  gl.getError();
  const t1 = performance.now();
  const wait = t1 - t0;
  // Stuck looks like this: the answer waited, and came just as a screen
  // refresh did (usually the next; after a long stall, a later one).
  const into = (((t1 - grid) % interval) + interval) % interval;
  const held = wait >= 3 && (into < 2 || into > interval - 1);
  batch.push([t0, t0 - v, wait, held ? 1 : 0, fixed]);
  if (fixed) {
    if (held) { if (!run) runAt = t0; run++; clean = 0; }
    else if (++clean >= 2) run = 0;
    if (!stuck && run >= 3) { stuck = true; flush({ stuck: true, at: runAt }); }
    else if (stuck && clean >= 2) { stuck = false; flush({ stuck: false, at: t0 }); }
  }
  if (batch.length >= 16) flush({});
  if (n % 64 === 0) {
    tune();
    // A lost context answers at once, always: that would read as "never stuck".
    if (gl.isContextLost()) { halt({ fail: 'its WebGL context was lost' }); return; }
  }
  kick();
}

// What the GPU thread is asked through.
function context() {
  try { return new OffscreenCanvas(1, 1).getContext('webgl', { antialias: false, depth: false, stencil: false, alpha: false }); } catch (err) { return null; }
}

function halt(more) {
  if (!running) return;
  running = false;
  going = false;
  if (job === 'pace') tell({ running: false, ...more });
  else if (stuck) { stuck = false; run = 0; flush({ stuck: false, at: performance.now(), running: false, ...more }); }
  else flush({ running: false, ...more });
}

next.port1.onmessage = () => { queued = false; if (job === 'pace') pace(); else ask(); };
// Something this worker can't do without, and won't get by trying again.
const never = (text) => postMessage({ fail: text, final: true });
onmessage = (e) => {
  const d = e.data || {};
  if (d.listener) { listeners.push(d.listener); return; }
  if (d.job) {
    job = d.job;
    if (job === 'time' || job === 'hold') return;
    if (job === 'pace') { try { ctx = d.canvas.getContext('2d'); } catch (err) {} } else gl = context();
    born = performance.now();
    d.times.onmessage = heardFrom;
    return;
  }
  if (d.run === false) { if (job === 'pace' || job === 'ask') halt({}); return; }
  if (!d.clock) return;
  interval = d.clock.interval;
  heard = performance.now();
  if (job === 'time' || job === 'hold') {
    hold();
    if (job === 'time') {
      running = true;
      if (!looping) {
        looping = true;
        try { requestAnimationFrame(onFrame); } catch (err) { running = looping = false; never('its worker is not given animation frames'); }
      }
    }
    return;
  }
  lead = d.clock.lead;
  if (running) return;
  // Asked to start.
  if (!ia) { never('its worker has no way to sleep'); return; }
  if (job === 'pace' && !ctx) { never('a canvas could not be drawn from its worker'); return; }
  if (job === 'ask') {
    if (!gl) { never('its worker could not get a WebGL context'); return; }
    // A context lost the last time round: get another.
    if (gl.isContextLost()) {
      const another = context();
      if (!another || another.isContextLost()) { postMessage({ fail: 'its WebGL context was lost' }); return; }
      gl = another;
    }
  }
  running = true;
  going = false;
  tried = 0;
  run = clean = 0;
  waiting = 0;
  told = false;
  frames();
  kick();
};
