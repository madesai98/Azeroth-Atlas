// Your character as a 3D figure standing in the world, shown instead of the flat arrow once
// the camera is close: a person-sized figure exactly where you are, with an arrow on the ground
// for the way you face. Where something is in front of it (a wall, a floor above) it shows
// through as a faint silhouette, so it is never lost.
//
// On a flight path the figure does not stand: it sits on what is flying it (mount.js: a gryphon,
// a wind rider), which heads the way the flight goes, noses up and down with it, leans into its
// turns and beats its wings.
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';
import { DEG } from './math.js';
import { mountBody, mountWings, mountBob, mountColors, mountOf, WING_VERTICES, SPAN } from './mount.js';

const HEIGHT = 1.9;  // yards, about a character's height
const MIN_PX = 30;   // never drawn smaller than this on screen (CSS pixels), so it stays easy to find
const STRIDE = 7;    // floats per vertex: position, normal, part (which colour: 0 body, 1 trim, 2 and up the colours of what you ride)
const MOUNT_MIN_PX = 76; // what flies you is never drawn narrower than this, wing tip to wing tip
const COLOURS = 8;   // colours a shape can be made of

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Figure {
  model: mat4x4f,   // figure space -> camera-relative world space
  colors: array<vec4f, ${COLOURS}>, // by part: the body, its trim, then the colours of what you ride
};
@group(1) @binding(0) var<uniform> F: Figure;
override GHOST: f32 = 0.0; // > 0: the see-through pass for the parts hidden behind something

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
  let base = F.colors[u32(in.part + 0.5)].rgb;
  if (GHOST > 0.0) { return vec4f(base, GHOST); }
  let n = normalize(in.normal);
  // Lit like the rest of the world, but never darker than half: it has to stand out in a cellar too.
  let lit = base * max(lambert(n), vec3f(0.55));
  // A light edge so the shape reads against any background.
  let rim = pow(1.0 - abs(dot(n, normalize(-in.rel))), 3.0) * 0.35;
  return vec4f(lit + vec3f(rim), 1.0);
}
`;

/** Triangles of a shape turned around the vertical axis from a profile of [radius, height] points. */
function lathe(out, profile, part, segments = 24, lift = 0) {
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    // outward normal of this band of the profile
    const dr = r1 - r0, dz = z1 - z0, len = Math.hypot(dr, dz) || 1;
    const nr = dz / len, nz = -dr / len;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2, a1 = ((s + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const v = (r, z, c, sn) => [r * c, r * sn, z + lift, nr * c, nr * sn, nz, part];
      const p00 = v(r0, z0, c0, s0), p01 = v(r0, z0, c1, s1), p10 = v(r1, z1, c0, s0), p11 = v(r1, z1, c1, s1);
      out.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
    }
  }
}

/** The figure itself, its feet `lift` yards up: a body and a head. */
function person(v, lift = 0) {
  // body: a tapering pawn shape, 1.36 yd tall
  lathe(v, [[0, 0], [0.44, 0], [0.46, 0.12], [0.36, 0.5], [0.24, 1.0], [0.19, 1.3], [0, 1.36]], 0, 24, lift);
  // head: a ball on top
  const head = [];
  for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i / 10) * Math.PI; head.push([0.27 * Math.cos(a), 1.62 + 0.27 * Math.sin(a)]); }
  lathe(v, head, 1, 24, lift);
}

function buildMesh() {
  const v = [];
  person(v);
  // a ring on the ground around the feet: the exact spot
  for (let s = 0; s < 32; s++) {
    const a0 = (s / 32) * Math.PI * 2, a1 = ((s + 1) / 32) * Math.PI * 2;
    const p = (r, a) => [r * Math.cos(a), r * Math.sin(a), 0.05, 0, 0, 1, 1];
    v.push(...p(0.62, a0), ...p(0.74, a0), ...p(0.74, a1), ...p(0.62, a0), ...p(0.74, a1), ...p(0.62, a1));
  }
  // an arrow head on the ground in front (figure space: +X is forward, +Y is left)
  const t = (x, y) => [x, y, 0.06, 0, 0, 1, 1];
  v.push(...t(1.55, 0), ...t(0.92, 0.42), ...t(1.08, 0), ...t(1.55, 0), ...t(1.08, 0), ...t(0.92, -0.42));
  return new Float32Array(v);
}

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]; };
const COLORS = { live: rgb('#35c8ff'), dead: rgb('#aab2bf'), stale: rgb('#7d8694'), trim: rgb('#ffffff') };
const UNIFORM = 16 + COLOURS * 4; // floats: the matrix, then the colours

export class FigureRenderer {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    const mesh = buildMesh();
    this.count = mesh.length / STRIDE;
    this.vertices = device.createBuffer({ label: 'figure', size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertices, 0, mesh);
    this.uniform = device.createBuffer({ label: 'figure-uniform', size: UNIFORM * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(UNIFORM);
    // what flies you: made the first time it is needed, one for each kind of creature; and its two
    // wings, laid out anew for every frame
    this.mounts = new Map();
    this.wings = device.createBuffer({ label: 'figure-wings', size: WING_VERTICES * STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.wingData = new Float32Array(WING_VERTICES * STRIDE);
    const layout = device.createBindGroupLayout({ label: 'figure', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    const module = device.createShaderModule({ label: 'figure', code: SHADER });
    const buffers = [{ arrayStride: STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }] }];
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] });
    const common = { layout: pipelineLayout, vertex: { module, entryPoint: 'vs', buffers }, primitive: { topology: 'triangle-list', cullMode: 'none' }, multisample: { count: gpu.sampleCount } };
    this.solid = device.createRenderPipeline({ label: 'figure', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu) }, depthStencil: depthState(gpu, true) });
    // The parts behind something (depth is reversed: "less" = farther than what is already drawn).
    this.ghost = device.createRenderPipeline({
      label: 'figure-ghost', ...common,
      fragment: { module, entryPoint: 'fs', targets: targets(gpu, ALPHA_BLEND), constants: { GHOST: 0.32 } },
      depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
  }

  /** The body of one kind of creature, with your figure on it (made once): { vertices, count, colors }. */
  #mount(kind) {
    let m = this.mounts.get(kind);
    if (!m) {
      const mesh = mountBody(kind, person);
      const vertices = this.gpu.device.createBuffer({ label: `figure-${kind}`, size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.gpu.device.queue.writeBuffer(vertices, 0, mesh);
      this.mounts.set(kind, (m = { vertices, count: mesh.length / STRIDE, colors: mountColors(kind).map(rgb) }));
    }
    return m;
  }

  /**
   * @param marker  { x, y, z, heading (compass degrees or null), dead, stale,
   *                  flight: on a flight path { heading, pitch, bank (degrees), faction } }
   * @param camera  Camera (pos, fov)
   * @param seconds the time, for the beating of the wings
   */
  draw(pass, marker, camera, seconds = 0) {
    const gpu = this.gpu, d = this.data, fl = marker.flight ?? null;
    const rx = marker.x - camera.pos[0], ry = marker.y - camera.pos[1], rz = marker.z - camera.pos[2];
    // Real size up close; from further away, enlarged just enough to stay easy to see.
    const dist = Math.hypot(rx, ry, rz);
    const pxPerYard = gpu.canvas.clientHeight / (2 * Math.tan((camera.fov * DEG) / 2) * Math.max(dist, 0.01));
    const s = fl ? Math.max(1, MOUNT_MIN_PX / (SPAN * pxPerYard)) : Math.max(1, MIN_PX / (HEIGHT * pxPerYard));
    const h = ((fl ? fl.heading : marker.heading ?? 0) * Math.PI) / 180;
    const fx = Math.cos(h), fy = -Math.sin(h); // forward in world axes (+X north, +Y west)
    d.fill(0, 16);
    d.set(marker.stale ? COLORS.stale : marker.dead ? COLORS.dead : COLORS.live, 16); d[19] = 1;
    d.set(COLORS.trim, 20); d[23] = 1;
    let body = this.vertices, count = this.count, wings = 0;
    if (!fl) d.set([fx * s, fy * s, 0, 0, -fy * s, fx * s, 0, 0, 0, 0, s, 0, rx, ry, rz, 1], 0);
    else {
      // Nose up or down by the pitch, then rolled about its own length by the bank (a bank to
      // the right lifts the left wing): forward, left and up, as the creature has them.
      const p = fl.pitch * DEG, b = fl.bank * DEG, cp = Math.cos(p), sp = Math.sin(p), cb = Math.cos(b), sb = Math.sin(b);
      const F = [fx * cp, fy * cp, sp], U = [-fx * sp, -fy * sp, cp], L0 = [-fy, fx, 0];
      const L = [L0[0] * cb + U[0] * sb, L0[1] * cb + U[1] * sb, L0[2] * cb + U[2] * sb];
      const T = [U[0] * cb - L0[0] * sb, U[1] * cb - L0[1] * sb, U[2] * cb - L0[2] * sb];
      // (the signal lost: it hangs where it was last seen, wings still, greyed like the figure)
      const t = marker.stale ? 0 : seconds, bob = marker.stale ? 0 : mountBob(t) * s;
      d.set([F[0] * s, F[1] * s, F[2] * s, 0, L[0] * s, L[1] * s, L[2] * s, 0, T[0] * s, T[1] * s, T[2] * s, 0, rx + T[0] * bob, ry + T[1] * bob, rz + T[2] * bob, 1], 0);
      const kind = mountOf(fl.faction), m = this.#mount(kind);
      m.colors.forEach((c, i) => {
        // (greyed: each colour most of the way toward the grey of a lost signal)
        const o = 24 + i * 4;
        for (let k = 0; k < 3; k++) d[o + k] = marker.stale ? c[k] * 0.3 + COLORS.stale[k] * 0.7 : c[k];
        d[o + 3] = 1;
      });
      body = m.vertices; count = m.count;
      wings = mountWings(kind, t, this.wingData);
      gpu.device.queue.writeBuffer(this.wings, 0, this.wingData, 0, wings * STRIDE);
    }
    gpu.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setBindGroup(0, gpu.globalsGroup);
    pass.setBindGroup(1, this.group);
    for (const pipeline of [this.ghost, this.solid]) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, body);
      pass.draw(count);
      if (wings) { pass.setVertexBuffer(0, this.wings); pass.draw(wings); }
    }
  }
}
