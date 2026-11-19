// The insides of the dungeons in the Atlas database: what following players through them
// teaches a copy of the map, sent on, put together with what every other copy learned, and
// handed back to all of them.
//
// Inside a dungeon the game hides where you are, and the map reads it off the minimap
// (server/minimap.js). Doing that it learns things of the dungeon itself that no file has:
//
//   a door     where you stand having come in, for a door the map's data does not have (the
//              reference database knows the original game's doors: not a new dungeon's, nor a
//              back way in). The trail of your way begins there, with no look through the plan.
//   a way      a step you took that the map's floors say nobody can take: a lift the reference
//              database does not have, a doorway its floors are shut at, a portal or a jump that
//              puts you somewhere else. The first time, the map does not believe the place it
//              finds you at until three pictures agree, and after a portal it has to look through
//              the whole plan for you - eight or nine seconds. Known, the far end of the way is
//              the first place it looks, and it has you with the next picture.
//   a check    where the game's combat log said you stood (exact, and late) against where the
//              minimap had put you at that moment, while you stood still: how far off the
//              minimap's place is, in each part of each dungeon. That is the measure of how well
//              all of this works in the game itself - and where copies agree that a part of a
//              plan sits a yard or two off, every copy's place there is put right by it.
//
// The lines they are sent as (collect.js sends them with the rest; publish.js, fold, takes
// them in), a fact a line, with nothing of a player in them - no name, no time, not which run:
//
//   d,<map>,<x>,<y>,<z or nothing>,<facing or nothing>,<times>
//   j,<map>,<x>,<y>,<z or nothing>,<x>,<y>,<z or nothing>,<times>      from, to
//   c,<map>,<cell north>,<cell west>,<checks>,<off north>,<off west>,<off>
//
// in the game's own yards (a height or a facing that is not known is left empty). `times` is how
// often this copy came in by that door, or went that way. A check's cell is 32 yards square
// (its number: the place over 32, rounded down); its figures are the mean of that many checks:
// how far north and west of the game's place the minimap's was, and how far off in all.
//
// What is believed (believed, below): a door that two copies have, or one copy came in by
// twice; a way that two copies went, or one copy three times - a single such finding may be the
// map having lost you and found you again, which looks the same; a part of a plan is moved only
// where two copies have ten checks each there and agree to within a yard.
//
// Published as one record per dungeon, /truth/place/b<n>/i<map> (records.js has the shape).
import fs from 'node:fs';
import path from 'node:path';

export const DOOR_SAME = 15;    // yards: two findings of a door this near each other are one door
export const WAY_SAME = 10;     // ...and of a way, at both its ends
export const WAY_TALL = 8;      // yards of height two findings of an end may differ by (where both are known)
export const CHECK_CELL = 32;   // yards: the square a dungeon's checks are kept by
export const CHECK_FIRST = 5;   // checks in a cell before anything is said of it
export const CHECK_SURE = 10;   // ...and before a copy's word on it counts towards moving anything
const CHECK_AGREE = 1;          // yards the copies' words on a cell may differ by
const CHECK_LEAST = 1, CHECK_MOST = 6; // yards: less is not worth moving anything by, more is not a plan sitting a little off
const MOST = { d: 12, j: 60, c: 600 }; // of each, the most kept of one dungeon
const MAP_MOST = 99999;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const yards = (v) => finite(v) && Math.abs(v) < 40000;
const r1 = (v) => String(Math.round(v * 10) / 10);
const r2 = (v) => String(Math.round(v * 100) / 100);
const orNothing = (v, f = r1) => (finite(v) ? f(v) : '');
/** A figure of a line: a number, or null where the place is empty (not known). Anything else: NaN. */
const figure = (s) => (s === '' || s === undefined ? null : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// ---- a line, written and read ---------------------------------------------------------------------

export const doorLine = (map, d) => `d,${map},${r1(d.x)},${r1(d.y)},${orNothing(d.z)},${orNothing(d.facing, r2)},${Math.min(9999, Math.max(1, d.n | 0))}`;
export const wayLine = (map, w) => `j,${map},${r1(w.a[0])},${r1(w.a[1])},${orNothing(w.a[2])},${r1(w.b[0])},${r1(w.b[1])},${orNothing(w.b[2])},${Math.min(9999, Math.max(1, w.n | 0))}`;
export const checkLine = (map, c) => `c,${map},${c.cx},${c.cy},${c.n},${r2(c.dx)},${r2(c.dy)},${r2(c.off)}`;

/**
 * One line as what it says - { k: 'd', map, x, y, z, facing, n }, { k: 'j', map, a: [x, y, z], b: [x, y, z], n },
 * { k: 'c', map, cx, cy, n, dx, dy, off } - or null: not a line of these kinds, or not a sound one.
 */
export function parsePlaceLine(line) {
  if (typeof line !== 'string' || line.length > 100) return null;
  const p = line.split(','), k = p[0], map = Number(p[1]);
  if (!whole(map, 1, MAP_MOST)) return null;
  const v = p.slice(2).map(figure);
  if (v.some((x) => Number.isNaN(x))) return null;
  if (k === 'd') {
    if (v.length !== 5 || !yards(v[0]) || !yards(v[1]) || (v[2] !== null && !yards(v[2])) || (v[3] !== null && Math.abs(v[3]) > 7) || !whole(v[4], 1, 9999)) return null;
    return { k, map, x: v[0], y: v[1], z: v[2], facing: v[3], n: v[4] };
  }
  if (k === 'j') {
    if (v.length !== 7 || ![v[0], v[1], v[3], v[4]].every(yards) || [v[2], v[5]].some((z) => z !== null && !yards(z)) || !whole(v[6], 1, 9999)) return null;
    return { k, map, a: [v[0], v[1], v[2]], b: [v[3], v[4], v[5]], n: v[6] };
  }
  if (k === 'c') {
    if (v.length !== 6 || !whole(v[0], -2000, 2000) || !whole(v[1], -2000, 2000) || !whole(v[2], CHECK_FIRST, 1e7) || ![v[3], v[4], v[5]].every((x) => finite(x) && Math.abs(x) <= 50) || v[5] < 0) return null;
    return { k, map, cx: v[0], cy: v[1], n: v[2], dx: v[3], dy: v[4], off: v[5] };
  }
  return null;
}

/** Are two findings of a door the same door? Of a way the same way? */
export const sameDoor = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= DOOR_SAME && (!finite(a.z) || !finite(b.z) || Math.abs(a.z - b.z) <= WAY_TALL);
const sameEnd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= WAY_SAME && (!finite(a[2]) || !finite(b[2]) || Math.abs(a[2] - b[2]) <= WAY_TALL);
export const sameWay = (a, b) => sameEnd(a.a, b.a) && sameEnd(a.b, b.b);

// ---- what this copy has learned, as lines ---------------------------------------------------------

/**
 * The lines of what this copy's map has noted of the dungeons (server/minimap-places.js keeps
 * it in <dataDir>/user: dungeon-doors.json, dungeon-ways.json, dungeon-checks.json). Only what
 * is sound passes; a file that is not there, or broken, gives no lines.
 */
export function placeLines(dataDir) {
  const lines = [];
  const read = (name) => { try { const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'user', name), 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; } };
  const maps = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).filter(([m]) => /^\d{1,5}$/.test(m) && +m >= 1).map(([m, v]) => [+m, v]) : []);
  const add = (line) => { if (parsePlaceLine(line)) lines.push(line); };
  for (const [map, list] of maps(read('dungeon-doors.json')?.doors)) {
    for (const d of Array.isArray(list) ? list.slice(0, MOST.d) : []) if (d && yards(d.x) && yards(d.y)) add(doorLine(map, { x: d.x, y: d.y, z: d.z, facing: d.facing, n: whole(d.n, 1, 9999) ? d.n : 1 }));
  }
  for (const [map, list] of maps(read('dungeon-ways.json')?.ways)) {
    for (const w of Array.isArray(list) ? list.slice(0, MOST.j) : []) if (w && Array.isArray(w.a) && Array.isArray(w.b) && [w.a[0], w.a[1], w.b[0], w.b[1]].every(yards) && whole(w.n, 1, 9999)) add(wayLine(map, w));
  }
  for (const [map, cells] of maps(read('dungeon-checks.json')?.cells)) {
    for (const [key, c] of Object.entries(cells && typeof cells === 'object' ? cells : {}).slice(0, MOST.c)) {
      const m = /^(-?\d{1,4}):(-?\d{1,4})$/.exec(key);
      // (what is sent of a cell is its figures as they stood when its checks last doubled: the same line until they double again)
      if (m && Array.isArray(c) && whole(c[4], CHECK_FIRST, 1e7) && [c[5], c[6], c[7]].every(finite)) add(checkLine(map, { cx: +m[1], cy: +m[2], n: c[4], dx: c[5], dy: c[6], off: c[7] }));
    }
  }
  return lines;
}

// ---- everybody's lines put together ---------------------------------------------------------------

/**
 * What the copies have sent of the dungeons, put together.
 * @param byCopy  Map<copy's name, [its lines, in the order sent]> (lines of other kinds are passed over)
 * @returns Map<map, the dungeon's record: { d, w, c, a }> (records.js has the shape)
 */
export function foldPlaces(byCopy) {
  const maps = new Map(); // map -> { doors: [{ voices }], ways: [{ voices }], cells: Map<"cx:cy", voices> }
  const of = (map) => { let m = maps.get(map); if (!m) maps.set(map, (m = { doors: [], ways: [], cells: new Map(), checkers: new Set() })); return m; };
  for (const copy of [...byCopy.keys()].sort()) {
    // A copy's own word: of each door, way and cell, what it said with the highest count (its counts only ever grow).
    const own = new Map();
    const mine = (map) => { let m = own.get(map); if (!m) own.set(map, (m = { doors: [], ways: [], cells: new Map() })); return m; };
    for (const line of byCopy.get(copy) ?? []) {
      const p = parsePlaceLine(line);
      if (!p) continue;
      const m = mine(p.map);
      if (p.k === 'd') { const i = m.doors.findIndex((q) => sameDoor(q, p)); if (i < 0) m.doors.push(p); else if (p.n >= m.doors[i].n) m.doors[i] = p; }
      else if (p.k === 'j') { const i = m.ways.findIndex((q) => sameWay(q, p)); if (i < 0) m.ways.push(p); else if (p.n >= m.ways[i].n) m.ways[i] = p; }
      else { const key = `${p.cx}:${p.cy}`, had = m.cells.get(key); if (!had || p.n >= had.n) m.cells.set(key, p); }
    }
    for (const [map, m] of own) {
      const all = of(map);
      for (const d of m.doors.slice(0, MOST.d)) { const at = all.doors.find((q) => sameDoor(q.voices[0], d)); if (at) at.voices.push(d); else all.doors.push({ voices: [d] }); }
      for (const w of m.ways.slice(0, MOST.j)) { const at = all.ways.find((q) => sameWay(q.voices[0], w)); if (at) at.voices.push(w); else all.ways.push({ voices: [w] }); }
      for (const [key, c] of m.cells) { let v = all.cells.get(key); if (!v) all.cells.set(key, (v = [])); v.push(c); }
      if (m.cells.size) all.checkers.add(copy);
    }
  }
  // (a copy's word weighs by how often it found the thing, and never for more than five times: one copy does not carry the rest)
  const weight = (v) => Math.min(5, v.n);
  const mean = (voices, get) => { let s = 0, w = 0; for (const v of voices) { const x = get(v); if (finite(x)) { s += x * weight(v); w += weight(v); } } return w ? s / w : null; };
  const times = (voices) => voices.reduce((n, v) => n + v.n, 0);
  const rank = (a, b) => b.voices.length - a.voices.length || times(b.voices) - times(a.voices);
  const out = new Map();
  for (const [map, m] of maps) {
    const rec = {};
    const doors = m.doors.sort(rank).slice(0, MOST.d).map(({ voices }) => {
      const most = voices.reduce((b, v) => (finite(v.facing) && (!b || v.n > b.n) ? v : b), null);
      return [r1(mean(voices, (v) => v.x)), r1(mean(voices, (v) => v.y)), orNothing(mean(voices, (v) => v.z)), orNothing(most?.facing, r2), voices.length, times(voices)].join(',');
    });
    if (doors.length) rec.d = doors.join(' ');
    const ways = m.ways.sort(rank).slice(0, MOST.j).map(({ voices }) => [
      r1(mean(voices, (v) => v.a[0])), r1(mean(voices, (v) => v.a[1])), orNothing(mean(voices, (v) => v.a[2])),
      r1(mean(voices, (v) => v.b[0])), r1(mean(voices, (v) => v.b[1])), orNothing(mean(voices, (v) => v.b[2])), voices.length, times(voices)].join(','));
    if (ways.length) rec.w = ways.join(' ');
    let checks = 0, offSum = 0;
    const cells = [...m.cells].map(([key, voices]) => {
      const n = voices.reduce((s, v) => s + v.n, 0);
      const dx = voices.reduce((s, v) => s + v.dx * v.n, 0) / n, dy = voices.reduce((s, v) => s + v.dy * v.n, 0) / n, off = voices.reduce((s, v) => s + v.off * v.n, 0) / n;
      // how many copies have checks enough there to count, and how far the furthest of those is from what they say together
      const sure = voices.filter((v) => v.n >= CHECK_SURE);
      const sx = sure.reduce((s, v) => s + v.dx, 0) / (sure.length || 1), sy = sure.reduce((s, v) => s + v.dy, 0) / (sure.length || 1);
      const spread = sure.reduce((s, v) => Math.max(s, Math.hypot(v.dx - sx, v.dy - sy)), 0);
      checks += n; offSum += off * n;
      return { key, n, text: [key.replace(':', ','), voices.length, n, r2(dx), r2(dy), r2(off), sure.length, r2(sure.length ? sx : 0), r2(sure.length ? sy : 0), r2(spread)].join(',') };
    }).sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1)).slice(0, MOST.c);
    if (cells.length) rec.c = cells.map((c) => c.text).join(' ');
    // (how far off the minimap's place is in this dungeon, over every check of every copy: [copies, checks, yards])
    if (checks) rec.a = [m.checkers.size, checks, Math.round((offSum / checks) * 100) / 100];
    if (Object.keys(rec).length) out.set(map, rec);
  }
  return out;
}

// ---- the published record, read -------------------------------------------------------------------

const rows = (text, width) => (typeof text === 'string' && text ? text.split(' ').map((row) => row.split(',').map(figure)).filter((v) => v.length >= width && !v.some((x) => Number.isNaN(x))) : []);

/**
 * A dungeon's record as lists: { doors: [{ x, y, z, facing, copies, times }], ways: [{ a: [x, y, z], b: [x, y, z],
 * copies, times }], cells: [{ cx, cy, copies, n, dx, dy, off, sure, sx, sy, spread }], checked: { copies, n, off } | null }.
 */
export function readPlace(rec) {
  const out = { doors: [], ways: [], cells: [], checked: null };
  if (!rec || typeof rec !== 'object') return out;
  for (const v of rows(rec.d, 6)) if (yards(v[0]) && yards(v[1]) && whole(v[4], 1, 1e6) && whole(v[5], 1, 1e9)) out.doors.push({ x: v[0], y: v[1], z: v[2], facing: v[3], copies: v[4], times: v[5] });
  for (const v of rows(rec.w, 8)) if ([v[0], v[1], v[3], v[4]].every(yards) && whole(v[6], 1, 1e6) && whole(v[7], 1, 1e9)) out.ways.push({ a: [v[0], v[1], v[2]], b: [v[3], v[4], v[5]], copies: v[6], times: v[7] });
  for (const v of rows(rec.c, 11)) if (v.every(finite) && whole(v[0], -2000, 2000) && whole(v[1], -2000, 2000)) out.cells.push({ cx: v[0], cy: v[1], copies: v[2], n: v[3], dx: v[4], dy: v[5], off: v[6], sure: v[7], sx: v[8], sy: v[9], spread: v[10] });
  if (Array.isArray(rec.a) && rec.a.length === 3 && rec.a.every(finite)) out.checked = { copies: rec.a[0], n: rec.a[1], off: rec.a[2] };
  return out;
}

/** What of a dungeon's record is gone by: see the head of this file. */
export const believed = {
  door: (d) => d.copies >= 2 || d.times >= 2,
  way: (w) => w.copies >= 2 || w.times >= 3,
  /** How far north and west of the truth the minimap's place is in a cell, where the copies agree on it: [north, west] - or null. */
  shift: (c) => { const far = Math.hypot(c.sx, c.sy); return c.sure >= 2 && c.spread <= CHECK_AGREE && far >= CHECK_LEAST && far <= CHECK_MOST ? [c.sx, c.sy] : null; },
};

/**
 * The dungeons as the database has them, as last fetched (<dataDir>/atlasdb/truth-place.json):
 * Map<map, readPlace()'s lists> - empty where nothing has been fetched.
 */
export function readPlaces(dataDir) {
  const out = new Map();
  let parts = null;
  try { parts = JSON.parse(fs.readFileSync(path.join(dataDir, 'atlasdb', 'truth-place.json'), 'utf8')); } catch { return out; }
  for (const part of Object.values(parts && typeof parts === 'object' ? parts : {})) {
    for (const [key, rec] of Object.entries(part && typeof part === 'object' ? part : {})) {
      const map = Number(String(key).slice(1));
      if (whole(map, 1, MAP_MOST)) out.set(map, readPlace(rec));
    }
  }
  return out;
}
