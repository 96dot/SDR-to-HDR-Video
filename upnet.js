// The "Best" level of Upscaling: a small trained network, FSRCNNX, that makes
// the brightness of the picture twice as wide and twice as high.
//
// The network itself is not in this file. It is in third_party/fsrcnnx/, as
// the two shader files its author (igv) published for the mpv video player,
// unchanged, under their own licence (LGPL 3: see the README there). Such a
// file is a list of passes, each a few lines of GLSL made of nothing but
// "add this weight times that neighbouring pixel". This file reads that text
// and writes the same passes out in WGSL, the shader language browsers use.
// It knows the handful of line shapes those files are made of and refuses
// anything else, so a file it does not fully understand is never half-run.
//
// What the passes do, in order (8 or 16 channels wide, 4 to a texture):
//   feature map      5x5 around each pixel of the brightness -> features
//   mapping 1..4     3x3 around each pixel of the features -> features
//   sub-band residuals   1x1, plus the first features again
//   sub-pixel convolution   3x3 -> the four new pixels for each old one
// and then one pass of our own (SDR2HDR_UPNET_OUT) puts those four in place
// and gives them the colour of the original picture.

// The text of an mpv hook shader -> { passes: [{ desc, bind: [names], save, code }] }.
// Throws on anything it doesn't know.
function sdr2hdrParseHooks(text) {
  const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
  const LIST = (n) => `(${NUM}(?:\\s*,\\s*${NUM}){${n - 1}})`;
  const OFF = '(?:vec2\\((-?\\d+),\\s*(-?\\d+)\\)|0)';
  const SHAPES = [
    [new RegExp(`^vec4 res = vec4\\(${LIST(4)}\\);$`), (m) => `var res = vec4f(${m[1]});`],
    [new RegExp(`^res \\+= vec4\\(${LIST(4)}\\) \\* float\\((\\w+)_texOff\\(${OFF}\\)\\);$`),
      (m, use) => `res += vec4f(${m[1]}) * luma(${use(m[2])}, p + vec2i(${m[3] || 0}, ${m[4] || 0}), lim);`],
    [new RegExp(`^res \\+= mat4(?:x4)?\\(${LIST(16)}\\) \\* (\\w+)_texOff\\(${OFF}\\);$`),
      (m, use) => `res += mat4x4f(${m[1]}) * at(${use(m[2])}, p + vec2i(${m[3] || 0}, ${m[4] || 0}), lim);`],
    [new RegExp(`^res \\+= (\\w+)_texOff\\(0\\);$`), (m, use) => `res += at(${use(m[1])}, p, lim);`],
    [new RegExp(`^res = max\\(res, vec4\\(0\\.0\\)\\) \\+ vec4\\(${LIST(4)}\\) \\* min\\(res, vec4\\(0\\.0\\)\\);$`),
      (m) => `res = max(res, vec4f(0.0)) + vec4f(${m[1]}) * min(res, vec4f(0.0));`],
  ];
  const SKIP = new Set(['', 'vec4 hook()', '{', '}', 'return res;', 'return vec4(res);']);
  const passes = [];
  let last = false;
  for (const block of text.split('//!HOOK').slice(1)) {
    if (last) throw new Error('there is a pass after the last one');
    // Every pass has to be one that runs on the brightness, at its size.
    if (block.split('\n')[0].trim() !== 'LUMA') throw new Error(`a pass is hooked on ${block.split('\n')[0].trim() || 'nothing'}, not on LUMA`);
    const lines = block.split('\n').slice(1).map((l) => l.trim());
    const p = { desc: '', bind: [], save: null };
    const body = [];
    for (const l of lines) {
      const d = /^\/\/!(\w+)\s*(.*)$/.exec(l);
      if (d) {
        if (d[1] === 'BIND') p.bind.push(d[2].trim());
        else if (d[1] === 'SAVE') p.save = d[2].trim();
        else if (d[1] === 'DESC') p.desc = d[2].trim();
        else if (d[1] === 'COMPONENTS') { if (d[2].trim() !== '4') throw new Error(`pass "${p.desc}" has ${d[2]} components, not 4`); }
        else if (d[1] === 'WIDTH' || d[1] === 'HEIGHT') p.sized = true;
        else if (d[1] !== 'WHEN') throw new Error(`pass "${p.desc || passes.length + 1}" has a direction this does not know: ${d[1]}`);
        continue;
      }
      if (!l.startsWith('//')) body.push(l);
    }
    for (const n of p.bind) if (!/^[A-Z][A-Z0-9_]*$/.test(n)) throw new Error(`odd texture name ${n}`);
    // The last pass of the file only puts the four new pixels in place. Ours
    // does that (and the colour) instead, so it is recognised and left out.
    if (!p.save) {
      if (p.bind.length !== 1 || !body.some((l) => /res\[index\.x \* 2 \+ index\.y\]/.test(l))) throw new Error(`pass "${p.desc}" is not one this can run`);
      last = p.bind[0];
      continue;
    }
    if (p.sized) throw new Error(`pass "${p.desc}" is drawn at another size, which this can not do`);
    if (p.bind.includes(p.save)) throw new Error(`pass "${p.desc}" reads the texture it writes`);
    const used = new Set();
    const use = (name) => {
      if (!p.bind.includes(name)) throw new Error(`pass "${p.desc}" uses ${name} without binding it`);
      used.add(name);
      return 't' + name;
    };
    const out = [];
    for (const l of body) {
      if (SKIP.has(l)) continue;
      const shape = SHAPES.find(([re]) => re.test(l));
      if (!shape) throw new Error(`pass "${p.desc}" has a line this does not know: ${l.slice(0, 60)}`);
      out.push('  ' + shape[1](shape[0].exec(l), use));
    }
    if (!out.length || !out[0].startsWith('  var res')) throw new Error(`pass "${p.desc}" does not start as expected`);
    // A texture that is bound but never read has no place in the pipeline.
    p.bind = p.bind.filter((n) => used.has(n));
    if (!p.bind.length) throw new Error(`pass "${p.desc}" reads nothing`);
    p.code = SDR2HDR_COMMON + p.bind.map((n, i) => `@group(0) @binding(${i}) var t${n}: texture_2d<f32>;`).join('\n') + `
fn at(t: texture_2d<f32>, p: vec2i, lim: vec2i) -> vec4f { return textureLoad(t, clamp(p, vec2i(0), lim), 0); }
// The network works on brightness alone: of the picture as stored.
fn luma(t: texture_2d<f32>, p: vec2i, lim: vec2i) -> f32 { return luma709(at(t, p, lim).rgb); }

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let lim = vec2i(textureDimensions(t${p.bind[0]})) - 1;
${out.join('\n')}
  return res;
}
`;
    passes.push(p);
  }
  if (!last || !passes.length) throw new Error('no passes found');
  // Every texture a pass reads has to have been written by an earlier one
  // (LUMA is the video frame).
  const made = new Set(['LUMA']);
  for (const p of passes) {
    for (const n of p.bind) if (!made.has(n)) throw new Error(`pass "${p.desc}" reads ${n} before it is made`);
    made.add(p.save);
  }
  if (!made.has(last) || last === 'LUMA') throw new Error('the last pass reads nothing the others made');
  return { passes, last };
}

// The pass after the network's: its four numbers per pixel of the frame are
// the brightness of the four pixels that one becomes. Colour is taken from
// the frame itself, stretched the plain way, and shifted to that brightness:
// the eye sees detail in brightness, hardly in colour (video itself stores
// colour at half the resolution for that reason).
const SDR2HDR_UPNET_OUT = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var four: texture_2d<f32>;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let o = vec2i(in.pos.xy);
  let ip = o / 2;
  let sub = o - ip * 2;
  let y = textureLoad(four, ip, 0)[sub.x * 2 + sub.y];
  let c = textureSampleLevel(frame, samp, in.uv, 0.0).rgb;
  return vec4f(clamp(c + (y - luma709(c)), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// The two sizes of the network there are files for, biggest first.
const SDR2HDR_UPNETS = [
  { key: 'x16', name: 'FSRCNNX 16', file: 'third_party/fsrcnnx/FSRCNNX_x2_16-0-4-1.glsl' },
  { key: 'x8', name: 'FSRCNNX 8', file: 'third_party/fsrcnnx/FSRCNNX_x2_8-0-4-1.glsl' },
];
const SDR2HDR_UPNET_FORMAT = 'rgba16float';

// Pipelines for one of them, from its text.
async function sdr2hdrBuildUpnet(device, text) {
  const { passes, last } = sdr2hdrParseHooks(text);
  const make = (code, format) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
  };
  const [out, ...pipes] = await Promise.all([
    make(SDR2HDR_UPNET_OUT, SDR2HDR_FRAME_FORMAT),
    ...passes.map((p) => make(p.code, SDR2HDR_UPNET_FORMAT)),
  ]);
  return {
    passes: passes.map((p, i) => ({ desc: p.desc, bind: p.bind, save: p.save, pipeline: pipes[i] })),
    names: [...new Set(passes.map((p) => p.save))],
    last, out,
  };
}
