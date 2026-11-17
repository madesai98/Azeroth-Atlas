// Terrain + water rendering. Every quadtree node (a single tile, or a 2x2 / 4x4 / 8x8 block of
// tiles) is drawn with the same shaders: a shared grid mesh displaced by the node's height
// texture, textured with the game's own baked ground colour.
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';
import { textureFromBLP } from './formats.js';

const NODE_UNIFORM_STRIDE = 256;
const MAX_DRAWS = 1024;

const NO_FLOOR = -1e9; // (a node's floor where all of its ground is drawn)

const NODE_WGSL = /* wgsl */ `
struct NodeU { originRel: vec3f, scale: f32, skirt: f32, level: f32, floor: f32, pad1: f32 };
@group(1) @binding(0) var<uniform> N: NodeU;
@group(1) @binding(1) var heightTex: texture_2d<f32>;
@group(1) @binding(2) var normalTex: texture_2d<f32>;
@group(1) @binding(3) var colorTex: texture_2d<f32>;
@group(1) @binding(4) var holeTex: texture_2d<f32>;
@group(1) @binding(5) var overlayTex: texture_2d<f32>;
`;

const TERRAIN_WGSL = GLOBALS_WGSL + NODE_WGSL + /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) rel: vec3f,
  @location(2) height: f32,
};

// Vertex = (hx, hy, skirt) in half-quad units: even coordinates are the shared corner
// vertices, odd ones are the quad-centre vertices (only used by the full-detail mesh).
@vertex fn vs(@location(0) a: vec4u) -> VSOut {
  var tc = vec2i(i32(a.x >> 1u), i32(a.y >> 1u));
  if ((a.x & 1u) == 1u) { tc.y += 129; }
  let h = textureLoad(heightTex, tc, 0).r;
  var o: VSOut;
  o.rel = N.originRel + vec3f(-f32(a.y) * N.scale, -f32(a.x) * N.scale, h - f32(a.z) * N.skirt);
  o.pos = G.viewProj * vec4f(o.rel, 1.0);
  o.uv = vec2f(f32(a.x), f32(a.y)) / 256.0;
  o.height = h;
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let albedo = textureSample(colorTex, linearSampler, in.uv).rgb;
  let gx = dpdx(in.rel);
  let gy = dpdy(in.rel);
  let hw = fwidth(in.height);
  if (textureSampleLevel(holeTex, nearestSampler, in.uv, 0.0).r > 0.5) { discard; }
  // (an island in the sky: nothing of its ground under its floor - see scene.js)
  if (in.height < N.floor) { discard; }
  if (G.cutOpts.y > 0.5 && cutAway(in.rel, false)) { discard; }
  // (a hill between the camera and you: a hole through it, along the line of sight)
  if (cutSight(in.rel, G.cutLand.x)) { discard; }
  let nuv = (in.uv * 128.0 + 0.5) / 129.0;
  let n = normalize(textureSampleLevel(normalTex, linearSampler, nuv, 0.0).xyz);
  var color = albedo * lambert(n);

  let ov = u32(G.overlay);
  if ((ov & 1u) != 0u) {
    // Walkability: the true geometric slope of the rendered surface.
    let cz = abs(normalize(cross(gx, gy)).z);
    if (cz < G.slopeCos) { color = mix(color, vec3f(0.85, 0.06, 0.04), 0.6); }
    else if (cz < G.slopeCos + 0.07) { color = mix(color, vec3f(0.95, 0.7, 0.05), 0.4); }
  }
  if ((ov & 2u) != 0u) {
    let c = in.height / G.contourStep;
    let w = max(hw / G.contourStep, 1e-5);
    let minor = 1.0 - smoothstep(0.0, 1.5 * w, abs(fract(c - 0.5) - 0.5));
    let major = 1.0 - smoothstep(0.0, 2.5 * w / 5.0, abs(fract(c / 5.0 - 0.5) - 0.5));
    let fade = 1.0 - smoothstep(0.25, 0.6, w);
    color = mix(color, color * 0.35, max(minor * 0.45, major * 0.8) * fade);
  }
  // Ground overlay (spawn zones): premultiplied colour painted over the terrain.
  let over = textureSampleLevel(overlayTex, linearSampler, in.uv, 0.0);
  color = color * (1.0 - over.a) + over.rgb;
  return vec4f(applyFog(color, in.rel), 1.0);
}
`;

const WATER_WGSL = GLOBALS_WGSL + NODE_WGSL + /* wgsl */ `
struct WOut {
  @builtin(position) pos: vec4f,
  @location(0) grid: vec2f,
  @location(1) rel: vec3f,
  @location(2) level: f32,
  @location(3) @interpolate(flat) kind: u32,
};

@vertex fn vs(@location(0) a: vec4f) -> WOut {
  var o: WOut;
  o.rel = N.originRel + vec3f(-a.y * N.scale, -a.x * N.scale, a.z);
  o.pos = G.viewProj * vec4f(o.rel, 1.0);
  o.grid = a.xy * 0.5;
  o.level = a.z;
  o.kind = u32(a.w);
  return o;
}

fn terrainHeight(g: vec2f) -> f32 {
  let p = clamp(g, vec2f(0.0), vec2f(127.999));
  let i = vec2i(floor(p));
  let f = fract(p);
  let h00 = textureLoad(heightTex, i, 0).r;
  let h10 = textureLoad(heightTex, i + vec2i(1, 0), 0).r;
  let h01 = textureLoad(heightTex, i + vec2i(0, 1), 0).r;
  let h11 = textureLoad(heightTex, i + vec2i(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

@fragment fn fs(in: WOut) -> @location(0) vec4f {
  if (cutAway(in.rel, false)) { discard; }
  let kind = in.kind & 7u;
  var depth = 60.0;
  if ((in.kind & 8u) == 0u) { depth = max(in.level - terrainHeight(in.grid), 0.0); }
  var shallow = vec3f(0.10, 0.36, 0.42);
  var deep = vec3f(0.015, 0.09, 0.20);
  var minAlpha = 0.5;
  if (kind == 2u) { shallow = vec3f(0.07, 0.34, 0.46); deep = vec3f(0.008, 0.06, 0.17); }
  if (kind == 3u) { // magma
    let glow = mix(vec3f(1.6, 0.42, 0.04), vec3f(0.9, 0.12, 0.02), smoothstep(0.0, 10.0, depth));
    return vec4f(applyFog(glow, in.rel), 1.0);
  }
  if (kind == 4u) { shallow = vec3f(0.22, 0.42, 0.06); deep = vec3f(0.07, 0.2, 0.02); minAlpha = 0.75; }
  let view = normalize(-in.rel);
  let fres = pow(1.0 - clamp(view.z, 0.0, 1.0), 5.0);
  var color = mix(shallow, deep, smoothstep(0.0, 22.0, depth)) * lambert(vec3f(0.0, 0.0, 1.0));
  color = mix(color, G.fogColor, fres * 0.55);
  // Sun glint
  let r = reflect(-G.sunDir, vec3f(0.0, 0.0, 1.0));
  color += G.sunColor * pow(max(dot(r, view), 0.0), 180.0) * 0.6;
  // Shallows are see-through; deep water is fully opaque so open sea looks the same everywhere.
  let alpha = max(mix(minAlpha, 1.0, smoothstep(0.0, 26.0, depth)), fres);
  return vec4f(applyFog(color, in.rel), alpha);
}
`;

const SKY_WGSL = GLOBALS_WGSL + /* wgsl */ `
struct SOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> SOut {
  var o: SOut;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
@fragment fn fs(in: SOut) -> @location(0) vec4f {
  let d = normalize(G.camFwd + G.camRight * in.ndc.x * G.tanX + G.camUp * in.ndc.y * G.tanY);
  let t = clamp(d.z, 0.0, 1.0);
  var color = mix(G.fogColor, G.zenith, pow(t, 0.45));
  let s = max(dot(d, G.sunDir), 0.0);
  color += G.sunColor * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.12);
  return vec4f(color, 1.0);
}
`;

/** Grid mesh in half-quad units (0..256). n = cells per side; fan = add quad-centre vertices. */
function buildGrid(n, fan) {
  const step = 256 / n;
  const verts = [];
  const idx = [];
  const at = (i, j) => j * (n + 1) + i;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * step, j * step, 0, 0);
  if (fan) {
    const base = verts.length / 4;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) verts.push(i * 2 + 1, j * 2 + 1, 0, 0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const c = base + j * n + i, a = at(i, j), b = at(i + 1, j), d = at(i + 1, j + 1), e = at(i, j + 1);
      idx.push(a, b, c, b, d, c, d, e, c, e, a, c);
    }
  } else {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = at(i, j), b = at(i + 1, j), d = at(i + 1, j + 1), e = at(i, j + 1);
      idx.push(a, b, e, b, d, e);
    }
  }
  // Skirts: a vertical curtain under each edge hides hairline gaps between neighbouring
  // nodes drawn at different resolutions.
  const edges = [
    (k) => [k, 0], (k) => [n, k], (k) => [n - k, n], (k) => [0, n - k],
  ];
  for (const edge of edges) {
    const start = verts.length / 4;
    for (let k = 0; k <= n; k++) { const [i, j] = edge(k); verts.push(i * step, j * step, 1, 0); }
    for (let k = 0; k < n; k++) {
      const [i0, j0] = edge(k), [i1, j1] = edge(k + 1);
      const a = at(i0, j0), b = at(i1, j1), s0 = start + k, s1 = start + k + 1;
      idx.push(a, s0, b, b, s0, s1);
    }
  }
  return { vertices: new Uint16Array(verts), indices: new Uint16Array(idx) };
}

export class TerrainRenderer {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    this.nodeLayout = device.createBindGroupLayout({
      label: 'node',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { hasDynamicOffset: true, minBindingSize: 32 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, this.nodeLayout] });
    const multisample = { count: gpu.sampleCount };

    const terrainModule = device.createShaderModule({ label: 'terrain', code: TERRAIN_WGSL });
    this.terrainPipeline = device.createRenderPipeline({
      label: 'terrain', layout,
      vertex: { module: terrainModule, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'uint16x4' }] }] },
      fragment: { module: terrainModule, entryPoint: 'fs', targets: targets(gpu) },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(gpu, true), multisample,
    });
    const waterModule = device.createShaderModule({ label: 'water', code: WATER_WGSL });
    this.waterPipeline = device.createRenderPipeline({
      label: 'water', layout,
      vertex: { module: waterModule, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
      fragment: { module: waterModule, entryPoint: 'fs', targets: targets(gpu, ALPHA_BLEND) },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(gpu, false), multisample,
    });
    const skyModule = device.createShaderModule({ label: 'sky', code: SKY_WGSL });
    this.skyPipeline = device.createRenderPipeline({
      label: 'sky', layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout] }),
      vertex: { module: skyModule, entryPoint: 'vs' },
      fragment: { module: skyModule, entryPoint: 'fs', targets: targets(gpu) },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'always' }, multisample,
    });

    // Shared grid meshes: [fan(128 + centres), 128, 64, 32, 16]
    this.meshes = [buildGrid(128, true), buildGrid(128, false), buildGrid(64, false), buildGrid(32, false), buildGrid(16, false)].map((m, i) => {
      const vb = device.createBuffer({ label: `grid${i}-v`, size: m.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vb, 0, m.vertices);
      const ib = device.createBuffer({ label: `grid${i}-i`, size: (m.indices.byteLength + 3) & ~3, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ib, 0, m.indices);
      return { vb, ib, count: m.indices.length };
    });

    this.uniformData = new Float32Array((MAX_DRAWS * NODE_UNIFORM_STRIDE) / 4);
    this.uniformBuffer = device.createBuffer({ label: 'node-uniforms', size: MAX_DRAWS * NODE_UNIFORM_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const solid = (format, bytes) => {
      const t = device.createTexture({ size: [1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, bytes, {}, [1, 1]);
      return t.createView();
    };
    this.noHoles = solid('r8unorm', new Uint8Array([0, 0, 0, 0]));
    this.flatHeight = solid('r32float', new Float32Array([0]));
    this.flatNormal = solid('rgba8snorm', new Int8Array([0, 0, 127, 0]));
    this.grey = solid('rgba8unorm', new Uint8Array([90, 100, 85, 255]));
    this.noOverlay = solid('rgba8unorm', new Uint8Array([0, 0, 0, 0]));
    // Bind group for geometry that is not tied to a node (open-sea filler quads).
    this.plainGroup = this.#bindGroup(this.flatHeight, this.flatNormal, this.grey, this.noHoles, this.noOverlay);

    this.fillerCapacity = 36000; // vertices (two maps side by side cut their sea into more pieces)
    this.fillerData = new Float32Array(this.fillerCapacity * 16);
    this.fillerBuffer = device.createBuffer({ label: 'sea-filler', size: this.fillerData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  #bindGroup(height, normal, color, holes, overlay) {
    return this.gpu.device.createBindGroup({
      layout: this.nodeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: 32 } },
        { binding: 1, resource: height }, { binding: 2, resource: normal }, { binding: 3, resource: color }, { binding: 4, resource: holes }, { binding: 5, resource: overlay },
      ],
    });
  }

  /**
   * Create GPU resources for a loaded node.
   * data: { heights:Float32Array (129*129, plus 128*128 centre heights for tiles), normals:Int8Array(129*129*4),
   *         colorBLP:ArrayBuffer|null, holes:{size,data:Uint8Array}|null, water:{vertices:Float32Array, indices:Uint32Array}|null }
   */
  createNode(data) {
    const { device } = this.gpu;
    const res = { textures: [], water: null };
    const hasInner = data.heights.length > 129 * 129;
    const rows = hasInner ? 257 : 129;
    const hTex = device.createTexture({ size: [129, rows], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    let hData = data.heights;
    if (hasInner) {
      // centre vertices are 128 per row; pad each row to the 129-texel width
      hData = new Float32Array(129 * 257);
      hData.set(data.heights.subarray(0, 129 * 129));
      for (let r = 0; r < 128; r++) hData.set(data.heights.subarray(129 * 129 + r * 128, 129 * 129 + (r + 1) * 128), (129 + r) * 129);
    }
    device.queue.writeTexture({ texture: hTex }, hData, { bytesPerRow: 129 * 4 }, [129, rows]);
    const nTex = device.createTexture({ size: [129, 129], format: 'rgba8snorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: nTex }, data.normals, { bytesPerRow: 129 * 4 }, [129, 129]);
    res.textures.push(hTex, nTex);
    let colorView = this.grey;
    if (data.colorBLP) {
      try {
        const c = textureFromBLP(this.gpu, data.colorBLP, { srgb: true });
        res.textures.push(c.texture);
        colorView = c.texture.createView();
      } catch (err) { console.warn('colour texture failed', err); }
    }
    let holeView = this.noHoles;
    if (data.holes) {
      const t = device.createTexture({ size: [data.holes.size, data.holes.size], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, data.holes.data, { bytesPerRow: data.holes.size }, [data.holes.size, data.holes.size]);
      res.textures.push(t);
      holeView = t.createView();
    }
    res.views = [hTex.createView(), nTex.createView(), colorView, holeView];
    res.overlay = null;
    res.bindGroup = this.#bindGroup(...res.views, this.noOverlay);
    if (data.water && data.water.indices.length) {
      const vb = device.createBuffer({ size: data.water.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vb, 0, data.water.vertices);
      const ib = device.createBuffer({ size: data.water.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ib, 0, data.water.indices);
      res.water = { vb, ib, count: data.water.indices.length };
    }
    return res;
  }

  /**
   * Set (or clear, with null) the ground overlay image of a node: square RGBA, premultiplied.
   */
  setOverlay(res, rgba, size = 256) {
    const { device } = this.gpu;
    if (!rgba) {
      if (!res.overlay) return;
      res.overlay.destroy();
      res.overlay = null;
      res.bindGroup = this.#bindGroup(...res.views, this.noOverlay);
      return;
    }
    const fresh = !res.overlay;
    if (fresh) res.overlay = device.createTexture({ size: [size, size], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: res.overlay }, rgba, { bytesPerRow: size * 4 }, [size, size]);
    if (fresh) res.bindGroup = this.#bindGroup(...res.views, res.overlay.createView());
  }

  destroyNode(res) {
    res.overlay?.destroy();
    for (const t of res.textures) t.destroy();
    res.water?.vb.destroy();
    res.water?.ib.destroy();
  }

  /**
   * Sky + terrain surface.
   * @param draws [{ res, originRel:[x,y,z], scale, skirt, mesh, level, floor (null: none) }] sorted near-to-far
   * @param fillerRel camera-relative origin for the open-sea quads
   */
  drawTerrain(pass, draws, fillerRel) {
    const { device } = this.gpu;
    const n = Math.min(draws.length, MAX_DRAWS - 1);
    this.drawCount = n;
    const u = this.uniformData;
    for (let i = 0; i < n; i++) {
      const d = draws[i], o = (i * NODE_UNIFORM_STRIDE) / 4;
      u[o] = d.originRel[0]; u[o + 1] = d.originRel[1]; u[o + 2] = d.originRel[2];
      u[o + 3] = d.scale; u[o + 4] = d.skirt; u[o + 5] = d.level; u[o + 6] = d.floor ?? NO_FLOOR;
    }
    // Last slot: identity-ish transform for the sea filler (positions are already camera-relative).
    const fo = (n * NODE_UNIFORM_STRIDE) / 4;
    u[fo] = fillerRel[0]; u[fo + 1] = fillerRel[1]; u[fo + 2] = fillerRel[2]; u[fo + 3] = 1; u[fo + 4] = 0; u[fo + 5] = 0; u[fo + 6] = NO_FLOOR;
    device.queue.writeBuffer(this.uniformBuffer, 0, u, 0, ((n + 1) * NODE_UNIFORM_STRIDE) / 4);

    pass.setBindGroup(0, this.gpu.globalsGroup);
    pass.setPipeline(this.skyPipeline);
    pass.draw(3);

    pass.setPipeline(this.terrainPipeline);
    let mesh = -1;
    for (let i = 0; i < n; i++) {
      const d = draws[i];
      if (d.mesh !== mesh) {
        mesh = d.mesh;
        pass.setVertexBuffer(0, this.meshes[mesh].vb);
        pass.setIndexBuffer(this.meshes[mesh].ib, 'uint16');
      }
      pass.setBindGroup(1, d.res.bindGroup, [i * NODE_UNIFORM_STRIDE]);
      pass.drawIndexed(this.meshes[mesh].count);
    }
  }

  /**
   * Lakes, rivers and sea (blended; call after all opaque geometry).
   * @param fillerVerts open-sea quads (4 floats per vertex, 6 vertices per quad), camera-relative
   */
  drawWater(pass, draws, fillerVerts) {
    const { device } = this.gpu;
    const n = this.drawCount;
    pass.setBindGroup(0, this.gpu.globalsGroup);
    pass.setPipeline(this.waterPipeline);
    const quads = Math.min(fillerVerts.length / 24, this.fillerCapacity / 6 | 0);
    if (quads > 0) {
      device.queue.writeBuffer(this.fillerBuffer, 0, fillerVerts, 0, quads * 24);
      pass.setVertexBuffer(0, this.fillerBuffer);
      pass.setBindGroup(1, this.plainGroup, [n * NODE_UNIFORM_STRIDE]);
      pass.draw(quads * 6);
    }
    // Water far-to-near for correct blending.
    for (let i = n - 1; i >= 0; i--) {
      const d = draws[i];
      if (!d.res.water) continue;
      pass.setVertexBuffer(0, d.res.water.vb);
      pass.setIndexBuffer(d.res.water.ib, 'uint32');
      pass.setBindGroup(1, d.res.bindGroup, [i * NODE_UNIFORM_STRIDE]);
      pass.drawIndexed(d.res.water.count);
    }
  }
}
