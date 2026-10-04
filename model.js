// Runs a model trained with HDR Trainer (hdr-model.json) on the GPU.
//
// The network looks at a 480x270 copy of the frame and writes a small map
// (120x68) of brightness curves: at each spot, four numbers saying how much
// brighter pixels of four brightness levels should get. The main shader then
// reads each pixel's gain from the curve at its position. So the network runs
// once per video frame at low resolution, and the per-pixel work stays a
// texture lookup.
//
// Everything here is WebGPU compute shaders. Layer outputs live in plain
// arrays of numbers on the GPU, laid out row by row with a pixel's channels
// next to each other: index = (y * width + x) * channels + channel.
//
// Passes per frame:
//   prep     video frame -> 480x270 picture, the way the trainer made its inputs
//            (a video that isn't 16:9 sits in it with black bars, unstretched)
//   e1 e2 e3 three shrinking convolutions            -> 240x135, 120x68, 60x34
//   mean     average of each channel over the frame  (whole-frame context)
//   addctx   pass that average through one layer and add it to every pixel
//   b1 b2 b3 three convolutions with widening reach
//   upcat    scale back up to 120x68 and stack with e2's output
//   d1       one more convolution
//   head     four curve points per spot, smoothed over time -> curves texture

const SDR2HDR_MODEL_KNOTS = [0.4, 0.7, 0.9, 1.0];
const SDR2HDR_MODEL_INPUT = [480, 270];    // width, height
const SDR2HDR_MODEL_MAP = [120, 68];       // size of the curves texture
const SDR2HDR_MODEL_LAYERS = ['e1', 'e2', 'e3', 'g', 'b1', 'b2', 'b3', 'd1', 'head'];

// How a video of this size sits in the network's 16:9 frame: the share of the
// frame it covers across and down. A wider video fills the width and leaves
// bars above and below; a narrower one the other way round.
function sdr2hdrModelFit(videoWidth, videoHeight) {
  const frame = SDR2HDR_MODEL_INPUT[0] / SDR2HDR_MODEL_INPUT[1];
  const shape = videoWidth / videoHeight;
  if (!(shape > 0) || Math.abs(shape / frame - 1) < 0.01) return [1, 1];
  return shape > frame ? [1, frame / shape] : [shape / frame, 1];
}

// Check a parsed hdr-model.json. Returns { widths, info } or throws an Error
// whose message can be shown to the user.
function sdr2hdrCheckModel(m) {
  const fail = (why) => { throw new Error(why); };
  if (!m || typeof m !== 'object' || m.format !== 'sdr2hdr-gainnet') fail("This isn't a model file from HDR Trainer.");
  if (m.version !== 1) fail('This model was made by a newer HDR Trainer than this extension understands. Update the extension.');
  const inp = m.input || {}, out = m.output || {};
  if (inp.width !== SDR2HDR_MODEL_INPUT[0] || inp.height !== SDR2HDR_MODEL_INPUT[1]) fail('This model expects a picture size this extension does not support.');
  const knots = out.knots || [];
  if (knots.length !== 4 || knots.some((k, i) => Math.abs(k - SDR2HDR_MODEL_KNOTS[i]) > 1e-6)) fail('This model uses brightness levels this extension does not support.');
  if (!(out.bound > 0 && out.bound <= 16)) fail('The model file is missing its output range.');

  const layers = {};
  for (const l of Array.isArray(m.layers) ? m.layers : []) layers[l && l.name] = l;
  for (const n of SDR2HDR_MODEL_LAYERS) if (!layers[n]) fail(`The model file is missing layer "${n}".`);
  const c1 = layers.e1.shape[0], c2 = layers.e2.shape[0], c3 = layers.e3.shape[0];
  const want = {
    e1: [c1, 3, 3, 3], e2: [c2, c1, 3, 3], e3: [c3, c2, 3, 3], g: [c3, c3],
    b1: [c3, c3, 3, 3], b2: [c3, c3, 3, 3], b3: [c3, c3, 3, 3],
    d1: [c2, c3 + c2, 3, 3], head: [4, c2, 1, 1],
  };
  let params = 0;
  for (const n of SDR2HDR_MODEL_LAYERS) {
    const l = layers[n], shape = l.shape || [];
    if (shape.length !== want[n].length || shape.some((v, i) => v !== want[n][i])) fail(`Layer "${n}" has an unexpected shape.`);
    const count = shape.reduce((a, b) => a * b, 1);
    if (!Array.isArray(l.weight) || l.weight.length !== count || !Array.isArray(l.bias) || l.bias.length !== shape[0]) fail(`Layer "${n}" has the wrong number of weights.`);
    for (const arr of [l.weight, l.bias]) {
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) fail(`Layer "${n}" holds an invalid number. Export the model again.`);
    }
    params += count + shape[0];
  }
  if (!(c1 > 0 && c2 > 0 && c3 > 0) || Math.max(c1, c2, c3) > 128) fail('The model is a size this extension does not support.');
  const t = m.trained || {};
  return {
    widths: [c1, c2, c3],
    layers,
    bound: out.bound,
    info: {
      steps: Number.isFinite(t.steps) ? t.steps : null,
      movies: Array.isArray(t.movies) ? t.movies.length : null,
      error: Number.isFinite(t.test_error) ? t.test_error : null,
      baseline: Number.isFinite(t.plain_sdr_error) ? t.plain_sdr_error : null,
      exported: typeof m.exported === 'string' ? m.exported : null,
      trainer: typeof m.trainer_version === 'string' ? m.trainer_version : null,
      params,
      // For the Guided method (see lightLike in shader.js): written by HDR
      // Trainer 0.5 and later.
      guide: (() => {
        const g = m.guide;
        if (!g || !Number.isFinite(g.lo) || !Number.isFinite(g.hi) || !(g.hi - g.lo > 0.02)) return null;
        return { lo: g.lo, hi: g.hi, agreement: Number.isFinite(g.agreement) ? g.agreement : null };
      })(),
    },
  };
}

const SDR2HDR_MODEL_WGSL = {
  // Shrink the video frame to the network's input size. 16 taps per output
  // pixel, averaged in linear light, then stored sRGB-encoded and scaled to
  // -1..1, which is what the network was trained on.
  //
  // The network's picture is always 16:9. The trainer never stretched a film
  // to fit: a wider or narrower one was shown with black bars. So the same is
  // done here. p.fit is the share of the 16:9 frame the video covers on each
  // axis (1, 1 for a 16:9 video).
  prep: /* wgsl */ `
struct P { w: u32, h: u32, a: u32, b: u32, fit: vec2f, c: vec2f };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
fn toEncoded(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let size = vec2f(f32(p.w), f32(p.h));
  var acc = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let spot = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) * 0.25) / size;   // in the 16:9 frame
      let uv = (spot - 0.5) / p.fit + 0.5;                                       // the same spot in the video
      // Sampled either way (the shader language wants that), counted only
      // when it lands on the picture; the rest is black bar.
      let c = textureSampleLevel(src, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
      if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
        acc += toLinear(clamp(c, vec3f(0.0), vec3f(1.0)));
      }
    }
  }
  let e = toEncoded(acc / 16.0) * 2.0 - 1.0;
  let o = (id.y * p.w + id.x) * 3u;
  dst[o] = e.r;
  dst[o + 1u] = e.g;
  dst[o + 2u] = e.b;
}`,

  // One convolution layer. One GPU thread per output number.
  // Weights are stored as PyTorch stores them: [out][in][ky][kx].
  conv: /* wgsl */ `
struct P {
  inW: u32, inH: u32, inC: u32, outW: u32, outH: u32, outC: u32,
  k: u32, stride: u32, dil: u32, wOff: u32, bOff: u32, relu: u32,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.outW || id.y >= p.outH || id.z >= p.outC) { return; }
  let kk = p.k * p.k;
  let pad = i32(p.dil * (p.k / 2u));
  var acc = w[p.bOff + id.z];
  for (var ky = 0u; ky < p.k; ky++) {
    let iy = i32(id.y * p.stride + ky * p.dil) - pad;
    if (iy < 0 || iy >= i32(p.inH)) { continue; }
    for (var kx = 0u; kx < p.k; kx++) {
      let ix = i32(id.x * p.stride + kx * p.dil) - pad;
      if (ix < 0 || ix >= i32(p.inW)) { continue; }
      let s = (u32(iy) * p.inW + u32(ix)) * p.inC;
      let wi = p.wOff + id.z * p.inC * kk + ky * p.k + kx;
      for (var ic = 0u; ic < p.inC; ic++) {
        acc += src[s + ic] * w[wi + ic * kk];
      }
    }
  }
  if (p.relu == 1u) { acc = max(acc, 0.0); }
  dst[(id.y * p.outW + id.x) * p.outC + id.z] = acc;
}`,

  // Average of each channel over the whole frame.
  mean: /* wgsl */ `
struct P { n: u32, c: u32, a: u32, b: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.c) { return; }
  var acc = 0.0;
  for (var i = 0u; i < p.n; i++) { acc += src[i * p.c + id.x]; }
  dst[id.x] = acc / f32(p.n);
}`,

  // Whole-frame context: run the channel averages through one layer, and add
  // the result to every pixel.
  addctx: /* wgsl */ `
struct P { w: u32, h: u32, c: u32, wOff: u32, bOff: u32, a: u32, b: u32, d: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read> avg: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h || id.z >= p.c) { return; }
  var ctx = w[p.bOff + id.z];
  for (var ic = 0u; ic < p.c; ic++) { ctx += avg[ic] * w[p.wOff + id.z * p.c + ic]; }
  let i = (id.y * p.w + id.x) * p.c + id.z;
  dst[i] = src[i] + max(ctx, 0.0);
}`,

  // Scale the small layer up to the bigger one's size (the same bilinear
  // scaling PyTorch does) and stack the bigger layer's channels after it.
  upcat: /* wgsl */ `
struct P { lowW: u32, lowH: u32, lowC: u32, w: u32, h: u32, skipC: u32, a: u32, b: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> low: array<f32>;
@group(0) @binding(2) var<storage, read> skip: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let sx = max((f32(id.x) + 0.5) * f32(p.lowW) / f32(p.w) - 0.5, 0.0);
  let sy = max((f32(id.y) + 0.5) * f32(p.lowH) / f32(p.h) - 0.5, 0.0);
  let x0 = min(u32(sx), p.lowW - 1u);
  let y0 = min(u32(sy), p.lowH - 1u);
  let x1 = min(x0 + 1u, p.lowW - 1u);
  let y1 = min(y0 + 1u, p.lowH - 1u);
  let fx = sx - f32(x0);
  let fy = sy - f32(y0);
  let outC = p.lowC + p.skipC;
  let o = (id.y * p.w + id.x) * outC;
  for (var c = 0u; c < p.lowC; c++) {
    let a = mix(low[(y0 * p.lowW + x0) * p.lowC + c], low[(y0 * p.lowW + x1) * p.lowC + c], fx);
    let b = mix(low[(y1 * p.lowW + x0) * p.lowC + c], low[(y1 * p.lowW + x1) * p.lowC + c], fx);
    dst[o + c] = mix(a, b, fy);
  }
  let s = (id.y * p.w + id.x) * p.skipC;
  for (var c = 0u; c < p.skipC; c++) { dst[o + p.lowC + c] = skip[s + c]; }
}`,

  // The last layer: four curve points per spot. They are eased over time so
  // the picture doesn't flicker from frame to frame, but where the answer
  // has changed a lot (a scene cut) the new value is taken straight away.
  head: /* wgsl */ `
struct P { w: u32, h: u32, c: u32, wOff: u32, bOff: u32, a: u32, alpha: f32, bound: f32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> wts: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> prev: array<f32>;
@group(0) @binding(4) var curves: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let s = (id.y * p.w + id.x) * p.c;
  var v = vec4f(wts[p.bOff], wts[p.bOff + 1u], wts[p.bOff + 2u], wts[p.bOff + 3u]);
  for (var ic = 0u; ic < p.c; ic++) {
    let x = src[s + ic];
    v += x * vec4f(wts[p.wOff + ic], wts[p.wOff + p.c + ic], wts[p.wOff + 2u * p.c + ic], wts[p.wOff + 3u * p.c + ic]);
  }
  v = p.bound * tanh(v / p.bound);

  let o = (id.y * p.w + id.x) * 4u;
  let old = vec4f(prev[o], prev[o + 1u], prev[o + 2u], prev[o + 3u]);
  let d = abs(v - old);
  let jump = smoothstep(0.5, 1.5, max(max(d.x, d.y), max(d.z, d.w)));
  let now = mix(old, v, max(p.alpha, jump));
  prev[o] = now.x;
  prev[o + 1u] = now.y;
  prev[o + 2u] = now.z;
  prev[o + 3u] = now.w;
  textureStore(curves, vec2i(id.xy), now);
}`,
};

// Compile the shaders and upload the weights. Shared by every video on the
// page. Throws if the model file is not usable.
async function sdr2hdrBuildModel(device, sampler, json) {
  const checked = sdr2hdrCheckModel(json);
  const [c1, c2, c3] = checked.widths;

  // All weights in one array: each layer's weights, then its biases.
  let total = 0;
  const off = {};
  for (const n of SDR2HDR_MODEL_LAYERS) {
    const l = checked.layers[n];
    off[n] = { w: total, b: total + l.weight.length };
    total += l.weight.length + l.bias.length;
  }
  const flat = new Float32Array(total);
  for (const n of SDR2HDR_MODEL_LAYERS) {
    flat.set(checked.layers[n].weight, off[n].w);
    flat.set(checked.layers[n].bias, off[n].b);
  }
  const wbuf = device.createBuffer({ size: flat.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(wbuf, 0, flat);

  const pipes = {};
  await Promise.all(Object.keys(SDR2HDR_MODEL_WGSL).map(async (k) => {
    const module = device.createShaderModule({ code: SDR2HDR_MODEL_WGSL[k] });
    pipes[k] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  }));

  const [W, H] = SDR2HDR_MODEL_INPUT;
  const half = (n) => Math.ceil(n / 2);
  const w1 = half(W), h1 = half(H), w2 = half(w1), h2 = half(h1), w3 = half(w2), h3 = half(h2);
  if (w2 !== SDR2HDR_MODEL_MAP[0] || h2 !== SDR2HDR_MODEL_MAP[1]) throw new Error('Unexpected curve map size.');

  const model = {
    info: checked.info,
    destroyed: false,
    destroy() { this.destroyed = true; wbuf.destroy(); },

    // The per-video part: the arrays the layers write into, and the list of
    // passes. curvesView is where the result goes (rgba16float, 120x68).
    createRun(curvesView) {
      const made = [];
      try {
        return this.buildRun(curvesView, made);
      } catch (e) {
        for (const b of made) b.destroy();     // don't leave a half-made set of buffers behind
        throw e;
      }
    },

    buildRun(curvesView, made) {
      const store = (count) => {
        const b = device.createBuffer({
          size: Math.max(16, count * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        made.push(b);
        return b;
      };
      const uniform = (u32s, f32s = []) => {
        const data = new ArrayBuffer((u32s.length + f32s.length) * 4);
        new Uint32Array(data, 0, u32s.length).set(u32s);
        new Float32Array(data, u32s.length * 4, f32s.length).set(f32s);
        const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        made.push(b);
        return b;
      };
      const group = (pipe, resources) => device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: resources.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
      });
      const grid = (w, h, d = 1) => [Math.ceil(w / 8), Math.ceil(h / 8), d];

      const a0 = store(W * H * 3);
      const a1 = store(w1 * h1 * c1);
      const a2 = store(w2 * h2 * c2);
      const a3 = store(w3 * h3 * c3);
      const avg = store(c3);
      const a4 = store(w3 * h3 * c3);
      const a5 = store(w3 * h3 * c3);
      const a6 = store(w2 * h2 * (c3 + c2));
      const a7 = store(w2 * h2 * c2);
      const prev = store(w2 * h2 * 4);

      const conv = (name, src, dst, inW, inH, inC, outW, outH, outC, stride, dil) => ({
        pipe: pipes.conv,
        bind: group(pipes.conv, [uniform([inW, inH, inC, outW, outH, outC, 3, stride, dil, off[name].w, off[name].b, 1]), wbuf, src, dst]),
        size: grid(outW, outH, outC),
      });
      const headUniform = uniform([w2, h2, c2, off.head.w, off.head.b, 0], [1, checked.bound]);
      const prepUniform = uniform([W, H, 0, 0], [1, 1, 0, 0]);
      const fitNow = new Float32Array([1, 1]);
      let prepSrc = null, prepBind = null;
      const prepBinds = new Map();
      const passes = [
        conv('e1', a0, a1, W, H, 3, w1, h1, c1, 2, 1),
        conv('e2', a1, a2, w1, h1, c1, w2, h2, c2, 2, 1),
        conv('e3', a2, a3, w2, h2, c2, w3, h3, c3, 2, 1),
        { pipe: pipes.mean, bind: group(pipes.mean, [uniform([w3 * h3, c3, 0, 0]), a3, avg]), size: [c3, 1, 1] },
        { pipe: pipes.addctx, bind: group(pipes.addctx, [uniform([w3, h3, c3, off.g.w, off.g.b, 0, 0, 0]), wbuf, a3, avg, a4]), size: grid(w3, h3, c3) },
        conv('b1', a4, a5, w3, h3, c3, w3, h3, c3, 1, 1),
        conv('b2', a5, a4, w3, h3, c3, w3, h3, c3, 1, 2),
        conv('b3', a4, a5, w3, h3, c3, w3, h3, c3, 1, 4),
        { pipe: pipes.upcat, bind: group(pipes.upcat, [uniform([w3, h3, c3, w2, h2, c2, 0, 0]), a5, a2, a6]), size: grid(w2, h2) },
        conv('d1', a6, a7, w2, h2, c3 + c2, w2, h2, c2, 1, 1),
        { pipe: pipes.head, bind: group(pipes.head, [headUniform, wbuf, a7, prev, curvesView]), size: grid(w2, h2) },
      ];
      const alpha = new Float32Array(1);

      return {
        model,
        input: a0,      // exposed so a test can feed the network directly
        output: prev,   // the curve map as numbers, [y][x][4]
        // Add this frame's passes to a command encoder. src is a view of
        // the video frame as an ordinary texture (leave it out to use
        // whatever is already in the input array).
        // alpha is how far to move toward this frame's answer, 0..1.
        // fit is the share of the network's 16:9 frame the video covers, as
        // [across, down] (see sdr2hdrModelFit).
        encode(enc, src, a, fit = [1, 1]) {
          alpha[0] = a;
          device.queue.writeBuffer(headUniform, 24, alpha);
          if (fit[0] !== fitNow[0] || fit[1] !== fitNow[1]) {
            fitNow.set(fit);
            device.queue.writeBuffer(prepUniform, 16, fitNow);
          }
          const pass = enc.beginComputePass();
          if (src) {
            // The frame texture only changes when the video's size does, so
            // its bind group is kept from one frame to the next.
            // (One for each of the few frame textures a video goes round.)
            if (prepSrc !== src) {
              prepSrc = src;
              prepBind = prepBinds.get(src);
              if (!prepBind) {
                if (prepBinds.size >= 8) prepBinds.clear();
                prepBind = group(pipes.prep, [prepUniform, sampler, src, a0]);
                prepBinds.set(src, prepBind);
              }
            }
            pass.setPipeline(pipes.prep);
            pass.setBindGroup(0, prepBind);
            pass.dispatchWorkgroups(...grid(W, H));
          }
          for (const p of passes) {
            pass.setPipeline(p.pipe);
            pass.setBindGroup(0, p.bind);
            pass.dispatchWorkgroups(...p.size);
          }
          pass.end();
        },
        destroy() { for (const b of made) b.destroy(); },
      };
    },
  };
  return model;
}
