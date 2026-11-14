// NPCs and quest objects as figures standing in the world, once the camera is close: a person
// for someone, a crate for something, each on the spot (and the floor) it stands on, in the
// colour of its sign. From further away they are the signs alone, which read better from a
// height; close up a floating sign says little about where exactly someone is, and a figure on
// the floor says it at a glance. The distance is the same one that turns you from an arrow
// into a figure. Hidden behind a wall or under a roof they show through faintly, as you do.
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';

const STRIDE = 7;    // floats per vertex: position, normal, part (0 body, 1 trim)
const INSTANCE = 8;  // floats per figure: position, size, colour, (spare)
const MOVED = 1.5;   // yards the camera moves before who is near is worked out again
export const FIGURE_HEIGHT = 1.9; // yards, at size 1

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Figures { origin: vec4f };  // the markers' own origin, camera-relative
@group(1) @binding(0) var<uniform> F: Figures;
override GHOST: f32 = 0.0; // > 0: the see-through pass for the parts hidden behind something

struct VSOut { @builtin(position) clip: vec4f, @location(0) rel: vec3f, @location(1) normal: vec3f, @location(2) color: vec3f };
@vertex fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) part: f32, @location(3) at: vec4f, @location(4) tint: vec4f) -> VSOut {
  var out: VSOut;
  let rel = at.xyz + F.origin.xyz + pos * at.w;
  out.clip = G.viewProj * vec4f(rel, 1.0);
  out.rel = rel;
  out.normal = normal;
  // the trim (a head, a lid) is the same colour, lighter
  out.color = mix(tint.rgb, mix(tint.rgb, vec3f(1.0), 0.6), step(0.5, part));
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  if (GHOST > 0.0) { return vec4f(in.color, GHOST); }
  let n = normalize(in.normal);
  // Lit like the rest of the world, but never darker than half: they have to show in a cellar too.
  let lit = in.color * max(lambert(n), vec3f(0.5));
  let rim = pow(1.0 - abs(dot(n, normalize(-in.rel))), 3.0) * 0.3;
  return vec4f(lit + vec3f(rim), 1.0);
}
`;

/** Triangles of a shape turned around the vertical axis from a profile of [radius, height] points. */
function lathe(out, profile, part, segments) {
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    const dr = r1 - r0, dz = z1 - z0, len = Math.hypot(dr, dz) || 1;
    const nr = dz / len, nz = -dr / len;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2, a1 = ((s + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const v = (r, z, c, sn) => [r * c, r * sn, z, nr * c, nr * sn, nz, part];
      const p00 = v(r0, z0, c0, s0), p01 = v(r0, z0, c1, s1), p10 = v(r1, z1, c0, s0), p11 = v(r1, z1, c1, s1);
      out.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
    }
  }
}

/** A box from (-hx, -hy, z0) to (hx, hy, z1), each face with its own normal. */
function box(out, hx, hy, z0, z1, part) {
  const quad = (a, b, c, d, n) => { for (const p of [a, b, c, a, c, d]) out.push(...p, ...n, part); };
  const P = (sx, sy, z) => [sx * hx, sy * hy, z];
  quad(P(-1, -1, z1), P(1, -1, z1), P(1, 1, z1), P(-1, 1, z1), [0, 0, 1]);
  quad(P(-1, -1, z0), P(-1, 1, z0), P(1, 1, z0), P(1, -1, z0), [0, 0, -1]);
  quad(P(1, -1, z0), P(1, 1, z0), P(1, 1, z1), P(1, -1, z1), [1, 0, 0]);
  quad(P(-1, 1, z0), P(-1, -1, z0), P(-1, -1, z1), P(-1, 1, z1), [-1, 0, 0]);
  quad(P(1, 1, z0), P(-1, 1, z0), P(-1, 1, z1), P(1, 1, z1), [0, 1, 0]);
  quad(P(-1, -1, z0), P(1, -1, z0), P(1, -1, z1), P(-1, -1, z1), [0, -1, 0]);
}

/** Someone: the same tapering body and round head as your own figure (no ring, no arrow: they are not you). */
function personMesh() {
  const v = [];
  lathe(v, [[0, 0], [0.4, 0], [0.42, 0.12], [0.33, 0.5], [0.22, 1.0], [0.18, 1.3], [0, 1.36]], 0, 14);
  const head = [];
  for (let i = 0; i <= 7; i++) { const a = -Math.PI / 2 + (i / 7) * Math.PI; head.push([0.26 * Math.cos(a), 1.62 + 0.26 * Math.sin(a)]); }
  lathe(v, head, 1, 14);
  return new Float32Array(v);
}

/** Something: a crate with a lighter lid. */
function crateMesh() {
  const v = [];
  box(v, 0.36, 0.36, 0, 0.5, 0);
  box(v, 0.4, 0.4, 0.5, 0.6, 1);
  return new Float32Array(v);
}

export class NpcFigures {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    const upload = (mesh, label) => { const b = device.createBuffer({ label, size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, mesh); return { buffer: b, count: mesh.length / STRIDE }; };
    this.person = upload(personMesh(), 'npc-person');
    this.crate = upload(crateMesh(), 'npc-crate');
    this.uniform = device.createBuffer({ label: 'npc-figures', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(4);
    const layout = device.createBindGroupLayout({ label: 'npc-figures', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    const module = device.createShaderModule({ label: 'npc-figures', code: SHADER });
    const buffers = [
      { arrayStride: STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }] },
      { arrayStride: INSTANCE * 4, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }, { shaderLocation: 4, offset: 16, format: 'float32x4' }] },
    ];
    const common = { layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] }), vertex: { module, entryPoint: 'vs', buffers }, primitive: { topology: 'triangle-list', cullMode: 'none' }, multisample: { count: gpu.sampleCount } };
    this.solid = device.createRenderPipeline({ label: 'npc-figures', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu) }, depthStencil: depthState(gpu, true) });
    // the parts behind something (depth is reversed: "less" = farther than what is already drawn)
    this.ghost = device.createRenderPipeline({ label: 'npc-figures-ghost', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu, ALPHA_BLEND), constants: { GHOST: 0.26 } }, depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'less' } });
    this.instances = null;
    this.people = 0;   // figures being drawn: people...
    this.things = 0;   // ...and crates
    this.rev = -1;
    this.reach = -1;
    this.at = [Infinity, 0, 0];
  }

  /**
   * @param layer  NpcLayer   @param reach  yards from the camera within which markers are figures (0 = none)
   */
  draw(pass, layer, camera, reach) {
    if (!reach || !layer.count) { this.people = 0; this.things = 0; this.rev = -1; return; }
    const c = camera.pos;
    if (layer.rev !== this.rev || reach !== this.reach || Math.hypot(c[0] - this.at[0], c[1] - this.at[1], c[2] - this.at[2]) > MOVED) {
      // who is near enough: asked for a little further than they are drawn, so nobody pops in late as the camera moves
      this.rev = layer.rev; this.reach = reach; this.at = [c[0], c[1], c[2]];
      const near = layer.near(c, reach + MOVED);
      this.people = near.people; this.things = near.things;
      if (near.data.length) {
        if (!this.instances || this.instances.size < near.data.byteLength) {
          this.instances?.destroy();
          this.instances = this.gpu.device.createBuffer({ label: 'npc-figure-instances', size: Math.max(near.data.byteLength, 1 << 14), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.gpu.device.queue.writeBuffer(this.instances, 0, near.data);
      }
    }
    if (!this.people && !this.things) return;
    const gpu = this.gpu, d = this.data;
    d[0] = layer.origin[0] - c[0]; d[1] = layer.origin[1] - c[1]; d[2] = layer.origin[2] - c[2];
    gpu.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setBindGroup(0, gpu.globalsGroup);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(1, this.instances);
    for (const pipeline of [this.ghost, this.solid]) {
      pass.setPipeline(pipeline);
      if (this.people) { pass.setVertexBuffer(0, this.person.buffer); pass.draw(this.person.count, this.people, 0, 0); }
      if (this.things) { pass.setVertexBuffer(0, this.crate.buffer); pass.draw(this.crate.count, this.things, 0, this.people); }
    }
  }
}
