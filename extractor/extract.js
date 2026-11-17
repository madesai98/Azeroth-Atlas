#!/usr/bin/env node
// Map data extractor. Reads the locally installed game (read-only) and writes viewer data.
//
// Re-runnable and incremental: every output records a signature derived from the content
// hashes of the game files it was built from, so after a game patch only what actually
// changed is rebuilt, and outputs that no longer exist in the game are removed.
//
//   node extractor/extract.js [--maps=0,1] [--force] [--json] [--workers=N]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Casc } from './casc/casc.js';
import { loadConfig } from './config.js';
import { buildWorld, roomNames, liftsOf, ROOMS_VERSION } from './world.js';
import { parseWDT } from './formats/wdt.js';
import { Pool } from './pool.js';
import { writeFileAtomic, unpackContainer } from './container.js';
import { TILE_VERSION } from './jobs/tile.js';
import { PAGE_VERSION, TOP_LEVEL } from './jobs/page.js';
import { AREAS_VERSION } from './jobs/areas.js';
import { PLACEMENTS_VERSION } from './jobs/placements.js';
import { MODEL_VERSION } from './jobs/model.js';
import { TREES_VERSION, isTree } from './trees.js';
import { CREATURES_VERSION, placeCreatures, placeInns, placeDungeons, writeCreatures } from './jobs/creatures.js';
import { readQuestieDungeons } from './questie-extras.js';
import { findQuestieDb, readQuestie, questieStamp, questieFrom } from './questie.js';
import { fetchQuestie } from '../atlasdb/questiedb.js';
import { NPCS_VERSION, placeNpcs, resolveHeights, writeNpcs, buildQuests } from './jobs/npcs.js';
import { fetchReference, readReference } from './reference.js';
import { NavReader } from './navread.js';
import { NAV_VERSION } from './jobs/nav.js';
import { loadTable } from './tables.js';
import { ensureItems } from './jobs/items.js';
import { ensureRecipes } from './jobs/recipes.js';
import { MAP_HALF } from './formats/chunked.js';
import { DATA_STAMP } from './stamp.js';

export const FORMAT_VERSION = 2;
const KIND_INDEX = { water: 1, ocean: 2, magma: 3, slime: 4 };
const TILE_YARDS = 1600 / 3; // one map tile
const sig = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
const round1 = (v) => Math.round(v * 10) / 10;

export async function runExtraction(cfg, opts = {}, report = () => {}) {
  const t0 = Date.now();
  const log = (msg) => report({ type: 'log', msg });
  const dataDir = cfg.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });

  report({ type: 'phase', name: 'Opening game archives' });
  const casc = new Casc(cfg.installRoot, cfg.product);
  casc.root;
  log(`Game build ${casc.build.version} (${casc.build.product}), ${casc.root.count.toLocaleString()} files in manifest`);

  const statePath = path.join(dataDir, 'state.json');
  let prev = { artifacts: {} };
  if (!opts.force && fs.existsSync(statePath)) {
    try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { prev = { artifacts: {} }; }
  }
  if (prev.formatVersion !== FORMAT_VERSION) prev = { artifacts: prev.artifacts ?? {}, stale: true };
  let prevManifest = null;
  try { prevManifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')); } catch { /* first run */ }
  const next = { formatVersion: FORMAT_VERSION, artifacts: {} };
  const abs = (rel) => path.join(dataDir, rel);
  const fresh = (rel, s) => !prev.stale && prev.artifacts[rel]?.sig === s && fs.existsSync(abs(rel));
  const stats = { built: 0, reused: 0, failed: 0, removed: 0, missing: 0, unavailable: 0 };
  let modelCounts = { wmo: 0, m2: 0, textures: 0 };

  report({ type: 'phase', name: 'Reading world tables' });
  const world = await buildWorld(casc, log, cfg);
  const lvfSig = sig(world.lvf);
  const kinds = {};
  for (const [id, t] of Object.entries(world.data.liquidTypes)) kinds[id] = KIND_INDEX[t.kind] ?? 1;
  const kindSig = sig(kinds);
  const ckey = (fdid) => (fdid ? casc.contentHash(fdid) : null);

  // ---- discover maps -------------------------------------------------------------------
  const mapFilter = opts.maps ? new Set(opts.maps) : null;
  const maps = [];
  for (const row of world.maps) {
    if (!row.WdtFileDataID) continue;
    if (mapFilter && !mapFilter.has(row.ID)) continue;
    let wdtBuf = null;
    try { wdtBuf = casc.readFile(row.WdtFileDataID); } catch (err) { log(`map ${row.ID} ${row.Directory}: ${err.message}`); }
    if (!wdtBuf) continue;
    maps.push({ row, wdt: parseWDT(wdtBuf), id: row.ID, tiles: [], pages: {} });
  }
  log(`${maps.length} maps to process`);

  const pool = new Pool(cfg.workers, { shared: casc.share() });
  const runJobs = async (name, jobs, fn) => {
    report({ type: 'phase', name, total: jobs.length });
    let done = 0;
    await Promise.all(jobs.map(async (j) => {
      try { await fn(j); stats.built++; } catch (err) { stats.failed++; log(`${name}: ${j.rel} failed: ${err.message}`); j.failed = true; }
      report({ type: 'progress', done: ++done, total: jobs.length });
    }));
  };

  try {
    // ---- terrain tiles (level 0) ---------------------------------------------------------
    const tileJobs = [];
    for (const map of maps) {
      for (const t of map.wdt.tiles) {
        const rel = `maps/${map.id}/t/${t.col}_${t.row}.bin`;
        const colorRel = `maps/${map.id}/c/${t.col}_${t.row}.blp`;
        const rootKey = ckey(t.root);
        if (!rootKey || !casc.exists(t.root)) { stats.missing++; continue; }
        const s = sig(TILE_VERSION, rootKey, ckey(t.obj0), ckey(t.mapTexture), lvfSig, kindSig);
        const entry = { map, t, x: t.col, y: t.row, rel, colorRel, sig: s, meta: null };
        const old = prev.artifacts[rel];
        if (fresh(rel, s) && (!old.meta.hasColor || fs.existsSync(abs(colorRel)))) { entry.meta = old.meta; stats.reused++; }
        else tileJobs.push(entry);
        map.tiles.push(entry);
      }
    }
    await runJobs('Extracting terrain', tileJobs, async (e) => {
      e.meta = await pool.run('tile', {
        files: { root: e.t.root, obj0: e.t.obj0, mapTexture: e.t.mapTexture },
        out: abs(e.rel), colorOut: abs(e.colorRel), lvf: world.lvf, kinds,
      });
    });
    for (const map of maps) {
      map.tiles = map.tiles.filter((e) => e.meta);
      for (const e of map.tiles) {
        next.artifacts[e.rel] = { sig: e.sig, meta: e.meta };
        if (e.meta.hasColor) next.artifacts[e.colorRel] = { sig: e.sig };
      }
      // Sea level: the level shared by this map's ocean surfaces (if it has an ocean at all).
      const levels = new Map();
      for (const e of map.tiles) if (e.meta.sea !== null && e.meta.sea !== undefined) levels.set(e.meta.sea, (levels.get(e.meta.sea) ?? 0) + 1);
      map.ocean = levels.size > 0;
      map.seaLevel = map.ocean ? [...levels].sort((a, b) => b[1] - a[1])[0][0] : 0;
    }

    // ---- area grids ------------------------------------------------------------------------
    const areaJobs = [];
    for (const map of maps) {
      if (!map.tiles.length) continue;
      const rel = `maps/${map.id}/areas.bin`;
      const s = sig(AREAS_VERSION, map.tiles.map((e) => e.sig));
      map.areasEntry = { map, rel, sig: s, meta: null };
      if (fresh(rel, s)) { map.areasEntry.meta = prev.artifacts[rel].meta; stats.reused++; }
      else areaJobs.push(map.areasEntry);
    }
    await runJobs('Building area grids', areaJobs, async (e) => {
      e.meta = await pool.run('areas', { tiles: e.map.tiles.map((t) => ({ col: t.x, row: t.y, file: abs(t.rel) })), out: abs(e.rel) });
    });
    for (const map of maps) if (map.areasEntry?.meta) next.artifacts[map.areasEntry.rel] = { sig: map.areasEntry.sig, meta: map.areasEntry.meta };

    // ---- multi-resolution pyramid (levels 1..TOP_LEVEL) -----------------------------------
    for (let level = 1; level <= TOP_LEVEL; level++) {
      const jobs = [];
      for (const map of maps) {
        const children = level === 1 ? map.tiles : map.pages[level - 1];
        const groups = new Map();
        for (const ch of children) {
          const key = `${ch.x >> 1}_${ch.y >> 1}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { x: ch.x >> 1, y: ch.y >> 1, kids: [null, null, null, null] }));
          g.kids[(ch.y & 1) * 2 + (ch.x & 1)] = ch;
        }
        map.pages[level] = [];
        for (const g of groups.values()) {
          const rel = `maps/${map.id}/p${level}/${g.x}_${g.y}.bin`;
          const s = sig(PAGE_VERSION, level, map.ocean, map.seaLevel, g.kids.map((k) => k?.sig ?? null));
          const entry = { map, level, x: g.x, y: g.y, rel, sig: s, meta: null, kids: g.kids };
          if (fresh(rel, s)) { entry.meta = prev.artifacts[rel].meta; stats.reused++; }
          else jobs.push(entry);
          map.pages[level].push(entry);
        }
      }
      await runJobs(`Building detail level ${level} of ${TOP_LEVEL}`, jobs, async (e) => {
        e.meta = await pool.run('page', {
          level: e.level,
          children: e.kids.map((k, i) => k && ({
            dx: i & 1, dy: i >> 1, file: abs(k.rel),
            color: level === 1 ? (k.meta.hasColor ? abs(k.colorRel) : null) : undefined,
          })),
          out: abs(e.rel), ocean: e.map.ocean, seaLevel: e.map.seaLevel, kinds,
        });
      });
      for (const map of maps) {
        map.pages[level] = map.pages[level].filter((e) => e.meta);
        for (const e of map.pages[level]) next.artifacts[e.rel] = { sig: e.sig, meta: e.meta };
      }
    }
    // ---- building placements (map-wide, de-duplicated) -------------------------------------
    const plJobs = [];
    for (const map of maps) {
      if (!map.tiles.some((e) => e.meta.wmoCount)) continue;
      const rel = `maps/${map.id}/wmos.bin`;
      const s = sig(PLACEMENTS_VERSION, map.tiles.map((e) => e.sig));
      map.wmosEntry = { map, rel, sig: s, meta: null };
      if (fresh(rel, s)) { map.wmosEntry.meta = prev.artifacts[rel].meta; stats.reused++; }
      else plJobs.push(map.wmosEntry);
    }
    await runJobs('Indexing buildings', plJobs, async (e) => {
      e.meta = await pool.run('placements', { tiles: e.map.tiles.filter((t) => t.meta.wmoCount).map((t) => ({ file: abs(t.rel) })), out: abs(e.rel) });
    });
    for (const map of maps) if (map.wmosEntry?.meta) next.artifacts[map.wmosEntry.rel] = { sig: map.wmosEntry.sig, meta: map.wmosEntry.meta };

    // ---- models: buildings (WMO), then objects (M2), then their textures -------------------
    // A model is rebuilt when any game file it was assembled from has a new content hash.
    const modelFresh = (rel, s) => {
      const a = prev.artifacts[rel];
      if (prev.stale || !a || a.sig !== s || !a.meta?.deps || !fs.existsSync(abs(rel))) return false;
      for (const [fd, ck] of Object.entries(a.meta.deps)) if (ckey(+fd) !== ck) return false;
      return true;
    };
    const buildModels = async (name, type, ids) => {
      const s = sig(MODEL_VERSION, type, kindSig);
      const entries = [...ids].sort((a, b) => a - b).map((fdid) => ({ fdid, rel: `models/${type}/${fdid}.bin`, sig: s, meta: null }));
      const jobs = [];
      for (const e of entries) {
        if (modelFresh(e.rel, s)) { e.meta = prev.artifacts[e.rel].meta; stats.reused++; } else jobs.push(e);
      }
      await runJobs(name, jobs, async (e) => {
        try { e.meta = await pool.run(type, { fdid: e.fdid, out: abs(e.rel), kinds }); }
        catch (err) {
          // Content that is not downloaded or is still encrypted (unreleased) is skipped, not an error.
          if (err.code === 'EMISSING' || err.code === 'EENCRYPTED') { stats.unavailable++; stats.built--; return; }
          throw err;
        }
      });
      const ok = entries.filter((e) => e.meta);
      for (const e of ok) next.artifacts[e.rel] = { sig: e.sig, meta: e.meta };
      return ok;
    };
    const wmoIds = new Set(), m2Ids = new Set(), texIds = new Set();
    for (const map of maps) {
      for (const e of map.tiles) { for (const id of e.meta.wmo) wmoIds.add(id); for (const id of e.meta.m2) m2Ids.add(id); }
      if (map.wdt.globalWmo?.isFdid && map.wdt.globalWmo.fdid) wmoIds.add(map.wdt.globalWmo.fdid);
    }
    // The game's own models of the boats, zeppelins and tram cars (viewer/transit.json names
    // them): no map places them anywhere, the viewer draws each where it is at the moment.
    try {
      const transit = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'transit.json'), 'utf8'));
      for (const m of Object.values(transit.models ?? {})) if (Number.isInteger(m.id)) (m.kind === 'wmo' ? wmoIds : m2Ids).add(m.id);
    } catch { /* no timetables: no craft to draw */ }
    const wmos = await buildModels('Converting buildings', 'wmo', wmoIds);
    for (const e of wmos) { for (const id of e.meta.m2) m2Ids.add(id); for (const id of e.meta.textures) texIds.add(id); }
    const m2s = await buildModels('Converting objects', 'm2', m2Ids);
    for (const e of m2s) for (const id of e.meta.textures) texIds.add(id);
    modelCounts = { wmo: wmos.length, m2: m2s.length, textures: 0 };
    // Small lookup of object sizes so the viewer can cull by distance before loading a model.
    const index = Buffer.alloc(m2s.length * 8);
    m2s.forEach((e, i) => { index.writeUInt32LE(e.fdid, i * 8); index.writeFloatLE(e.meta.radius ?? 0, i * 8 + 4); });
    writeFileAtomic(abs('models/m2-index.bin'), index);
    next.artifacts['models/m2-index.bin'] = { sig: sig(crypto.createHash('sha1').update(index).digest('hex')) };
    // Which of the objects are trees (trees.js): by each one's own name and shape. An object
    // converted before this was looked at is read once more for it (and keeps the answer).
    const shapeless = m2s.filter((e) => !e.meta.shape);
    if (shapeless.length) {
      report({ type: 'phase', name: 'Telling trees from other objects', total: shapeless.length });
      let done = 0;
      await Promise.all(shapeless.map(async (e) => {
        try { e.meta.shape = await pool.run('m2shape', { fdid: e.fdid }); } catch { /* not readable just now: not a tree this time */ }
        report({ type: 'progress', done: ++done, total: shapeless.length });
      }));
    }
    const trees = new Uint32Array(m2s.filter((e) => isTree(e.meta.shape)).map((e) => e.fdid));
    const treeBytes = Buffer.from(trees.buffer, trees.byteOffset, trees.byteLength);
    writeFileAtomic(abs('models/trees.bin'), treeBytes);
    next.artifacts['models/trees.bin'] = { sig: sig(TREES_VERSION, crypto.createHash('sha1').update(treeBytes).digest('hex')) };
    modelCounts.trees = trees.length; // (in the manifest: the viewer asks for the list only where there is one)
    log(`${trees.length.toLocaleString()} of the ${m2s.length.toLocaleString()} kinds of object are trees`);

    const texJobs = [];
    let batch = [];
    for (const fdid of [...texIds].sort((a, b) => a - b)) {
      const rel = `tex/${fdid}.blp`;
      const s = ckey(fdid);
      if (!s) continue;
      if (fresh(rel, s)) { next.artifacts[rel] = { sig: s }; stats.reused++; modelCounts.textures++; continue; }
      batch.push({ fdid, rel, sig: s });
      if (batch.length === 32) { texJobs.push({ rel: `tex (${batch[0].fdid}…)`, items: batch }); batch = []; }
    }
    if (batch.length) texJobs.push({ rel: `tex (${batch[0].fdid}…)`, items: batch });
    await runJobs('Copying textures', texJobs, async (j) => {
      const done = await pool.run('textures', { items: j.items.map((t) => ({ fdid: t.fdid, out: abs(t.rel) })) });
      for (const t of j.items) if (done[t.fdid]) { next.artifacts[t.rel] = { sig: t.sig }; modelCounts.textures++; }
    });

    // ---- navigation: where a character can stand, per tile (for the route planner) ----------
    // Built from the tile and the collision meshes of everything placed on it, so it is rebuilt
    // when the tile or any of those models changes.
    const modelSig = { wmo: new Map(wmos.map((e) => [e.fdid, sig(e.sig, e.meta.deps)])), m2: new Map(m2s.map((e) => [e.fdid, sig(e.sig, e.meta.deps)])) };
    const navJobs = [];
    for (const map of maps) {
      map.nav = [];
      for (const e of map.tiles) {
        const rel = `maps/${map.id}/nav/${e.x}_${e.y}.bin`;
        const s = sig(NAV_VERSION, e.sig, kindSig, e.meta.wmo.map((id) => modelSig.wmo.get(id) ?? 0), e.meta.m2.map((id) => modelSig.m2.get(id) ?? 0));
        const entry = { map, e, rel, sig: s, meta: null };
        if (fresh(rel, s)) { entry.meta = prev.artifacts[rel].meta; stats.reused++; } else navJobs.push(entry);
        map.nav.push(entry);
      }
    }
    await runJobs('Mapping where you can walk', navJobs, async (n) => {
      n.meta = await pool.run('nav', { col: n.e.x, row: n.e.y, tile: abs(n.e.rel), models: abs('models'), out: abs(n.rel), kinds });
    });
    for (const map of maps) {
      map.nav = map.nav.filter((n) => n.meta);
      for (const n of map.nav) next.artifacts[n.rel] = { sig: n.sig, meta: n.meta };
    }
  } finally {
    await pool.close();
  }

  // ---- creatures (source of the danger zones) --------------------------------------------
  // From QuestieDB, the community's database of this game. The Atlas database has it as it is
  // published (a scheduled function puts every new version there): it is fetched from there
  // first, so the game needs no addon for it. Without a connection the copy fetched earlier is
  // used, and without one of those the QuestieDB addon in the game's AddOns folder, where it is
  // installed. Optional all the same: anything wrong with it only leaves the danger zones, the
  // NPCs and the quests out; it never fails the map update.
  report({ type: 'phase', name: 'Looking for newer creature data' });
  await fetchQuestie(cfg, log);
  report({ type: 'phase', name: 'Placing creatures' });
  let danger = null;
  let questie = null; // which QuestieDB file this map was built from (even if it was unusable)
  let innsSig = null, dungeonsSig = null, liftsSig = null;
  let reference = null, ref = null; // the reference database, once it has been looked for (the NPC layer and the lifts both read it)
  let questieDb = null, factionTemplates = null, factionHash = null; // kept for the NPC layer below
  try {
    const file = findQuestieDb(cfg);
    if (file) questie = { stamp: questieStamp(file) };
    if (!file) log('QuestieDB could not be fetched from the Atlas database and is not an addon in the game folder either: spawn zones, NPCs and quests are unavailable');
    else {
      const db = readQuestie(file);
      questie.hash = db.hash; // (what is in it: the same data in another place is the same data - see builtFromQuestie)
      log(`QuestieDB ${db.version ?? '?'}, from ${questieFrom(cfg, file)}`);
      const ft = await loadTable(casc, 'FactionTemplate', log);
      const templates = ft ? new Map(ft.rows.map((r) => [r.ID, { friend: r.FriendGroup, enemy: r.EnemyGroup }])) : null;
      questieDb = db; factionTemplates = templates; factionHash = ft?.hash ?? null;
      if (!templates) log('faction table unavailable: every non-friendly creature is treated as hostile');
      const s = sig(CREATURES_VERSION, db.hash, sig(world.data.zones), ft?.hash ?? null, world.hash, maps.map((m) => m.areasEntry?.sig ?? null));
      const source = `QuestieDB ${db.version ?? '?'}`;
      // innkeepers, for the route planner (where a hearthstone leads) and for knowing the towns
      world.data.inns = placeInns(db.npcs, world.data.zones, templates);
      innsSig = sig('inns3', db.hash, ft?.hash ?? null);
      // the dungeons' doors, for leading a quest that is done inside one to the way in
      const dungeons = readQuestieDungeons(file);
      world.data.dungeons = placeDungeons(dungeons.list, world.data.zones, world.data.areas, dungeons.instances, world.maps);
      dungeonsSig = sig('dungeons2', dungeons.hash, sig(world.data.zones), sig(world.maps.map((r) => [r.ID, r.CorpseMapID, r.Corpse])));
      if (dungeons.list.length) log(`${world.data.dungeons.length} dungeons with their doors, from QuestieDB`);
      // the game's area under a spot, on any map (from the area grids built above)
      const grids = new Map();
      const areaAt = (mapId, x, y) => {
        let g = grids.get(mapId);
        if (g === undefined) {
          g = null;
          const entry = maps.find((m) => m.id === mapId)?.areasEntry;
          try {
            if (entry) {
              const c = unpackContainer(fs.readFileSync(abs(entry.rel)), 'WFA1');
              const h = c.sections.get(1), b = c.sections.get(2);
              g = { minCol: h.readInt32LE(0), minRow: h.readInt32LE(4), cols: h.readInt32LE(8), rows: h.readInt32LE(12), grid: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
            }
          } catch { g = null; }
          grids.set(mapId, g);
        }
        if (!g) return 0;
        const cx = Math.floor((32 - y / TILE_YARDS) * 16) - g.minCol * 16, cy = Math.floor((32 - x / TILE_YARDS) * 16) - g.minRow * 16;
        return cx < 0 || cy < 0 || cx >= g.cols * 16 || cy >= g.rows * 16 ? 0 : g.grid[cy * g.cols * 16 + cx];
      };
      // (the area each innkeeper stands in: a zone with two inns, and the game names only the place your hearthstone is set to)
      for (const i of world.data.inns) { const a = areaAt(i.map, i.pos[0], i.pos[1]); if (a) i.area = a; }
      const places = { areaAt, areas: world.data.areas, capitals: world.data.capitals, inns: world.data.inns, taxiNodes: world.data.taxiNodes };
      const { maps: placed, dropped } = placeCreatures(db.npcs, world.data.zones, templates, places);
      let total = 0;
      for (const map of maps) {
        const m = placed.get(map.id);
        if (!m || !m.spawnCreature.length) continue;
        const rel = `maps/${map.id}/creatures.bin`;
        let meta;
        if (fresh(rel, s)) { meta = prev.artifacts[rel].meta; stats.reused++; }
        else { meta = writeCreatures(abs(rel), m, source); stats.built++; }
        map.creaturesEntry = { rel, sig: s, meta };
        next.artifacts[rel] = { sig: s, meta };
        total += meta.spawns;
      }
      danger = { source, spawns: total };
      log(`${source}: ${total.toLocaleString()} creature spawn points placed (${dropped.unconfirmed} creatures with no side recorded among them, at ${dropped.unconfirmedPoints.toLocaleString()} spawn points, flagged as such; left out: ${dropped.inTown.toLocaleString()} spawn points inside a town or city of the side they are hostile to; ${dropped.unconfirmedFolk} with no side recorded who have a job or a quest; ${dropped.friendly} friendly to everyone; ${dropped.unknownLevel} with no level)`);
    }
  } catch (err) {
    log(`danger zones unavailable: ${err.message}`);
  }

  // ---- everyone and everything, with heights (the map's NPC layer) --------------------------
  // QuestieDB again, for every creature and quest object this time, each spawn point given a
  // height from the reference database and the map's own ground (see jobs/npcs.js). Optional
  // like the danger zones: anything wrong here only leaves the NPC layer out.
  let npcInfo = null;
  if (questieDb) {
    report({ type: 'phase', name: 'Placing NPCs' });
    try {
      const db = questieDb;
      const source = `QuestieDB ${db.version ?? '?'}`;
      reference = await fetchReference(cfg, dataDir, log);
      if (reference) { try { ref = readReference(reference.file); } catch (err) { log(`reference database unreadable (${err.message}): heights come from the map data alone`); } }
      const placed = placeNpcs(db, world.data.zones, factionTemplates, ref ? { areas: world.data.areas, ref, mapIds: new Set(maps.map((m) => m.id)) } : null);
      const todo = [];
      for (const map of maps) {
        const m = placed.get(map.id);
        if (!m || (!m.points.length && !m.unplaced.length)) continue;
        const navRev = map.nav?.length ? sig(map.nav.map((n) => n.sig)) : null;
        const s = sig(NPCS_VERSION, db.hash, sig(world.data.zones), factionHash, reference?.sha ?? null, navRev);
        map.npcsEntry = { rel: `maps/${map.id}/npcs.bin`, sig: s, meta: null };
        if (fresh(map.npcsEntry.rel, s)) { map.npcsEntry.meta = prev.artifacts[map.npcsEntry.rel].meta; stats.reused++; }
        else todo.push({ map, m });
      }
      if (todo.length) {
        report({ type: 'phase', name: 'Working out where NPCs stand', total: todo.length });
        let done = 0;
        for (const { map, m } of todo) {
          const nav = map.nav?.length ? new NavReader(abs(`maps/${map.id}/nav`)) : null;
          const h = resolveHeights(m, map.id, nav, ref);
          map.npcsEntry.meta = writeNpcs(abs(map.npcsEntry.rel), m, h, { source, reference: reference?.name ?? null });
          stats.built++;
          report({ type: 'progress', done: ++done, total: todo.length });
        }
      }
      const heights = [0, 0, 0, 0, 0];
      let spawns = 0, places = 0;
      for (const map of maps) {
        const e = map.npcsEntry;
        if (!e?.meta) continue;
        next.artifacts[e.rel] = { sig: e.sig, meta: e.meta };
        spawns += e.meta.spawns; places++;
        e.meta.heights.forEach((c, i) => { heights[i] += c; });
      }
      // the quests (who gives and takes each, what it asks for)
      const qs = sig(NPCS_VERSION, db.hash, sig(world.data.zones), reference?.sha ?? null);
      if (fresh('quests.json', qs)) stats.reused++;
      else { writeFileAtomic(abs('quests.json'), JSON.stringify({ source, reference: ref ? reference.name : null, ...buildQuests(db, world.data.zones, ref) })); stats.built++; }
      next.artifacts['quests.json'] = { sig: qs };
      npcInfo = { source, reference: reference?.name ?? null, spawns, heights, quests: db.quests.length };
      const pct = (c) => `${((c / Math.max(1, spawns)) * 100).toFixed(0)}%`;
      log(`${source}: ${spawns.toLocaleString()} NPC and object spawn points placed on ${places} maps. Heights: ${pct(heights[4])} from the reference database and confirmed by the ground, ${pct(heights[3])} from the reference database alone, ${pct(heights[2])} the only place to stand, ${pct(heights[1])} the likeliest of several, ${pct(heights[0])} not known`);
    } catch (err) {
      log(`NPC layer unavailable: ${err.message}`);
    }
  }

  // ---- lifts, and what the game calls each room of its buildings ---------------------------
  // For the height tracker (viewer/js/height.js), which works out how high you are from what the
  // game does tell an addon: a lift carries you up or down with no step across the map, so the
  // map has to know where the lifts are (world.json: lifts); and the game says the name of the
  // room you stand in, so the map has to know the rooms' names (rooms.json). Either missing only
  // leaves the tracker without that help.
  try {
    if (!reference) { reference = await fetchReference(cfg, dataDir, log); if (reference) ref = readReference(reference.file); }
    const anim = await loadTable(casc, 'TransportAnimation', log);
    world.data.lifts = ref && anim ? liftsOf(ref, anim.rows) : [];
    liftsSig = sig('lifts1', reference?.sha ?? null, anim?.hash ?? null);
    if (world.data.lifts.length) log(`${world.data.lifts.length} lifts, from the reference database and the game's own table of how each moves`);
  } catch (err) {
    world.data.lifts = [];
    log(`lifts unavailable: ${err.message}`);
  }
  try {
    const t = await loadTable(casc, 'WMOAreaTable', log);
    if (t) {
      const rs = sig('rooms', ROOMS_VERSION, t.hash, sig(Object.entries(world.data.areas).map(([id, a]) => [id, a.n])));
      if (fresh('rooms.json', rs)) stats.reused++;
      else {
        const rooms = roomNames(t.rows, world.data.areas);
        writeFileAtomic(abs('rooms.json'), JSON.stringify(rooms));
        stats.built++;
        log(`rooms: ${rooms.names.length.toLocaleString()} names for the rooms of ${Object.keys(rooms.wmo).length.toLocaleString()} buildings`);
      }
      next.artifacts['rooms.json'] = { sig: rs };
    }
  } catch (err) {
    log(`room names unavailable: ${err.message}`);
  }

  // ---- items ---------------------------------------------------------------------------
  // Every item's name and kind (jobs/items.js), for wherever an item is shown. It is made again
  // whenever the game has been sent new records, which is most times you have played: so it is
  // not counted among what makes the map "changed".
  report({ type: 'phase', name: 'Listing items' });
  try {
    const made = await ensureItems(casc, cfg, log);
    if (!made) log('items: the item tables of the game could not be read');
    else if (made.built) stats.built++; else stats.reused++;
  } catch (err) {
    log(`items unavailable: ${err.message}`);
  }
  // and everything the professions make, and out of what (jobs/recipes.js)
  report({ type: 'phase', name: 'Listing recipes' });
  try {
    const made = await ensureRecipes(casc, cfg, log);
    if (!made) log('recipes: the profession tables of the game could not be read');
    else if (made.built) stats.built++; else stats.reused++;
  } catch (err) {
    log(`recipes unavailable: ${err.message}`);
  }

  // ---- metadata ------------------------------------------------------------------------
  report({ type: 'phase', name: 'Writing metadata' });
  const manifestMaps = [];
  const areaCount = new Map();
  for (const a of Object.values(world.data.areas)) areaCount.set(a.m, (areaCount.get(a.m) ?? 0) + 1);
  for (const map of maps) {
    const { row, wdt } = map;
    if (!map.tiles.length && !wdt.globalWmo) continue;
    let minH = Infinity, maxH = -Infinity;
    for (const e of map.tiles) { minH = Math.min(minH, e.meta.minH); maxH = Math.max(maxH, e.meta.maxH); }
    const g = wdt.globalWmo && wdt.globalWmo.isFdid ? wdt.globalWmo : null;
    const pages = {};
    for (let level = 1; level <= TOP_LEVEL; level++) pages[level] = (map.pages[level] ?? []).map((e) => [e.x, e.y, round1(e.meta.minH), round1(e.meta.maxH), e.meta.water ? 1 : 0]);
    // (a map that is one building: 'middle' is how that building is placed - see below - so that a map built before it was put right is written anew)
    let rev = sig(FORMAT_VERSION, map.tiles.map((e) => e.sig), Object.values(map.pages).flat().map((e) => e.sig), map.areasEntry?.sig, map.wmosEntry?.sig, map.creaturesEntry?.sig, map.npcsEntry?.sig ?? null, g?.fdid ?? 0, ckey(g?.fdid), ...(g ? ['middle'] : [])).slice(0, 10);
    // the walkable-ground data has its own revision (it changes when a building model does)
    const navRev = map.nav?.length ? sig(map.nav.map((n) => n.sig)) : null;
    if (navRev) rev = sig(rev, navRev);
    const mapJson = {
      id: row.ID, name: row.MapName_lang, directory: row.Directory, instanceType: row.InstanceType,
      parentMap: row.ParentMapID, areaTable: row.AreaTableID,
      topLevel: TOP_LEVEL,
      // [col, row, minHeight, maxHeight, flags]  flags: 1 = has baked colour texture, 2 = has liquid
      tiles: map.tiles.map((e) => [e.x, e.y, round1(e.meta.minH), round1(e.meta.maxH), (e.meta.hasColor ? 1 : 0) | (e.meta.liquidTypes.length ? 2 : 0)]),
      pages,
      ocean: map.ocean, seaLevel: map.seaLevel,
      areas: map.areasEntry?.meta ?? null,
      wmoCount: map.wmosEntry?.meta?.count ?? 0,
      creatures: map.creaturesEntry?.meta ?? null,
      npcs: map.npcsEntry?.meta ?? null, // maps/<id>/npcs.bin
      nav: navRev ? { tiles: map.nav.length, rev: navRev, cells: 512 } : null, // maps/<id>/nav/<col>_<row>.bin
      heightRange: map.tiles.length ? [minH, maxH] : null,
      // A map that is one building (the Deeprun Tram, a dungeon) has it placed from the middle of
      // the world, not from the map's corner as everything that stands on a map with ground is:
      // the game's files put every one of them at (0, 0, 0), and you walk about in them at the
      // building's own coordinates. (Placed from the corner, the building stood 17,067 yards north
      // and west of everyone in it. `middle` says it is placed aright: the page moves one that is
      // not, from a map built before this - viewer/js/scene.js.)
      globalWmo: g ? {
        fdid: g.fdid, uniqueId: g.uniqueId, pos: [-g.pos[2], -g.pos[0], g.pos[1]], rot: g.rot, scale: g.scale, doodadSet: g.doodadSet, nameSet: g.nameSet,
        bounds: [-g.extents[5], -g.extents[3], g.extents[1], -g.extents[2], -g.extents[0], g.extents[4]],
        middle: true,
      } : null,
      rev,
    };
    const rel = `maps/${row.ID}/map.json`;
    writeFileAtomic(abs(rel), JSON.stringify(mapJson));
    next.artifacts[rel] = { sig: rev };
    manifestMaps.push({
      id: row.ID, name: row.MapName_lang, directory: row.Directory, instanceType: row.InstanceType,
      kind: map.tiles.length ? 'terrain' : 'wmo', tileCount: map.tiles.length, rev,
      // Evidence of how the game itself uses this map (drives the grouping in the map list):
      zones: world.data.zones.filter((z) => z.map === row.ID && z.type === 3).length, // zones on the in-game world map
      areas: areaCount.get(row.ID) ?? 0,                                                // named areas
      parent: row.ParentMapID,                                                          // >= 0: a phase/variant of that map
    });
  }
  writeFileAtomic(abs('world.json'), JSON.stringify(world.data));
  next.artifacts['world.json'] = { sig: sig(world.hash, innsSig, dungeonsSig, liftsSig) };

  // A filtered run (--maps) must not drop the other maps that were extracted earlier.
  if (mapFilter && !prev.stale) {
    for (const [rel, a] of Object.entries(prev.artifacts)) {
      if (next.artifacts[rel]) continue;
      const m = /^maps\/(\d+)\//.exec(rel);
      // keep other maps, and the shared models/textures they use
      if (m ? !mapFilter.has(+m[1]) : /^(models|tex)\//.test(rel)) next.artifacts[rel] = a;
    }
    for (const m of prevManifest?.maps ?? []) if (!mapFilter.has(m.id)) manifestMaps.push(m);
  }
  manifestMaps.sort((a, b) => (a.instanceType - b.instanceType) || (b.tileCount - a.tileCount) || (a.id - b.id));

  // ---- remove outputs whose source no longer exists -------------------------------------
  for (const rel of Object.keys(prev.artifacts)) {
    if (next.artifacts[rel]) continue;
    try { fs.unlinkSync(abs(rel)); stats.removed++; } catch { /* already gone */ }
  }

  const revision = sig(Object.entries(next.artifacts).map(([k, v]) => k + v.sig).sort());
  const manifest = {
    formatVersion: FORMAT_VERSION,
    tool: DATA_STAMP, // (which build of the map data this is: see stamp.js)
    build: casc.build,
    revision,
    extractedAt: new Date().toISOString(),
    models: modelCounts,
    danger,
    npcs: npcInfo,
    questie,
    maps: manifestMaps,
  };
  const changed = prevManifest?.revision !== revision;
  writeFileAtomic(statePath, JSON.stringify(next));
  writeFileAtomic(abs('manifest.json'), JSON.stringify(manifest, null, 1));
  casc.close();
  const summary = { ...stats, changed, revision, build: casc.build.version, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  report({ type: 'done', summary });
  return summary;
}

// ---- command line ------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
  const json = !!args.json;
  let lastLine = 0;
  const report = (ev) => {
    if (json) { process.stdout.write(JSON.stringify(ev) + '\n'); return; }
    if (ev.type === 'phase') console.log(`\n== ${ev.name}${ev.total ? ` (${ev.total})` : ''}`);
    else if (ev.type === 'log') console.log('   ' + ev.msg);
    else if (ev.type === 'progress') {
      const now = Date.now();
      if (now - lastLine > 1000 || ev.done === ev.total) { lastLine = now; console.log(`   ${ev.done}/${ev.total}`); }
    } else if (ev.type === 'done') console.log('\nDone:', ev.summary);
  };
  try {
    const cfg = loadConfig();
    if (args.workers) cfg.workers = +args.workers;
    await runExtraction(cfg, { force: !!args.force, maps: args.maps ? String(args.maps).split(',').map(Number) : null }, report);
  } catch (err) {
    if (json) process.stdout.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
    else console.error('\nExtraction failed:', err.stack ?? err.message);
    process.exit(1);
  }
}
