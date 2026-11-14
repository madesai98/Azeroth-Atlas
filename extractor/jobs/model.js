// Converts game models (WMO buildings, M2 doodads) into a compact render + collision format.
//
// Render data: interleaved vertices (position, normal, uv, colour = 36 bytes) and triangle
// batches grouped by texture. Collision data is kept alongside, including the game's own
// per-triangle flags, so a route planner can tell walkable floors from decoration.
import { parseWmoRoot, parseWmoGroup, TRI, GROUP } from '../formats/wmo.js';
import { parseM2, parseSkin } from '../formats/m2.js';
import { packContainer, writeFileAtomic, BinWriter } from '../container.js';

export const MODEL_VERSION = 2;
export const MSEC = { META: 1, VERTICES: 2, INDICES: 3, COLLISION_VERTS: 4, COLLISION_INDICES: 5, COLLISION_FLAGS: 6, DOODADS: 7, LIQUID_VERTS: 8, LIQUID_INDICES: 9 };
const STRIDE = 36;

function readDep(casc, fdid, deps) {
  deps[fdid] = casc.contentHash(fdid);
  return casc.readFile(fdid);
}

export function buildWmo(casc, job) {
  const deps = {};
  const rootBuf = readDep(casc, job.fdid, deps);
  if (!rootBuf) throw Object.assign(new Error('not available locally'), { code: 'EMISSING' });
  const root = parseWmoRoot(rootBuf);
  const groups = [];
  for (const fd of root.groupFiles) {
    if (!fd) continue;
    try {
      const buf = readDep(casc, fd, deps);
      if (buf) groups.push(parseWmoGroup(buf, root.flags));
    } catch (err) {
      if (err.code !== 'EENCRYPTED') throw err; // unreleased (encrypted) parts are simply absent
    }
  }
  let totalVerts = 0;
  for (const g of groups) totalVerts += g.nVerts;
  const vbuf = Buffer.alloc(totalVerts * STRIDE);
  const byMaterial = new Map();
  const colIdx = [], colFlags = [];
  const liqVerts = [], liqIdx = [];
  const groupInfo = [];
  let base = 0;
  for (const g of groups) {
    groupInfo.push({ flags: g.flags, bbox: g.bbox, area: g.areaGroupId, firstVertex: base, vertexCount: g.nVerts });
    if (!g.positions || !g.indices) continue;
    const baked = (g.flags & GROUP.INTERIOR) && g.colors && g.colors.length >= g.nVerts * 4;
    for (let i = 0; i < g.nVerts; i++) {
      const o = (base + i) * STRIDE;
      vbuf.writeFloatLE(g.positions[i * 3], o); vbuf.writeFloatLE(g.positions[i * 3 + 1], o + 4); vbuf.writeFloatLE(g.positions[i * 3 + 2], o + 8);
      if (g.normals) { vbuf.writeFloatLE(g.normals[i * 3], o + 12); vbuf.writeFloatLE(g.normals[i * 3 + 1], o + 16); vbuf.writeFloatLE(g.normals[i * 3 + 2], o + 20); }
      else vbuf.writeFloatLE(1, o + 20);
      if (g.uvs) { vbuf.writeFloatLE(g.uvs[i * 2], o + 24); vbuf.writeFloatLE(g.uvs[i * 2 + 1], o + 28); }
      // Interior groups carry baked lighting in their vertex colours (alpha 0 marks "pre-lit").
      if (baked) { vbuf[o + 32] = g.colors[i * 4 + 2]; vbuf[o + 33] = g.colors[i * 4 + 1]; vbuf[o + 34] = g.colors[i * 4]; vbuf[o + 35] = 0; }
      else { vbuf[o + 32] = 255; vbuf[o + 33] = 255; vbuf[o + 34] = 255; vbuf[o + 35] = 255; }
    }
    const nTris = Math.min(g.nTris, g.triFlags ? g.triFlags.length : 0);
    for (let t = 0; t < nTris; t++) {
      const a = g.indices[t * 3] + base, b = g.indices[t * 3 + 1] + base, c = g.indices[t * 3 + 2] + base;
      const f = g.triFlags[t], m = g.triMaterial[t];
      if (m < root.materials.length) {
        let list = byMaterial.get(m);
        if (!list) byMaterial.set(m, (list = []));
        list.push(a, b, c);
      }
      const isRender = (f & TRI.RENDER) && !(f & TRI.DETAIL);
      if ((f & TRI.COLLISION) || isRender) { colIdx.push(a, b, c); colFlags.push(f); }
    }
    if (g.liquid) {
      const L = g.liquid, kind = job.kinds[L.type] ?? 1;
      const v0 = liqVerts.length / 4;
      for (let j = 0; j < L.yv; j++) for (let i = 0; i < L.xv; i++) liqVerts.push(L.corner[0] + i * L.unit, L.corner[1] + j * L.unit, L.heights[j * L.xv + i], kind);
      for (let j = 0; j < L.yt; j++) for (let i = 0; i < L.xt; i++) {
        if ((L.tiles[j * L.xt + i] & 0x0f) === 0x0f) continue;
        const a = v0 + j * L.xv + i, b = a + 1, d = a + L.xv, e = d + 1;
        liqIdx.push(a, b, d, b, e, d);
      }
    }
    base += g.nVerts;
  }
  const textures = [];
  const texIndex = (fdid) => {
    if (!fdid) return -1;
    let i = textures.indexOf(fdid);
    if (i < 0) { i = textures.length; textures.push(fdid); }
    return i;
  };
  const batches = [];
  const indexParts = [];
  let first = 0;
  for (const [m, list] of [...byMaterial].sort((x, y) => x[0] - y[0])) {
    const mat = root.materials[m];
    batches.push({ tex: texIndex(mat.texture), first, count: list.length, blend: Math.min(mat.blend, 2), flags: (mat.flags & 0x04 ? 1 : 0) | (mat.flags & 0x01 ? 2 : 0) });
    indexParts.push(list);
    first += list.length;
  }
  const indices = new Uint32Array(first);
  let o = 0;
  for (const list of indexParts) { indices.set(list, o); o += list.length; }

  const dw = new BinWriter(root.doodads.length * 40 + 4);
  for (const d of root.doodads) dw.u32(d.fdid).f32(d.pos[0]).f32(d.pos[1]).f32(d.pos[2]).f32(d.rot[0]).f32(d.rot[1]).f32(d.rot[2]).f32(d.rot[3]).f32(d.scale).u32(d.color);

  const meta = {
    kind: 'wmo', wmoId: root.wmoId, bbox: root.bbox, vertexCount: totalVerts, batches, textures,
    doodadSets: root.doodadSets, doodadCount: root.doodads.length, groups: groupInfo,
    collision: { shared: true, triangles: colFlags.length },
  };
  const sections = [
    { id: MSEC.META, data: Buffer.from(JSON.stringify(meta)) }, { id: MSEC.VERTICES, data: vbuf }, { id: MSEC.INDICES, data: indices },
    { id: MSEC.COLLISION_INDICES, data: new Uint32Array(colIdx) }, { id: MSEC.COLLISION_FLAGS, data: new Uint8Array(colFlags) },
    { id: MSEC.DOODADS, data: dw.done() },
  ];
  if (liqIdx.length) sections.push({ id: MSEC.LIQUID_VERTS, data: new Float32Array(liqVerts) }, { id: MSEC.LIQUID_INDICES, data: new Uint32Array(liqIdx) });
  writeFileAtomic(job.out, packContainer('WFM1', MODEL_VERSION, sections));
  return { deps, textures, m2: [...new Set(root.doodads.map((d) => d.fdid).filter(Boolean))], triangles: first / 3 };
}

/** The parts an object is drawn in: [{ material, texture, first, count }] (one pass each; the extra passes are effects). */
function m2Parts(m, skin) {
  const out = [];
  if (!skin) return out;
  const seen = new Set();
  for (const b of skin.batches) {
    if (b.layer > 0 || seen.has(b.section)) continue;
    const sec = skin.sections[b.section];
    const mat = m.materials[b.material];
    if (!sec || !mat || sec.indexStart + sec.indexCount > skin.indices.length) continue;
    seen.add(b.section);
    out.push({ mat, tex: m.textures[m.texCombos[b.textureCombo]], first: sec.indexStart, count: sec.indexCount });
  }
  return out;
}

/**
 * What an object looks like, in a few numbers (see trees.js): its own name, how tall and how
 * wide it is, and how much of it is foliage (drawn with cut-out transparency).
 */
function m2Shape(m, parts) {
  let all = 0, leaf = 0;
  for (const p of parts) { all += p.count; if (p.mat.blend === 1) leaf += p.count; }
  const b = m.bbox, r2 = (v) => Math.round(v * 100) / 100;
  return { name: m.name, h: r2(b[5] - b[2]), w: r2(Math.max(b[3] - b[0], b[4] - b[1])), leaf: all ? r2(leaf / all) : 0 };
}

/** The same numbers for an object that is already converted (nothing is written). */
export function shapeM2(casc, job) {
  const buf = casc.readFile(job.fdid);
  if (!buf) throw Object.assign(new Error('not available locally'), { code: 'EMISSING' });
  const m = parseM2(buf);
  let skin = null;
  if (m.skinFiles[0]) { const sb = casc.readFile(m.skinFiles[0]); if (sb) skin = parseSkin(sb); }
  return m2Shape(m, m2Parts(m, skin));
}

export function buildM2(casc, job) {
  const deps = {};
  const buf = readDep(casc, job.fdid, deps);
  if (!buf) throw Object.assign(new Error('not available locally'), { code: 'EMISSING' });
  const m = parseM2(buf);
  let skin = null;
  if (m.skinFiles[0]) {
    const sb = readDep(casc, m.skinFiles[0], deps);
    if (sb) skin = parseSkin(sb);
  }
  const vbuf = Buffer.alloc(m.nVertices * STRIDE);
  for (let i = 0; i < m.nVertices; i++) {
    const o = i * STRIDE;
    for (let k = 0; k < 3; k++) { vbuf.writeFloatLE(m.positions[i * 3 + k], o + k * 4); vbuf.writeFloatLE(m.normals[i * 3 + k], o + 12 + k * 4); }
    vbuf.writeFloatLE(m.uvs[i * 2], o + 24); vbuf.writeFloatLE(m.uvs[i * 2 + 1], o + 28);
    vbuf[o + 32] = 255; vbuf[o + 33] = 255; vbuf[o + 34] = 255; vbuf[o + 35] = 255;
  }
  const textures = [];
  const texIndex = (fdid) => {
    if (!fdid) return -1;
    let i = textures.indexOf(fdid);
    if (i < 0) { i = textures.length; textures.push(fdid); }
    return i;
  };
  const batches = [];
  let indices = new Uint32Array(0);
  if (skin) {
    indices = skin.indices;
    for (let i = 0; i < indices.length; i++) if (indices[i] >= m.nVertices) indices[i] = 0;
    const seen = new Set();
    for (const b of skin.batches) {
      // Extra material layers re-draw the same geometry for effects; one pass is enough here.
      if (b.layer > 0 || seen.has(b.section)) continue;
      const sec = skin.sections[b.section];
      const mat = m.materials[b.material];
      if (!sec || !mat || sec.indexStart + sec.indexCount > indices.length) continue;
      seen.add(b.section);
      const tex = m.textures[m.texCombos[b.textureCombo]];
      batches.push({ tex: texIndex(tex?.fdid ?? 0), first: sec.indexStart, count: sec.indexCount, blend: mat.blend, flags: (mat.flags & 0x04 ? 1 : 0) | (mat.flags & 0x01 ? 2 : 0) });
    }
  }
  const meta = {
    kind: 'm2', bbox: m.bbox, radius: m.radius, vertexCount: m.nVertices, batches, textures,
    collision: { shared: false, triangles: m.collision ? m.collision.indices.length / 3 : 0 },
  };
  const sections = [{ id: MSEC.META, data: Buffer.from(JSON.stringify(meta)) }, { id: MSEC.VERTICES, data: vbuf }, { id: MSEC.INDICES, data: indices }];
  if (m.collision) sections.push({ id: MSEC.COLLISION_VERTS, data: m.collision.positions }, { id: MSEC.COLLISION_INDICES, data: m.collision.indices });
  writeFileAtomic(job.out, packContainer('WFM1', MODEL_VERSION, sections));
  // Bounding radius about the model origin (0 = nothing to draw), used for distance culling.
  let radius = 0;
  if (batches.length) for (let c = 0; c < 8; c++) radius = Math.max(radius, Math.hypot(m.bbox[c & 1 ? 3 : 0], m.bbox[c & 2 ? 4 : 1], m.bbox[c & 4 ? 5 : 2]));
  return { deps, textures, triangles: indices.length / 3, radius: Math.round(radius * 100) / 100, shape: m2Shape(m, m2Parts(m, skin)) };
}

/** Copy textures out of the archives unchanged (they are already GPU-ready). */
export function copyTextures(casc, job) {
  const done = {};
  for (const { fdid, out } of job.items) {
    try {
      const buf = casc.readFile(fdid);
      if (!buf || buf.latin1Slice(0, 4) !== 'BLP2') continue;
      writeFileAtomic(out, buf);
      done[fdid] = true;
    } catch { /* encrypted or unreadable: the viewer falls back to a flat colour */ }
  }
  return done;
}
