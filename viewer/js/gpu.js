// WebGPU device / swap-chain setup and the per-frame global uniform block.

import { note } from './log.js';
export const GLOBALS_SIZE = 352;

// The hole the cutaway opens along the line of sight is drawn in close to you: this wide at you
// (yards), widening this fast toward the camera. (cutaway.js goes by the same two, for what can
// be clicked.)
export const CUT_NARROW = 1.6, CUT_WIDEN = 1.2;

/** WGSL declaration shared by every pipeline (bind group 0). */
export const GLOBALS_WGSL = /* wgsl */ `
struct Globals {
  viewProj: mat4x4f,
  sunDir: vec3f, time: f32,
  sunColor: vec3f, fogDensity: f32,
  skyAmbient: vec3f, slopeCos: f32,
  groundAmbient: vec3f, overlay: f32,       // bit 1: slope, bit 2: contours, bit 4: areas
  fogColor: vec3f, contourStep: f32,
  camZ: f32, pixelAngle: f32, fogHeight: f32, pad0: f32,
  zenith: vec3f, pad1: f32,
  camRight: vec3f, tanX: f32,
  camUp: vec3f, tanY: f32,
  camFwd: vec3f, pad2: f32,
  // The cutaway (cutaway.js works these out; places are counted from the camera):
  cut: vec4f,      // the circle around you: x, y, the height it cuts above, its radius (0: no cutaway at all)
  cutOpts: vec4f,  // x: the circle takes everything (else tree tops only), y: the ground is cut too (you are under it), z: the line of sight cuts nothing below this height, w: how wide it is for the trees (they are cut along it always)
  cutLine: vec4f,  // the line of sight: your chest, and how wide the hole along it is (0: shut)
  cutRoom: vec4f,  // the room you are in: the middle of its box (x, y), half its two sides...
  cutRoomB: vec4f, // ...the cosine and sine of its turn, the height it is cut above, on (1) or off
  cutCity: vec4f,  // the city under the ground you are in: the same
  cutCityB: vec4f,
  cutLand: vec4f,  // x: how wide the hole along the line of sight is for the ground (0: shut - no hill is in the way)
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var nearestSampler: sampler;

fn applyFog(color: vec3f, rel: vec3f) -> vec3f {
  let d = length(rel);
  // Thinner haze when looking down from altitude, thicker along the horizon.
  let f = 1.0 - exp(-d * G.fogDensity);
  return mix(color, G.fogColor, clamp(f, 0.0, 1.0));
}

// Inside a box of the cutaway (a room, a city under the ground), above the height it cuts at?
fn cutBox(rel: vec3f, a: vec4f, b: vec4f) -> bool {
  if (b.w < 0.5 || rel.z < b.z) { return false; }
  let d = rel.xy - a.xy;
  return abs(d.x * b.x + d.y * b.y) < a.z && abs(d.y * b.x - d.x * b.y) < a.w;
}

// Inside the hole along the line of sight: a tunnel from you to the camera, cutLine.w yards
// wide, drawn in close to you so that what you stand next to is left alone. (As wide all the
// way: what is in the way far from the camera gets a window, what is right in front of the
// camera - the wall it has backed into - goes altogether. cutaway.js has the same shape, for
// what can be clicked.)
fn cutSight(rel: vec3f, wide: f32) -> bool {
  if (wide <= 0.0 || rel.z < G.cutOpts.z) { return false; }
  let q = G.cutLine.xyz;
  let far = length(q);
  let v = rel - q;
  let s = -dot(v, q) / far;        // how far from you, toward the camera
  if (s <= 0.0 || s >= far) { return false; }
  let off = v + q * (s / far);
  let r = min(wide, ${CUT_NARROW.toFixed(3)} + s * ${CUT_WIDEN.toFixed(3)});
  return dot(off, off) < r * r;
}

// True for what the cutaway takes off the picture. tree: this is one of the trees. Their tops
// go in a circle around you, and along the line of sight always (a forest's canopy is in the
// way more often than not, and nothing in the game's data says where it is); of anything else,
// only what is found to be in the way.
fn cutAway(rel: vec3f, tree: bool) -> bool {
  if (G.cut.w <= 0.0) { return false; }
  if (tree || G.cutOpts.x > 0.5) {
    let d = rel.xy - G.cut.xy;
    if (rel.z > G.cut.z && dot(d, d) < G.cut.w * G.cut.w) { return true; }
  }
  if (tree && cutSight(rel, G.cutOpts.w)) { return true; }
  return cutBox(rel, G.cutRoom, G.cutRoomB) || cutBox(rel, G.cutCity, G.cutCityB) || cutSight(rel, G.cutLine.w);
}

fn lambert(n: vec3f) -> vec3f {
  let ndl = max(dot(n, G.sunDir), 0.0);
  let hemi = mix(G.groundAmbient, G.skyAmbient, n.z * 0.5 + 0.5);
  return hemi + G.sunColor * ndl;
}
`;

// How long to wait before each further try at getting the graphics card (ms). A card can refuse
// for a moment and be perfectly willing the next: just after the page has loaded itself again
// (the page before is still letting go of it - as after a map build), or while the game has it
// busy. What it says then is that it is "out of memory".
const TRIES = [0, 500, 1000, 2000, 3000, 4000];

/**
 * The graphics card, for drawing with: asked again where it refuses, and of the other card
 * where the computer has two (a laptop's own, when the one the game runs on will not).
 * @param waiting  called before each further try: (which try, of how many)
 * Throws what the last try said; `.none` on it means there is no WebGPU here at all.
 */
/** What a graphics card says of itself, for the page's notes. */
function about(adapter, powerPreference) {
  const i = adapter.info ?? {};
  return { vendor: i.vendor ?? null, architecture: i.architecture ?? null, device: i.device ?? null, description: i.description ?? null, asked: powerPreference, software: adapter.isFallbackAdapter ?? i.isFallbackAdapter ?? null, features: [...adapter.features].sort(), limits: { texture: adapter.limits?.maxTextureDimension2D, buffer: adapter.limits?.maxBufferSize, layers: adapter.limits?.maxTextureArrayLayers } };
}

async function getDevice(waiting) {
  if (!navigator.gpu) throw Object.assign(new Error('WebGPU is not available in this browser. Use a current version of Chrome or Edge.'), { none: true });
  let last = null, found = false;
  for (let i = 0; i < TRIES.length; i++) {
    if (TRIES[i]) { waiting(i, TRIES.length - 1); await new Promise((r) => setTimeout(r, TRIES[i])); }
    for (const powerPreference of i < 2 ? ['high-performance'] : ['high-performance', 'low-power']) {
      try {
        // (asked for afresh each time: one that has refused is of no further use)
        const adapter = await navigator.gpu.requestAdapter({ powerPreference });
        if (!adapter) { last = last ?? new Error('No WebGPU adapter found (is hardware acceleration enabled?).'); continue; }
        found = true;
        const requiredFeatures = adapter.features.has('texture-compression-bc') ? ['texture-compression-bc'] : [];
        const device = await adapter.requestDevice({ requiredFeatures });
        const info = about(adapter, powerPreference);
        note('gpu', `the graphics card has started${i ? `, at try ${i + 1}` : ''}`, info);
        return { device, requiredFeatures, info };
      } catch (err) { last = err; note('gpu', `the graphics card would not start (try ${i + 1}, ${powerPreference})`, { error: String(err?.message ?? err) }); }
    }
  }
  throw Object.assign(last ?? new Error('The graphics card could not be started.'), { none: !found });
}

export async function initGPU(canvas, waiting = () => {}) {
  const { device, requiredFeatures, info } = await getDevice(waiting);
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  // Render through an sRGB view so lighting math happens in linear space.
  const colorFormat = format + '-srgb';
  context.configure({ device, format, viewFormats: [colorFormat], alphaMode: 'opaque' });

  const gpu = {
    device, context, canvas, format, colorFormat,
    depthFormat: 'depth32float',
    bc: requiredFeatures.length > 0,
    sampleCount: 4,
    scale: 1,       // fraction of full resolution the picture is drawn at (lowered while the card is busy)
    pixelRatio: 1,  // picture pixels per CSS pixel
    lost: false,
    info,           // what the card says of itself (for "Report a problem")
  };
  device.lost.then((info) => { gpu.lost = true; note('gpu', `the graphics card was lost: ${info.reason ?? ''}`, { message: info.message }); gpu.onLost?.(info); });
  // (what the card refuses while drawing - a texture too large, memory gone - would otherwise only be said on the console)
  let refused = 0;
  device.addEventListener?.('uncapturederror', (e) => { if (++refused <= 20) note('gpu', `the graphics card refused something${refused === 20 ? ' (no more of these are noted)' : ''}`, { kind: e.error?.constructor?.name, message: String(e.error?.message ?? '').slice(0, 600) }); });

  gpu.globalsBuffer = device.createBuffer({ label: 'globals', size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  gpu.globalsLayout = device.createBindGroupLayout({
    label: 'globals',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
    ],
  });
  gpu.globalsGroup = device.createBindGroup({
    layout: gpu.globalsLayout,
    entries: [
      { binding: 0, resource: { buffer: gpu.globalsBuffer } },
      { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }) },
      { binding: 2, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }) },
    ],
  });
  return gpu;
}

/** (Re)create the multisampled colour + depth targets for the current canvas size. */
export function resizeTargets(gpu) {
  const { device, canvas } = gpu;
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * (gpu.scale || 1);
  gpu.pixelRatio = dpr;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (gpu.width === w && gpu.height === h && gpu.colorTarget) return false;
  canvas.width = w; canvas.height = h;
  gpu.width = w; gpu.height = h;
  gpu.colorTarget?.destroy();
  gpu.depthTarget?.destroy();
  gpu.colorTarget = device.createTexture({ size: [w, h], sampleCount: gpu.sampleCount, format: gpu.colorFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  gpu.depthTarget = device.createTexture({ size: [w, h], sampleCount: gpu.sampleCount, format: gpu.depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  gpu.colorView = gpu.colorTarget.createView();
  gpu.depthView = gpu.depthTarget.createView();
  return true;
}

/** Common pipeline pieces. Depth is reversed (1 = near, 0 = far). */
export function targets(gpu, blend) {
  return [{ format: gpu.colorFormat, blend }];
}
export const depthState = (gpu, write = true) => ({ format: gpu.depthFormat, depthWriteEnabled: write, depthCompare: 'greater' });
export const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};
