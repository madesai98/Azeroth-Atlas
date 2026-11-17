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
 */
function readFacts(sql) {
  const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
  const reader = (name) => { const cols = columns(sql, name); const at = (c) => cols.indexOf(c); return { ok: cols.length > 0, at, rows: () => tuples(sql, name) }; };
  const templates = new Map();
  {
    const t = reader('creature_template');
    const c = ['Entry', 'MinLevel', 'MaxLevel', 'Family', 'CreatureType', 'Rank', 'MinLevelHealth', 'MaxLevelHealth', 'LootId', 'SkinningLootId'].map(t.at);
    if (t.ok && c.every((i) => i >= 0)) for (const r of t.rows()) templates.set(num(r[c[0]]), { lv: [num(r[c[1]]), num(r[c[2]])], family: num(r[c[3]]), type: num(r[c[4]]), rank: num(r[c[5]]), hp: [num(r[c[6]]), num(r[c[7]])], loot: num(r[c[8]]), skin: num(r[c[9]]) });
  }
  const respawn = new Map();
  {
    const t = reader('creature');
    const iId = t.at('id'), iMin = t.at('spawntimesecsmin'), iMax = t.at('spawntimesecsmax');
    const all = new Map();
    if (t.ok && Math.min(iId, iMin, iMax) >= 0) for (const r of t.rows()) { const id = num(r[iId]); let list = all.get(id); if (!list) all.set(id, (list = [])); list.push((num(r[iMin]) + num(r[iMax])) / 2); }
    for (const [id, list] of all) { list.sort((a, b) => a - b); respawn.set(id, Math.round(list[list.length >> 1])); }
  }
  const lootTable = (name) => {
    const out = new Map();
    const t = reader(name);
    const c = ['entry', 'item', 'ChanceOrQuestChance', 'groupid', 'mincountOrRef', 'maxcount'].map(t.at);
    if (t.ok && c.every((i) => i >= 0)) for (const r of t.rows()) { const id = num(r[c[0]]); let list = out.get(id); if (!list) out.set(id, (list = [])); list.push([num(r[c[1]]), num(r[c[2]]), num(r[c[3]]), num(r[c[4]]), num(r[c[5]])]); }
    return out;
  };
  const loot = { creature: lootTable('creature_loot_template'), reference: lootTable('reference_loot_template'), object: lootTable('gameobject_loot_template') };
  const chests = new Map(), movers = new Map();
  {
    const t = reader('gameobject_template');
    const iId = t.at('entry'), iType = t.at('type'), iData = t.at('data1'), iName = t.at('name');
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
  return { templates, respawn, loot, chests, movers, quests };
}

/**
 * Read the spawn tables out of the database dump, and what else it knows (see readFacts).
 * @returns {{ hash, creatures: Map<id, number[]>, objects: Map<id, number[]>, ...facts }}  each list is map, x, y, z per spawn
 */
export function readReference(file) {
  const raw = fs.readFileSync(file);
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const sql = (/\.gz$/i.test(file) ? zlib.gunzipSync(raw) : raw).toString('latin1');
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
  let facts = { templates: new Map(), respawn: new Map(), loot: { creature: new Map(), reference: new Map(), object: new Map() }, chests: new Map(), movers: new Map(), quests: new Map() };
  try { facts = readFacts(sql); } catch { /* the spawn tables alone, as before */ }
  return { hash, creatures: table('creature'), objects: table('gameobject'), ...facts };
}
