// Where everyone and everything stands, in three dimensions: every creature and quest object
// QuestieDB knows, per map, each spawn point with a height and a note of how that height is
// known. This is the data behind the map's NPC layer.
//
// QuestieDB gives a spot on a zone map and no height. The height comes from, in order:
//
//   4  the reference database and the ground agree   the public cmangos classic-db lists the same
//                                                    creature within a few yards of the spot, with
//                                                    a height, and this game's own map data has
//                                                    something to stand on at that height
//   3  the reference database alone                  as above, but nothing to stand on there in the
//                                                    map data: something that flies, swims or perches
//   2  the only place to stand                       no reference (a creature new to this game), and
//                                                    the map data has one level at that spot
//   1  the likeliest of several                      no reference, several levels (a building with
//                                                    storeys, a bridge, a cave under a hill): see guess()
//   0  not known                                     no map data to stand on at all there
//
// (5, "seen in game", is added by the map itself when you talk to someone: see viewer/js/npcs.js.)
//
// Dungeons, raids and the other maps you enter through a door are a different case: QuestieDB
// lists who is in them but not where (a dungeon has no zone map to give a spot on). On a map
// where QuestieDB places nothing, the reference database's spawns are used outright, for the
// creatures and quest objects QuestieDB knows: position and height both come from there
// (source 3, or 4 where the map's own ground agrees). A dungeon that is new to this game, or
// has been rebuilt, is not in the reference, and whoever QuestieDB lists there cannot be
// placed; they are counted in `unplaced` so the map can say so.
//
// The guess was chosen by scoring candidate rules against the reference heights on the spawns
// that have one. Counting only ground you can walk onto (not a roof, a ledge, or the earth shut
// in under a floor), people stand on the lowest built floor and creatures on the lowest ground;
// and where the reference database has someone standing on one of the stretches of ground at a
// spot, that stretch is preferred to one nobody is known to stand on (a city inside a mountain
// has a shell under its streets and a mountain over them: the streets are where everyone is).
// Where nobody is known to stand on any of them, whatever there is to stand on at the height of
// the people the reference database has within 60 yards is taken (open ground or not: a dais
// and the floor behind a counter are neither, and are where someone stands).
// That is right for about 91% of people and 97% of creatures; where there are several levels,
// for about 83% and 81%.
import { packContainer, writeFileAtomic } from '../container.js';
import { reactions } from './creatures.js';

export const NPCS_VERSION = 7;
export const NSEC = { META: 1, SPAWNS: 2, OWNER: 3, SOURCE: 4 };
export const HEIGHT = { NONE: 0, GUESS: 1, ONLY: 2, REFERENCE: 3, AGREED: 4 };

const TILE = 1600 / 3;
const MATCH = 5;    // yards: a reference spawn of the same creature this close to the spot is the same spawn
const AGREE = 3;    // yards: a reference height this close to something to stand on is confirmed by it
const BURIED = 4;   // yards: a reference height this far under everything there is to stand on is from a world that has changed
const STOREY = 2.5; // yards apart: two different levels
const NEAR = 60;    // yards: how far around a spot "the people around here" are looked for
const LEVEL = 6;    // yards: a floor this close to their height is on their level

/**
 * Every creature and object with somewhere to be, per map, as spots on the map. A spot from
 * QuestieDB has no height yet; one from the reference database (see above) comes with its own.
 * @param extra  { areas (world.json's), ref (from readReference()), mapIds: Set of the maps that were extracted } or null
 * @returns Map<mapId, { entries: [...], points: [{ e (index into entries), x, y, z? }], unplaced: string[] }>
 */
export function placeNpcs(db, zones, templates, extra = null) {
  // Questie zone id == the area id of a zone map. Prefer the plain zone map when several share it.
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const maps = new Map();
  const bucket = (mapId) => {
    let m = maps.get(mapId);
    if (!m) maps.set(mapId, (m = { entries: [], index: new Map(), points: [], unplaced: [] }));
    return m;
  };
  const place = (thing, key, make) => {
    for (const [zoneId, points] of thing.spawns ?? []) {
      const z = zoneByArea.get(zoneId);
      if (!z) continue;
      const m = bucket(z.map);
      for (const p of points) {
        if (!Array.isArray(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue; // -1,-1 = position unknown
        let e = m.index.get(key);
        if (e === undefined) { e = m.entries.length; m.index.set(key, e); m.entries.push(make()); }
        m.points.push({ e, x: z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0]), y: z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]) });
      }
    }
  };
  const npcEntry = (npc) => {
    const r = reactions(npc, templates);
    const e = { id: npc.id, n: npc.name, a: r[0], h: r[1] };
    if (r[2]) e.u = 1; // which side it is on is not recorded: a and h are a guess from who it is marked friendly to
    if (npc.subName) e.s = npc.subName;
    if (npc.maxLevel > 0) e.l = [npc.minLevel || npc.maxLevel, npc.maxLevel];
    if (npc.rank) e.r = npc.rank;
    // (the kind of thing it is - beast, humanoid, undead...: from the reference database, for the creatures it has)
    const kind = extra?.ref?.templates?.get(npc.id)?.type;
    if (kind >= 1 && kind <= 9) e.ct = kind;
    if (npc.flags) e.f = npc.flags;
    if (npc.questStarts.length) e.qs = npc.questStarts;
    if (npc.questEnds.length) e.qe = npc.questEnds;
    return e;
  };
  const objEntry = (obj) => {
    const e = { id: obj.id, k: 1, n: obj.name };
    if (obj.questStarts.length) e.qs = obj.questStarts;
    if (obj.questEnds.length) e.qe = obj.questEnds;
    return e;
  };
  for (const npc of db.npcs) if (npc.spawns) place(npc, `n${npc.id}`, () => npcEntry(npc));
  for (const obj of db.objects) if (obj.spawns) place(obj, `o${obj.id}`, () => objEntry(obj));

  if (extra?.ref) {
    // Maps QuestieDB places nothing on (dungeons, raids, the tram): the reference database's spawns.
    const own = new Set(maps.keys());
    const fill = (table, things, prefix, make) => {
      const byId = new Map(things.map((t) => [t.id, t]));
      for (const [id, rows] of table) {
        const thing = byId.get(id);
        if (!thing) continue; // (only what QuestieDB knows: it is the one that says who is in this game)
        for (let i = 0; i < rows.length; i += 4) {
          const mapId = rows[i];
          if (own.has(mapId) || !extra.mapIds.has(mapId)) continue;
          const m = bucket(mapId), key = prefix + id;
          let e = m.index.get(key);
          if (e === undefined) { e = m.entries.length; m.index.set(key, e); m.entries.push(make(thing)); }
          m.points.push({ e, x: rows[i + 1], y: rows[i + 2], z: rows[i + 3] });
        }
      }
    };
    fill(extra.ref.creatures, db.npcs, 'n', npcEntry);
    fill(extra.ref.objects, db.objects, 'o', objEntry);
    // Who QuestieDB lists somewhere without a spot, and neither source could place anywhere.
    const placed = new Set();
    for (const m of maps.values()) for (const key of m.index.keys()) placed.add(key);
    for (const npc of db.npcs) {
      if (!npc.spawns || placed.has(`n${npc.id}`)) continue;
      for (const zoneId of npc.spawns.keys()) {
        const mapId = extra.areas[zoneId]?.m;
        if (mapId === undefined || !extra.mapIds.has(mapId)) continue;
        bucket(mapId).unplaced.push(npc.name);
        break;
      }
    }
  }
  for (const m of maps.values()) { delete m.index; m.unplaced = [...new Set(m.unplaced)].sort(); }
  return maps;
}

/** Someone you talk to (stands on a floor, usually indoors) rather than something that roams. */
const isPerson = (e) => !e.k && !!(e.f || e.qs || e.qe || (e.s && (e.a === 0 || e.h === 0)));

/**
 * The likeliest height from the map alone. @param floors what there is to stand on, lowest first (no water)
 * @returns { z, src }
 */
function guess(floors, person, lived, around) {
  let storeys = 1;
  for (let i = 1; i < floors.length; i++) if (floors[i].z - floors[i - 1].z > STOREY) storeys++;
  const open = floors.filter((f) => f.open);
  const ground = open.length ? open : floors;
  const built = person ? ground.filter((f) => f.built) : [];
  const pool = built.length ? built : ground;
  // of these: one somebody is known to stand on; else whatever is at the height of the people around; else the lowest
  let pick = pool.find((f) => lived.has(f.part));
  if (!pick && floors.length > 1) {
    const level = around();
    if (level !== null) {
      const best = floors.reduce((b, f) => (Math.abs(f.z - level) < Math.abs(b.z - level) ? f : b));
      if (Math.abs(best.z - level) <= LEVEL) pick = best;
    }
  }
  pick ??= pool[0];
  return { z: pick.z, src: storeys > 1 ? HEIGHT.GUESS : HEIGHT.ONLY };
}

/**
 * Give every spot of one map its height.
 * @param m     one map's { entries, points } from placeNpcs()
 * @param nav   NavReader for the map, or null if it has no walkable-ground data
 * @param ref   { creatures, objects } from readReference(), or null
 * @returns { spawns: Float32Array (x, y, z per spawn; z is NaN where not known), owner: Uint32Array, source: Uint8Array, counts: number[5] }
 */
export function resolveHeights(m, mapId, nav, ref) {
  const n = m.points.length;
  // in the order of the map's tiles, so the ground data is read a tile at a time
  const order = m.points.map((p, i) => i).sort((a, b) => {
    const pa = m.points[a], pb = m.points[b];
    return (Math.floor(pa.y / TILE) - Math.floor(pb.y / TILE)) || (Math.floor(pa.x / TILE) - Math.floor(pb.x / TILE));
  });
  const spawns = new Float32Array(n * 3), owner = new Uint32Array(n), source = new Uint8Array(n), counts = [0, 0, 0, 0, 0];
  // The stretches of walkable ground the reference database has someone standing on.
  const lived = new Set();
  const bears = (solid, z) => {
    let best = null;
    for (const f of solid) if (Math.abs(f.z - z) <= AGREE && (!best || Math.abs(f.z - z) < Math.abs(best.z - z))) best = f;
    if (best) lived.add(best.part);
    return !!best;
  };
  // First everyone the reference database places; then, knowing where people stand, the rest.
  const later = [];
  for (let k = 0; k < n; k++) {
    const p = m.points[order[k]], entry = m.entries[p.e];
    let x = p.x, y = p.y, z = NaN, src = HEIGHT.NONE;
    if (p.z !== undefined) {
      // placed by the reference database itself (a dungeon): does the ground here bear it out?
      const solid = nav ? nav.floorsAt(x, y, 1).filter((f) => !f.swim) : [];
      z = p.z;
      src = bears(solid, z) ? HEIGHT.AGREED : HEIGHT.REFERENCE;
    }
    const rows = src === HEIGHT.NONE && ref && (entry.k ? ref.objects : ref.creatures).get(entry.id);
    if (rows) {
      let best = -1, bestD = MATCH;
      for (let i = 0; i < rows.length; i += 4) {
        if (rows[i] !== mapId) continue;
        const d = Math.hypot(rows[i + 1] - x, rows[i + 2] - y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const rx = rows[best + 1], ry = rows[best + 2], rz = rows[best + 3];
        const solid = nav ? nav.floorsAt(rx, ry, 1).filter((f) => !f.swim) : [];
        if (bears(solid, rz)) { x = rx; y = ry; z = rz; src = HEIGHT.AGREED; }
        else if (!solid.length || rz >= solid[0].z - BURIED) { x = rx; y = ry; z = rz; src = HEIGHT.REFERENCE; }
        // (else it is under everything there is: the ground has changed here since; use the map's own)
      }
    }
    spawns[k * 3] = x; spawns[k * 3 + 1] = y; spawns[k * 3 + 2] = z;
    owner[k] = p.e;
    source[k] = src;
    if (src === HEIGHT.NONE && nav) later.push(k); else counts[src]++;
  }
  // Everyone placed so far, in a grid: for "how high are the people around here?" (the middle height of the five nearest).
  const grid = new Map();
  for (let k = 0; k < n; k++) {
    if (source[k] < HEIGHT.REFERENCE) continue;
    const key = `${Math.floor(spawns[k * 3] / NEAR)}:${Math.floor(spawns[k * 3 + 1] / NEAR)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(k);
  }
  const levelAround = (x, y) => {
    const near = [], cx = Math.floor(x / NEAR), cy = Math.floor(y / NEAR);
    for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      for (const k of grid.get(`${i}:${j}`) ?? []) { const d = Math.hypot(spawns[k * 3] - x, spawns[k * 3 + 1] - y); if (d <= NEAR) near.push([d, spawns[k * 3 + 2]]); }
    }
    if (!near.length) return null;
    const zs = near.sort((a, b) => a[0] - b[0]).slice(0, 5).map((q) => q[1]).sort((a, b) => a - b);
    return zs[zs.length >> 1];
  };
  for (const k of later) {
    const x = spawns[k * 3], y = spawns[k * 3 + 1], entry = m.entries[owner[k]];
    let z = NaN, src = HEIGHT.NONE;
    let floors = [];
    for (let reach = 0; reach <= 2 && !floors.length; reach++) floors = nav.floorsAt(x, y, reach).filter((f) => !f.swim);
    if (floors.length) ({ z, src } = guess(floors, isPerson(entry), lived, () => levelAround(x, y)));
    else {
      // nothing but water: something that swims, somewhere under the surface
      const water = nav.floorsAt(x, y, 1).filter((f) => f.swim);
      if (water.length) { z = water[0].z - 1; src = HEIGHT.GUESS; }
    }
    spawns[k * 3 + 2] = z;
    source[k] = src;
    counts[src]++;
  }
  return { spawns, owner, source, counts };
}

/** Write one map's file. Returns a short summary for the manifest. */
export function writeNpcs(out, m, h, info) {
  const meta = { source: info.source, reference: info.reference, entries: m.entries, unplaced: m.unplaced.slice(0, 300) };
  writeFileAtomic(out, packContainer('WFP1', NPCS_VERSION, [
    { id: NSEC.META, data: Buffer.from(JSON.stringify(meta)) },
    { id: NSEC.SPAWNS, data: h.spawns },
    { id: NSEC.OWNER, data: h.owner },
    { id: NSEC.SOURCE, data: h.source },
  ]));
  return { entries: m.entries.length, spawns: h.owner.length, heights: h.counts, unplaced: m.unplaced.length };
}

/**
 * The quests, for the map: who gives and takes each, what it asks for, and where those are.
 * @returns { quests: { id: {...} }, items: { id: {...} }, npcs: { id: [name, map, x, y] }, objects: { id: [name, map, x, y] } }
 */
/**
 * How often a creature (or a chest) with this loot gives an item, and how many at a time:
 * [chance (0..1), how many on average, true if only while you are on the quest that wants it] or null.
 * A loot table lists items on their own (each with its own chance), items in groups (one of
 * the group at most: those with no chance of their own share what is left), and references to
 * shared tables, rolled a number of times.
 */
function dropChance(tables, id, item, shared, depth = 0) {
  const rows = (shared ? tables.reference : tables.main).get(id);
  if (!rows || depth > 3) return null;
  // (what each group's members with no chance of their own get)
  const left = new Map();
  for (const [, chance, group, ref] of rows) {
    if (!group || ref < 0) continue;
    const g = left.get(group) ?? { given: 0, free: 0 };
    if (chance === 0) g.free++; else g.given += Math.abs(chance);
    left.set(group, g);
  }
  let miss = 1, count = 1, quest = false, found = false;
  for (const [it, chance, group, minOrRef, max] of rows) {
    if (minOrRef < 0) {
      // a shared table, rolled `max` times, each time with this chance
      const inner = dropChance(tables, -minOrRef, item, true, depth + 1);
      if (!inner) continue;
      const each = (Math.abs(chance) || 100) / 100 * inner[0];
      miss *= (1 - Math.min(1, each)) ** Math.max(1, max);
      count = inner[1]; quest = quest || inner[2]; found = true;
    } else if (it === item) {
      const g = group ? left.get(group) : null;
      const pct = chance !== 0 ? Math.abs(chance) : g && g.free ? Math.max(0, 100 - g.given) / g.free : 100;
      miss *= 1 - Math.min(1, pct / 100);
      count = (minOrRef + Math.max(minOrRef, max)) / 2; quest = quest || chance < 0; found = true;
    }
  }
  return found ? [1 - miss, count, quest] : null;
}

/**
 * The quests, with who gives and takes each and what it asks for (from QuestieDB) - and, for
 * the quest explorer, what the reference database knows on top (`ref`, from readReference()):
 * how many of each thing a quest asks for, how often each creature or chest gives an item a
 * quest wants, and how tough each creature involved is and how soon it is back.
 */
export function buildQuests(db, zones, ref = null) {
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  const first = (spawns) => {
    for (const [zoneId, points] of spawns ?? []) {
      const z = zoneByArea.get(zoneId);
      const p = z && points.find((q) => Array.isArray(q) && q[0] >= 0 && q[1] >= 0);
      if (p) return [z.map, r1(z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0])), r1(z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]))];
    }
    return null;
  };
  const npcById = new Map(db.npcs.map((n) => [n.id, n])), objById = new Map(db.objects.map((o) => [o.id, o]));
  const quests = {}, items = {}, npcs = {}, objects = {}, mobs = {};
  const spawnCount = (thing) => { let n = 0; for (const points of thing.spawns?.values() ?? []) n += points.length; return n; };
  // A creature a quest has you kill, or that carries what one wants: its levels, rank and how
  // many places it stands in (QuestieDB), and its health, kind and time to come back (the reference database, where it has it).
  const needMob = (id) => {
    const n = npcById.get(id);
    if (!n || mobs[id]) return;
    const m = { sp: spawnCount(n) };
    if (n.maxLevel > 0) m.lv = [n.minLevel || n.maxLevel, n.maxLevel];
    if (n.rank) m.rk = n.rank;
    const t = ref?.templates.get(id);
    if (t) { if (t.hp[1] > 0) m.hp = Math.round((t.hp[0] + t.hp[1]) / 2); if (t.type >= 1 && t.type <= 9) m.ct = t.type; }
    const back = ref?.respawn.get(id);
    if (back > 0) m.rs = back;
    mobs[id] = m;
  };
  const needNpc = (id) => { const n = npcById.get(id); if (n && !npcs[id]) npcs[id] = [n.name, ...(first(n.spawns) ?? [])]; };
  const needObj = (id) => { const o = objById.get(id); if (o && !objects[id]) objects[id] = [o.name, ...(first(o.spawns) ?? [])]; };
  const needItem = (id) => {
    if (items[id]) return;
    const it = db.item(id);
    if (!it) return;
    const out = { n: it.name };
    // (something every creature drops is not worth listing; the first fifty will do)
    if (it.npcDrops.length) { out.d = it.npcDrops.slice(0, 50); out.d.forEach(needNpc); out.d.forEach(needMob); }
    if (it.objectDrops.length) { out.o = it.objectDrops.slice(0, 50); out.o.forEach(needObj); }
    if (ref) {
      // how often each of them gives it, and how many at a time: [per cent, how many] (left out where the reference database does not say)
      const round = (c) => [Math.round(c[0] * 1000) / 10, Math.round(c[1] * 10) / 10];
      const dc = {}, oc = {};
      for (const who of out.d ?? []) {
        const t = ref.templates.get(who);
        const c = t?.loot ? dropChance({ main: ref.loot.creature, reference: ref.loot.reference }, t.loot, +id) : null;
        if (c && c[0] > 0) dc[who] = round(c);
      }
      for (const oid of out.o ?? []) {
        const lootId = ref.chests.get(oid);
        const c = lootId ? dropChance({ main: ref.loot.object, reference: ref.loot.reference }, lootId, +id) : null;
        if (c && c[0] > 0) oc[oid] = round(c);
      }
      if (Object.keys(dc).length) out.dc = dc;
      if (Object.keys(oc).length) out.oc = oc;
    }
    if (it.vendors.length) { out.v = it.vendors.slice(0, 20); out.v.forEach(needNpc); }
    items[id] = out;
  };
  // Which side a quest is for, from the races allowed (1 Alliance, 2 Horde, 3 either).
  const side = (races) => { const low = races % 256; const s = (low & 77 ? 1 : 0) | (low & 178 ? 2 : 0); return s || 3; };
  for (const q of db.quests) {
    const o = { n: q.name, l: q.level, m: q.minLevel, side: side(q.races) };
    if (q.maxLevel) o.x = q.maxLevel;
    if (q.classes) o.c = q.classes;
    if (q.starts.npcs.length) { o.s = q.starts.npcs; o.s.forEach(needNpc); }
    if (q.starts.objects.length) { o.so = q.starts.objects; o.so.forEach(needObj); }
    if (q.starts.items.length) { o.si = q.starts.items; o.si.forEach(needItem); }
    if (q.ends.npcs.length) { o.e = q.ends.npcs; o.e.forEach(needNpc); }
    if (q.ends.objects.length) { o.eo = q.ends.objects; o.eo.forEach(needObj); }
    if (q.text.length) o.t = q.text.join(' ');
    if (q.pre.length) o.pre = q.pre;
    if (q.preAll.length) o.pa = q.preAll;
    if (q.exclusive.length) o.ex = q.exclusive;
    if (q.next) o.nx = q.next;
    if (q.zoneOrSort) o.z = q.zoneOrSort;
    if (q.special & 1) o.rep = 1; // repeatable
    if (q.objectives.creatures.length) { o.oc = q.objectives.creatures; o.oc.forEach(needNpc); o.oc.forEach(needMob); }
    if (q.objectives.killCredit.length) { o.ok = q.objectives.killCredit; o.ok.forEach(needNpc); o.ok.forEach(needMob); }
    // how many of each thing it asks for, and what kind of quest it is (the reference database's, for the quests it has)
    const known = ref?.quests.get(q.id);
    if (known) {
      if (known.needs.length) {
        o.nd = known.needs;
        for (const [kind, id] of known.needs) { if (kind === 'i') needItem(id); else if (kind === 'o') needObj(id); else { needNpc(id); needMob(id); } }
      }
      if (known.type) o.ty = known.type;
      if (known.limit) o.tl = known.limit;
    }
    if (q.objectives.objects.length) { o.oo = q.objectives.objects; o.oo.forEach(needObj); }
    if (q.objectives.items.length) { o.oi = q.objectives.items; o.oi.forEach(needItem); }
    if (q.trigger) {
      const spots = [];
      for (const [zoneId, points] of q.trigger.spawns) {
        const z = zoneByArea.get(zoneId);
        if (!z || !Array.isArray(points)) continue;
        for (const p of points) if (Array.isArray(p) && p[0] >= 0 && p[1] >= 0) spots.push([z.map, r1(z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0])), r1(z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]))]);
      }
      if (spots.length) o.tr = { t: q.trigger.text, at: spots };
    }
    quests[q.id] = o;
  }
  return { quests, items, npcs, objects, mobs };
}
