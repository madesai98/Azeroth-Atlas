// Putting the Atlas database together, publishing it, and fetching it.
//
// In the database:
//
//   /meta                      what is published: its number (rev), when, how many of each kind,
//                              what it was made from, and a fingerprint of every shard
//   /truth/<kind>/b<n>/i<id>   the records (records.js): kind is npc, object or quest - or place,
//                              a dungeon with what the copies learned of its insides (places.js) -
//                              or yield, a band of things that can be disenchanted with what the
//                              copies' players got of it (yields.js) - or loot, a creature with
//                              what the copies' players found in its corpses (loot.js); a shard
//                              holds the ids n to n+499
//   /inbox/<copy>/<key>        what each copy of the map has sent (collect.js): added to, never
//                              changed. Everything published can be made again from these and
//                              the sources on the maker's own disk. Where several copies have
//                              sent the game's cache of the same thing, a vote settles each fact
//                              (vote).
//   /installs/<copy>           when a copy last sent something, and which version it runs
//
//   /questie                   QuestieDB itself, as it is published: the files the map is built
//                              from, put there by a scheduled function whenever a new version is
//                              out (functions/questie.js) and fetched by every copy (questiedb.js).
//                              No part of what is made or published here.
//
// Making it (buildTruth) reads QuestieDB and the reference database from the maker's own disk
// and every delivery in the inbox, and merges them record by record. Publishing writes only the
// shards whose records changed. A copy that fetches it (pull) asks for the fingerprints first
// and fetches only what differs from what it has.
import fs from 'node:fs';
import path from 'node:path';
import { findQuestieDb, readQuestie } from '../extractor/questie.js';
import { readReference, lootOf } from '../extractor/reference.js';
import { KINDS, PLACE, YIELD, SALE, COST, LOOT, PUBLISHED, SCHEMA, LAYERS, fromQuestie, fromReference, referenceLoot, mergeAll, shards, canonical, tidy, cacheSays } from './records.js';
import { foldPlaces } from './places.js';
import { readYieldLine, foldYields } from './yields.js';
import { readSaleLine, foldSales } from './sales.js';
import { readLootLine, takeLootLine, foldLoot } from './loot.js';
import { entries, SERVER_TIME } from './rtdb.js';

const SAME = 30;            // yards: sightings of one NPC this close together are the same spot
const FLATS = 400;          // the most places kept of one creature on one map, of those fights with it began at
const SOLD = 200;           // the most things kept of what one vendor sells
const TAUGHT = 400;         // ...and of what one trainer teaches
const PINS = 12;            // the most places kept of one kind of pin of a quest on one of the game's maps
const PIN_SAME = 1.5;       // per cent of the map: pins of a quest this close together are one pin
const LEVEL_SAME = 5;       // yards: two words on the level a creature was fought on this close together are of one spot
const LEVEL_APART = 4;      // ...and this far apart in height, they are of two levels (what most say is kept; a tie, nothing)
const REQUEST = 3 << 20;    // bytes of records to one request
const WHOLE = 40;           // shards wanted of one kind beyond which the whole kind is fetched at once

/**
 * Sources the maker of the database keeps on their own disk besides QuestieDB and the reference
 * database: each a file <dataDir>/atlasdb/layers/<name>.json, written by a tool of the maker's
 * own, already in the shape of the records (records.js):
 *
 *   { "v": 1, "code": "w", "name": "wowhead", "made": "2026-11-15T20:00:00Z",
 *     "npc": { "<id>": { fields } }, "object": { ... }, "quest": { ... } }
 *
 * `code` is the letter the source is known by in a record, and settles how far it is believed.
 * @returns [{ code, name, made, npc: Map, object: Map, quest: Map }]
 */
export function readLayers(dataDir, log = () => {}) {
  const dir = path.join(dataDir, 'atlasdb', 'layers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (d?.v !== 1 || !LAYERS.includes(d.code)) { log(`layers/${name}: not a source this version knows (v ${d?.v}, code "${d?.code}"): left out`); continue; }
      const layer = { code: d.code, name: typeof d.name === 'string' && d.name ? d.name : name.replace(/\.json$/i, ''), made: d.made ?? null, npc: new Map(), object: new Map(), quest: new Map() };
      for (const kind of KINDS) {
        for (const [key, rec] of Object.entries(d[kind] ?? {})) {
          const id = Number(String(key).replace(/^i/, ''));
          if (!Number.isInteger(id) || id <= 0 || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
          const fields = tidy(rec);
          if (Object.keys(fields).length) layer[kind].set(id, fields);
        }
      }
      out.push(layer);
    } catch (err) { log(`layers/${name}: not read (${err.message})`); }
  }
  return out;
}

/** The fields that are words: a cache in another language than English is sent without them (collect.js), and so says nothing about them. */
const WORDS = ['n', 'sub'];
const NOTHING = '(nothing)';
/** Which of two voices spoke later: by when the database took the delivery, then by the order of the deliveries, then by name (so that it is always the same one). */
const later = (a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.copy < b.copy ? -1 : a.copy > b.copy ? 1 : 0);

/**
 * What the game's cache says about one thing, where several copies have sent theirs. Every copy
 * is believed, and each has one voice: the last it said about the thing. Fact by fact:
 *
 *   one copy            what it says
 *   two copies          what the later one says
 *   three or more       what most say; where that is a tie, the side whose latest voice is the later
 *
 * A copy that has the thing and does not have a fact others give (no second name, no money for
 * the quest) says "there is none", and that is counted like any other answer: one copy cannot
 * add a fact of its own to what several agree on.
 * @param voices [{ copy, at, key, rec }], one per copy
 * @returns { rec, split: [{ field, said: [{ value, copies: [name], won }] }] } split: the facts they did not agree on
 */
export function vote(voices) {
  const order = [...voices].sort(later);
  const fields = new Set();
  for (const v of order) for (const f of Object.keys(v.rec)) fields.add(f);
  const rec = {}, split = [];
  for (const f of fields) {
    const sides = new Map(); // what is said -> { value, copies, last }
    order.forEach((v, i) => {
      const value = v.rec[f];
      const has = value !== undefined && value !== null;
      if (!has && WORDS.includes(f) && !('n' in v.rec)) return; // (sent without its words: no voice on them)
      const k = has ? canonical(value) : NOTHING;
      const side = sides.get(k) ?? { value: has ? value : undefined, copies: [], last: i };
      side.copies.push(v.copy); side.last = i;
      sides.set(k, side);
    });
    const ranked = [...sides.values()].sort((a, b) => b.copies.length - a.copies.length || b.last - a.last);
    if (!ranked.length) continue;
    if (ranked[0].value !== undefined) rec[f] = ranked[0].value;
    if (ranked.length > 1) split.push({ field: f, said: ranked.map((s, i) => ({ value: s.value ?? null, copies: s.copies, won: i === 0 })) });
  }
  return { rec, split };
}

/** What most of the copies say (each has one voice); of two said equally often, the larger - so that it is always the same one. */
function mostSaid(voices) {
  const count = new Map();
  for (const v of voices.values()) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
}

/**
 * What the copies have sent, put together: per kind the facts of the game's cache (settled by
 * vote where several copies have sent the same thing: vote()), the sightings, what the game's
 * combat log said of the creatures fought, and who reported what.
 *
 * The lines of a delivery's `seen` list, by their first letter (collect.js writes them):
 *   n,<id>,<map>,<x>,<y>,<z>     where an NPC stands, from someone who stood beside it and talked
 *   o,<id>,<map>,<x>,<y>,<z>     the same of an object
 *   f,<id>,<map>,<x>,<y>         where a creature was when a fight with it began (no height)
 *   l,<id>,<level>,<health>      a creature's health at a level, as the fight showed it
 *   r,<id>,<A or H>,<1, 0, -1>   how a creature stood towards a player of that side
 *   v,<id>,<item>,<copper>,<how many>,<1: stock is limited>   what a vendor sells, as its window showed
 *   t,<id>,<spell>,<copper>,<skill>,<skill level>,<level>     what a trainer teaches, and what it asks
 *   q,<quest>,<s, o or e>,<the game's map>,<x>,<y>            where the game's own map puts a quest:
 *                                where it starts, an objective, where it is handed in (per cent of that map)
 *   h,<id>,<map>,<x>,<y>,<z>     a spot of the map's own for a creature, and the height of the level
 *                                a player fought it on there (where the map had only guessed)
 *   d,... j,... c,...            of a dungeon: a door, a way its floors do not have, how far off the
 *                                minimap's place is (places.js has the three, and puts them together)
 *   y,<band>,<times>,<material>,<pieces>,...   what disenchanting things of a band gave, in all (yields.js)
 *   a,<item>,<house>,<hours>,...   what became of a copy's players' own auctions of an item; k,...: what a house took (sales.js)
 *   p,<creature>,<corpses>,<item>,<found in>,...   what a copy's players found in a creature's corpses; w,...: of what drops only with its quest (loot.js)
 * A line of any other kind is left out: a later version's, which this one does not know.
 * @param inbox what GET /inbox returned
 * @returns { cache, seen, logged, obs, copies, deliveries, splits: [{ kind, id, field, said }],
 *            places: Map<map, a dungeon's record>, yields: Map<band, what disenchanting it gave>,
 *            sales: Map<item, what became of the auctions of it>, costs: Map<1 | 2, what a house took>,
 *            loot: Map<copy, Map<creature, what it counted in that creature's corpses>> (put together by foldLoot) }
 */
export function fold(inbox) {
  const reports = { npc: new Map(), object: new Map(), quest: new Map() }; // id -> Map<copy, { copy, at, key, build, rec }>
  const spots = new Map(); // "n123:m0" -> [{ x, y, z, copies: Set }]
  const flats = new Map();  // "123:m0" -> [{ x, y, by: Map<copy, [x, y]> }]
  const levels = new Map(); // id -> Map<level, Map<copy, health>>
  const stands = new Map(); // id -> [Map<copy, how> towards the Alliance, the same towards the Horde]
  const sells = new Map();  // id -> Map<item, Map<copy, [copper, how many, limited]>>
  const teaches = new Map(); // id -> Map<spell, Map<copy, [copper, skill, skill level, level]>>
  const pins = new Map();   // "quest:s|o|e:the game's map" -> [{ x, y, by: Map<copy, [x, y]> }]
  const fought = new Map(); // "123:m0" -> [{ x, y, by: Map<copy, z> }]: the level a creature was fought on at a spot
  const ofPlaces = new Map(); // copy -> [its lines of the dungeons, in the order sent]
  const ofYields = new Map(); // copy -> Map<band, its count of what disenchanting gave: the one with the most disenchantings>
  const ofSales = new Map();  // copy -> Map<kind and key, its count of its own auctions: the one with the most auctions>
  const ofLoot = new Map();   // copy -> Map<creature, its count of what was in that creature's corpses: the largest of each figure>
  const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  let deliveries = 0;
  const copies = entries(inbox);
  for (const [copy, list] of copies) {
    for (const [key, b] of entries(list)) {
      if (!b || b.v !== 1) continue;
      deliveries++;
      const build = Number(b.build) || 0, at = Number(b.at) || 0;
      for (const kind of KINDS) {
        for (const [idKey, sent] of entries(b[kind])) {
          const id = Number(String(idKey).replace(/^i/, ''));
          if (!Number.isInteger(id) || id <= 0) continue;
          // (only what a cache can say: a delivery is believed as the game's cache, not as anything it likes)
          const rec = cacheSays(kind, sent);
          if (!Object.keys(rec).length) continue;
          let per = reports[kind].get(id);
          if (!per) reports[kind].set(id, (per = new Map()));
          // (a copy's voice about a thing is the last it said: what it sent before no longer counts)
          const now = { copy, at, key, build, rec };
          const had = per.get(copy);
          if (!had || later(had, now) <= 0) per.set(copy, now);
        }
      }
      for (const [, line] of entries(b.seen)) {
        const p = String(line).split(',');
        const k = p[0], id = +p[1], map = +p[2], x = +p[3], y = +p[4], z = +p[5];
        if (!Number.isInteger(id) || id <= 0) continue;
        if (k === 'd' || k === 'j' || k === 'c') {
          // of a dungeon: put together by places.js, a copy's lines in the order it sent them
          let mine = ofPlaces.get(copy);
          if (!mine) ofPlaces.set(copy, (mine = []));
          mine.push(String(line));
          continue;
        }
        if (k === 'y') {
          // what disenchanting gave: a line is all a copy has counted of a band so far, so its fullest line stands for the others
          const said = readYieldLine(p);
          if (!said) continue;
          let mine = ofYields.get(copy);
          if (!mine) ofYields.set(copy, (mine = new Map()));
          const had = mine.get(said.band);
          if (!had || said.n >= had.n) mine.set(said.band, said);
          continue;
        }
        if (k === 'a' || k === 'k') {
          // a copy's own auctions: a line is all it has counted so far, so its fullest line stands for the others
          const said = readSaleLine(p);
          if (!said) continue;
          let mine = ofSales.get(copy);
          if (!mine) ofSales.set(copy, (mine = new Map()));
          const had = mine.get(said.kind + said.key);
          if (!had || said.v[0] >= had.v[0]) mine.set(said.kind + said.key, said);
          continue;
        }
        if (k === 'p' || k === 'w') {
          // what was in a creature's corpses: a line is all a copy has counted so far, and every figure only grows
          const said = readLootLine(p);
          if (!said) continue;
          let mine = ofLoot.get(copy);
          if (!mine) ofLoot.set(copy, (mine = new Map()));
          takeLootLine(mine, said);
          continue;
        }
        if (k === 'h') {
          // the level a creature was fought on at a spot: a copy's later word on a spot stands for its earlier one
          if (p.length !== 6 || !Number.isInteger(map) || map < 0 || ![x, y, z].every((v) => Number.isFinite(v) && Math.abs(v) < 40000)) continue;
          const key = `${id}:m${map}`;
          let list2 = fought.get(key);
          if (!list2) fought.set(key, (list2 = []));
          const near = list2.find((s) => Math.hypot(s.x - x, s.y - y) < LEVEL_SAME);
          if (near) near.by.set(copy, z);
          else if (list2.length < FLATS) list2.push({ x, y, by: new Map([[copy, z]]) });
          continue;
        }
        if (k === 'f') {
          // where a creature was when a fight began: the same spot from several copies is one spot, in the middle of what they say
          if (!Number.isInteger(map) || map < 0 || ![x, y].every((v) => Number.isFinite(v) && Math.abs(v) < 40000)) continue;
          const key = `${id}:m${map}`;
          let list2 = flats.get(key);
          if (!list2) flats.set(key, (list2 = []));
          const near = list2.find((s) => Math.hypot(s.x - x, s.y - y) < SAME);
          if (near) {
            near.by.set(copy, [x, y]);
            const all = [...near.by.values()];
            near.x = all.reduce((a, v) => a + v[0], 0) / all.length; near.y = all.reduce((a, v) => a + v[1], 0) / all.length;
          } else if (list2.length < FLATS) list2.push({ x, y, by: new Map([[copy, [x, y]]]) });
          continue;
        }
        if (k === 'l') {
          const level = +p[2], health = +p[3];
          if (!Number.isInteger(level) || level < 1 || level > 99 || !Number.isInteger(health) || health < 1 || health > 2e9) continue;
          let by = levels.get(id);
          if (!by) levels.set(id, (by = new Map()));
          let voices = by.get(level);
          if (!voices) by.set(level, (voices = new Map()));
          voices.set(copy, health); // (a copy's later word on a level stands for its earlier one)
          continue;
        }
        if (k === 'r') {
          const side = p[2] === 'A' ? 0 : p[2] === 'H' ? 1 : -1, how = +p[3];
          if (side < 0 || ![1, 0, -1].includes(how)) continue;
          let both = stands.get(id);
          if (!both) stands.set(id, (both = [new Map(), new Map()]));
          both[side].set(copy, how);
          continue;
        }
        if (k === 'v' || k === 't') {
          // a vendor's goods or a trainer's lessons: each thing with what every copy saw asked for it
          const thing = +p[2], rest = p.slice(3).map(Number);
          const fits = k === 'v'
            ? rest.length === 3 && whole(rest[0], 0, 2e9) && whole(rest[1], 1, 10000) && (rest[2] === 0 || rest[2] === 1)
            : rest.length === 4 && whole(rest[0], 0, 2e9) && whole(rest[1], 0, 65535) && whole(rest[2], 0, 1000) && whole(rest[3], 0, 99);
          if (!whole(thing, 1, 16777215) || !fits) continue;
          const shelf = k === 'v' ? sells : teaches;
          let things = shelf.get(id);
          if (!things) shelf.set(id, (things = new Map()));
          let voices = things.get(thing);
          if (!voices) { if (things.size >= (k === 'v' ? SOLD : TAUGHT)) continue; things.set(thing, (voices = new Map())); }
          voices.set(copy, rest);
          continue;
        }
        if (k === 'q') {
          // a pin of the game's own map for a quest: the same pin from several copies is one, in the middle of what they say
          const what = p[2], ui = +p[3], px = +p[4], py = +p[5];
          if (!['s', 'o', 'e'].includes(what) || !whole(ui, 1, 99999) || ![px, py].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) continue;
          const key = `${id}:${what}:${ui}`;
          let list2 = pins.get(key);
          if (!list2) pins.set(key, (list2 = []));
          const near = list2.find((s) => Math.hypot(s.x - px, s.y - py) < PIN_SAME);
          if (near) {
            near.by.set(copy, [px, py]);
            const all = [...near.by.values()];
            near.x = all.reduce((a, v) => a + v[0], 0) / all.length; near.y = all.reduce((a, v) => a + v[1], 0) / all.length;
          } else if (list2.length < PINS) list2.push({ x: px, y: py, by: new Map([[copy, [px, py]]]) });
          continue;
        }
        if ((k !== 'n' && k !== 'o') || !Number.isInteger(map) || ![x, y, z].every(Number.isFinite)) continue;
        const key = `${k}${id}:m${map}`;
        let list2 = spots.get(key);
        if (!list2) spots.set(key, (list2 = []));
        const near = list2.find((s) => Math.hypot(s.x - x, s.y - y) < SAME);
        if (near) {
          // (one copy's newest word on a spot replaces its older one; several copies are averaged)
          near.by.set(copy, [x, y, z]);
          const all = [...near.by.values()];
          near.x = all.reduce((a, v) => a + v[0], 0) / all.length; near.y = all.reduce((a, v) => a + v[1], 0) / all.length; near.z = all.reduce((a, v) => a + v[2], 0) / all.length;
        } else list2.push({ x, y, z, by: new Map([[copy, [x, y, z]]]) });
      }
    }
  }
  const cache = { npc: new Map(), object: new Map(), quest: new Map() }, obs = { npc: new Map(), object: new Map(), quest: new Map() };
  const splits = [];
  for (const kind of KINDS) {
    for (const [id, per] of reports[kind]) {
      const voices = [...per.values()];
      const { rec, split } = vote(voices);
      for (const s of split) splits.push({ kind, id, ...s });
      // (a thing every one of whose facts was voted away is left to the other sources)
      if (Object.keys(rec).length) cache[kind].set(id, rec);
      obs[kind].set(id, { g: [per.size, Math.max(...voices.map((v) => v.build))] });
    }
  }
  const seen = { npc: new Map(), object: new Map() };
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const [key, list] of spots) {
    const m = /^([no])(\d+):(m-?\d+)$/.exec(key);
    const kind = m[1] === 'n' ? 'npc' : 'object', id = +m[2];
    const rec = seen[kind].get(id) ?? { seen: {} };
    rec.seen[m[3]] = list.map((s) => [r2(s.x), r2(s.y), r2(s.z), s.by.size].join(',')).join(' ');
    seen[kind].set(id, rec);
    const o = obs[kind].get(id) ?? {};
    o.s = [Math.max(o.s?.[0] ?? 0, ...list.map((s) => s.by.size))];
    obs[kind].set(id, o);
  }
  // what the combat log said of each creature: where fights with it began, its health level by level, how it stands towards each side
  const logged = { npc: new Map(), quest: new Map() };
  const told = new Map(); // id -> Set of the copies that said anything of it
  const of = (id) => { let rec = logged.npc.get(id); if (!rec) logged.npc.set(id, (rec = {})); return rec; };
  const by = (id, names) => { let s = told.get(id); if (!s) told.set(id, (s = new Set())); for (const n of names) s.add(n); };
  for (const [key, list] of flats) {
    const m = /^(\d+):(m\d+)$/.exec(key), id = +m[1];
    (of(id).f ??= {})[m[2]] = list.map((s) => [r2(s.x), r2(s.y)].join(',')).join(' ');
    for (const s of list) by(id, s.by.keys());
  }
  for (const [id, perLevel] of levels) {
    const hpl = [...perLevel].map(([level, voices]) => [level, mostSaid(voices)]).sort((a, b) => a[0] - b[0]);
    const rec = of(id);
    rec.hpl = hpl;
    rec.lv = [hpl[0][0], hpl[hpl.length - 1][0]];
    rec.hp = [hpl[0][1], hpl[hpl.length - 1][1]];
    for (const voices of perLevel.values()) by(id, voices.keys());
  }
  for (const [id, both] of stands) {
    of(id).react = both.map((voices) => (voices.size ? mostSaid(voices) : -2));
    for (const voices of both) by(id, voices.keys());
  }
  // What a vendor sells and a trainer teaches. A price falls with your standing with its people,
  // so the largest anybody was asked is the price; of everything else, what most say.
  const column = (voices, n) => mostSaid(new Map([...voices].map(([copy, v]) => [copy, v[n]])));
  for (const [id, things] of sells) {
    of(id).sells = [...things].map(([item, voices]) => [item, Math.max(...[...voices.values()].map((v) => v[0])), column(voices, 1), column(voices, 2)]).sort((a, b) => a[0] - b[0]);
    for (const voices of things.values()) by(id, voices.keys());
  }
  for (const [id, things] of teaches) {
    of(id).teaches = [...things].map(([spell, voices]) => [spell, Math.max(...[...voices.values()].map((v) => v[0])), column(voices, 1), column(voices, 2), column(voices, 3)]).sort((a, b) => a[0] - b[0]);
    for (const voices of things.values()) by(id, voices.keys());
  }
  // The level a creature was fought on, spot by spot: what most copies say (their heights within a
  // few yards of each other are one level, and its height the middle of theirs); where two levels
  // are said by as many, nothing - the map goes on guessing there.
  for (const [key, list] of fought) {
    const m = /^(\d+):(m\d+)$/.exec(key), id = +m[1], spots2 = [];
    for (const s of list) {
      const levels = []; // [{ z, n }]
      for (const z of [...s.by.values()].sort((a, b) => a - b)) {
        const at = levels.find((l) => Math.abs(l.z - z) < LEVEL_APART);
        if (at) { at.z = (at.z * at.n + z) / (at.n + 1); at.n++; } else levels.push({ z, n: 1 });
      }
      levels.sort((a, b) => b.n - a.n);
      if (levels.length > 1 && levels[0].n === levels[1].n) continue;
      spots2.push([r2(s.x), r2(s.y), r2(levels[0].z), levels[0].n].join(','));
      by(id, s.by.keys());
    }
    if (spots2.length) (of(id).fz ??= {})[m[2]] = spots2.join(' ');
  }
  // Where the game's own map puts a quest: { s: { u<the game's map>: "x,y x,y" }, o: ..., e: ... }
  for (const [key, list] of pins) {
    const [quest, what, ui] = key.split(':');
    let rec = logged.quest.get(+quest);
    if (!rec) logged.quest.set(+quest, (rec = { gp: {} }));
    (rec.gp[what] ??= {})[`u${ui}`] = list.map((s) => [r2(s.x), r2(s.y)].join(',')).join(' ');
  }
  for (const [id, names] of told) {
    const o = obs.npc.get(id) ?? {};
    o.l = [names.size];
    obs.npc.set(id, o);
  }
  return { cache, seen, logged, obs, copies: copies.length, deliveries, splits, places: foldPlaces(ofPlaces), yields: foldYields(ofYields), ...foldSales(ofSales), loot: ofLoot };
}

/**
 * The whole database, made from the sources on this disk and what the copies have sent.
 * @returns { records: { npc: Map, object: Map, quest: Map }, from: {...} }
 */
export async function buildTruth(cfg, dataDir, inbox, log = () => {}) {
  const sources = { npc: [], object: [], quest: [] }, from = {};
  const got = fold(inbox);
  const toc = findQuestieDb(cfg);
  // (QuestieDB is what says which creatures and quests this game has at all: without it the
  // reference database's whole original game would be taken for this one)
  if (!toc) throw new Error('QuestieDB is not on this computer (neither fetched from the database - "questie" does that - nor an addon in the game): the database is made on a computer that has it');
  let known = null;
  {
    const qdb = readQuestie(toc);
    let extras = null;
    try { const { readQuestieExtras } = await import('../extractor/questie-extras.js'); extras = readQuestieExtras(toc); } catch (err) { log(`QuestieDB's measured figures were not read (${err.message})`); }
    const q = fromQuestie(qdb, extras);
    sources.npc.push(['q', q.npc]); sources.object.push(['q', q.object]); sources.quest.push(['q', q.quest], ['x', q.measured]);
    from.questie = qdb.version ?? '?';
    from.measured = q.measured.size;
    known = { npc: new Set(q.npc.keys()), object: new Set(q.object.keys()), quest: new Set(q.quest.keys()) };
    log(`QuestieDB ${from.questie}: ${q.npc.size.toLocaleString()} creatures, ${q.object.size.toLocaleString()} objects, ${q.quest.size.toLocaleString()} quests (${q.measured.size.toLocaleString()} with experience measured in this game)`);
  }
  // the maker's own further sources (they, too, say what this game has)
  for (const layer of readLayers(dataDir, log)) {
    for (const kind of KINDS) { sources[kind].push([layer.code, layer[kind]]); for (const id of layer[kind].keys()) known[kind].add(id); }
    (from.layers ??= {})[layer.name] = layer.made ?? '?';
    log(`${layer.name} (as of ${layer.made ?? '?'}): ${layer.npc.size.toLocaleString()} creatures, ${layer.object.size.toLocaleString()} objects, ${layer.quest.size.toLocaleString()} quests`);
  }
  // the reference database, as the map update fetched it
  let refLoot = null;
  try {
    const dir = path.join(dataDir, 'sources', 'classic-db');
    const name = fs.readdirSync(dir).find((f) => /\.sql(\.gz)?$/i.test(f));
    if (name) {
      // (it is about the original game: only what this game is known to have is taken from it, plus what a player's game has met)
      const ref = readReference(path.join(dir, name));
      const all = { npc: new Set([...known.npc, ...got.cache.npc.keys()]), object: new Set([...known.object, ...got.cache.object.keys()]), quest: new Set([...known.quest, ...got.cache.quest.keys()]) };
      const c = fromReference(ref, all);
      sources.npc.push(['c', c.npc]); sources.object.push(['c', c.object]); sources.quest.push(['c', c.quest]);
      // (and what its loot tables say each of this game's creatures gives: where nobody has looted one yet, that is all there is)
      try { refLoot = referenceLoot(ref, lootOf, all.npc); } catch (err) { log(`the reference database's loot tables were not read (${err.message})`); }
      from.reference = name;
      log(`${name}: ${c.npc.size.toLocaleString()} creatures, ${c.object.size.toLocaleString()} objects, ${c.quest.size.toLocaleString()} quests of this game known to it`);
    } else log('no reference database on this disk (Update map fetches it)');
  } catch (err) { log(`reference database not read (${err.message})`); }
  for (const kind of KINDS) {
    sources[kind].push(['g', got.cache[kind]]);
    if (got.seen[kind]) sources[kind].push(['s', got.seen[kind]]);
    if (got.logged[kind]) sources[kind].push(['l', got.logged[kind]]);
  }
  from.copies = got.copies; from.deliveries = got.deliveries;
  if (got.logged.npc.size) { from.logged = got.logged.npc.size; log(`the game's combat log, as the copies read it: ${got.logged.npc.size.toLocaleString()} creatures with a place, a level and health, or a side`); }
  if (got.splits.length) from.split = got.splits.length;
  log(`${got.copies} ${got.copies === 1 ? 'copy has' : 'copies have'} sent ${got.deliveries} ${got.deliveries === 1 ? 'delivery' : 'deliveries'}: ${got.cache.npc.size.toLocaleString()} creatures, ${got.cache.object.size.toLocaleString()} objects and ${got.cache.quest.size.toLocaleString()} quests from the game's cache, sightings of ${(got.seen.npc.size + got.seen.object.size).toLocaleString()}`);
  if (got.splits.length) log(`the copies' caches disagree about ${got.splits.length.toLocaleString()} ${got.splits.length === 1 ? 'fact' : 'facts'}: settled by vote ("votes" lists them)`);
  const records = {};
  for (const kind of KINDS) records[kind] = mergeAll(kind, sources[kind], got.obs[kind]);
  // the dungeons: what the copies learned of their insides, as it was folded (no other source says anything of that)
  records[PLACE] = got.places;
  if (got.places.size) { from.places = got.places.size; log(`the dungeons, as the copies went through them: ${got.places.size} with a door, a way or checks of the minimap's place`); }
  // what disenchanting gives: the copies' own counts, band by band (no other source says anything of that for this game)
  records[YIELD] = got.yields;
  if (got.yields.size) { from.yields = [...got.yields.values()].reduce((n, y) => n + y.n, 0); log(`what disenchanting gives, as the copies' players found it: ${from.yields.toLocaleString()} disenchantings of ${got.yields.size} kinds of thing`); }
  // the players' own auctions: what became of them, and what the houses took (nobody else can say either)
  records[SALE] = got.sales;
  records[COST] = got.costs;
  if (got.sales.size) { from.sales = [...got.sales.values()].reduce((n, r) => n + Object.values(r.h).reduce((m, by) => m + Object.values(by).reduce((q, v) => q + v[0], 0), 0), 0); log(`the players' own auctions: ${from.sales.toLocaleString()} put up, of ${got.sales.size.toLocaleString()} items`); }
  // what creatures give: the copies' own counts of what was in the corpses their players looted, and, beside them,
  // what the reference database's loot tables give (nobody else says anything of this game's creatures)
  records[LOOT] = foldLoot(got.loot, refLoot);
  {
    const counted = [...records[LOOT].values()].filter((r) => r.n > 0 || r.on);
    if (counted.length) { from.loot = counted.reduce((n, r) => n + (r.n ?? 0), 0); log(`what creatures give, as the copies' players found it: ${from.loot.toLocaleString()} corpses looted, of ${counted.length.toLocaleString()} creatures`); }
    if (refLoot?.size) log(`...and the reference database's loot tables for ${refLoot.size.toLocaleString()} of this game's creatures`);
  }
  return { records, from, splits: got.splits };
}

/**
 * Write what has changed. @returns { rev, changed, removed, bytes, same: true when nothing differed }
 */
export async function publish(db, truth, { dry = false, log = () => {} } = {}) {
  const meta = (await db.get('meta')) ?? {};
  const next = { schema: SCHEMA, rev: (meta.rev ?? 0) + 1, at: SERVER_TIME, counts: {}, from: truth.from, shards: {} };
  let changed = 0, removed = 0, bytes = 0;
  for (const kind of PUBLISHED) {
    if (!truth.records[kind]) continue; // (made by something that does not know the kind: what is published of it stays)
    const { shards: parts, hashes } = shards(truth.records[kind]);
    next.counts[kind] = truth.records[kind].size;
    next.shards[kind] = {};
    const old = Object.fromEntries(entries(meta.shards?.[kind]));
    let request = {}, size = 0;
    const flush = async () => {
      if (!Object.keys(request).length) return;
      if (!dry) await db.patch(`truth/${kind}`, request);
      request = {}; size = 0;
    };
    for (const [b, part] of parts) {
      const key = 'b' + b, hash = hashes.get(b);
      next.shards[kind][key] = hash;
      if (old[key] === hash) continue;
      const len = JSON.stringify(part).length;
      if (size && size + len > REQUEST) await flush();
      request[key] = part; size += len; bytes += len; changed++;
    }
    for (const key of Object.keys(old)) if (!(key in next.shards[kind])) { request[key] = null; removed++; }
    await flush();
    log(`${kind}: ${truth.records[kind].size.toLocaleString()} records in ${parts.size} shards`);
  }
  // (a kind this run did not make keeps what is published of it)
  for (const kind of PUBLISHED) if (!truth.records[kind] && meta.shards?.[kind]) { next.shards[kind] = Object.fromEntries(entries(meta.shards[kind])); if (meta.counts?.[kind] !== undefined) next.counts[kind] = meta.counts[kind]; }
  const same = !changed && !removed && meta.schema === SCHEMA;
  if (!dry && !same) await db.put('meta', next);
  return { rev: same ? meta.rev ?? 0 : next.rev, changed, removed, bytes, same, dry };
}

/**
 * Fetch what differs from what this copy has. The records land in the local store, one file per kind.
 * @returns { rev, fetched, counts } or null when nothing is published
 */
export async function pull(db, store, log = () => {}) {
  const meta = await db.get('meta');
  if (!meta?.shards) return null;
  const mine = store.read('truth-meta.json', {});
  let fetched = 0;
  const counts = {};
  for (const kind of PUBLISHED) {
    const want = Object.fromEntries(entries(meta.shards[kind]));
    const have = mine.schema === meta.schema ? mine.shards?.[kind] ?? {} : {};
    const local = store.read(`truth-${kind}.json`, {});
    for (const key of Object.keys(local)) if (!(key in want)) delete local[key];
    const need = Object.keys(want).filter((key) => !(have[key] === want[key] && local[key]));
    if (need.length > WHOLE) {
      // most of it: the whole kind in one request (far quicker than hundreds of small ones)
      const all = Object.fromEntries(entries(await db.get(`truth/${kind}`)));
      for (const key of need) local[key] = Object.fromEntries(entries(all[key]));
    } else {
      // a few shards: several at a time
      let next = 0;
      const one = async () => { while (next < need.length) { const key = need[next++]; local[key] = Object.fromEntries(entries(await db.get(`truth/${kind}/${key}`))); } };
      await Promise.all(Array.from({ length: Math.min(6, need.length) }, one));
    }
    fetched += need.length;
    counts[kind] = Object.values(local).reduce((a, p) => a + Object.keys(p).length, 0);
    store.write(`truth-${kind}.json`, local);
  }
  store.write('truth-meta.json', { schema: meta.schema, rev: meta.rev, at: meta.at, counts: meta.counts, from: meta.from, shards: Object.fromEntries(PUBLISHED.map((k) => [k, Object.fromEntries(entries(meta.shards[k]))])) });
  log(`database ${meta.rev}: ${fetched} shards fetched`);
  return { rev: meta.rev, fetched, counts };
}

/** One record as the local copy has it, or null. */
export function lookup(store, kind, id) {
  const local = store.read(`truth-${kind}.json`, {});
  return local['b' + Math.floor(id / 500) * 500]?.['i' + id] ?? null;
}
