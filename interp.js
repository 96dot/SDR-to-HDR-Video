// Frame interpolation ("Smooth motion"): for a video with fewer frames than
// the screen has refreshes (30 or 25 or 24 a second on a 60 Hz screen), the
// pictures between two video frames are made up, so that each refresh shows
// something new instead of the same frame twice.
//
// How, for each new video frame B and the one before it, A:
//
//   1. PYRAMID  B is shrunk to 480x270, 120x68 and 30x17 by the same two
//               passes the analysis uses (shader.js, DOWN1 and DOWN); only
//               the luminance is used. The pyramid of A is kept from last time.
//   2. FLOW     Block matching, coarse to fine. At 30x17 every shift up to 3
//               texels either way is tried; at 120x68 only shifts within 2
//               of what the level above found, at 480x270 within 1. The result is
//               for each pixel of B the shift F such that A(x + F) looks like
//               B(x), in fractions of the frame (so every level agrees).
//   3. MIX      For each refresh between the two frames, t going from 0 (A)
//               to 1 (B): the picture is made from A(x + t F) and
//               B(x - (1 - t) F). Where those two disagree (the match was
//               wrong, something was uncovered, the scene cut) the nearer of
//               the two frames is used as it is instead, so a failed match
//               shows as the old judder and not as a smear.
//
// The result of MIX goes into a texture shaped like a copy of a video frame,
// and the rest of the pipeline (analysis, upscaling, the conversion to HDR)
// takes it for one. Nothing downstream knows.
//
// Run once per video frame, not per refresh: the pyramid and the flow. Per
// refresh: one pass, MIX. At 30 fps on a 60 Hz screen the second refresh of
// each pair is made, and the first is the frame itself (t = 0).
//
// Before it is used on a GPU, a made-up pair of frames with a known shift
// goes through the same code (sdr2hdrInterpSelfTest) and the result is
// checked; if it is wrong the feature is not offered on that GPU.

const SDR2HDR_FLOW_LEVELS = [SDR2HDR_LEVELS[0], SDR2HDR_LEVELS[1], SDR2HDR_LEVELS[2]];   // fine to coarse
const SDR2HDR_FLOW_FORMAT = 'rgba16float';
// How far the motion can be followed, in pixels of the finest level (480 wide):
// the search at the coarsest level (6 texels of 16 pixels either way) plus what
// the two finer levels add to it (2 texels of 4 pixels, 1 pixel). See
// Sdr2hdrMotion.search. It was 57 until 1.3.5.
const SDR2HDR_FLOW_REACH = 6 * 16 + 2 * 4 + 1;

// Block matching. One shader for all three levels: q says how big a window
// to compare, how far to search around the guess, and whether there is a
// guess (the flow of the coarser level) at all.
//
// Output: rg = the shift as a fraction of the frame, b = how badly the best
// shift still matches (mean difference of the square roots of luminance, so
// that dark detail counts as much as bright).
const SDR2HDR_FLOW = SDR2HDR_COMMON + /* wgsl */ `
struct Q { win: i32, rad: i32, sub: i32, coarse: i32 };
@group(0) @binding(0) var cur: texture_2d<f32>;
@group(0) @binding(1) var prv: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var pred: texture_2d<f32>;
@group(0) @binding(4) var<uniform> q: Q;

fn lumAt(t: texture_2d<f32>, p: vec2i) -> f32 {
  let d = vec2i(textureDimensions(t));
  return sqrt(max(textureLoad(t, clamp(p, vec2i(0), d - vec2i(1)), 0).r, 0.0));
}

fn matchCost(p: vec2i, dd: vec2i) -> f32 {
  var s = 0.0;
  for (var j = -q.win; j <= q.win; j++) {
    for (var i = -q.win; i <= q.win; i++) {
      let o = vec2i(i, j);
      s += abs(lumAt(cur, p + o) - lumAt(prv, p + o + dd));
    }
  }
  let n = f32((2 * q.win + 1) * (2 * q.win + 1));
  return s / n;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let d = vec2f(textureDimensions(cur));
  var centre = vec2i(0);
  if (q.coarse == 0) {
    centre = vec2i(round(textureSampleLevel(pred, samp, in.uv, 0.0).xy * d));
  }
  // The guess first, so that where nothing tells shifts apart (flat areas)
  // it is the one that stays.
  var best = matchCost(p, centre);
  var bestRaw = best;
  var bd = centre;
  for (var dy = -q.rad; dy <= q.rad; dy++) {
    for (var dx = -q.rad; dx <= q.rad; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let dd = centre + vec2i(dx, dy);
      let raw = matchCost(p, dd);
      // A small preference for shifts close to the guess, which keeps noise
      // from pulling neighbouring pixels in different directions.
      let c = raw + 0.003 * f32(abs(dx) + abs(dy));
      if (c < best) { best = c; bestRaw = raw; bd = dd; }
    }
  }
  var f = vec2f(bd);
  if (q.sub == 1) {
    // Between whole pixels: the lowest point of a parabola through the
    // best shift and its two neighbours along each axis.
    let cxm = matchCost(p, bd + vec2i(-1, 0));
    let cxp = matchCost(p, bd + vec2i(1, 0));
    let cym = matchCost(p, bd + vec2i(0, -1));
    let cyp = matchCost(p, bd + vec2i(0, 1));
    let ax = cxm - 2.0 * bestRaw + cxp;
    let ay = cym - 2.0 * bestRaw + cyp;
    if (ax > 1e-5) { f.x += clamp(0.5 * (cxm - cxp) / ax, -0.5, 0.5); }
    if (ay > 1e-5) { f.y += clamp(0.5 * (cym - cyp) / ay, -0.5, 0.5); }
  }
  return vec4f(f / d, bestRaw, 1.0);
}
`;

// The motion the whole picture agrees on (a pan, say), for MIX to fall back on
// where the motion found at one place cannot be trusted. Every shift of the
// whole picture within the search range is tried, at the 120x68 level, and
// the one that fits best over the whole picture is taken: flat areas fit
// every shift equally well and so do not vote, which taking the average of
// the motions found, weighted by how well they matched, got badly wrong (a
// mostly flat picture came out as no motion, or the wrong way). The picture
// is read at every other texel, which is plenty to tell shifts apart.
//
// GLOBAL1: one pixel for each shift (GLOBAL_RADIUS texels either way, so a
// square of 2 * GLOBAL_RADIUS + 1), r = how badly the picture fits it.
const SDR2HDR_GLOBAL_RADIUS = 24;
const SDR2HDR_GLOBAL1 = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var cur: texture_2d<f32>;
@group(0) @binding(1) var prv: texture_2d<f32>;

fn lum(t: texture_2d<f32>, p: vec2i) -> f32 {
  return sqrt(max(textureLoad(t, p, 0).r, 0.0));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let c = vec2i(in.pos.xy) - vec2i(${SDR2HDR_GLOBAL_RADIUS});
  let d = vec2i(textureDimensions(cur));
  var sum = 0.0;
  var n = 0.0;
  for (var y = 0; y < d.y; y += 2) {
    for (var x = 0; x < d.x; x += 2) {
      let q = vec2i(x, y) + c;
      if (q.x < 0 || q.y < 0 || q.x >= d.x || q.y >= d.y) { continue; }
      sum += abs(lum(cur, vec2i(x, y)) - lum(prv, q));
      n += 1.0;
    }
  }
  // Only shifts that leave most of the picture overlapping count; a small
  // push toward no motion settles ties.
  let overlap = n * 4.0 / f32(d.x * d.y);
  let cost = select(1.0, sum / max(n, 1.0), overlap > 0.4) + 0.0003 * f32(abs(c.x) + abs(c.y));
  return vec4f(cost, 0.0, 0.0, 1.0);
}
`;

// GLOBAL2: the best of those, with a parabola through it and its neighbours
// for the part of a texel. Output rg = the shift as a fraction of the frame.
const SDR2HDR_GLOBAL2 = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var cost: texture_2d<f32>;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let side = 2 * ${SDR2HDR_GLOBAL_RADIUS} + 1;
  var best = 1e9;
  var bp = vec2i(${SDR2HDR_GLOBAL_RADIUS});
  for (var y = 0; y < side; y++) {
    for (var x = 0; x < side; x++) {
      let c = textureLoad(cost, vec2i(x, y), 0).r;
      if (c < best) { best = c; bp = vec2i(x, y); }
    }
  }
  var f = vec2f(bp - vec2i(${SDR2HDR_GLOBAL_RADIUS}));
  if (bp.x > 0 && bp.x < side - 1) {
    let cm = textureLoad(cost, bp + vec2i(-1, 0), 0).r;
    let cp = textureLoad(cost, bp + vec2i(1, 0), 0).r;
    let a = cm - 2.0 * best + cp;
    if (a > 1e-6) { f.x += clamp(0.5 * (cm - cp) / a, -0.5, 0.5); }
  }
  if (bp.y > 0 && bp.y < side - 1) {
    let cm = textureLoad(cost, bp + vec2i(0, -1), 0).r;
    let cp = textureLoad(cost, bp + vec2i(0, 1), 0).r;
    let a = cm - 2.0 * best + cp;
    if (a > 1e-6) { f.y += clamp(0.5 * (cm - cp) / a, -0.5, 0.5); }
  }
  return vec4f(f / vec2f(${SDR2HDR_FLOW_LEVELS[1][0]}.0, ${SDR2HDR_FLOW_LEVELS[1][1]}.0), best, 1.0);
}
`;

// Is this a cut? The mean of how badly the coarsest level of the flow
// matched, over the whole frame: a real motion leaves most of it matching, a
// cut leaves none. And how fast the fastest thing moved, for the report. And
// how well the finest level matched in general (read at every eighth texel
// each way), which is what MIX judges a place's match against: footage with
// grain and fine detail matches less well everywhere, and a place is in doubt
// only when it is well below the rest of its own picture.
// r = the mean mismatch at the coarsest level, g = the largest motion in
// pixels of the finest level, b = the mean mismatch at the finest level.
const SDR2HDR_CUT = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var coarse: texture_2d<f32>;
@group(0) @binding(1) var fine: texture_2d<f32>;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let d = vec2i(textureDimensions(coarse));
  var cost = 0.0;
  var fastest = 0.0;
  let grid = vec2f(${SDR2HDR_FLOW_LEVELS[0][0]}.0, ${SDR2HDR_FLOW_LEVELS[0][1]}.0);
  for (var y = 0; y < d.y; y++) {
    for (var x = 0; x < d.x; x++) {
      let t = textureLoad(coarse, vec2i(x, y), 0);
      cost += t.z;
      fastest = max(fastest, length(t.xy * grid));
    }
  }
  let fd = vec2i(textureDimensions(fine));
  var fsum = 0.0;
  var cnt = 0.0;
  for (var y = 4; y < fd.y; y += 8) {
    for (var x = 4; x < fd.x; x += 8) {
      fsum += textureLoad(fine, vec2i(x, y), 0).z;
      cnt += 1.0;
    }
  }
  return vec4f(cost / f32(d.x * d.y), fastest, fsum / max(cnt, 1.0), 1.0);
}
`;

// The picture between two frames, for t from 0 (A) to 1 (B). dbg: 0 = the
// picture; 1 = where the nearer frame was used instead (red); 2 = the
// motion that was found (colour for direction, strength for how far).
const SDR2HDR_MIXLIB = SDR2HDR_COMMON + /* wgsl */ `
struct P { t: f32, dbg: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var fa: texture_2d<f32>;
@group(0) @binding(2) var fb: texture_2d<f32>;
@group(0) @binding(3) var flow: texture_2d<f32>;
@group(0) @binding(4) var<uniform> pr: P;
@group(0) @binding(5) var cut: texture_2d<f32>;
@group(0) @binding(6) var glob: texture_2d<f32>;

struct Shifted { rgb: vec3f, diff: f32, both: bool };

// The picture at t between the two frames, if everything at uv moves by f: A
// read at uv + t f, B at uv - (1 - t) f, blended; where one of the two is
// outside the frame, only the other. diff: how much the two disagree.
fn shift(f: vec2f, uv: vec2f) -> Shifted {
  let ua = uv + pr.t * f;
  let ub = uv - (1.0 - pr.t) * f;
  let a = textureSampleLevel(fa, samp, ua, 0.0).rgb;
  let b = textureSampleLevel(fb, samp, ub, 0.0).rgb;
  let inA = all(ua >= vec2f(0.0)) && all(ua <= vec2f(1.0));
  let inB = all(ub >= vec2f(0.0)) && all(ub <= vec2f(1.0));
  var o: Shifted;
  o.both = inA && inB;
  o.diff = max(abs(a.r - b.r), max(abs(a.g - b.g), abs(a.b - b.b)));
  o.rgb = mix(a, b, pr.t);
  if (!inA && inB) { o.rgb = b; }
  else if (inA && !inB) { o.rgb = a; }
  else if (!inA && !inB) { o.rgb = mix(a, b, pr.t); o.both = true; o.diff = 1.0; }
  return o;
}

fn hue(h: f32) -> vec3f {
  let k = vec3f(5.0, 3.0, 1.0) + h * 6.0;
  return clamp(abs((k - floor(k / 6.0) * 6.0) - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

struct Made { rgb: vec3f, w: f32, f: vec2f, x: f32 };

// The picture at uv, and how much of it is the plain nearer frame (w).
fn mixAt(uv: vec2f) -> Made {
  let fl = textureSampleLevel(flow, samp, uv, 0.0);
  let cutv = textureLoad(cut, vec2i(0, 0), 0);
  let near = select(textureSampleLevel(fb, samp, uv, 0.0).rgb,
                    textureSampleLevel(fa, samp, uv, 0.0).rgb, pr.t < 0.5);

  // Tier 1: the motion found at this place. Tier 2: the motion most of the
  // picture agrees on (the GLOBAL passes), for where tier 1 cannot be trusted. Tier 3:
  // the nearer real frame, as it is.
  let loc = shift(fl.xy, uv);
  let glo = shift(textureLoad(glob, vec2i(0, 0), 0).xy, uv);

  // Where the local motion is in doubt: its match here was poor, well below
  // what is usual for this picture (cutv.b) and not just noise. Not the
  // difference between the two pictures it makes, point by point: grain, fine
  // detail and a slight change of exposure make that large where the motion is
  // right, and everything that moved then fell back to the plain frame (it did
  // on the busy test picture, and the footage it was reported on).
  let wl = smoothstep(1.8, 3.5, fl.z / max(cutv.b, 0.02)) * smoothstep(0.04, 0.09, fl.z);
  // Where even the overall motion gives two pictures that disagree. Where one
  // of the two places to read from is outside the frame (a pan: what slides
  // in at the edge is in one frame only) the other is all there is.
  let wg = select(0.0, smoothstep(0.10, 0.28, glo.diff), glo.both);
  // And everywhere, if the frame as a whole did not match: a cut.
  let wc = smoothstep(0.065, 0.088, cutv.r);

  // Where the motion found here is not the overall motion and the two
  // pictures it makes disagree, it is most likely a wrong match (dark sky,
  // a crowd, fine detail that looks the same shifted any way: the cost of the
  // match says nothing there, and the picture came out as warped swirls on
  // real footage). The overall motion is the better guess for such a place.
  // A thing really moving its own way also differs from the overall motion,
  // but then its two pictures agree. (x: how much of this, for the view.)
  let away = length(fl.xy - textureLoad(glob, vec2i(0, 0), 0).xy) * ${SDR2HDR_FLOW_LEVELS[0][0]}.0;
  let wx = smoothstep(0.15, 0.45, clamp(away / 20.0, 0.0, 1.0) * clamp(loc.diff * 4.0, 0.0, 1.0));

  let tier = mix(mix(loc.rgb, glo.rgb, wl), glo.rgb, wx);
  let w = max(max(wg * wl, wc), 0.0);
  let base = tier;
  let f = fl.xy;
  var m: Made;
  m.rgb = mix(base, near, w);
  m.w = w;
  m.f = f;
  m.x = wx;
  return m;
}
`;

const SDR2HDR_MIX = SDR2HDR_MIXLIB + /* wgsl */ `
@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let m = mixAt(in.uv);
  var o = m.rgb;
  let w = m.w;
  let f = m.f;
  if (pr.dbg > 1.5 && pr.dbg < 2.5) {
    let mv = f * vec2f(${SDR2HDR_FLOW_LEVELS[0][0]}.0, ${SDR2HDR_FLOW_LEVELS[0][1]}.0);
    let len = length(mv);
    let ang = atan2(mv.y, mv.x) / 6.2831853 + 0.5;
    o = mix(o * 0.45, hue(ang), clamp(len / 6.0, 0.0, 1.0) * 0.8);
  } else if (pr.dbg > 0.5) {
    o = mix(o, vec3f(1.0, 0.1, 0.1), w * 0.85);
    o = mix(o, vec3f(0.1, 0.4, 1.0), m.x * 0.6 * (1.0 - w));
  }
  if (pr.dbg > 2.5) { o = vec3f(w); }
  return vec4f(o, 1.0);
}
`;



// How much of the picture falls back to the plain frame: the mean of MIX's
// weight over a grid of points, at the halfway picture, for the report. One
// pixel, r = the share.
const SDR2HDR_STATS = SDR2HDR_MIXLIB + /* wgsl */ `
@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  var sum = 0.0;
  for (var y = 0; y < 18; y++) {
    for (var x = 0; x < 32; x++) {
      sum += mixAt(vec2f((f32(x) + 0.5) / 32.0, (f32(y) + 0.5) / 18.0)).w;
    }
  }
  return vec4f(sum / 576.0, 0.0, 0.0, 1.0);
}
`;

// Made-up frames for the self-check: smooth noise with a shift. Moving the
// same noise by a known amount gives a pair whose true motion is exact.
const SDR2HDR_TESTCARD = SDR2HDR_COMMON + /* wgsl */ `
struct T { shift: vec2f, size: vec2f, kind: vec4f };
@group(0) @binding(0) var<uniform> tc: T;

fn h2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2f(1.0, 0.0)), u.x), mix(h2(i + vec2f(0.0, 1.0)), h2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // Position in pixels of the frame, moved by the shift.
  let p = (in.uv - tc.shift) * tc.size;
  var c: f32;
  if (tc.kind.x > 3.5) {
    // A busy scene, as real video is: a pan across detail, two things moving
    // their own ways, and a slight change of exposure between the frames (kind.w).
    let n = 0.4 * vnoise(p / 40.0) + 0.3 * vnoise(p / 14.0) + 0.2 * vnoise(p / 6.0) + 0.1 * vnoise(p / 2.5);
    c = 0.10 + 0.80 * smoothstep(0.30, 0.70, n);
    let c1 = vec2f(0.30, 0.35) + tc.shift * 2.5;
    let d1 = abs(in.uv - c1);
    if (d1.x < 0.10 && d1.y < 0.14) {
      let q = (in.uv - c1) * tc.size;
      c = 0.15 + 0.7 * smoothstep(0.3, 0.7, 0.5 * vnoise(q / 12.0 + 50.0) + 0.5 * vnoise(q / 4.0 + 90.0));
    }
    let c2 = vec2f(0.70, 0.65) - tc.shift * 1.5 + vec2f(0.0, tc.shift.x * 0.8);
    let d2 = abs(in.uv - c2);
    if (d2.x < 0.12 && d2.y < 0.10) {
      let q = (in.uv - c2) * tc.size;
      c = 0.9 - 0.7 * smoothstep(0.3, 0.7, 0.5 * vnoise(q / 9.0 + 10.0) + 0.5 * vnoise(q / 3.0 + 30.0));
    }
    c = c * (1.0 + tc.kind.w * select(0.0, select(0.5, 1.0, abs(tc.kind.z - 2.0) < 0.1), tc.kind.z > 0.5));
  } else if (tc.kind.x < 0.5) {
    let n = 0.4 * vnoise(p / 64.0) + 0.3 * vnoise(p / 24.0) + 0.2 * vnoise(p / 9.0) + 0.1 * vnoise(p / 3.0);
    // Pushed apart, so that there are real edges to follow (and to get wrong).
    c = 0.075 + 0.85 * smoothstep(0.35, 0.65, n);
  } else {
    // A scene to pan across: flat sky with a few soft clouds, a sharp
    // horizon, textured ground, and posts standing on it.
    // (Pattern 3: nearly all sky, which is flat, and a thin strip of ground.)
    let hy = tc.size.y * select(0.45, 0.88, tc.kind.x > 2.5);
    let sky = 0.80 - 0.25 * (p.y / hy) + select(0.04 * vnoise(p / 90.0), 0.0, tc.kind.x > 2.5);
    let ground = 0.20 + 0.55 * smoothstep(0.30, 0.70, 0.5 * vnoise(p / 30.0) + 0.3 * vnoise(p / 11.0) + 0.2 * vnoise(p / 4.0));
    // (With pattern 2 the posts are near the camera and move twice as far.)
    let q = select(p, (in.uv - tc.shift * 2.0) * tc.size, tc.kind.x > 1.5);
    let post = step(abs(fract(q.x / 97.0) - 0.5), 0.03) * step(hy - 60.0, p.y) * step(p.y, hy + 10.0);
    c = mix(sky, ground, step(hy, p.y));
    c = mix(c, 0.05, post);
  }
  // Noise that is new every frame (what compression leaves behind).
  c = c + tc.kind.y * (h2(in.uv * tc.size + vec2f(tc.kind.z, tc.kind.z * 1.7)) - 0.5);
  return vec4f(c, c * 0.9 + 0.05, 1.0 - c * 0.8, 1.0);
}
`;

async function sdr2hdrInterpPipelines(device) {
  const make = (code, format) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
  };
  const [flow, g1, g2, cut, mix, stats, card] = await Promise.all([
    make(SDR2HDR_FLOW, SDR2HDR_FLOW_FORMAT),
    make(SDR2HDR_GLOBAL1, SDR2HDR_FLOW_FORMAT),
    make(SDR2HDR_GLOBAL2, SDR2HDR_FLOW_FORMAT),
    make(SDR2HDR_CUT, SDR2HDR_FLOW_FORMAT),
    make(SDR2HDR_MIX, SDR2HDR_FRAME_FORMAT),
    make(SDR2HDR_STATS, SDR2HDR_FLOW_FORMAT),
    make(SDR2HDR_TESTCARD, SDR2HDR_FRAME_FORMAT),
  ]);
  return { flow, g1, g2, cut, mix, stats, card };
}

// The working memory of one video's interpolation, and the passes. The
// caller hands over frames as "slots": { view, bgDown1 } (see content.js).
class Sdr2hdrMotion {
  static search = [[2, 6, 1, 1], [2, 2, 1, 0], [2, 1, 1, 0]];
  constructor(gpu, pipes) {
    this.gpu = gpu;
    this.pipes = pipes;
    const { device } = gpu;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const group = (pipeline, resources) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    this.group = group;
    const tex = ([w, h]) => device.createTexture({ size: [w, h], format: SDR2HDR_FLOW_FORMAT, usage });
    const mk = (size) => { const t = tex(size); return { tex: t, view: t.createView() }; };
    this.textures = [];
    // Two pyramids: the frame now current and the one before it, swapping.
    this.pyr = [0, 1].map(() => SDR2HDR_FLOW_LEVELS.map((s) => { const x = mk(s); this.textures.push(x.tex); return x; }));
    // Flow, coarse (index 0) to fine (index 2).
    this.flow = [...SDR2HDR_FLOW_LEVELS].reverse().map((s) => { const x = mk(s); this.textures.push(x.tex); return x; });
    const dummy = mk([1, 1]);
    this.textures.push(dummy.tex);
    // The one number that says whether the frame was a cut.
    this.cut = mk([1, 1]);
    this.textures.push(this.cut.tex);
    this.bgCut = group(pipes.cut, [this.flow[0].view, this.flow[this.flow.length - 1].view]);
    // The overall motion: the cost of each shift, and the best of them.
    const side = 2 * SDR2HDR_GLOBAL_RADIUS + 1;
    this.gcost = mk([side, side]);
    this.glob = mk([1, 1]);
    this.textures.push(this.gcost.tex, this.glob.tex);
    this.bgG2 = group(pipes.g2, [this.gcost.view]);
    // How much falls back to the plain frame, at the halfway picture (see SDR2HDR_STATS).
    this.wstat = mk([1, 1]);
    this.textures.push(this.wstat.tex);
    this.sbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.sbuf, 0, new Float32Array([0.5, 0, 0, 0]));
    this.statGroups = new Map();
    // [window, search radius, subpixel, coarsest] for each level, coarse to fine.
    const settings = Sdr2hdrMotion.search;
    this.qbufs = settings.map((s) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Int32Array(s));
      return b;
    });
    // bgFlow[k][i]: matching level i (coarse to fine) with pyramid k as the
    // current frame and the other as the one before.
    this.bgFlow = [0, 1].map((k) => this.flow.map((_, i) => {
      const lv = SDR2HDR_FLOW_LEVELS.length - 1 - i;
      return group(pipes.flow, [
        this.pyr[k][lv].view, this.pyr[1 - k][lv].view, gpu.sampler,
        i === 0 ? dummy.view : this.flow[i - 1].view, { buffer: this.qbufs[i] },
      ]);
    }));
    // bgG1[k]: the overall motion between the two pyramids, k being the current one.
    this.bgG1 = [0, 1].map((k) => group(pipes.g1, [this.pyr[k][1].view, this.pyr[1 - k][1].view]));
    // bgPyr[k][j]: shrinking level j of pyramid k into level j + 1.
    this.bgPyr = [0, 1].map((k) => [0, 1].map((j) => group(gpu.down, [gpu.sampler, this.pyr[k][j].view])));
    this.pbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pdata = new Float32Array(4);
    this.mixGroups = new Map();
    this.k = 0;              // which pyramid holds the current frame
    this.valid = false;      // the other one holds the frame before it
  }

  pass(enc, view, pipeline, bind, timing) {
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      ...(timing ? { timestampWrites: timing } : {}),
    });
    rp.setPipeline(pipeline);
    rp.setBindGroup(0, bind);
    rp.draw(4);
    rp.end();
  }

  // A new current frame. Builds its pyramid, and if there is a frame before
  // it, the flow from one to the other. Returns true if the flow was made.
  // tq: a query set of two timestamps (see Session.timer), to have the GPU
  // time all of this itself: from the start of the first pass to the end of
  // the last.
  advance(enc, sl, tq = null) {
    const g = this.gpu;
    this.k = 1 - this.k;
    const pk = this.pyr[this.k];
    const first = tq && { querySet: tq.set, beginningOfPassWriteIndex: 0 };
    const last = tq && { querySet: tq.set, endOfPassWriteIndex: 1 };
    const flowed = this.valid;
    this.pass(enc, pk[0].view, g.down1, sl.bgDown1, first);
    this.pass(enc, pk[1].view, g.down, this.bgPyr[this.k][0]);
    this.pass(enc, pk[2].view, g.down, this.bgPyr[this.k][1], flowed ? null : last);
    if (flowed) {
      for (let i = 0; i < this.flow.length; i++) this.pass(enc, this.flow[i].view, this.pipes.flow, this.bgFlow[this.k][i]);
      this.pass(enc, this.gcost.view, this.pipes.g1, this.bgG1[this.k]);
      this.pass(enc, this.glob.view, this.pipes.g2, this.bgG2);
      this.pass(enc, this.cut.view, this.pipes.cut, this.bgCut, last);
    }
    this.valid = true;
    return flowed;
  }

  // Start again (a seek, a pause, interpolation switched off): the next
  // frame has nothing to be matched with.
  reset() { this.valid = false; }

  // The picture at t between frame A and frame B (the two frames the last
  // advance matched), into target.view.
  mix(enc, a, b, t, target, dbg = 0) {
    this.pdata[0] = t;
    this.pdata[1] = dbg;
    this.gpu.device.queue.writeBuffer(this.pbuf, 0, this.pdata);
    let row = this.mixGroups.get(a);
    if (!row) this.mixGroups.set(a, (row = new Map()));
    let bg = row.get(b);
    if (!bg) {
      bg = this.group(this.pipes.mix, [this.gpu.sampler, a.view, b.view, this.flow[this.flow.length - 1].view, { buffer: this.pbuf }, this.cut.view, this.glob.view]);
      row.set(b, bg);
    }
    this.pass(enc, target.view, this.pipes.mix, bg);
  }

  // How much of the picture would fall back to the plain frame at the halfway
  // picture between a and b (the two frames the last advance matched), into
  // this.wstat.
  stat(enc, a, b) {
    let row = this.statGroups.get(a);
    if (!row) this.statGroups.set(a, (row = new Map()));
    let bg = row.get(b);
    if (!bg) {
      bg = this.group(this.pipes.stats, [this.gpu.sampler, a.view, b.view, this.flow[this.flow.length - 1].view, { buffer: this.sbuf }, this.cut.view, this.glob.view]);
      row.set(b, bg);
    }
    this.pass(enc, this.wstat.view, this.pipes.stats, bg);
  }

  // The frames' textures were remade: bind groups that name them are stale.
  dropGroups() { this.mixGroups.clear(); this.statGroups.clear(); }

  destroy() {
    for (const t of this.textures) t.destroy();
    for (const b of this.qbufs) b.destroy();
    this.pbuf.destroy();
    this.sbuf.destroy();
    this.mixGroups.clear();
    this.statGroups.clear();
  }
}

// ---- When to show what -------------------------------------------------------

// The timing of the made-up pictures, with no GPU in it so that it can be
// tested on its own.
//
// It keeps its own steady clock. A pair of frames (A, then B) starts at t0
// and lasts dur, the time between them in the video, which is the same in
// real time at normal speed; the next pair starts at t0 + dur exactly,
// not when its frame happens to have arrived. Frames turn up on the grid of
// screen refreshes, one refresh early or late, and going by that would show
// the video moving in uneven steps. Going by the clock it moves the same
// amount every refresh. Frames are only waited for: a pair starts at the
// first refresh at or after its time, if its frame is there; if it is not
// (late), the newest frame is held, and when it comes the clock carries on
// where it was, or starts again if it is too far behind.
//
// At any refresh the picture shown is the one t of the way from A to B,
// t = (now - t0) / dur, so B is shown one gap after it turned up: the
// picture runs one video frame behind the sound.
class Sdr2hdrSchedule {
  constructor() { this.reset(); }

  reset() {
    this.curTs = null;     // the newest frame's time in the video (microseconds)
    this.pair = false;     // there is a frame before it, with a motion to go by
    this.t0 = 0;           // when the pair began (ms, on the refreshes' clock)
    this.dur = 0;          // how long it lasts (ms)
  }

  // Is it time for the next frame to begin its pair (if there is one
  // waiting)? Always, when nothing is being made up: frames then go straight
  // to the screen.
  due(now) {
    return !this.pair || now >= this.t0 + this.dur - 0.1;
  }

  // The next frame, with video time ts, begins its pair at now (ms).
  // rate: the video's playback rate. frameMs: how long a frame lasts at
  // normal speed.
  // flowed: the motion between it and the frame before it was worked out.
  // Returns { pair, near, slip, resync, gap }: pair, as above; near, the two
  // frames are one or two frames apart (a bigger hole is a seek or a stall,
  // and nothing is made up across it); slip, how long after its time on the
  // clock this pair began, in ms (NaN if there was no pair before); resync,
  // the clock was started afresh because it was too far behind; gap, the gap
  // in ms (NaN if not near).
  start(now, ts, rate, frameMs, flowed) {
    const real = frameMs / (rate || 1);       // how long a frame lasts as it is being played
    const gap = this.curTs != null && ts != null ? (ts - this.curTs) / 1000 / (rate || 1) : NaN;
    const near = gap > 4 && gap < real * 2.5 + 1;
    const was = this.pair;
    const nextAt = this.t0 + this.dur;
    const slip = was ? now - nextAt : NaN;
    this.pair = near && !!flowed;
    // Carry on from where the clock was unless it is a gap and a half behind
    // (or 50 ms, if that is more).
    const keep = was && this.pair && slip < Math.max(this.dur * 1.5, 50);
    const resync = was && this.pair && !keep;
    this.t0 = keep ? nextAt : now;
    this.dur = near ? gap : real;
    this.curTs = ts;
    return { pair: this.pair, near, slip, resync, gap: near ? gap : NaN };
  }

  // What the refresh at now shows: { kind: 'prev' | 'mid' | 'cur', t }. A
  // picture within a hundredth of a gap of a frame is that frame.
  at(now) {
    if (!this.pair) return { kind: 'cur', t: 1 };
    const t = Math.min(1, Math.max(0, (now - this.t0) / this.dur));
    if (t > 0.99) return { kind: 'cur', t: 1 };
    if (t < 0.01) return { kind: 'prev', t: 0 };
    return { kind: 'mid', t };
  }
}

// ---- The self-check ---------------------------------------------------------

const sdr2hdrHalf = (h) => {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
};

// Made-up frames: the same noise, moved by (mx, my) (fractions of the frame)
// from A to B. Runs the real passes, then reads back the flow and the picture
// at t = 0.5 and compares them with what is known to be true.
// Returns { ok, flowErr, flowSize, midErr, ms, why } with errors in pixels of
// the flow grid (flowErr) and in 0 to 1 colour (midErr), or throws.
async function sdr2hdrInterpSelfTestRun(gpu, pipes, mx, my, t, own, pattern, noise, dbg, patternB) {
  const { device } = gpu;
  const W = 512, H = 288;
  const began = performance.now();
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const keep = own.keep;
  const [FW, FH] = SDR2HDR_FLOW_LEVELS[0];     // the grid the flow is on
  const frame = () => { const t = device.createTexture({ size: [W, H], format: SDR2HDR_FRAME_FORMAT, usage }); keep.push(t); return { tex: t, view: t.createView() }; };
  const A = frame(), B = frame(), E = frame(), M = frame();
  const card = (target, sx, sy, seed = 0, pat = pattern) => {
    const ub = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    keep.push(ub);
    device.queue.writeBuffer(ub, 0, new Float32Array([sx, sy, W, H, pat, noise, seed, pat > 3.5 ? 0.05 : 0]));
    const bind = device.createBindGroup({ layout: pipes.card.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }] });
    rp.setPipeline(pipes.card); rp.setBindGroup(0, bind); rp.draw(4); rp.end();
    device.queue.submit([enc.finish()]);
  };
  // A is the noise as it is; B is the same noise moved by (mx, my); the
  // truth at t is the noise moved t of the way.
  card(A, 0, 0, 1);
  card(B, mx, my, 2, patternB);
  card(E, mx * t, my * t, 3);
  for (const s of [A, B]) s.bgDown1 = device.createBindGroup({ layout: gpu.down1.getBindGroupLayout(0), entries: [{ binding: 0, resource: gpu.sampler }, { binding: 1, resource: s.view }] });
  const motion = (own.motion = new Sdr2hdrMotion(gpu, pipes));
  const bytes = (w, h, size) => { const row = Math.ceil(w * size / 256) * 256; return { row, size: row * h }; };
  const fl = bytes(FW, FH, 8), md = bytes(W, H, 4);
  const fbuf = device.createBuffer({ size: fl.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const mbuf = device.createBuffer({ size: md.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const ebuf = device.createBuffer({ size: md.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const abuf = device.createBuffer({ size: md.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bbuf = device.createBuffer({ size: md.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const cbuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const gbuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const wbuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  keep.push(fbuf, mbuf, ebuf, abuf, bbuf, cbuf, gbuf, wbuf);
  const enc = device.createCommandEncoder();
  motion.advance(enc, A);
  const flowed = motion.advance(enc, B);
  motion.mix(enc, A, B, t, M, dbg);
  motion.stat(enc, A, B);
  enc.copyTextureToBuffer({ texture: motion.flow[motion.flow.length - 1].tex }, { buffer: fbuf, bytesPerRow: fl.row }, [FW, FH]);
  enc.copyTextureToBuffer({ texture: M.tex }, { buffer: mbuf, bytesPerRow: md.row }, [W, H]);
  enc.copyTextureToBuffer({ texture: E.tex }, { buffer: ebuf, bytesPerRow: md.row }, [W, H]);
  enc.copyTextureToBuffer({ texture: A.tex }, { buffer: abuf, bytesPerRow: md.row }, [W, H]);
  enc.copyTextureToBuffer({ texture: B.tex }, { buffer: bbuf, bytesPerRow: md.row }, [W, H]);
  enc.copyTextureToBuffer({ texture: motion.cut.tex }, { buffer: cbuf, bytesPerRow: 256 }, [1, 1]);
  enc.copyTextureToBuffer({ texture: motion.glob.tex }, { buffer: gbuf, bytesPerRow: 256 }, [1, 1]);
  enc.copyTextureToBuffer({ texture: motion.wstat.tex }, { buffer: wbuf, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([enc.finish()]);
  await Promise.all([fbuf, mbuf, ebuf, abuf, bbuf, cbuf, gbuf, wbuf].map((b) => b.mapAsync(GPUMapMode.READ)));
  // Flow: the shift F with A(x + F) = B(x) is minus the motion, in
  // fractions of the frame; compared in pixels of the flow grid, over
  // the middle of the frame (the edges have nothing to match with).
  const f16 = new Uint16Array(fbuf.getMappedRange().slice(0));
  const wantX = -mx * FW, wantY = -my * FH;
  let sum = 0, n = 0;
  const errs = [];
  const margin = 70;
  for (let y = margin; y < FH - margin; y++) {
    for (let x = margin; x < FW - margin; x++) {
      const o = (y * (fl.row / 2)) + x * 4;
      const fx = sdr2hdrHalf(f16[o]) * FW, fy = sdr2hdrHalf(f16[o + 1]) * FH;
      const e = Math.hypot(fx - wantX, fy - wantY);
      sum += e;
      errs.push(e);
      n++;
    }
  }
  const flowAtUv = (u, v) => {
    const x = Math.min(FW - 1, Math.max(0, Math.round(u * FW))), y = Math.min(FH - 1, Math.max(0, Math.round(v * FH)));
    const o = y * (fl.row / 2) + x * 4;
    return [sdr2hdrHalf(f16[o]) * FW, sdr2hdrHalf(f16[o + 1]) * FH, sdr2hdrHalf(f16[o + 2])];
  };
  const flowErr = sum / n;
  errs.sort((a, b) => a - b);
  const flowMedian = errs[errs.length >> 1];
  const flowGood = errs.filter((e) => e < 1).length / errs.length;
  // Picture: mean difference from the truth over the middle.
  const m32 = new Uint32Array(mbuf.getMappedRange().slice(0));
  const read = new Map();     // each buffer can be mapped out once
  const diff = (other, y0 = 40, y1 = H - 40, x0 = 40, x1 = W - 40) => {
    if (!read.has(other)) read.set(other, new Uint32Array(other.getMappedRange().slice(0)));
    const o32 = read.get(other);
    let ds = 0, dn = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = m32[y * (md.row / 4) + x], b = o32[y * (md.row / 4) + x];
        for (let c = 0; c < 3; c++) ds += Math.abs(((a >> (10 * c)) & 1023) - ((b >> (10 * c)) & 1023)) / 1023;
        dn += 3;
      }
    }
    return ds / dn;
  };
  const midErr = diff(ebuf), errA = diff(abuf), errB = diff(bbuf);
  const hy = Math.round(H * 0.45);
  const bands = {
    sky: diff(ebuf, 40, hy - 40),
    horizon: diff(ebuf, hy - 40, hy + 30),
    ground: diff(ebuf, hy + 30, H - 40),
    // the columns at the sides, where what slides in has nothing to be matched with
    left: diff(ebuf, 40, H - 40, 0, 24),
    right: diff(ebuf, 40, H - 40, W - 24, W),
  };
  // With dbg 3 the picture is the fallback weight as grey: its mean is the share that fell back.
  let fell = 0, fn = 0;
  for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 40; x++) { fell += (m32[y * (md.row / 4) + x] & 1023) / 1023; fn++; }
  const fellBack = fell / fn;
  // The fallback weight along one row of the ground, from the left edge to the right (with dbg 3), to see where it falls back.
  // a coarse map of the fallback weight (with dbg 3), to see where
  const map = Array.from({ length: 24 }, (_, gy) => Array.from({ length: 64 }, (_, gx) => (m32[Math.min(H - 1, Math.round((gy + 0.5) * H / 24)) * (md.row / 4) + Math.min(W - 1, Math.round((gx + 0.5) * W / 64))] & 1023) / 1023));
  const rowY = Math.round(H * 0.75);
  const row = Array.from({ length: W }, (_, x) => (m32[rowY * (md.row / 4) + x] & 1023) / 1023);
  const ch = new Uint16Array(cbuf.getMappedRange().slice(0, 8));
  const cutValue = sdr2hdrHalf(ch[0]);
  // the overall motion MIX falls back on, in pixels of the flow grid
  const gh = new Uint16Array(gbuf.getMappedRange().slice(0, 8));
  const globalFlow = [sdr2hdrHalf(gh[0]) * FW, sdr2hdrHalf(gh[1]) * FH];
  // what the statistic for the report says (a coarse grid of the same weight)
  const fellStat = sdr2hdrHalf(new Uint16Array(wbuf.getMappedRange().slice(0, 8))[0]);
  const ms = performance.now() - began;
  const ok = flowed && flowMedian < 0.7 && midErr < 0.01;
  return { ok, flowed, flowErr, flowMedian, flowGood, midErr, errA, errB, cutValue, bands, fellBack, row, globalFlow, flowAtUv, map, fellStat, ms, want: [wantX, wantY], why: ok ? '' : `the flow was off by ${flowMedian.toFixed(2)} px (typical) and the picture by ${(midErr * 100).toFixed(1)}%` };
}

// Runs the check and lets go of everything it made, whether it passed or not.
// pattern: 0 the smooth noise the check uses; 1 a scene (sky, horizon, ground)
// to pan across. noise: how much new noise each frame has (0 for none).
async function sdr2hdrInterpSelfTest(gpu, pipes, mx = 12 / 512, my = 5 / 288, t = 0.5, pattern = 0, noise = 0, dbg = 0, patternB = pattern) {
  const own = { keep: [], motion: null };
  try {
    return await sdr2hdrInterpSelfTestRun(gpu, pipes, mx, my, t, own, pattern, noise, dbg, patternB);
  } finally {
    if (own.motion) own.motion.destroy();
    for (const x of own.keep) x.destroy();
  }
}
