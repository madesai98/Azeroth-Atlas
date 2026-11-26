// A second opinion on where things stand, with heights.
//
// QuestieDB (the game-specific source) knows every creature and object but only as a spot on a
// zone map: no height. The cmangos "classic-db" project publishes a full world database for the
// original game (patch 1.12), under the GPL, in which every spawn has its real x, y and z. Most
// of this game's world is that world, so wherever the two sources name the same creature at the
// same spot, the height (and a more exact position) can be taken from there, and checked
// against the ground in this game's own map data (see jobs/npcs.js).
//
// The file is downloaded once (about 13 MB) into <dataDir>/sources and looked for again only
// when the map is updated. With no connection, a copy fetched earlier is used; with none at
// all, heights are worked out from the map data alone. Nothing about you or your game is sent:
// these are two plain downloads from GitHub.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { writeFileAtomic } from './container.js';

const LISTING = 'https://api.github.com/repos/cmangos/classic-db/contents/Full_DB';
const WANTED = /^ClassicDB_.*\.sql\.gz$/i;
const HEADERS = { 'User-Agent': 'map-extractor', Accept: 'application/vnd.github+json' };

async function get(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}

/**
 * Make sure the reference database is on disk and say which one it is.
 * @param cfg  config.json (reference: false switches this off; referenceFile: a file of your own to use instead)
 * @returns {{ file, name, sha } | null}
 */
export async function fetchReference(cfg, dataDir, log) {
  if (cfg.reference === false) { log('reference database switched off in config.json: heights come from the map data alone'); return null; }
  if (cfg.referenceFile) {
    if (!fs.existsSync(cfg.referenceFile)) { log(`reference database ${cfg.referenceFile} not found`); return null; }
    const st = fs.statSync(cfg.referenceFile);
    return { file: cfg.referenceFile, name: path.basename(cfg.referenceFile), sha: `${st.size}:${Math.round(st.mtimeMs)}` };
  }
  const dir = path.join(dataDir, 'sources', 'classic-db');
  const noteFile = path.join(dir, 'source.json');
  let have = null;
  try { have = JSON.parse(fs.readFileSync(noteFile, 'utf8')); if (!fs.existsSync(path.join(dir, have.name))) have = null; } catch { have = null; }
  let latest = null;
  try {
    const list = JSON.parse((await get(LISTING, 20000)).toString('utf8'));
    latest = (Array.isArray(list) ? list : []).filter((f) => f.type === 'file' && WANTED.test(f.name)).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))[0] ?? null;
  } catch (err) {
    log(`could not look for the reference database online (${err.message})${have ? ': using the copy fetched earlier' : ''}`);
  }
  if (latest && (!have || have.sha !== latest.sha)) {
    try {
      log(`fetching the reference database ${latest.name} (${(latest.size / 1048576).toFixed(0)} MB)`);
      const data = await get(latest.download_url, 600000);
      zlib.gunzipSync(data.subarray(0, Math.min(data.length, 1 << 16)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }); // (is it what it says it is?)
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, latest.name), data);
      if (have && have.name !== latest.name) { try { fs.unlinkSync(path.join(dir, have.name)); } catch { /* left behind */ } }
      have = { name: latest.name, sha: latest.sha, size: latest.size, from: latest.html_url, fetched: new Date().toISOString() };
      writeFileAtomic(noteFile, JSON.stringify(have, null, 1));
    } catch (err) {
      log(`could not fetch the reference database (${err.message})${have ? ': using the copy fetched earlier' : ''}`);
    }
  }
  return have ? { file: path.join(dir, have.name), name: have.name, sha: have.sha } : null;
}

/**
 * Every row of one table of the dump, as lists of values in the table's own column order
 * (numbers as text, strings unquoted). Strings may hold commas, brackets and quotes: they are
 * read character by character, not split.
 */
function* tuples(sql, name) {
  const head = `INSERT INTO \`${name}\` VALUES `;
  for (let p = sql.indexOf(head); p >= 0; p = sql.indexOf(head, p + 1)) {
    let i = p + head.length;
    while (sql[i] === '(') {
      i++;
      const row = [];
      for (;;) {
        if (sql[i] === "'") {
          let j = i + 1, out = '';
          for (;;) {
            const c = sql[j];
            if (c === undefined) return;
            if (c === '\\') { out += sql[j + 1]; j += 2; } else if (c === "'") { if (sql[j + 1] === "'") { out += "'"; j += 2; } else break; } else { out += c; j++; }
          }
          row.push(out);
          i = j + 1;
        } else {
          let j = i;
          while (sql[j] !== ',' && sql[j] !== ')' && j < sql.length) j++;
          row.push(sql.slice(i, j));
          i = j;
        }
        if (sql[i] !== ',') break;
        i++;
      }
      i++; // (past the closing bracket)
      yield row;
      if (sql[i] !== ',') break;
      i++;
    }
  }
}
/** The names of a table's columns, in order. */
function columns(sql, name) {
  const create = sql.indexOf(`CREATE TABLE \`${name}\``);
  const cols = [];
  if (create < 0) return cols;
  for (const line of sql.slice(create, sql.indexOf(';', create)).split('\n')) { const m = /^\s*`(\w+)`/.exec(line); if (m) cols.push(m[1]); }
  return cols;
}

const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
/** One table of the dump, to be read: { ok (it is there), at(column): where a row has it, rows() }. */
function tableOf(sql, name) {
  const cols = columns(sql, name);
  return { ok: cols.length > 0, at: (c) => cols.indexOf(c), rows: () => tuples(sql, name) };
}
/** One of the dump's loot tables: Map<loot id, [[item, chance, group, min count or -reference, max count], ...]>. */
function lootTable(sql, name) {
  const out = new Map();
  const t = tableOf(sql, name);
  const c = ['entry', 'item', 'ChanceOrQuestChance', 'groupid', 'mincountOrRef', 'maxcount'].map(t.at);
  if (t.ok && c.every((i) => i >= 0)) for (const r of t.rows()) { const id = num(r[c[0]]); let list = out.get(id); if (!list) out.set(id, (list = [])); list.push([num(r[c[1]]), num(r[c[2]]), num(r[c[3]]), num(r[c[4]]), num(r[c[5]])]); }
  return out;
}
/** The dump's text (a .gz is unpacked). */
const textOf = (raw, file) => (/\.gz$/i.test(file) ? zlib.gunzipSync(raw) : raw).toString('latin1');

/**
 * What the reference database knows that QuestieDB does not, for the quest explorer and the
 * NPC filters (all of it for the original game: a creature or quest new to this one is not here):
 *   templates  Map<creature id, { type (1 beast, 2 dragonkin, 3 demon, 4 elemental, 5 giant, 6 undead,
 *              7 humanoid, 8 critter, 9 mechanical), family, rank, lv: [min, max], hp: [at min level, at max], loot, skin }>
 *   respawn    Map<creature id, seconds it takes to be back (the middle one of its spawn points)>
 *   loot       { creature, reference, object: Map<loot id, [[item, chance, group, min count or -reference, max count], ...]> }
 *              (chance: per cent; negative: only while you are on the quest that wants it; 0: an equal share of what its group has left)
 *   chests     Map<object id, loot id>
 *   movers     Map<object id, name>: the objects that carry you (lifts, moving platforms: the game's
 *              "transport" kind). Where each stands is among the object spawns; how far it
 *              travels is the game's own to say (world.js, liftsOf)
 *   quests     Map<quest id, { title, type, limit (seconds), needs: [['n' | 'o' | 'i', id, how many], ...] }>
 *   entrances  [{ id, name, map, pos: [x, y, z], facing }]: where the server puts you when you walk into
 *              one of the game's doorways (its "area triggers": id is the game's own number for the doorway) -
 *              the spot inside a dungeon's door among them (world.js, entrancesOf)
 */
function readFacts(sql) {
  const reader = (name) => tableOf(sql, name);
  const templates = new Map();
  {
    const t = reader('creature_template');
    const c = ['Entry', 'MinLevel', 'MaxLevel', 'Family', 'CreatureType', 'Rank', 'MinLevelHealth', 'MaxLevelHealth', 'LootId', 'SkinningLootId'].map(t.at);
    // (the coin in a corpse, in copper: the least and the most - where the dump has it)
    const iLeast = t.at('MinLootGold'), iMost = t.at('MaxLootGold');
    if (t.ok && c.every((i) => i >= 0)) for (const r of t.rows()) {
      const one = { lv: [num(r[c[1]]), num(r[c[2]])], family: num(r[c[3]]), type: num(r[c[4]]), rank: num(r[c[5]]), hp: [num(r[c[6]]), num(r[c[7]])], loot: num(r[c[8]]), skin: num(r[c[9]]) };
      if (iLeast >= 0 && iMost >= 0) { const least = num(r[iLeast]), most = Math.max(least, num(r[iMost])); if (most > 0) one.gold = [least, most]; }
      templates.set(num(r[c[0]]), one);
    }
  }
  const respawn = new Map();
  {
    const t = reader('creature');
    const iId = t.at('id'), iMin = t.at('spawntimesecsmin'), iMax = t.at('spawntimesecsmax');
    const all = new Map();
    if (t.ok && Math.min(iId, iMin, iMax) >= 0) for (const r of t.rows()) { const id = num(r[iId]); let list = all.get(id); if (!list) all.set(id, (list = [])); list.push((num(r[iMin]) + num(r[iMax])) / 2); }
    for (const [id, list] of all) { list.sort((a, b) => a - b); respawn.set(id, Math.round(list[list.length >> 1])); }
  }
  const loot = { creature: lootTable(sql, 'creature_loot_template'), reference: lootTable(sql, 'reference_loot_template'), object: lootTable(sql, 'gameobject_loot_template') };
  const chests = new Map(), movers = new Map(), objectKinds = new Map();
  {
    const t = reader('gameobject_template');
    const iId = t.at('entry'), iType = t.at('type'), iData = t.at('data1'), iName = t.at('name');
    // (the object's kind and its first five numbers, as the server has them: which lock it has, what a profession works at there - world.js, objectNeeds)
    const iNumbers = [0, 1, 2, 3, 4].map((n) => t.at(`data${n}`));
    if (t.ok && Math.min(iId, iType, ...iNumbers) >= 0) for (const r of t.rows()) objectKinds.set(num(r[iId]), [num(r[iType]), ...iNumbers.map((i) => num(r[i]))]);
    // (type 3: a chest - anything you open and take from; its second number is the loot it holds.
    // type 11: something that moves along a way of its own with whoever stands on it - a lift)
    if (t.ok && Math.min(iId, iType, iData) >= 0) for (const r of t.rows()) {
      if (num(r[iType]) === 3 && num(r[iData]) > 0) chests.set(num(r[iId]), num(r[iData]));
      else if (num(r[iType]) === 11) movers.set(num(r[iId]), iName >= 0 ? String(r[iName] ?? '') : '');
    }
  }
  const quests = new Map();
  {
    const t = reader('quest_template');
    const iId = t.at('entry'), iTitle = t.at('Title'), iType = t.at('Type'), iLimit = t.at('LimitTime');
    if (t.ok && iId >= 0) for (const r of t.rows()) {
      const needs = [];
      for (let k = 1; k <= 4; k++) {
        const who = num(r[t.at(`ReqCreatureOrGOId${k}`)]), many = num(r[t.at(`ReqCreatureOrGOCount${k}`)]);
        if (who && many > 0) needs.push([who > 0 ? 'n' : 'o', Math.abs(who), many]);
        const item = num(r[t.at(`ReqItemId${k}`)]), count = num(r[t.at(`ReqItemCount${k}`)]);
        if (item > 0 && count > 0) needs.push(['i', item, count]);
      }
      quests.set(num(r[iId]), { title: iTitle >= 0 ? r[iTitle] : '', type: iType >= 0 ? num(r[iType]) : 0, limit: iLimit >= 0 ? num(r[iLimit]) : 0, needs });
    }
  }
  const entrances = [];
  {
    const t = reader('areatrigger_teleport');
    const c = ['id', 'name', 'target_map', 'target_position_x', 'target_position_y', 'target_position_z', 'target_orientation'].map(t.at);
    if (t.ok && c.every((i) => i >= 0)) for (const r of t.rows()) entrances.push({ id: num(r[c[0]]), name: String(r[c[1]] ?? ''), map: num(r[c[2]]), pos: [num(r[c[3]]), num(r[c[4]]), num(r[c[5]])], facing: num(r[c[6]]) });
  }
  return { templates, respawn, loot, chests, movers, objectKinds, quests, entrances };
}

/**
 * Everything a loot table gives, each thing with the chance that one corpse (or chest) has it:
 * Map<item, [chance (0..1), true if only while you are on the quest that wants it, how many
 * pieces a corpse that has it gives on average]>.
 * A loot table lists items on their own (each with its own chance), items in groups (one of the
 * group at most: those with no chance of their own share what is left), and references to
 * shared tables, rolled a number of times.
 * @param tables { main: Map<loot id, rows>, reference: Map<loot id, rows> } (readReference().loot: creature or object, and reference)
 */
export function lootOf(tables, id, shared = false, depth = 0) {
  const rows = (shared ? tables.reference : tables.main).get(id);
  const out = new Map();
  if (!rows || depth > 3) return out;
  // (what each group's members with no chance of their own get)
  const left = new Map();
  for (const [, chance, group, ref] of rows) {
    if (!group || ref < 0) continue;
    const g = left.get(group) ?? { given: 0, free: 0 };
    if (chance === 0) g.free++; else g.given += Math.abs(chance);
    left.set(group, g);
  }
  // (pieces: how many of a thing a corpse gives on average, those without it counted in - divided by the chance at the end)
  const miss = new Map(), quest = new Set(), pieces = new Map();
  const add = (item, p, only, many) => {
    miss.set(item, (miss.get(item) ?? 1) * (1 - Math.min(1, Math.max(0, p))));
    pieces.set(item, (pieces.get(item) ?? 0) + Math.max(0, many));
    if (only) quest.add(item);
  };
  for (const [item, chance, group, minOrRef, max] of rows) {
    if (minOrRef < 0) {
      // a shared table, rolled `max` times, each time with this chance
      const roll = (Math.abs(chance) || 100) / 100, times = Math.max(1, max);
      for (const [inner, [p, only, each]] of lootOf(tables, -minOrRef, true, depth + 1)) {
        const once = Math.min(1, roll * p);
        add(inner, 1 - (1 - once) ** times, only || chance < 0, times * once * (each ?? 1));
      }
    } else {
      const g = group ? left.get(group) : null;
      const pct = chance !== 0 ? Math.abs(chance) : g && g.free ? Math.max(0, 100 - g.given) / g.free : 100;
      const least = Math.max(1, minOrRef), most = Math.max(least, max);
      add(item, pct / 100, chance < 0, Math.min(1, Math.max(0, pct / 100)) * (least + most) / 2);
    }
  }
  for (const [item, m] of miss) if (item > 0 && m < 1) out.set(item, [1 - m, quest.has(item), Math.max(1, (pieces.get(item) ?? 0) / (1 - m))]);
  return out;
}

/**
 * Read the spawn tables out of the database dump, and what else it knows (see readFacts).
 * @returns {{ hash, creatures: Map<id, number[]>, objects: Map<id, number[]>, ...facts }}  each list is map, x, y, z per spawn
 */
export function readReference(file) {
  const raw = fs.readFileSync(file);
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const sql = textOf(raw, file);
  const table = (name) => {
    const out = new Map();
    const create = sql.indexOf(`CREATE TABLE \`${name}\``);
    if (create < 0) return out;
    // the order of the columns, from the table's own definition
    const cols = [];
    for (const line of sql.slice(create, sql.indexOf(';', create)).split('\n')) { const m = /^\s*`(\w+)`/.exec(line); if (m) cols.push(m[1]); }
    const at = (c) => cols.indexOf(c);
    const iId = at('id'), iMap = at('map'), iX = at('position_x'), iY = at('position_y'), iZ = at('position_z');
    if (Math.min(iId, iMap, iX, iY, iZ) < 0) return out;
    const head = `INSERT INTO \`${name}\` VALUES `;
    for (let p = sql.indexOf(head); p >= 0; p = sql.indexOf(head, p + 1)) {
      const end = sql.indexOf(';\n', p);
      const tuple = /\(([^()]*)\)/g;
      tuple.lastIndex = p + head.length;
      for (let m = tuple.exec(sql); m && m.index < end; m = tuple.exec(sql)) {
        const v = m[1].split(',');
        const id = +v[iId], x = +v[iX], y = +v[iY], z = +v[iZ], map = +v[iMap];
        if (!Number.isFinite(x + y + z) || !(id > 0)) continue;
        let list = out.get(id);
        if (!list) out.set(id, (list = []));
        list.push(map, x, y, z);
      }
    }
    return out;
  };
  let facts = { templates: new Map(), respawn: new Map(), loot: { creature: new Map(), reference: new Map(), object: new Map() }, chests: new Map(), movers: new Map(), objectKinds: new Map(), quests: new Map(), entrances: [] };
  try { facts = readFacts(sql); } catch { /* the spawn tables alone, as before */ }
  return { hash, creatures: table('creature'), objects: table('gameobject'), ...facts };
}

// ---- which things drop only with their quest ----------------------------------------------------
// The loot tables say of every drop whether it is in a corpse only while a quest of yours wants
// the thing: its chance is written below nought. The game's own word on an item - how it binds -
// tells that right for all but a few things: a Troll Tribal Necklace is bound to nothing, and is
// in a Vilebranch troll only for whoever has the quest for it. Those the tables put right
// (server/drops.js marks them for the addon in the game).
//
// Only what the tables mark is taken from them - not what they leave unmarked. A mark is
// somebody's deliberate word; "for anybody" is also what a row says that nobody looked at, and
// what a row says that has a condition of its own, which is not read here (a Red Scepter Shard
// is in Nefarian for the one who has its quest: by a condition, not by its chance). So where
// the game binds a thing to a quest and the tables do not mark it, the game's word stands.
const ONLY_VERSION = 1;              // of how the list is made: raise to have it made again
const ONLY_FILE = 'quest-only.json'; // where it is kept, beside the dump it is of

/**
 * The things the creatures' loot tables give only with their quest: every one of those tables
 * that has the thing marks it so (a thing that any creature gives to anybody is not among them).
 * @param tables  { main, reference } (readReference().loot: creature, and reference)
 * @param lootIds the creatures' loot tables (their numbers)
 * @returns Set<item>
 */
export function questOnly(tables, lootIds) {
  const only = new Set(), free = new Set();
  for (const id of new Set(lootIds)) for (const [item, [, quest]] of lootOf(tables, id)) (quest ? only : free).add(item);
  for (const item of free) only.delete(item);
  return only;
}

/**
 * The reference database as it is on this disk - nothing is looked for online:
 * { file, name, stamp (another for another dump) }, or null (never fetched, or switched off).
 * @param cfg config.json, or nothing (see fetchReference)
 */
export function referenceOnDisk(cfg, dataDir) {
  try {
    if (cfg?.reference === false) return null;
    let file = cfg?.referenceFile || null;
    if (!file) {
      const dir = path.join(dataDir, 'sources', 'classic-db');
      let name = null;
      try { name = path.basename(String(JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).name ?? '')); } catch { /* no note of which: whatever dump is there */ }
      if (!name || !fs.existsSync(path.join(dir, name))) name = fs.readdirSync(dir).filter((f) => /\.sql(\.gz)?$/i.test(f)).sort()[0] ?? null;
      if (!name) return null;
      file = path.join(dir, name);
    }
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { file, name: path.basename(file), stamp: `${path.basename(file)}:${st.size}:${Math.round(st.mtimeMs)}` };
  } catch { return null; }
}

/**
 * ...of the reference database on this disk: Set<item> - or null where there is none, or it is
 * not to be read. Read out of the dump once and kept beside it (the items, and which dump they
 * are of), so that the dump - a second's work - is read again only when it is another.
 */
export function questOnlyThings(cfg, dataDir) {
  const have = referenceOnDisk(cfg, dataDir);
  if (!have) return null;
  const kept = path.join(dataDir, 'sources', 'classic-db', ONLY_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(kept, 'utf8'));
    if (j?.v === ONLY_VERSION && j.of === have.stamp && Array.isArray(j.items)) return new Set(j.items.filter((i) => Number.isInteger(i) && i > 0));
  } catch { /* not made yet */ }
  let items;
  try {
    const sql = textOf(fs.readFileSync(have.file), have.file);
    const t = tableOf(sql, 'creature_template');
    const iLoot = t.at('LootId');
    const lootIds = [];
    if (t.ok && iLoot >= 0) for (const r of t.rows()) { const id = num(r[iLoot]); if (id > 0) lootIds.push(id); }
    items = [...questOnly({ main: lootTable(sql, 'creature_loot_template'), reference: lootTable(sql, 'reference_loot_template') }, lootIds)].sort((a, b) => a - b);
  } catch { return null; }
  try {
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    writeFileAtomic(kept, JSON.stringify({ v: ONLY_VERSION, of: have.stamp, items }));
  } catch { /* made again the next time */ }
  return new Set(items);
}
