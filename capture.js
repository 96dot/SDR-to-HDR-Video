// Saving real frames of what is playing, so that the picture can be tuned on
// real footage instead of made-up pictures (Alt+Shift+C with Stats on; see
// Session.saveStart in content.js). The frames, and a small file about them
// (the report and the sizes and times), are put in one zip that the browser
// saves to Downloads. Nothing is sent anywhere: the zip is made here, in the
// page, and what happens to it after that is for its owner to decide.
//
// This file holds what needs no page: turning frames into pictures (PNG), the
// zip, and the one small shader pass that shrinks a picture for the recorder
// (Alt+Shift+R: the last pictures put on screen); that pass uses the shared
// part of the shaders in shader.js, loaded before it. The frames are read
// back from the GPU in content.js.

// The CRC-32 that a zip keeps for each file.
const SDR2HDR_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function sdr2hdrCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = SDR2HDR_CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// A zip with nothing compressed: each file is stored as it is, which is all
// that is needed for PNGs (already compressed) and a small text file, and
// keeps this to a few lines.
// files: [{ name, data: Uint8Array }]. Returns a Blob.
function sdr2hdrZip(files, when = new Date()) {
  const enc = new TextEncoder();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = sdr2hdrCrc32(f.data);
    // 20: version needed; flag 0x0800: the name is UTF-8; method 0: stored
    const local = cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name);
    parts.push(local, f.data);
    // central directory entry: signature, made by, needed, flags, method, time, date, crc, size, size, name length, extra, comment, disk, internal and external attributes, offset
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    offset += local.length + f.data.length;
  }
  const dir = cat(...central);
  parts.push(dir, cat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(0)));
  return new Blob(parts, { type: 'application/zip' });
}

// The GPU's frames are 10 bits a channel with the red in the lowest bits (see
// SDR2HDR_FRAME_FORMAT). Rows are padded (rowBytes). Returns 8-bit RGBA.
function sdr2hdrFrameToRgba(words, w, h, rowBytes) {
  const out = new Uint8ClampedArray(w * h * 4);
  const stride = rowBytes / 4;
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = words[y * stride + x];
      out[o++] = (v & 1023) >> 2;
      out[o++] = ((v >> 10) & 1023) >> 2;
      out[o++] = ((v >> 20) & 1023) >> 2;
      out[o++] = 255;
    }
  }
  return out;
}

// Shrinks a picture to the size of the target. A picture that is not being
// made smaller is copied as it is; otherwise four bilinear taps near the
// middle of the target texel, which is not a proper box filter (it will alias
// on fine detail when the picture is shrunk a lot) but is enough to look at.
const SDR2HDR_SHRINK = SDR2HDR_COMMON + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let px = vec2f(abs(dpdx(in.uv.x)), abs(dpdy(in.uv.y)));
  if (f32(textureDimensions(src).x) * px.x < 1.01) {
    return vec4f(textureSampleLevel(src, samp, in.uv, 0.0).rgb, 1.0);
  }
  var acc = vec3f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let o = (vec2f(f32(i), f32(j)) - 0.5) * 0.5 * px;
      acc += textureSampleLevel(src, samp, in.uv + o, 0.0).rgb;
    }
  }
  return vec4f(acc * 0.25, 1.0);
}
`;

function sdr2hdrShrinkPipeline(device) {
  const module = device.createShaderModule({ code: SDR2HDR_SHRINK });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vsFull' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: SDR2HDR_FRAME_FORMAT }] },
    primitive: { topology: 'triangle-strip' },
  });
}

// The GPU wants the rows of a copy to a buffer to start on 256 bytes.
function sdr2hdrRowBytes(w) {
  return Math.ceil(w * 4 / 256) * 256;
}

// RGBA to a PNG (as bytes), made no wider than maxW.
async function sdr2hdrPng(rgba, w, h, maxW) {
  const full = new OffscreenCanvas(w, h);
  full.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  let canvas = full;
  if (w > maxW) {
    canvas = new OffscreenCanvas(maxW, Math.round(h * maxW / w));
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, canvas.width, canvas.height);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
}

// Hand a blob to the browser as a download. The link is never put on the
// page: a page could see it, and read what is behind it (the address of a
// blob made here belongs to the page's own origin). The address is let go
// soon after, once the browser has had time to start the download.
function sdr2hdrDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
