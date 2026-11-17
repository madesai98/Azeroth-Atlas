// Buildings (WMO) and objects (M2): streamed on demand and drawn with GPU instancing.
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';
import { unpackContainer, sectionView, textureFromBLP } from './formats.js';
import { placementMatrix, quatMatrix, affineMul, boxVisible, sphereVisible, TILE } from './math.js';

const NONE = 0, LOADING = 1, READY = 2, FAILED = 3;
const MAX_MODEL_LOADS = 6, MAX_TEX_LOADS = 8;
const STRIDE = 36;

const MODEL_WGSL = GLOBALS_WGSL + /* wgsl */ `
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var texSampler: sampler;
override ALPHA_REF: f32 = -1.0;
override TREE: f32 = 0.0; // 1: this is drawn for the trees (the cutaway takes their tops in a circle around you)

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) rel: vec3f,
  @location(2) normal: vec3f,
  @location(3) color: vec4f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) color: vec4f,
              @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f) -> VOut {
  var o: VOut;
  o.rel = vec3f(dot(m0.xyz, p) + m0.w, dot(m1.xyz, p) + m1.w, dot(m2.xyz, p) + m2.w);
  o.normal = vec3f(dot(m0.xyz, n), dot(m1.xyz, n), dot(m2.xyz, n));
  o.pos = G.viewProj * vec4f(o.rel, 1.0);
  o.uv = uv;
  o.color = color;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, texSampler, in.uv);
  if (t.a < ALPHA_REF) { discard; }
  if (cutAway(in.rel, TREE > 0.5)) { discard; }
  let n = normalize(in.normal);
  var light = lambert(n);
  // Interiors ship with baked vertex lighting (flagged by alpha 0).
  if (in.color.a < 0.5) { light = max(in.color.rgb * 2.2, vec3f(0.22)); }
  return vec4f(applyFog(t.rgb * light, in.rel), t.a);
}
`;

const LIQUID_WGSL = GLOBALS_WGSL + /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) rel: vec3f, @location(1) @interpolate(flat) kind: u32 };
@vertex fn vs(@location(0) a: vec4f, @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f) -> VOut {
  var o: VOut;
  o.rel = vec3f(dot(m0.xyz, a.xyz) + m0.w, dot(m1.xyz, a.xyz) + m1.w, dot(m2.xyz, a.xyz) + m2.w);
  o.pos = G.viewProj * vec4f(o.rel, 1.0);
  o.kind = u32(a.w);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (cutAway(in.rel, false)) { discard; }
  if (in.kind == 3u) { return vec4f(applyFog(vec3f(1.5, 0.38, 0.04), in.rel), 1.0); }
  var color = vec3f(0.05, 0.22, 0.32);
  if (in.kind == 4u) { color = vec3f(0.16, 0.34, 0.05); }
  let view = normalize(-in.rel);
  let fres = pow(1.0 - clamp(view.z, 0.0, 1.0), 5.0);
  color = mix(color * lambert(vec3f(0.0, 0.0, 1.0)), G.fogColor, fres * 0.5);
  return vec4f(applyFog(color, in.rel), max(0.8, fres));
}
`;

export class ModelRenderer {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    this.texLayout = device.createBindGroupLayout({
      label: 'model-tex',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }],
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 4, addressModeU: 'repeat', addressModeV: 'repeat' });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, this.texLayout] });
    const module = device.createShaderModule({ label: 'model', code: MODEL_WGSL });
    const instanceAttrs = [
      { shaderLocation: 4, offset: 0, format: 'float32x4' }, { shaderLocation: 5, offset: 16, format: 'float32x4' }, { shaderLocation: 6, offset: 32, format: 'float32x4' },
    ];
    const buffers = [
      { arrayStride: STRIDE, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'unorm8x4' },
      ] },
      { arrayStride: 48, stepMode: 'instance', attributes: instanceAttrs },
    ];
    const make = (label, alphaRef, blend, tree = 0) => device.createRenderPipeline({
      label, layout,
      vertex: { module, entryPoint: 'vs', buffers },
      fragment: { module, entryPoint: 'fs', targets: targets(gpu, blend), constants: { ALPHA_REF: alphaRef, TREE: tree } },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(gpu, !blend), multisample: { count: gpu.sampleCount },
    });
    // index = pipeline id used by batches; the same four again, 4 further on, for the trees
    this.pipelines = [0, 1].flatMap((tree) => [make('model-opaque', -1, undefined, tree), make('model-key', 0.5, undefined, tree), make('model-key-hi', 0.8784, undefined, tree), make('model-blend', 1 / 255, ALPHA_BLEND, tree)]);
    // Which objects are trees (a Set of their file ids), once the map has been told (models/trees.bin,
    // written when the map is updated); null until then - every object counts as one to the cutaway.
    this.trees = null;
    const liquidModule = device.createShaderModule({ label: 'model-liquid', code: LIQUID_WGSL });
    this.liquidPipeline = device.createRenderPipeline({
      label: 'model-liquid', layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout] }),
      vertex: { module: liquidModule, entryPoint: 'vs', buffers: [
        { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        { arrayStride: 48, stepMode: 'instance', attributes: instanceAttrs },
      ] },
      fragment: { module: liquidModule, entryPoint: 'fs', targets: targets(gpu, ALPHA_BLEND) },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(gpu, false), multisample: { count: gpu.sampleCount },
    });

    const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: white }, new Uint8Array([150, 145, 138, 255]), {}, [1, 1]);
    this.fallbackGroup = this.#texGroup(white.createView());

    this.textures = new Map();   // fdid -> { state, group, texture, bytes, lastUsed }
    this.models = new Map();     // key -> model
    this.texLoads = 0; this.modelLoads = 0;
    this.texQueue = []; this.modelQueue = [];
    this.texBytes = 0; this.modelBytes = 0;
    this.texBudget = 700e6; this.modelBudget = 500e6;
    this.maxTextureSize = 512;
    this.frame = 0;
    this.rev = '';
    this.onChange = () => {};

    this.instanceCapacity = 16384;
    this.instanceData = new Float32Array(this.instanceCapacity * 12);
    this.instanceBuffer = device.createBuffer({ label: 'instances', size: this.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.active = [];
    this.stats = { instances: 0, draws: 0, tris: 0 };
  }

  #texGroup(view) {
    return this.gpu.device.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }] });
  }

  // ---- textures --------------------------------------------------------------------------
  #texture(fdid) {
    if (fdid < 0) return this.fallbackGroup;
    let t = this.textures.get(fdid);
    if (!t) { t = { fdid, state: NONE, group: null, texture: null, bytes: 0, lastUsed: 0 }; this.textures.set(fdid, t); }
    t.lastUsed = this.frame;
    if (t.state === NONE) { t.state = LOADING; this.texQueue.push(t); }
    return t.state === READY ? t.group : this.fallbackGroup;
  }

  async #loadTexture(t) {
    this.texLoads++;
    try {
      const res = await fetch(`/data/tex/${t.fdid}.blp?v=${this.rev}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const made = textureFromBLP(this.gpu, await res.arrayBuffer(), { srgb: true, maxSize: this.maxTextureSize });
      t.texture = made.texture;
      t.group = this.#texGroup(made.texture.createView());
      t.bytes = made.bytes;
      this.texBytes += t.bytes;
      t.state = READY;
    } catch { t.state = FAILED; }
    this.texLoads--;
    this.onChange();
  }

  // ---- models ----------------------------------------------------------------------------
  /** Get (and start loading) a model. kind: 'wmo' | 'm2'. */
  model(kind, fdid, priority = 0) {
    const key = kind + fdid;
    let m = this.models.get(key);
    if (!m) { m = { key, kind, fdid, state: NONE, loaded: false, failed: false, lastUsed: 0, priority, instances: 0, first: 0 }; this.models.set(key, m); }
    m.lastUsed = this.frame;
    if (m.state === NONE) { m.state = LOADING; m.queued = true; this.modelQueue.push(m); }
    if (m.queued) m.priority = priority;
    return m;
  }

  async #loadModel(m) {
    this.modelLoads++;
    m.queued = false;
    try {
      const res = await fetch(`/data/models/${m.kind}/${m.fdid}.bin?v=${this.rev}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const c = unpackContainer(buf, 'WFM1');
      const ms = c.sections.get(1);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, ms.offset, ms.size)));
      const { device } = this.gpu;
      const vs = c.sections.get(2), is = c.sections.get(3);
      m.meta = meta;
      m.bytes = 0;
      if (vs && vs.size && is && is.size && meta.batches.length) {
        m.vb = device.createBuffer({ size: (vs.size + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(m.vb, 0, buf, vs.offset, vs.size);
        m.ib = device.createBuffer({ size: is.size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(m.ib, 0, buf, is.offset, is.size);
        m.bytes += vs.size + is.size;
        const hi = m.kind === 'wmo';
        m.batches = meta.batches.filter((b) => b.count > 0 && b.blend <= 2).map((b) => ({
          first: b.first, count: b.count, tex: b.tex >= 0 ? meta.textures[b.tex] : -1,
          pipeline: b.blend === 0 ? 0 : b.blend === 1 ? (hi ? 2 : 1) : 3,
        })).sort((x, y) => x.pipeline - y.pipeline);
      } else m.batches = [];
      const lv = c.sections.get(8), li = c.sections.get(9);
      if (lv && li && li.size) {
        m.liquid = { count: li.size / 4 };
        m.liquid.vb = device.createBuffer({ size: lv.size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(m.liquid.vb, 0, buf, lv.offset, lv.size);
        m.liquid.ib = device.createBuffer({ size: li.size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(m.liquid.ib, 0, buf, li.offset, li.size);
        m.bytes += lv.size + li.size;
      }
      if (m.kind === 'wmo') {
        // Local transforms of the objects placed inside this building.
        const ds = c.sections.get(7);
        const n = ds ? ds.size / 40 : 0;
        const dv = new DataView(buf, ds?.offset ?? 0, ds?.size ?? 0);
        m.doodads = [];
        for (let i = 0; i < n; i++) {
          const p = i * 40;
          const f = (o) => dv.getFloat32(p + o, true);
          m.doodads.push({ fdid: dv.getUint32(p, true), local: quatMatrix([f(4), f(8), f(12)], [f(16), f(20), f(24), f(28)], f(32)), scale: f(32) });
        }
        // Keep the collision triangles: they tell us where the floors are (see floors.js).
        const cs = c.sections.get(5);
        if (vs && vs.size && cs && cs.size) {
          m.collision = { verts: new Float32Array(buf, vs.offset, Math.floor(vs.size / 4)), indices: new Uint32Array(buf, cs.offset, Math.floor(cs.size / 4)), stride: 9 };
          m.bytes += vs.size + cs.size;
        }
        // ...and the triangles it is DRAWN with: what of it can stand between the camera and you
        // (see sight.js). Not the collision triangles: most of a city's roofs have none - nobody
        // can get up there to walk through them - and they hide you all the same. The see-through
        // parts (glass, a beam of light) are left out: they hide nothing.
        const drawn = meta.batches.filter((b) => b.count >= 3 && b.blend <= 1).map((b) => [b.first, b.count]);
        if (vs && vs.size && is && is.size && drawn.length) {
          const aligned = vs.offset % 4 === 0 && is.offset % 4 === 0;
          m.solid = {
            verts: m.collision?.verts ?? (aligned ? new Float32Array(buf, vs.offset, Math.floor(vs.size / 4)) : new Float32Array(buf.slice(vs.offset, vs.offset + Math.floor(vs.size / 4) * 4))),
            indices: aligned ? new Uint32Array(buf, is.offset, Math.floor(is.size / 4)) : new Uint32Array(buf.slice(is.offset, is.offset + Math.floor(is.size / 4) * 4)),
            stride: 9, ranges: drawn,
          };
          m.bytes += m.collision ? is.size : vs.size + is.size;
        }
      } else {
        // An object's collision shape (a tent's canvas, a tree's trunk: small): what of it can
        // stand between the camera and you (see sight.js).
        const cv = c.sections.get(4), ci = c.sections.get(5);
        if (cv && cv.size >= 36 && ci && ci.size >= 12) {
          m.solid = { verts: new Float32Array(buf.slice(cv.offset, cv.offset + Math.floor(cv.size / 4) * 4)), indices: new Uint32Array(buf.slice(ci.offset, ci.offset + Math.floor(ci.size / 4) * 4)), stride: 3 };
          m.bytes += cv.size + ci.size;
        }
      }
      this.modelBytes += m.bytes;
      m.state = READY;
      m.loaded = true;
    } catch (err) {
      m.state = FAILED;
      m.failed = true;
    }
    this.modelLoads--;
    this.onChange();
  }

  // ---- per-frame --------------------------------------------------------------------------
  beginFrame() {
    this.frame++;
    for (const m of this.active) { m.instances = 0; m.list = null; }
    this.active.length = 0;
    this.count = 0;
  }

  /**
   * Queue one instance. `mat` is a 3x4 world transform (doubles); cam is the camera position in
   * the frame the transform is in (two maps drawn side by side each have their own: joined.js).
   */
  add(m, mat, cam) {
    if (m.state !== READY || (!m.batches.length && !m.liquid)) return;
    if (!m.list) { m.list = []; this.active.push(m); }
    m.list.push(mat, cam);
    m.instances++;
    this.count++;
  }

  endFrame() {
    const { device } = this.gpu;
    if (this.count > this.instanceCapacity) {
      this.instanceCapacity = Math.ceil(this.count * 1.5);
      this.instanceData = new Float32Array(this.instanceCapacity * 12);
      this.instanceBuffer.destroy();
      this.instanceBuffer = device.createBuffer({ label: 'instances', size: this.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const d = this.instanceData;
    let o = 0, tris = 0, draws = 0;
    for (const m of this.active) {
      m.first = o / 12;
      for (let i = 0; i < m.list.length; i += 2) {
        const mat = m.list[i], cam = m.list[i + 1];
        d[o] = mat[0]; d[o + 1] = mat[1]; d[o + 2] = mat[2]; d[o + 3] = mat[3] - cam[0];
        d[o + 4] = mat[4]; d[o + 5] = mat[5]; d[o + 6] = mat[6]; d[o + 7] = mat[7] - cam[1];
        d[o + 8] = mat[8]; d[o + 9] = mat[9]; d[o + 10] = mat[10]; d[o + 11] = mat[11] - cam[2];
        o += 12;
      }
      for (const b of m.batches) { tris += (b.count / 3) * m.instances; draws++; }
    }
    if (o) device.queue.writeBuffer(this.instanceBuffer, 0, d, 0, o);
    this.stats = { instances: this.count, draws, tris };
  }

  /** Start queued downloads. Call after drawing (drawing is what discovers needed textures). */
  pump() {
    if (this.modelQueue.length) {
      this.modelQueue.sort((a, b) => a.priority - b.priority);
      while (this.modelLoads < MAX_MODEL_LOADS && this.modelQueue.length) this.#loadModel(this.modelQueue.shift());
    }
    while (this.texLoads < MAX_TEX_LOADS && this.texQueue.length) this.#loadTexture(this.texQueue.shift());
    if (this.frame % 60 === 0) this.#evict();
  }

  get pending() { return this.modelQueue.length + this.modelLoads + this.texQueue.length + this.texLoads; }

  #evict() {
    if (this.texBytes > this.texBudget) {
      const old = [...this.textures.values()].filter((t) => t.state === READY && this.frame - t.lastUsed > 120).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of old) {
        if (this.texBytes < this.texBudget * 0.8) break;
        t.texture.destroy(); this.texBytes -= t.bytes; this.textures.delete(t.fdid);
      }
    }
    if (this.modelBytes > this.modelBudget) {
      const old = [...this.models.values()].filter((m) => m.state === READY && this.frame - m.lastUsed > 120).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const m of old) {
        if (this.modelBytes < this.modelBudget * 0.8) break;
        m.vb?.destroy(); m.ib?.destroy(); m.liquid?.vb.destroy(); m.liquid?.ib.destroy();
        this.modelBytes -= m.bytes; this.models.delete(m.key);
      }
    }
  }

  dispose() {
    for (const t of this.textures.values()) t.texture?.destroy();
    for (const m of this.models.values()) { m.vb?.destroy(); m.ib?.destroy(); m.liquid?.vb.destroy(); m.liquid?.ib.destroy(); }
    this.textures.clear(); this.models.clear(); this.texQueue.length = 0; this.modelQueue.length = 0;
    this.texBytes = 0; this.modelBytes = 0; this.active.length = 0;
  }

  /** Opaque + alpha-tested geometry. */
  drawOpaque(pass) { this.#draw(pass, 0, 2); }
  /** Blended geometry and interior liquids (after terrain water). */
  drawTransparent(pass) {
    if (this.active.some((m) => m.liquid)) {
      pass.setPipeline(this.liquidPipeline);
      for (const m of this.active) {
        if (!m.liquid) continue;
        pass.setVertexBuffer(0, m.liquid.vb);
        pass.setVertexBuffer(1, this.instanceBuffer, m.first * 48, m.instances * 48);
        pass.setIndexBuffer(m.liquid.ib, 'uint32');
        pass.drawIndexed(m.liquid.count, m.instances);
      }
    }
    this.#draw(pass, 3, 3);
  }

  #draw(pass, fromPipeline, toPipeline) {
    let pipeline = -1;
    for (const m of this.active) {
      if (!m.batches.length) continue;
      let bound = false;
      const tree = m.kind === 'm2' && (!this.trees || this.trees.has(m.fdid)) ? 4 : 0;
      for (const b of m.batches) {
        if (b.pipeline < fromPipeline || b.pipeline > toPipeline) continue;
        if (b.pipeline + tree !== pipeline) { pipeline = b.pipeline + tree; pass.setPipeline(this.pipelines[pipeline]); }
        if (!bound) {
          pass.setVertexBuffer(0, m.vb);
          pass.setVertexBuffer(1, this.instanceBuffer, m.first * 48, m.instances * 48);
          pass.setIndexBuffer(m.ib, 'uint32');
          bound = true;
        }
        pass.setBindGroup(1, this.#texture(b.tex));
        pass.drawIndexed(b.count, m.instances, b.first);
      }
    }
  }
}

/**
 * The placed objects of one map: every building (known up front) and the doodads of the
 * full-detail tiles that are currently loaded.
 */
export class ObjectLayer {
  constructor(renderer, scene, m2Radius) {
    this.renderer = renderer;
    this.scene = scene;
    this.m2Radius = m2Radius;
    this.wmos = [];
    this.tiles = new Map(); // node -> Float64Array-backed doodad list
    // (trees: the objects known to be trees - renderer.trees; until they are known, all are "objects")
    this.enabled = { buildings: true, objects: true, trees: true };
    this.detail = 1;
    // What moves, placed afresh every frame: [{ kind, fdid, mat (3x4) }] (the boats, zeppelins and trams: main.js)
    this.moving = [];
  }

  async load() {
    const map = this.scene.map;
    const g = map.globalWmo;
    if (g) this.#addWmo(g.fdid, g.pos, g.rot, g.scale, g.doodadSet, g.bounds, g.nameSet ?? 0);
    if (!map.wmoCount) return;
    const res = await fetch(`/data/maps/${map.id}/wmos.bin?v=${map.rev}`);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const c = unpackContainer(buf, 'WFW1');
    const s = c.sections.get(1);
    const dv = new DataView(buf, s.offset, s.size);
    for (let p = 0; p + 68 <= s.size; p += 68) {
      const f = (o) => dv.getFloat32(p + o, true);
      this.#addWmo(dv.getUint32(p, true), [f(8), f(12), f(16)], [f(20), f(24), f(28)], f(32), dv.getUint16(p + 36, true), [f(44), f(48), f(52), f(56), f(60), f(64)], dv.getUint16(p + 38, true));
    }
  }

  /** @param nameSet  which of the building's sets of room names this placement of it uses (the game's own number: see floors.js) */
  #addWmo(fdid, pos, rot, scale, doodadSet, bounds, nameSet = 0) {
    const radius = Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) / 2;
    this.wmos.push({ fdid, mat: placementMatrix(pos, rot, scale), scale, doodadSet, nameSet, bounds, radius, doodads: null });
  }

  /** Called by the scene when a full-detail tile arrives: keep the doodads that stand on it. */
  addTile(node, buffer, section) {
    const dv = new DataView(buffer, section.offset, section.size);
    const n = dv.getUint32(0, true);
    const list = [];
    const x1 = node.xN, x0 = x1 - TILE, y1 = node.yW, y0 = y1 - TILE;
    for (let i = 0; i < n; i++) {
      const p = 8 + i * 40;
      const x = dv.getFloat32(p + 8, true), y = dv.getFloat32(p + 12, true);
      // A doodad overlapping a tile border is listed by both tiles; it belongs to the one it stands on.
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const fdid = dv.getUint32(p, true);
      const scale = dv.getFloat32(p + 32, true);
      const r = (this.m2Radius.get(fdid) ?? 0) * scale;
      if (r <= 0) continue;
      list.push({ fdid, mat: placementMatrix([x, y, dv.getFloat32(p + 16, true)], [dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true)], scale), r });
    }
    this.tiles.set(node, list);
  }

  removeTile(node) { this.tiles.delete(node); }

  /** Select what is visible and hand it to the renderer (this map alone on the picture). */
  update(cam, planes) {
    this.renderer.beginFrame();
    this.collect(cam, planes);
    this.renderer.endFrame();
  }

  /**
   * The same, as one of several maps on the picture: between the renderer's beginFrame() and
   * endFrame(), each map with the camera where it is in that map's own coordinates.
   */
  collect(cam, planes) {
    const R = this.renderer;
    const k = this.detail;
    const things = this.enabled.objects || this.enabled.trees;
    if (this.enabled.buildings) {
      for (const w of this.wmos) {
        const b = w.bounds;
        const dx = Math.max(b[0] - cam[0], 0, cam[0] - b[3]), dy = Math.max(b[1] - cam[1], 0, cam[1] - b[4]), dz = Math.max(b[2] - cam[2], 0, cam[2] - b[5]);
        const d = Math.hypot(dx, dy, dz);
        // Draw while the building is big enough on screen to matter.
        if (d > (300 + w.radius * 45) * k) continue;
        if (!boxVisible(planes, b[0] - cam[0], b[1] - cam[1], b[2] - cam[2], b[3] - cam[0], b[4] - cam[1], b[5] - cam[2])) {
          if (d < 400) R.model('wmo', w.fdid, d); // keep nearby buildings warm for quick turns
          continue;
        }
        const m = R.model('wmo', w.fdid, d);
        R.add(m, w.mat, cam);
        if (m.state !== READY || !things || !m.doodads.length || d > 450 * k) continue;
        if (!w.doodads) w.doodads = this.#wmoDoodads(w, m);
        for (const o of w.doodads) this.#object(o, cam, planes, k);
      }
    }
    if (things) {
      for (const [node, list] of this.tiles) {
        const dx = Math.max(node.xN - TILE - cam[0], 0, cam[0] - node.xN), dy = Math.max(node.yW - TILE - cam[1], 0, cam[1] - node.yW);
        if (Math.hypot(dx, dy) > 1400 * k) continue;
        for (const o of list) this.#object(o, cam, planes, k);
      }
    }
    // what moves: where it is this frame, with whatever stands aboard it (a ship's rigging)
    for (const o of this.moving) {
      const m = R.model(o.kind, o.fdid, 0);
      R.add(m, o.mat, cam);
      if (o.kind === 'wmo' && m.state === READY && things && m.doodads.length) {
        for (const d of this.#wmoDoodads({ mat: o.mat, scale: 1, doodadSet: 0 }, m)) this.#object(d, cam, planes, k);
      }
    }
  }

  #object(o, cam, planes, k) {
    // (the trees have a switch of their own)
    if (this.renderer.trees?.has(o.fdid) ? !this.enabled.trees : !this.enabled.objects) return;
    const x = o.mat[3] - cam[0], y = o.mat[7] - cam[1], z = o.mat[11] - cam[2];
    const d = Math.hypot(x, y, z);
    // Small things disappear sooner than large ones.
    if (d > (70 + o.r * 38) * k || d > 1500 * k) return;
    if (!sphereVisible(planes, x, y, z, o.r)) return;
    this.renderer.add(this.renderer.model('m2', o.fdid, d), o.mat, cam);
  }

  #wmoDoodads(w, m) {
    const sets = m.meta.doodadSets ?? [];
    const use = [sets[0], w.doodadSet ? sets[w.doodadSet] : null].filter(Boolean);
    const out = [];
    for (const s of use) {
      for (let i = s.start; i < s.start + s.count && i < m.doodads.length; i++) {
        const d = m.doodads[i];
        const r = (this.m2Radius.get(d.fdid) ?? 0) * d.scale * w.scale;
        if (r <= 0) continue;
        out.push({ fdid: d.fdid, mat: affineMul(w.mat, d.local), r });
      }
    }
    return out;
  }
}
