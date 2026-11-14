// Builds one terrain tile artifact from the game's ADT files. Everything a renderer *and* a
// future pathfinder needs is kept losslessly: exact heights (corner + centre vertices), holes,
// per-chunk flags/area ids, liquid layers and object placements.
import { parseAdtRoot, parseAdtObj, OUTER, INNER } from '../formats/adt.js';
import { MAP_HALF } from '../formats/chunked.js';
import { packContainer, writeFileAtomic, BinWriter, f32View } from '../container.js';

export const TILE_VERSION = 1;
export const SEC = { HEIGHTS: 1, NORMALS: 2, COLORS: 3, HOLES: 4, CHUNKS: 5, LIQUID: 6, OBJECTS: 7 };
const NV = OUTER * OUTER + INNER * INNER;

function packNormals(outer, inner) {
  const out = new Int8Array(NV * 4);
  let o = 0;
  for (const src of [outer, inner]) for (let i = 0; i < src.length; i += 3, o += 4) { out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; }
  return out;
}

function packColors(outer, inner) {
  // MCCV is stored BGRA; emit RGBA. 0x7F is the neutral value (shader multiplies by 2).
  const out = new Uint8Array(NV * 4);
  let o = 0;
  for (const src of [outer, inner]) for (let i = 0; i < src.length; i += 4, o += 4) { out[o] = src[i + 2]; out[o + 1] = src[i + 1]; out[o + 2] = src[i]; out[o + 3] = src[i + 3]; }
  return out;
}

function packLiquid(layers) {
  const w = new BinWriter(4096);
  w.u32(layers.length);
  for (const L of layers) {
    const n = (L.w + 1) * (L.h + 1);
    const flags = (L.exists ? 1 : 0) | (L.heights ? 2 : 0) | (L.depths ? 4 : 0) | (L.fishable ? 8 : 0);
    w.u16(L.chunk).u16(L.type).u8(L.x).u8(L.y).u8(L.w).u8(L.h).u32(flags).f32(L.minH).f32(L.maxH);
    if (L.exists) { const e = new Uint8Array(8); e.set(L.exists.subarray(0, 8)); w.bytes(e); }
    if (L.heights) w.bytes(L.heights);
    if (L.depths) w.bytes(L.depths.subarray(0, n)).align();
    if (L.fishable) w.bytes(L.fishable).bytes(L.deep);
  }
  return w.done();
}

/** Inverse of packLiquid (used when building the distant-water grids). */
export function parseLiquidSection(buf) {
  const layers = [];
  if (!buf || buf.length < 4) return layers;
  const count = buf.readUInt32LE(0);
  let p = 4;
  for (let i = 0; i < count; i++) {
    const L = { chunk: buf.readUInt16LE(p), type: buf.readUInt16LE(p + 2), x: buf[p + 4], y: buf[p + 5], w: buf[p + 6], h: buf[p + 7] };
    const flags = buf.readUInt32LE(p + 8);
    L.minH = buf.readFloatLE(p + 12); L.maxH = buf.readFloatLE(p + 16);
    p += 20;
    const n = (L.w + 1) * (L.h + 1);
    L.exists = null; L.heights = null; L.depths = null;
    if (flags & 1) { L.exists = buf.subarray(p, p + 8); p += 8; }
    if (flags & 2) { L.heights = f32View(buf, n, p); p += n * 4; }
    if (flags & 4) { L.depths = buf.subarray(p, p + n); p += (n + 3) & ~3; }
    if (flags & 8) { L.fishable = buf.subarray(p, p + 8); L.deep = buf.subarray(p + 8, p + 16); p += 16; }
    layers.push(L);
  }
  return layers;
}

/** ADT placement coordinates -> world coordinates (X north, Y west, Z up). */
export const placementToWorld = (p) => [MAP_HALF - p[2], MAP_HALF - p[0], p[1]];

function packObjects(doodads, wmos) {
  const w = new BinWriter(8 + doodads.length * 40 + wmos.length * 68);
  w.u32(doodads.length).u32(wmos.length);
  for (const d of doodads) {
    const p = placementToWorld(d.pos);
    w.u32(d.fdid).u32(d.uniqueId).f32(p[0]).f32(p[1]).f32(p[2]).f32(d.rot[0]).f32(d.rot[1]).f32(d.rot[2]).f32(d.scale).u32(d.flags);
  }
  for (const m of wmos) {
    const p = placementToWorld(m.pos);
    const e = m.extents;
    w.u32(m.fdid).u32(m.uniqueId).f32(p[0]).f32(p[1]).f32(p[2]).f32(m.rot[0]).f32(m.rot[1]).f32(m.rot[2]).f32(m.scale)
      .u16(m.doodadSet).u16(m.nameSet).u32(m.flags)
      // world-space bounds: min xyz, max xyz
      .f32(MAP_HALF - e[5]).f32(MAP_HALF - e[3]).f32(e[1]).f32(MAP_HALF - e[2]).f32(MAP_HALF - e[0]).f32(e[4]);
  }
  return w.done();
}

/**
 * @param casc   archive reader
 * @param job    { files:{root,obj0,mapTexture}, out, colorOut, lvf:{byType,typeForObject} }
 * @returns summary used for overview building, model discovery and incremental state
 */
export function buildTile(casc, job) {
  const rootBuf = casc.readFile(job.files.root);
  if (!rootBuf) throw new Error(`terrain file ${job.files.root} is not available locally`);
  const lvf = job.lvf;
  const lvfForObject = (object, type) => {
    const t = lvf.typeForObject[object] ?? type;
    return lvf.byType[t];
  };
  const adt = parseAdtRoot(rootBuf, lvfForObject);
  // Resolve each liquid layer's real type id (the MH2O "object" indirection) for the viewer/nav.
  for (const L of adt.liquids) if (L.object >= 42 && lvf.typeForObject[L.object] !== undefined) L.type = lvf.typeForObject[L.object];

  let doodads = [], wmos = [];
  const objBuf = job.files.obj0 ? casc.readFile(job.files.obj0) : null;
  if (objBuf) {
    const o = parseAdtObj(objBuf);
    doodads = o.doodads.filter((d) => d.isFdid && d.fdid);
    wmos = o.wmos.filter((d) => d.isFdid && d.fdid);
  }

  const heights = new Float32Array(NV);
  heights.set(adt.heightsOuter, 0);
  heights.set(adt.heightsInner, OUTER * OUTER);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < NV; i++) { const h = heights[i]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
  const chunks = new Uint32Array(512);
  for (let i = 0; i < 256; i++) { chunks[i * 2] = adt.chunkFlags[i]; chunks[i * 2 + 1] = adt.chunkArea[i]; }

  const sections = [
    { id: SEC.HEIGHTS, data: heights },
    { id: SEC.NORMALS, data: packNormals(adt.normalsOuter, adt.normalsInner) },
    { id: SEC.HOLES, data: adt.holes },
    { id: SEC.CHUNKS, data: chunks },
    { id: SEC.LIQUID, data: packLiquid(adt.liquids) },
    { id: SEC.OBJECTS, data: packObjects(doodads, wmos) },
  ];
  if (adt.hasColors) sections.push({ id: SEC.COLORS, data: packColors(adt.colorsOuter, adt.colorsInner) });
  writeFileAtomic(job.out, packContainer('WFT1', TILE_VERSION, sections));

  let hasColor = false;
  if (job.files.mapTexture && job.colorOut) {
    const tex = casc.readFile(job.files.mapTexture);
    if (tex && tex.latin1Slice(0, 4) === 'BLP2') { writeFileAtomic(job.colorOut, tex); hasColor = true; }
  }
  const liquidTypes = [...new Set(adt.liquids.map((L) => L.type))];
  const areas = [...new Set(adt.chunkArea)];
  // Level of this tile's ocean surface, if it has one (used to continue the sea past the map edge).
  let sea = null;
  for (const L of adt.liquids) if (job.kinds?.[L.type] === 2) { sea = Math.round(L.minH * 100) / 100; break; }
  return {
    minH, maxH, hasColor, liquidTypes, areas, sea,
    m2: [...new Set(doodads.map((d) => d.fdid))],
    wmo: [...new Set(wmos.map((d) => d.fdid))],
    doodadCount: doodads.length, wmoCount: wmos.length,
  };
}
