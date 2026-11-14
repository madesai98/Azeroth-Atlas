// WDT: per-map tile table. Lists which of the 64x64 tiles exist and the FileDataIDs of their parts.
import { chunkMap } from './chunked.js';

export function parseWDT(buf) {
  const c = chunkMap(buf);
  const mphd = c.get('MPHD')?.[0];
  const main = c.get('MAIN')?.[0];
  const maid = c.get('MAID')?.[0];
  if (!mphd) throw new Error('WDT without MPHD');
  const flags = buf.readUInt32LE(mphd.pos);
  const out = { flags, usesGlobalWmo: (flags & 1) !== 0, tiles: [], globalWmo: null };
  if (main && maid) {
    const stride = maid.size / 4096;
    for (let row = 0; row < 64; row++) {
      for (let col = 0; col < 64; col++) {
        const i = row * 64 + col;
        if (!(buf.readUInt32LE(main.pos + i * 8) & 1)) continue;
        const e = maid.pos + i * stride;
        const t = {
          col, row,
          root: buf.readUInt32LE(e), obj0: buf.readUInt32LE(e + 4), obj1: buf.readUInt32LE(e + 8), tex0: buf.readUInt32LE(e + 12),
          lod: buf.readUInt32LE(e + 16), mapTexture: buf.readUInt32LE(e + 20), mapTextureN: buf.readUInt32LE(e + 24), minimap: buf.readUInt32LE(e + 28),
        };
        if (t.root) out.tiles.push(t);
      }
    }
  }
  const modf = c.get('MODF')?.[0];
  if (modf && modf.size >= 64) out.globalWmo = parseMODFEntry(buf, modf.pos);
  return out;
}

/** One 64-byte WMO placement record (shared by WDT and ADT obj files). */
export function parseMODFEntry(buf, p) {
  const flags = buf.readUInt16LE(p + 56);
  return {
    fdid: buf.readUInt32LE(p),
    isFdid: (flags & 0x8) !== 0,
    uniqueId: buf.readUInt32LE(p + 4),
    pos: [buf.readFloatLE(p + 8), buf.readFloatLE(p + 12), buf.readFloatLE(p + 16)],
    rot: [buf.readFloatLE(p + 20), buf.readFloatLE(p + 24), buf.readFloatLE(p + 28)],
    extents: [buf.readFloatLE(p + 32), buf.readFloatLE(p + 36), buf.readFloatLE(p + 40), buf.readFloatLE(p + 44), buf.readFloatLE(p + 48), buf.readFloatLE(p + 52)],
    flags,
    doodadSet: buf.readUInt16LE(p + 58),
    nameSet: buf.readUInt16LE(p + 60),
    scale: flags & 0x4 ? buf.readUInt16LE(p + 62) / 1024 : 1,
  };
}
