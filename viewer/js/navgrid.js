// The map's walkable-ground data (maps/<id>/nav/<col>_<row>.bin: the places a character can
// stand, about a yard apart - extractor/jobs/nav.js), read here on the page itself, a tile at a
// time as it is asked for. The route search has its own copy in its worker (navworker.js); this
// one answers at once, for the height tracker (height.js), which asks many times a second:
//
//   - what there is to stand on at a spot besides the terrain and the floors of buildings: the
//     decks of docks, the planks of rope bridges, scaffolds, ramps - things the game places as
//     objects, whose collision the ground data has and the page's own floor lookup has not;
//   - whether the floor at a height leads on to the next cell: a wall between two spots you
//     were at, one after the other, says you are not on that floor.
//
// A tile that has not been fetched yet answers "not known" (null) and is fetched; nothing waits.

const TILE = 1600 / 3, N = 512, CELL = TILE / N;
const F_SWIM = 1, F_TERRAIN = 4, F_STEEP = 8; // (steep: ground too steep to stand on, kept for the route search's ways down it - nothing to stand on)
const OPEN_EAST = 16, OPEN_WEST = 32, OPEN_SOUTH = 64, OPEN_NORTH = 128;
const KEEP = 12;     // tiles kept in hand (about 2 MB each)
const REACH = 1.6;   // yards above or below a height within which a floor is "the floor at that height"

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One tile as it is on the disk, made ready to be asked: { offs, z, flags, xN, yW }. */
export async function readNavTile(buf, col, row) {
  const dv = new DataView(buf);
  const sections = new Map();
  for (let i = 0, n = dv.getUint32(8, true); i < n; i++) sections.set(dv.getUint32(12 + i * 12, true), new Uint8Array(buf, dv.getUint32(16 + i * 12, true), dv.getUint32(20 + i * 12, true)));
  const [counts, zb, flags] = await Promise.all([inflate(sections.get(2)), inflate(sections.get(3)), inflate(sections.get(4))]);
  const q = new Uint16Array(zb.buffer, zb.byteOffset, zb.byteLength >> 1);
  const z = new Float32Array(q.length);
  for (let i = 0, acc = 0; i < q.length; i++) { acc = (acc + q[i]) & 0xffff; z[i] = acc / 8 - 2048; } // stored as differences
  const offs = new Uint32Array(N * N + 1);
  for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
  return { col, row, xN: (32 - row) * TILE, yW: (32 - col) * TILE, offs, z, flags };
}

export class NavGrid {
  /** @param app { scene } (the map in hand says which tiles there are)   @param load (map, name, rev) => Promise<ArrayBuffer | null>, for tests */
  constructor(app, load = null) {
    this.app = app;
    this.tiles = new Map(); // "map/rev/col_row" -> tile | null (none) | undefined while being fetched
    this.loading = 0;
    this.load = load ?? (async (map, name, rev) => { const res = await fetch(`/data/maps/${map}/nav/${name}.bin?v=${rev}`); return res.ok ? res.arrayBuffer() : null; });
    this.have = null;       // the tiles the map in hand has, as a Set of "col_row" (made once per map)
    this.haveFor = null;
  }

  /** True while a tile that was asked for is still on its way. */
  get pending() { return this.loading > 0; }

  #tile(x, y) {
    const map = this.app.scene?.map;
    if (!map?.nav) return null;
    if (this.haveFor !== map) { this.haveFor = map; this.have = new Set((map.tiles ?? []).map((t) => `${t[0]}_${t[1]}`)); }
    const col = Math.floor(32 - y / TILE), row = Math.floor(32 - x / TILE), name = `${col}_${row}`;
    if (!this.have.has(name)) return null;
    const key = `${map.id}/${map.nav.rev}/${name}`;
    if (this.tiles.has(key)) {
      const t = this.tiles.get(key);
      if (t) { this.tiles.delete(key); this.tiles.set(key, t); } // (lately used: kept longest)
      return t;
    }
    this.tiles.set(key, undefined);
    this.loading++;
    this.load(map.id, name, map.nav.rev).then((buf) => (buf ? readNavTile(buf, col, row) : null)).catch(() => null).then((tile) => {
      this.loading--;
      this.tiles.set(key, tile);
      for (const k of this.tiles.keys()) { if (this.tiles.size <= KEEP) break; if (k !== key && this.tiles.get(k) !== undefined) this.tiles.delete(k); }
      if (this.app) this.app.dirty = true;
    });
    return undefined;
  }

  /** The cell a spot is in, in its tile: [tile, cell index] - or null (no ground data there) / undefined (on its way). */
  #cell(x, y) {
    const t = this.#tile(x, y);
    if (!t) return t;
    const i = Math.min(N - 1, Math.max(0, Math.floor((t.yW - y) / CELL))), j = Math.min(N - 1, Math.max(0, Math.floor((t.xN - x) / CELL)));
    return [t, j * N + i];
  }

  /**
   * What there is to stand on in the cell a spot is in: [{ z, terrain, swim }] lowest first -
   * or null where that is not known (no ground data for the map, or the tile still on its way).
   */
  floorsAt(x, y) {
    const c = this.#cell(x, y);
    if (!c) return null;
    const [t, cell] = c, out = [];
    for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) if (!(t.flags[k] & F_STEEP)) out.push({ z: t.z[k], terrain: !!(t.flags[k] & F_TERRAIN), swim: !!(t.flags[k] & F_SWIM) });
    return out.sort((a, b) => a.z - b.z);
  }

  /**
   * The square of the map that the cell a spot is in covers: [x0, y0, x1, y1] - or null where
   * that is not known. (What floorsAt says of a spot is true of somewhere in this square, not
   * of the spot itself: every solid thing that reaches into the cell is in it.)
   */
  cellBox(x, y) {
    const c = this.#cell(x, y);
    if (!c) return null;
    const [t, cell] = c, i = cell % N, j = (cell - i) / N;
    return [t.xN - (j + 1) * CELL, t.yW - (i + 1) * CELL, t.xN - j * CELL, t.yW - i * CELL];
  }

  /**
   * Walking from one spot to the next (a step: less than a cell apart), on the floor at height z:
   * does that floor lead on that way? true: it does (or the two spots are in one cell); false:
   * there is a wall, an edge or a drop between them at that height; null: not known (no floor at
   * that height in the ground data where you were, or no data).
   */
  open(x0, y0, x1, y1, z) {
    const a = this.#cell(x0, y0), b = this.#cell(x1, y1);
    if (!a || !b) return null;
    const [ta, ca] = a, [tb, cb] = b;
    if (ta === tb && ca === cb) return true;
    // (which way: both spots counted in cells from the first one's tile corner, so that it holds across the edge of a tile)
    const east = Math.floor((ta.yW - y1) / CELL) - Math.floor((ta.yW - y0) / CELL), south = Math.floor((ta.xN - x1) / CELL) - Math.floor((ta.xN - x0) / CELL);
    if (Math.abs(east) > 1 || Math.abs(south) > 1) return null; // (further than a step: nothing said)
    if (!east && !south) return true;
    let floor = -1, best = REACH;
    for (let k = ta.offs[ca]; k < ta.offs[ca + 1]; k++) { const d = Math.abs(ta.z[k] - z); if (d <= best && !(ta.flags[k] & F_STEEP)) { best = d; floor = k; } }
    if (floor < 0) return null;
    const f = ta.flags[floor];
    const sideways = east > 0 ? OPEN_EAST : east < 0 ? OPEN_WEST : 0, along = south > 0 ? OPEN_SOUTH : south < 0 ? OPEN_NORTH : 0;
    // (cornerwise: either of the two ways round will do; which floors the way round leads over is not followed further)
    if (sideways && along) return !!(f & sideways) || !!(f & along);
    return !!(f & (sideways || along));
  }
}
