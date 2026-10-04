// Checks of when smooth motion shows which picture (Sdr2hdrSchedule in
// interp.js), with no GPU: a pretend screen refreshing at a set rate is
// shown a pretend video, and what is put on it is checked.
// Run: node tests/schedule.test.mjs
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ performance, console });
for (const f of ['shader.js', 'interp.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
const Sdr2hdrSchedule = vm.runInContext('Sdr2hdrSchedule', ctx);

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

// Run a pretend screen of hz refreshes against a video of fps frames for
// seconds. A frame turns up at the first refresh at or after its time. late:
// { frameNumber: extra refreshes it is late by }; skip: frame numbers that
// never turn up. Returns what was shown at each refresh, as the time in the
// video of the picture, and what start() said for each frame.
function run({ hz, fps, seconds = 4, late = {}, skip = [], rate = 1, jumpAt = null, flowed = true }) {
  const s = new Sdr2hdrSchedule();
  const tick = 1000 / hz, frameMs = 1000 / fps;
  const shown = [], arrivals = [];
  const waiting = [];    // frames that have turned up and not yet begun their pair
  let maxWaiting = 0;
  let next = 0;
  for (let r = 0; r * tick < seconds * 1000; r++) {
    const now = r * tick + 1000;
    // frames that have turned up by this refresh
    while (true) {
      const due = next * frameMs / rate + (late[next] || 0) * tick;
      if (skip.includes(next)) { next++; continue; }
      if (due > r * tick + 1e-6) break;
      waiting.push({ n: next, ts: (next * frameMs + (jumpAt && next >= jumpAt[0] ? jumpAt[1] : 0)) * 1000 });
      next++;
    }
    // as the player does it: one frame a refresh, and only when the clock says
    if (waiting.length && s.due(now)) {
      const f = waiting.shift();
      arrivals.push({ r, n: f.n, ...s.start(now, f.ts, rate, frameMs, flowed) });
      maxWaiting = Math.max(maxWaiting, waiting.length);
    }
    shown.push({ r, ...s.at(now) });
  }
  return { shown, arrivals, s, maxWaiting };
}

// 30 on 60: A, then the picture halfway, then B, and so on.
{
  const { shown } = run({ hz: 60, fps: 30 });
  const steady = shown.slice(8, 100);
  const pattern = steady.map((x) => x.kind[0]).join('');
  check('30 fps on 60 Hz: the frame itself, then a made-up one halfway, alternately', /^(pm)+p?$/.test(pattern) || /^(mp)+m?$/.test(pattern), pattern.slice(0, 24));
  const mids = steady.filter((x) => x.kind === 'mid');
  check('30 fps on 60 Hz: every made-up picture is halfway (t = 0.5)', mids.every((x) => Math.abs(x.t - 0.5) < 0.02), `t from ${Math.min(...mids.map((x) => x.t)).toFixed(3)} to ${Math.max(...mids.map((x) => x.t)).toFixed(3)}`);
}

// 24 and 25 on 60: every video frame goes through once, and the refreshes in between show made-up pictures inside the gap.
for (const fps of [24, 25]) {
  const { shown, arrivals } = run({ hz: 60, fps });
  const steady = shown.slice(10);
  const expected = Math.floor((shown.length - 10) * (1000 / 60) / (1000 / fps));
  const began = arrivals.filter((a) => a.r >= 10).length;
  check(`${fps} fps on 60 Hz: each video frame begins its pair once`, Math.abs(began - expected) <= 1, `${began} began, about ${expected} expected`);
  const mids = steady.filter((x) => x.kind === 'mid');
  check(`${fps} fps on 60 Hz: made-up pictures stay strictly inside the gap`, mids.length > 0 && mids.every((x) => x.t > 0.01 && x.t < 0.99), `${mids.length} made up of ${steady.length} refreshes`);
}

// How smooth is it? The time in the video of each picture shown, refresh by
// refresh: every step should be the same, whatever the frame rate.
function smoothness(hz, fps, extra = {}) {
  const { shown, arrivals } = run({ hz, fps, seconds: 6, ...extra });
  const frameMs = 1000 / fps;
  const vt = [];
  for (const x of shown) {
    const begun = arrivals.filter((a) => a.r <= x.r);
    const n = begun.length ? begun[begun.length - 1].n : 0;
    vt.push((n - 1 + x.t) * frameMs);     // the gap before frame n runs from frame n - 1 to frame n
  }
  const steps = [];
  for (let i = 40; i < vt.length - 1; i++) steps.push(vt[i + 1] - vt[i]);
  const ideal = 1000 / hz;
  return { worst: Math.max(...steps.map((d) => Math.abs(d - ideal))), steps };
}
{
  for (const [hz, fps] of [[60, 30], [60, 24], [60, 25], [144, 30], [120, 24], [75, 30], [60, 23.976]]) {
    const a = smoothness(hz, fps);
    check(`${fps} fps on ${hz} Hz: the video time advances evenly, refresh by refresh`, a.worst < 0.35, `worst step ${a.worst.toFixed(2)} ms off an even ${(1000 / hz).toFixed(2)}`);
  }
}

// A frame two refreshes late: the newest frame is held, the clock then carries on.
{
  const { shown, arrivals } = run({ hz: 60, fps: 30, late: { 40: 2 } });
  const lateOne = arrivals.find((a) => a.n === 40);
  check('a late frame is noticed (it began its pair more than 20 ms after its time)', lateOne && lateOne.slip > 20, `slip ${lateOne && lateOne.slip.toFixed(1)} ms`);
  check('a late frame: the clock carries on where it was', lateOne && !lateOne.resync, `resync ${lateOne && lateOne.resync}`);
  const held = shown.filter((x) => x.r >= 78 && x.r <= 84).map((x) => x.kind[0]).join('');
  check('a late frame: the newest frame is held meanwhile', /cc/.test(held), held);
  // and afterwards the video time is back on its line
  const a = smoothness(60, 30, { late: { 40: 2 } });
  const bumps = a.steps.filter((d) => Math.abs(d - 1000 / 60) > 0.35).length;
  check('a late frame: the picture stays put once or twice and catches up, nothing else', bumps <= 4, `${bumps} uneven steps`);
}

// A frame much too late: the clock starts again.
{
  const { arrivals } = run({ hz: 60, fps: 30, late: { 40: 8 } });
  const a = arrivals.find((x) => x.n === 40);
  check('a frame far too late: the clock is started again', a && a.resync, `slip ${a && a.slip.toFixed(1)} ms, resync ${a && a.resync}`);
}

// A frame that never turns up (dropped by the decoder): the gap is two frames, spread over it.
{
  const { arrivals } = run({ hz: 60, fps: 30, skip: [30] });
  const a = arrivals.find((x) => x.n === 31);
  check('a dropped frame: the gap is two frames and is still made up across', a && a.near && a.pair && Math.abs(a.gap - 66.7) < 1, `gap ${a && a.gap.toFixed(1)} ms`);
}

// A seek: no pair, the new frame is shown as it is.
{
  const { arrivals, shown } = run({ hz: 60, fps: 30, jumpAt: [60, 5000] });
  const a = arrivals.find((x) => x.n === 60);
  check('a seek: nothing is made up across the jump', a && !a.near && !a.pair, `near ${a && a.near}, pair ${a && a.pair}`);
  const after = shown.find((x) => x.r === a.r);
  check('a seek: the new frame is shown as it is at once', after.kind === 'cur', after.kind);
}

// No motion could be worked out: the frames are shown as they are.
{
  const { shown } = run({ hz: 60, fps: 30, flowed: false });
  check('no motion found: only whole frames are shown', shown.every((x) => x.kind === 'cur'));
}

// Playback at twice the speed: the gap in real time is half.
{
  const { arrivals } = run({ hz: 60, fps: 15, rate: 2 });
  const a = arrivals[10];
  check('playback rate 2: gaps are in real time', a && Math.abs(a.gap - 33.3) < 1, `gap ${a && a.gap.toFixed(1)} ms`);
}

// About as many frames as refreshes: nothing builds up waiting (a backlog would
// never drain, because frames are taken one a gap).
{
  const { maxWaiting } = run({ hz: 60, fps: 59.94 });
  check('about as many frames as refreshes: at most one frame ever waits', maxWaiting <= 1, `at most ${maxWaiting} waiting`);
}

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
