// WGSL for the SDR -> HDR pipeline. Six passes per frame:
//
//   1. DOWN1  video -> L1 (480x270)   luminance, "is highlight" and "is clipped" masks
//   2. DOWN   L1 -> L2 (120x68)       4x downsample
//   3. DOWN   L2 -> L3 (30x17)        4x downsample
//   4. DOWN   L3 -> L4 (8x5)          4x downsample
//   5. SCENE  L3 -> 1x1               whole-frame average, smoothed over time
//   6. MAIN   video + L1..L4 + scene -> HDR canvas
//
// Output is extended-range Display P3 (sRGB transfer curve, values above 1.0
// are brighter than SDR white).
//
// Trained model: expansionGain() in MAIN is the hand-written answer to "how
// much brighter should this pixel get". A model from HDR Trainer answers the
// same question instead: it writes a small map of brightness curves (see
// model.js), and modelGain() in MAIN reads each pixel's gain from it. MAIN can
// use either, and split view can put any two of original, shader and model
// side by side.

const SDR2HDR_LEVELS = [[480, 270], [120, 68], [30, 17], [8, 5]];

const SDR2HDR_COMMON = /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

fn quadCorner(i: u32) -> vec2f {
  var c = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  return c[i];
}

@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  let p = quadCorner(i);
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

fn toLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn luma709(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Tap weights for the downsample passes, per axis. A plain box average would
// make a small light's measured size depend on where it sits relative to the
// texel grid, so its brightness would pulse as it moved. Overlapping tent
// weights make the measurement nearly independent of position.
const WEIGHTS = array<f32, 4>(1.0, 3.0, 3.0, 1.0);

// Brightness that drives expansion: luminance mixed with the max channel, so
// saturated lights (neon, fire) count as bright too.
fn drive(lin: vec3f) -> f32 {
  return mix(luma709(lin), max(lin.r, max(lin.g, lin.b)), 0.5);
}

// 1 where a pixel has hit (or nearly hit) the top of the SDR range in any
// channel, which is where the source ran out of room and lost its detail.
fn clipped(lin: vec3f) -> f32 {
  return smoothstep(0.85, 0.95, max(lin.r, max(lin.g, lin.b)));
}
`;

// Pass 1: video -> L1. r = linear luminance, g = highlight mask, b = clipped mask.
const SDR2HDR_DOWN1 = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_external;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // 4x4 bilinear taps, so a 4K frame is properly averaged instead of
  // point-sampled. The taps reach into the neighbouring texels with falling
  // weights (see WEIGHTS), which is what keeps the result steady as things
  // move around the frame.
  let texel = vec2f(1.0 / ${SDR2HDR_LEVELS[0][0]}.0, 1.0 / ${SDR2HDR_LEVELS[0][1]}.0);
  var wts = WEIGHTS;
  var acc = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let o = (vec2f(f32(i), f32(j)) - 1.5) * 0.5;
      let lin = toLinear(textureSampleBaseClampToEdge(src, samp, in.uv + o * texel).rgb);
      acc += wts[i] * wts[j] * vec3f(luma709(lin), smoothstep(0.45, 0.85, drive(lin)), clipped(lin));
    }
  }
  return vec4f(acc / 64.0, 1.0);
}
`;

// Passes 2 to 4: 4x downsample. Each output texel averages an 8x8 block of
// input texels (twice its own footprint) with tent-shaped weights.
const SDR2HDR_DOWN = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var wts = WEIGHTS;
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      // Taps at -3, -1, +1, +3 input texels: each lands on a texel corner,
      // so the bilinear fetch averages a 2x2 block for free.
      let o = (vec2f(f32(i), f32(j)) - 1.5) * 2.0;
      acc += wts[i] * wts[j] * textureSampleLevel(src, samp, in.uv + o * t, 0.0);
    }
  }
  return acc / 64.0;
}
`;

// Pass 5: whole-frame average, eased over time so the picture doesn't pump.
// A big jump (scene cut) snaps quickly instead of easing.
const SDR2HDR_SCENE = SDR2HDR_COMMON + /* wgsl */ `
struct S { reset: f32, dt: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var l3: texture_2d<f32>;
@group(0) @binding(1) var prev: texture_2d<f32>;
@group(0) @binding(2) var<uniform> s: S;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let d = vec2i(textureDimensions(l3));
  var sum = vec2f(0.0);
  for (var y = 0; y < d.y; y++) {
    for (var x = 0; x < d.x; x++) {
      sum += textureLoad(l3, vec2i(x, y), 0).rg;
    }
  }
  let cur = sum / f32(d.x * d.y);
  let p = textureLoad(prev, vec2i(0, 0), 0).rg;

  let slow = 1.0 - exp(-s.dt / 0.7);
  let cut = 0.6 * smoothstep(0.05, 0.2, abs(cur.r - p.r));
  var a = max(slow, cut);
  if (s.reset > 0.5) { a = 1.0; }
  return vec4f(mix(p, cur, a), 0.0, 1.0);
}
`;

// Pass 6: the actual SDR -> HDR conversion.
const SDR2HDR_MAIN = SDR2HDR_COMMON + /* wgsl */ `
struct U {
  scale: vec2f,     // quad scale for object-fit handling
  texel: vec2f,     // size of one video pixel in uv
  peak: f32,        // peak brightness as a multiple of SDR white
  strength: f32,    // 0..1, how far down the tonal range expansion reaches
  sat: f32,         // colour boost (1 = none)
  split: f32,       // 1 = split view is on: draw the line
  seed: f32,        // per-frame noise seed
  splitPos: f32,    // where the split line sits, 0..1 across the video
  headroom: f32,    // brightest the display can show, as a multiple of SDR white
  soften: f32,      // 0..1, how much to shape big blown-out areas
  step: vec2f,      // sharpening tap distance in uv (one source or screen pixel)
  sharpen: f32,     // 0..1
  gamut: f32,       // 0..1, how far vivid colours are stretched toward the P3 edge
  vivid: f32,       // 0..1, how much coloured lights are boosted like white ones
  lite: f32,        // 1 = skip sharpening and debanding (performance)
  left: f32,        // what's shown left of the split line: 0 = the original, 1 = shader, 2 = trained model
  right: f32,       // the same for the right of the line (and for the whole picture when split view is off)
  fit: vec2f,       // share of the model's 16:9 frame the video covers, across and down (model.js)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_external;
@group(0) @binding(3) var l1: texture_2d<f32>;
@group(0) @binding(4) var l2: texture_2d<f32>;
@group(0) @binding(5) var l3: texture_2d<f32>;
@group(0) @binding(6) var l4: texture_2d<f32>;
@group(0) @binding(7) var sceneTex: texture_2d<f32>;
@group(0) @binding(8) var curves: texture_2d<f32>;   // the model's brightness curves (model.js)

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = quadCorner(i);
  var o: VOut;
  o.pos = vec4f(p * u.scale, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

fn toEncoded(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn lumaP3(c: vec3f) -> f32 { return dot(c, vec3f(0.2290, 0.6917, 0.0793)); }

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn maxc(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)); }

fn tap(uv: vec2f) -> vec3f {
  return textureSampleBaseClampToEdge(src, samp, uv).rgb;
}

// Linear Rec.709 -> linear Display P3 (column-major).
const TO_P3 = mat3x3f(
  vec3f(0.8225, 0.0332, 0.0171),
  vec3f(0.1774, 0.9669, 0.0724),
  vec3f(0.0000, 0.0000, 0.9108));

// d:        the pixel's brightness for expansion purposes, 0..1 (see fs)
// coverage: 0 = isolated highlight (sparkle, lamp), 1 = part of a big or
//           dense bright region (sky, white page, a line of subtitles)
// scene:    smoothed average luminance of the whole frame
fn expansionGain(d: f32, coverage: f32, scene: f32) -> f32 {
  // Leave shadows, midtones and skin alone; only the top of the range expands.
  let x = clamp((d - 0.2) / 0.8, 0.0, 1.0);

  // Dark scenes: let the expansion reach a little further down.
  let reach = clamp(u.strength + 0.15 * (1.0 - smoothstep(0.03, 0.15, scene)), 0.0, 1.0);
  let t = pow(x, mix(4.0, 1.5, reach));

  // Bright scenes get less headroom than dark ones, and big bright regions
  // get less than isolated highlights.
  let sceneScale = mix(1.0, 0.6, smoothstep(0.10, 0.45, scene));
  let areaScale = mix(1.0, 0.45 - 0.1 * u.soften, coverage);
  return 1.0 + (u.peak - 1.0) * sceneScale * areaScale * t;
}

// The trained model's answer. Its map holds, at each spot, log2 of the gain
// for pixels of four brightness levels (0.4, 0.7, 0.9 and 1.0, linear). A
// pixel reads the curve at its position at its own brightness: flat below the
// first level, straight lines between. "Brightness" here is the same half
// luminance, half max-channel mix the model was trained with.
//
// The model's map is of a 16:9 frame, in which a video of another shape sits
// with bars; u.fit turns a position in the video into one in that frame.
fn modelGain(uv: vec2f, lin: vec3f) -> f32 {
  let c = textureSampleLevel(curves, samp, (uv - 0.5) * u.fit + 0.5, 0.0);
  let d = drive(lin);
  let g = c.r
    + (c.g - c.r) * clamp((d - 0.4) / 0.3, 0.0, 1.0)
    + (c.b - c.g) * clamp((d - 0.7) / 0.2, 0.0, 1.0)
    + (c.a - c.b) * clamp((d - 0.9) / 0.1, 0.0, 1.0);
  return exp2(g);
}

// Roll-off for the model. The model isn't bound by the Peak slider, so here
// Peak (or the display's maximum, if lower) is a ceiling: highlights ease
// into it instead of clipping flat.
fn rollOffModel(c: vec3f) -> vec3f {
  let h = min(u.headroom, u.peak);
  let knee = 0.75 * h;
  let m = maxc(c);
  if (m <= knee) { return c; }
  let a = h - knee;
  let b = max(3.0 * h, 12.0) - knee;
  let t = clamp((m - knee) / b, 0.0, 1.0);
  let m2 = knee + a * (1.0 - pow(1.0 - t, b / a));
  return c * (m2 / m);
}

// Highlight roll-off. If the pipeline can produce values brighter than the
// display can show, ease the top of the range into the display's maximum
// instead of letting it clip flat. Below the knee nothing changes; the curve
// leaves the knee at slope 1 and lands exactly on the headroom at the
// brightest value we can produce. Scaling by max channel keeps the hue.
fn rollOff(c: vec3f) -> vec3f {
  let h = u.headroom;
  let inMax = u.peak * u.sat;
  let knee = 0.75 * h;
  let m = maxc(c);
  if (inMax <= h || m <= knee) { return c; }
  let a = h - knee;
  let b = inMax - knee;
  let t = clamp((m - knee) / b, 0.0, 1.0);
  let m2 = knee + a * (1.0 - pow(1.0 - t, b / a));
  return c * (m2 / m);
}

// How skin-like a colour is, 0..1. Skin of every tone sits in a narrow band
// of orange hue; lighter skin is less saturated and deeper skin more so, so
// the saturation band is wide. Only near-pure orange (fire, sunsets, hi-vis)
// falls outside it and still gets boosted.
// c is gamma-encoded.
fn skinMask(c: vec3f) -> f32 {
  let mx = maxc(c);
  let mn = min(c.r, min(c.g, c.b));
  let ch = mx - mn;
  if (ch < 0.001 || c.r < c.g || c.g < c.b) { return 0.0; }
  let hue = 60.0 * (c.g - c.b) / ch;            // degrees, 0 = red, 60 = yellow
  let hueW = smoothstep(2.0, 10.0, hue) * (1.0 - smoothstep(38.0, 52.0, hue));
  let s = ch / mx;
  let satW = smoothstep(0.10, 0.22, s) * (1.0 - smoothstep(0.80, 0.95, s));
  return hueW * satW * smoothstep(0.08, 0.20, mx);
}

// How deep inside a blown-out region this pixel is, 0 (at the rim) to 1
// (far inside), on a roughly logarithmic scale. Each pyramid level holds the
// fraction of clipped pixels in its neighbourhood; a level reads as "inside"
// once that fraction passes a half. A pixel a few px in is only inside at the
// finest level, one far in is inside at all four.
fn clipDepth(uv: vec2f) -> f32 {
  let d1 = smoothstep(0.5, 1.0, textureSampleLevel(l1, samp, uv, 0.0).b);
  let d2 = smoothstep(0.5, 1.0, textureSampleLevel(l2, samp, uv, 0.0).b);
  let d3 = smoothstep(0.5, 1.0, textureSampleLevel(l3, samp, uv, 0.0).b);
  let d4 = smoothstep(0.5, 1.0, textureSampleLevel(l4, samp, uv, 0.0).b);
  return (d1 + d2 + d3 + d4) * 0.25;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let enc = tap(in.uv);

  // Sharpening and debanding each read 4 more video pixels per output pixel,
  // which is most of this pass's cost. The light path skips both.
  var smoothed = enc;
  if (u.lite < 0.5) {
    // Sharpen, contrast-adaptive (the idea behind AMD's CAS): look at the four
    // neighbours, and sharpen less where there's already a strong edge or the
    // result would clip, so edges don't grow halos. Texture too faint to be
    // real detail (compression noise) is left alone.
    let sn = tap(in.uv - vec2f(0.0, u.step.y));
    let ss = tap(in.uv + vec2f(0.0, u.step.y));
    let sw = tap(in.uv - vec2f(u.step.x, 0.0));
    let se = tap(in.uv + vec2f(u.step.x, 0.0));
    let lo = min(enc, min(min(sn, ss), min(sw, se)));
    let hi = max(enc, max(max(sn, ss), max(sw, se)));
    let amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, vec3f(0.0001)), vec3f(0.0), vec3f(1.0)));
    let gate = smoothstep(2.0 / 255.0, 8.0 / 255.0, maxc(hi - lo));
    let k = -amp * (0.2 * u.sharpen * gate);
    let sharp = (enc + (sn + ss + sw + se) * k) / (1.0 + 4.0 * k);

    // Deband: compare against 4 neighbours at a random offset. Where they're
    // all within a few 8-bit steps (a smooth gradient), use their average, which
    // fills in the in-between values the 8-bit source couldn't store. Real
    // detail and edges fail the test and keep the sharpened value.
    let r1 = hash(in.pos.xy + u.seed * 91.7);
    let r2 = hash(in.pos.xy * 1.37 + u.seed * 37.3 + 11.0);
    let ang = r1 * 6.2831853;
    let d = vec2f(cos(ang), sin(ang)) * (4.0 + 12.0 * r2);
    let q = vec2f(-d.y, d.x);
    let t0 = tap(in.uv + d * u.texel);
    let t1 = tap(in.uv - d * u.texel);
    let t2 = tap(in.uv + q * u.texel);
    let t3 = tap(in.uv - q * u.texel);
    let dv = max(max(maxc(abs(t0 - enc)), maxc(abs(t1 - enc))),
                 max(maxc(abs(t2 - enc)), maxc(abs(t3 - enc))));
    let flat = 1.0 - smoothstep(1.5 / 255.0, 3.5 / 255.0, dv);
    smoothed = mix(sharp, (t0 + t1 + t2 + t3) * 0.25, flat);
  }
  let r3 = hash(in.pos.xy * 0.73 + u.seed * 53.1 + 5.0);

  // A touch of dither on top.
  let lin = toLinear(clamp(smoothed + (r3 - 0.5) / 255.0, vec3f(0.0), vec3f(1.0)));

  // How much of the surrounding area (about a quarter of the frame width
  // across) is highlight. A sparkle or lamp barely registers; a couple of
  // lines of subtitles register partly; sky or a white page maxes it out.
  // The area is much wider than any light that should get the full boost, so
  // every pixel of that light sees nearly the same value and it brightens
  // evenly. It saturates below 25%, which is what a pixel in the corner of a
  // big white area sees, so big areas are treated evenly right to the rim.
  let c4 = textureSampleLevel(l4, samp, in.uv, 0.0).g;
  let coverage = smoothstep(0.03, 0.20, c4);
  let scene = textureLoad(sceneTex, vec2i(0, 0), 0).r;

  // Blown-out areas: instead of one flat brightness (a white sticker), make
  // them dimmer at the rim and brighter toward the middle, like a light
  // source. Half-way deep is neutral, so mid-sized lights keep their centre
  // brightness. Weighted by coverage so isolated sparkles are untouched, and
  // by the pixel's own clipped-ness so real detail is untouched.
  let shape = 1.0 + 0.8 * u.soften * clipped(lin) * coverage * (clipDepth(in.uv) - 0.5);
  let skin = skinMask(smoothed);

  // Coloured lights. Plain luminance rates a pure red or blue as dim, so a
  // neon sign or brake light would get a fraction of the boost a white lamp
  // does. Leaning on the brightest channel instead lets them expand too. At
  // 0 this is the original half-and-half mix; at 1 a fully saturated light
  // is boosted as much as a white one. Skin is kept on the original mix.
  let lean = mix(0.5, 1.0, u.vivid * (1.0 - skin));
  let bright = mix(luma709(lin), maxc(lin), lean);
  // The max() never lets the shaping push a highlight below plain SDR white.
  var gain = max(1.0, expansionGain(bright, coverage, scene) * shape);
  // Which picture this pixel shows: split view can put a different one on
  // each side of the line.
  let side = select(u.right, u.left, u.split > 0.5 && in.uv.x < u.splitPos);
  let useModel = side > 1.5;
  // The model reads the picture without the dither added above: its curves
  // are steep near white, where that noise would show as grain.
  if (useModel) { gain = modelGain(in.uv, toLinear(clamp(smoothed, vec3f(0.0), vec3f(1.0)))); }

  // Wide colour. Converting Rec.709 to P3 exactly leaves every colour where
  // it was, well inside what a P3 display can show. For vivid colours, blend
  // toward reading the same numbers as P3 directly, which slides them out
  // toward the P3 edge: at full strength a pure Rec.709 red becomes a pure
  // P3 red. Greys are identical either way, muted colours are left alone,
  // and skin is excluded.
  let s8 = clamp(smoothed, vec3f(0.0), vec3f(1.0));
  let vividness = (maxc(s8) - min(s8.r, min(s8.g, s8.b))) / max(maxc(s8), 0.0001);
  let stretch = u.gamut * smoothstep(0.3, 0.8, vividness) * (1.0 - skin);

  var hdr = max(mix(TO_P3 * lin, lin, stretch), vec3f(0.0)) * gain;

  // Colour boost, done in P3 so it can push past the Rec.709 gamut. Skin
  // tones get almost none of it, so faces don't go orange.
  let sat = 1.0 + (u.sat - 1.0) * (1.0 - 0.9 * skin);
  let yh = lumaP3(hdr);
  hdr = max(mix(vec3f(yh), hdr, sat), vec3f(0.0));
  if (useModel) { hdr = rollOffModel(hdr); } else { hdr = rollOff(hdr); }

  var outc = hdr;
  if (side < 0.5) { outc = max(TO_P3 * toLinear(enc), vec3f(0.0)); }
  if (u.split > 0.5 && abs(in.uv.x - u.splitPos) < 0.0012) { outc = vec3f(1.0); }
  return vec4f(toEncoded(outc), 1.0);
}
`;
