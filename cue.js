// The sound that says "wiggle the mouse now" during the A/B test (see the
// Alt+Shift+A key in content.js), and the popup's Test button for it. Purely
// a testing aid: so that the mouse gets moved the same in every turn of the
// test and the turns can be compared. Each sound is made on the spot from a
// tone or two; nothing is loaded.
const SDR2HDR_CUE = (() => {
  const NAMES = { ping: 'Ping', double: 'Double beep', chirp: 'Chirp', knock: 'Knock', bell: 'Bell' };
  let ac = null;
  // Must first be called from a key press or a click: browsers don't let a
  // page make sound before that.
  function context() {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch (e) { ac = null; }
    return ac;
  }
  // One tone: from f0 to f1 Hz, starting `at` seconds from now, fading out over `len`.
  function tone(a, at, len, f0, f1, type, vol) {
    const t = a.currentTime + at;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + len + 0.02);
  }
  function play(name) {
    const a = context();
    if (!a || !NAMES[name]) return false;
    try {
      if (name === 'ping') tone(a, 0, 0.35, 880);
      else if (name === 'double') { tone(a, 0, 0.12, 660, 0, 'square', 0.12); tone(a, 0.18, 0.12, 660, 0, 'square', 0.12); }
      else if (name === 'chirp') tone(a, 0, 0.25, 400, 1400, 'triangle', 0.3);
      else if (name === 'knock') { tone(a, 0, 0.09, 190, 90, 'sine', 0.6); tone(a, 0.16, 0.09, 190, 90, 'sine', 0.6); }
      else if (name === 'bell') { tone(a, 0, 0.9, 1320, 0, 'sine', 0.2); tone(a, 0, 0.6, 1980, 0, 'sine', 0.1); }
    } catch (e) { return false; }
    return true;
  }
  return { NAMES, play, wake: context };
})();
