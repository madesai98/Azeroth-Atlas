// What this copy of the map has learned about the game world, gathered and sent on to the
// Atlas database, where it is put together with what every other copy has learned.
//
// Gathered from:
//   - the game's own cache (<game>/Cache/WDB/<language>/*.wdb): what the game's server told your
//     game about the creatures, objects and quests you have met. Read only, never changed.
//   - what the map has seen for itself: where an NPC really stands, noted when you talk to one
//     (<dataDir>/user/npcs-seen.json).
//
// Sent: facts about the game world and nothing else. Not your account, your characters, your
// realm, your computer's name, where you were or when. A sighting goes as "this NPC stands
// here"; where you stood and when you saw it stay on your disk. What is sent is filed under a
// made-up name this copy is signed in under (signin.js), which says nothing about you.
import fs from 'node:fs';
import path from 'node:path';
import { flavourFolder } from '../extractor/config.js';
import { fromCache, hashOf } from './records.js';
import { SERVER_TIME } from './rtdb.js';

const BATCH = 400 * 1024; // bytes of facts to one delivery
const CACHE = { 'creaturecache.wdb': 'npc', 'gameobjectcache.wdb': 'object', 'questcache.wdb': 'quest' };

/** Whatever the game's own language, the names kept are the English ones: a cache in another language gives its facts without its words. */
const wordless = (kind, rec) => {
  const { n, sub, ...rest } = rec;
  return rest;
};

/**
 * Read everything there is to send.
 * @returns { build, npc: Map<id, fields>, object: Map, quest: Map, seen: [[kind letter, id, map, x, y, z]], notes: string[] }
 */
export async function gather(cfg, dataDir) {
  const found = { build: 0, npc: new Map(), object: new Map(), quest: new Map(), seen: [], notes: [] };
  const folder = flavourFolder(cfg);
  const root = folder ? path.join(cfg.installRoot, folder, 'Cache', 'WDB') : null;
  let languages = [];
  try { languages = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { found.notes.push('the game has no cache yet'); }
  let readWdb = null;
  try { ({ readWdb } = await import('../extractor/wdb.js')); } catch (err) { found.notes.push(`the cache reader is not there (${err.message})`); }
  // (English first: its names are the ones kept)
  for (const lang of languages.sort((a, b) => (a === 'enUS' ? -1 : b === 'enUS' ? 1 : a.localeCompare(b)))) {
    if (!readWdb) break;
    for (const [file, kind] of Object.entries(CACHE)) {
      let wdb;
      try { wdb = readWdb(path.join(root, lang, file)); } catch { continue; }
      if (!wdb || wdb.unreadable || !wdb.records?.length) { if (wdb?.unreadable) found.notes.push(`${lang}/${file}: laid out in a way this version cannot read (game build ${wdb.build})`); continue; }
      found.build = Math.max(found.build, wdb.build || 0);
      for (const r of wdb.records) {
        if (!Number.isInteger(r.id) || r.id <= 0) continue;
        let rec = fromCache(kind, r);
        if (lang !== 'enUS') rec = wordless(kind, rec);
        if (!Object.keys(rec).length) continue;
        if (!found[kind].has(r.id)) found[kind].set(r.id, rec);
      }
    }
  }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'user', 'npcs-seen.json'), 'utf8'));
    const r2 = (v) => Math.round(v * 100) / 100;
    for (const s of d.seen ?? []) {
      if (!Number.isInteger(s.map) || !Number.isInteger(s.id) || s.id <= 0 || ![s.x, s.y, s.z].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 40000)) continue;
      found.seen.push([s.object ? 'o' : 'n', s.id, s.map, r2(s.x), r2(s.y), r2(s.z)]);
    }
  } catch { /* nothing seen yet */ }
  return found;
}

/**
 * Send what has not been sent before.
 * @param db     Rtdb
 * @param store  LocalStore
 * @param copy   the name this copy is signed in under (none: a database open to all, and its made-up name)
 * @param dry    true: say what would be sent, send nothing
 * @returns { sent: { npc, object, quest, seen }, deliveries, bytes }
 */
export async function share(db, store, found, { app = '', dry = false, copy = null } = {}) {
  const install = copy ?? store.install();
  const sent = store.read('sent.json', {});
  const fresh = { npc: {}, object: {}, quest: {}, seen: [] }, marks = {};
  const count = { npc: 0, object: 0, quest: 0, seen: 0 };
  for (const kind of ['npc', 'object', 'quest']) {
    for (const [id, rec] of found[kind]) {
      const key = `${kind}:${id}`, mark = hashOf([found.build, rec]);
      if (sent[key] === mark) continue;
      fresh[kind]['i' + id] = rec; marks[key] = mark; count[kind]++;
    }
  }
  for (const s of found.seen) {
    const key = `seen:${s[0]}${s[1]}:${s[2]}:${Math.round(s[3] / 30)}:${Math.round(s[4] / 30)}`, mark = hashOf(s);
    if (sent[key] === mark) continue;
    fresh.seen.push(s.join(',')); marks[key] = mark; count.seen++;
  }
  // deliveries of a modest size each
  const batches = [];
  let cur = null, size = 0;
  const open = () => { cur = { v: 1, app, build: found.build, at: SERVER_TIME }; size = 0; batches.push(cur); };
  const add = (kind, key, value) => {
    const bytes = JSON.stringify(value).length + 16;
    if (!cur || size + bytes > BATCH) open();
    if (kind === 'seen') (cur.seen ??= []).push(value); else (cur[kind] ??= {})[key] = value;
    size += bytes;
  };
  for (const kind of ['npc', 'object', 'quest']) for (const [key, rec] of Object.entries(fresh[kind])) add(kind, key, rec);
  for (const s of fresh.seen) add('seen', null, s);
  let bytes = 0;
  for (const b of batches) bytes += JSON.stringify(b).length;
  if (dry || !batches.length) return { sent: count, deliveries: batches.length, bytes, dry };
  for (const b of batches) await db.post(`inbox/${install}`, b);
  await db.patch(`installs/${install}`, { last: SERVER_TIME, app, build: found.build });
  store.write('sent.json', { ...sent, ...marks });
  return { sent: count, deliveries: batches.length, bytes, dry: false };
}
