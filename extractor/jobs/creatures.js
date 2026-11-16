// Where creatures are stationed: spawn points and patrol paths per map, with level range, rank
// and whether they attack each player faction. This is the source for the map's spawn zones.
//
// Positions come from the QuestieDB addon (zone-map percentages) and are converted to world
// coordinates with the game's own zone rectangles. Hostility comes from the game's faction
// template table, so neutral wildlife is not mistaken for a threat.
//
// The database is community-collected and, for creatures new to this game, incomplete:
//   * no faction recorded  -> whether it attacks is not known. It is kept, flagged `u`: the spawn
//     zones show such creatures only when asked to, and say that their side is a guess. (They
//     were once treated as hostile outright, and then left out altogether: too many were quest
//     NPCs, props and visitors from events, which mattered while routes went round the zones.
//     Routes no longer do. The ones that give or take a quest, or have a job, are still left
//     out: those are people to talk to.)
//   * a level range 5+ wide -> the real level at a given spot is unknown, so it is estimated
//     from the other creatures of the same zone (flagged `est`).
//   * recorded as hostile, but standing inside a town or city of the side it is hostile to ->
//     not a danger to that side (flagged `t`; see townFinder()). These are the weather and
//     event helpers the game keeps in towns, practice targets, the other side's flight master in
//     a neutral port, and the odd quest villain in a capital.
import { packContainer, writeFileAtomic } from '../container.js';

export const CREATURES_VERSION = 9;
// What extract.js adds to world.json from QuestieDB and the map's own area grids: the area each
// innkeeper stands in, the dungeons' doors. Raise it when that changes: the page then offers
// "Update map", which writes world.json anew and builds nothing else again.
export const PLACES_VERSION = 2;
export const CSEC = { META: 1, SPAWNS: 2, SPAWN_CREATURE: 3, PATH_POINTS: 4, PATHS: 5 };

// Faction group bits: 1 = any player, 2 = Alliance, 4 = Horde.
const ALLIANCE = 1 | 2, HORDE = 1 | 4;
const FRIENDLY = 0, NEUTRAL = 1, HOSTILE = 2;
const WIDE = 5; // level span from which a recorded range is not trusted

/** @returns [reactionToAlliance, reactionToHorde, true if no side is recorded for it (so neither reaction is known)] */
export function reactions(npc, templates) {
  const t = npc.faction ? templates?.get(npc.faction) : null;
  if (t) {
    const to = (mask) => (t.enemy & mask ? HOSTILE : t.friend & mask ? FRIENDLY : NEUTRAL);
    return [to(ALLIANCE), to(HORDE), false];
  }
  // No faction data: all that is known is which side (if any) it is marked friendly to.
  const f = npc.friendly ?? '';
  return [f.includes('A') ? FRIENDLY : HOSTILE, f.includes('H') ? FRIENDLY : HOSTILE, true];
}

const TOWN_REACH = 40; // yards
const TOWN_FOLK = 3;   // this many of a town's people within TOWN_REACH: the spot is in among them

/**
 * Tells whether a spot is clearly inside a town or city of each side.
 *
 * A city is one of the capitals the game's area table marks, with the side it belongs to. A
 * creature the database files mostly under cities lives in them (the beast in Stormwind's
 * canals, a rioter at the Stockade), and each such spawn point is in the city. One that mostly
 * lives elsewhere is wildlife the city's map happens to take in (the wolves on the plain at the
 * foot of Thunder Bluff), and is treated like one standing on a town's ground:
 * A town is the named place where an innkeeper who is not hostile to that side, or one of its
 * flight masters, stands. Such a place takes in the fields around the town as well, where the
 * wolves are real (and a city's ground the plain at the foot of it), so a spot on a town's or
 * a city's ground only counts as in it when it also has TOWN_FOLK of the place's people within
 * TOWN_REACH yards: everyone friendly to that side, and the neutral who offer a service
 * (wildlife is neutral too, and is not people).
 *
 * @param places { areaAt(map, x, y), areas, capitals: [{ area, sides }], inns, taxiNodes } or null
 * @returns { inTown(map, x, y, zoneId, resident) => bit 1: in an Alliance (or neutral) town or city; bit 2: the Horde's,
 *            resident(npc) => true if the creature lives in cities }
 */
function townFinder(npcs, zoneByArea, toWorld, templates, places) {
  if (!places) return { inTown: () => 0, resident: () => false };
  const { areaAt, areas } = places;
  const capital = new Map(places.capitals.map((c) => [c.area, c.sides]));
  const towns = [new Set(), new Set()];
  const mark = (side, map, x, y) => { const id = areaAt(map, x, y); if (id && areas[id]?.p) towns[side].add(`${map}/${id}`); }; // (a named place, not a whole zone)
  for (const i of places.inns ?? []) {
    if (i.a < HOSTILE) mark(0, i.map, i.pos[0], i.pos[1]);
    if (i.h < HOSTILE) mark(1, i.map, i.pos[0], i.pos[1]);
  }
  for (const n of places.taxiNodes ?? []) {
    if (!n.pos[0] && !n.pos[1]) continue;
    if (n.flags & 1) mark(0, n.map, n.pos[0], n.pos[1]);
    if (n.flags & 2) mark(1, n.map, n.pos[0], n.pos[1]);
  }
  const folk = [new Map(), new Map()]; // per side: "map:cx:cy" -> [x, y, ...]
  const cellKey = (map, x, y) => `${map}:${Math.floor(x / TOWN_REACH)}:${Math.floor(y / TOWN_REACH)}`;
  for (const npc of npcs) {
    if (!npc.spawns) continue;
    const r = reactions(npc, templates);
    const service = !!(npc.flags || npc.questGiver);
    for (let side = 0; side < 2; side++) {
      if (!(r[side] === FRIENDLY || (r[side] === NEUTRAL && service))) continue;
      for (const [zoneId, points] of npc.spawns) {
        const z = zoneByArea.get(zoneId);
        if (!z) continue;
        for (const p of points) {
          if (!Array.isArray(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue;
          const [x, y] = toWorld(z, p[0], p[1]);
          const key = cellKey(z.map, x, y);
          let list = folk[side].get(key);
          if (!list) folk[side].set(key, (list = []));
          list.push(x, y);
        }
      }
    }
  }
  const among = (side, map, x, y) => {
    let n = 0;
    for (let dy = -TOWN_REACH; dy <= TOWN_REACH; dy += TOWN_REACH) for (let dx = -TOWN_REACH; dx <= TOWN_REACH; dx += TOWN_REACH) {
      const list = folk[side].get(cellKey(map, x + dx, y + dy));
      if (!list) continue;
      for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - y) <= TOWN_REACH && ++n >= TOWN_FOLK) return true;
    }
    return false;
  };
  const resident = (npc) => {
    let all = 0, city = 0;
    for (const [zoneId, points] of npc.spawns ?? []) { all += points.length; if (capital.has(zoneId)) city += points.length; }
    return city > 0 && city * 2 >= all;
  };
  const inTown = (map, x, y, zoneId, lives) => {
    const id = areaAt(map, x, y);
    // a city's own creature, filed under it: in it. Anything else on a city's ground or a
    // town's (or wildlife filed under a city): only when in among the place's people.
    const filed = capital.get(zoneId) ?? 0;
    let bits = lives ? filed : 0, ground = lives ? 0 : filed;
    for (let a = id, n = 0; a && areas[a] && n < 6; a = areas[a].p, n++) ground |= capital.get(a) ?? 0;
    for (let side = 0; side < 2; side++) {
      const bit = 1 << side;
      if (!(bits & bit) && (ground & bit || towns[side].has(`${map}/${id}`)) && among(side, map, x, y)) bits |= bit;
    }
    return bits;
  };
  return { inTown, resident };
}

const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * @param npcs       from readQuestieNpcs()
 * @param zones      world.data.zones (uiMap rectangles with their area id and map)
 * @param templates  Map<factionTemplateId, { friend, enemy }> or null
 * @param places     what townFinder() needs to know the towns and cities, or null to leave that out
 * @returns {{ maps: Map<mapId, { creatures, spawns, spawnCreature, pathPoints, paths }>, dropped }}
 */
export function placeCreatures(npcs, zones, templates, places = null) {
  // Questie zone id == the area id of a zone map. Prefer the plain zone map when several share it.
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const toWorld = (z, px, py) => [z.region[2] - (py / 100) * (z.region[2] - z.region[0]), z.region[3] - (px / 100) * (z.region[3] - z.region[1])];

  // Typical creature level per zone (weighted by spawn points), from entries with a normal range.
  const zoneLevels = new Map();
  for (const npc of npcs) {
    if (!npc.spawns || !(npc.maxLevel > 0) || npc.maxLevel - npc.minLevel >= WIDE) continue;
    for (const [zoneId, points] of npc.spawns) {
      let list = zoneLevels.get(zoneId);
      if (!list) zoneLevels.set(zoneId, (list = []));
      for (let i = 0; i < points.length; i++) list.push(npc.maxLevel);
    }
  }
  const zoneLevel = new Map([...zoneLevels].map(([z, list]) => [z, median(list)]));
  const { inTown, resident } = townFinder(npcs, zoneByArea, toWorld, templates, places);
  const maps = new Map();
  const bucket = (mapId) => {
    let m = maps.get(mapId);
    if (!m) maps.set(mapId, (m = { creatures: [], index: new Map(), spawns: [], spawnCreature: [], pathPoints: [], paths: [] }));
    return m;
  };
  const dropped = { unknownLevel: 0, friendly: 0, unconfirmed: 0, unconfirmedPoints: 0, unconfirmedFolk: 0, noZoneMap: 0, inTown: 0 };
  for (const npc of npcs) {
    if (!npc.spawns && !npc.paths) continue;
    if (!(npc.maxLevel > 0) || npc.name === 'Unknown') { dropped.unknownLevel++; continue; }
    const react = reactions(npc, templates);
    // no side recorded: whether it attacks anyone is not known. Someone to talk to makes no zone;
    // the rest are kept, and say that their side is a guess (u).
    const unsure = react[2];
    if (unsure) {
      if (npc.flags || npc.questGiver) { dropped.unconfirmedFolk++; continue; }
      dropped.unconfirmed++;
      for (const points of npc.spawns?.values() ?? []) dropped.unconfirmedPoints += points.length;
    }
    if (react[0] === FRIENDLY && react[1] === FRIENDLY) { dropped.friendly++; continue; } // never a threat to anyone
    const wide = npc.maxLevel - npc.minLevel >= WIDE;
    const hostileTo = (react[0] === HOSTILE ? 1 : 0) | (react[1] === HOSTILE ? 2 : 0), lives = resident(npc);
    // one entry per creature per map; a wide-range creature gets one per zone (its level differs),
    // and its spawn points inside a side's towns get one of their own (t: which side's)
    const indexOf = (m, zoneId, town = 0) => {
      const key = `${wide ? `${npc.id}/${zoneId}` : npc.id}${town ? `/t${town}` : ''}`; // (per creature, per zone where its level differs, per town it stands in)
      let i = m.index.get(key);
      if (i === undefined) {
        i = m.creatures.length;
        m.index.set(key, i);
        const c = { id: npc.id, name: npc.name, min: npc.minLevel, max: npc.maxLevel, rank: npc.rank, a: react[0], h: react[1] };
        if (unsure) c.u = 1;
        if (town) c.t = town;
        if (wide) {
          const lv = Math.max(npc.minLevel, Math.min(npc.maxLevel, zoneLevel.get(zoneId) ?? npc.minLevel));
          c.min = lv; c.max = lv; c.est = 1;
        }
        m.creatures.push(c);
      }
      return i;
    };
    for (const [zoneId, points] of npc.spawns ?? []) {
      const z = zoneByArea.get(zoneId);
      if (!z) { dropped.noZoneMap++; continue; }
      const m = bucket(z.map);
      for (const p of points) {
        if (!Array.isArray(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue; // -1,-1 = position unknown
        const [x, y] = toWorld(z, p[0], p[1]);
        // hostile on paper, but standing in a town or city of the side it is hostile to
        const town = inTown(z.map, x, y, zoneId, lives) & hostileTo;
        if (town) dropped.inTown++;
        if (town && town === hostileTo) continue; // (no side is left for it to be a danger to)
        m.spawns.push(x, y);
        m.spawnCreature.push(indexOf(m, zoneId, town));
      }
    }
    for (const [zoneId, paths] of npc.paths ?? []) {
      const z = zoneByArea.get(zoneId);
      if (!z) continue;
      const m = bucket(z.map);
      for (const pathPts of paths) {
        if (!Array.isArray(pathPts) || pathPts.length < 2) continue;
        const first = m.pathPoints.length / 2;
        let town = hostileTo; // a patrol is in a town if every point of it is
        for (const p of pathPts) {
          if (!Array.isArray(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue;
          const [x, y] = toWorld(z, p[0], p[1]);
          town &= inTown(z.map, x, y, zoneId, lives);
          m.pathPoints.push(x, y);
        }
        const count = m.pathPoints.length / 2 - first;
        if (count >= 2 && !(town && town === hostileTo)) m.paths.push(indexOf(m, zoneId, town), first, count);
        else m.pathPoints.length = first * 2;
      }
    }
  }
  return { maps, dropped };
}

const INNKEEPER = 128; // QuestieDB npc flag

/**
 * Every innkeeper and where they stand, for knowing where a hearthstone leads (the game only
 * tells an addon the name of the place it is set to).
 * @returns [{ name, map, zone (area id of the zone map they are on), pos: [x, y], a, h (reaction to each side: 0 friendly, 1 neutral, 2 hostile) }]
 *          (extract.js adds to each: area, the game's own area under their feet, where the map says)
 */
/**
 * The dungeons, each with where its doors are in the world: for leading a quest that is done
 * inside one to the way in (nobody in a dungeon new to this game can be placed, and nothing in
 * any dungeon is on the map you stand on outside it).
 * @param list   from QuestieDB (questie-extras.js: readQuestieDungeons): doors as per cent of a zone's map
 * @param areas  the game's areas (world.js): the map a dungeon's own area is on is the dungeon's map
 * @returns [{ area, name, also (area ids its quests are filed under as well), map (the dungeon's own, or null), doors: [{ map, pos: [x, y] }] }]
 */
export function placeDungeons(list, zones, areas) {
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const out = [];
  for (const d of list) {
    const doors = [];
    for (const q of d.doors) {
      const z = zoneByArea.get(q.zone);
      if (!z) continue;
      const x = z.region[2] - (q.y / 100) * (z.region[2] - z.region[0]), y = z.region[3] - (q.x / 100) * (z.region[3] - z.region[1]);
      doors.push({ map: z.map, pos: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] });
    }
    if (doors.length) out.push({ area: d.area, name: d.name, also: d.also, map: areas[d.area]?.m ?? null, doors });
  }
  return out;
}

export function placeInns(npcs, zones, templates) {
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const inns = [];
  for (const npc of npcs) {
    // (the flag, not the title under the name: an innkeeper's assistant has the title too)
    if (!npc.spawns || !(npc.flags & INNKEEPER)) continue;
    const react = reactions(npc, templates);
    for (const [zoneId, points] of npc.spawns) {
      const z = zoneByArea.get(zoneId);
      const p = points.find((q) => Array.isArray(q) && q[0] >= 0 && q[1] >= 0);
      if (!z || !p) continue;
      const x = z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0]), y = z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]);
      inns.push({ name: npc.name, map: z.map, zone: zoneId, pos: [Math.round(x * 10) / 10, Math.round(y * 10) / 10], a: react[0], h: react[1] });
    }
  }
  return inns;
}

/** Write one map's creature file. Returns a short summary for the manifest. */
export function writeCreatures(out, m, source) {
  const meta = { source, creatures: m.creatures };
  writeFileAtomic(out, packContainer('WFC1', CREATURES_VERSION, [
    { id: CSEC.META, data: Buffer.from(JSON.stringify(meta)) },
    { id: CSEC.SPAWNS, data: new Float32Array(m.spawns) },
    { id: CSEC.SPAWN_CREATURE, data: new Uint32Array(m.spawnCreature) },
    { id: CSEC.PATH_POINTS, data: new Float32Array(m.pathPoints) },
    { id: CSEC.PATHS, data: new Uint32Array(m.paths) },
  ]));
  const counts = new Uint32Array(m.creatures.length);
  for (const i of m.spawnCreature) counts[i]++;
  return { creatures: m.creatures.length, spawns: m.spawnCreature.length, paths: m.paths.length / 3 };
}
