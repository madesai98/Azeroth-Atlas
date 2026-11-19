// What the Atlas database knows beyond QuestieDB, laid over it for the map.
//
// The map's creatures, NPCs and quests are built from QuestieDB, with heights from the
// reference database. The Atlas database (atlasdb/) puts those two together with what no
// single one of them has: what the game's server told the copies' games (its cache), where
// players stood beside someone, what the game's combat log said of the creatures fought (where
// they were, their level and health, whose side they are on), and Wowhead's database for this
// game. Every copy fetches it (<dataDir>/atlasdb/truth-*.json) - and until this file was
// written, the map made no use of it: a creature only Wowhead could place, or that only another
// player had met, was in the database and not on anybody's map.
//
// So before the map is built, the database as last fetched is laid over QuestieDB as it was
// read. What is believed, field by field:
//
//   the game's own word      what its cache, a sighting or its combat log said ('g', 's', 'l' in
//                            a record's `src`): believed before QuestieDB. The server calls a
//                            creature "Searing Lava Spider" where QuestieDB has "Greater Lava
//                            Spider": the map says what the game says.
//   QuestieDB, as on this    next. It is the copy on this disk that is read, which may be newer
//   disk                     than the one the database was made from: where it says something,
//                            that stands.
//   everything else          what Wowhead or the reference database gave ('w', 'c') fills in
//                            where QuestieDB says nothing: a level it has as 0, a creature it
//                            does not place, one it does not list at all.
//
// A creature, object or quest QuestieDB does not have is added whole. Nothing is taken away.
// What is added to a creature beyond QuestieDB's own fields (jobs/npcs.js reads them):
//
//   type    the kind of creature it is, by the game's numbers (1 beast ... 10 not specified)
//   react   how it stands towards [the Alliance, the Horde]: 1 friendly, 0 neutral, -1 hostile,
//           -2 not known - for the creatures no faction is recorded for
//   hp      [health at its lowest level, at its highest], measured in fights where it was
//   seen    [{ map, x, y, z, n }]: where players stood beside it and talked (n: how many said so)
//   flat    [{ map, x, y }]: where fights with it began, with no height (the map finds one)
//   boss    1: the game's cache marks it a leader
//
// With no database fetched yet (a copy that has never been online, or has it switched off),
// nothing is laid over and the map is built from QuestieDB as before.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ATLAS_VERSION = 4; // raise when what is laid over changes
const SCHEMA = 1;               // of the database's records (atlasdb/records.js)
const GAME = new Set(['g', 's', 'l']);

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * Which database this disk holds: { rev, hash } - or null where none has been fetched. The hash
 * is of what is in it (the fingerprints of its parts), so the same records under another
 * number are the same database. Reads one small file.
 */
export function atlasStamp(dataDir) {
  const meta = readJson(path.join(dataDir, 'atlasdb', 'truth-meta.json'));
  if (!meta || meta.schema !== SCHEMA || !meta.shards) return null;
  const hash = crypto.createHash('sha1').update(JSON.stringify(['npc', 'object', 'quest'].map((k) => Object.entries(meta.shards[k] ?? {}).sort()))).digest('hex').slice(0, 16);
  return { rev: meta.rev ?? 0, hash };
}

/**
 * The database as last fetched: { rev, hash, npc: Map<id, record>, object: Map, quest: Map } -
 * or null where there is none (or one this version cannot read).
 */
export function readAtlas(dataDir) {
  const stamp = atlasStamp(dataDir);
  if (!stamp) return null;
  const out = { ...stamp, npc: new Map(), object: new Map(), quest: new Map() };
  for (const kind of ['npc', 'object', 'quest']) {
    const parts = readJson(path.join(dataDir, 'atlasdb', `truth-${kind}.json`));
    if (!parts || typeof parts !== 'object') return null;
    for (const part of Object.values(parts)) {
      for (const [key, rec] of Object.entries(part ?? {})) {
        const id = Number(key.slice(1));
        if (Number.isInteger(id) && id > 0 && rec && typeof rec === 'object') out[kind].set(id, rec);
      }
    }
  }
  return out;
}

const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
/** { z12: "x,y x,y" } as QuestieDB has spots: Map<zone, [[x, y], ...]>, or null. */
function zoned(at) {
  if (!at || typeof at !== 'object') return null;
  const out = new Map();
  for (const [key, text] of Object.entries(at)) {
    const zone = Number(key.slice(1));
    // (u<a continent's map>: pins on the continent's own map - see wide)
    if (key[0] !== 'z' || !Number.isInteger(zone) || typeof text !== 'string' || !text) continue;
    const points = text.split(' ').map((p) => p.split(',').map(Number)).filter((p) => p.length >= 2 && p.every(Number.isFinite));
    if (points.length) out.set(zone, points);
  }
  return out.size ? out : null;
}
/**
 * { u1415: "x,y ..." }: pins on a continent's own map (Wowhead has some creatures on no zone's
 * map, only there), in per cent of it, as flat places in the world: [{ map, x, y }]. A tenth of
 * a per cent of a continent is some 35 yards, so these say "about here" and no more; they are
 * used only for a creature nothing else places.
 * @param zones  world.json's zones (the continents' own maps are among them, with what of the world each shows)
 */
function wide(at, zones) {
  const out = [];
  if (!at || typeof at !== 'object' || !Array.isArray(zones)) return out;
  for (const [key, text] of Object.entries(at)) {
    if (key[0] !== 'u' || typeof text !== 'string') continue;
    const z = zones.find((c) => c.uiMap === Number(key.slice(1)) && c.type === 2 && Array.isArray(c.region));
    if (!z) continue;
    for (const p of text.split(' ')) {
      const [across, down] = p.split(',').map(Number);
      if (![across, down].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) continue;
      out.push({ map: z.map, x: Math.round((z.region[2] - (down / 100) * (z.region[2] - z.region[0])) * 10) / 10, y: Math.round((z.region[3] - (across / 100) * (z.region[3] - z.region[1])) * 10) / 10 });
    }
  }
  return out;
}
/** { m0: "x,y,z,n ..." } as a list of { map, x, y, z, n } (`width`: how many numbers a spot has at least). */
function spots(per, width) {
  const out = [];
  if (!per || typeof per !== 'object') return out;
  for (const [key, text] of Object.entries(per)) {
    const map = Number(key.slice(1));
    if (!Number.isInteger(map) || map < 0 || typeof text !== 'string') continue;
    for (const p of text.split(' ')) {
      const v = p.split(',').map(Number);
      if (v.length < width || !v.slice(0, width).every((x) => Number.isFinite(x) && Math.abs(x) < 40000)) continue;
      out.push(width === 2 ? { map, x: v[0], y: v[1] } : { map, x: v[0], y: v[1], z: v[2], n: v[3] > 0 ? v[3] : 1 });
    }
  }
  return out;
}

/**
 * Lay the database over QuestieDB as it was read. `db` (from readQuestie()) is changed in place.
 * @returns what was done, in numbers: { rev, creatures: { added, named, levelled, placed, sided, measured, seen, fought }, objects: {...}, quests: {...} }
 */
export function layOver(db, atlas, zones = null) {
  const said = { rev: atlas.rev, creatures: { added: 0, named: 0, levelled: 0, placed: 0, sided: 0, measured: 0, seen: 0, fought: 0 }, objects: { added: 0, named: 0, placed: 0, seen: 0 }, quests: { added: 0, given: 0, taken: 0, counted: 0 } };
  const game = (rec, field) => rec[field] !== undefined && GAME.has(rec.src?.[field]);

  // ---- creatures ----
  const c = said.creatures;
  const npcById = new Map(db.npcs.map((n) => [n.id, n]));
  for (const [id, r] of atlas.npc) {
    if (typeof r.n !== 'string' || !r.n) continue;
    let n = npcById.get(id);
    if (!n) {
      n = { id, name: r.n, minLevel: 0, maxLevel: 0, rank: 0, zone: 0, faction: 0, friendly: null, subName: null, flags: 0, spawns: null, paths: null, questStarts: [], questEnds: [], questGiver: false };
      db.npcs.push(n); npcById.set(id, n); c.added++;
    } else if (game(r, 'n') && r.n !== n.name) { n.name = r.n; c.named++; }
    if (typeof r.sub === 'string' && r.sub && (game(r, 'sub') || !n.subName)) n.subName = r.sub;
    if (!(n.maxLevel > 0) && Array.isArray(r.lv) && r.lv[1] > 0) { n.minLevel = r.lv[0] || r.lv[1]; n.maxLevel = r.lv[1]; c.levelled++; }
    if (Number.isInteger(r.rank) && (game(r, 'rank') || !n.rank)) n.rank = r.rank;
    if (!n.zone && Number.isInteger(r.zone)) n.zone = r.zone;
    if (!n.faction && Number.isInteger(r.fac)) n.faction = r.fac;
    if (!n.friendly && typeof r.fr === 'string') n.friendly = r.fr;
    if (!n.flags && Number.isInteger(r.flags)) n.flags = r.flags;
    if (!n.questStarts.length && ids(r.qs).length) n.questStarts = ids(r.qs);
    if (!n.questEnds.length && ids(r.qe).length) n.questEnds = ids(r.qe);
    n.questGiver = n.questStarts.length > 0 || n.questEnds.length > 0;
    if (!n.spawns) { const at = zoned(r.at); if (at) { n.spawns = at; if ([...at.values()].some((list) => list.some((p) => p[0] >= 0 && p[1] >= 0))) c.placed++; } }
    if (Number.isInteger(r.type) && r.type > 0) n.type = r.type;
    if (Array.isArray(r.react) && r.react.length === 2 && r.react.some((v) => v === 1 || v === 0 || v === -1)) { n.react = r.react; if (!n.faction) c.sided++; }
    if (Array.isArray(r.hp) && r.hp[1] > 0 && r.src?.hp === 'l') { n.hp = r.hp; c.measured++; }
    if (r.boss === 1) n.boss = 1;
    // (what its vendor's window showed, and its trainer's: the addon's notes, from every copy)
    if (Array.isArray(r.sells) && r.sells.length) n.sells = r.sells.filter((s) => Array.isArray(s) && Number.isInteger(s[0]));
    if (Array.isArray(r.teaches) && r.teaches.length) n.teaches = r.teaches.filter((s) => Array.isArray(s) && Number.isInteger(s[0]));
    const seen = spots(r.seen, 3);
    if (seen.length) { n.seen = seen; c.seen++; }
    const flat = spots(r.f, 2);
    if (flat.length) { n.flat = flat; c.fought++; }
    // (on a continent's own map only, and nothing else says where: about there)
    if (!n.flat && !n.seen && !(n.spawns && [...n.spawns.values()].some((list) => Array.isArray(list) && list.some((p) => p[0] >= 0 && p[1] >= 0)))) {
      const far = wide(r.at, zones);
      if (far.length) { n.flat = far; c.placed++; }
    }
  }

  // ---- objects ----
  const o = said.objects;
  const objById = new Map(db.objects.map((x) => [x.id, x]));
  for (const [id, r] of atlas.object) {
    if (typeof r.n !== 'string' || !r.n) continue;
    let x = objById.get(id);
    if (!x) { x = { id, name: r.n, zone: 0, questStarts: [], questEnds: [], spawns: null, faction: 0 }; db.objects.push(x); objById.set(id, x); o.added++; }
    else if (game(r, 'n') && r.n !== x.name) { x.name = r.n; o.named++; }
    if (!x.zone && Number.isInteger(r.zone)) x.zone = r.zone;
    if (!x.questStarts.length && ids(r.qs).length) x.questStarts = ids(r.qs);
    if (!x.questEnds.length && ids(r.qe).length) x.questEnds = ids(r.qe);
    if (!x.spawns) { const at = zoned(r.at); if (at) { x.spawns = at; if ([...at.values()].some((list) => list.some((p) => p[0] >= 0 && p[1] >= 0))) o.placed++; } }
    // (its kind and numbers as the server gave them to somebody's game: only the game's cache has
    // the numbers, and a kind from anywhere else is counted differently)
    if (Number.isInteger(r.type) && Array.isArray(r.data)) { x.type = r.type; x.data = r.data; }
    const seen = spots(r.seen, 3);
    if (seen.length) { x.seen = seen; o.seen++; }
  }

  // ---- quests ----
  const q = said.quests;
  const questById = new Map(db.quests.map((x) => [x.id, x]));
  const wanted = (list) => (Array.isArray(list) ? list.filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && p[0] > 0) : []);
  for (const [id, r] of atlas.quest) {
    if (typeof r.n !== 'string' || !r.n) continue;
    let x = questById.get(id);
    if (!x) {
      x = {
        id, name: r.n, level: r.l ?? 0, minLevel: r.m ?? 0, maxLevel: r.ml ?? 0, races: r.races ?? 0, classes: r.classes ?? 0,
        starts: { npcs: [], objects: [], items: [] }, ends: { npcs: [], objects: [] },
        text: Array.isArray(r.t) ? r.t.filter((t) => typeof t === 'string') : [],
        pre: ids(r.pre), preAll: ids(r.preAll), exclusive: ids(r.excl), next: r.nx ?? 0, parent: r.parent ?? 0, zoneOrSort: r.z ?? 0,
        flags: r.flags ?? 0, special: r.special ?? 0, sourceItem: r.srcItem ?? 0,
        objectives: { creatures: wanted(r.o?.n).map((p) => p[0]), objects: wanted(r.o?.o).map((p) => p[0]), items: wanted(r.o?.i).map((p) => p[0]), killCredit: [] },
        trigger: null,
      };
      db.quests.push(x); questById.set(id, x); q.added++;
    }
    if (!x.level && r.l > 0) x.level = r.l;
    if (!x.minLevel && r.m > 0) x.minLevel = r.m;
    const noGiver = !x.starts.npcs.length && !x.starts.objects.length && !x.starts.items.length;
    if (noGiver && r.s && (ids(r.s.n).length || ids(r.s.o).length || ids(r.s.i).length)) { x.starts = { npcs: ids(r.s.n), objects: ids(r.s.o), items: ids(r.s.i) }; q.given++; }
    if (!x.ends.npcs.length && !x.ends.objects.length && r.e && (ids(r.e.n).length || ids(r.e.o).length)) { x.ends = { npcs: ids(r.e.n), objects: ids(r.e.o) }; q.taken++; }
    // how many of each thing it asks for, as far as anybody has said (jobs/npcs.js, buildQuests: for the quests the reference database does not have)
    const needs = [];
    for (const kind of ['n', 'o', 'i']) for (const [what, many] of wanted(r.o?.[kind])) if (many > 0) needs.push([kind, what, many]);
    if (needs.length) { x.needs = needs; q.counted++; }
    // (where the game's own map puts it: buildQuests turns the pins into places)
    if (r.gp && typeof r.gp === 'object') x.pins = r.gp;
    if (Number.isInteger(r.type) && r.type > 0) x.type = r.type;
    if (Number.isInteger(r.limit) && r.limit > 0) x.limit = r.limit;
  }
  return said;
}
