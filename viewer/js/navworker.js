// Route search over the map's navigation data (maps/<id>/nav/<col>_<row>.bin, one grid of
// "floors" per tile: the places a character can stand, about a yard apart; see
// extractor/jobs/nav.js). Runs in a worker so a long search never stalls the map.
//
// Each floor records which of its four neighbouring cells it leads on to (worked out at half-yard
// precision when the data is built, so thin walls separate and narrow doorways connect), and
// which floor there: the one within a step up, or a short drop down. The cost of a move is the
// time it takes: distance over your run speed, or your swim speed on water.
//
// The game also lets you go where you cannot walk back: off a ledge, down a bank too steep to
// stand on. The data has those too - what lies under each edge, and the steep ground itself,
// which leads only downhill - and a route takes them where the fall is one you walk away from
// (see FALL_MOST): you land where you land, and a long way round is not the only way down.
//
// And it has lifts (world.json: lifts, handed over with each question): from the floor a lift
// stops at to the floor at any other of its stops is a move like any other, that costs the wait
// for the lift and the ride. Up Thunder Bluff, down into the Undercity and into Gnomeregan
// there is no other way.
import { FELL, LIFTED, FALL_SPEED, fallCost as hurt } from './falls.js';

const TILE = 1600 / 3, N = 512, CELL = TILE / N;
const UP = 1.375;        // yards you can step up from one cell to the next (a 50 degree slope, a kerb): as extractor/jobs/nav.js has it
const UP_OLD = 1.3;      // ...as it was in the data built before links were kept (see hop)
const DOWN = 3;          // yards you will drop from one cell to the next and call it walking
const F_SWIM = 1, F_LAVA = 2, F_TERRAIN = 4, F_STEEP = 8;
const OPEN = [16, 32, 64, 128];     // floor flag: open toward east, west, south, north (as DX / DY below)
const BACK = [32, 16, 128, 64];     // the same edge seen from the other cell
const LINK_EDGE = 15;    // a link that says: open on this side, and the next cell is on the next tile
const LAVA_COST = 60;
// Falls. The game takes nothing for a fall of up to about 14.5 yards and, beyond that, about
// 1.8% of your full health a yard (falls.js: hurt): 69 yards kills from full health. A route
// never asks for more than FALL_MOST, which costs a little over half of it, nor for several
// falls that cost more than that between them (HURT_MOST) -
// the map is not told how much health you have just now, and its heights are good to a yard or
// so - and a fall that hurts counts as that much longer a way, so that a safe way round that
// is nearly as quick is the one shown. Into water deep enough to swim in there is no harm at all.
// Sliding down ground too steep to stand on is falling, to the game: what counts is the height
// from where you left your feet to where you get them back.
const FALL_MOST = 45;    // yards: no route has you fall further than this
const HURT_MOST = 57;    // hundredths of your full health: all the falls of a route together cost no more than this (what one fall of FALL_MOST does)
const FALL_HURT = 60;    // seconds a fall counts for, per whole health bar it takes (what it costs to get that health back)
const SLIDE_ON = 0.5;    // yards lower the steep ground on the next tile has to be for a slide to go on to it
const HEAD = 1.7;        // yards of free space a character needs over their feet (as extractor/jobs/nav.js has it)
const OPEN_SKY = 65535;  // the room over a surface at a tile's edge, where nothing at all is over it
const PACK_BITS = 22, PACK = 1 << PACK_BITS, PACK_MASK = PACK - 1; // a surface is named by its tile's slot and its number in the tile, in one number
// How hard the search leans toward the goal: 1 would be strictly the shortest way, and slow to
// find. Close by it stays near that; over a long distance it leans harder, giving up a little
// length for a search that stays in a corridor instead of flooding half a continent.
const weightFor = (yards) => (yards < 700 ? 1.12 : yards < 1800 ? 1.4 : 1.9);
const MAX_EXPANDED = 2000000; // (a real way, even a long one, is found within a fraction of this)
// The longer a search goes on, the harder it leans toward the goal: a way that is hard to find (round
// a mountain range, through one gap in a wall) would otherwise be found only after every other way,
// however far, had been tried (seconds of work, each time the route is refreshed). The lean doubles
// after this many floors, trebles after twice as many, and so on.
const HURRY = 150000;
const MAX_TILES = 64;
const SNAP = 14;         // cells: how far from the asked position a place to stand is looked for
const DOCK_LEVEL = 12;   // yards above or below a boat's or zeppelin's stop that its landing can be
const COVERED = 75;      // seconds: how much quicker buried ground must be before it is taken for the floor built over it
const SPARE = 900;       // seconds: how much quicker another floor at the spot must be before it is taken for the one at the height asked for
const SEED_OVER = 4;     // yards: a walk begins on no floor further than this above the height you are at
const EXTRA = 400000;    // floors looked at, at most, for the floor over buried ground once the ground has been reached
const WIDE = 5;          // cells: something built over the ground this far to each side is a street or a hall, not an awning
// "Which levels are there at this spot?" (a waypoint is a spot on a map: under it there can be a
// street, the floor above it, a cellar)
const LEVEL_NEAR = 2.2;  // yards around the spot whose floors count as being at it
const LEVEL_GAP = 2.5;   // yards between two floors, one above the other, for them to be two levels
const LEVEL_EXTRA = 500000; // floors looked at, at most, for further levels once the first has been reached...
const LEVEL_MS = 1500;   // ...and for no longer than this
const LEVEL_FIRST_MS = 3000; // how long to look at all, with nothing found yet
const LEVEL_WIDE = 45;   // yards: with no level at the spot that can be walked to (it is on a roof, in a wall), the nearest place within this far that can
const NEAR_EXTRA = 150000; // floors looked at, at most, for a place nearer still
const SUNK_REACH = 24;   // cells: ground with built floors well above it this near, most of the way round, is buried ground...
const SUNK_UP = 3;       // ...yards above it
const SUNK_SIDES = 6;    // ...in this many of the eight directions
const STUCK = 40000;     // floors: a search that ran out this soon never left the ledge it began on
// Where the way found has another level over or under it (see findRoute)
const STACKED = 16;      // kind bit of a point: another level lies over or under this place
const FELL_SHOWN = 6;    // yards a fall has to be, from the floor left to the floor landed on, for its points to be marked so
const STACK_REACH = 7;   // cells to each side that are looked at
const STACK_GAP = 2.5;   // yards above or below that make another level
const STACK_ISLAND = 600; // floors: a surface with fewer than this to walk about on is not a level (a roof, an awning, a tree top)
const STACK_ROUND = 8;   // yards (and 2.5 times as far as they are apart) of route between two places for one to be over the other, not up a stair from it
const STACK_MS = 250;    // no longer than this is spent on it
// Lifts. The floor a lift stops at is the building's (or the ground's): the nearest floors to the
// lift's middle at the height it stops at, and a few yards on from those - round a shaft, the
// rim of its opening.
const LIFT_LAND = 14;    // yards from a lift's middle within which the floor it stops at is looked for
const LIFT_BAND = 4;     // ...and how much further out than the nearest such floor its landing goes on
const LIFT_NEAR = 3.5;   // yards from the height a lift stops at within which a floor is its landing (as height.js has it)
const LIFT_STEP = 2;     // seconds to step on to a lift and off it
const LIFT_SPEED = 12;   // yards a second a lift goes, and...
const LIFT_STILL = 5;    // ...seconds it stands at a stop, where the map's data does not say (built before it did)
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];

let ctx = { map: -1, rev: '', have: new Set(), lifts: [] }; // the map the search in hand is on
const maps = new Map();  // map id -> { map, rev, have, lifts } as last described by the page

/** The heights a lift stops at, lowest first. */
const stopsOf = (L) => (Array.isArray(L.stops) && L.stops.length >= 2 ? L.stops : [L.lo, L.hi]);
/**
 * Seconds a lift takes you from one of its stops to another: the wait for it - half its round,
 * arriving at any moment of it -, the ride, and getting on and off.
 */
function liftSeconds(L, a, b) {
  const stops = stopsOf(L), far = Math.abs(stops[b] - stops[a]);
  const speed = L.speed > 0 ? L.speed : LIFT_SPEED, still = L.still > 0 ? L.still : LIFT_STILL;
  const round = L.round > 0 ? L.round : 2 * (stops.length - 1) * ((stops[stops.length - 1] - stops[0]) / (stops.length - 1) / speed + still);
  return round / 2 + far / speed + (Math.abs(b - a) - 1) * still + LIFT_STEP;
}
const tiles = new Map(); // "map/rev/col_row" -> tile | null, most recently used last

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadTile(col, row) {
  // (kept by the revision of the map's data too: after the map has been built again, a tile of the old build is not one of the new)
  const name = `${col}_${row}`, key = `${ctx.map}/${ctx.rev}/${name}`;
  if (tiles.has(key)) { const t = tiles.get(key); tiles.delete(key); tiles.set(key, t); return t; }
  let tile = null;
  if (ctx.have.has(name)) {
    try {
      const res = await fetch(`/data/maps/${ctx.map}/nav/${name}.bin?v=${ctx.rev}`);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const dv = new DataView(buf);
        const sections = new Map();
        for (let i = 0, n = dv.getUint32(8, true); i < n; i++) sections.set(dv.getUint32(12 + i * 12, true), new Uint8Array(buf, dv.getUint32(16 + i * 12, true), dv.getUint32(20 + i * 12, true)));
        // (links: which surface each one leads on to, each way. Data built before they were kept has none: see hop)
        const [counts, zb, flags, lb, eb] = await Promise.all([inflate(sections.get(2)), inflate(sections.get(3)), inflate(sections.get(4)), sections.has(5) ? inflate(sections.get(5)) : null, sections.has(6) ? inflate(sections.get(6)) : null]);
        const q = new Uint16Array(zb.buffer, zb.byteOffset, zb.byteLength >> 1);
        const z = new Float32Array(q.length);
        for (let i = 0, acc = 0; i < q.length; i++) { acc = (acc + q[i]) & 0xffff; z[i] = acc / 8 - 2048; } // stored as differences
        const offs = new Uint32Array(N * N + 1);
        for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
        const links = lb && lb.byteLength >> 1 === z.length ? new Uint16Array(lb.buffer, lb.byteOffset, z.length) : null;
        // (edge: along the tile's four edges, the room over each surface on that side - see fall; edgeAt: where each edge cell's surfaces begin in it)
        let edge = null;
        const edgeAt = new Int32Array(4 * N);
        if (links && eb) {
          let at = 0;
          for (let d = 0; d < 4; d++) for (let a = 0; a < N; a++) {
            const cell = (d === 2 ? N - 1 : d === 3 ? 0 : a) * N + (d === 0 ? N - 1 : d === 1 ? 0 : a);
            edgeAt[d * N + a] = at - offs[cell]; // (so that a surface's own number in the tile can be added)
            at += offs[cell + 1] - offs[cell];
          }
          if (eb.byteLength >> 1 === at) edge = new Uint16Array(eb.buffer, eb.byteOffset, at);
        }
        tile = { col, row, xN: (32 - row) * TILE, yW: (32 - col) * TILE, offs, z, flags, links, edge, edgeAt, nodes: z.length };
      }
    } catch { /* treated as a tile with nowhere to stand */ }
  }
  tiles.set(key, tile);
  while (tiles.size > 40) tiles.delete(tiles.keys().next().value); // (about 2 MB each)
  return tile;
}

// ---- min-heap of (priority, node, cell) ----
class Heap {
  constructor() { this.n = 0; this.cap = 1 << 16; this.key = new Float32Array(this.cap); this.id = new Int32Array(this.cap); this.cell = new Int32Array(this.cap); }
  push(key, id, cell) {
    if (this.n === this.cap) {
      this.cap *= 2;
      const g = (a, T) => { const b = new T(this.cap); b.set(a); return b; };
      this.key = g(this.key, Float32Array); this.id = g(this.id, Int32Array); this.cell = g(this.cell, Int32Array);
    }
    let i = this.n++;
    const K = this.key, I = this.id, C = this.cell;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; I[i] = I[p]; C[i] = C[p]; i = p;
    }
    K[i] = key; I[i] = id; C[i] = cell;
  }
  pop() { // -> index 0 holds the minimum before the call; read it first
    const K = this.key, I = this.id, C = this.cell;
    const n = --this.n;
    const key = K[n], id = I[n], cell = C[n];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= n) break;
      if (c + 1 < n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c]; I[i] = I[c]; C[i] = C[c]; i = c;
    }
    K[i] = key; I[i] = id; C[i] = cell;
  }
}

/**
 * @param req { from: [x, y, z|null], to: [x, y, z|null], run, swim }
 * @returns { ok, reason?, points: Float32Array (x, y, z per point), kinds: Uint8Array (per point:
 *            1 swim, 2 come to by a fall (FELL), 16 another level lies over or under it, 64 come to on a lift (LIFTED)),
 *            length (yards: what there is to walk and swim - a lift's ride is not in it), seconds, expanded,
 *            fall (yards: the furthest fall on the way), hurt (the part of your full health the falls on the way cost),
 *            rides: [{ at (the number of the point come to on a lift), seconds (the wait and the ride), from, to (heights), name }] }
 */
async function findRoute(req) {
  const began = performance.now();
  const run = req.run > 0 ? req.run : 7, swim = req.swim > 0 ? req.swim : run * 0.67;
  const slots = [], slotOf = new Map(), state = [];
  // (the lifts that may have a landing on each tile in hand, or null: most tiles have none, and no floor of theirs is asked about)
  const lifts = req.noLifts ? [] : ctx.lifts ?? [], slotLifts = [];
  const getSlot = async (col, row) => {
    const key = col * 128 + row;
    let s = slotOf.get(key);
    if (s !== undefined) return s;
    const t = slots.length < MAX_TILES ? await loadTile(col, row) : null;
    if (!t || t.nodes >= PACK) { slotOf.set(key, -1); return -1; }
    s = slots.length;
    slots.push(t);
    // (closed: 1 once a surface has been looked at; the rest of the byte, the health the falls of the way there have cost, in hundredths of a full bar)
    state.push({ g: new Float32Array(t.nodes).fill(Infinity), parent: new Int32Array(t.nodes).fill(-1), closed: new Uint8Array(t.nodes) });
    let near = null;
    for (const L of lifts) if (L.x >= t.xN - TILE - LIFT_LAND && L.x <= t.xN + LIFT_LAND && L.y >= t.yW - TILE - LIFT_LAND && L.y <= t.yW + LIFT_LAND) (near ??= []).push(L);
    slotLifts.push(near);
    slotOf.set(key, s);
    return s;
  };
  // The places to stand near a position, nearest first: [{ slot, cell, node, d }]. With a known
  // height the floor at that height comes first; without one, every floor of a cell counts alike.
  const snap = async (p, land) => {
    const out = [], reach = land ? SNAP * 3 : SNAP;
    for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
      const x = p[0] - dj * CELL, y = p[1] - di * CELL;
      const s = await getSlot(Math.floor(32 - y / TILE), Math.floor(32 - x / TILE));
      if (s < 0) continue;
      const t = slots[s];
      const i = Math.min(N - 1, Math.max(0, Math.floor((t.yW - y) / CELL))), j = Math.min(N - 1, Math.max(0, Math.floor((t.xN - x) / CELL)));
      const cell = j * N + i;
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
        if (t.flags[k] & F_STEEP) continue;        // nowhere to stand
        if (land && t.flags[k] & F_SWIM) continue; // a boat's stop is out on the water: the pier beside it
        const dz = p[2] === null || p[2] === undefined ? 0 : land ? Math.max(0, Math.abs(t.z[k] - p[2]) - DOCK_LEVEL) * 2 : Math.abs(t.z[k] - p[2]) * 2;
        out.push({ slot: s, cell, node: k, d: Math.hypot(di * CELL, dj * CELL) + dz });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  };
  // The floor you step on to going one cell east / west / south / north (d = 0..3) from a floor:
  // its index in the tile it is in (hopSlot, hopCell say where), -1 if that way is closed, or -2
  // if the tile over there has not been loaded yet (hopCol, hopRow say which).
  let hopSlot = 0, hopCell = 0, hopCol = 0, hopRow = 0;
  const hop = (s, cell, n, d) => {
    const t = slots[s];
    if (!(t.flags[n] & OPEN[d])) return -1;
    let ni = (cell % N) + DX[d], nj = ((cell / N) | 0) + DY[d], ts = s, tt = t, border = false;
    if (ni < 0 || ni >= N || nj < 0 || nj >= N) {
      hopCol = t.col + (ni < 0 ? -1 : ni >= N ? 1 : 0); hopRow = t.row + (nj < 0 ? -1 : nj >= N ? 1 : 0);
      ts = slotOf.get(hopCol * 128 + hopRow);
      if (ts === undefined) return -2;
      if (ts < 0) return -1;
      tt = slots[ts]; ni = (ni + N) % N; nj = (nj + N) % N; border = true;
    }
    const nc = nj * N + ni, z = t.z[n];
    hopSlot = ts; hopCell = nc;
    // (the data says which floor: the highest within a step that this one touches)
    if (t.links && !border) return t.offs[nc] + ((t.links[n] >> (d * 4)) & 15) - 1;
    let best = -1;
    if (t.links && tt.links) {
      // across a tile edge each side only knows its own half of the way through: the highest floor within a step that is open on its side
      for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e; k++) { const dz = tt.z[k] - z; if (dz <= UP && dz >= -DOWN && tt.flags[k] & BACK[d]) best = k; }
      return best;
    }
    // Data built before links were kept: the highest floor within a step, as the builder of that data took it.
    for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e; k++) { const dz = tt.z[k] - z; if (dz <= UP_OLD && dz >= -DOWN && !(tt.flags[k] & F_STEEP)) best = k; }
    if (best >= 0 && border && !(tt.flags[best] & BACK[d])) return -1;
    return best;
  };
  // Where you come down going one cell that way off a surface that leads on to no floor there:
  // off the edge of a floor, or on down steep ground - its index (hopSlot, hopCell say where),
  // -1 if there is no going that way, -2 if the tile over there has not been loaded yet.
  // One way only: there is no coming back up.
  const fall = (s, cell, n, d) => {
    const t = slots[s];
    if (!t.links) return -1;
    const v = (t.links[n] >> (d * 4)) & 15;
    if (!v) return -1;
    const ni = (cell % N) + DX[d], nj = ((cell / N) | 0) + DY[d];
    if (v !== LINK_EDGE) {
      if (t.flags[n] & OPEN[d]) return -1; // (it leads on to a floor: that is walking - hop)
      hopSlot = s; hopCell = nj * N + ni;
      return t.offs[hopCell] + v - 1;
    }
    // Across a tile edge: the first surface under you over there - no higher than this one (steep
    // ground only leads on to what is lower still), and with nothing solid between it and your
    // head as you come in: that tile says how much room there is over each of its surfaces on
    // this side. A floor to land on before steep ground to slide on down; of two alike, the higher.
    hopCol = t.col + (ni < 0 ? -1 : ni >= N ? 1 : 0); hopRow = t.row + (nj < 0 ? -1 : nj >= N ? 1 : 0);
    const ts = slotOf.get(hopCol * 128 + hopRow);
    if (ts === undefined) return -2;
    if (ts < 0) return -1;
    const tt = slots[ts];
    if (!tt.edge) return -1;
    const mi = (ni + N) % N, mj = (nj + N) % N, nc = mj * N + mi, b = d ^ 1;
    const z = t.z[n], top = z - (t.flags[n] & F_STEEP ? SLIDE_ON : 0), room = tt.edgeAt[b * N + (b < 2 ? mj : mi)];
    let best = -1, rank = -Infinity;
    for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e && tt.z[k] <= top; k++) {
      if (tt.edge[room + k] < (z - tt.z[k] + HEAD) * 8) continue;
      // (and not on to ground with something built over it: as the builder has it, within a tile)
      if ((tt.flags[k] & (F_TERRAIN | F_STEEP)) === F_TERRAIN && tt.edge[room + k] !== OPEN_SKY) continue;
      const r = tt.z[k] + (tt.flags[k] & F_STEEP ? 0 : 1e6);
      if (r > rank) { rank = r; best = k; }
    }
    hopSlot = ts; hopCell = nc;
    return best;
  };
  // The same, but only where you could also step back the way you came: not a drop off a ledge.
  // The levels of a spot are looked for along such steps alone. A place that can only be dropped
  // into and never walked out of (the ground the game leaves buried under a town, entered where a
  // cliff at the town's edge can be climbed down) is not somewhere to send anyone.
  const hopBack = (s, cell, n, d) => {
    const k = hop(s, cell, n, d);
    if (k < 0) return k;
    const ts = hopSlot, tc = hopCell;
    const back = hop(ts, tc, k, d ^ 1) === n && hopSlot === s;
    hopSlot = ts; hopCell = tc;
    return back ? k : -1;
  };
  const strict = !!req.levels && !req.drops;
  const step = strict ? hopBack : hop;
  // Falls are for a way somewhere, not for saying which levels a spot has (those are walked to, and back from).
  const falls = !req.levels && !req.noFalls;
  // True if a floor is shut in: everything you can get to from it is a small pocket (the ground
  // under a building's floor, the inside of a rock) that the other end is not in.
  // `leaving`: for where a way begins - a ledge you can drop off is not shut in, though no step leads off it.
  const pocketIn = new Set(), pocketLeft = new Set(); // floors already found to be shut in
  const enclosed = async (c, other, leaving = false) => {
    const pocket = leaving && falls ? pocketLeft : pocketIn;
    if (pocket.has(c.slot * PACK + c.node)) return true;
    const seen = new Set([c.slot * PACK + c.node]), queue = [[c.slot, c.cell, c.node]];
    for (let q = 0; q < queue.length; q++) {
      if (queue.length > 2500) return false;
      const [s, cell, n] = queue[q];
      if (s === other.slot && n === other.node) return false;
      const lifts = slotLifts[s] ? liftsBy(s, cell, n) : null;
      if (lifts && (await liftAt(lifts, s * PACK + n))) return false; // (a lift stops here: it leads on)
      for (let d = 0; d < 4; d++) {
        let k = hop(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hop(s, cell, n, d); }
        if (k < 0 && leaving && falls) {
          k = fall(s, cell, n, d);
          if (k === -2) { await getSlot(hopCol, hopRow); k = fall(s, cell, n, d); }
        }
        if (k < 0) continue;
        const id = hopSlot * PACK + k;
        if (!seen.has(id)) { seen.add(id); queue.push([hopSlot, hopCell, k]); }
      }
    }
    for (const id of seen) pocket.add(id);
    return true;
  };
  // True for ground with something wide built over it: the earth under a city's streets or a
  // great hall's floor. The game leaves that ground in place and it can join up with open land
  // somewhere, but it is not where anyone stands; an awning or a branch overhead does not count.
  const built = (t, cell, z) => {
    for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) if (!(t.flags[k] & (F_TERRAIN | F_SWIM | F_STEEP)) && t.z[k] > z + 1.5) return true;
    return false;
  };
  const covered = (c) => {
    const t = slots[c.slot];
    if (!(t.flags[c.node] & F_TERRAIN) || !built(t, c.cell, t.z[c.node])) return false;
    const i = c.cell % N, j = (c.cell / N) | 0;
    let sides = 0;
    for (const [di, dj] of [[WIDE, 0], [-WIDE, 0], [0, WIDE], [0, -WIDE]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || ni >= N || nj < 0 || nj >= N || built(t, nj * N + ni, t.z[c.node])) sides++;
    }
    return sides >= 3;
  };
  const pos = (s, cell) => { const t = slots[s]; return [t.xN - (Math.floor(cell / N) + 0.5) * CELL, t.yW - ((cell % N) + 0.5) * CELL]; };
  // ---- lifts ----
  // Where a lift lets you on and off: for each of its stops, the floors at that height nearest
  // its middle - [{ floors: [{ slot, cell, node, d (yards from the middle) }], ids }], a stop
  // with no floor by it having none. (Looked for once in a search, when the search first comes by.)
  const landings = new Map();
  const landingsOf = async (L) => {
    let out = landings.get(L);
    if (out) return out;
    const stops = stopsOf(L), reach = Math.ceil(LIFT_LAND / CELL);
    out = stops.map(() => ({ floors: [], ids: new Set() }));
    for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
      const d = Math.hypot(di * CELL, dj * CELL);
      if (d > LIFT_LAND) continue;
      const x = L.x - dj * CELL, y = L.y - di * CELL;
      const s = await getSlot(Math.floor(32 - y / TILE), Math.floor(32 - x / TILE));
      if (s < 0) continue;
      const t = slots[s];
      const cell = Math.min(N - 1, Math.max(0, Math.floor((t.xN - x) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((t.yW - y) / CELL)));
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
        if (t.flags[k] & (F_STEEP | F_SWIM | F_LAVA)) continue;
        const q = stops.findIndex((z) => Math.abs(t.z[k] - z) <= LIFT_NEAR);
        if (q >= 0) out[q].floors.push({ slot: s, cell, node: k, d });
      }
    }
    for (const stop of out) {
      const nearest = stop.floors.reduce((m, f) => Math.min(m, f.d), Infinity);
      stop.floors = stop.floors.filter((f) => f.d <= nearest + LIFT_BAND);
      for (const f of stop.floors) stop.ids.add(f.slot * PACK + f.node);
    }
    landings.set(L, out);
    return out;
  };
  // The lifts a floor is within reach of, at a height they pass: [[lift, yards from its middle], ...]
  // or null. (Asked of every floor looked at on a tile with a lift: nothing here waits.)
  const liftsBy = (s, cell, n) => {
    const near = slotLifts[s];
    if (!near) return null;
    const t = slots[s], z = t.z[n], x = t.xN - (((cell / N) | 0) + 0.5) * CELL, y = t.yW - ((cell % N) + 0.5) * CELL;
    let out = null;
    for (const L of near) {
      if (z < L.lo - LIFT_NEAR || z > L.hi + LIFT_NEAR) continue;
      const d = Math.hypot(x - L.x, y - L.y);
      if (d <= LIFT_LAND) (out ??= []).push([L, d]);
    }
    return out;
  };
  // The lift a floor is a landing of, where that lift has another stop to take you to:
  // { L, land (landingsOf), q (which of its stops this is), d (yards from its middle) } or null.
  // @param by  what liftsBy said of the floor
  const liftAt = async (by, id) => {
    for (const [L, d] of by) {
      const land = await landingsOf(L);
      const q = land.findIndex((stop) => stop.ids.has(id));
      if (q >= 0 && land.some((stop, r) => r !== q && stop.floors.length)) return { L, land, q, d };
    }
    return null;
  };
  // True for ground lying in a pit of built floors: the earth under a town, which the game leaves
  // in place below the streets. (covered() above asks for a floor right over the spot; this also
  // knows the ground under a roof or inside a wall, where nothing walkable is overhead.)
  const sunkMemo = new Map();
  const sunk = async (slot, cell, node) => {
    const id = slot * PACK + node;
    if (sunkMemo.has(id)) return sunkMemo.get(id);
    const t = slots[slot];
    let out = false;
    if (t.flags[node] & F_TERRAIN) {
      const h = t.z[node] + SUNK_UP, [x, y] = pos(slot, cell);
      let sides = 0;
      for (let d = 0; d < 8 && sides + (8 - d) >= SUNK_SIDES; d++) {
        let over = false;
        for (let k = 1; k <= SUNK_REACH && !over; k++) {
          const wx = x + DX[d] * k * CELL, wy = y + DY[d] * k * CELL;
          const s2 = await getSlot(Math.floor(32 - wy / TILE), Math.floor(32 - wx / TILE));
          if (s2 < 0) continue;
          const t2 = slots[s2];
          const c2 = Math.min(N - 1, Math.max(0, Math.floor((t2.xN - wx) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((t2.yW - wy) / CELL)));
          for (let q = t2.offs[c2]; q < t2.offs[c2 + 1]; q++) if (!(t2.flags[q] & (F_TERRAIN | F_SWIM | F_STEEP)) && t2.z[q] > h) { over = true; break; }
        }
        if (over) sides++;
      }
      out = sides >= SUNK_SIDES;
    }
    sunkMemo.set(id, out);
    return out;
  };
  const starts = await snap(req.from, req.landFrom), ends = await snap(req.to, req.landTo);
  if (!starts.length) return { ok: false, reason: 'no walkable ground where you are' };
  if (!ends.length && !req.levels) return { ok: false, reason: 'no walkable ground at the destination' };
  let start = starts[0];
  // Asked which levels there are at the spot: every floor close by it, sorted into levels (floors
  // within a short step of each other in height are one level: a slope, a stair passing by).
  // The search below then goes on until it has reached each of them, or has looked far enough to
  // say that the rest cannot be walked to.
  // Buried ground is not a level while there is a real one; and where no level at the spot can
  // be walked to at all, the answer is the nearest place to it that can (nearBest).
  let levels = null, levelOf = null, realCount = 0, realLeft = 0, firstRealAt = -1, nearBest = null, nearAt = 0;
  if (req.levels) {
    const first = ends.length ? ends[0].d : Infinity;
    const reach = first <= LEVEL_NEAR ? LEVEL_NEAR : first + 1.6;
    const near = ends.filter((c) => c.d <= reach).map((c) => ({ ...c, z: slots[c.slot].z[c.node] })).sort((a, b) => a.z - b.z);
    const groups = [];
    for (const c of near) {
      const top = groups[groups.length - 1];
      if (top && c.z - top.hi <= LEVEL_GAP) { top.members.push(c); top.hi = c.z; }
      else groups.push({ members: [c], hi: c.z, reached: null });
    }
    levels = [];
    levelOf = new Map();
    for (const g of groups) {
      // (a level that is nothing but a shut-in pocket - the earth under a floor - is not one)
      g.members.sort((a, b) => a.d - b.d);
      let open = false;
      for (const c of g.members.slice(0, 12)) if (!(await enclosed(c, start))) { open = true; break; }
      if (!open) continue;
      g.sunk = covered(g.members[0]) || (await sunk(g.members[0].slot, g.members[0].cell, g.members[0].node));
      if (!g.sunk) realCount++;
      for (const c of g.members) levelOf.set(c.slot * PACK + c.node, levels.length);
      levels.push(g);
    }
    realLeft = realCount;
  }
  // Where exactly to end: the destination is a spot on the map, often with no height. Any floor
  // there will do (the search stops at whichever it reaches first, which is the one at ground
  // level if there is a choice), except the shut-in ones nobody can get to.
  const goals = [];
  if (levels) for (const g of levels) goals.push(...g.members);
  else for (const c of ends.slice(0, 400)) {
    if (goals.length && c.d > goals[0].d + 1.6) break;
    if (!(await enclosed(c, start))) goals.push(c);
  }
  // With a height asked for, the floors at the spot itself count too, as a second choice: what
  // is at that height may be nowhere anyone can walk onto (the rim of a well a quest has you use
  // stands a few yards over the ground around it), and then the way there is the way to its foot.
  // It used to be no way at all: the search looked at two million floors for the rim and gave up,
  // "too far to work out on foot", three hundred yards from it.
  const spare = [];
  if (!levels && req.to[2] !== null && req.to[2] !== undefined) {
    // (the nearest place of each level there: one is enough to tell whether that level leads anywhere)
    const taken = goals.map((c) => slots[c.slot].z[c.node]);
    const near = ends.slice(0, 400).map((c) => { const [x, y] = pos(c.slot, c.cell); return { c, off: Math.hypot(x - req.to[0], y - req.to[1]) }; })
      .filter((e) => e.off <= LEVEL_NEAR).sort((a, b) => a.off - b.off);
    for (const { c } of near) {
      const z = slots[c.slot].z[c.node];
      if (taken.some((v) => Math.abs(v - z) <= LEVEL_GAP)) continue;
      taken.push(z);
      if (!(await enclosed(c, start))) spare.push(c);
    }
  }
  if (!goals.length && !spare.length && !levels) return { ok: false, reason: 'no way there on foot' };
  // Likewise begin from the nearest place to stand that leads somewhere (not the top of a signpost);
  // where your height is not known, from any of the floors there. Where it is known, not from
  // anything more than a step over it: you can drop down from where you are, but not rise to a
  // floor overhead. (In the Wizard's Sanctum under Stormwind, whose only way out is its portal,
  // the search began on the earth under the streets above it and walked off along that.)
  const loose = !req.landFrom && (req.from[2] === null || req.from[2] === undefined);
  const over = loose || req.landFrom ? Infinity : req.from[2] + SEED_OVER;
  const seeds = [];
  for (const c of starts.slice(0, 400)) {
    if (seeds.length && (!loose || c.d > seeds[0].d + 1.6)) break;
    if (slots[c.slot].z[c.node] > over) continue;
    if (!(await enclosed(c, goals[0] ?? spare[0] ?? { slot: -1, node: -1 }, true))) seeds.push(c);
  }
  // On a lift, between its stops: no floor is under you, and the lift puts you down at one of
  // them - whichever, as far as the map can tell. The way begins at each, the time to it counted.
  if (!seeds.length) {
    const z0 = req.from[2] === null || req.from[2] === undefined ? null : req.from[2];
    for (const L of lifts) {
      if (Math.hypot(req.from[0] - L.x, req.from[1] - L.y) > (L.r ?? 7) + 1 || (z0 !== null && (z0 < L.lo - 6 || z0 > L.hi + 6))) continue;
      const land = await landingsOf(L), stops = stopsOf(L), speed = L.speed > 0 ? L.speed : LIFT_SPEED;
      land.forEach((stop, q) => { for (const f of stop.floors) seeds.push({ ...f, g0: (z0 === null ? (stops[stops.length - 1] - stops[0]) / 2 : Math.abs(z0 - stops[q])) / speed + f.d / run }); });
      if (seeds.length) break;
    }
  }
  if (!seeds.length) return { ok: false, reason: 'no way out of where you are on foot' };
  // Buried ground counts as that much further away, at either end: the floor built over it is
  // the one meant unless only the ground can be reached. (So do the spare floors at the spot.)
  const goalSet = new Set([...goals, ...spare].map((c) => c.slot * PACK + c.node));
  const buried = new Set([...goals.filter(covered), ...spare].map((c) => c.slot * PACK + c.node));
  const spares = new Set(spare.map((c) => c.slot * PACK + c.node));
  const plain = goals.length - goals.filter(covered).length; // goals that are not buried ground
  let goalId = -1, goalCost = Infinity, goalAt = 0;
  const gx = req.to[0], gy = req.to[1];
  const vmax = Math.max(run, swim);
  const WEIGHT = weightFor(Math.hypot(req.to[0] - req.from[0], req.to[1] - req.from[1]));
  const heap = new Heap();
  for (const c of seeds) {
    const g0 = c.g0 ?? (seeds.length > 1 && covered(c) ? COVERED : 0);
    if (g0 >= state[c.slot].g[c.node]) continue;
    state[c.slot].g[c.node] = g0;
    heap.push(g0, c.slot * PACK + c.node, c.cell);
  }
  let expanded = 0, found = false;
  const nb = new Int32Array(8), nbSlot = new Int32Array(8), nbCell = new Int32Array(8), nbFell = new Uint8Array(8);
  // One cell on from a surface: walking where it leads on to a floor, else - where falls count -
  // dropping (as hop and fall answer; fell says which it was).
  let fell = 0;
  const go = (s, cell, n, d) => {
    fell = 0;
    let k = step(s, cell, n, d);
    if (k !== -1 || !falls) return k;
    k = fall(s, cell, n, d);
    if (k >= 0) fell = 1;
    return k;
  };
  // Steep ground reached so far -> the height at which the fall that got there began. (What a
  // fall costs is its whole height, from the floor you left to the floor you land on, however
  // far you slide between the two.)
  const fellFrom = new Map();
  // A floor reached on a lift -> { from (the floor the lift was got on at), L, q, r (from which of its stops to which), seconds }
  const rode = new Map();

  while (heap.n > 0) {
    // an end has been reached (buried ground): stop once nothing left could beat it. (The search
    // leans toward the goal by WEIGHT, so what is left is only that much worse than it looks.)
    if (found && (heap.key[0] >= goalCost * WEIGHT || expanded > goalAt + EXTRA)) break;
    const id = heap.id[0], cell = heap.cell[0];
    heap.pop();
    const s = id >>> PACK_BITS, n = id & PACK_MASK, st = state[s];
    if (st.closed[n] & 1) continue;
    st.closed[n] |= 1;
    if (levels) {
      const li = levelOf.get(id);
      if (li !== undefined && !levels[li].reached) {
        levels[li].reached = { slot: s, cell, node: n, seconds: st.g[n] };
        if (!levels[li].sunk) {
          if (firstRealAt < 0) firstRealAt = expanded;
          if (--realLeft === 0) break;
        }
      }
      if (firstRealAt < 0 && !(slots[s].flags[n] & F_SWIM)) {
        // no level at the spot itself yet: is this the nearest place to it reached so far?
        const [x, y] = pos(s, cell), d = Math.hypot(x - gx, y - gy);
        if (d <= LEVEL_WIDE && (!nearBest || d < nearBest.d - 0.5) && !(await sunk(s, cell, n))) { nearBest = { slot: s, cell, node: n, seconds: st.g[n], d }; nearAt = expanded; }
      }
      // (what is still missing may be somewhere there is no walking to: do not look for ever)
      const since = firstRealAt >= 0 ? firstRealAt : nearBest ? nearAt : -1;
      if (since >= 0 && expanded > since + (firstRealAt >= 0 || realCount > 0 ? LEVEL_EXTRA : NEAR_EXTRA)) break;
      if ((expanded & 4095) === 0 && performance.now() - began > (since >= 0 ? LEVEL_MS : LEVEL_FIRST_MS)) break;
    } else if (goalSet.has(id)) {
      const under = buried.has(id), cost = st.g[n] + (spares.has(id) ? SPARE : under ? COVERED : 0);
      if (cost < goalCost) { if (!found) goalAt = expanded; found = true; goalId = id; goalCost = cost; }
      if (!under || !plain) break; // (reached buried ground first: see if the floor over it is nearly as near)
    }
    if (++expanded > MAX_EXPANDED) break;
    const g = st.g[n], lean = WEIGHT * (1 + expanded / HURRY);
    // the four cells beside this one that its floor leads on to
    for (let d = 0; d < 4; d++) {
      let k = go(s, cell, n, d);
      if (k === -2) { await getSlot(hopCol, hopRow); k = go(s, cell, n, d); }
      nb[d] = k; nbSlot[d] = hopSlot; nbCell[d] = hopCell; nbFell[d] = fell;
    }
    // a diagonal only where both ways round the corner lead to the same floor
    for (let d = 4; d < 8; d++) {
      nb[d] = -1;
      const dx = DX[d] > 0 ? 0 : 1, dy = DY[d] > 0 ? 2 : 3;
      if (nb[dx] < 0 || nb[dy] < 0) continue;
      let k1 = go(nbSlot[dx], nbCell[dx], nb[dx], dy);
      if (k1 === -2) { await getSlot(hopCol, hopRow); k1 = go(nbSlot[dx], nbCell[dx], nb[dx], dy); }
      const s1 = hopSlot, c1 = hopCell, f1 = fell;
      let k2 = go(nbSlot[dy], nbCell[dy], nb[dy], dx);
      if (k2 === -2) { await getSlot(hopCol, hopRow); k2 = go(nbSlot[dy], nbCell[dy], nb[dy], dx); }
      if (k1 >= 0 && k1 === k2 && s1 === hopSlot) { nb[d] = k1; nbSlot[d] = s1; nbCell[d] = c1; nbFell[d] = nbFell[dx] | nbFell[dy] | f1 | fell; }
    }
    const t = slots[s], z = t.z[n];
    const from = t.flags[n] & F_STEEP ? fellFrom.get(id) ?? z : z; // the height a fall from here began at
    const lost = st.closed[n] >> 1;                                 // the health the falls on the way here have cost, in hundredths
    for (let d = 0; d < 8; d++) {
      const k = nb[d];
      if (k < 0) continue;
      const ts = nbSlot[d], tt = slots[ts], sn = state[ts];
      if (sn.closed[k] & 1) continue;
      const dz = tt.z[k] - z, flat = d < 4 ? CELL : CELL * 1.41421356;
      const f = tt.flags[k];
      let cost, losing = lost;
      if (!nbFell[d]) cost = Math.sqrt(flat * flat + dz * dz) / (f & F_SWIM ? swim : run);
      else {
        // a fall: no further than you walk away from (into water: as far as you like), and one that hurts is that much longer a way
        const far = from - tt.z[k];
        if (far > FALL_MOST && !(f & F_SWIM)) continue;
        // Not on to the earth a town is built over. The data lets no fall end on ground with
        // something built over it; but a town's canals are open to the sky, their water is the
        // town's own and not in this data, and to the search they are dry trenches down to that
        // earth: nowhere anyone lands, with no way back up, and a way out under the town to the
        // open country that nobody could take.
        if (f & F_TERRAIN && !(f & F_STEEP) && (covered({ slot: ts, cell: nbCell[d], node: k }) || (await sunk(ts, nbCell[d], k)))) continue;
        cost = flat / run + Math.max(0, -dz) / FALL_SPEED;
        if (!(f & (F_STEEP | F_SWIM))) {
          // (the falls of one way add up: two you would each walk away from are not two you walk away from)
          losing += Math.round(hurt(far) * 100);
          if (losing > HURT_MOST) continue;
          cost += hurt(far) * FALL_HURT;
        }
      }
      const x = tt.xN - (((nbCell[d] / N) | 0) + 0.5) * CELL, y = tt.yW - ((nbCell[d] % N) + 0.5) * CELL;
      if (f & F_LAVA) cost *= LAVA_COST;
      const ng = g + cost;
      if (ng < sn.g[k]) {
        sn.g[k] = ng;
        sn.parent[k] = id;
        sn.closed[k] = losing << 1;
        if (f & F_STEEP) fellFrom.set(ts * PACK + k, from);
        heap.push(ng + (Math.hypot(x - gx, y - gy) / vmax) * lean, ts * PACK + k, nbCell[d]);
      }
    }
    // a lift that stops at this floor: on to the floors at each of its other stops
    const reach = slotLifts[s] ? liftsBy(s, cell, n) : null;
    const by = reach ? await liftAt(reach, id) : null;
    if (by) {
      for (let r = 0; r < by.land.length; r++) {
        if (r === by.q) continue;
        const ride = liftSeconds(by.L, by.q, r);
        for (const fl of by.land[r].floors) {
          const sn = state[fl.slot];
          if (sn.closed[fl.node] & 1) continue;
          const ng = g + by.d / run + ride + fl.d / run;
          if (ng >= sn.g[fl.node]) continue;
          sn.g[fl.node] = ng;
          sn.parent[fl.node] = id;
          sn.closed[fl.node] = lost << 1;
          rode.set(fl.slot * PACK + fl.node, { from: id, L: by.L, q: by.q, r, seconds: ride });
          const [x, y] = pos(fl.slot, fl.cell);
          heap.push(ng + (Math.hypot(x - gx, y - gy) / vmax) * lean, fl.slot * PACK + fl.node, fl.cell);
        }
      }
    }
  }
  if (levels) {
    // the levels that can be walked to, highest first: how high, how long it takes to get there,
    // and what kind of ground it is
    // (off: how far from the spot asked about the place is)
    const say = (r, buried) => {
      const t = slots[r.slot], f = t.flags[r.node], [x, y] = pos(r.slot, r.cell);
      return { x, y, z: t.z[r.node], seconds: r.seconds, terrain: !!(f & F_TERRAIN), swim: !!(f & F_SWIM), buried, off: Math.hypot(x - gx, y - gy) };
    };
    let out = levels.filter((g) => g.reached && !g.sunk).map((g) => say(g.reached, false)), nearest = false;
    // no level at the spot can be walked to: the nearest place that can; failing that, buried ground after all
    if (!out.length && nearBest) { out = [say(nearBest, false)]; nearest = true; }
    if (!out.length) out = levels.filter((g) => g.reached).map((g) => say(g.reached, true));
    out.sort((a, b) => b.z - a.z);
    if (!out.length) {
      // (nothing, and little looked at: where you stand can only be left by dropping off it - look again, drops and all)
      if (strict && heap.n === 0 && expanded < STUCK) return findRoute({ ...req, drops: true });
      return { ok: false, reason: expanded > MAX_EXPANDED || slots.length >= MAX_TILES ? 'too far to work out on foot' : 'no way there on foot', levels: [], expanded };
    }
    return { ok: true, levels: out, nearest, expanded, complete: realCount > 0 && realLeft === 0 };
  }
  if (!found) return { ok: false, reason: expanded > MAX_EXPANDED || slots.length >= MAX_TILES ? 'too far to work out on foot' : 'no way there on foot', expanded };

  // ---- the path: cells from the goal back to the start ----
  const cellOf = (t, node) => { let lo = 0, hi = N * N - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t.offs[mid] <= node) lo = mid; else hi = mid - 1; } return lo; };
  const raw = [];
  for (let id = goalId; id >= 0; id = state[id >>> PACK_BITS].parent[id & PACK_MASK]) {
    const s = id >>> PACK_BITS, n = id & PACK_MASK, t = slots[s], c = cellOf(t, n);
    const [x, y] = pos(s, c);
    // (lift: come to on a lift, from the place before it - unless a step led here sooner after all)
    const by = rode.get(id);
    raw.push({ x, y, z: t.z[n], kind: (t.flags[n] & F_SWIM ? 1 : 0), steep: !!(t.flags[n] & F_STEEP), slot: s, cell: c, node: n, lift: by && by.from === state[s].parent[n] ? by : null });
  }
  raw.reverse();
  // Which of its places are come to by a fall (off an edge, or down steep ground), not by a
  // step: each fall from the floor left to the floor landed on. One of a few yards - a bank a
  // little too steep to stand on, a ledge you hop down - is not worth the name: it is drawn and
  // told like the walking either side of it. And the furthest fall of the way, water not
  // counted (there is no harm in it).
  let furthest = 0, costs = 0;
  for (let i = 1, from = 0, first = 0; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    b.fell = !b.lift && (a.steep || b.steep || a.z - b.z > DOWN); // (a lift down is no fall)
    if (!b.fell) continue;
    if (!a.steep) { from = a.z; first = i; }
    if (b.steep && i < raw.length - 1) continue;
    if (from - b.z < FELL_SHOWN) for (let k = first; k <= i; k++) raw[k].fell = false;
    else if (!(b.kind & 1)) { furthest = Math.max(furthest, from - b.z); costs += hurt(from - b.z); }
  }

  // ---- straighten: the grid path zig-zags; pull it tight wherever a straight line is as walkable ----
  // Floors along a straight line from a to b, or null if it is blocked or leaves the kind of ground a and b share.
  const line = (a, b) => {
    const dist = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(dist / (CELL * 0.45)));
    let s = a.slot, cell = a.cell, n = a.node;
    const out = [];
    for (let k = 1; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps, y = a.y + ((b.y - a.y) * k) / steps;
      const t = slots[s];
      const di = Math.floor((t.yW - y) / CELL) - (cell % N), dj = Math.floor((t.xN - x) / CELL) - ((cell / N) | 0);
      if (di || dj) {
        if (Math.abs(di) > 1 || Math.abs(dj) > 1) return null;
        const hx = di > 0 ? 0 : 1, hy = dj > 0 ? 2 : 3, before = t.z[n];
        let k1;
        if (di && dj) {
          // round the corner either way, to the same floor
          k1 = hop(s, cell, n, hx);
          if (k1 < 0) return null;
          k1 = hop(hopSlot, hopCell, k1, hy);
          if (k1 < 0) return null;
          const s1 = hopSlot, c1 = hopCell;
          let k2 = hop(s, cell, n, hy);
          if (k2 < 0) return null;
          k2 = hop(hopSlot, hopCell, k2, hx);
          if (k2 !== k1 || hopSlot !== s1) return null;
          s = s1; cell = c1; n = k1;
        } else {
          k1 = hop(s, cell, n, di ? hx : hy);
          if (k1 < 0) return null;
          s = hopSlot; cell = hopCell; n = k1;
        }
        if (before - slots[s].z[n] > UP) return null; // no dropping off a ledge on a short cut
      }
      const tt = slots[s], f = tt.flags[n];
      const kind = (f & F_SWIM ? 1 : 0);
      if (kind !== a.kind || kind !== b.kind || f & (F_LAVA | F_STEEP)) return null;
      out.push({ x, y, z: tt.z[n], kind, slot: s, cell, node: n });
    }
    return s === b.slot && n === b.node ? out : null;
  };
  const pts = [raw[0]];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    // On to a lift and off it at another of its stops: two places at its middle, one over the
    // other, and the second is come to on the lift.
    const by = raw[anchor + 1].lift;
    if (by) {
      const stops = stopsOf(by.L);
      pts.push({ x: by.L.x, y: by.L.y, z: stops[by.q], kind: 0, stack: true }, { x: by.L.x, y: by.L.y, z: stops[by.r], kind: 0, stack: true, lifted: by }, raw[anchor + 1]);
      anchor++;
      continue;
    }
    // the farthest point of the path a straight line from here reaches (none goes across a lift)
    let far = anchor + 1, seg = null, step = 64, most = raw.length - 1;
    for (let k = anchor + 2; k <= Math.min(raw.length - 1, anchor + step); k++) if (raw[k].lift) { most = k - 1; break; }
    for (let probe = Math.min(most, anchor + step); probe > anchor + 1; ) {
      const l = line(raw[anchor], raw[probe]);
      if (l) { far = probe; seg = l; break; }
      step = Math.max(1, step >> 1);
      probe = Math.min(probe - 1, anchor + step);
    }
    if (seg) { for (let k = 3; k < seg.length - 1; k += 4) pts.push(seg[k]); } // keep points along it, to follow the ground
    // (a straight line is walked: whatever the grid path did to get there, this did not fall)
    pts.push(seg ? { ...raw[far], fell: false } : raw[far]);
    anchor = far;
  }
  // (a slide down steep ground: every third place of it will do for a line)
  for (let i = pts.length - 2, run = 0; i > 0; i--) {
    run = pts[i].steep && pts[i + 1].steep && pts[i - 1].steep ? run + 1 : 0;
    if (run % 3) pts.splice(i, 1);
  }
  // begin where you stand, and finish at the asked spot itself when it is right by the last place to stand
  pts[0] = { ...pts[0], x: req.from[0], y: req.from[1] };
  const last = pts[pts.length - 1];
  if (Math.hypot(req.to[0] - last.x, req.to[1] - last.y) < 3) pts[pts.length - 1] = { ...last, x: req.to[0], y: req.to[1] };

  // ---- where another level lies over or under the way ----
  // Seen from above a route is a line on a map, and where one floor lies over another (a bridge
  // over the road, a gallery over the hall, a ledge over the path that climbs to it) being on
  // that line does not say which of the two you are on. Whoever follows the route by map position
  // alone - the game's addon, which is told no height - has to know where that is so. A point is
  // marked when a place to stand within STACK_REACH yards of it lies more than a level above or
  // below it and is not simply the same ground a few steps on (a slope is not two levels; the
  // earth the game leaves buried under a town's streets is nowhere anyone stands; nor is a roof).
  const stackBegan = performance.now();
  const stacked = async (p) => {
    const t0 = slots[p.slot], z0 = t0.z[p.node], ci = p.cell % N, cj = (p.cell / N) | 0;
    const suspects = [];
    for (let b = -STACK_REACH; b <= STACK_REACH; b++) for (let a = -STACK_REACH; a <= STACK_REACH; a++) {
      let i = ci + a, j = cj + b, s = p.slot;
      if (i < 0 || i >= N || j < 0 || j >= N) {
        s = await getSlot(t0.col + (i < 0 ? -1 : i >= N ? 1 : 0), t0.row + (j < 0 ? -1 : j >= N ? 1 : 0));
        if (s < 0) continue;
        i = (i + N) % N; j = (j + N) % N;
      }
      const t = slots[s], cell = j * N + i;
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
        if (Math.abs(t.z[k] - z0) <= STACK_GAP || t.flags[k] & F_STEEP) continue;
        if (t.flags[k] & F_TERRAIN && t.z[k] < z0 && covered({ slot: s, cell, node: k })) continue;
        suspects.push(s * PACK + k);
      }
    }
    if (!suspects.length) return false;
    // the ground this place is part of: what can be walked to, and back from, without leaving the neighbourhood
    const seen = new Set([p.slot * PACK + p.node]), queue = [[p.slot, p.cell, p.node, 0, 0]];
    for (let q = 0; q < queue.length; q++) {
      const [s, cell, n, oi, oj] = queue[q];
      for (let d = 0; d < 4; d++) {
        const ni = oi + DX[d], nj = oj + DY[d];
        if (Math.abs(ni) > STACK_REACH || Math.abs(nj) > STACK_REACH) continue;
        let k = hopBack(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hopBack(s, cell, n, d); }
        if (k < 0) continue;
        const id = hopSlot * PACK + k;
        if (!seen.has(id)) { seen.add(id); queue.push([hopSlot, hopCell, k, ni, nj]); }
      }
    }
    for (const id of suspects) if (!seen.has(id) && (await standable(id))) return true;
    return false;
  };
  // A floor is another level only if it is somewhere to walk about: a surface that goes on, by
  // steps that can be taken both ways. The data is full of floors that are not - a roof nobody
  // can get on to, an awning, a tree top, the face of a bank too steep to stand on (each of its
  // cells a floor with no way to the next) - and those are soon used up when walked from. And
  // the ground the game leaves buried under a town goes on for ever but is nowhere to be.
  const island = new Map(); // floor -> true if it is part of a level, false if not
  const standable = async (id) => {
    if (island.has(id)) return island.get(id);
    const s0 = Math.floor(id / PACK), n0 = id % PACK, c0 = cellOf(slots[s0], n0);
    const seen = new Set([id]), queue = [[s0, c0, n0]];
    let real = null;
    for (let q = 0; q < queue.length && real === null; q++) {
      const [s, cell, n] = queue[q];
      for (let d = 0; d < 4; d++) {
        let k = hopBack(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hopBack(s, cell, n, d); }
        if (k < 0) continue;
        const next = hopSlot * PACK + k;
        // (the same surface as one already looked at: it is whatever that was)
        if (island.has(next)) { real = island.get(next); break; }
        if (!seen.has(next)) { seen.add(next); queue.push([hopSlot, hopCell, k]); }
      }
      if (real === null && queue.length > STACK_ISLAND) {
        // it goes on. Buried ground? (asked of a few of its places: most of them say)
        let buried = 0;
        const asked = [0, 0.25, 0.5, 0.75, 1].map((f) => queue[Math.floor(f * (queue.length - 1))]);
        for (const [as, ac, an] of asked) if (slots[as].flags[an] & F_TERRAIN && (covered({ slot: as, cell: ac, node: an }) || (await sunk(as, ac, an)))) buried++;
        real = buried < 3;
      }
    }
    if (real === null) real = false; // (used up: an island)
    for (const v of seen) island.set(v, real);
    return real;
  };
  // First of all the route itself: where a later part of it passes over or under an earlier one
  // (the gallery it ends on over the hall it comes in by, the bridge over the road), both are marked.
  // (Not a stair or a slope, though, whose top is over its foot only as far as it has run: the way
  // between the two has to be a good deal longer than they are apart on the map.)
  const along = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) along[i] = along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    for (let j = i + 1; j < pts.length; j++) {
      const b = pts[j];
      if (Math.abs(b.z - a.z) <= STACK_GAP || Math.abs(b.x - a.x) > STACK_REACH || Math.abs(b.y - a.y) > STACK_REACH) continue;
      if (along[j] - along[i] >= STACK_ROUND + 2.5 * Math.hypot(b.x - a.x, b.y - a.y)) a.stack = b.stack = true;
    }
  }
  for (const p of pts) {
    if (p.stack || p.steep) continue; // (nobody stands on steep ground to be on one level or another)
    // (a route so long that this would hold it up: the rest counts as marked, which only makes its follower more careful)
    p.stack = performance.now() - stackBegan > STACK_MS ? true : await stacked(p);
  }

  let length = 0, seconds = 0;
  const points = new Float32Array(pts.length * 3), kinds = new Uint8Array(pts.length), rides = [];
  pts.forEach((p, i) => {
    points[i * 3] = p.x; points[i * 3 + 1] = p.y; points[i * 3 + 2] = p.z; kinds[i] = p.kind | (p.fell ? FELL : 0) | (p.stack ? STACKED : 0) | (p.lifted ? LIFTED : 0);
    if (i > 0) {
      const q = pts[i - 1], d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      // (a lift's ride is time, and no yards of anybody's walking)
      if (p.lifted) { seconds += p.lifted.seconds; rides.push({ at: i, seconds: p.lifted.seconds, from: q.z, to: p.z, name: p.lifted.L.name ?? '' }); return; }
      length += d;
      seconds += p.fell ? Math.hypot(p.x - q.x, p.y - q.y) / run + Math.max(0, q.z - p.z) / FALL_SPEED : d / (p.kind & 1 ? swim : run);
    }
  });
  // (fall: the furthest you fall on the way, in yards, and hurt: the part of your full health its falls cost between them - 0 where none hurts)
  return { ok: true, points, kinds, length, seconds, expanded, tiles: slots.length, fall: furthest, hurt: Math.min(1, costs), rides };
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'route') {
    // one search at a time, in the order asked
    chain = chain.then(async () => {
      const t0 = performance.now();
      let out;
      // which map this search is on (each search says; the tiles of each are cached)
      const nav = m.nav;
      if (!nav) out = { ok: false, reason: 'no walking data for this map' };
      else {
        let c = maps.get(nav.map);
        if (!c || c.rev !== nav.rev) { c = { map: nav.map, rev: nav.rev, have: new Set(nav.tiles), lifts: [] }; maps.set(nav.map, c); }
        // (the lifts of this map, as the page has them now: a list of a few)
        c.lifts = Array.isArray(nav.lifts) ? nav.lifts : [];
        ctx = c;
      }
      try { if (!out) out = await findRoute(m); } catch (err) { out = { ok: false, reason: String(err?.message ?? err) }; }
      out.type = 'route'; out.id = m.id; out.ms = Math.round(performance.now() - t0);
      self.postMessage(out, out.points ? [out.points.buffer, out.kinds.buffer] : []);
    });
  }
};
