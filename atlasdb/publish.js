// Putting the Atlas database together, publishing it, and fetching it.
//
// In the database:
//
//   /meta                      what is published: its number (rev), when, how many of each kind,
//                              what it was made from, and a fingerprint of every shard
//   /truth/<kind>/b<n>/i<id>   the records (records.js): kind is npc, object or quest; a shard
//                              holds the ids n to n+499
//   /inbox/<copy>/<key>        what each copy of the map has sent (collect.js): added to, never
//                              changed. Everything published can be made again from these and
//                              the sources on the maker's own disk.
//   /installs/<copy>           when a copy last sent something, and which version it runs
//
// Making it (buildTruth) reads QuestieDB and the reference database from the maker's own disk
// and every delivery in the inbox, and merges them record by record. Publishing writes only the
// shards whose records changed. A copy that fetches it (pull) asks for the fingerprints first
// and fetches only what differs from what it has.
import fs from 'node:fs';
import path from 'node:path';
import { findQuestieDb, readQuestie } from '../extractor/questie.js';
import { readReference } from '../extractor/reference.js';
import { KINDS, SCHEMA, LAYERS, fromQuestie, fromReference, mergeAll, shards, hashOf, tidy } from './records.js';
import { entries, SERVER_TIME } from './rtdb.js';

const SAME = 30;            // yards: sightings of one NPC this close together are the same spot
const REQUEST = 3 << 20;    // bytes of records to one request
const WHOLE = 40;           // shards wanted of one kind beyond which the whole kind is fetched at once

/**
 * Sources the maker of the database keeps on their own disk besides QuestieDB and the reference
 * database: each a file <dataDir>/atlasdb/layers/<name>.json, written by a tool of the maker's
 * own, already in the shape of the records (records.js):
 *
 *   { "v": 1, "code": "w", "name": "wowhead", "made": "2026-11-15T20:00:00Z",
 *     "npc": { "<id>": { fields } }, "object": { ... }, "quest": { ... } }
 *
 * `code` is the letter the source is known by in a record, and settles how far it is believed.
 * @returns [{ code, name, made, npc: Map, object: Map, quest: Map }]
 */
export function readLayers(dataDir, log = () => {}) {
  const dir = path.join(dataDir, 'atlasdb', 'layers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (d?.v !== 1 || !LAYERS.includes(d.code)) { log(`layers/${name}: not a source this version knows (v ${d?.v}, code "${d?.code}"): left out`); continue; }
      const layer = { code: d.code, name: typeof d.name === 'string' && d.name ? d.name : name.replace(/\.json$/i, ''), made: d.made ?? null, npc: new Map(), object: new Map(), quest: new Map() };
      for (const kind of KINDS) {
        for (const [key, rec] of Object.entries(d[kind] ?? {})) {
          const id = Number(String(key).replace(/^i/, ''));
          if (!Number.isInteger(id) || id <= 0 || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
          const fields = tidy(rec);
          if (Object.keys(fields).length) layer[kind].set(id, fields);
        }
      }
      out.push(layer);
    } catch (err) { log(`layers/${name}: not read (${err.message})`); }
  }
  return out;
}

/**
 * What the copies have sent, put together: per kind the facts of the game's cache (the newest
 * game build's, and among those what most copies say), the sightings, and who reported what.
 * @param inbox what GET /inbox returned
 */
export function fold(inbox) {
  const reports = { npc: new Map(), object: new Map(), quest: new Map() }; // id -> Map<copy, { build, rec }>
  const spots = new Map(); // "n123:m0" -> [{ x, y, z, copies: Set }]
  let deliveries = 0;
  const copies = entries(inbox);
  for (const [copy, list] of copies) {
    for (const [, b] of entries(list)) {
      if (!b || b.v !== 1) continue;
      deliveries++;
      const build = Number(b.build) || 0;
      for (const kind of KINDS) {
        for (const [key, rec] of entries(b[kind])) {
          const id = Number(String(key).replace(/^i/, ''));
          if (!Number.isInteger(id) || id <= 0 || !rec || typeof rec !== 'object') continue;
          let per = reports[kind].get(id);
          if (!per) reports[kind].set(id, (per = new Map()));
          const had = per.get(copy);
          if (!had || had.build <= build) per.set(copy, { build, rec });
        }
      }
      for (const [, line] of entries(b.seen)) {
        const p = String(line).split(',');
        const k = p[0], id = +p[1], map = +p[2], x = +p[3], y = +p[4], z = +p[5];
        if ((k !== 'n' && k !== 'o') || !Number.isInteger(id) || !Number.isInteger(map) || ![x, y, z].every(Number.isFinite)) continue;
        const key = `${k}${id}:m${map}`;
        let list2 = spots.get(key);
        if (!list2) spots.set(key, (list2 = []));
        const near = list2.find((s) => Math.hypot(s.x - x, s.y - y) < SAME);
        if (near) {
          // (one copy's newest word on a spot replaces its older one; several copies are averaged)
          near.by.set(copy, [x, y, z]);
          const all = [...near.by.values()];
          near.x = all.reduce((a, v) => a + v[0], 0) / all.length; near.y = all.reduce((a, v) => a + v[1], 0) / all.length; near.z = all.reduce((a, v) => a + v[2], 0) / all.length;
        } else list2.push({ x, y, z, by: new Map([[copy, [x, y, z]]]) });
      }
    }
  }
  const cache = { npc: new Map(), object: new Map(), quest: new Map() }, obs = { npc: new Map(), object: new Map(), quest: new Map() };
  for (const kind of KINDS) {
    for (const [id, per] of reports[kind]) {
      const newest = Math.max(...[...per.values()].map((r) => r.build));
      const votes = new Map(); // fingerprint -> { rec, n }
      for (const r of per.values()) { if (r.build !== newest) continue; const h = hashOf(r.rec); const v = votes.get(h) ?? { rec: r.rec, n: 0 }; v.n++; votes.set(h, v); }
      const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
      cache[kind].set(id, best.rec);
      obs[kind].set(id, { g: [per.size, newest] });
    }
  }
  const seen = { npc: new Map(), object: new Map() };
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const [key, list] of spots) {
    const m = /^([no])(\d+):(m-?\d+)$/.exec(key);
    const kind = m[1] === 'n' ? 'npc' : 'object', id = +m[2];
    const rec = seen[kind].get(id) ?? { seen: {} };
    rec.seen[m[3]] = list.map((s) => [r2(s.x), r2(s.y), r2(s.z), s.by.size].join(',')).join(' ');
    seen[kind].set(id, rec);
    const o = obs[kind].get(id) ?? {};
    o.s = [Math.max(o.s?.[0] ?? 0, ...list.map((s) => s.by.size))];
    obs[kind].set(id, o);
  }
  return { cache, seen, obs, copies: copies.length, deliveries };
}

/**
 * The whole database, made from the sources on this disk and what the copies have sent.
 * @returns { records: { npc: Map, object: Map, quest: Map }, from: {...} }
 */
export async function buildTruth(cfg, dataDir, inbox, log = () => {}) {
  const sources = { npc: [], object: [], quest: [] }, from = {};
  const got = fold(inbox);
  const toc = findQuestieDb(cfg);
  // (QuestieDB is what says which creatures and quests this game has at all: without it the
  // reference database's whole original game would be taken for this one)
  if (!toc) throw new Error('QuestieDB is not installed in the game on this computer: the database is made on a computer that has it');
  let known = null;
  {
    const qdb = readQuestie(toc);
    let extras = null;
    try { const { readQuestieExtras } = await import('../extractor/questie-extras.js'); extras = readQuestieExtras(toc); } catch (err) { log(`QuestieDB's measured figures were not read (${err.message})`); }
    const q = fromQuestie(qdb, extras);
    sources.npc.push(['q', q.npc]); sources.object.push(['q', q.object]); sources.quest.push(['q', q.quest], ['x', q.measured]);
    from.questie = qdb.version ?? '?';
    from.measured = q.measured.size;
    known = { npc: new Set(q.npc.keys()), object: new Set(q.object.keys()), quest: new Set(q.quest.keys()) };
    log(`QuestieDB ${from.questie}: ${q.npc.size.toLocaleString()} creatures, ${q.object.size.toLocaleString()} objects, ${q.quest.size.toLocaleString()} quests (${q.measured.size.toLocaleString()} with experience measured in this game)`);
  }
  // the maker's own further sources (they, too, say what this game has)
  for (const layer of readLayers(dataDir, log)) {
    for (const kind of KINDS) { sources[kind].push([layer.code, layer[kind]]); for (const id of layer[kind].keys()) known[kind].add(id); }
    (from.layers ??= {})[layer.name] = layer.made ?? '?';
    log(`${layer.name} (as of ${layer.made ?? '?'}): ${layer.npc.size.toLocaleString()} creatures, ${layer.object.size.toLocaleString()} objects, ${layer.quest.size.toLocaleString()} quests`);
  }
  // the reference database, as the map update fetched it
  try {
    const dir = path.join(dataDir, 'sources', 'classic-db');
    const name = fs.readdirSync(dir).find((f) => /\.sql(\.gz)?$/i.test(f));
    if (name) {
      // (it is about the original game: only what this game is known to have is taken from it, plus what a player's game has met)
      const ref = readReference(path.join(dir, name));
      const all = { npc: new Set([...known.npc, ...got.cache.npc.keys()]), object: new Set([...known.object, ...got.cache.object.keys()]), quest: new Set([...known.quest, ...got.cache.quest.keys()]) };
      const c = fromReference(ref, all);
      sources.npc.push(['c', c.npc]); sources.object.push(['c', c.object]); sources.quest.push(['c', c.quest]);
      from.reference = name;
      log(`${name}: ${c.npc.size.toLocaleString()} creatures, ${c.object.size.toLocaleString()} objects, ${c.quest.size.toLocaleString()} quests of this game known to it`);
    } else log('no reference database on this disk (Update map fetches it)');
  } catch (err) { log(`reference database not read (${err.message})`); }
  for (const kind of KINDS) {
    sources[kind].push(['g', got.cache[kind]]);
    if (got.seen[kind]) sources[kind].push(['s', got.seen[kind]]);
  }
  from.copies = got.copies; from.deliveries = got.deliveries;
  log(`${got.copies} ${got.copies === 1 ? 'copy has' : 'copies have'} sent ${got.deliveries} ${got.deliveries === 1 ? 'delivery' : 'deliveries'}: ${got.cache.npc.size.toLocaleString()} creatures, ${got.cache.object.size.toLocaleString()} objects and ${got.cache.quest.size.toLocaleString()} quests from the game's cache, sightings of ${(got.seen.npc.size + got.seen.object.size).toLocaleString()}`);
  const records = {};
  for (const kind of KINDS) records[kind] = mergeAll(kind, sources[kind], got.obs[kind]);
  return { records, from };
}

/**
 * Write what has changed. @returns { rev, changed, removed, bytes, same: true when nothing differed }
 */
export async function publish(db, truth, { dry = false, log = () => {} } = {}) {
  const meta = (await db.get('meta')) ?? {};
  const next = { schema: SCHEMA, rev: (meta.rev ?? 0) + 1, at: SERVER_TIME, counts: {}, from: truth.from, shards: {} };
  let changed = 0, removed = 0, bytes = 0;
  for (const kind of KINDS) {
    const { shards: parts, hashes } = shards(truth.records[kind]);
    next.counts[kind] = truth.records[kind].size;
    next.shards[kind] = {};
    const old = Object.fromEntries(entries(meta.shards?.[kind]));
    let request = {}, size = 0;
    const flush = async () => {
      if (!Object.keys(request).length) return;
      if (!dry) await db.patch(`truth/${kind}`, request);
      request = {}; size = 0;
    };
    for (const [b, part] of parts) {
      const key = 'b' + b, hash = hashes.get(b);
      next.shards[kind][key] = hash;
      if (old[key] === hash) continue;
      const len = JSON.stringify(part).length;
      if (size && size + len > REQUEST) await flush();
      request[key] = part; size += len; bytes += len; changed++;
    }
    for (const key of Object.keys(old)) if (!(key in next.shards[kind])) { request[key] = null; removed++; }
    await flush();
    log(`${kind}: ${truth.records[kind].size.toLocaleString()} records in ${parts.size} shards`);
  }
  const same = !changed && !removed && meta.schema === SCHEMA;
  if (!dry && !same) await db.put('meta', next);
  return { rev: same ? meta.rev ?? 0 : next.rev, changed, removed, bytes, same, dry };
}

/**
 * Fetch what differs from what this copy has. The records land in the local store, one file per kind.
 * @returns { rev, fetched, counts } or null when nothing is published
 */
export async function pull(db, store, log = () => {}) {
  const meta = await db.get('meta');
  if (!meta?.shards) return null;
  const mine = store.read('truth-meta.json', {});
  let fetched = 0;
  const counts = {};
  for (const kind of KINDS) {
    const want = Object.fromEntries(entries(meta.shards[kind]));
    const have = mine.schema === meta.schema ? mine.shards?.[kind] ?? {} : {};
    const local = store.read(`truth-${kind}.json`, {});
    for (const key of Object.keys(local)) if (!(key in want)) delete local[key];
    const need = Object.keys(want).filter((key) => !(have[key] === want[key] && local[key]));
    if (need.length > WHOLE) {
      // most of it: the whole kind in one request (far quicker than hundreds of small ones)
      const all = Object.fromEntries(entries(await db.get(`truth/${kind}`)));
      for (const key of need) local[key] = Object.fromEntries(entries(all[key]));
    } else {
      // a few shards: several at a time
      let next = 0;
      const one = async () => { while (next < need.length) { const key = need[next++]; local[key] = Object.fromEntries(entries(await db.get(`truth/${kind}/${key}`))); } };
      await Promise.all(Array.from({ length: Math.min(6, need.length) }, one));
    }
    fetched += need.length;
    counts[kind] = Object.values(local).reduce((a, p) => a + Object.keys(p).length, 0);
    store.write(`truth-${kind}.json`, local);
  }
  store.write('truth-meta.json', { schema: meta.schema, rev: meta.rev, at: meta.at, counts: meta.counts, from: meta.from, shards: Object.fromEntries(KINDS.map((k) => [k, Object.fromEntries(entries(meta.shards[k]))])) });
  log(`database ${meta.rev}: ${fetched} shards fetched`);
  return { rev: meta.rev, fetched, counts };
}

/** One record as the local copy has it, or null. */
export function lookup(store, kind, id) {
  const local = store.read(`truth-${kind}.json`, {});
  return local['b' + Math.floor(id / 500) * 500]?.['i' + id] ?? null;
}
