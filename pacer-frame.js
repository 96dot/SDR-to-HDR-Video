// The extension's own frame (pacer.html), which pacer.js puts into a page
// that is converting fast video. There is nothing in it to see. It is here
// because many pages (YouTube among them) don't allow a worker to be started
// from the page itself, and the workers of pacer.js have to run somewhere
// that belongs to the same browser window: in a frame of the extension's own
// they may. All this script does is start them and pass messages on.
'use strict';

let port = null;           // to the page's side of the extension (pacer.js)
// 'pace' and 'ask' do the work; 'time' keeps time for those two and 'hold'
// keeps the timers of this process fine (see pacer-worker.js for both).
const workers = {};
const kept = [];           // the canvas the pacing worker draws into is kept here; it is never shown

const tell = (m) => { if (port) port.postMessage(m); };
const both = (fail, final) => { for (const j of ['pace', 'ask']) tell({ job: j, fail, final }); };

// The two that the others depend on. If the time-keeper stops, all are done
// away with, to be started afresh the next time one is wanted.
function helpers() {
  if (workers.time) return;
  const t = workers.time = new Worker('pacer-worker.js');
  t.onmessage = (e) => { if (e.data && e.data.fail) both(e.data.fail, !!e.data.final); };
  t.onerror = (e) => {
    both(`its time-keeper stopped${e && e.message ? ` (${e.message})` : ''}`);
    for (const k of Object.keys(workers)) { try { workers[k].terminate(); } catch (err) {} delete workers[k]; }
  };
  t.postMessage({ job: 'time' });
  const h = workers.hold = new Worker('pacer-worker.js');
  h.onerror = () => {};     // without it the sleeps may be coarse, and the sleepers find that out for themselves
  h.postMessage({ job: 'hold' });
}

function make(job) {
  let w = null;
  try {
    helpers();
    // A line from the time-keeper to this worker.
    const line = new MessageChannel();
    workers.time.postMessage({ listener: line.port1 }, [line.port1]);
    w = new Worker('pacer-worker.js');
    w.onmessage = (e) => tell({ ...e.data, job });
    w.onerror = (e) => {
      tell({ job, fail: `its worker stopped${e && e.message ? ` (${e.message})` : ''}` });
      try { w.terminate(); } catch (err) {}
      delete workers[job];
    };
    if (job === 'pace') {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const off = c.transferControlToOffscreen();
      w.postMessage({ job, times: line.port2, canvas: off }, [line.port2, off]);
      kept.push(c);
    } else {
      w.postMessage({ job, times: line.port2 }, [line.port2]);
    }
  } catch (e) {
    tell({ job, fail: `its worker could not be started (${e.name}: ${e.message})` });
    return null;
  }
  return w;
}

// What the page's side may ask for, and nothing else: any page can send a
// message to a frame inside it, so only plain numbers within sensible limits
// are passed on.
function asked(e) {
  const d = e.data || {};
  if (d.job !== 'pace' && d.job !== 'ask') return;
  if (d.run === false) {
    if (workers[d.job]) workers[d.job].postMessage({ run: false });
    return;
  }
  const c = d.clock;
  if (!c || !(c.interval > 3.5 && c.interval < 34) || !(c.lead >= 0 && c.lead <= 12)) return;
  const w = workers[d.job] || (workers[d.job] = make(d.job));
  if (!w) return;
  const clock = { interval: +c.interval, lead: +c.lead };
  for (const h of [workers.time, workers.hold]) if (h) h.postMessage({ clock });
  w.postMessage({ clock });
}

// The page's side says hello once, when the frame has loaded, and hands over
// its end of the line. Whoever says it first is the one listened to.
addEventListener('message', (e) => {
  if (port || e.source !== parent || !e.data || e.data.sdr2hdr !== 'pacer' || !e.ports || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = asked;
  tell({ ready: true });
});
