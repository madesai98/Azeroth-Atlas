// Helpers for the IFF-style chunked files used by WDT/ADT/WMO (magic is stored reversed).

/** Iterate chunks in [start, end). Yields { magic, size, pos } where pos is the payload offset. */
export function* iterChunks(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    const magic = String.fromCharCode(buf[p + 3], buf[p + 2], buf[p + 1], buf[p]);
    const size = buf.readUInt32LE(p + 4);
    yield { magic, size, pos: p + 8 };
    p += 8 + size;
  }
}

/** Collect top-level chunks into a Map magic -> [{size,pos}] */
export function chunkMap(buf, start = 0, end = buf.length) {
  const m = new Map();
  for (const c of iterChunks(buf, start, end)) {
    let list = m.get(c.magic);
    if (!list) m.set(c.magic, (list = []));
    list.push(c);
  }
  return m;
}

export const TILE_SIZE = 1600 / 3; // 533.333.. yards
export const CHUNK_SIZE = TILE_SIZE / 16;
export const UNIT_SIZE = CHUNK_SIZE / 8;
export const MAP_HALF = 32 * TILE_SIZE; // 17066.666..
