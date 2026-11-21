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
// The Atlas database (laid over QuestieDB before this runs: extractor/atlas.js) adds two more
// kinds of spot:
//
//   7  seen in game by another player   someone stood beside them and talked, on a copy of the
//                                       map somewhere: the spot and the height are that
//                                       player's. Laid over the rest once heights are settled,
//                                       as the page lays your own sightings over them: it moves
//                                       the nearest spot of the same NPC, or adds one - and is
//                                       not believed where it contradicts the reference database
//                                       by more than a storey or two. Someone the databases put
//                                       in one place only, met far from it and never there, is
//                                       moved to where they were met (see resolveHeights).
//      where a fight with it began      from the game's combat log: a spot with no height, like
//                                       QuestieDB's, which gets one the same way (4 to 0 above).
//                                       It is the only kind of spot there is inside a dungeon
//                                       that is new to this game.
//   8  fought on this level by          where one floor lies over another the map guesses which a
//      another player                   creature is on (1). A player who fought one there, on a copy
//                                       of the map somewhere, was on its level: that copy put the
//                                       spot on the floor at that height (viewer/js/npcs.js, #fought),
//                                       and the height came by way of the database. Here it settles
//                                       the same and no more: a spot whose height is from the map
//                                       alone, put on the floor of its own nearest that height.
//                                       Nobody is added or moved across the map by it.
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
import { objectNeeds } from '../world.js';
import { reactions } from './creatures.js';

export const NPCS_VERSION = 12; // (12: someone the databases put in one place, met only elsewhere, is moved to where they were met - and the file says which spots are the databases'; 11: another player's sighting leaves alone whom the reference database places; 10: what a vendor sells, how much a trainer teaches, the game's own quest pins; 8: what the Atlas database adds - atlas.js - and the game's own list of bosses; 9: what an object asks of whoever opens it)
/** Of quests.json alone: raise when it is to hold something else. (1: what a quest asks of whoever takes it - race, profession, standing, spell, and how it hangs together with other quests.) */
export const QUESTS_VERSION = 1;
export const NSEC = { META: 1, SPAWNS: 2, OWNER: 3, SOURCE: 4 };
// (5 and 6 are the page's own: someone you talked to, a creature you fought - viewer/js/npcs.js)
export const HEIGHT = { NONE: 0, GUESS: 1, ONLY: 2, REFERENCE: 3, AGREED: 4, SHARED: 7, FOUGHT: 8 };
const HEIGHTS = 9; // how many ways a height can be known, counting the page's own

const TILE = 1600 / 3;
const MATCH = 5;    // yards: a reference spawn of the same creature this close to the spot is the same spawn
const AGREE = 3;    // yards: a reference height this close to something to stand on is confirmed by it
const BURIED = 4;   // yards: a reference height this far under everything there is to stand on is from a world that has changed
const STOREY = 2.5; // yards apart: two different levels
const NEAR = 60;    // yards: how far around a spot "the people around here" are looked for
const LEVEL = 6;    // yards: a floor this close to their height is on their level
const FOUGHT_NEAR = 30; // yards: a fight that began this close to where a creature is known to be says nothing new of where it is
const SEEN_SAME = 40;   // yards: the spot of an NPC this close to where a player met it is the one they met (as on the page)
const SEEN_LIFT = 60;   // ...nor one that lifts anybody this far
const LEVEL_SPOT = 6;   // yards: the spot of a creature this close to where another copy's fight settled its level is that spot
const LEVEL_FLOOR = 3;  // ...and the floor there within this much of the height that copy gave is the level meant

/**
 * Every creature and object with somewhere to be, per map, as spots on the map. A spot from
 * QuestieDB has no height yet; one from the reference database (see above) comes with its own.
 * @param extra  { areas (world.json's), ref (from readReference(), or null), mapIds: Set of the maps that were extracted,
 *                 bosses: { [mapId]: [name, ...] } (the game's own list, world.json's),
 *                 opens (world.json's: the game's locks and what professions work at) } or null
 * @returns Map<mapId, { entries: [...], points: [{ e (index into entries), x, y, z? }], seen: [{ e, x, y, z }], levels: [{ e, x, y, z }], unplaced: string[], bosses: string[] }>
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
    if (!m) maps.set(mapId, (m = { entries: [], index: new Map(), points: [], seen: [], levels: [], unplaced: [], bosses: [] }));
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
    // which side it is on is not recorded: a and h are a guess from who it is marked friendly to
    // (ks: the sides that ARE known all the same, 1 the Alliance's, 2 the Horde's - reactions())
    if (r[2]) { e.u = 1; if (r[3]) e.ks = r[3]; }
    if (npc.subName) e.s = npc.subName;
    if (npc.maxLevel > 0) e.l = [npc.minLevel || npc.maxLevel, npc.maxLevel];
    if (npc.rank) e.r = npc.rank;
    // (the kind of thing it is - beast, humanoid, undead...: as the game's own cache or Wowhead has it
    // (the Atlas database), else from the reference database, for the creatures it has)
    const kind = npc.type ?? extra?.ref?.templates?.get(npc.id)?.type;
    if (kind >= 1 && kind <= 9) e.ct = kind;
    // (its health as fights measured it, at its lowest and highest level)
    if (npc.hp?.[1] > 0) e.hp = npc.hp[0] === npc.hp[1] ? [npc.hp[1]] : [npc.hp[0], npc.hp[1]];
    if (npc.flags) e.f = npc.flags;
    // (what it sells, as its window showed the players who noted it: [item, copper, name], the
    // first forty; and how many things it teaches)
    if (npc.sells?.length) { e.sl = npc.sells.slice(0, 40).map(([item, copper]) => [item, copper, itemName(item)]); if (npc.sells.length > 40) e.sm = npc.sells.length - 40; }
    if (npc.teaches?.length) e.tc = npc.teaches.length;
    if (npc.questStarts.length) e.qs = npc.questStarts;
    if (npc.questEnds.length) e.qe = npc.questEnds;
    return e;
  };
  const itemName = (id) => { try { const n = db.item?.(id)?.name; return typeof n === 'string' && n && n !== `Item ${id}` ? n : ''; } catch { return ''; } };
  const objEntry = (obj) => {
    const e = { id: obj.id, k: 1, n: obj.name };
    // (what it asks of whoever would open it - a skill, a key - and what it is to a profession:
    // by the server's own word of the object where a game has met it, else the reference database's)
    const kind = Array.isArray(obj.data) ? [obj.type, ...obj.data] : extra?.ref?.objectKinds?.get(obj.id);
    if (kind && extra?.opens) {
      const { need, spot } = objectNeeds(extra.opens, kind[0], kind.slice(1));
      if (need) e.nd = need;
      if (spot) e.fo = spot;
    }
    if (obj.questStarts.length) e.qs = obj.questStarts;
    if (obj.questEnds.length) e.qe = obj.questEnds;
    return e;
  };
  for (const npc of db.npcs) if (npc.spawns) place(npc, `n${npc.id}`, () => npcEntry(npc));
  for (const obj of db.objects) if (obj.spawns) place(obj, `o${obj.id}`, () => objEntry(obj));

  const entryOn = (mapId, key, make) => {
    const m = bucket(mapId);
    let e = m.index.get(key);
    if (e === undefined) { e = m.entries.length; m.index.set(key, e); m.entries.push(make()); }
    return [m, e];
  };
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
          const [m, e] = entryOn(mapId, prefix + id, () => make(thing));
          m.points.push({ e, x: rows[i + 1], y: rows[i + 2], z: rows[i + 3] });
        }
      }
    };
    fill(extra.ref.creatures, db.npcs, 'n', npcEntry);
    fill(extra.ref.objects, db.objects, 'o', objEntry);
  }
  if (extra?.mapIds) {
    // What the Atlas database adds (atlas.js). Where a fight with a creature began, by the
    // game's combat log: a spot like QuestieDB's, with no height - unless the creature is
    // already known to be within FOUGHT_NEAR yards of it, in which case it says nothing new
    // (a fight begins where the creature was pulled from, not where its spawn point is).
    for (const npc of db.npcs) {
      for (const f of npc.flat ?? []) {
        if (!extra.mapIds.has(f.map)) continue;
        const [m, e] = entryOn(f.map, `n${npc.id}`, () => npcEntry(npc));
        if (m.points.some((p) => p.e === e && Math.hypot(p.x - f.x, p.y - f.y) < FOUGHT_NEAR)) continue;
        m.points.push({ e, x: f.x, y: f.y });
      }
    }
    // Where players stood beside someone and talked: kept apart, and laid over the spots above
    // once those have their heights (resolveHeights).
    const sightings = (things, prefix, make) => {
      for (const thing of things) {
        for (const s of thing.seen ?? []) {
          if (!extra.mapIds.has(s.map)) continue;
          const [m, e] = entryOn(s.map, prefix + thing.id, () => make(thing));
          m.seen.push({ e, x: s.x, y: s.y, z: s.z });
        }
      }
    };
    sightings(db.npcs, 'n', npcEntry);
    sightings(db.objects, 'o', objEntry);
    // Which level a creature is on, where a player's fight settled it: for the creatures that are
    // on the map already (it adds nobody), held against their spots once those have their heights.
    for (const npc of db.npcs) {
      for (const l of npc.level ?? []) {
        const m = maps.get(l.map), e = m?.index.get(`n${npc.id}`);
        if (e !== undefined) m.levels.push({ e, x: l.x, y: l.y, z: l.z });
      }
    }
    // Who is known to be on a map, and not where: QuestieDB lists them in a zone without a
    // spot, or the database knows no more of them than their zone - and no source could place
    // them anywhere. (Most are in dungeons: a dungeon has no zone map to give a spot on.)
    const placed = new Set();
    for (const m of maps.values()) for (const key of m.index.keys()) placed.add(key);
    for (const npc of db.npcs) {
      if (placed.has(`n${npc.id}`)) continue;
      for (const zoneId of [...(npc.spawns?.keys() ?? []), ...(npc.zone ? [npc.zone] : [])]) {
        const mapId = extra.areas?.[zoneId]?.m;
        if (mapId === undefined || !extra.mapIds.has(mapId)) continue;
        // (a zone of the open world lists everything ever filed under it: only where a place is one building, or QuestieDB itself says "here, somewhere")
        if (!npc.spawns?.has(zoneId) && !extra.inside?.has(mapId)) continue;
        bucket(mapId).unplaced.push(npc.name);
        break;
      }
    }
    // The game's own list of the bosses of each dungeon and raid (its table DungeonEncounter),
    // in the order it has them: so a map can say who they are, placed or not.
    for (const [mapId, names] of Object.entries(extra.bosses ?? {})) {
      if (!extra.mapIds.has(+mapId) || !names.length) continue;
      const m = bucket(+mapId);
      m.bosses = names;
      const is = new Set(names);
      for (const e of m.entries) if (!e.k && is.has(e.n)) e.b = 1;
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
  // (room for the sightings that land where the database has nobody: each may add a spot)
  const room = n + (m.seen?.length ?? 0);
  let spawns = new Float32Array(room * 3), owner = new Uint32Array(room), source = new Uint8Array(room);
  const counts = new Array(HEIGHTS).fill(0);
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
  // Which level a creature is on, where a player's fight settled it on another copy of the map: the
  // spot of that creature nearest the one named, where its height is the map's own doing (a guess,
  // the only floor it saw, or none), is put on the floor of its own nearest the height given - if
  // there is one within a few yards of that. A spot the reference database places is left alone.
  for (const l of m.levels ?? []) {
    if (!nav) break;
    let best = -1, bestD = LEVEL_SPOT;
    for (let k = 0; k < n; k++) {
      if (owner[k] !== l.e || source[k] > HEIGHT.ONLY) continue;
      const d = Math.hypot(spawns[k * 3] - l.x, spawns[k * 3 + 1] - l.y);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) continue;
    let floors = [];
    for (let reach = 0; reach <= 2 && !floors.length; reach++) floors = nav.floorsAt(spawns[best * 3], spawns[best * 3 + 1], reach).filter((f) => !f.swim);
    let pick = null;
    for (const f of floors) if (Math.abs(f.z - l.z) <= LEVEL_FLOOR && (!pick || Math.abs(f.z - l.z) < Math.abs(pick.z - l.z))) pick = f;
    if (!pick) continue;
    counts[source[best]]--;
    spawns[best * 3 + 2] = pick.z; source[best] = HEIGHT.FOUGHT;
    counts[HEIGHT.FOUGHT]++;
  }
  // Where players stood beside someone and talked, as the Atlas database has it from every copy:
  // laid over what is there as the page lays your own sightings over it. The nearest spot of
  // the same NPC within SEEN_SAME yards is the one that was met, and takes the sighting's place
  // and height; where there is none, the sighting is a spot of its own. A sighting's height is
  // the height of the player who made it, as that player's map had it - and a map can be wrong
  // about that. So someone the reference database places stays as placed: the reference is
  // surer of where they stand than any player's map was of where the player did, and the page
  // counts on that when it puts YOUR height right by theirs. And a sighting that lifts anybody
  // sixty yards is left out.
  //   But someone the databases put in ONE place, who was met only elsewhere - SEEN_SAME yards
  // and more from it, and never there - does not stand there in this game, which has moved
  // some and built places anew: Archmage Ansirem Runeweaver stood at the gate of ruined
  // Dalaran, where a wall of the city built over it stands now, and he is inside. There the
  // sighting takes that place over rather than being one more, which the way to him led to
  // whenever it was the nearer of the two. Not for someone the databases put in several places
  // (a guard, a wanderer), nor someone met at that place too: Archmage Tervosh is in his tower
  // and, for a quest, out in the marsh, and both are kept. (The page does the same with yours:
  // viewer/js/npcs.js, #lone - so it is told which spots are the databases' and which of those
  // a sighting met without moving them: base and met in the file.)
  const spotsOf = new Map(); // each NPC's spots: the databases', then those sightings add
  for (let k = 0; k < n; k++) { const list = spotsOf.get(owner[k]); if (list) list.push(k); else spotsOf.set(owner[k], [k]); }
  const nearest = (e, x, y, upTo) => {
    let best = -1, bestD = SEEN_SAME;
    for (const k of spotsOf.get(e) ?? []) {
      if (k >= upTo) continue;
      const d = Math.hypot(spawns[k * 3] - x, spawns[k * 3 + 1] - y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  };
  // (the databases' spots someone was met at, whether or not that changed them)
  const met = new Uint8Array(n);
  for (const s of m.seen ?? []) { const k = nearest(s.e, s.x, s.y, n); if (k >= 0) met[k] = 1; }
  let count = n, moved = 0;
  for (const s of m.seen ?? []) {
    let best = nearest(s.e, s.x, s.y, count);
    if (best >= 0) {
      const was = spawns[best * 3 + 2];
      if (source[best] === HEIGHT.REFERENCE || source[best] === HEIGHT.AGREED) continue;
      if (Number.isFinite(was) && s.z - was > SEEN_LIFT) continue;
      counts[source[best]]--;
    } else {
      // (their one place, if it is the databases' alone: nobody met there, no fight settled its level, not moved already)
      const list = spotsOf.get(s.e), one = list?.length === 1 && list[0] < n ? list[0] : -1;
      if (one >= 0 && !met[one] && source[one] <= HEIGHT.AGREED) { best = one; counts[source[best]]--; moved++; }
      else { best = count++; if (list) list.push(best); else spotsOf.set(s.e, [best]); }
    }
    spawns[best * 3] = s.x; spawns[best * 3 + 1] = s.y; spawns[best * 3 + 2] = s.z;
    owner[best] = s.e; source[best] = HEIGHT.SHARED;
    counts[HEIGHT.SHARED]++;
  }
  if (count < room) { spawns = spawns.slice(0, count * 3); owner = owner.slice(0, count); source = source.slice(0, count); }
  // (base: the first so many spots are the databases', the rest what sightings added; met: those
  // of the databases' a sighting met and left as they were - a reference height, or too far under it)
  const metKept = [];
  for (let k = 0; k < n; k++) if (met[k] && source[k] <= HEIGHT.AGREED) metKept.push(k);
  return { spawns, owner, source, counts, base: n, met: metKept, moved };
}

/** Write one map's file. Returns a short summary for the manifest. */
export function writeNpcs(out, m, h, info) {
  const meta = { source: info.source, reference: info.reference, entries: m.entries, unplaced: m.unplaced.slice(0, 300) };
  // (the bosses of the place, by the game's own list and in its order)
  if (m.bosses?.length) meta.bosses = m.bosses;
  // (which spots are the databases' and which of those a sighting met: see resolveHeights)
  if (Number.isInteger(h.base)) meta.base = h.base;
  if (h.met?.length) meta.met = h.met;
  writeFileAtomic(out, packContainer('WFP1', NPCS_VERSION, [
    { id: NSEC.META, data: Buffer.from(JSON.stringify(meta)) },
    { id: NSEC.SPAWNS, data: h.spawns },
    { id: NSEC.OWNER, data: h.owner },
    { id: NSEC.SOURCE, data: h.source },
  ]));
  return { entries: m.entries.length, spawns: h.owner.length, heights: h.counts, unplaced: m.unplaced.length, moved: h.moved ?? 0 };
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
export function buildQuests(db, zones, ref = null, { factionNames = null } = {}) {
  const zoneByArea = new Map();
  for (const z of [...zones].sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1) || a.order - b.order)) {
    if (z.area && !zoneByArea.has(z.area)) zoneByArea.set(z.area, z);
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  // (the game's maps by their own numbers, for its quest pins: a zone's map before a continent's)
  const zoneByUi = new Map();
  for (const z of [...zones].sort((a, b) => b.type - a.type || a.order - b.order)) if (z.uiMap && Array.isArray(z.region) && !zoneByUi.has(z.uiMap)) zoneByUi.set(z.uiMap, z);
  const first = (spawns) => {
    for (const [zoneId, points] of spawns ?? []) {
      const z = zoneByArea.get(zoneId);
      const p = z && points.find((q) => Array.isArray(q) && q[0] >= 0 && q[1] >= 0);
      if (p) return [z.map, r1(z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0])), r1(z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]))];
    }
    return null;
  };
  const npcById = new Map(db.npcs.map((n) => [n.id, n])), objById = new Map(db.objects.map((o) => [o.id, o]));
  const quests = {}, items = {}, npcs = {}, objects = {}, mobs = {}, factions = {};
  // (a faction a quest asks about: what it is called, where QuestieDB names it)
  const needFaction = (id) => { const name = factionNames?.get(id); if (name) factions[id] = name; };
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
    // (its health as fights in this game measured it, and its kind as the game says it, where the Atlas database has them: atlas.js)
    if (n.hp?.[1] > 0) m.hp = Math.round((n.hp[0] + n.hp[1]) / 2);
    if (n.type >= 1 && n.type <= 9) m.ct = n.type;
    const back = ref?.respawn.get(id);
    if (back > 0) m.rs = back;
    mobs[id] = m;
  };
  // Where one of them is, for someone who has no spot on a zone's map: where a player stood
  // beside them, where a fight with them began, or where the reference database has them (the
  // people inside a dungeon have no other place than these).
  const elsewhere = (thing, table) => {
    const p = thing.seen?.[0] ?? thing.flat?.[0];
    if (p) return [p.map, r1(p.x), r1(p.y)];
    const rows = table?.get(thing.id);
    return rows?.length >= 4 ? [rows[0], r1(rows[1]), r1(rows[2])] : null;
  };
  // Where someone is that QuestieDB puts in one place only, and players have met only elsewhere -
  // SEEN_SAME yards and more from it, never there: where they were met, as on the map itself
  // (resolveHeights: Archmage Ansirem Runeweaver, inside the Dalaran built over the ruin's gate).
  const metElsewhere = (thing) => {
    if (!thing.seen?.length || thing.flat?.length) return null;
    let one = null;
    for (const [zoneId, points] of thing.spawns ?? []) {
      const z = zoneByArea.get(zoneId);
      if (!z) continue;
      for (const p of points) {
        if (!Array.isArray(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue;
        if (one) return null; // (several places: a guard, a wanderer - whichever was met, the others are as likely)
        one = [z.map, z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0]), z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1])];
      }
    }
    if (!one || thing.seen.some((s) => s.map === one[0] && Math.hypot(s.x - one[1], s.y - one[2]) < SEEN_SAME)) return null;
    const s = thing.seen.find((q) => q.map === one[0]) ?? thing.seen[0];
    return [s.map, r1(s.x), r1(s.y)];
  };
  const needNpc = (id) => { const n = npcById.get(id); if (n && !npcs[id]) npcs[id] = [n.name, ...(metElsewhere(n) ?? first(n.spawns) ?? elsewhere(n, ref?.creatures) ?? [])]; };
  const needObj = (id) => { const o = objById.get(id); if (o && !objects[id]) objects[id] = [o.name, ...(metElsewhere(o) ?? first(o.spawns) ?? elsewhere(o, ref?.objects) ?? [])]; };
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
    // What it takes to be offered the quest, beyond side, level and the quests before it (the page
    // holds them against your character: viewer/js/questopen.js says what each means).
    if (q.races) o.rc = q.races;                 // the races it is for, as QuestieDB marks them (none: any)
    if (q.parent) o.par = q.parent;              // the quest it is a part of
    if (q.requiredSkill) o.sk = q.requiredSkill; // [profession, how far]
    if (q.requiredRanks?.length) o.rk = q.requiredRanks;
    if (q.requiredMinRep) { o.rn = q.requiredMinRep; needFaction(o.rn[0]); } // [faction, standing at least]
    if (q.requiredMaxRep) { o.rx = q.requiredMaxRep; needFaction(o.rx[0]); } // [faction, standing under]
    if (q.requiredSpell) o.sp = q.requiredSpell; // a spell you must know (below zero: must not)
    if (q.requiredSpecialization) o.spz = q.requiredSpecialization;
    if (q.breadcrumbFor) o.bf = q.breadcrumbFor; // the quest this one only leads to
    if (q.breadcrumbs?.length) o.bc = q.breadcrumbs; // the quests that only lead to this one
    if (q.availableUntilCompleted) o.au = q.availableUntilCompleted;
    if (q.availableStartingWith) o.as = q.availableStartingWith;
    if (q.disabledByQuest) o.dq = q.disabledByQuest;
    if (q.objectives.creatures.length) { o.oc = q.objectives.creatures; o.oc.forEach(needNpc); o.oc.forEach(needMob); }
    if (q.objectives.killCredit.length) { o.ok = q.objectives.killCredit; o.ok.forEach(needNpc); o.ok.forEach(needMob); }
    // how many of each thing it asks for, and what kind of quest it is (the reference database's, for the quests it has)
    // (...and where it does not have the quest - one new to this game - what the Atlas database
    // has of it: the counts as the game's own cache or Wowhead give them. atlas.js)
    const known = ref?.quests.get(q.id);
    const needs = known?.needs.length ? known.needs : q.needs ?? [];
    if (needs.length) {
      o.nd = needs;
      for (const [kind, id] of needs) { if (kind === 'i') needItem(id); else if (kind === 'o') needObj(id); else { needNpc(id); needMob(id); } }
    }
    const type = known?.type || q.type, limit = known?.limit || q.limit;
    if (type) o.ty = type;
    if (limit) o.tl = limit;
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
    // Where the game's own map puts the quest (the addon's notes of its pins: where it starts, an
    // objective, where it is handed in), as places in the world: { s, o, e: [[map, x, y], ...] }.
    // For a quest nothing else places, this is all there is to go by.
    if (q.pins) {
      const gp = {};
      for (const what of ['s', 'o', 'e']) {
        const spots = [];
        for (const [key, text] of Object.entries(q.pins[what] ?? {})) {
          const z = key[0] === 'u' ? zoneByUi.get(Number(key.slice(1))) : null;
          if (!z || typeof text !== 'string') continue;
          for (const pin of text.split(' ')) {
            const [across, down] = pin.split(',').map(Number);
            if ([across, down].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) spots.push([z.map, r1(z.region[2] - (down / 100) * (z.region[2] - z.region[0])), r1(z.region[3] - (across / 100) * (z.region[3] - z.region[1]))]);
          }
        }
        if (spots.length) gp[what] = spots;
      }
      if (Object.keys(gp).length) o.gp = gp;
    }
    quests[q.id] = o;
  }
  return { quests, items, npcs, objects, mobs, factions };
}
