// What this copy of the map has learned about the game world, gathered and sent on to the
// Atlas database, where it is put together with what every other copy has learned.
//
// Gathered from:
//   - the game's own cache (<game>/Cache/WDB/<language>/*.wdb): what the game's server told your
//     game about the creatures, objects and quests you have met. Read only, never changed.
//   - what the map has seen for itself: where an NPC really stands, noted when you talk to one
//     (<dataDir>/user/npcs-seen.json).
//   - the boats, zeppelins and tram: every sighting the addon has taken (your own rides, and
//     what other players' addons passed on), which it keeps for this in the game's saved
//     settings (<game>/WTF/Account/*/SavedVariables/AzerothAtlas.lua; see boats.js). Read only.
//
// Sent: facts about the game world and nothing else. Not your account, your characters, your
// realm, your computer's name. A sighting of an NPC goes as "this NPC stands here"; where you
// stood and when you saw it stay on your disk. A sighting of a boat goes as "a craft of this
// line left this stop at this moment, by this way" (a ride, or which addon passed it on), with
// no names, yours or anybody's: the moment is the whole of what it says, so it has to go, and
// of a ride of your own it does say that this copy's player was aboard then. What is sent is
// filed under a made-up name this copy is signed in under (signin.js), which says nothing
// about you.
import fs from 'node:fs';
import path from 'node:path';
import { flavourFolder } from '../extractor/config.js';
import { fromCache, hashOf } from './records.js';
import { SERVER_TIME } from './rtdb.js';
import { sightingsIn, pack, unpack } from './boats.js';

const BATCH = 400 * 1024; // bytes of facts to one delivery
const BOATS_AGE = 45 * 86400; // seconds: a boat sighting older than this is not sent (what was sent is remembered a little longer)
const BOATS_BATCH = 300;      // boat sightings to one delivery
const CACHE = { 'creaturecache.wdb': 'npc', 'gameobjectcache.wdb': 'object', 'questcache.wdb': 'quest' };

/** Whatever the game's own language, the names kept are the English ones: a cache in another language gives its facts without its words. */
const wordless = (kind, rec) => {
  const { n, sub, ...rest } = rec;
  return rest;
};

/**
 * Read everything there is to send.
 * @returns { build, npc: Map<id, fields>, object: Map, quest: Map, seen: [[kind letter, id, map, x, y, z]], boats: [a sighting as it is sent], notes: string[] }
 */
export async function gather(cfg, dataDir) {
  const found = { build: 0, npc: new Map(), object: new Map(), quest: new Map(), seen: [], boats: [], notes: [] };
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
      // (what a fight settled stays on this disk: a sighting sent is "this NPC stands here", from someone who stood beside them and talked)
      if (s.fight) continue;
      found.seen.push([s.object ? 'o' : 'n', s.id, s.map, r2(s.x), r2(s.y), r2(s.z)]);
    }
  } catch { /* nothing seen yet */ }
  // the boats: what the addon has kept for sending, in every account's saved settings
  try {
    const accounts = path.join(cfg.installRoot, folder, 'WTF', 'Account');
    const all = new Set();
    for (const account of fs.readdirSync(accounts)) {
      let text;
      try { text = fs.readFileSync(path.join(accounts, account, 'SavedVariables', 'AzerothAtlas.lua'), 'utf8'); } catch { continue; }
      for (const x of sightingsIn(text)) all.add(pack(x));
    }
    found.boats = [...all];
  } catch { /* no saved settings yet */ }
  return found;
}

/**
 * Send what has not been sent before.
 * @param db     Rtdb
 * @param store  LocalStore
 * @param copy   the name this copy is signed in under (none: a database open to all, and its made-up name)
 * @param dry    true: say what would be sent, send nothing
 * @returns { sent: { npc, object, quest, seen, boats }, deliveries, bytes, boatsError (the boats could not be sent: why) }
 */
export async function share(db, store, found, { app = '', dry = false, copy = null } = {}) {
  const install = copy ?? store.install();
  const sent = store.read('sent.json', {});
  const fresh = { npc: {}, object: {}, quest: {}, seen: [] }, marks = {};
  const count = { npc: 0, object: 0, quest: 0, seen: 0, boats: 0 };
  // The boats: each sighting once. They go to a place of their own in the database, where a
  // function takes them in every ten minutes (functions/boats.js).
  const boatsSent = store.read('boats-sent.json', {}), today = Date.now() / 1000;
  const boats = (found.boats ?? []).filter((s) => { const x = unpack(s); return x && today - x.t < BOATS_AGE && !boatsSent[s]; });
  count.boats = boats.length;
  let boatsError;
  const sendBoats = async () => {
    if (dry || !boats.length) return;
    // (a database that does not take them yet - its rules are older than this - is no reason not to send the rest)
    try {
      for (let i = 0; i < boats.length; i += BOATS_BATCH) await db.post(`boats/seen/${install}`, { v: 1, app, at: SERVER_TIME, s: boats.slice(i, i + BOATS_BATCH) });
      const keep = {};
      for (const [s, t] of Object.entries(boatsSent)) if (today - t < BOATS_AGE + 5 * 86400) keep[s] = t;
      for (const s of boats) keep[s] = unpack(s).t;
      store.write('boats-sent.json', keep);
    } catch (err) { boatsError = err?.message ?? String(err); count.boats = 0; }
  };
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
  await sendBoats();
  if (dry || !batches.length) return { sent: count, deliveries: batches.length, bytes, dry, boatsError };
  for (const b of batches) await db.post(`inbox/${install}`, b);
  await db.patch(`installs/${install}`, { last: SERVER_TIME, app, build: found.build });
  store.write('sent.json', { ...sent, ...marks });
  return { sent: count, deliveries: batches.length, bytes, dry: false, boatsError };
}

/**
 * Fetch each boat line's place on the server's clock as the database has measured it from
 * everybody's sightings (/transit: see boats.js), into <dataDir>/atlasdb/transit.json. The map
 * and the addon go by it where it is newer than their own figures.
 * @returns { lines (how many are measured), changed } - or null where the database has none yet
 */
export async function fetchBoats(db, store) {
  const got = await db.get('transit');
  if (!got || typeof got !== 'object' || got.v !== 1 || typeof got.lines !== 'object') return null;
  const was = store.read('transit.json', null);
  const changed = JSON.stringify(was?.lines ?? null) !== JSON.stringify(got.lines);
  if (changed) store.write('transit.json', { v: 1, count: got.count ?? null, at: got.at ?? null, lines: got.lines });
  return { lines: Object.keys(got.lines).length, changed };
}
