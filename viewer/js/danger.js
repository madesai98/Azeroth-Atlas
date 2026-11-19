// Spawn zones: the ground around where creatures are stationed, so that what you are looking
// for can be found on the map.
//
// Positions (spawn points and patrol paths), level ranges and faction reactions come from the
// extractor (maps/<id>/creatures.bin). Each creature gets a circle whose radius is the distance
// it would notice you from at YOUR level, and a group ("band") by how its level compares with
// yours, so you can choose which groups are painted. Which creatures count is yours to say:
// the ones that attack your side on sight, the ones that leave you alone until you attack them,
// and the ones whose side the database does not record (new to this game: unconfirmed).
//
// They used to be "danger zones" that routes could be told to go round. Routes no longer look
// at them: a zone says where something spawns, not where it is at this moment, and going round
// every one of them made for long ways round things that were often not there.
import { unpackContainer, sectionView } from './formats.js';

/** Level groups, weakest first. Colours follow the game's own difficulty colours. */
export const BANDS = [
  { key: 'trivial', label: 'Trivial', hint: 'so far below you they give no experience', color: [150, 150, 150] },
  { key: 'easy', label: 'Easy', hint: '3 or more levels below you', color: [60, 200, 70] },
  { key: 'even', label: 'Even', hint: 'within 2 levels of you', color: [240, 210, 40] },
  { key: 'hard', label: 'Hard', hint: '3 to 4 levels above you', color: [245, 130, 30] },
  { key: 'deadly', label: 'Deadly', hint: '5 or more levels above you', color: [230, 40, 35] },
];

/**
 * Aggro distance in yards for a creature of `mobLevel` against a player of `playerLevel`:
 * about 20 yd at equal level, one yard more per level it is above you (less per level below),
 * never under 5 or over 45. This is the long-standing rule for this world; treat it as an
 * estimate (stealth, special creatures and server tuning can differ).
 */
export const aggroRadius = (playerLevel, mobLevel) => Math.max(5, Math.min(45, 20 + (mobLevel - playerLevel)));

// Highest creature level that is "grey" (no experience) to a player of this level.
function greyLevel(level) {
  if (level <= 5) return 0;
  if (level <= 39) return level - 5 - Math.floor(level / 10);
  if (level <= 59) return level - 1 - Math.floor(level / 5);
  return level - 9;
}

/**
 * Which group a creature falls in for this player. Elites and bosses count one group higher,
 * except when they are trivial: a grey elite is still no threat.
 */
export function bandOf(playerLevel, mobLevel, rank) {
  const d = mobLevel - playerLevel;
  let band = d >= 5 ? 4 : d >= 3 ? 3 : d >= -2 ? 2 : mobLevel > greyLevel(playerLevel) ? 1 : 0;
  if ((rank === 1 || rank === 2 || rank === 3) && band >= 1 && band < 4) band++;
  return band;
}

const CELL = 64;      // yards per lookup cell
const MAX_REACH = 60; // largest possible circle (45 yd aggro + margin)
const RANK_NAME = ['', 'elite', 'rare elite', 'boss', 'rare'];
const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

export class DangerLayer {
  constructor() {
    // (kinds: which creatures - hostile to you, neutral, side not recorded)
    this.settings = { enabled: false, level: 10, faction: 'alliance', bands: [false, true, true, true, true], margin: 5, kinds: { hostile: true, neutral: false, unconfirmed: false } };
    this.rev = 1;          // changes whenever the zones would look different
    this.data = null;      // creature data of the current map
    this.source = null;
  }

  /** Change settings; returns true if anything changed. */
  set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(this.settings[k]) !== JSON.stringify(v)) { this.settings[k] = v; changed = true; }
    }
    if (changed) { this.rev++; this.#classify(); }
    return changed;
  }

  get active() { return this.settings.enabled && !!this.data; }

  async load(map) {
    this.data = null;
    this.source = null;
    this.rev++;
    if (!map.creatures) return;
    const res = await fetch(`/data/maps/${map.id}/creatures.bin?v=${map.rev}`);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const c = unpackContainer(buf, 'WFC1');
    const ms = c.sections.get(1);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, ms.offset, ms.size)));
    const d = {
      creatures: meta.creatures,
      spawns: sectionView(c, 2, Float32Array), spawnCreature: sectionView(c, 3, Uint32Array),
      pathPoints: sectionView(c, 4, Float32Array), paths: sectionView(c, 5, Uint32Array),
      radius: new Float32Array(meta.creatures.length), band: new Int8Array(meta.creatures.length),
    };
    // Lookup grid over spawn points and patrol-path segments.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (let i = 0; i < d.spawns.length; i += 2) grow(d.spawns[i], d.spawns[i + 1]);
    for (let i = 0; i < d.pathPoints.length; i += 2) grow(d.pathPoints[i], d.pathPoints[i + 1]);
    if (!Number.isFinite(x0)) return;
    const nx = Math.floor((x1 - x0) / CELL) + 1, ny = Math.floor((y1 - y0) / CELL) + 1;
    const cellOf = (x, y) => Math.floor((y - y0) / CELL) * nx + Math.floor((x - x0) / CELL);
    // segments: [creature, ax, ay, bx, by]
    const segs = [];
    for (let p = 0; p < d.paths.length; p += 3) {
      const ci = d.paths[p], first = d.paths[p + 1], count = d.paths[p + 2];
      for (let k = 0; k < count - 1; k++) segs.push(ci, d.pathPoints[(first + k) * 2], d.pathPoints[(first + k) * 2 + 1], d.pathPoints[(first + k + 1) * 2], d.pathPoints[(first + k + 1) * 2 + 1]);
    }
    d.segs = new Float32Array(segs);
    const nSpawn = d.spawnCreature.length, nSeg = d.segs.length / 5;
    const counts = new Uint32Array(nx * ny + 1);
    const segCells = (s, fn) => {
      const o = s * 5;
      const cx0 = Math.floor((Math.min(d.segs[o + 1], d.segs[o + 3]) - x0) / CELL), cx1 = Math.floor((Math.max(d.segs[o + 1], d.segs[o + 3]) - x0) / CELL);
      const cy0 = Math.floor((Math.min(d.segs[o + 2], d.segs[o + 4]) - y0) / CELL), cy1 = Math.floor((Math.max(d.segs[o + 2], d.segs[o + 4]) - y0) / CELL);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * nx + cx);
    };
    for (let i = 0; i < nSpawn; i++) counts[cellOf(d.spawns[i * 2], d.spawns[i * 2 + 1]) + 1]++;
    for (let s = 0; s < nSeg; s++) segCells(s, (cell) => counts[cell + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const fill = counts.slice(0, nx * ny);
    const items = new Int32Array(counts[nx * ny]); // >= 0: spawn index, < 0: -(segment index) - 1
    for (let i = 0; i < nSpawn; i++) items[fill[cellOf(d.spawns[i * 2], d.spawns[i * 2 + 1])]++] = i;
    for (let s = 0; s < nSeg; s++) segCells(s, (cell) => { items[fill[cell]++] = -s - 1; });
    d.grid = { x0, y0, nx, ny, starts: counts, items };
    this.data = d;
    this.source = meta.source;
    this.#classify();
    this.rev++;
  }

  /** Work out each creature's group and circle radius for the current level / faction. */
  #classify() {
    const d = this.data;
    if (!d) return;
    const s = this.settings;
    const key = s.faction === 'horde' ? 'h' : 'a', mine = s.faction === 'horde' ? 2 : 1;
    for (let i = 0; i < d.creatures.length; i++) {
      const c = d.creatures[i];
      // Which kind it is to you: one whose side is not recorded (c.u: whether it attacks is a
      // guess), one that attacks your side on sight, one that is neutral. Friendly ones make no
      // zone, nor do those whose level is not known, nor the hostile ones standing inside one of
      // your own side's towns or cities (c.t says whose: practice targets, event helpers).
      // (a side that is known all the same - c.ks - is known: see #guess)
      const what = this.#guess(c) ? 'unconfirmed' : c[key] === 2 ? 'hostile' : c[key] === 1 ? 'neutral' : null;
      if (!what || !s.kinds?.[what] || !(c.max > 0) || (what === 'hostile' && c.t & mine)) { d.band[i] = -1; continue; }
      const band = bandOf(s.level, c.max, c.rank);
      d.band[i] = s.bands[band] ? band : -1;
      d.radius[i] = aggroRadius(s.level, c.max) + s.margin;
    }
  }

  /** Visit every active circle / path segment that could reach the rectangle. */
  #each(xa, ya, xb, yb, onSpawn, onSeg) {
    const d = this.data, g = d.grid;
    const cx0 = Math.max(0, Math.floor((xa - MAX_REACH - g.x0) / CELL)), cx1 = Math.min(g.nx - 1, Math.floor((xb + MAX_REACH - g.x0) / CELL));
    const cy0 = Math.max(0, Math.floor((ya - MAX_REACH - g.y0) / CELL)), cy1 = Math.min(g.ny - 1, Math.floor((yb + MAX_REACH - g.y0) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      for (let k = g.starts[cy * g.nx + cx], end = g.starts[cy * g.nx + cx + 1]; k < end; k++) {
        const it = g.items[k];
        if (it >= 0) { const ci = d.spawnCreature[it]; if (d.band[ci] >= 0) onSpawn(d.spawns[it * 2], d.spawns[it * 2 + 1], ci); }
        else {
          const o = (-it - 1) * 5, ci = d.segs[o];
          // a segment spanning several cells is listed in each; handle it from its first cell only
          if (d.band[ci] < 0) continue;
          const fx = Math.max(cx0, Math.floor((Math.min(d.segs[o + 1], d.segs[o + 3]) - g.x0) / CELL)), fy = Math.max(cy0, Math.floor((Math.min(d.segs[o + 2], d.segs[o + 4]) - g.y0) / CELL));
          if (fx === cx && fy === cy) onSeg(d.segs[o + 1], d.segs[o + 2], d.segs[o + 3], d.segs[o + 4], ci);
        }
      }
    }
  }

  /**
   * Paint the zones covering one terrain node into a square RGBA image (premultiplied, linear),
   * or return null when no zone touches it. The node spans world X [xN - size, xN] (north edge
   * first) and Y [yW - size, yW] (west edge first); texel (i, j) maps to (east, south).
   */
  rasterize(xN, yW, size, res = 256) {
    if (!this.active) return null;
    const d = this.data;
    const texel = size / res;
    const bands = new Int8Array(res * res).fill(-1);
    let any = false;
    const mark = (wx, wy, r, band) => {
      // world -> texel coordinates
      const ci = (yW - wy) / texel, cj = (xN - wx) / texel, rt = r / texel;
      const i0 = Math.max(0, Math.floor(ci - rt)), i1 = Math.min(res - 1, Math.ceil(ci + rt));
      const j0 = Math.max(0, Math.floor(cj - rt)), j1 = Math.min(res - 1, Math.ceil(cj + rt));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - ci, dy = j + 0.5 - cj;
        // a circle smaller than a texel still marks the texel its centre is in, so zones stay
        // visible when the map is zoomed far out
        if (dx * dx + dy * dy <= rt * rt || (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5)) {
          const o = j * res + i;
          if (band > bands[o]) { bands[o] = band; any = true; }
        }
      }
    };
    this.#each(xN - size, yW - size, xN, yW,
      (x, y, ci) => mark(x, y, d.radius[ci], d.band[ci]),
      (ax, ay, bx, by, ci) => {
        // sweep the circle along the patrol segment
        const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / Math.max(texel, d.radius[ci] * 0.5)));
        for (let k = 0; k <= steps; k++) mark(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, d.radius[ci], d.band[ci]);
      });
    if (!any) return null;
    const out = new Uint8Array(res * res * 4);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const b = bands[j * res + i];
      if (b < 0) continue;
      // outline where a higher group borders a lower one (or open ground)
      const edge = (i > 0 && bands[j * res + i - 1] < b) || (i < res - 1 && bands[j * res + i + 1] < b) || (j > 0 && bands[(j - 1) * res + i] < b) || (j < res - 1 && bands[(j + 1) * res + i] < b);
      const a = edge ? 0.9 : 0.2 + b * 0.045;
      const c = BANDS[b].color, o = (j * res + i) * 4;
      out[o] = Math.round(lin(c[0]) * a * 255); out[o + 1] = Math.round(lin(c[1]) * a * 255); out[o + 2] = Math.round(lin(c[2]) * a * 255); out[o + 3] = Math.round(a * 255);
    }
    return out;
  }

  /**
   * Zones covering a world point: { band, creatures: [{ name, min, max, rank, band, distance,
   * estimated (level guessed from its zone) }] }
   * (strongest first), or null when the point is clear of every selected group.
   */
  at(x, y) {
    if (!this.active) return null;
    const d = this.data;
    const hits = new Map();
    const hit = (ci, dist) => {
      if (dist > d.radius[ci]) return;
      const prev = hits.get(ci);
      if (!prev || dist < prev) hits.set(ci, dist);
    };
    this.#each(x, y, x, y,
      (sx, sy, ci) => hit(ci, Math.hypot(sx - x, sy - y)),
      (ax, ay, bx, by, ci) => {
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
        hit(ci, Math.hypot(ax + vx * t - x, ay + vy * t - y));
      });
    if (!hits.size) return null;
    const creatures = [...hits].map(([ci, distance]) => {
      const c = d.creatures[ci];
      return { name: c.name, min: c.min, max: c.max, rank: RANK_NAME[c.rank] ?? '', band: d.band[ci], distance, estimated: !!c.est, unconfirmed: this.#guess(c) };
    }).sort((p, q) => q.band - p.band || q.max - p.max);
    return { band: creatures[0].band, creatures };
  }

  /**
   * Is how this creature stands towards YOUR side a guess? `u` marks one with a side not
   * recorded; `ks` says which sides are known all the same (1 the Alliance's, 2 the Horde's:
   * the game's combat log, or Wowhead, said so by way of the Atlas database).
   */
  #guess(c) { return !!c.u && !((c.ks ?? 0) & (this.settings.faction === 'horde' ? 2 : 1)); }

  /** How many creatures of this map's data have no side recorded towards yours (0: none, or a map built before they were kept). */
  get unconfirmed() { return this.data ? this.data.creatures.reduce((n, c) => n + (this.#guess(c) ? 1 : 0), 0) : 0; }
}
