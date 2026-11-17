#!/usr/bin/env node
// The Atlas database by hand. The map does the first of these by itself while it runs.
//
//   node atlasdb/cli.js collect            send what this copy has learned (the game's cache, what you have seen)
//   node atlasdb/cli.js publish            make the database again from every source and everything sent, and publish what changed
//                                          (only a copy the database lists as a maintainer may)
//   node atlasdb/cli.js pull               fetch the database as published
//   node atlasdb/cli.js questie            fetch QuestieDB as the database has it (what the map's creatures, NPCs and quests are
//                                          built from: a scheduled function puts every new version there), if this disk has another
//   node atlasdb/cli.js show npc 263380    one record (as published; --local: as last fetched)
//   node atlasdb/cli.js status             what is published, and what this copy has sent
//   node atlasdb/cli.js whoami             the name this copy is signed in under
//   node atlasdb/cli.js votes              where the copies' game caches disagree, and how each vote went
//                                          (votes quest 95534: one thing; for the maintainers: it reads what was sent)
//   node atlasdb/cli.js auto               what the map does by itself: collect (unless "share" is off), questie, publish
//                                          (where "maintain" is on), pull
//
//   --dry                 collect / publish: say what would be sent, send nothing
//   --json                publish / pull / auto: the outcome as one line of JSON (the last line written)
//   --only=seen|cache     collect: only what you have seen for yourself, or only the game's cache
//   --url=https://...     the database (else "database": { "url": ... } in config.json, else the one this version names)
//   --key=...             the key to sign in to it with (else as for --url; none: the database is open to all)
//   --config=path         another config.json
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CONFIG_FILE, PROJECT_ROOT } from '../extractor/config.js';
import { Rtdb, entries } from './rtdb.js';
import { LocalStore } from './local.js';
import { gather, share, fetchBoats } from './collect.js';
import { buildTruth, publish, pull, lookup, fold } from './publish.js';
import { databaseSettings } from './settings.js';
import { signIn } from './signin.js';
import { pullQuestie, fetchedSource } from './questiedb.js';
import { SUPPORTED_CONTRACTS } from '../extractor/questie.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const words = args.filter((a) => !a.startsWith('--'));
const cfg = loadConfig(value('config') ? path.resolve(value('config')) : CONFIG_FILE);
const settings = databaseSettings(cfg);
const url = value('url') ?? settings.url;
const json = flag('json');
if (!url) {
  if (json) console.log(JSON.stringify({ off: true }));
  else console.error('No database: give --url=..., or set "database": { "url": "..." } in config.json');
  process.exit(json ? 0 : 2);
}
const store = new LocalStore(cfg.dataDir);
const log = json ? () => {} : (msg) => console.log(msg);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
/** The end of a run that could not be done: said as the caller reads it. */
const fail = (message, code = 1) => {
  if (json) console.log(JSON.stringify({ errors: [message] }));
  else console.error(message);
  process.exitCode = json ? 0 : code;
};
// (Nothing here ends the program by force once a request has gone out: on Windows that can trip
// an assertion inside node while its connections close. The exit code is set, and it runs out.)

// Who this copy is to the database (a database open to all asks nobody: --url without a key).
const apiKey = value('key') ?? (value('url') ? null : settings.apiKey);
let me = null, signedOut = false;
if (apiKey) {
  try { me = await signIn(apiKey, store); } catch (err) { fail(err.message); signedOut = true; }
}
const db = new Rtdb(url, { auth: me?.token ?? null });
// (QuestieDB's data file comes as a few pieces of four megabytes: each is given longer than a small read gets)
const slow = new Rtdb(url, { auth: me?.token ?? null, timeoutMs: 180000 });
const copy = me?.uid ?? null;
const app = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
/** What the database said no to, in words that say what to do about it. */
const said = (err) => (err.status === 401 || err.status === 403 ? `the database does not allow this copy to do that (${err.server || `HTTP ${err.status}`})` : err.message);

const command = words[0] ?? 'status';
try {
  if (signedOut) {
    // (said above: nothing can be done without signing in)
  } else if (command === 'collect') {
    const found = await gather(cfg, cfg.dataDir);
    for (const n of found.notes) log(n);
    if (value('only') === 'seen') { found.npc.clear(); found.object.clear(); found.quest.clear(); }
    if (value('only') === 'cache') found.seen.length = 0;
    log(`found: ${found.npc.size} creatures, ${found.object.size} objects and ${found.quest.size} quests in the game's cache (game build ${found.build || '?'}), ${found.seen.length} sightings, ${found.boats.length} sightings of boats, zeppelins and the tram`);
    const r = await share(db, store, found, { app, dry: flag('dry'), copy });
    log(`${r.dry ? 'would send' : 'sent'}: ${r.sent.npc} creatures, ${r.sent.object} objects, ${r.sent.quest} quests, ${r.sent.seen} sightings in ${r.deliveries} ${r.deliveries === 1 ? 'delivery' : 'deliveries'} (${kb(r.bytes)}), ${r.sent.boats} sightings of boats; the rest was sent before`);
    if (r.boatsError) log(`the boats could not be sent: ${r.boatsError}`);
    if (json) console.log(JSON.stringify({ collect: r }));
  } else if (command === 'publish') {
    const truth = await buildTruth(cfg, cfg.dataDir, await db.get('inbox'), log);
    const r = await publish(db, truth, { dry: flag('dry'), log });
    log(r.same ? `nothing has changed: the database stays at ${r.rev}` : `${r.dry ? 'would publish' : 'published'} database ${r.rev}: ${r.changed} shards written (${kb(r.bytes)}), ${r.removed} removed`);
    if (json) console.log(JSON.stringify({ publish: { ...r, counts: Object.fromEntries(Object.entries(truth.records).map(([k, m]) => [k, m.size])), from: truth.from } }));
  } else if (command === 'pull') {
    const r = await pull(db, store, log);
    log(r ? `have database ${r.rev}: ${Object.entries(r.counts).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(', ')}` : 'nothing is published yet');
    if (json) console.log(JSON.stringify({ pull: r }));
  } else if (command === 'questie') {
    const r = await pullQuestie(slow, cfg.dataDir, { log });
    log(!r ? 'the database holds no QuestieDB yet' : r.skipped ? `QuestieDB ${r.version} was not taken: ${r.skipped}` : r.same ? `this disk has QuestieDB ${r.version}, the one the database holds` : `fetched QuestieDB ${r.version} (${kb(r.bytes)})`);
    if (json) console.log(JSON.stringify({ questie: r }));
  } else if (command === 'show') {
    const kind = words[1], id = Number(words[2]);
    if (!['npc', 'object', 'quest'].includes(kind) || !Number.isInteger(id)) fail('show npc|object|quest <id>', 2);
    else {
      const rec = flag('local') ? lookup(store, kind, id) : await db.get(`truth/${kind}/b${Math.floor(id / 500) * 500}/i${id}`);
      console.log(rec ? JSON.stringify(rec, null, 1) : 'not in the database');
    }
  } else if (command === 'status') {
    const meta = await db.get('meta');
    if (!meta) log('nothing is published yet');
    else log(`database ${meta.rev}, published ${new Date(meta.at).toISOString()}: ${Object.entries(meta.counts ?? {}).map(([k, n]) => `${Number(n).toLocaleString()} ${k}`).join(', ')}\nmade from: ${JSON.stringify(meta.from ?? {})}`);
    // (who has sent is for the maintainers to see)
    try {
      const installs = entries(await db.get('installs'));
      log(`${installs.length} ${installs.length === 1 ? 'copy has' : 'copies have'} sent something`);
    } catch (err) { if (err.status !== 401 && err.status !== 403) throw err; }
    const mine = store.read('truth-meta.json');
    log(mine ? `this copy has database ${mine.rev}` : 'this copy has not fetched the database');
    // QuestieDB as the scheduled function last put it in, and when it last looked for a newer one
    try {
      const q = await db.get('questie/meta'), looked = await db.get('questie/check'), own = fetchedSource(cfg.dataDir);
      const when = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?');
      const readable = q && q.v === 1 && q.mode === 'baked' && SUPPORTED_CONTRACTS.has(String(q.contract));
      log(q ? `QuestieDB ${q.version} in the database${readable ? '' : ', laid out in a way this version of the map cannot read'} (taken in ${when(q.at)}; ${looked ? `last looked for a newer one ${when(looked.at)}${looked.error ? `, which failed: ${looked.error}` : ''}` : 'not looked for since'}); this copy has ${own ? own.version : 'none fetched'}` : 'the database holds no QuestieDB yet');
    } catch (err) { if (err.status !== 401 && err.status !== 403) throw err; log('the database holds no QuestieDB that this copy may read'); }
    log(`this copy is known to the database as ${copy ?? store.install()} and has sent ${Object.keys(store.read('sent.json', {})).length} facts`);
  } else if (command === 'whoami') {
    console.log(copy ?? `${store.install()} (the database is open to all: nobody is signed in)`);
  } else if (command === 'votes') {
    const kind = words[1], id = Number(words[2]);
    const got = fold(await db.get('inbox'));
    const list = got.splits.filter((s) => (!kind || s.kind === kind) && (!words[2] || s.id === id));
    const short = (v) => { const t = v === null ? 'nothing' : JSON.stringify(v); return t.length > 70 ? t.slice(0, 67) + '...' : t; };
    if (json) console.log(JSON.stringify({ votes: list }));
    else {
      for (const s of list) console.log(`${s.kind} ${s.id} ${s.field}: ${s.said.map((x) => `${x.won ? 'believed ' : ''}${short(x.value)} (${x.copies.length}: ${x.copies.map((c) => c.slice(0, 6)).join(' ')})`).join('  |  ')}`);
      console.log(`${got.copies} ${got.copies === 1 ? 'copy has' : 'copies have'} sent the game's cache of ${(got.cache.npc.size + got.cache.object.size + got.cache.quest.size).toLocaleString()} things; they disagree about ${list.length.toLocaleString()} ${list.length === 1 ? 'fact' : 'facts'}${kind ? ' of those asked for' : ''}`);
    }
  } else if (command === 'auto') {
    // each step on its own: one that fails does not stop the next
    const out = { errors: [] };
    const step = async (name, fn) => { try { out[name] = await fn(); } catch (err) { out.errors.push(`${name}: ${said(err)}`); } };
    if (settings.share) await step('collect', async () => { const found = await gather(cfg, cfg.dataDir); const r = await share(db, store, found, { app, copy }); return { ...r, notes: found.notes }; });
    // (before the database is made again, where this copy makes it: from the newest QuestieDB there is)
    await step('questie', async () => pullQuestie(slow, cfg.dataDir, { log }));
    if (settings.maintain) await step('publish', async () => publish(db, await buildTruth(cfg, cfg.dataDir, await db.get('inbox'), log), { log }));
    await step('pull', async () => pull(db, store, log));
    // (where each boat line stands on the server's clock, as measured from everybody's sightings)
    await step('boats', async () => fetchBoats(db, store));
    console.log(json ? JSON.stringify(out) : JSON.stringify(out, null, 1));
  } else {
    fail(`unknown command "${command}": collect, publish, pull, show, status, whoami, votes, auto`, 2);
  }
} catch (err) {
  fail(said(err));
}
