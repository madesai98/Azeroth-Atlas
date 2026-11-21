// The big quest marks: a gold "!" over whoever gives a quest open to you, a gold "?" over whoever
// takes one of yours that is finished (grey while it is not), crossed swords over what a quest of
// yours has you kill, use or collect, and a blue gem over a quest object. Each is a solid, shaded
// model with a dark outline, floating over its NPC's head, so that it stands out at a glance
// from close by and from far off - over snow and sand as over grass. They are drawn instead of
// those flat signs (npcs.js: MARKS says which); "Big 3D quest marks" in the NPC panel turns them
// back into the signs.
//
// - However far off, a mark keeps at least MARK_MIN pixels on the screen, as the signs do, and it
//   grows to MARK_MAX close by (less in a small picture: markFit). Its foot is where the sign
//   was: over the head of the figure standing in the world, or a little over the spot from
//   further away.
// - Of the many there can be (a hundred kobolds), the nearest MOST are drawn.
// - It faces the camera, turned a little about its upright so that its depth shows: read from
//   above too, where a mark standing up would be seen end on. And it is not animated: the map
//   draws a picture only when something has changed, and a mark that turned by itself would have
//   it drawing all the time beside the game.
// - Hidden behind a wall or under a roof it shows through, fainter, as the signs did.
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';
import { MARKS, MARK_K, MARK_MIN, MARK_MAX, SIGN_FAR, TALL } from './npcs.js';

const VERT = 10;       // floats per vertex: position, normal, the way the outline grows, part (0 the mark's colour, 1 steel)
const INST = 12;       // floats per mark: where (x, y, z) and the size of its NPC; colour and scale; shown at any distance
const MOST = 300;      // marks drawn at most: the nearest
const OUTLINE = 3;     // pixels of dark outline round a mark
const TURN = 0.38;     // radians a mark is turned about its upright from facing you square on
const DEG = Math.PI / 180;

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Marks {
  origin: vec4f,  // xyz: the markers' own origin, camera-relative; w: yards one CSS pixel spans one yard from the camera
  size: vec4f,    // x: pixels tall at one yard (pixels = x / distance), y: least, z: most, w: pixels of outline
  near: vec4f,    // x: closer than this a marker is a figure standing in the world; y: a figure's height; z: how high a sign floats over the spot otherwise; w: how far marks show
  turn: vec4f,    // x, y: cosine and sine of the turn about the upright
};
@group(1) @binding(0) var<uniform> M: Marks;
override OUTLINE: f32 = 0.0; // > 0: the outline, grown out of the mark and seen from behind
override GHOST: f32 = 0.0;   // > 0: the see-through pass for the parts hidden behind something

const STEEL = vec3f(0.74, 0.79, 0.86);
const INK = vec3f(0.012, 0.009, 0.006);

struct VSOut { @builtin(position) clip: vec4f, @location(0) rel: vec3f, @location(1) normal: vec3f, @location(2) color: vec3f };
@vertex fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) grow: vec3f, @location(3) part: f32,
              @location(4) at: vec4f, @location(5) tint: vec4f, @location(6) more: vec4f) -> VSOut {
  var out: VSOut;
  let feet = at.xyz + M.origin.xyz;
  let figure = length(feet) < M.near.x;
  // its foot: over the figure's head, or where the sign floats over the spot
  let base = feet + vec3f(0.0, 0.0, select(M.near.z, M.near.y * at.w + 0.45, figure));
  let dist = max(length(base), 0.5);
  let limit = select(M.near.w, 1.0e9, more.x > 0.5);
  let fade = clamp((limit - dist) / (limit * 0.12), 0.0, 1.0);
  let foot = G.viewProj * vec4f(base, 1.0);
  if (fade <= 0.0 || foot.w < 0.3) { out.clip = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  // pixels tall: big close by, never smaller than MARK_MIN; and shrinking away at the edge of the range
  let px = clamp(M.size.x / dist, M.size.y, M.size.z) * tint.w * fade;
  let tall = px * dist * M.origin.w;
  var p = pos;
  if (OUTLINE > 0.0) { p = p + grow * (M.size.w / max(px, 1.0)); }
  let q = vec3f(p.x * M.turn.x - p.y * M.turn.y, p.x * M.turn.y + p.y * M.turn.x, p.z);
  let m = vec3f(normal.x * M.turn.x - normal.y * M.turn.y, normal.x * M.turn.y + normal.y * M.turn.x, normal.z);
  // across: the screen's right; up: the screen's up; depth: away from you
  let rel = base + (G.camRight * q.x + G.camFwd * q.y + G.camUp * q.z) * tall;
  out.clip = G.viewProj * vec4f(rel, 1.0);
  out.rel = rel;
  out.normal = G.camRight * m.x + G.camFwd * m.y + G.camUp * m.z;
  // (steel: a blade - with a touch of the mark's colour, so that a sword says whose it is)
  out.color = select(tint.rgb, mix(STEEL, tint.rgb, 0.28), part > 0.5);
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let a = select(1.0, GHOST, GHOST > 0.0);
  if (OUTLINE > 0.0) { return vec4f(INK, a); }
  let n = normalize(in.normal);
  let v = normalize(-in.rel);
  // Lit from the upper left, in front, the same however the sun stands (a mark is not of the
  // world), and brighter toward its top: bright enough to stand out of a sunlit forest.
  let l = normalize(G.camUp * 0.75 - G.camRight * 0.45 - G.camFwd * 0.5);
  let shade = 0.5 + 0.55 * max(dot(n, l), 0.0) + 0.15 * dot(n, G.camUp);
  var c = in.color * shade;
  c = c + vec3f(1.0, 0.97, 0.9) * pow(max(dot(n, normalize(l + v)), 0.0), 40.0) * 0.6;
  c = c + in.color * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.25;
  return vec4f(min(c, vec3f(1.0)), a);
}
`;

// ---- the models: x across, y depth (away from you), z up; a full height of 1, the foot at 0 ----

/**
 * A surface turned about an upright from a profile of [radius, height], bottom to top, standing
 * at (cx, cy). Its normals: [across, up] for each point of the profile, or worked out from it.
 */
function revolve(out, profile, { part = 0, seg = 14, cx = 0, cy = 0, normals = null } = {}) {
  // (smooth: each point's normal from the direction of the profile there)
  const nrm = normals ?? profile.map((p, i) => {
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 1)];
    const dr = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dr, dz) || 1;
    return [dz / len, -dr / len];
  });
  const v = (k, ang) => {
    const [r, z] = profile[k], [nr, nz] = nrm[k], c = Math.cos(ang), s = Math.sin(ang), nx = nr * c, ny = nr * s;
    return [cx + r * c, cy + r * s, z, nx, ny, nz, nx, ny, nz, part];
  };
  for (let i = 0; i + 1 < profile.length; i++) {
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const p00 = v(i, a0), p01 = v(i, a1), p10 = v(i + 1, a0), p11 = v(i + 1, a1);
      out.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
    }
  }
}

/** A ball - or only its lower half (bottom: the round end of an upright tube, which meets it at its middle). */
function sphere(out, cx, cy, cz, r, { part = 0, rings = 7, seg = 12, bottom = false } = {}) {
  const profile = [], normals = [];
  for (let k = 0; k <= rings; k++) {
    const a = -Math.PI / 2 + (k / rings) * (bottom ? Math.PI / 2 : Math.PI);
    profile.push([r * Math.cos(a), cz + r * Math.sin(a)]);
    normals.push([Math.cos(a), Math.sin(a)]); // (a ball's own: straight out from its middle)
  }
  revolve(out, profile, { part, seg, cx, cy, normals });
}

/**
 * A tube along a path in the plane of the mark ([x, z] points), at depth cy. Its cross-section
 * is an ellipse: wide(t) across in the plane, deep(t) in depth, t from 0 at the first point to 1
 * at the last.
 */
function sweep(out, path, wide, deep, { part = 0, seg = 12, cy = 0 } = {}) {
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = along[along.length - 1] || 1;
  const rings = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const t = along[i] / total, rx = Math.max(wide(t), 1e-4), ry = Math.max(deep(t), 1e-4);
    const ring = [];
    for (let s = 0; s <= seg; s++) {
      const ang = (s / seg) * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
      // (across in the plane is (tz, -tx); the normal of an ellipse: cos/rx across, sin/ry in depth)
      let nx = (tz * c) / rx, ny = sn / ry, nz = (-tx * c) / rx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      ring.push([p[0] + tz * c * rx, cy + sn * ry, p[1] - tx * c * rx, nx, ny, nz]);
    }
    return ring;
  });
  const v = (k, j) => { const q = rings[k][j]; return [q[0], q[1], q[2], q[3], q[4], q[5], q[3], q[4], q[5], part]; };
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let s = 0; s < seg; s++) {
      const p00 = v(i, s), p01 = v(i, s + 1), p10 = v(i + 1, s), p11 = v(i + 1, s + 1);
      out.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
    }
  }
}

/** "!": a bar wider at the top, round at both ends, over a dot. */
export function bangModel() {
  const v = [], rb = 0.085, zb = 0.385, rt = 0.155, zt = 0.84, profile = [];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2); profile.push([rb * Math.cos(a), zb + rb * Math.sin(a)]); }
  for (let i = 1; i <= 3; i++) { const t = i / 4; profile.push([rb + (rt - rb) * t, zb + (zt - zb) * t]); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); profile.push([rt * Math.cos(a), zt + rt * Math.sin(a)]); }
  revolve(v, profile);
  sphere(v, 0, 0, 0.115, 0.105);
  return new Float32Array(v);
}

/** "?": a hook ending in a ball, coming down into a short stem, over a dot. */
export function hookModel() {
  const v = [], R = 0.21, cz = 0.7, r = 0.088, path = [];
  for (let a = 155; a >= -55; a -= 10) path.push([R * Math.cos(a * DEG), cz + R * Math.sin(a * DEG)]);
  path.push([0.075, 0.485], [0.03, 0.455], [0.006, 0.425], [0, 0.39], [0, 0.375]);
  sweep(v, path, () => r, () => r);
  sphere(v, path[0][0], 0, path[0][1], 0.105, { rings: 6, seg: 10 });
  sphere(v, 0, 0, 0.375, r, { rings: 4, seg: 12, bottom: true }); // (the stem's round foot: the half below the tube's end)
  sphere(v, 0, 0, 0.115, 0.105, { rings: 6, seg: 10 });
  return new Float32Array(v);
}

/** Crossed swords: steel blades, their hilts in the mark's colour. */
export function swordsModel() {
  const v = [], L = 1.3, s45 = Math.SQRT1_2;
  for (const side of [1, -1]) {
    const d = [side * s45, s45], n = [-d[1], d[0]];
    const x0 = -side * 0.46, z0 = 0.065, cy = side * 0.03; // (the pommel; the two a little apart in depth, where they cross)
    const at = (u, off = 0) => [x0 + d[0] * u * L + n[0] * off, z0 + d[1] * u * L + n[1] * off];
    sphere(v, x0, cy, z0, 0.066, { rings: 6, seg: 10 });
    sweep(v, [at(0.03), at(0.18)], () => 0.042, () => 0.042, { cy, seg: 8 });
    sweep(v, [at(0.195, -0.15), at(0.195, 0.15)], () => 0.046, () => 0.046, { cy, seg: 8 });
    for (const off of [-0.15, 0.15]) { const g = at(0.195, off); sphere(v, g[0], cy, g[1], 0.056, { rings: 5, seg: 8 }); }
    const blade = [];
    for (let i = 0; i <= 10; i++) blade.push(at(0.21 + (0.79 * i) / 10));
    sweep(v, blade, (t) => (t < 0.82 ? 0.064 - 0.012 * (t / 0.82) : 0.052 * (1 - (t - 0.82) / 0.18) + 0.003), () => 0.02, { part: 1, cy, seg: 10 });
  }
  return new Float32Array(v);
}

/** A gem: two six-sided pyramids, base to base, cut flat. */
export function gemModel() {
  const v = [], sides = 6, ring = 0.36, mid = 0.56, mz = 0.5;
  const P = (k) => { const a = ((k % sides) / sides) * Math.PI * 2 + Math.PI / sides; return [Math.cos(a) * ring, Math.sin(a) * ring, mid]; };
  const tri = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], nl = Math.hypot(...n) || 1;
    // (the outline grows away from the middle: the faces' own normals would leave gaps at the edges)
    for (const p of [a, b, c]) { const g = [p[0], p[1], p[2] - mz], gl = Math.hypot(...g) || 1; v.push(p[0], p[1], p[2], n[0] / nl, n[1] / nl, n[2] / nl, g[0] / gl, g[1] / gl, g[2] / gl, 0); }
  };
  for (let k = 0; k < sides; k++) { const a = P(k), b = P(k + 1); tri(a, b, [0, 0, 1]); tri(b, a, [0, 0, 0]); }
  return new Float32Array(v);
}

export const MODELS = { bang: bangModel, hook: hookModel, swords: swordsModel, gem: gemModel };
const ORDER = Object.keys(MODELS);

const linear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [linear((n >> 16) & 255), linear((n >> 8) & 255), linear(n & 255)]; };
const COLOR = Object.fromEntries(Object.entries(MARKS).map(([icon, m]) => [icon, rgb(m.color)]));

/** Yards one CSS pixel spans one yard from the camera. */
export const yardsPerPixel = (camera, gpu) => (2 * Math.tan((camera.fov * DEG) / 2) * (gpu.pixelRatio || 1)) / Math.max(1, gpu.height);
/**
 * How big the marks are against their full size, for a picture so many CSS pixels tall: full
 * size from FULL_AT up, smaller in a smaller one (down to FIT_LEAST: the map as a minimap over
 * the game, a few hundred pixels tall, where marks of the full size would crowd it).
 */
const FULL_AT = 900, FIT_LEAST = 0.55;
export const markFit = (cssHeight) => Math.min(1, Math.max(FIT_LEAST, cssHeight / FULL_AT));

export class QuestMarks {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    this.models = {};
    for (const key of ORDER) {
      const mesh = MODELS[key]();
      const buffer = device.createBuffer({ label: `quest-mark-${key}`, size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, mesh);
      this.models[key] = { buffer, count: mesh.length / VERT, first: 0, n: 0 };
    }
    this.uniform = device.createBuffer({ label: 'quest-marks', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(16);
    const layout = device.createBindGroupLayout({ label: 'quest-marks', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    const module = device.createShaderModule({ label: 'quest-marks', code: SHADER });
    const buffers = [
      { arrayStride: VERT * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x3' }, { shaderLocation: 3, offset: 36, format: 'float32' }] },
      { arrayStride: INST * 4, stepMode: 'instance', attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }, { shaderLocation: 5, offset: 16, format: 'float32x4' }, { shaderLocation: 6, offset: 32, format: 'float32x4' }] },
    ];
    const pipeline = (label, { outline, ghost }) => device.createRenderPipeline({
      label, layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] }),
      vertex: { module, entryPoint: 'vs', buffers, constants: { OUTLINE: outline ? 1 : 0 } },
      // (the outline is the mark grown a little, seen from behind: only where it sticks out round the mark does it show)
      primitive: { topology: 'triangle-list', cullMode: outline ? 'front' : 'back' },
      multisample: { count: gpu.sampleCount },
      fragment: { module, entryPoint: 'fs', targets: ghost ? targets(gpu, ALPHA_BLEND) : targets(gpu), constants: { OUTLINE: outline ? 1 : 0, GHOST: ghost ? 0.6 : 0 } },
      // (the parts behind something: depth is reversed, "less" = farther than what is already drawn)
      depthStencil: ghost ? { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'less' } : depthState(gpu, true),
    });
    this.passes = [
      pipeline('quest-marks-outline-ghost', { outline: true, ghost: true }), pipeline('quest-marks-ghost', { outline: false, ghost: true }),
      pipeline('quest-marks-outline', { outline: true, ghost: false }), pipeline('quest-marks', { outline: false, ghost: false }),
    ];
    this.instances = null;
    this.count = 0;
    this.key = '';
    this.at = [Infinity, 0, 0];
  }

  /**
   * Which marks to draw: the markers of the layer that are marks (MARKS), within the range or
   * shown at any distance, the nearest MOST of them - grouped by model.
   */
  #choose(layer, camera) {
    const inst = layer.inst, S = layer.stride, o = layer.origin, c = camera.pos, range = layer.settings.range;
    const list = [];
    for (let k = 0; k < layer.count; k++) {
      const q = k * S, icon = inst[q + 3];
      if (!MARKS[icon]) continue;
      const d = Math.hypot(inst[q] + o[0] - c[0], inst[q + 1] + o[1] - c[1], inst[q + 2] + o[2] - c[2]);
      if (!inst[q + 4] && d > range * 1.1) continue;
      list.push([d, k]);
    }
    if (list.length > MOST) list.sort((a, b) => a[0] - b[0]).length = MOST;
    const data = new Float32Array(Math.max(1, list.length) * INST);
    let w = 0;
    for (const key of ORDER) {
      const model = this.models[key];
      model.first = w / INST; model.n = 0;
      for (const [, k] of list) {
        const q = k * S, icon = inst[q + 3], mark = MARKS[icon];
        if (mark.model !== key) continue;
        const color = COLOR[icon];
        data.set([inst[q], inst[q + 1], inst[q + 2], inst[q + 5], color[0], color[1], color[2], mark.scale, inst[q + 4], 0, 0, 0], w);
        w += INST; model.n++;
      }
    }
    this.count = w / INST;
    if (!this.count) return;
    if (!this.instances || this.instances.size < data.byteLength) {
      this.instances?.destroy();
      this.instances = this.gpu.device.createBuffer({ label: 'quest-mark-instances', size: Math.max(data.byteLength, 1 << 14), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.gpu.device.queue.writeBuffer(this.instances, 0, data);
  }

  /** @param layer NpcLayer */
  draw(pass, layer, camera) {
    const on = !!layer.settings.marks && layer.count > 0;
    const perPx = yardsPerPixel(camera, this.gpu), fit = markFit(this.gpu.height / (this.gpu.pixelRatio || 1));
    // (for what is under the cursor, and the names over the marks: npcs.js)
    layer.markView = on ? { perPx, up: camera.basis().u, fit } : null;
    if (!on) { this.count = 0; this.key = ''; return; }
    const c = camera.pos, range = layer.settings.range;
    const key = `${layer.rev}|${range}`;
    if (key !== this.key || Math.hypot(c[0] - this.at[0], c[1] - this.at[1], c[2] - this.at[2]) > Math.min(30, range * 0.05)) {
      this.key = key; this.at = [c[0], c[1], c[2]];
      this.#choose(layer, camera);
    }
    if (!this.count) return;
    const gpu = this.gpu, d = this.data;
    d[0] = layer.origin[0] - c[0]; d[1] = layer.origin[1] - c[1]; d[2] = layer.origin[2] - c[2]; d[3] = perPx;
    d[4] = MARK_K * fit; d[5] = MARK_MIN * fit; d[6] = MARK_MAX * fit; d[7] = OUTLINE;
    d[8] = layer.figureDist; d[9] = TALL; d[10] = SIGN_FAR; d[11] = range;
    d[12] = Math.cos(TURN); d[13] = Math.sin(TURN);
    gpu.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setBindGroup(0, gpu.globalsGroup);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(1, this.instances);
    for (const pipeline of this.passes) {
      pass.setPipeline(pipeline);
      for (const key of ORDER) {
        const m = this.models[key];
        if (!m.n) continue;
        pass.setVertexBuffer(0, m.buffer);
        pass.draw(m.count, m.n, 0, m.first);
      }
    }
  }
}
