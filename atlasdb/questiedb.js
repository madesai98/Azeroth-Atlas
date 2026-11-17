// QuestieDB as the Atlas database has it, fetched to this disk.
//
// The map is built from QuestieDB: who stands where, the spawn zones, the quests. A scheduled
// function in the cloud (functions/questie.js) puts every new version of QuestieDB into the
// database, under /questie, as the files QuestieDB itself publishes. This fetches them, so that
// nobody has to have the QuestieDB addon in their game, or keep it up to date, for the map's
// sake. (In the game itself, the addons that use QuestieDB - Questie, guide packs - still need
// it there: the game loads only what is in its own folder.)
//
// On this disk, in <dataDir>/sources/questiedb:
//
//   source.json                 which version is in use: { folder, before (the folder of the
//                               version before it, kept until the next), tag, version, contract,
//                               sha256, commit, from, fetched, files: { path: fingerprint } }
//   <version>-<8 letters>/QuestieDB/…
//                               the files, where the addon has them in its own folder (the data
//                               file, support/Forever/…, the licence), so that what reads the
//                               addon reads this just the same (extractor/questie.js)
//
// A new version is written into a folder of its own, checked (every file against the
// fingerprint the database gives for it, and the data file by reading it), and only then named
// in source.json: a copy half fetched, or one this version of the map cannot read, is never
// used. Files that did not change from one version to the next are not fetched again.
//
// Nothing about you or your computer is sent: these are plain reads of the database.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeFileAtomic } from '../extractor/container.js';
import { SUPPORTED_CONTRACTS, TOC_NAME, fetchedQuestieDir, readQuestie } from '../extractor/questie.js';
import { Rtdb, entries } from './rtdb.js';
import { LocalStore } from './local.js';
import { databaseSettings } from './settings.js';
import { signIn } from './signin.js';

const V = 1;                 // the layout of /questie this version reads
const MOST_FILES = 300;      // more than this is not QuestieDB
const LARGEST = 96 << 20;    // bytes: no file of it is anywhere near
const MOST_PARTS = 64;
/** A path as it may be written under the folder: plain names with / between them, none beginning with a dot (so none leads out of it). */
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

/** What is in use on this disk: source.json as written, or null. */
export function fetchedSource(dataDir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(fetchedQuestieDir(dataDir), 'source.json'), 'utf8')); return s && typeof s === 'object' && typeof s.folder === 'string' ? s : null; } catch { return null; }
}

/** The files /questie/meta lists, each looked over: [{ path, size, sha1, parts }]. Throws where the list is not what it should be. */
function listed(meta) {
  const out = [], seen = new Set();
  for (const [, f] of entries(meta.files)) {
    const ok = f && typeof f.path === 'string' && f.path.length <= 200 && PLAIN.test(f.path) && !seen.has(f.path.toLowerCase())
      && Number.isInteger(f.size) && f.size >= 0 && f.size <= LARGEST && /^[0-9a-f]{40}$/.test(f.sha1 ?? '') && Number.isInteger(f.parts) && f.parts >= 1 && f.parts <= MOST_PARTS;
    if (!ok) throw new Error(`the database's list of QuestieDB's files is not as it should be (${String(f?.path ?? '?').slice(0, 80)})`);
    seen.add(f.path.toLowerCase());
    out.push({ path: f.path, size: f.size, sha1: f.sha1, parts: f.parts });
  }
  if (!out.length || out.length > MOST_FILES || !out.some((f) => f.path === TOC_NAME)) throw new Error('the database\'s list of QuestieDB\'s files is not as it should be');
  return out;
}

/** One file from the database: its pieces put together, unpacked, and held against its fingerprint. */
async function fetchFile(db, f) {
  let text = '';
  for (let i = 0; i < f.parts; i++) {
    const piece = await db.get(`questie/data/${f.sha1}/p${i}`);
    if (typeof piece !== 'string' || !piece) throw new Error(`${f.path}: piece ${i + 1} of ${f.parts} is not in the database (a newer version is being put in: it will be there the next time)`);
    text += piece;
  }
  let data;
  try { data = zlib.gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: LARGEST }); } catch (err) { throw new Error(`${f.path}: could not be unpacked (${err.message})`); }
  if (data.length !== f.size || sha1(data) !== f.sha1) throw new Error(`${f.path}: not what the database says it is (damaged on the way?)`);
  return data;
}

/**
 * Folders of versions no longer wanted, removed. The version in use stays, and the one before
 * it: a map update that began before the newer one came in may still be reading that (the
 * support files are read some way into the update), and is not to find them gone.
 */
function tidy(dir, keep) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    if (!e.isDirectory() || keep.includes(e.name)) continue;
    try { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); } catch { /* in use */ }
  }
}

/**
 * Fetch QuestieDB from the database if it has another version than this disk.
 * @returns null: the database holds none. Else { version, tag, same: true } (this disk has it),
 *   { version, tag, fetched: files fetched, kept: files that had not changed, bytes: fetched, off the wire },
 *   or { version, tag, skipped: why it was left where it is }.
 */
export async function pullQuestie(db, dataDir, { log = () => {} } = {}) {
  let meta = null;
  try { meta = await db.get('questie/meta'); } catch (err) {
    // (a database whose rules do not open /questie to its copies has none for them: one of your own, or this one before it had any)
    if (err.status !== 401 && err.status !== 403) throw err;
    log('the database holds no QuestieDB that this copy may read');
  }
  if (!meta || typeof meta !== 'object' || !meta.files) return null;
  const version = String(meta.version ?? '?'), tag = String(meta.tag ?? '');
  if (meta.v !== V) return { version, tag, skipped: 'it is kept in the database in a way this version of the map does not know: a newer version of the map will' };
  if (meta.mode !== 'baked' || !SUPPORTED_CONTRACTS.has(String(meta.contract))) return { version, tag, skipped: `QuestieDB ${version} is laid out in a way this version of the map cannot read yet (${meta.mode}, contract ${meta.contract})` };
  const want = listed(meta);
  const dir = fetchedQuestieDir(dataDir);
  const have = fetchedSource(dataDir);
  const root = (folder) => path.join(dir, folder, 'QuestieDB');
  const intact = (folder, f) => { try { return fs.statSync(path.join(root(folder), f.path)).size === f.size; } catch { return false; } };
  if (have && have.sha256 === meta.sha256 && want.every((f) => have.files?.[f.path] === f.sha1 && intact(have.folder, f)) && Object.keys(have.files ?? {}).length === want.length) {
    tidy(dir, [have.folder, have.before]);
    return { version, tag, same: true };
  }
  // into a folder of its own, named after the version and what the release was
  const folder = `${version.replace(/[^\w.-]/g, '_').slice(0, 40) || 'v'}-${String(meta.sha256 ?? sha1(JSON.stringify(want))).replace(/[^0-9a-f]/g, '').slice(0, 8) || 'x'}`;
  log(`fetching QuestieDB ${version} from the Atlas database`);
  let fetched = 0, kept = 0, bytes = 0;
  for (const f of want) {
    const to = path.join(root(folder), f.path);
    // (already there from a fetch that broke off, or unchanged since the version in use: not fetched again)
    const same = (file) => { try { const d = fs.readFileSync(file); return d.length === f.size && sha1(d) === f.sha1 ? d : null; } catch { return null; } };
    if (same(to)) { kept++; continue; }
    const old = have && have.folder !== folder && have.files?.[f.path] === f.sha1 ? same(path.join(root(have.folder), f.path)) : null;
    if (old) { writeFileAtomic(to, old); kept++; continue; }
    const data = await fetchFile(db, f);
    writeFileAtomic(to, data);
    fetched++; bytes += data.length;
  }
  // can it be read? (a data file that cannot would leave the map without its creatures and quests)
  const read = readQuestie(path.join(root(folder), TOC_NAME));
  if (!read.npcs.length || !read.quests.length) throw new Error(`QuestieDB ${version} as fetched holds no creatures or no quests: the copy in use is kept`);
  const before = have && have.folder !== folder ? have.folder : have?.before ?? null;
  writeFileAtomic(path.join(dir, 'source.json'), JSON.stringify({
    folder, before, tag, version, contract: meta.contract, sha256: meta.sha256 ?? null, commit: meta.commit ?? null, from: meta.from ?? null,
    fetched: new Date().toISOString(), files: Object.fromEntries(want.map((f) => [f.path, f.sha1])),
  }, null, 1));
  tidy(dir, [folder, before]);
  log(`QuestieDB ${version}: ${read.npcs.length.toLocaleString('en')} creatures, ${read.objects.length.toLocaleString('en')} objects, ${read.quests.length.toLocaleString('en')} quests (${fetched} files fetched, ${(bytes / 1048576).toFixed(1)} MB; ${kept} as they were)`);
  return { version, tag, fetched, kept, bytes };
}

/**
 * The same for whoever has no connection to the database open yet (the map update): signs in as
 * this copy and fetches. Nothing that goes wrong here is passed on: the copy fetched earlier, or
 * the addon in the game's folder, is used instead, and `log` is told why.
 * @returns what pullQuestie() returns, or null
 */
export async function fetchQuestie(cfg, log = () => {}) {
  const s = databaseSettings(cfg);
  if (!s.url) return null;
  try {
    const me = s.apiKey ? await signIn(s.apiKey, new LocalStore(cfg.dataDir)) : null;
    // (the data file is ten megabytes in three pieces: each is given longer than a small read gets)
    const r = await pullQuestie(new Rtdb(s.url, { auth: me?.token ?? null, timeoutMs: 180000 }), cfg.dataDir, { log });
    if (r?.skipped) log(`QuestieDB ${r.version} in the Atlas database was not taken: ${r.skipped}`);
    return r;
  } catch (err) {
    const have = fetchedSource(cfg.dataDir);
    log(`QuestieDB could not be fetched from the Atlas database (${err.message})${have ? `: using version ${have.version}, fetched earlier` : ''}`);
    return null;
  }
}
