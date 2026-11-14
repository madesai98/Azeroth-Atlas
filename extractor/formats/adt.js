// ADT terrain tiles (split format: root + tex0 + obj0).
import { iterChunks, chunkMap } from './chunked.js';
import { parseMODFEntry } from './wdt.js';

export const OUTER = 129; // shared-corner vertices per tile side
export const INNER = 128; // quad-centre vertices per tile side

/**
 * Parse the root ADT: exact heights, normals, vertex colours, holes, per-chunk metadata, liquids.
 * Grids are row-major: row index runs north->south (world X decreasing), column west->east (world Y decreasing).
 */
export function parseAdtRoot(buf, lvfForObject = null) {
  const heightsOuter = new Float32Array(OUTER * OUTER);
  const heightsInner = new Float32Array(INNER * INNER);
  const normalsOuter = new Int8Array(OUTER * OUTER * 3);
  const normalsInner = new Int8Array(INNER * INNER * 3);
  const colorsOuter = new Uint8Array(OUTER * OUTER * 4).fill(0x7f);
  const colorsInner = new Uint8Array(INNER * INNER * 4).fill(0x7f);
  const holes = new Uint8Array(256 * 8); // per chunk: 8 rows x 8 bits (bit set = quad is a hole)
  const chunkFlags = new Uint32Array(256);
  const chunkArea = new Uint32Array(256);
  const chunkBaseZ = new Float32Array(256);
  let origin = null;
  let hasColors = false;
  let mh2o = null;
  let nChunks = 0;

  for (const c of iterChunks(buf)) {
    if (c.magic === 'MH2O') { mh2o = c; continue; }
    if (c.magic !== 'MCNK') continue;
    const h = c.pos;
    const flags = buf.readUInt32LE(h);
    const ix = buf.readUInt32LE(h + 4), iy = buf.readUInt32LE(h + 8);
    const ci = iy * 16 + ix;
    const px = buf.readFloatLE(h + 0x68), py = buf.readFloatLE(h + 0x6c), pz = buf.readFloatLE(h + 0x70);
    if (ix === 0 && iy === 0) origin = [px, py];
    chunkFlags[ci] = flags;
    chunkArea[ci] = buf.readUInt32LE(h + 0x34);
    chunkBaseZ[ci] = pz;
    nChunks++;
    if (flags & 0x10000) {
      // high-res holes: 8 bytes, one per row, bit = column
      for (let r = 0; r < 8; r++) holes[ci * 8 + r] = buf[h + 0x14 + r];
    } else {
      // low-res holes: 4x4 bits, each covering 2x2 quads
      const low = buf.readUInt16LE(h + 0x3c);
      for (let r = 0; r < 8; r++) {
        let bits = 0;
        for (let q = 0; q < 8; q++) if (low & (1 << ((r >> 1) * 4 + (q >> 1)))) bits |= 1 << q;
        holes[ci * 8 + r] = bits;
      }
    }
    let p = h + 128;
    const end = c.pos + c.size;
    while (p + 8 <= end) {
      const magic = String.fromCharCode(buf[p + 3], buf[p + 2], buf[p + 1], buf[p]);
      let size = buf.readUInt32LE(p + 4);
      const d = p + 8;
      if (magic === 'MCVT') {
        for (let r = 0; r < 9; r++) for (let q = 0; q < 9; q++) heightsOuter[(iy * 8 + r) * OUTER + ix * 8 + q] = pz + buf.readFloatLE(d + (r * 17 + q) * 4);
        for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) heightsInner[(iy * 8 + r) * INNER + ix * 8 + q] = pz + buf.readFloatLE(d + (r * 17 + 9 + q) * 4);
      } else if (magic === 'MCNR') {
        for (let r = 0; r < 9; r++) for (let q = 0; q < 9; q++) {
          const s = d + (r * 17 + q) * 3, o = ((iy * 8 + r) * OUTER + ix * 8 + q) * 3;
          normalsOuter[o] = buf.readInt8(s); normalsOuter[o + 1] = buf.readInt8(s + 1); normalsOuter[o + 2] = buf.readInt8(s + 2);
        }
        for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) {
          const s = d + (r * 17 + 9 + q) * 3, o = ((iy * 8 + r) * INNER + ix * 8 + q) * 3;
          normalsInner[o] = buf.readInt8(s); normalsInner[o + 1] = buf.readInt8(s + 1); normalsInner[o + 2] = buf.readInt8(s + 2);
        }
        if (size === 435) size = 448; // legacy files omit the 13 pad bytes from the chunk size
      } else if (magic === 'MCCV') {
        hasColors = true;
        for (let r = 0; r < 9; r++) for (let q = 0; q < 9; q++) buf.copy(colorsOuter, ((iy * 8 + r) * OUTER + ix * 8 + q) * 4, d + (r * 17 + q) * 4, d + (r * 17 + q) * 4 + 4);
        for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) buf.copy(colorsInner, ((iy * 8 + r) * INNER + ix * 8 + q) * 4, d + (r * 17 + 9 + q) * 4, d + (r * 17 + 9 + q) * 4 + 4);
      }
      p = d + size;
    }
  }
  if (nChunks !== 256 || !origin) throw new Error(`ADT root has ${nChunks} chunks`);
  return {
    origin, heightsOuter, heightsInner, normalsOuter, normalsInner, colorsOuter, colorsInner, hasColors,
    holes, chunkFlags, chunkArea, chunkBaseZ,
    liquids: mh2o ? parseMH2O(buf, mh2o, lvfForObject) : [],
  };
}

/**
 * Liquid layers. Each layer covers a sub-rectangle of one chunk's 8x8 quads.
 * @returns {Array<{chunk:number,type:number,object:number,minH:number,maxH:number,x:number,y:number,w:number,h:number,
 *   exists:Uint8Array|null, heights:Float32Array|null, depths:Uint8Array|null, fishable:Uint8Array|null, deep:Uint8Array|null}>}
 */
export function parseMH2O(buf, chunk, lvfForObject = null) {
  const base = chunk.pos;
  const end = chunk.pos + chunk.size;
  // Collect every referenced offset so vertex-block sizes can be inferred.
  const marks = new Set([chunk.size]);
  const headers = [];
  for (let i = 0; i < 256; i++) {
    const ofsInst = buf.readUInt32LE(base + i * 12), count = buf.readUInt32LE(base + i * 12 + 4), ofsAttr = buf.readUInt32LE(base + i * 12 + 8);
    headers.push({ ofsInst, count, ofsAttr });
    if (count) marks.add(ofsInst);
    if (ofsAttr) marks.add(ofsAttr);
    for (let l = 0; l < count; l++) {
      const p = base + ofsInst + l * 24;
      const ofsExists = buf.readUInt32LE(p + 16), ofsVert = buf.readUInt32LE(p + 20);
      if (ofsExists) marks.add(ofsExists);
      if (ofsVert) marks.add(ofsVert);
    }
  }
  const sorted = [...marks].sort((a, b) => a - b);
  const nextMark = (o) => { for (const m of sorted) if (m > o) return m; return chunk.size; };

  const layers = [];
  for (let i = 0; i < 256; i++) {
    const { ofsInst, count, ofsAttr } = headers[i];
    let fishable = null, deep = null;
    if (count && ofsAttr) {
      fishable = Uint8Array.from(buf.subarray(base + ofsAttr, base + ofsAttr + 8));
      deep = Uint8Array.from(buf.subarray(base + ofsAttr + 8, base + ofsAttr + 16));
    }
    for (let l = 0; l < count; l++) {
      const p = base + ofsInst + l * 24;
      const type = buf.readUInt16LE(p), object = buf.readUInt16LE(p + 2);
      const minH = buf.readFloatLE(p + 4), maxH = buf.readFloatLE(p + 8);
      const x = buf[p + 12], y = buf[p + 13], w = buf[p + 14], h = buf[p + 15];
      const ofsExists = buf.readUInt32LE(p + 16), ofsVert = buf.readUInt32LE(p + 20);
      const n = (w + 1) * (h + 1);
      let exists = null;
      if (ofsExists) exists = Uint8Array.from(buf.subarray(base + ofsExists, base + ofsExists + Math.ceil((w * h) / 8)));
      let heights = null, depths = null;
      if (ofsVert && base + ofsVert < end) {
        const avail = nextMark(ofsVert) - ofsVert;
        let lvf = object < 42 ? object : lvfForObject?.(object, type);
        if (lvf === undefined || lvf === null) lvf = avail >= n * 9 ? 3 : avail >= n * 8 ? 1 : avail >= n * 5 ? 0 : 2;
        // Guard against a bad format guess running past the block.
        if ((lvf === 0 && avail < n * 5) || (lvf === 1 && avail < n * 8) || (lvf === 3 && avail < n * 9)) lvf = avail >= n * 5 ? 0 : 2;
        const v = base + ofsVert;
        if (lvf === 0 || lvf === 1 || lvf === 3) {
          heights = new Float32Array(n);
          for (let k = 0; k < n; k++) heights[k] = buf.readFloatLE(v + k * 4);
        }
        if (lvf === 0) depths = Uint8Array.from(buf.subarray(v + n * 4, v + n * 5));
        else if (lvf === 2) depths = Uint8Array.from(buf.subarray(v, v + n));
        else if (lvf === 3) depths = Uint8Array.from(buf.subarray(v + n * 8, v + n * 9));
      }
      layers.push({ chunk: i, type, object, minH, maxH, x, y, w, h, exists, heights, depths, fishable, deep });
    }
  }
  return layers;
}

/** Object placement file (obj0): doodads (M2) and world map objects (WMO). */
export function parseAdtObj(buf) {
  const c = chunkMap(buf);
  const doodads = [];
  const wmos = [];
  const mddf = c.get('MDDF')?.[0];
  if (mddf) {
    for (let p = mddf.pos; p + 36 <= mddf.pos + mddf.size; p += 36) {
      const flags = buf.readUInt16LE(p + 34);
      doodads.push({
        fdid: buf.readUInt32LE(p), isFdid: (flags & 0x40) !== 0, uniqueId: buf.readUInt32LE(p + 4),
        pos: [buf.readFloatLE(p + 8), buf.readFloatLE(p + 12), buf.readFloatLE(p + 16)],
        rot: [buf.readFloatLE(p + 20), buf.readFloatLE(p + 24), buf.readFloatLE(p + 28)],
        scale: buf.readUInt16LE(p + 32) / 1024, flags,
      });
    }
  }
  const modf = c.get('MODF')?.[0];
  if (modf) for (let p = modf.pos; p + 64 <= modf.pos + modf.size; p += 64) wmos.push(parseMODFEntry(buf, p));
  return { doodads, wmos };
}

/** Texture layer file (tex0): ground texture ids + per-chunk layers and alpha maps. */
export function parseAdtTex(buf, { bigAlpha = true } = {}) {
  let diffuseIds = [], heightIds = [];
  const chunks = [];
  for (const c of iterChunks(buf)) {
    if (c.magic === 'MDID') { for (let p = c.pos; p < c.pos + c.size; p += 4) diffuseIds.push(buf.readUInt32LE(p)); }
    else if (c.magic === 'MHID') { for (let p = c.pos; p < c.pos + c.size; p += 4) heightIds.push(buf.readUInt32LE(p)); }
    else if (c.magic === 'MCNK') {
      const sub = chunkMap(buf, c.pos, c.pos + c.size);
      const mcly = sub.get('MCLY')?.[0], mcal = sub.get('MCAL')?.[0];
      const layers = [];
      if (mcly) {
        for (let p = mcly.pos; p + 16 <= mcly.pos + mcly.size; p += 16) {
          layers.push({ texture: buf.readUInt32LE(p), flags: buf.readUInt32LE(p + 4), ofsAlpha: buf.readUInt32LE(p + 8), effectId: buf.readUInt32LE(p + 12), alpha: null });
        }
        for (let li = 1; li < layers.length; li++) {
          const L = layers[li];
          if (!(L.flags & 0x100) || !mcal) continue; // 0x100: has alpha map
          L.alpha = decodeAlpha(buf, mcal.pos + L.ofsAlpha, mcal.pos + mcal.size, (L.flags & 0x200) !== 0, bigAlpha);
        }
      }
      chunks.push({ layers });
    }
  }
  return { diffuseIds, heightIds, chunks };
}

function decodeAlpha(buf, p, end, compressed, bigAlpha) {
  const out = new Uint8Array(4096);
  if (compressed) {
    let o = 0;
    while (o < 4096 && p < end) {
      const info = buf[p++];
      const fill = info & 0x80, n = info & 0x7f;
      if (fill) { const v = buf[p++]; for (let k = 0; k < n && o < 4096; k++) out[o++] = v; }
      else for (let k = 0; k < n && o < 4096; k++) out[o++] = buf[p++];
    }
  } else if (bigAlpha) {
    buf.copy(out, 0, p, Math.min(end, p + 4096));
  } else {
    for (let i = 0; i < 2048 && p + i < end; i++) {
      const b = buf[p + i];
      out[i * 2] = (b & 15) * 17; out[i * 2 + 1] = (b >> 4) * 17;
    }
  }
  return out;
}
