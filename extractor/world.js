// World metadata from the client database: maps, area names, zones, points of interest,
// liquids, and the links between places (flight paths, area triggers) that a route planner needs.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadTable } from './tables.js';
import { readCache } from './hotfix.js';
import { transportLines, findPortalData, readPortals } from './transit.js';

export const WORLD_VERSION = 9; // raise when the contents of world.json change (6: lifts; 7: bosses, and what the server sent since the game's files were made; 8: locks and what professions work at; 9: where each lift stops and how long its round takes)
/** The ways into a lock that are a skill of a player's own, by the game's number for each (its table LockType). */
const LOCK_SKILLS = { 1: 'Lockpicking', 2: 'Herbalism', 3: 'Mining', 19: 'Fishing' };
/** Which of an object's numbers names its lock, by the object's kind (0 a door, 1 a button, 2 a quest giver, 3 a chest - herbs and veins are chests -, 6 a trap, 10 a thing you use, 25 a school of fish, 50 a node). */
const LOCK_AT = { 0: 1, 1: 1, 2: 0, 3: 0, 6: 0, 10: 0, 13: 0, 22: 0, 23: 0, 24: 0, 25: 4, 50: 0 };
/**
 * What an object asks of whoever would open it, and what it is to a profession, in words:
 * { need: "Herbalism 70" | "Lockpicking 150 or a key" | "a key", spot: "Anvil" } (either may be
 * missing). `type` and `data` are the object's kind and numbers as the server gives them.
 * @param opens  world.json's opens
 */
export function objectNeeds(opens, type, data) {
  const out = {};
  if (!opens || !Number.isInteger(type) || !Array.isArray(data)) return out;
  if (type === 8) { const spot = opens.spots?.[data[0]]; if (spot) out.spot = spot; return out; }
  const lock = opens.locks?.[data[LOCK_AT[type] ?? -1]];
  if (!lock) return out;
  const ways = (lock.s ?? []).map(([skill, level]) => `${opens.skills?.[skill] ?? 'a skill'} ${level}`);
  // (a key is another way into what a lock pick opens. The game's table also names one for four
  // kinds of ore vein - an axe, Rockslicer - which opens nothing: what is gathered is gathered)
  if (lock.k?.length && !(lock.s ?? []).some(([skill]) => skill !== 1)) ways.push('a key');
  if (ways.length) out.need = ways.join(' or ');
  return out;
}
export const ROOMS_VERSION = 1; // ...and of rooms.json
const hex = (argb) => '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);

/**
 * What the game calls each room of its buildings (its table WMOAreaTable): the words it shows
 * over the minimap while you stand in that room. A building is put together of rooms ("groups"),
 * and the table names them by the building's number, the set of names its placement on the map
 * uses, and the room's own number (-1: the whole building, for every room with no line of its
 * own). A line with no name of its own takes the name of the area it is filed under.
 *
 * The game says that name to an addon (GetMinimapZoneText), and the map knows which room every
 * floor belongs to: so where two floors, one over the other, are in rooms of different names,
 * the name says which you are on (viewer/js/height.js).
 * @returns {{ names: string[], wmo: { [building]: number[] } }}  per building a flat list of
 *          name set, room, index into names - three numbers a line
 */
export function roomNames(rows, areas) {
  const names = [], index = new Map(), wmo = {};
  for (const r of rows) {
    const name = String(r.AreaName_lang || areas[r.AreaTableID]?.n || '').trim();
    if (!name || !Number.isInteger(r.WMOID) || r.WMOID <= 0) continue;
    let i = index.get(name);
    if (i === undefined) { i = names.length; names.push(name); index.set(name, i); }
    (wmo[r.WMOID] ??= []).push(r.NameSetID | 0, Number.isInteger(r.WMOGroupID) ? r.WMOGroupID : -1, i);
  }
  return { names, wmo };
}

const LIFT_TRAVEL = 10; // yards up and down that make a lift (the doors beside one move less)
const LIFT_ACROSS = 6;  // ...and no further than this across (the tram's cars are objects of the same kind)
const LIFT_REACH = 7;   // yards from its middle within which you may be standing on it
const LIFT_SAME = 5;    // two such objects this close are parts of one lift: the one that travels furthest is it
const LIFT_STILL = 0.5; // yards a platform may move between two moments of its round and count as standing
const LIFT_STOP = 1;    // seconds it has to stand at a height, in a round, for that height to be a stop
const LIFT_APART = 2.5; // yards between two heights it stands at for them to be two stops

/**
 * A lift's round, read off the moments the game's table gives of it: at which heights it stands
 * (counted from where the object stands), how long the round takes, how fast it goes between
 * its stops and how long it stands at one. Null where the moments do not say (one moment only).
 * @param moments  [[milliseconds into the round, height], ...]
 * @returns {{ stops: number[] (lowest first), round: seconds, speed: yards a second, still: seconds }}
 */
export function liftRound(moments) {
  const m = [...moments].sort((a, b) => a[0] - b[0]);
  const round = m.length ? m[m.length - 1][0] / 1000 : 0;
  if (m.length < 2 || !(round > 0)) return null;
  const stood = []; // { z, s }: a height it stands at, and for how long in a round
  let travel = 0, moving = 0;
  for (let i = 0; i + 1 < m.length; i++) {
    const s = (m[i + 1][0] - m[i][0]) / 1000, dz = m[i + 1][1] - m[i][1];
    if (!(s > 0)) continue;
    if (Math.abs(dz) > LIFT_STILL) { travel += Math.abs(dz); moving += s; continue; }
    const z = (m[i][1] + m[i + 1][1]) / 2;
    const at = stood.find((b) => Math.abs(b.z - z) <= LIFT_APART);
    if (at) { at.z = (at.z * at.s + z * s) / (at.s + s); at.s += s; } else stood.push({ z, s });
  }
  const stops = stood.filter((b) => b.s >= LIFT_STOP).sort((a, b) => a.z - b.z);
  if (stops.length < 2 || !(moving > 0)) return null;
  // (it calls at each stop between its two ends twice in a round, at each end once)
  const calls = 2 * (stops.length - 1);
  return { stops: stops.map((b) => b.z), round, speed: travel / moving, still: stops.reduce((sum, b) => sum + b.s, 0) / calls };
}

/**
 * The lifts: objects that carry whoever stands on them up and down (Thunder Bluff, the
 * Undercity, the Great Lift). Nothing the game tells an addon says you are on one, and it moves
 * you a long way up or down without a step across the map: so the map has to know where they
 * are. Where each stands is the reference database's word (the game's files do not place
 * objects, its server does), how far it travels the game's own: its table TransportAnimation
 * says where such an object is at each moment of its round, counted from where it stands.
 * The same table says where it stops and how long its round takes: a route that takes a lift
 * (viewer/js/navworker.js) counts half a round of waiting and the ride.
 * @param ref   what readReference() gave: objects (where each object stands) and movers (the objects of this kind)
 * @param rows  TransportAnimation
 * @returns [{ id, name, map, x, y, lo, hi, r, stops, round, speed, still }]  lo, hi: how low and how high its
 *          platform gets; r: how far from its middle you may be on it; stops: the heights it stands at,
 *          lowest first; round: seconds its round takes; speed: yards a second between stops; still:
 *          seconds it stands at one (the last four only where the table says: see liftRound)
 */
export function liftsOf(ref, rows) {
  const travel = new Map();
  for (const r of rows) {
    if (!Array.isArray(r.Pos)) continue;
    let t = travel.get(r.TransportID);
    if (!t) travel.set(r.TransportID, (t = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], moments: [] }));
    for (let i = 0; i < 3; i++) { t.lo[i] = Math.min(t.lo[i], r.Pos[i]); t.hi[i] = Math.max(t.hi[i], r.Pos[i]); }
    if (Number.isFinite(r.TimeIndex)) t.moments.push([r.TimeIndex, r.Pos[2]]);
  }
  const all = [];
  for (const [id, name] of ref?.movers ?? []) {
    const t = travel.get(id), at = ref.objects?.get(id);
    if (!t || !at || t.hi[2] - t.lo[2] < LIFT_TRAVEL || Math.max(t.hi[0] - t.lo[0], t.hi[1] - t.lo[1]) > LIFT_ACROSS) continue;
    // (its stops: only where the lowest and the highest of them are its two ends - else the ends alone, as before)
    const how = liftRound(t.moments);
    const sound = !!how && Math.abs(how.stops[0] - t.lo[2]) <= LIFT_APART && Math.abs(how.stops[how.stops.length - 1] - t.hi[2]) <= LIFT_APART;
    for (let i = 0; i + 3 < at.length; i += 4) {
      const lift = { id, name, map: at[i], x: r3([at[i + 1]])[0], y: r3([at[i + 2]])[0], lo: r3([at[i + 3] + t.lo[2]])[0], hi: r3([at[i + 3] + t.hi[2]])[0], r: LIFT_REACH };
      if (sound) {
        const z = at[i + 3];
        lift.stops = r3(how.stops.map((s, k) => (k === 0 ? t.lo[2] : k === how.stops.length - 1 ? t.hi[2] : s) + z));
        lift.round = Math.round(how.round * 10) / 10; lift.speed = Math.round(how.speed * 100) / 100; lift.still = Math.round(how.still * 10) / 10;
      }
      all.push(lift);
    }
  }
  all.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo) || a.id - b.id || a.x - b.x || a.y - b.y);
  const out = [];
  for (const l of all) if (!out.some((o) => o.map === l.map && Math.hypot(o.x - l.x, o.y - l.y) < LIFT_SAME)) out.push(l);
  return out.sort((a, b) => a.map - b.map || a.x - b.x || a.y - b.y);
}

/**
 * A table of the game's with what the game's server has sent since its files were made laid over
 * it (the hotfix cache: hotfix.js). The game's files do not hold every record: a dungeon added
 * after they were made - its map, its areas, the names of its rooms - comes that way, and so
 * does a flight path that was moved. Where the sent records cannot be laid over (a layout this
 * version cannot read), the table is read as the files have it: better that than no table.
 * @param cache  what readCache(cfg) gave (null: there is none)
 * @returns what loadTable() returns, its `hash` taking in what was laid over - or null
 */
export async function loadSentTable(casc, name, log, cache) {
  let t = cache ? await loadTable(casc, name, () => {}, { cache }) : null;
  if (!t) t = await loadTable(casc, name, log);
  if (t?.sent) t.hash = `${t.hash}+${t.sent}`;
  return t;
}

export async function buildWorld(casc, log, cfg = null) {
  const names = ['Map', 'AreaTable', 'UiMap', 'UiMapAssignment', 'AreaPOI', 'LiquidType', 'LiquidObject', 'LiquidMaterial', 'TaxiNodes', 'TaxiPath', 'TaxiPathNode', 'AreaTrigger', 'DungeonEncounter', 'QuestXP', 'Lock', 'SpellFocusObject'];
  const T = {};
  const hashes = [];
  let cache = null;
  try { cache = cfg ? readCache(cfg) : null; } catch { cache = null; }
  let sentRows = 0;
  // (the tables that say how water is laid out are read as the game's files have them: every
  // tile of terrain is built with them, the tiles themselves come out of the files, and a record
  // sent later for a new kind of water would have every tile of every map built again for nothing)
  const AS_FILED = new Set(['LiquidType', 'LiquidObject', 'LiquidMaterial']);
  for (const name of names) {
    const t = AS_FILED.has(name) ? await loadTable(casc, name, log) : await loadSentTable(casc, name, log, cache);
    T[name] = t?.rows ?? [];
    if (t?.sent) sentRows += t.hotfixed ?? 0;
    hashes.push(`${name}:${t?.hash ?? 'none'}`);
  }
  if (sentRows) log(`world tables: ${sentRows.toLocaleString()} records the game's server has sent since its files were made are laid over them`);
  if (!T.Map.length) throw new Error('Map table could not be read from the game data');

  // Liquid vertex-format lookup (needed to decode water height data correctly).
  const lvfByMaterial = Object.fromEntries(T.LiquidMaterial.map((r) => [r.ID, r.LVF]));
  const lvf = { byType: {}, typeForObject: {} };
  for (const r of T.LiquidType) if (lvfByMaterial[r.MaterialID] !== undefined) lvf.byType[r.ID] = lvfByMaterial[r.MaterialID];
  for (const r of T.LiquidObject) lvf.typeForObject[r.ID] = r.LiquidTypeID;

  const liquidTypes = {};
  for (const r of T.LiquidType) {
    const name = r.Name ?? '';
    let kind = ['water', 'ocean', 'magma', 'slime'][r.SoundBank] ?? 'water';
    if (kind === 'water' && /ocean/i.test(name)) kind = 'ocean';
    liquidTypes[r.ID] = { name, kind, colors: (r.Color ?? []).filter((c) => c !== 0).map(hex) };
  }

  const areas = {};
  for (const r of T.AreaTable) areas[r.ID] = { n: r.AreaName_lang, p: r.ParentAreaID, m: r.ContinentID };

  // Capital cities and whose they are (sides: bit 1 Alliance, bit 2 Horde). The game marks
  // them itself; a district without a side of its own takes the side of the city it is in.
  const areaRow = new Map(T.AreaTable.map((r) => [r.ID, r]));
  const capitals = [];
  for (const r of T.AreaTable) {
    if (!((Array.isArray(r.Flags) ? r.Flags[0] : r.Flags) & 0x100)) continue;
    let mask = 0;
    for (let a = r, n = 0; a && n < 6 && !mask; a = areaRow.get(a.ParentAreaID), n++) mask = a.FactionGroupMask;
    const sides = (mask & 2 ? 1 : 0) | (mask & 4 ? 2 : 0);
    if (sides) capitals.push({ area: r.ID, map: r.ContinentID, sides });
  }

  const uiMapById = new Map(T.UiMap.map((r) => [r.ID, r]));
  const zones = [];
  for (const a of T.UiMapAssignment) {
    const u = uiMapById.get(a.UiMapID);
    if (!u) continue;
    zones.push({
      uiMap: u.ID, name: u.Name_lang, type: u.Type, parent: u.ParentUiMapID, map: a.MapID, area: a.AreaID, order: a.OrderIndex,
      // world-space rectangle this UI map covers: [minX, minY, maxX, maxY]; in-game map coords are
      // x% = (maxY - worldY) / (maxY - minY), y% = (maxX - worldX) / (maxX - minX)
      region: r3([a.Region[0], a.Region[1], a.Region[3], a.Region[4]]),
      ui: r3([a.UiMin[0], a.UiMin[1], a.UiMax[0], a.UiMax[1]]),
    });
  }

  const pois = T.AreaPOI.map((r) => ({ id: r.ID, name: r.Name_lang, desc: r.Description_lang || undefined, map: r.ContinentID, area: r.AreaID, pos: r3(r.Pos), icon: r.Icon, importance: r.Importance, flags: r.Flags }));
  const taxiNodes = T.TaxiNodes.map((r) => ({ id: r.ID, name: r.Name_lang, map: r.ContinentID, pos: r3(r.Pos), flags: r.Flags }));
  const pathPoints = new Map();
  for (const n of T.TaxiPathNode) {
    let list = pathPoints.get(n.PathID);
    if (!list) pathPoints.set(n.PathID, (list = []));
    list.push(n);
  }
  const taxiPaths = T.TaxiPath.map((r) => {
    const pts = (pathPoints.get(r.ID) ?? []).sort((a, b) => a.NodeIndex - b.NodeIndex);
    const path = { id: r.ID, from: r.FromTaxiNode, to: r.ToTaxiNode, cost: r.Cost, map: pts[0]?.ContinentID ?? -1, points: pts.map((p) => r3(p.Loc)) };
    // A boat or zeppelin route can cross to another continent part-way: say which map each point is on.
    if (pts.some((p) => p.ContinentID !== path.map)) path.pointMaps = pts.map((p) => p.ContinentID);
    return path;
  });
  // Boats and zeppelins (from the game's tables) and the doorways between maps: for planning
  // journeys across maps. The doorways are not in the game's files. The list kept with this
  // project (doorways.json) is used, or the ShortestPathForever addon's own where that is
  // installed (it may be newer): nothing has to be installed for it.
  const transports = transportLines(T.TaxiNodes, T.TaxiPath, T.TaxiPathNode);
  let portals = [];
  try {
    const own = fs.readFileSync(new URL('./doorways.json', import.meta.url), 'utf8');
    portals = JSON.parse(own).portals;
    let from = `doorways:${crypto.createHash('sha1').update(own).digest('hex')}`;
    const file = cfg ? findPortalData(cfg) : null;
    if (file) {
      try { const p = readPortals(file); if (p.portals.length) { portals = p.portals; from = `portals:${p.hash}`; } } catch (err) { log(`ShortestPathForever's portal list unreadable (${err.message}): using the project's own`); }
    }
    hashes.push(from);
  } catch (err) { log(`portal list unreadable: ${err.message}`); }
  const areaTriggers = T.AreaTrigger.map((r) => ({
    id: r.ID, map: r.ContinentID, pos: r3(r.Pos), radius: r.Radius,
    box: r.Box_length || r.Box_width || r.Box_height ? r3([r.Box_length, r.Box_width, r.Box_height, r.Box_yaw]) : undefined,
  }));

  // The bosses of each dungeon and raid, as the game itself lists them (its table
  // DungeonEncounter: what it counts a kill of towards being saved to the place), in its own
  // order: { [map]: [name, ...] }. Names only - the game's files do not say where a boss stands.
  const bosses = {};
  for (const r of [...T.DungeonEncounter].sort((a, b) => a.MapID - b.MapID || a.OrderIndex - b.OrderIndex || a.ID - b.ID)) {
    const name = String(r.Name_lang ?? '').trim();
    // (the table keeps rows its makers gave up: "No Longer in Use" is nobody to look for)
    if (!name || /^no longer in use$|^unused\b|\bunused$/i.test(name) || !Number.isInteger(r.MapID) || r.MapID < 0) continue;
    const list = (bosses[r.MapID] ??= []);
    if (!list.includes(name)) list.push(name);
  }

  // What it takes to open a thing (the game's table Lock): a lock is up to eight ways in, each a
  // key (an item) or a skill at some level. The skills that are a player's own are kept -
  // picking locks, herbalism, mining, fishing - with the keys: { [lock]: { s: [[skill, level],
  // ...], k: [item, ...] } }. (The other ways a lock lists - "open", "treasure" - are what
  // everybody can do once it is unlocked, and say nothing of what it asks.) And what a profession
  // works at (the game's table SpellFocusObject): { [id]: "Anvil" }. Which lock or which of those
  // an object is, the server says when the object is met (the game's cache), not the files.
  const opens = { skills: LOCK_SKILLS, locks: {}, spots: {} };
  for (const r of T.Lock) {
    if (!Array.isArray(r.Type) || !Array.isArray(r.Index)) continue;
    const s = [], k = [];
    for (let i = 0; i < r.Type.length; i++) {
      if (r.Type[i] === 1 && r.Index[i] > 0) k.push(r.Index[i]);
      else if (r.Type[i] === 2 && LOCK_SKILLS[r.Index[i]]) s.push([r.Index[i], r.Skill?.[i] > 0 ? r.Skill[i] : 1]);
    }
    if (s.length || k.length) opens.locks[r.ID] = k.length ? { s, k } : { s };
  }
  for (const r of T.SpellFocusObject) { const name = String(r.Name_lang ?? '').trim(); if (name && r.ID > 0) opens.spots[r.ID] = name; }

  // What a quest gives in experience, as the game works it out: the server names a quest's level
  // and a step (1-7), and the game looks the amount up here (its table QuestXP): { [level]:
  // [amount at step 0, 1, ...] }. The game's cache holds the step and not the amount, so whoever
  // reads the cache needs this beside it (atlasdb/collect.js, questXp).
  const questXp = {};
  for (const r of T.QuestXP) if (Number.isInteger(r.ID) && r.ID > 0 && Array.isArray(r.Difficulty) && r.Difficulty.some((v) => v > 0)) questXp[r.ID] = r.Difficulty;

  return {
    maps: T.Map,
    lvf,
    // WORLD_VERSION is part of it so that a change to what is written here reaches the viewer
    // (it caches world.json by the map revision).
    hash: `v${WORLD_VERSION}|${hashes.join('|')}`,
    data: { areas, zones, pois, taxiNodes, taxiPaths, transports, portals, capitals, areaTriggers, liquidTypes, bosses, questXp, opens },
  };
}
