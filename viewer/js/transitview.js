// The boats, zeppelins and trams as shapes in the world, each where it is this moment
// (transit.js says where). A ship with a mast, an airship with its car slung under it, a tram
// car: their real size up close, and from further away enlarged just enough to stay easy to
// see, in the colour of the side whose line it is. Where the game's own model of a craft has
// been made ready (extractor: transport models), main.js draws that instead of the shape.
import { GLOBALS_WGSL, targets, depthState } from './gpu.js';
import { DEG } from './math.js';

export const CRAFT_MIN_PX = 34;   // a craft is never drawn shorter than this on screen (CSS pixels)
const STRIDE = 7;    // floats per vertex: position, normal, part (0 body, 1 trim)
const MOST = 40;     // crafts drawn at once

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Craft {
  model: mat4x4f,   // craft space -> camera-relative world space
  body: vec4f,
  trim: vec4f,
};
@group(1) @binding(0) var<uniform> F: Craft;

struct VSOut { @builtin(position) clip: vec4f, @location(0) rel: vec3f, @location(1) normal: vec3f, @location(2) part: f32 };
@vertex fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) part: f32) -> VSOut {
  var out: VSOut;
  let rel = (F.model * vec4f(pos, 1.0)).xyz;
  out.clip = G.viewProj * vec4f(rel, 1.0);
  out.rel = rel;
  out.normal = (F.model * vec4f(normal, 0.0)).xyz;
  out.part = part;
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let base = mix(F.body.rgb, F.trim.rgb, step(0.5, in.part));
  let n = normalize(in.normal);
  let lit = base * max(lambert(n), vec3f(0.5));
  let rim = pow(1.0 - abs(dot(n, normalize(-in.rel))), 3.0) * 0.25;
  return vec4f(lit + vec3f(rim), F.body.a);
}
`;

// ---- shapes (craft space: +X is the bow, +Y is port, +Z is up; yards) ----
function tri(out, a, b, c, part) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (const p of [a, b, c]) out.push(p[0], p[1], p[2], nx, ny, nz, part);
}
const quad = (out, a, b, c, d, part) => { tri(out, a, b, c, part); tri(out, a, c, d, part); };
function box(out, x0, x1, y0, y1, z0, z1, part) {
  const p = (x, y, z) => [x, y, z];
  quad(out, p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), part);
  quad(out, p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), p(x0, y0, z0), part);
  quad(out, p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), part);
  quad(out, p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), part);
  quad(out, p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), part);
  quad(out, p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), part);
}
/** A hull: an outline of [x, half width] from stern to bow, from the keel (narrower) up to the deck. */
function hull(out, outline, keel, deck, part) {
  const n = outline.length;
  for (let i = 0; i + 1 < n; i++) {
    const [x0, w0] = outline[i], [x1, w1] = outline[i + 1];
    for (const side of [1, -1]) {
      const a = [x0, side * w0 * 0.45, keel], b = [x1, side * w1 * 0.45, keel], c = [x1, side * w1, deck], d = [x0, side * w0, deck];
      if (side > 0) quad(out, a, b, c, d, part); else quad(out, b, a, d, c, part);
    }
    quad(out, [x0, -w0, deck], [x1, -w1, deck], [x1, w1, deck], [x0, w0, deck], 1);          // the deck
    quad(out, [x1, -w1 * 0.45, keel], [x0, -w0 * 0.45, keel], [x0, w0 * 0.45, keel], [x1, w1 * 0.45, keel], part); // the bottom
  }
  const [xs, ws] = outline[0];
  quad(out, [xs, ws * 0.45, keel], [xs, -ws * 0.45, keel], [xs, -ws, deck], [xs, ws, deck], part); // the stern
}
/** A shape turned around the craft's long axis from a profile of [x, radius] points, its middle `up` yards high. */
function spindle(out, profile, up, part, segments = 16) {
  for (let i = 0; i + 1 < profile.length; i++) {
    const [x0, r0] = profile[i], [x1, r1] = profile[i + 1];
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2, a1 = ((s + 1) / segments) * Math.PI * 2;
      const p = (x, r, a) => [x, r * Math.cos(a), up + r * Math.sin(a)];
      quad(out, p(x0, r0, a0), p(x1, r1, a0), p(x1, r1, a1), p(x0, r0, a1), part);
    }
  }
}
function shapes() {
  const boat = [];
  hull(boat, [[-17, 3.6], [-12, 5], [0, 5.6], [9, 4.4], [15, 2], [19, 0.1]], -1.5, 3.2, 0);
  box(boat, -15, -8, -3.4, 3.4, 3.2, 6.4, 0);       // the cabin aft
  box(boat, -0.5, 0.5, -0.5, 0.5, 3.2, 24, 1);      // the mast
  quad(boat, [0.6, -7, 9], [0.6, 7, 9], [0.6, 6, 21], [0.6, -6, 21], 1); // the sail, both faces
  quad(boat, [0.6, 7, 9], [0.6, -7, 9], [0.6, -6, 21], [0.6, 6, 21], 1);
  const zeppelin = [];
  const balloon = [];
  for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI; balloon.push([-22 * Math.cos(a), 7.5 * Math.sin(a) ** 0.8]); }
  spindle(zeppelin, balloon, 14, 0);
  hull(zeppelin, [[-9, 2.4], [-5, 3], [5, 3], [9, 1.6], [11, 0.1]], 0, 3, 1); // the car slung under it
  box(zeppelin, -0.2, 0.2, -0.2, 0.2, 3, 8, 1);
  box(zeppelin, -6.2, -5.8, -0.2, 0.2, 3, 8, 1);
  quad(zeppelin, [-24, 0, 14], [-17, 0, 14], [-18, 0, 24], [-25, 0, 22], 1); // the fin, both faces
  quad(zeppelin, [-17, 0, 14], [-24, 0, 14], [-25, 0, 22], [-18, 0, 24], 1);
  const tram = [];
  box(tram, -7, 7, -2.2, 2.2, 0.4, 4.2, 0);
  box(tram, -7.6, 7.6, -1.6, 1.6, 1, 3.4, 1);
  box(tram, -6, 6, -2.5, 2.5, 0, 0.5, 1);
  return { boat: new Float32Array(boat), zeppelin: new Float32Array(zeppelin), tram: new Float32Array(tram) };
}
export const CRAFT_LENGTH = { boat: 36, zeppelin: 46, tram: 15 };

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]; };
const COLORS = { alliance: rgb('#3f8fe0'), horde: rgb('#d0463a'), both: rgb('#e0b040'), trim: rgb('#f3ede0') };

export class TransitRenderer {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    this.meshes = {};
    for (const [kind, data] of Object.entries(shapes())) {
      const buffer = device.createBuffer({ label: `craft-${kind}`, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data);
      this.meshes[kind] = { buffer, count: data.length / STRIDE };
    }
    const layout = device.createBindGroupLayout({ label: 'craft', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    // (a craft each has its own few numbers: several are drawn in one pass)
    this.slots = [];
    for (let i = 0; i < MOST; i++) {
      const uniform = device.createBuffer({ label: 'craft-uniform', size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.slots.push({ uniform, group: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] }) });
    }
    this.data = new Float32Array(24);
    const module = device.createShaderModule({ label: 'craft', code: SHADER });
    const buffers = [{ arrayStride: STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }] }];
    this.pipeline = device.createRenderPipeline({
      label: 'craft', layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] }),
      vertex: { module, entryPoint: 'vs', buffers }, fragment: { module, entryPoint: 'fs', targets: targets(gpu) },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, multisample: { count: gpu.sampleCount }, depthStencil: depthState(gpu, true),
    });
  }

  /**
   * @param crafts  [{ line: { kind, side }, x, y, z, heading (compass degrees) }] (transit.js onMap), less the ones drawn as the game's own model
   * @param camera  Camera (pos, fov)
   */
  draw(pass, crafts, camera) {
    const gpu = this.gpu, d = this.data;
    let used = 0;
    for (const c of crafts) {
      if (used >= MOST) break;
      const kind = c.line.kind === 'tram' ? 'tram' : c.line.kind === 'zeppelin' ? 'zeppelin' : 'boat';
      const mesh = this.meshes[kind];
      const rx = c.x - camera.pos[0], ry = c.y - camera.pos[1], rz = c.z - camera.pos[2];
      const dist = Math.hypot(rx, ry, rz);
      const pxPerYard = gpu.canvas.clientHeight / (2 * Math.tan((camera.fov * DEG) / 2) * Math.max(dist, 0.01));
      const s = Math.max(1, CRAFT_MIN_PX / (CRAFT_LENGTH[kind] * pxPerYard));
      const h = (c.heading * Math.PI) / 180;
      const fx = Math.cos(h), fy = -Math.sin(h); // the bow, in world axes (+X north, +Y west)
      d.set([fx * s, fy * s, 0, 0, -fy * s, fx * s, 0, 0, 0, 0, s, 0, rx, ry, rz, 1], 0);
      d.set(COLORS[c.line.side ?? 'both'] ?? COLORS.both, 16); d[19] = 1;
      d.set(COLORS.trim, 20); d[23] = 1;
      const slot = this.slots[used++];
      gpu.device.queue.writeBuffer(slot.uniform, 0, d);
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, gpu.globalsGroup);
      pass.setBindGroup(1, slot.group);
      pass.setVertexBuffer(0, mesh.buffer);
      pass.draw(mesh.count);
    }
  }
}
