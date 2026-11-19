// What there is to walk on inside a dungeon, for holding the minimap's places against.
//
// The minimap says where you are, picture by picture (minimap-find.js) - and a picture can be
// read wrong: two corridors alike, something over half the minimap. But you get from one place
// to the next on your feet. The map has every dungeon's floors (maps/<id>/nav/<col>_<row>.bin:
// the places a character can stand, about a yard apart, and which of them each leads on to -
// extractor/jobs/nav.js; the page's route search reads the same files: viewer/js/navworker.js),
// and the game says how fast you are moving. So of any place the minimap gives it can be asked:
// is there a floor there, and could you have walked to it from where you were, in the yards you
// have gone since? Through a wall, or up to the floor above with no stair between, you could not.
//
// Read here straight off the disk, a tile when it is first asked about, and kept (a dungeon has
// a handful). Nothing here knows of the minimap: floors, steps, and how far it is on foot.
import zlib from 'node:zlib';

const TILE = 1600 / 3, N = 512;
export const CELL = TILE / N;
const F_STEEP = 8;
const OPEN = [16, 32, 64, 128];   // a floor's flag: it leads on east, west, south, north (as DX / DY below)
const BACK = [32, 16, 128, 64];   // the same edge seen from the other cell
const LINK_EDGE = 15;             // a link that says: on this side it is open, and the next cell is on the next tile
const UP = 1.375, DOWN = 3;       // yards up and down from one cell to the next that are a step (as extractor/jobs/nav.js has it)
const HEAD = 1.7, OPEN_SKY = 65535, SLIDE_ON = 0.5;
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DIAG = CELL * Math.SQRT2;
const FALL_MOST = 70;             // yards: further than this nobody falls and walks on

/** One tile as it is on the disk (a Buffer), made ready to be asked - or null where it cannot be read. */
export function readGroundTile(buf, col, row) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), sections = new Map();
    for (let i = 0, n = dv.getUint32(8, true); i < n; i++) sections.set(dv.getUint32(12 + i * 12, true), buf.subarray(dv.getUint32(16 + i * 12, true), dv.getUint32(16 + i * 12, true) + dv.getUint32(20 + i * 12, true)));
    const open = (id) => (sections.has(id) ? zlib.inflateRawSync(sections.get(id)) : null);
    const counts = open(2), zb = open(3), flags = open(4), lb = open(5), eb = open(6);
    if (!counts || !zb || !flags || counts.length < N * N) return null;
    const n = zb.length >> 1, z = new Float32Array(n);
    for (let i = 0, acc = 0; i < n; i++) { acc = (acc + zb.readUInt16LE(i * 2)) & 0xffff; z[i] = acc / 8 - 2048; } // (stored as differences)
    const offs = new Uint32Array(N * N + 1);
    for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
    let links = null;
    if (lb && lb.length >> 1 === n) { links = new Uint16Array(n); for (let i = 0; i < n; i++) links[i] = lb.readUInt16LE(i * 2); }
    // (along the tile's four edges, the room over each surface on that side: what a drop on to this tile from the next has to clear)
    let edge = null;
    const edgeAt = new Int32Array(4 * N);
    if (links && eb) {
      let at = 0;
      for (let d = 0; d < 4; d++) for (let a = 0; a < N; a++) {
        const cell = (d === 2 ? N - 1 : d === 3 ? 0 : a) * N + (d === 0 ? N - 1 : d === 1 ? 0 : a);
        edgeAt[d * N + a] = at - offs[cell];
        at += offs[cell + 1] - offs[cell];
      }
      if (eb.length >> 1 === at) { edge = new Uint16Array(at); for (let i = 0; i < at; i++) edge[i] = eb.readUInt16LE(i * 2); }
    }
    return { col, row, xN: (32 - row) * TILE, yW: (32 - col) * TILE, offs, z, flags, links, edge, edgeAt, nodes: n };
  } catch { return null; }
}

/** A floor: the tile it is in, its cell there, its number in the tile. */
const spot = (t, cell, n) => ({ t, cell, n, z: t.z[n], x: t.xN - (((cell / N) | 0) + 0.5) * CELL, y: t.yW - ((cell % N) + 0.5) * CELL });

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v;
    let i = K.length; K.push(key); V.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v, top = [K[0], V[0]], key = K.pop(), val = V.pop(), n = K.length;
    if (n) {
      let i = 0;
      for (;;) { let c = i * 2 + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

export class Ground {
  /**
   * @param read   (col, row) => the tile's file as a Buffer, or null where there is none
   * @param lifts  the map's lifts (world.json: lifts): [{ x, y, r, lo, hi, stops }] - a lift takes you from
   *               the floor at one of its stops to the floor at another without a yard walked
   */
  constructor({ read, lifts = [] }) {
    this.read = read;
    this.lifts = lifts;
    this.tiles = new Map(); // col * 128 + row -> tile | null
    this.ids = [];          // a number for each tile read, for naming a floor by one number (see key)
  }

  tile(col, row) {
    const k = col * 128 + row;
    let t = this.tiles.get(k);
    if (t !== undefined) return t;
    let buf = null;
    try { buf = this.read(col, row); } catch { buf = null; }
    t = buf ? readGroundTile(buf, col, row) : null;
    if (t) { t.id = this.ids.length; this.ids.push(t); }
    this.tiles.set(k, t);
    return t;
  }

  /** True where the map has floors to go by at all (some tile of it could be read). */
  get any() { return this.ids.length > 0; }

  /** A floor by one number, and back. */
  key(f) { return f.t.id * 4194304 + f.n; }

  #cell(x, y) {
    const t = this.tile(Math.floor(32 - y / TILE), Math.floor(32 - x / TILE));
    if (!t) return null;
    const i = Math.min(N - 1, Math.max(0, Math.floor((t.yW - y) / CELL))), j = Math.min(N - 1, Math.max(0, Math.floor((t.xN - x) / CELL)));
    return [t, j * N + i];
  }

  /** What there is to stand on in the cell a spot is in: [{ t, cell, n, z, x, y }], lowest first. */
  floorsAt(x, y) {
    const c = this.#cell(x, y);
    if (!c) return [];
    const [t, cell] = c, out = [];
    for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) if (!(t.flags[k] & F_STEEP)) out.push(spot(t, cell, k));
    return out.sort((a, b) => a.z - b.z);
  }

  /**
   * The floors within so many yards of a spot (and, where heights are given, between them):
   * [{ t, cell, n, z, x, y, d (yards from the spot to the floor's cell) }], nearest first.
   */
  floorsNear(x, y, reach = 1.5, lo = -Infinity, hi = Infinity) {
    const out = [], r = Math.ceil(reach / CELL);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const px = x - dj * CELL, py = y - di * CELL;
      const c = this.#cell(px, py);
      if (!c) continue;
      const [t, cell] = c;
      // (how far the spot is from the cell itself: nothing where it is in it)
      const cx = t.xN - (((cell / N) | 0) + 0.5) * CELL, cy = t.yW - ((cell % N) + 0.5) * CELL;
      const d = Math.hypot(Math.max(0, Math.abs(x - cx) - CELL / 2), Math.max(0, Math.abs(y - cy) - CELL / 2));
      if (d > reach) continue;
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
        if (t.flags[k] & F_STEEP || t.z[k] < lo || t.z[k] > hi) continue;
        out.push({ ...spot(t, cell, k), d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** The floor you step on to going one cell east / west / south / north (d = 0..3) from a floor - or null: that way is shut. */
  hop(f, d) {
    const t = f.t, n = f.n;
    if (!(t.flags[n] & OPEN[d])) return null;
    let ni = (f.cell % N) + DX[d], nj = ((f.cell / N) | 0) + DY[d], tt = t, border = false;
    if (ni < 0 || ni >= N || nj < 0 || nj >= N) {
      tt = this.tile(t.col + (ni < 0 ? -1 : ni >= N ? 1 : 0), t.row + (nj < 0 ? -1 : nj >= N ? 1 : 0));
      if (!tt) return null;
      ni = (ni + N) % N; nj = (nj + N) % N; border = true;
    }
    const nc = nj * N + ni, z = t.z[n];
    if (t.links && !border) { const k = t.offs[nc] + ((t.links[n] >> (d * 4)) & 15) - 1; return k >= t.offs[nc] && k < t.offs[nc + 1] ? spot(t, nc, k) : null; }
    let best = -1;
    if (t.links && tt.links) { for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e; k++) { const dz = tt.z[k] - z; if (dz <= UP && dz >= -DOWN && tt.flags[k] & BACK[d]) best = k; } }
    else { for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e; k++) { const dz = tt.z[k] - z; if (dz <= UP && dz >= -DOWN && !(tt.flags[k] & F_STEEP)) best = k; } if (best >= 0 && border && !(tt.flags[best] & BACK[d])) best = -1; }
    return best >= 0 ? spot(tt, nc, best) : null;
  }

  /** Where you come down going one cell that way off a floor that leads on to none there (an edge, steep ground) - or null. */
  fall(f, d) {
    const t = f.t, n = f.n;
    if (!t.links) return null;
    const v = (t.links[n] >> (d * 4)) & 15;
    if (!v) return null;
    const ni = (f.cell % N) + DX[d], nj = ((f.cell / N) | 0) + DY[d];
    if (v !== LINK_EDGE) {
      if (t.flags[n] & OPEN[d]) return null; // (it leads on to a floor: that is a step - hop)
      const nc = nj * N + ni, k = t.offs[nc] + v - 1;
      return k < t.offs[nc + 1] ? spot(t, nc, k) : null;
    }
    const tt = this.tile(t.col + (ni < 0 ? -1 : ni >= N ? 1 : 0), t.row + (nj < 0 ? -1 : nj >= N ? 1 : 0));
    if (!tt || !tt.edge) return null;
    const mi = (ni + N) % N, mj = (nj + N) % N, nc = mj * N + mi, b = d ^ 1;
    const z = t.z[n], top = z - (t.flags[n] & F_STEEP ? SLIDE_ON : 0), room = tt.edgeAt[b * N + (b < 2 ? mj : mi)];
    let best = -1, rank = -Infinity;
    for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e && tt.z[k] <= top; k++) {
      if (tt.edge[room + k] < (z - tt.z[k] + HEAD) * 8) continue;
      const r = tt.z[k] + (tt.flags[k] & F_STEEP ? 0 : 1e6);
      if (r > rank) { rank = r; best = k; }
    }
    return best >= 0 ? spot(tt, nc, best) : null;
  }

  /** The lift a floor is a landing of (it is within the lift's reach, at the height of one of its stops) - or null. */
  #lift(f) {
    for (const L of this.lifts) {
      if (Math.hypot(f.x - L.x, f.y - L.y) > (L.r ?? 7) + 9) continue;
      const stops = Array.isArray(L.stops) && L.stops.length >= 2 ? L.stops : [L.lo, L.hi];
      if (stops.some((s) => Math.abs(f.z - s) <= 3.5)) return { L, stops };
    }
    return null;
  }

  /**
   * How far it is on foot from some floors to everything within so many yards of them.
   * @param seeds   [{ t, cell, n, g (yards already gone; 0 where left out) }]
   * @param budget  yards: nothing further than this is looked at
   * @param most    floors looked at, at the most (a guard: the answer is then short of the whole truth, and says so)
   * @returns a Spread: has(floor), far(floor) - yards, or Infinity -, and floors(x, y, reach): the floors reached near a spot
   */
  spread(seeds, budget, most = 60000) {
    const g = new Map(), heap = new Heap(), at = new Map();
    for (const s of seeds) { const k = this.key(s), v = s.g ?? 0; if (v <= budget && !(g.get(k) <= v)) { g.set(k, v); at.set(k, s); heap.push(v, k); } }
    const done = new Set();
    let cut = false;
    while (heap.size) {
      const [d0, k0] = heap.pop();
      if (done.has(k0) || d0 > g.get(k0)) continue;
      done.add(k0);
      if (done.size > most) { cut = true; break; }
      const f = at.get(k0);
      const step = (to, cost) => {
        if (!to) return;
        const k = this.key(to), v = d0 + cost;
        if (v > budget || g.get(k) <= v) return;
        g.set(k, v); at.set(k, to); heap.push(v, k);
      };
      const nb = [null, null, null, null];
      for (let d = 0; d < 4; d++) {
        nb[d] = this.hop(f, d);
        if (nb[d]) step(nb[d], CELL);
        else { const low = this.fall(f, d); if (low && f.z - low.z <= FALL_MOST) step(low, CELL); } // (a drop: the way across is what counts, the way down takes no walking)
      }
      // cornerwise: where both ways round the corner come to the same floor
      for (let d = 4; d < 8; d++) {
        const a = nb[DX[d] > 0 ? 0 : 1], b = nb[DY[d] > 0 ? 2 : 3];
        if (!a || !b) continue;
        const k1 = this.hop(a, DY[d] > 0 ? 2 : 3), k2 = this.hop(b, DX[d] > 0 ? 0 : 1);
        if (k1 && k2 && k1.t === k2.t && k1.n === k2.n) step(k1, DIAG);
      }
      // a lift: from the floor at one of its stops to the floors at the others, with nothing walked
      const lift = this.#lift(f);
      if (lift) for (const s of lift.stops) {
        if (Math.abs(s - f.z) <= 3.5) continue;
        for (const o of this.floorsNear(lift.L.x, lift.L.y, (lift.L.r ?? 7) + 9, s - 3.5, s + 3.5)) step(o, 0);
      }
    }
    return new Spread(this, g, at, cut);
  }
}

export class Spread {
  constructor(ground, g, at, cut) { this.ground = ground; this.g = g; this.at = at; this.cut = cut; }
  get size() { return this.g.size; }
  /** The heights of the floors reached: [lowest, highest] - or null where the look was cut short (they are then not all of them), or reached nothing. */
  get span() {
    if (this.cut) return null;
    if (this.zs === undefined) {
      let lo = Infinity, hi = -Infinity;
      for (const f of this.at.values()) { if (f.z < lo) lo = f.z; if (f.z > hi) hi = f.z; }
      this.zs = lo <= hi ? [lo, hi] : null;
    }
    return this.zs;
  }
  has(f) { return this.g.has(this.ground.key(f)); }
  far(f) { return this.g.get(this.ground.key(f)) ?? Infinity; }
  /** The floors reached within so many yards of a spot: [{ ...floor, d (yards from the spot), g (yards on foot to it) }], the least way first. */
  floors(x, y, reach = 1.5, lo = -Infinity, hi = Infinity) {
    const out = [];
    for (const f of this.ground.floorsNear(x, y, reach, lo, hi)) { const v = this.g.get(this.ground.key(f)); if (v !== undefined) out.push({ ...f, g: v }); }
    return out.sort((a, b) => a.g + a.d - (b.g + b.d));
  }
}

/** The ground of one map, read from the map data on the disk (fs, path: node's own; handed in so that this file needs neither). */
export function groundOf(fs, path, dataDir, map, lifts = []) {
  const dir = path.join(dataDir, 'maps', String(map), 'nav');
  return new Ground({ read: (col, row) => { const f = path.join(dir, `${col}_${row}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; }, lifts });
}
