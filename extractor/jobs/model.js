// Converts game models (WMO buildings, M2 doodads) into a compact render + collision format.
//
// Render data: interleaved vertices (position, normal, uv, colour = 36 bytes) and triangle
// batches grouped by texture. Collision data is kept alongside, including the game's own
// per-triangle flags, so a route planner can tell walkable floors from decoration.
import { parseWmoRoot, parseWmoGroup, groupName, TRI, GROUP } from '../formats/wmo.js';
import { parseM2, parseSkin, unseen } from '../formats/m2.js';
import { packContainer, writeFileAtomic, BinWriter } from '../container.js';

export const MODEL_VERSION = 3;
// What the route grid takes from a model is its collision. That was last made differently for
// every model at this version; since then it differs only for the buildings that leave a part
// out (leftOut below), and extract.js lays a route tile again only where one of those stands.
export const COLLISION_VERSION = 2;
export const MSEC = { META: 1, VERTICES: 2, INDICES: 3, COLLISION_VERTS: 4, COLLISION_INDICES: 5, COLLISION_FLAGS: 6, DOODADS: 7, LIQUID_VERTS: 8, LIQUID_INDICES: 9 };
const STRIDE = 36;

function readDep(casc, fdid, deps) {
  deps[fdid] = casc.contentHash(fdid);
  return casc.readFile(fdid);
}

// ---- the parts of a building that are not part of the picture --------------------------------
// The game never draws a building whole: it draws the groups the camera can see from where it
// is, through the building's doorways. The map draws every group at once, so that you see a
// town and the rooms in it from above. Two kinds of group must not be in that picture:
//
//  - An ANTIPORTAL: a slab (flagged so, or simply named "antiportal") with which the game
//    hides what is behind a wall. It is no part of the building: the game never draws it and
//    nobody can get to it - drawn, it is a bright blue slab in the middle of Gilneas.
//
//  - A STAND-IN: what a city shows of itself to somebody outside it. The streets and squares of
//    Stormwind are "indoor" groups lit by the sky; standing in the canals the game does not
//    draw them, it draws a copy of the cathedral made to be seen over the walls - larger than
//    the one on the square, and not in the same place. The copy is flagged UNREACHABLE, but so
//    are treetops, a tower's outer shell and the mountain a keep is built into, which are all
//    there is of those. What tells a stand-in apart is that it is out of reach AND stands over
//    a district that lies under the open sky. (Neither is enough alone: a house whose porch is
//    such an "indoor group lit by the sky" has its roof over it - but that roof is the house,
//    and the game does not flag it out of reach.)
const STANDIN_CELL = 2;      // yards: the grid a group's outline is taken on, seen from straight above
const STANDIN_MIN = 25;      // cells (100 square yards): a smaller unreachable bit is not judged
const STANDIN_SHARE = 0.25;  // this much of its outline over an open-sky district: a stand-in
const STANDIN_CLEAR = 3;     // yards above the district's floor that count as "over" it
// (Held against every building of the game, 964 of them: the two cathedral copies of Stormwind
//  stand 52% and 91% over Cathedral Square; every other unreachable group that is big enough
//  to be judged - Darnassus's treetops, Shadowfang's tower, the mountain behind Stormwind Keep -
//  stands 0% over an open-sky district. 21 buildings have such districts; 63 groups that can
//  be reached stand a quarter or more over one - upper rooms over an arcade, a bell tower, the
//  roof over a porch - and stay.)

/** The cells of the grid a group's drawn triangles cover, seen from above: fn(i, j, height). */
function outline(root, g, x0, y0, upOnly, fn) {
  const P = g.positions, N = g.normals, I = g.indices;
  const nTris = Math.min(g.nTris, g.triMaterial ? g.triMaterial.length : 0);
  for (let t = 0; t < nTris; t++) {
    if (g.triMaterial[t] >= root.materials.length) continue; // not drawn
    const ia = I[t * 3], ib = I[t * 3 + 1], ic = I[t * 3 + 2];
    const ax = (P[ia * 3] - x0) / STANDIN_CELL, ay = (P[ia * 3 + 1] - y0) / STANDIN_CELL, az = P[ia * 3 + 2];
    const bx = (P[ib * 3] - x0) / STANDIN_CELL, by = (P[ib * 3 + 1] - y0) / STANDIN_CELL, bz = P[ib * 3 + 2];
    const cx = (P[ic * 3] - x0) / STANDIN_CELL, cy = (P[ic * 3 + 1] - y0) / STANDIN_CELL, cz = P[ic * 3 + 2];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); // twice its area as seen from above
    if (upOnly) {
      // a floor: it faces up, by the normals it is drawn with (or, without any, by how it lies)
      let up;
      if (N && N.length >= g.nVerts * 3) up = (N[ia * 3 + 2] + N[ib * 3 + 2] + N[ic * 3 + 2]) / 3;
      else {
        const ux = P[ib * 3] - P[ia * 3], uy = P[ib * 3 + 1] - P[ia * 3 + 1], uz = bz - az, vx = P[ic * 3] - P[ia * 3], vy = P[ic * 3 + 1] - P[ia * 3 + 1], vz = cz - az;
        const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
        up = Math.abs(gz) / (Math.hypot(gx, gy, gz) || 1);
      }
      if (!(up >= 0.5)) continue;
    }
    fn(Math.floor(ax), Math.floor(ay), az); fn(Math.floor(bx), Math.floor(by), bz); fn(Math.floor(cx), Math.floor(cy), cz);
    if (Math.abs(den) < 1e-9) continue; // (upright: its corners are all there is of it from above)
    const i0 = Math.floor(Math.min(ax, bx, cx)), i1 = Math.floor(Math.max(ax, bx, cx));
    const j0 = Math.floor(Math.min(ay, by, cy)), j1 = Math.floor(Math.max(ay, by, cy));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i + 0.5, py = j + 0.5;
      const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w = 1 - u - v;
      if (u < 0 || v < 0 || w < 0) continue;
      fn(i, j, u * az + v * bz + w * cz);
    }
  }
}

/**
 * Which groups of a building the map leaves out, and why: for each group (as parseWmoGroup gave
 * it) '' - it is part of the building - or 'antiportal' or 'stand-in' (see above).
 */
export function leftOut(root, groups) {
  const why = groups.map((g) => ((g.flags & GROUP.ANTIPORTAL) || groupName(root, g).toLowerCase() === 'antiportal' ? 'antiportal' : ''));
  const far = [], open = [];
  groups.forEach((g, i) => {
    if (why[i] || !g.positions || !g.indices || !g.triMaterial) return;
    if (g.flags & GROUP.UNREACHABLE) far.push(i);
    else if ((g.flags & GROUP.INTERIOR) && (g.flags & GROUP.EXTERIOR_LIT)) open.push(i);
  });
  if (!far.length || !open.length) return why;
  // The floors of the open-sky districts, on a grid over them (nothing stands over one outside it).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of open) {
    const b = groups[i].bbox;
    x0 = Math.min(x0, b[0], b[3]); x1 = Math.max(x1, b[0], b[3]); y0 = Math.min(y0, b[1], b[4]); y1 = Math.max(y1, b[1], b[4]);
  }
  const nx = Math.floor((x1 - x0) / STANDIN_CELL) + 1, ny = Math.floor((y1 - y0) / STANDIN_CELL) + 1;
  if (!(nx > 0 && ny > 0 && nx * ny < 4e7)) return why;
  const floor = new Float32Array(nx * ny).fill(Infinity);
  for (const i of open) outline(root, groups[i], x0, y0, true, (ci, cj, z) => { if (ci >= 0 && cj >= 0 && ci < nx && cj < ny && z < floor[cj * nx + ci]) floor[cj * nx + ci] = z; });
  for (const i of far) {
    const top = new Map(); // cell -> the highest the group reaches there
    outline(root, groups[i], x0, y0, false, (ci, cj, z) => { const k = (cj + 0x8000) * 0x10000 + (ci + 0x8000); const was = top.get(k); if (was === undefined || z > was) top.set(k, z); });
    if (top.size < STANDIN_MIN) continue;
    let over = 0;
    for (const [k, z] of top) {
      const ci = (k % 0x10000) - 0x8000, cj = Math.floor(k / 0x10000) - 0x8000;
      if (ci >= 0 && cj >= 0 && ci < nx && cj < ny && z > floor[cj * nx + ci] + STANDIN_CLEAR) over++;
    }
    if (over >= top.size * STANDIN_SHARE) why[i] = 'stand-in';
  }
  return why;
}

export function buildWmo(casc, job) {
  const deps = {};
  const rootBuf = readDep(casc, job.fdid, deps);
  if (!rootBuf) throw Object.assign(new Error('not available locally'), { code: 'EMISSING' });
  const root = parseWmoRoot(rootBuf);
  const every = [];
  for (const fd of root.groupFiles) {
    if (!fd) continue;
    try {
      const buf = readDep(casc, fd, deps);
      if (buf) every.push(parseWmoGroup(buf, root.flags));
    } catch (err) {
      if (err.code !== 'EENCRYPTED') throw err; // unreleased (encrypted) parts are simply absent
    }
  }
  // The groups that are no part of the picture (see leftOut) are left out whole: not drawn, no
  // ground to stand on, no room of the building. An object placed in the building belongs to
  // the groups that list it: one that only left-out groups list goes with them.
  const why = leftOut(root, every);
  const groups = every.filter((g, i) => !why[i]);
  const left = [];
  every.forEach((g, i) => { if (why[i]) left.push({ group: i, why: why[i], name: groupName(root, g), flags: g.flags, bbox: g.bbox }); });
  const kept = new Uint8Array(root.doodads.length), gone = new Uint8Array(root.doodads.length);
  every.forEach((g, i) => { for (const d of g.doodadRefs) if (d < kept.length) (why[i] ? gone : kept)[d] = 1; });
  const doodads = root.doodads.map((d, i) => (gone[i] && !kept[i] ? { ...d, fdid: 0 } : d));
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

  // (an object that went with a left-out group keeps its place in the list - the sets of objects
  // go by position - with no model to draw: the viewer passes over it)
  const dw = new BinWriter(doodads.length * 40 + 4);
  for (const d of doodads) dw.u32(d.fdid).f32(d.pos[0]).f32(d.pos[1]).f32(d.pos[2]).f32(d.rot[0]).f32(d.rot[1]).f32(d.rot[2]).f32(d.rot[3]).f32(d.scale).u32(d.color);

  const meta = {
    kind: 'wmo', wmoId: root.wmoId, bbox: root.bbox, vertexCount: totalVerts, batches, textures,
    doodadSets: root.doodadSets, doodadCount: doodads.length, groups: groupInfo,
    collision: { shared: true, triangles: colFlags.length },
  };
  if (left.length) meta.left = left; // (what was left out of it, and why: for whoever wonders where a part went)
  const sections = [
    { id: MSEC.META, data: Buffer.from(JSON.stringify(meta)) }, { id: MSEC.VERTICES, data: vbuf }, { id: MSEC.INDICES, data: indices },
    { id: MSEC.COLLISION_INDICES, data: new Uint32Array(colIdx) }, { id: MSEC.COLLISION_FLAGS, data: new Uint8Array(colFlags) },
    { id: MSEC.DOODADS, data: dw.done() },
  ];
  if (liqIdx.length) sections.push({ id: MSEC.LIQUID_VERTS, data: new Float32Array(liqVerts) }, { id: MSEC.LIQUID_INDICES, data: new Uint32Array(liqIdx) });
  writeFileAtomic(job.out, packContainer('WFM1', MODEL_VERSION, sections));
  const out = { deps, textures, m2: [...new Set(doodads.map((d) => d.fdid).filter(Boolean))], triangles: first / 3 };
  // (which groups were left out: the route grid of the tiles it stands on is made without them - see extract.js)
  if (left.length) out.left = left.map((l) => `${l.group}:${l.why}`);
  return out;
}

/**
 * The parts an object is drawn in: [{ mat, tex, first, count }] (one pass each; the extra
 * passes are effects). A part the game keeps invisible where the object stands is not one of
 * them (formats/m2.js: unseen) - the broken half of a door that is whole, an invisible wall,
 * the shape a beam of light hangs on: drawn, each is a solid thing that is not there.
 */
export function m2Parts(m, skin) {
  const out = [];
  if (!skin) return out;
  const seen = new Set();
  for (const b of skin.batches) {
    if (b.layer > 0 || seen.has(b.section)) continue;
    const sec = skin.sections[b.section];
    const mat = m.materials[b.material];
    if (!sec || !mat || sec.indexStart + sec.indexCount > skin.indices.length) continue;
    if (unseen(m, b)) continue;
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
  const parts = m2Parts(m, skin);
  if (skin) {
    indices = skin.indices;
    for (let i = 0; i < indices.length; i++) if (indices[i] >= m.nVertices) indices[i] = 0;
    // (Extra material layers re-draw the same geometry for effects; one pass is enough here.)
    for (const p of parts) batches.push({ tex: texIndex(p.tex?.fdid ?? 0), first: p.first, count: p.count, blend: p.mat.blend, flags: (p.mat.flags & 0x04 ? 1 : 0) | (p.mat.flags & 0x01 ? 2 : 0) });
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
  return { deps, textures, triangles: indices.length / 3, radius: Math.round(radius * 100) / 100, shape: m2Shape(m, parts) };
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
