// Finds the display's real maximum brightness, as a multiple of SDR white.
// The square is drawn far brighter than any display can show, so it lands on
// the display's maximum. The cross is drawn at the slider's value. Once the
// slider passes the display's maximum, both clip to the same brightness and
// the cross vanishes: that slider value is the headroom.
const REFERENCE = 24;   // multiples of SDR white; beyond any real display

const WGSL = /* wgsl */ `
struct U { value: f32, reference: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> u: U;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var c = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  var o: VOut;
  o.pos = vec4f(c[i], 0.0, 1.0);
  o.uv = c[i];
  return o;
}

fn toEncoded(c: f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let a = abs(in.uv);
  let inCross = (a.x < 0.14 && a.y < 0.6) || (a.y < 0.14 && a.x < 0.6);
  let lin = select(u.reference, u.value, inCross);
  return vec4f(vec3f(toEncoded(lin)), 1.0);
}
`;

const $ = (id) => document.getElementById(id);
const say = (text, bad) => { $('msg').textContent = text; $('msg').className = bad ? 'bad' : ''; };

(async () => {
  if (!navigator.gpu) return say('WebGPU is not available in this browser.', true);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return say('No GPU found.', true);
  const device = await adapter.requestDevice();

  const ctx = $('c').getContext('webgpu');
  ctx.configure({
    device,
    format: 'rgba16float',
    colorSpace: 'display-p3',
    toneMapping: { mode: 'extended' },
    alphaMode: 'opaque',
  });

  const module = device.createShaderModule({ code: WGSL });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-strip' },
  });
  const data = new Float32Array(4);
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: buf } }],
  });

  function draw() {
    const v = Number($('v').value);
    $('val').textContent = `${v.toFixed(1)}x SDR white`;
    $('v').style.setProperty('--p', `${((v - 1) / 15) * 100}%`);
    data[0] = v;
    data[1] = REFERENCE;
    device.queue.writeBuffer(buf, 0, data);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(4);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
  window.__draw = draw;

  chrome.storage.local.get({ headroom: 0 }, (s) => {
    if (s.headroom > 0) $('v').value = s.headroom;
    draw();
    if (!matchMedia('(dynamic-range: high)').matches) {
      say('This display is not in HDR mode, so the cross will never appear. Turn on HDR in Windows display settings first.', true);
    }
  });

  $('v').addEventListener('input', draw);

  $('save').addEventListener('click', () => {
    const v = Number($('v').value);
    chrome.storage.local.set({ headroom: v }, () =>
      say(`Saved: your display tops out at about ${v.toFixed(1)}x SDR white. You can close this tab.`));
  });

  $('clear').addEventListener('click', () => {
    chrome.storage.local.set({ headroom: 0 }, () => say('Calibration cleared.'));
  });
})();
