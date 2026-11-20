// What is known of the insides of the dungeons beyond the map's own data: learned here, from
// following you through them (minimap.js), and learned by every other copy of the map, as the
// Atlas database has put it together (atlasdb/places.js says what, and what of it is believed).
//
//   the doors   where you stand having come in. The game's own spots (world.json: entrances, from
//               the reference database); those this copy found you at, coming in by a door that
//               is not among them (<dataDir>/user/dungeon-doors.json); and those other copies found.
//   the ways    steps the map's floors say nobody can take, and somebody took: a lift the map
//               does not have, a doorway its floors are shut at, a portal. This copy's own
//               (<dataDir>/user/dungeon-ways.json: gone by once it has seen one twice - once may
//               be the map having lost you and found you again), and those other copies went.
//   the checks  how far the minimap's place was from where the game's combat log had you, while
//               you stood still, by the part of the dungeon (<dataDir>/user/dungeon-checks.json:
//               sums, a square of 32 yards a line). Where a copy's checks say that the minimap's
//               place is off one way in a part of a dungeon, the place given there is put right.
//
// The three files hold facts of the dungeons and nothing of you but that you were once there:
// no time (a door has the day it was first found, which stays here), no character, no run. They
// go to the Atlas database with the rest of what this copy learns (atlasdb/collect.js), under
// the same switch.
import fs from 'node:fs';
import path from 'node:path';
import { note } from './log.js';
import { readPlaces, believed, sameDoor, sameWay, CHECK_CELL, CHECK_FIRST, DOOR_SAME } from '../atlasdb/places.js';

const LOOK = 60000;      // ms between looks at whether the map's data or the database has changed on the disk
const KEEP = 20000;      // ms: the checks are written down no more often than this
const DOORS_MOST = 6;    // doors kept of one dungeon
const WAYS_MOST = 40;    // ...and ways
const WAY_OWN = 2;       // times this copy has to have gone a way before it goes by it on its own word
const CHECK_MOST = 6;    // yards: a check further off than this is the minimap having you in the wrong place, not a little off

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => (finite(v) ? Math.round(v * 10) / 10 : null);
const r3 = (v) => (finite(v) ? Math.round(v * 1000) / 1000 : null);
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; } };

export class Places {
  /** @param onNew  () => called when something was learned that is worth sending on */
  constructor(dataDir, { onNew = null } = {}) {
    this.dataDir = dataDir;
    this.onNew = onNew;
    this.world = null;    // the game's own doors: { at, stamp, by: Map<map, [door]> }
    this.shared = null;   // what the database has: { at, stamp, by: Map<map, { doors, ways, shifts: Map<"cx:cy", [north, west]> }> }
    this.own = null;      // what this copy has noted: { doors: { [map]: [...] }, ways: { [map]: [...] }, cells: { [map]: { "cx:cy": [...] } } }
    this.dirty = false; this.savedAt = 0;
  }

  #file(name) { return path.join(this.dataDir, 'user', name); }

  #mine() {
    if (this.own) return this.own;
    const read = (name, key) => { try { const j = JSON.parse(fs.readFileSync(this.#file(name), 'utf8')); return j && typeof j === 'object' && j[key] && typeof j[key] === 'object' ? j[key] : {}; } catch { return {}; } };
    this.own = { doors: read('dungeon-doors.json', 'doors'), ways: read('dungeon-ways.json', 'ways'), cells: read('dungeon-checks.json', 'cells') };
    return this.own;
  }

  #write(name, value) {
    try {
      fs.mkdirSync(path.join(this.dataDir, 'user'), { recursive: true });
      const file = this.#file(name), tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, name === 'dungeon-checks.json' ? 0 : 1));
      fs.renameSync(tmp, file);
      return true;
    } catch (err) { note('minimap', 'what was learned of a dungeon could not be written down', { file: name, error: err.message }); return false; }
  }

  #told() { try { this.onNew?.(); } catch { /* its own affair */ } }

  /** The game's own doors (world.json: entrances - looked at again when that file changes, once a minute at the most). */
  #doorsOfTheGame(map) {
    const t = Date.now();
    if (!this.world || t - this.world.at > LOOK) {
      const file = path.join(this.dataDir, 'world.json'), stamp = stampOf(file);
      if (!this.world || this.world.stamp !== stamp) {
        const by = new Map();
        try {
          for (const e of JSON.parse(fs.readFileSync(file, 'utf8')).entrances ?? []) {
            if (!Number.isInteger(e.map) || !Array.isArray(e.pos) || !e.pos.slice(0, 2).every(Number.isFinite)) continue;
            if (!by.has(e.map)) by.set(e.map, []);
            by.get(e.map).push({ x: e.pos[0], y: e.pos[1], z: finite(e.pos[2]) ? e.pos[2] : null, facing: finite(e.facing) ? e.facing : null });
          }
        } catch { /* none known */ }
        this.world = { at: t, stamp, by };
      } else this.world.at = t;
    }
    return this.world.by.get(map) ?? [];
  }

  /** What the database has of a dungeon, as far as it is believed (looked at again when the fetched file changes). */
  #fromOthers(map) {
    const t = Date.now();
    if (!this.shared || t - this.shared.at > LOOK) {
      const stamp = stampOf(path.join(this.dataDir, 'atlasdb', 'truth-place.json'));
      if (!this.shared || this.shared.stamp !== stamp) {
        const by = new Map();
        for (const [m, p] of stamp ? readPlaces(this.dataDir) : []) {
          const shifts = new Map();
          for (const c of p.cells) { const s = believed.shift(c); if (s) shifts.set(`${c.cx}:${c.cy}`, s); }
          by.set(m, { doors: p.doors.filter(believed.door), ways: p.ways.filter(believed.way), shifts, checked: p.checked });
        }
        this.shared = { at: t, stamp, by };
      } else this.shared.at = t;
    }
    return this.shared.by.get(map) ?? null;
  }

  /** The doors of a dungeon: where you stand having come in - [{ x, y, z (or null), facing (or null) }]. */
  doors(map) {
    const out = [...this.#doorsOfTheGame(map)];
    const add = (d) => { if (finite(d.x) && finite(d.y) && !out.some((o) => Math.hypot(o.x - d.x, o.y - d.y) <= DOOR_SAME / 3)) out.push({ x: d.x, y: d.y, z: finite(d.z) ? d.z : null, facing: finite(d.facing) ? d.facing : null }); };
    const own = this.#mine().doors[map];
    for (const d of Array.isArray(own) ? own : []) if (d) add(d);
    for (const d of this.#fromOthers(map)?.doors ?? []) add(d);
    return out;
  }

  /** The ways of a dungeon that its floors do not have: [{ a: [x, y, z or null], b: [x, y, z or null] }], from a to b. */
  ways(map) {
    const out = [];
    const own = this.#mine().ways[map];
    for (const w of Array.isArray(own) ? own : []) if (w && Array.isArray(w.a) && Array.isArray(w.b) && w.n >= WAY_OWN) out.push({ a: w.a, b: w.b });
    for (const w of this.#fromOthers(map)?.ways ?? []) if (!out.some((o) => sameWay(o, w))) out.push({ a: w.a, b: w.b });
    return out;
  }

  /**
   * How far north and west of the truth the minimap's place is taken to be at a spot, by what
   * the copies' checks say: [north, west] to take off it - or null: nothing is known to be off there.
   * (Between the middles of the squares it is passed from one's figure to the next's, so that a
   * place does not jump at an edge.)
   */
  shift(map, x, y) {
    const shifts = this.#fromOthers(map)?.shifts;
    if (!shifts?.size) return null;
    const u = x / CHECK_CELL - 0.5, v = y / CHECK_CELL - 0.5, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    let north = 0, west = 0, any = false;
    for (const [di, dj, w] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
      const s = shifts.get(`${i + di}:${j + dj}`);
      if (s && w > 0) { north += s[0] * w; west += s[1] * w; any = true; }
    }
    return any ? [north, west] : null;
  }

  /**
   * You were found standing where you had just come in: { x, y, z (or null), facing (or null) }.
   * A door the game's own data has is left at that. Any other is noted - the first time, to begin
   * at when you next come in by it; again, as borne out (and where it is, as the middle of the findings).
   * @returns 'known' | 'new' | 'again'
   */
  cameIn(map, at) {
    if (!finite(at?.x) || !finite(at?.y)) return 'known';
    if (this.#doorsOfTheGame(map).some((d) => Math.hypot(d.x - at.x, d.y - at.y) <= DOOR_SAME)) return 'known';
    const own = this.#mine(), list = Array.isArray(own.doors[map]) ? own.doors[map] : (own.doors[map] = []);
    const had = list.find((d) => d && sameDoor(d, at));
    if (had) {
      const n = (Number.isInteger(had.n) && had.n > 0 ? had.n : 1) + 1, k = Math.min(n, 8);
      had.x = r1(had.x + (at.x - had.x) / k); had.y = r1(had.y + (at.y - had.y) / k);
      if (finite(at.z)) had.z = r1(finite(had.z) ? had.z + (at.z - had.z) / k : at.z);
      if (finite(at.facing)) had.facing = r3(at.facing);
      had.n = n;
    } else {
      list.push({ x: r1(at.x), y: r1(at.y), ...(finite(at.z) ? { z: r1(at.z) } : {}), facing: r3(at.facing), n: 1, at: new Date().toISOString().slice(0, 10) });
      // (no more than a few of one dungeon: the one found least often goes, the oldest of those)
      while (list.length > DOORS_MOST) { let least = 0; for (let i = 1; i < list.length - 1; i++) if ((list[i].n ?? 1) < (list[least].n ?? 1)) least = i; list.splice(least, 1); }
    }
    if (this.#write('dungeon-doors.json', { v: 1, doors: own.doors })) this.#told();
    return had ? 'again' : 'new';
  }

  /**
   * You went from one place to another that the map's floors do not lead to, and the place you
   * came to held: from, to as [x, y, z or null]. Noted, or counted once more.
   * @returns how often this copy has now gone that way
   */
  went(map, from, to) {
    if (![from?.[0], from?.[1], to?.[0], to?.[1]].every(finite)) return 0;
    const own = this.#mine(), list = Array.isArray(own.ways[map]) ? own.ways[map] : (own.ways[map] = []);
    const w = { a: [r1(from[0]), r1(from[1]), r1(from[2])], b: [r1(to[0]), r1(to[1]), r1(to[2])] };
    const had = list.find((o) => o && Array.isArray(o.a) && Array.isArray(o.b) && sameWay(o, w));
    if (had) {
      had.n = (Number.isInteger(had.n) && had.n > 0 ? had.n : 1) + 1;
      const k = Math.min(had.n, 8);
      for (const end of ['a', 'b']) for (let i = 0; i < 3; i++) { const now = w[end][i], was = had[end][i]; had[end][i] = finite(now) ? r1(finite(was) ? was + (now - was) / k : now) : finite(was) ? was : null; }
    } else {
      list.push({ ...w, n: 1 });
      while (list.length > WAYS_MOST) { let least = 0; for (let i = 1; i < list.length - 1; i++) if ((list[i].n ?? 1) < (list[least].n ?? 1)) least = i; list.splice(least, 1); }
    }
    if (this.#write('dungeon-ways.json', { v: 1, ways: own.ways })) this.#told();
    return had ? had.n : 1;
  }

  /**
   * A check: the game's combat log had you at (x, y), and the minimap's place - as it was found,
   * before anything was taken off it - was (north, west) yards from that, while you stood still.
   * Summed up by the square of the dungeon it was in.
   */
  checked(map, x, y, north, west) {
    const off = Math.hypot(north, west);
    if (![x, y, north, west].every(finite) || off > CHECK_MOST || !Number.isInteger(map) || map < 1) return;
    const own = this.#mine(), cells = own.cells[map] && typeof own.cells[map] === 'object' ? own.cells[map] : (own.cells[map] = {});
    const key = `${Math.floor(x / CHECK_CELL)}:${Math.floor(y / CHECK_CELL)}`;
    // [checks, sum north, sum west, sum off, and as they stood when last told of: checks, mean north, mean west, mean off]
    const c = Array.isArray(cells[key]) && cells[key].length === 8 && cells[key].every(finite) ? cells[key] : (cells[key] = [0, 0, 0, 0, 0, 0, 0, 0]);
    c[0]++; c[1] = r3(c[1] + north); c[2] = r3(c[2] + west); c[3] = r3(c[3] + off);
    this.dirty = true;
    // (told of when there are five, and again each time there are twice as many: the same word in between)
    if (c[0] >= CHECK_FIRST && c[0] >= 2 * c[4]) { c[4] = c[0]; c[5] = r3(c[1] / c[0]); c[6] = r3(c[2] / c[0]); c[7] = r3(c[3] / c[0]); this.save(true); this.#told(); }
    else this.save(false);
  }

  /** Write the checks down (they come many a fight: not each on its own). */
  save(now = false) {
    if (!this.dirty || !this.own || (!now && Date.now() - this.savedAt < KEEP)) return;
    this.savedAt = Date.now();
    if (this.#write('dungeon-checks.json', { v: 1, cells: this.own.cells })) this.dirty = false;
  }

  /** In figures, for the page and for a report of a problem. */
  status(map) {
    const own = this.#mine(), others = this.#fromOthers(map);
    const cells = Object.values(own.cells[map] ?? {}).filter(Array.isArray);
    const n = cells.reduce((s, c) => s + (c[0] || 0), 0), off = cells.reduce((s, c) => s + (c[3] || 0), 0);
    return {
      doors: { game: this.#doorsOfTheGame(map).length, own: (own.doors[map] ?? []).length, others: others?.doors.length ?? 0 },
      ways: { own: (own.ways[map] ?? []).length, goneBy: this.ways(map).length, others: others?.ways.length ?? 0 },
      checks: { own: n, off: n ? Math.round((off / n) * 100) / 100 : null, others: others?.checked ?? null, shifted: others?.shifts.size ?? 0 },
    };
  }
}
