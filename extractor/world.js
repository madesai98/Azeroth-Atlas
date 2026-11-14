// World metadata from the client database: maps, area names, zones, points of interest,
// liquids, and the links between places (flight paths, area triggers) that a route planner needs.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadTable } from './tables.js';
import { transportLines, findPortalData, readPortals } from './transit.js';

export const WORLD_VERSION = 5; // raise when the contents of world.json change
const hex = (argb) => '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);

export async function buildWorld(casc, log, cfg = null) {
  const names = ['Map', 'AreaTable', 'UiMap', 'UiMapAssignment', 'AreaPOI', 'LiquidType', 'LiquidObject', 'LiquidMaterial', 'TaxiNodes', 'TaxiPath', 'TaxiPathNode', 'AreaTrigger'];
  const T = {};
  const hashes = [];
  for (const name of names) {
    const t = await loadTable(casc, name, log);
    T[name] = t?.rows ?? [];
    hashes.push(`${name}:${t?.hash ?? 'none'}`);
  }
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

  return {
    maps: T.Map,
    lvf,
    // WORLD_VERSION is part of it so that a change to what is written here reaches the viewer
    // (it caches world.json by the map revision).
    hash: `v${WORLD_VERSION}|${hashes.join('|')}`,
    data: { areas, zones, pois, taxiNodes, taxiPaths, transports, portals, capitals, areaTriggers, liquidTypes },
  };
}
