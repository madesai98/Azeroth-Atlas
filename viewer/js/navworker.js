// Route search over the map's navigation data (maps/<id>/nav/<col>_<row>.bin, one grid of
// "floors" per tile: the places a character can stand, about a yard apart; see
// extractor/jobs/nav.js). Runs in a worker so a long search never stalls the map.
//
// Each floor records which of its four neighbouring cells it leads on to (worked out at half-yard
// precision when the data is built, so thin walls separate and narrow doorways connect); the
// floor it leads to there is the one within a step up, or a short drop down. The cost of a move is the time it takes: distance over your run
// speed, or your swim speed on water.

const TILE = 1600 / 3, N = 512, CELL = TILE / N;
const UP = 1.3;          // yards you can step up from one cell to the next (a 50 degree slope, a kerb)
const DOWN = 3;          // yards you will drop from one cell to the next
const F_SWIM = 1, F_LAVA = 2, F_TERRAIN = 4;
const OPEN = [16, 32, 64, 128];     // floor flag: open toward east, west, south, north (as DX / DY below)
const BACK = [32, 16, 128, 64];     // the same edge seen from the other cell
const LAVA_COST = 60;
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
const STACK_REACH = 7;   // cells to each side that are looked at
const STACK_GAP = 2.5;   // yards above or below that make another level
const STACK_ISLAND = 600; // floors: a surface with fewer than this to walk about on is not a level (a roof, an awning, a tree top)
const STACK_ROUND = 8;   // yards (and 2.5 times as far as they are apart) of route between two places for one to be over the other, not up a stair from it
const STACK_MS = 250;    // no longer than this is spent on it
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];

let ctx = { map: -1, rev: '', have: new Set() }; // the map the search in hand is on
const maps = new Map();  // map id -> { map, rev, have } as last described by the page
const tiles = new Map(); // "map/col_row" -> tile | null, most recently used last

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadTile(col, row) {
  const name = `${col}_${row}`, key = `${ctx.map}/${name}`;
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
        const [counts, zb, flags] = await Promise.all([inflate(sections.get(2)), inflate(sections.get(3)), inflate(sections.get(4))]);
        const q = new Uint16Array(zb.buffer, zb.byteOffset, zb.byteLength >> 1);
        const z = new Float32Array(q.length);
        for (let i = 0, acc = 0; i < q.length; i++) { acc = (acc + q[i]) & 0xffff; z[i] = acc / 8 - 2048; } // stored as differences
        const offs = new Uint32Array(N * N + 1);
        for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
        tile = { col, row, xN: (32 - row) * TILE, yW: (32 - col) * TILE, offs, z, flags, nodes: z.length };
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
 *            1 swim, 16 another level lies over or under it),
 *            length (yards), seconds, expanded }
 */
async function findRoute(req) {
  const began = performance.now();
  const run = req.run > 0 ? req.run : 7, swim = req.swim > 0 ? req.swim : run * 0.67;
  const slots = [], slotOf = new Map(), state = [];
  const getSlot = async (col, row) => {
    const key = col * 128 + row;
    let s = slotOf.get(key);
    if (s !== undefined) return s;
    const t = slots.length < MAX_TILES ? await loadTile(col, row) : null;
    if (!t || t.nodes >= 1048576) { slotOf.set(key, -1); return -1; }
    s = slots.length;
    slots.push(t);
    state.push({ g: new Float32Array(t.nodes).fill(Infinity), parent: new Int32Array(t.nodes).fill(-1), closed: new Uint8Array(t.nodes) });
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
    let best = -1;
    for (let k = tt.offs[nc], e = tt.offs[nc + 1]; k < e; k++) { const dz = tt.z[k] - z; if (dz <= UP && dz >= -DOWN) best = k; }
    // across a tile edge each side only knows its own half of the way through
    if (best >= 0 && border && !(tt.flags[best] & BACK[d])) return -1;
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
  // True if a floor is shut in: everything you can get to from it is a small pocket (the ground
  // under a building's floor, the inside of a rock) that the other end is not in.
  const pocket = new Set(); // floors already found to be shut in
  const enclosed = async (c, other) => {
    if (pocket.has(c.slot * 1048576 + c.node)) return true;
    const seen = new Set([c.slot * 1048576 + c.node]), queue = [[c.slot, c.cell, c.node]];
    for (let q = 0; q < queue.length; q++) {
      if (queue.length > 2500) return false;
      const [s, cell, n] = queue[q];
      if (s === other.slot && n === other.node) return false;
      for (let d = 0; d < 4; d++) {
        let k = hop(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hop(s, cell, n, d); }
        if (k < 0) continue;
        const id = hopSlot * 1048576 + k;
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
    for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) if (!(t.flags[k] & (F_TERRAIN | F_SWIM)) && t.z[k] > z + 1.5) return true;
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
  // True for ground lying in a pit of built floors: the earth under a town, which the game leaves
  // in place below the streets. (covered() above asks for a floor right over the spot; this also
  // knows the ground under a roof or inside a wall, where nothing walkable is overhead.)
  const sunkMemo = new Map();
  const sunk = async (slot, cell, node) => {
    const id = slot * 1048576 + node;
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
          for (let q = t2.offs[c2]; q < t2.offs[c2 + 1]; q++) if (!(t2.flags[q] & (F_TERRAIN | F_SWIM)) && t2.z[q] > h) { over = true; break; }
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
      for (const c of g.members) levelOf.set(c.slot * 1048576 + c.node, levels.length);
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
  if (!goals.length && !levels) return { ok: false, reason: 'no way there on foot' };
  // Likewise begin from the nearest place to stand that leads somewhere (not the top of a signpost);
  // where your height is not known, from any of the floors there.
  const loose = !req.landFrom && (req.from[2] === null || req.from[2] === undefined);
  const seeds = [];
  for (const c of starts.slice(0, 400)) {
    if (seeds.length && (!loose || c.d > seeds[0].d + 1.6)) break;
    if (!(await enclosed(c, goals[0] ?? { slot: -1, node: -1 }))) seeds.push(c);
  }
  if (!seeds.length) return { ok: false, reason: 'no way out of where you are on foot' };
  // Buried ground counts as that much further away, at either end: the floor built over it is
  // the one meant unless only the ground can be reached.
  const goalSet = new Set(goals.map((c) => c.slot * 1048576 + c.node));
  const buried = new Set(goals.filter(covered).map((c) => c.slot * 1048576 + c.node));
  const plain = goals.length - buried.size; // goals that are not buried ground
  let goalId = -1, goalCost = Infinity, goalAt = 0;
  const gx = req.to[0], gy = req.to[1];
  const vmax = Math.max(run, swim);
  const WEIGHT = weightFor(Math.hypot(req.to[0] - req.from[0], req.to[1] - req.from[1]));
  const heap = new Heap();
  for (const c of seeds) {
    const g0 = seeds.length > 1 && covered(c) ? COVERED : 0;
    state[c.slot].g[c.node] = g0;
    heap.push(g0, c.slot * 1048576 + c.node, c.cell);
  }
  let expanded = 0, found = false;
  const nb = new Int32Array(8), nbSlot = new Int32Array(8), nbCell = new Int32Array(8);

  while (heap.n > 0) {
    // an end has been reached (buried ground): stop once nothing left could beat it. (The search
    // leans toward the goal by WEIGHT, so what is left is only that much worse than it looks.)
    if (found && (heap.key[0] >= goalCost * WEIGHT || expanded > goalAt + EXTRA)) break;
    const id = heap.id[0], cell = heap.cell[0];
    heap.pop();
    const s = id >>> 20, n = id & 1048575, st = state[s];
    if (st.closed[n]) continue;
    st.closed[n] = 1;
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
      const under = buried.has(id), cost = st.g[n] + (under ? COVERED : 0);
      if (cost < goalCost) { if (!found) goalAt = expanded; found = true; goalId = id; goalCost = cost; }
      if (!under || !plain) break; // (reached buried ground first: see if the floor over it is nearly as near)
    }
    if (++expanded > MAX_EXPANDED) break;
    const g = st.g[n], lean = WEIGHT * (1 + expanded / HURRY);
    // the four cells beside this one that its floor leads on to
    for (let d = 0; d < 4; d++) {
      let k = step(s, cell, n, d);
      if (k === -2) { await getSlot(hopCol, hopRow); k = step(s, cell, n, d); }
      nb[d] = k; nbSlot[d] = hopSlot; nbCell[d] = hopCell;
    }
    // a diagonal only where both ways round the corner lead to the same floor
    for (let d = 4; d < 8; d++) {
      nb[d] = -1;
      const dx = DX[d] > 0 ? 0 : 1, dy = DY[d] > 0 ? 2 : 3;
      if (nb[dx] < 0 || nb[dy] < 0) continue;
      let k1 = step(nbSlot[dx], nbCell[dx], nb[dx], dy);
      if (k1 === -2) { await getSlot(hopCol, hopRow); k1 = step(nbSlot[dx], nbCell[dx], nb[dx], dy); }
      const s1 = hopSlot, c1 = hopCell;
      let k2 = step(nbSlot[dy], nbCell[dy], nb[dy], dx);
      if (k2 === -2) { await getSlot(hopCol, hopRow); k2 = step(nbSlot[dy], nbCell[dy], nb[dy], dx); }
      if (k1 >= 0 && k1 === k2 && s1 === hopSlot) { nb[d] = k1; nbSlot[d] = s1; nbCell[d] = c1; }
    }
    const t = slots[s], z = t.z[n];
    for (let d = 0; d < 8; d++) {
      const k = nb[d];
      if (k < 0) continue;
      const ts = nbSlot[d], tt = slots[ts], sn = state[ts];
      if (sn.closed[k]) continue;
      const dz = tt.z[k] - z, flat = d < 4 ? CELL : CELL * 1.41421356;
      const f = tt.flags[k];
      let cost = Math.sqrt(flat * flat + dz * dz) / (f & F_SWIM ? swim : run);
      const x = tt.xN - (((nbCell[d] / N) | 0) + 0.5) * CELL, y = tt.yW - ((nbCell[d] % N) + 0.5) * CELL;
      if (f & F_LAVA) cost *= LAVA_COST;
      const ng = g + cost;
      if (ng < sn.g[k]) {
        sn.g[k] = ng;
        sn.parent[k] = id;
        heap.push(ng + (Math.hypot(x - gx, y - gy) / vmax) * lean, ts * 1048576 + k, nbCell[d]);
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
  for (let id = goalId; id >= 0; id = state[id >>> 20].parent[id & 1048575]) {
    const s = id >>> 20, n = id & 1048575, t = slots[s], c = cellOf(t, n);
    const [x, y] = pos(s, c);
    raw.push({ x, y, z: t.z[n], kind: (t.flags[n] & F_SWIM ? 1 : 0), slot: s, cell: c, node: n });
  }
  raw.reverse();

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
      if (kind !== a.kind || kind !== b.kind || f & F_LAVA) return null;
      out.push({ x, y, z: tt.z[n], kind, slot: s, cell, node: n });
    }
    return s === b.slot && n === b.node ? out : null;
  };
  const pts = [raw[0]];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    // the farthest point of the path a straight line from here reaches
    let far = anchor + 1, seg = null, step = 64;
    for (let probe = Math.min(raw.length - 1, anchor + step); probe > anchor + 1; ) {
      const l = line(raw[anchor], raw[probe]);
      if (l) { far = probe; seg = l; break; }
      step = Math.max(1, step >> 1);
      probe = Math.min(probe - 1, anchor + step);
    }
    if (seg) { for (let k = 3; k < seg.length - 1; k += 4) pts.push(seg[k]); } // keep points along it, to follow the ground
    pts.push(raw[far]);
    anchor = far;
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
        if (Math.abs(t.z[k] - z0) <= STACK_GAP) continue;
        if (t.flags[k] & F_TERRAIN && t.z[k] < z0 && covered({ slot: s, cell, node: k })) continue;
        suspects.push(s * 1048576 + k);
      }
    }
    if (!suspects.length) return false;
    // the ground this place is part of: what can be walked to, and back from, without leaving the neighbourhood
    const seen = new Set([p.slot * 1048576 + p.node]), queue = [[p.slot, p.cell, p.node, 0, 0]];
    for (let q = 0; q < queue.length; q++) {
      const [s, cell, n, oi, oj] = queue[q];
      for (let d = 0; d < 4; d++) {
        const ni = oi + DX[d], nj = oj + DY[d];
        if (Math.abs(ni) > STACK_REACH || Math.abs(nj) > STACK_REACH) continue;
        let k = hopBack(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hopBack(s, cell, n, d); }
        if (k < 0) continue;
        const id = hopSlot * 1048576 + k;
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
    const s0 = Math.floor(id / 1048576), n0 = id % 1048576, c0 = cellOf(slots[s0], n0);
    const seen = new Set([id]), queue = [[s0, c0, n0]];
    let real = null;
    for (let q = 0; q < queue.length && real === null; q++) {
      const [s, cell, n] = queue[q];
      for (let d = 0; d < 4; d++) {
        let k = hopBack(s, cell, n, d);
        if (k === -2) { await getSlot(hopCol, hopRow); k = hopBack(s, cell, n, d); }
        if (k < 0) continue;
        const next = hopSlot * 1048576 + k;
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
    if (p.stack) continue;
    // (a route so long that this would hold it up: the rest counts as marked, which only makes its follower more careful)
    p.stack = performance.now() - stackBegan > STACK_MS ? true : await stacked(p);
  }

  let length = 0, seconds = 0;
  const points = new Float32Array(pts.length * 3), kinds = new Uint8Array(pts.length);
  pts.forEach((p, i) => {
    points[i * 3] = p.x; points[i * 3 + 1] = p.y; points[i * 3 + 2] = p.z; kinds[i] = p.kind | (p.stack ? STACKED : 0);
    if (i > 0) { const d = Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z); length += d; seconds += d / (p.kind & 1 ? swim : run); }
  });
  return { ok: true, points, kinds, length, seconds, expanded, tiles: slots.length };
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
        if (!c || c.rev !== nav.rev) { c = { map: nav.map, rev: nav.rev, have: new Set(nav.tiles) }; maps.set(nav.map, c); }
        ctx = c;
      }
      try { if (!out) out = await findRoute(m); } catch (err) { out = { ok: false, reason: String(err?.message ?? err) }; }
      out.type = 'route'; out.id = m.id; out.ms = Math.round(performance.now() - t0);
      self.postMessage(out, out.points ? [out.points.buffer, out.kinds.buffer] : []);
    });
  }
};
