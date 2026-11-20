// The Atlas database: one record per creature, object and quest, put together from every source
// there is, each fact with a note of where it came from.
//
// The sources, and the letter each is known by in a record:
//
//   g  the game's own cache    what the game's server told a player's game about something they
//                              met (extractor/wdb.js). The server's own answer: believed first,
//                              from every copy alike. Where several copies have sent the same
//                              thing, a vote settles each fact (publish.js, vote): of two
//                              copies the later is believed, of three or more what most say.
//   s  seen in game            where someone really stands, noted by the map when a player talks
//                              to them (server/seen.js).
//   l  the game's combat log   what a player's game wrote down of its own fights
//                              (server/combatlog.js): where a creature was when it was first
//                              hit, which level it was and how much health it had, and how it
//                              stood towards that player's side. The server's own figures for
//                              the creature that was fought: believed for health before every
//                              table. A level it gives is the level of the ones somebody happened
//                              to fight, not every level the creature comes in: so for levels it
//                              is asked last, and fills in where nobody else says.
//   w  Wowhead                its database for this game (wowhead.com/forever), which its own
//                              users' games feed. Read by a tool of the database's maker and
//                              handed over as a file (publish.js, readLayers): believed for what
//                              a thing is (name, level, kind, side), and where QuestieDB is
//                              silent; for where things stand and who gives which quest
//                              QuestieDB is asked first.
//   q  QuestieDB               the community's database for this game (extractor/questie.js).
//   x  QuestieDB, measured     its figures gathered from players' sessions (quest experience).
//   c  the reference database  cmangos classic-db: the original game, patch 1.12
//                              (extractor/reference.js). Right for most of the old world, silent
//                              about everything new.
//
// A record holds, for every field, the value of the most believed source that has one. `src`
// says which source that was wherever it was not QuestieDB; `alt` keeps what the other sources
// said where they said something else (a name spelt differently, another level), so a
// disagreement can be seen and looked into rather than lost. `obs` says how many copies of the
// map reported the thing, and the newest game build any of them was on.
//
// Shapes (every field optional but the name):
//
//   npc     n name, sub what is written under the name, lv [min, max], rank (0 normal, 1 elite,
//           2 rare elite, 3 boss, 4 rare), type (1 beast, 2 dragonkin, 3 demon, 4 elemental,
//           5 giant, 6 undead, 7 humanoid, 8 critter, 9 mechanical, 10 not specified), fam (a
//           beast's family), zone, fac (its faction), fr (whose side it is on: A, H or AH),
//           react [towards the Alliance, towards the Horde] (1 friendly, 0 neutral, -1 hostile,
//           -2 not known),
//           flags (what it does: vendor, trainer...), hp [at min level, at max], hpl [[level,
//           health]] (health as fights measured it, level by level), respawn
//           (seconds), qs / qe (quests it gives / takes), loot / skin (which loot table),
//           disp (how it looks), hpMul, qi (quest items it carries), boss (1: a leader),
//           drops [[item a quest wants, how often in per cent]] (the original game's rates),
//           sells [[item, copper, how many at a time, 1: stock is limited]] (what its vendor's
//           window showed), teaches [[spell, copper, skill, skill level asked, level asked]]
//   object  n, zone, type, disp, qs, qe, chest (its loot table), size, qi, data (the game's
//           own numbers for it)
//   quest   n, l level, m level needed, ml highest level, races, classes, s { n, o, i } who or
//           what gives it, e { n, o } who takes it, t the lines of what it asks, pre (one of
//           these done first), preAll (all of these), excl, nx, parent, z (zone or kind), flags,
//           special, srcItem, o { n, o, i: [[id, how many (0: not known)]], k: [[counts as, any of
//           these...]], r: [faction, standing to reach] },
//           trig { t, at }, xp, money, ri [[item, count]] given, rc [[item, count]] to choose
//           from, rep [[faction, value]], type, limit (seconds), grp (players suggested), skill
//           [skill, value needed], minRep / maxRep [faction, value], crumbFor, crumbs, kids, group,
//           srcItems, gp { s, o, e: { u<the game's map>: "x,y ..." } } (where the game's own map
//           puts it: where it starts, its objectives, where it is handed in; per cent of that map)
//
// Where things stand: `at` is { z<zone id>: "x,y x,y ..." } in per cent of the zone's map (as
// QuestieDB gives it; -1,-1: in this zone, spot not known), `paths` the same per patrol route,
// `w` is { m<map id>: "x,y,z x,y,z ..." } in the game's own yards (the reference database),
// `seen` is { m<map id>: "x,y,z,n ..." }: sightings, n the number of copies that made them, and
// `f` is { m<map id>: "x,y x,y ..." }: where creatures of this kind were when a fight with them
// began, in the game's own yards and with no height (the combat log has none).
// `fz` is { m<map id>: "x,y,z,n ..." }: a spot of the map's own for a creature of this kind, and
// the height of the level a player fought it on there (n: how many copies say so) - for a spot
// with several floors one over the other, where the map could only guess.
// (The letters before the ids keep the database from turning a list of numbers into an array.)
//
// Besides the three kinds of thing there is one record per dungeon, kind "place" (places.js):
//
//   place   d "x,y,z,facing,copies,times ..." the doors copies found themselves at having come in,
//           that the map's own data does not have; w "x,y,z,x,y,z,copies,times ..." the ways its
//           floors do not have, from a place to a place; c "cell north,cell west,copies,checks,
//           off north,off west,off,copies with checks enough that point one way,their off north,their off west,how
//           far they differ ..." how far the minimap's place is from the combat log's, by the
//           32-yard square; a [copies, checks, yards]: the same over the whole dungeon.
//           (A height or a facing that is not known is left empty.)
import crypto from 'node:crypto';

export const SCHEMA = 1;
export const KINDS = ['npc', 'object', 'quest'];
/** ...and the kind that is no thing but a place: a dungeon, with what the copies learned of its insides (places.js). */
export const PLACE = 'place';
/** Every kind there is a shard of. */
export const PUBLISHED = [...KINDS, PLACE];
export const BUCKET = 500; // ids to a shard: a copy fetches only the shards that have changed

/** Believed first to last. */
const ORDER = ['g', 's', 'l', 'w', 'q', 'x', 'c'];
const rankOf = (code) => { const i = ORDER.indexOf(code); return i < 0 ? ORDER.length : i; };

/**
 * The source asked last for a field, whatever its place otherwise. What the combat log says of
 * a creature's level is the level of the ones somebody happened to fight: it fills in where no
 * other source gives a level, and narrows nobody's.
 */
const LAST = { npc: { lv: 'l' } };

/** The sources that come as a file of the maker's own (publish.js, readLayers). */
export const LAYERS = ['w'];

/**
 * Where the usual order does not hold: the source asked first for a field. The cache gives a
 * quest's reputation as a step on a scale, not an amount (the amount is worked out from a table
 * and is right about nineteen times in twenty), and Wowhead names only the factions a quest is
 * for, not what spills over to their friends: QuestieDB's amounts are believed before both.
 * A quest's experience as players' own sessions measured it in this game is believed before any
 * table of it (of 3,556 quests both know, Wowhead's figure is the same for all but five).
 */
const PREFER = { quest: { rep: 'q', xp: 'x' } };

/**
 * The fields for which Wowhead is asked only after QuestieDB: where things stand, and who gives
 * and takes which quest. QuestieDB has every spawn point to two decimals and has been put right
 * by hand; Wowhead shows a sample of where its users met a thing. Wowhead fills in where
 * QuestieDB has nothing.
 */
const AFTER_Q = {
  npc: ['at', 'paths', 'zone', 'qs', 'qe'],
  object: ['at', 'zone', 'qs', 'qe'],
  quest: ['s', 'e', 'nx'],
};
const rankAfterQ = (code) => (code === 'w' ? rankOf('q') + 0.5 : rankOf(code));

/**
 * Sources that add to what a quest asks for only where nobody else says: where another source
 * lists the creatures, objects or items wanted, such a source gives the counts and no further
 * things (it may count a kill under another creature's name, which would look like one more
 * thing to do).
 */
const COUNTS_ONLY = ['w'];

/** Fields whose other readings are worth keeping when sources disagree (small ones: not where things stand). */
const NOTED = {
  npc: ['n', 'sub', 'lv', 'rank', 'type', 'fam', 'fr', 'fac', 'flags'],
  object: ['n', 'type'],
  quest: ['n', 'l', 'm', 'z', 'xp', 'money', 'nx', 'limit', 'type', 'o'],
};

export const bucketOf = (id) => Math.floor(id / BUCKET) * BUCKET;
const r2 = (v) => Math.round(v * 100) / 100;

/** [[x, y], ...] as "x,y x,y" (two decimals), and back. */
export const packPoints = (points) => points.filter(Array.isArray).map((p) => p.filter((v) => typeof v === 'number' && Number.isFinite(v)).map(r2).join(',')).filter(Boolean).join(' ');
export const unpackPoints = (s) => (typeof s === 'string' && s ? s.split(' ').map((p) => p.split(',').map(Number)) : []);

const some = (v) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) && v !== '';
/** A record without its empty fields (the database drops them anyway: a record must come back as it went). */
export function tidy(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (some(v)) out[k] = v;
  return out;
}

/** The same text for the same value, whatever order its fields were set in. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
export const hashOf = (v) => crypto.createHash('sha1').update(canonical(v)).digest('hex').slice(0, 16);
const same = (a, b) => canonical(a) === canonical(b);

// ---- what each source says ---------------------------------------------------------------------

const zoned = (map, pack) => {
  if (!(map instanceof Map) || !map.size) return undefined;
  const out = {};
  for (const [zone, v] of map) { if (!Number.isInteger(zone)) continue; const s = pack(v); if (some(s)) out['z' + zone] = s; }
  return Object.keys(out).length ? out : undefined;
};
const ids = (list) => (Array.isArray(list) && list.length ? [...new Set(list.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : undefined);

/** QuestieDB (from readQuestie()), and its measured figures (from readQuestieExtras(), or null). */
export function fromQuestie(db, extras = null) {
  const npc = new Map(), object = new Map(), quest = new Map(), measured = new Map();
  for (const n of db.npcs) {
    npc.set(n.id, tidy({
      n: n.name, sub: n.subName ?? undefined,
      lv: n.maxLevel > 0 ? [n.minLevel || n.maxLevel, n.maxLevel] : undefined,
      rank: n.rank || undefined, zone: n.zone || undefined, fac: n.faction || undefined, fr: n.friendly ?? undefined, flags: n.flags || undefined,
      qs: ids(n.questStarts), qe: ids(n.questEnds),
      at: zoned(n.spawns, (pts) => (Array.isArray(pts) ? packPoints(pts) : '')),
      paths: zoned(n.paths, (routes) => (Array.isArray(routes) ? routes.map((r) => (Array.isArray(r) ? packPoints(r) : '')).filter(Boolean) : [])),
    }));
  }
  // how often a creature gives an item a quest wants (QuestieDB's table for the original game): by creature
  for (const [item, by] of extras?.drops ?? []) {
    for (const [who, pct] of by) {
      const rec = npc.get(who);
      if (rec && pct > 0) (rec.drops ??= []).push([item, r2(Math.min(pct, 100))]);
    }
  }
  for (const rec of npc.values()) rec.drops?.sort((a, b) => a[0] - b[0]);
  for (const o of db.objects) {
    object.set(o.id, tidy({ n: o.name, zone: o.zone || undefined, fac: o.faction || undefined, qs: ids(o.questStarts), qe: ids(o.questEnds), at: zoned(o.spawns, (pts) => (Array.isArray(pts) ? packPoints(pts) : '')) }));
  }
  const pairs = (list) => (Array.isArray(list) && list.length ? list.filter((p) => Array.isArray(p) && Number.isInteger(p[0])).map((p) => [p[0], Number(p[1]) || 0]) : undefined);
  for (const q of db.quests) {
    const want = (list) => (list?.length ? ids(list).map((id) => [id, 0]) : undefined);
    // (experience: QuestieDB's own table for the original game goes with QuestieDB; what players' sessions measured in this game is a source of its own)
    const xp = extras?.xp?.get(q.id);
    if (xp?.xp > 0 && xp.from === 'traces') measured.set(q.id, { xp: xp.xp });
    quest.set(q.id, tidy({
      xp: xp?.xp > 0 && xp.from !== 'traces' ? xp.xp : undefined,
      n: q.name, l: q.level || undefined, m: q.minLevel || undefined, ml: q.maxLevel || undefined,
      races: q.races || undefined, classes: q.classes || undefined,
      s: tidy({ n: ids(q.starts.npcs), o: ids(q.starts.objects), i: ids(q.starts.items) }),
      e: tidy({ n: ids(q.ends.npcs), o: ids(q.ends.objects) }),
      t: q.text?.length ? q.text : undefined,
      pre: ids(q.pre), preAll: ids(q.preAll), excl: ids(q.exclusive),
      nx: q.next || undefined, parent: q.parent || undefined, z: q.zoneOrSort || undefined,
      flags: q.flags || undefined, special: q.special || undefined, srcItem: q.sourceItem || undefined,
      // (k: a kill that counts whichever of several creatures it was - [what it counts as, each of them]; r: a standing to reach - [faction, value])
      o: tidy({
        n: want(q.objectives.creatures), o: want(q.objectives.objects), i: want(q.objectives.items),
        k: q.objectivesDetail?.killCredit?.length ? q.objectivesDetail.killCredit.map((row) => [row[1] || 0, ...row[0]]) : undefined,
        r: q.objectivesDetail?.reputation,
      }),
      trig: q.trigger ? tidy({ t: q.trigger.text || undefined, at: zoned(q.trigger.spawns, (pts) => (Array.isArray(pts) ? packPoints(pts) : '')) }) : undefined,
      // (the fields readQuestie() has only lately learned to read; each is there or not)
      rep: pairs(q.reputationReward), skill: q.requiredSkill, minRep: q.requiredMinRep, maxRep: q.requiredMaxRep,
      crumbFor: q.breadcrumbFor || undefined, crumbs: ids(q.breadcrumbs), kids: ids(q.childQuests), group: ids(q.inGroupWith),
      srcItems: ids(q.requiredSourceItems),
    }));
  }
  return { npc, object, quest, measured, version: db.version ?? null };
}

/** The reference database (from readReference()). `known` limits it to what this game has: a Set per kind, or null for everything. */
export function fromReference(ref, known = null) {
  const npc = new Map(), object = new Map(), quest = new Map();
  const world = (rows) => {
    const maps = {};
    for (let i = 0; i + 3 < rows.length; i += 4) (maps['m' + rows[i]] ??= []).push([rows[i + 1], rows[i + 2], rows[i + 3]]);
    for (const k of Object.keys(maps)) maps[k] = packPoints(maps[k]);
    return maps;
  };
  const want = (kind, id) => !known || known[kind].has(id);
  for (const [id, t] of ref.templates) {
    if (!want('npc', id)) continue;
    npc.set(id, tidy({
      lv: t.lv?.[1] > 0 ? [t.lv[0] || t.lv[1], t.lv[1]] : undefined, rank: t.rank || undefined,
      type: t.type || undefined, fam: t.family || undefined, hp: t.hp?.[1] > 0 ? t.hp : undefined,
      loot: t.loot || undefined, skin: t.skin || undefined, respawn: ref.respawn.get(id) || undefined,
    }));
  }
  for (const [id, rows] of ref.creatures) { if (want('npc', id)) npc.set(id, { ...(npc.get(id) ?? {}), w: world(rows) }); }
  for (const [id, rows] of ref.objects) { if (want('object', id)) object.set(id, { w: world(rows) }); }
  for (const [id, loot] of ref.chests) { if (want('object', id)) object.set(id, { ...(object.get(id) ?? {}), chest: loot }); }
  for (const [id, q] of ref.quests) {
    if (!want('quest', id)) continue;
    const o = { n: [], o: [], i: [] };
    for (const [kind, what, many] of q.needs) o[kind].push([what, many]);
    quest.set(id, tidy({ n: q.title || undefined, type: q.type || undefined, limit: q.limit || undefined, o: tidy(o) }));
  }
  return { npc, object, quest };
}

/** One record of the game's cache (from readWdb()) as the fields a record keeps. */
export function fromCache(kind, r) {
  const list = (v) => (Array.isArray(v) && v.length ? v : undefined);
  if (kind === 'npc') {
    return tidy({
      n: r.name || undefined, sub: r.subName || undefined, type: r.type > 0 ? r.type : undefined, fam: r.family > 0 ? r.family : undefined,
      rank: Number.isInteger(r.rank) ? r.rank : undefined, disp: list(r.displays), hpMul: r.hpMul > 0 && r.hpMul !== 1 ? r2(r.hpMul) : undefined,
      qi: list(r.questItems), boss: r.leader ? 1 : undefined,
    });
  }
  if (kind === 'object') {
    let data = Array.isArray(r.data) ? [...r.data] : [];
    while (data.length && !data[data.length - 1]) data.pop();
    return tidy({ n: r.name || undefined, type: Number.isInteger(r.type) ? r.type : undefined, disp: r.displayId || undefined, size: r.size > 0 && r.size !== 1 ? r2(r.size) : undefined, qi: list(r.questItems), data: list(data) });
  }
  const o = { n: [], o: [], i: [] };
  // (the cache's kinds of objective, see extractor/wdb.js: 0 a creature to kill, 3 one to speak to, 1 an item, 2 an object, 6 a standing to reach)
  const KIND = { 0: 'n', 3: 'n', 1: 'i', 2: 'o' };
  for (const ob of r.objectives ?? []) {
    const k = KIND[ob.type];
    if (k && ob.id > 0 && !o[k].some((had) => had[0] === ob.id)) o[k].push([ob.id, ob.count > 0 ? ob.count : 0]);
    else if (ob.type === 6 && ob.id > 0) o.r = [ob.id, ob.count];
  }
  return tidy({
    n: r.name || undefined, l: r.level > 0 ? r.level : undefined, m: r.minLevel > 0 ? r.minLevel : undefined, z: r.zoneOrSort || undefined,
    type: r.type || undefined, grp: r.suggestedGroup || undefined, nx: r.next || undefined, xp: r.xp > 0 ? r.xp : undefined,
    money: r.money > 0 ? r.money : undefined, srcItem: r.startItem || undefined, limit: r.timeAllowed || undefined,
    ri: list(r.rewardItems), rc: list(r.choiceItems), rep: list(r.rewardFactions), o: tidy(o),
  });
}

// What a record of the game's cache may hold as a copy sends it: the fields fromCache() gives, each
// in its own shape. (A field added to fromCache() is added here too.)
const whole = Number.isInteger;
const number = (v) => typeof v === 'number' && Number.isFinite(v);
const words = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const listOf = (ok, most = 64) => (v) => Array.isArray(v) && v.length > 0 && v.length <= most && v.every(ok);
const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(whole);
// (a quest's reputation: [faction, amount or none, step])
const repRow = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 3 && whole(v[0]) && v.slice(1).every((x) => x === null || x === undefined || number(x));
const wanted = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
  && Object.entries(v).every(([k, list]) => (k === 'r' ? pair(list) : ['n', 'o', 'i'].includes(k) && listOf(pair)(list)));
const CACHE_SAYS = {
  npc: { n: words, sub: words, type: whole, fam: whole, rank: whole, disp: listOf(whole), hpMul: number, qi: listOf(whole), boss: (v) => v === 1 },
  object: { n: words, type: whole, disp: whole, size: number, qi: listOf(whole), data: listOf(number) },
  quest: {
    n: words, l: whole, m: whole, z: whole, type: whole, grp: whole, nx: whole, xp: whole, money: whole, srcItem: whole, limit: whole,
    ri: listOf(pair), rc: listOf(pair), rep: listOf(repRow), o: wanted,
  },
};

/**
 * What a delivery's record of the game's cache says, as far as a cache can say it: the fields
 * the cache has, each in its own shape. Whatever else was sent with it (where a creature
 * stands, its level, anything misshapen) is not the cache speaking and is left out.
 */
export function cacheSays(kind, rec) {
  const out = {};
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return out;
  for (const [f, ok] of Object.entries(CACHE_SAYS[kind])) if (rec[f] !== undefined && rec[f] !== null && ok(rec[f])) out[f] = rec[f];
  return out;
}

// ---- putting them together ---------------------------------------------------------------------

/** What a quest asks for: the ids of every source, each with the count of the most believed source that has one. */
function mergeWanted(layers) {
  const out = {}, from = new Set();
  for (const kind of ['n', 'o', 'i']) {
    const got = new Map(); // id -> [count, code]
    const listed = layers.some(([code, rec]) => !COUNTS_ONLY.includes(code) && rec.o?.[kind]?.length);
    for (const [code, rec] of layers) {
      for (const [id, many] of rec.o?.[kind] ?? []) {
        if (listed && COUNTS_ONLY.includes(code) && !layers.some(([c, r]) => !COUNTS_ONLY.includes(c) && r.o?.[kind]?.some((p) => p[0] === id))) continue;
        const had = got.get(id);
        if (!had || (!had[0] && many)) got.set(id, [many || 0, many ? code : had?.[1] ?? code]);
      }
    }
    if (got.size) { out[kind] = [...got].sort((a, b) => a[0] - b[0]).map(([id, [many, code]]) => { if (many) from.add(code); return [id, many]; }); }
  }
  for (const extra of ['k', 'r']) { const v = layers.find(([, rec]) => rec.o?.[extra])?.[1].o[extra]; if (v) out[extra] = v; }
  const codes = [...from].sort((a, b) => rankOf(a) - rankOf(b));
  return { value: tidy(out), code: codes[0] ?? layers[0][0] };
}

/**
 * How a creature stands towards each side, side by side: each from the most believed source
 * that knows it (-2: nobody does). One source often knows one side only - a player's game says
 * how the creature stood towards that player.
 */
function mergeReact(have) {
  const out = [-2, -2], from = [];
  for (let i = 0; i < 2; i++) {
    for (const [code, rec] of have) {
      const v = rec.react?.[i];
      if (v === 1 || v === 0 || v === -1) { out[i] = v; from.push(code); break; }
    }
  }
  from.sort((a, b) => rankOf(a) - rankOf(b));
  return { value: from.length ? out : undefined, code: from[0] ?? have[0][0] };
}

/**
 * One record out of what each source says about the same thing.
 * @param layers [[code, fields], ...] in any order
 */
export function merge(kind, layers) {
  const sorted = layers.filter(([, rec]) => rec && Object.keys(rec).length).sort((a, b) => rankOf(a[0]) - rankOf(b[0]));
  const out = {}, src = {}, alt = {};
  const fields = new Set();
  for (const [, rec] of sorted) for (const f of Object.keys(rec)) fields.add(f);
  for (const f of fields) {
    const have = sorted.filter(([, rec]) => some(rec[f]));
    if (!have.length) continue;
    const first = PREFER[kind]?.[f];
    if (AFTER_Q[kind]?.includes(f)) have.sort((x, y) => rankAfterQ(x[0]) - rankAfterQ(y[0]));
    if (first) have.sort((x, y) => (x[0] === first ? -1 : 0) - (y[0] === first ? -1 : 0));
    const last = LAST[kind]?.[f];
    if (last) have.sort((x, y) => (x[0] === last ? 1 : 0) - (y[0] === last ? 1 : 0));
    let code = have[0][0], value = have[0][1][f];
    if (kind === 'quest' && f === 'o') ({ value, code } = mergeWanted(have));
    if (kind === 'npc' && f === 'react') ({ value, code } = mergeReact(have));
    if (!some(value)) continue;
    out[f] = value;
    if (code !== 'q') src[f] = code;
    if (NOTED[kind].includes(f) && f !== 'o') {
      for (const [c, rec] of have.slice(1)) if (!same(rec[f], value) && !(alt[f] && Object.values(alt[f]).some((v) => same(v, rec[f])))) (alt[f] ??= {})[c] = rec[f];
    }
  }
  if (Object.keys(src).length) out.src = src;
  if (Object.keys(alt).length) out.alt = alt;
  return out;
}

/**
 * Every record of one kind. @param sources [[code, Map<id, fields>], ...]
 * @param obs Map<id, { g: [copies, build], s: [copies] }> or null: who reported what
 */
export function mergeAll(kind, sources, obs = null) {
  const all = new Set();
  for (const [, map] of sources) for (const id of map.keys()) all.add(id);
  const out = new Map();
  for (const id of all) {
    const rec = merge(kind, sources.map(([code, map]) => [code, map.get(id)]).filter(([, r]) => r));
    if (!rec.n) continue; // (a thing with no name is a stray id, not a thing)
    const o = obs?.get(id);
    if (o) rec.obs = o;
    out.set(id, rec);
  }
  return out;
}

/** Records in shards: Map<bucket, { id: record }>, and the fingerprint of each. */
export function shards(records) {
  const out = new Map();
  for (const id of [...records.keys()].sort((a, b) => a - b)) {
    const b = bucketOf(id);
    let s = out.get(b);
    if (!s) out.set(b, (s = {}));
    s['i' + id] = records.get(id);
  }
  const hashes = new Map();
  for (const [b, s] of out) hashes.set(b, hashOf(s));
  return { shards: out, hashes };
}
