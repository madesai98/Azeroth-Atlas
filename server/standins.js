// What other addons ask of QuestieDB, Questie and Auctionator, answered out of the map's own data.
//
// Plenty of addons lean on those three: a map addon asks Questie where the vendors stand, a
// profession planner asks Auctionator what an herb costs, a guide pack will not load without
// QuestieDB. The map has all of that itself - QuestieDB as published, the Atlas database laid
// over it, every auction house's prices, hour by hour. Whether it answers for each of the three
// is yours to say: the page has a box for each, and nothing is put in the game for a box that
// is not ticked (kept with what is yours: <dataDir>/user/standins.json). Nothing is worked out
// from the addons you happen to have.
//
// Ticked, what is done depends on whether you have the addon itself:
//
//   QuestieDB     none: put in as its makers publish it (fetched from where they publish it,
//                 checked against the fingerprint they give), and kept current from then on.
//                 Yours: left as it is, whatever its version. Either way the Atlas database is
//                 laid over it in the game, by a small addon of the map's own beside it
//                 (AzerothAtlas_Facts: facts.js), through QuestieDB's own way in for
//                 corrections. No file of QuestieDB's is changed.
//   Questie       none: a stand-in, in the folder Questie, answers the questions put to Questie
//                 out of QuestieDB (addon/standins/Questie.lua). Yours: not touched - it reads
//                 QuestieDB, so the Atlas database laid over that is what reaches it. Either
//                 way QuestieDB is needed, and is seen to as if its own box were ticked.
//   Auctionator   none: a stand-in, in the folder Auctionator, answers with the map's prices
//                 (addon/standins/Auctionator.lua; the prices themselves: prices.js). Yours: not
//                 touched - a small addon of the map's own beside it (AzerothAtlas_Prices, the
//                 same Lua) gives the map's price through Auctionator's own price questions
//                 wherever that is the fresher one. Its window, its scans and its lists are its
//                 own as before.
//
// So an addon of yours is never written over, moved or changed: the least that routes the map's
// data into it is nothing of its own at all. And a stand-in is in the folder the addon itself
// would be in, under its name, so that every addon that names it finds it.
//
// Unticked again, the stand-in is taken out, and whatever was laid beside your own addon. A
// QuestieDB the map put in is taken out too - unless a Questie of yours is there, or an addon
// that will not load without QuestieDB (its .toc says so): then it stays, and the page says
// for whom.
//
// What is the map's own is known by a mark: a stand-in's .toc says "## X-AzerothAtlas-StandIn",
// and a QuestieDB the map put in has a note beside it (AzerothAtlas-installed.json) with the
// fingerprint of its data file. A folder without the mark, or whose data file is another by
// now (an addon manager updated it), is yours, and is treated as yours. The addon itself
// unpacked over a stand-in is yours as well: what is left of the stand-in is cleared out of it.
//
// The game keeps, for each character, which addons are switched off (WTF/Account/<account>/
// <realm>/<character>/AddOns.txt), and goes on keeping it for an addon whose folder is gone: an
// addon you once switched off and removed is still switched off the day a folder of its name is
// back. A QuestieDB that is switched off answers nobody, and nothing that needs it loads. So
// how each of the three stands says which characters it is switched off for, and the page
// offers to switch it on there - asked, because it is your setting, and only while the game is
// closed (the game writes that file when it closes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from '../extractor/config.js';
import { writeFileAtomic } from '../extractor/container.js';
import { FLAVOUR, TOC_NAME, installedQuestieDb, laterVersion } from '../extractor/questie.js';
import { unzip } from './appupdate.js';
import { gameRunning } from './legacy.js';
import { addonsDir } from './addon.js';

const MAIN = 'AzerothAtlas';
const BUNDLED = path.join(PROJECT_ROOT, 'addon', 'standins');
const MARK = 'X-AzerothAtlas-StandIn';
export const FACTS = 'AzerothAtlas_Facts';
export const PRICES = 'AzerothAtlas_Prices';
/** Raise when a stand-in's toc is to read differently (its Lua is told apart byte for byte). */
const VERSIONS = { Auctionator: 2, Questie: 2 };
const NOTE = 'AzerothAtlas-installed.json';
const RELEASE = 'https://github.com/Questie/QuestieDB/releases/latest/download/release.json';
const AGENT = 'azeroth-atlas';
const LARGEST = 200 << 20;
const HEAD = 256 << 10; // of a .toc: what it says of itself is at its top
const ASKED = ['QuestieDB', 'Questie', 'Auctionator'];
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

// ---- reading what is there ----------------------------------------------------------------------
function head(file, bytes = HEAD) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    return buf.toString('latin1', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const said = (text, key) => new RegExp(`^##[ \\t]*${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, 'im').exec(text)?.[1] ?? null;
const tocs = (folder) => { try { return fs.readdirSync(folder).filter((f) => /\.toc$/i.test(f)).map((f) => path.join(folder, f)); } catch { return []; } };
const folders = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
/** The game version the map's own addon is written for: what its small addons say they are for as well. */
export const interfaceVersion = () => said(head(path.join(PROJECT_ROOT, 'addon', MAIN, `${MAIN}.toc`)), 'Interface') ?? '0';

/**
 * Which installed addons name each of the three in their .toc: { QuestieDB: [{ addon, required }],
 * Questie: [...], Auctionator: [...] } - as one they need (## Dependencies, ## RequiredDeps) or
 * one they load after where it is there (## OptionalDeps). The three themselves and the map's
 * own folders are not counted - but a real Questie is, as one that needs QuestieDB.
 *
 * Nothing is put in on the strength of this. It is told on the page beside each box, and a
 * QuestieDB the map put in is not taken out from under an addon that needs it.
 */
export function dependents(dir) {
  const out = { QuestieDB: [], Questie: [], Auctionator: [] };
  const names = new Map(ASKED.map((n) => [n.toLowerCase(), n]));
  for (const name of folders(dir)) {
    const lower = name.toLowerCase();
    if (lower === MAIN.toLowerCase() || lower.startsWith(`${MAIN.toLowerCase()}_`)) continue;
    if (lower === 'questiedb' || lower === 'auctionator') continue;
    const files = tocs(path.join(dir, name));
    if (!files.length) continue;
    const needs = new Set(), after = new Set();
    let marked = 0;
    for (const file of files) {
      const text = head(file);
      if (said(text, MARK)) marked++;
      for (const m of text.matchAll(/^##[ \t]*([A-Za-z-]+)[ \t]*:(.*)$/gm)) {
        const key = m[1].toLowerCase();
        const into = key === 'optionaldeps' ? after : key === 'requireddeps' || key.startsWith('dep') ? needs : null;
        if (into) for (const n of m[2].split(',')) if (n.trim()) into.add(n.trim().toLowerCase());
      }
    }
    if (marked === files.length) continue; // (a stand-in of the map's)
    for (const [low, proper] of names) {
      if (low === lower) continue;
      // (Questie itself reads QuestieDB whatever its .toc calls that)
      const real = lower === 'questie' && low === 'questiedb';
      if (needs.has(low) || real) out[proper].push({ addon: name, required: true });
      else if (after.has(low)) out[proper].push({ addon: name, required: false });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.addon.localeCompare(b.addon));
  return out;
}

/**
 * A folder that may hold a stand-in of the map's: { folder, present, ours, leftover, version,
 * title }. ours: every .toc in it is the stand-in's. leftover: the addon itself was unpacked
 * over the stand-in, and a .toc of the stand-in's is still beside its own.
 */
function lookFolder(dir, folder, stands) {
  const files = tocs(path.join(dir, folder));
  const out = { folder, present: files.length > 0, ours: false, leftover: false, version: null, title: null };
  // (the .toc the game reads for this flavour, where there are several)
  files.sort((a, b) => (path.basename(b).toLowerCase().includes(FLAVOUR.toLowerCase()) ? 1 : 0) - (path.basename(a).toLowerCase().includes(FLAVOUR.toLowerCase()) ? 1 : 0));
  let marked = 0;
  for (const file of files) {
    const text = head(file);
    if (said(text, MARK) === stands) { marked++; continue; }
    out.version ??= said(text, 'Version');
    out.title ??= said(text, 'Title');
  }
  out.ours = marked > 0 && marked === files.length;
  out.leftover = marked > 0 && marked < files.length;
  return out;
}

// (the fingerprint of a data file, worked out again only when the file is another)
const prints = new Map();
function sha1Of(file) {
  try {
    const st = fs.statSync(file), stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    const had = prints.get(file);
    if (had?.stamp === stamp) return had.sha1;
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    prints.set(file, { stamp, sha1 });
    return sha1;
  } catch { return null; }
}

/** QuestieDB as it is in the game: { present, ours, version, contract, commit, toc, sha1 }. */
export function lookQuestieDb(cfg) {
  const toc = installedQuestieDb(cfg);
  if (!toc) return { present: false, ours: false, version: null };
  const text = head(toc, 16384);
  let note = null;
  try { note = JSON.parse(fs.readFileSync(path.join(path.dirname(toc), NOTE), 'utf8')); } catch { /* not put in by the map */ }
  const sha1 = note ? sha1Of(toc) : null;
  return {
    present: true, toc, ours: !!note && !!sha1 && note.toc === sha1, sha1,
    version: said(text, 'Version'), contract: Number(said(text, 'X-Contract-Version')) || null, commit: said(text, 'X-BUILD-COMMIT'), flavor: said(text, 'X-Flavor'),
  };
}

// ---- which boxes are ticked ---------------------------------------------------------------------
const wantsFile = (cfg) => path.join(cfg.dataDir, 'user', 'standins.json');
/** { QuestieDB, Questie, Auctionator }: true for a box that is ticked. None is, until you tick it. */
export function readWants(cfg) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(wantsFile(cfg), 'utf8')); } catch { /* nothing ticked yet */ }
  return Object.fromEntries(ASKED.map((n) => [n, a?.[n] === true]));
}
export function setWant(cfg, name, on) {
  if (!ASKED.includes(name)) throw new Error(`there is no box for ${name}`);
  const a = readWants(cfg);
  a[name] = !!on;
  writeFileAtomic(wantsFile(cfg), JSON.stringify(a, null, 1) + '\n');
  return a;
}
/** Is the Atlas database to be laid over the QuestieDB in the game? (facts.js writes it) */
export function layerWanted(cfg) {
  const want = readWants(cfg);
  return (want.QuestieDB || want.Questie) && lookQuestieDb(cfg).present;
}
/**
 * How the map's prices are to be handed to the game (prices.js writes them): 'standin' (into the
 * stand-in's own folder), 'route' (a small addon beside your own Auctionator), or null (the box
 * is not ticked, or there is neither in the game).
 */
export function pricesMode(cfg) {
  const dir = addonsDir(cfg);
  if (!dir || !readWants(cfg).Auctionator) return null;
  const a = lookFolder(dir, 'Auctionator', 'Auctionator');
  return !a.present ? null : a.ours ? 'standin' : 'route';
}

// ---- the stand-ins' own files -------------------------------------------------------------------
// (a stand-in is in the folder the addon itself would be in, and its .toc has that folder's name)
/** The files of a stand-in as they are to be in the game: { name: text }. */
export function standinFiles(stands) {
  const lua = fs.readFileSync(path.join(BUNDLED, `${stands}.lua`), 'utf8');
  const top = [`## Interface: ${interfaceVersion()}`];
  if (stands === 'Auctionator') {
    top.push(
      '## Title: Auctionator |cff888888(Azeroth Atlas stand-in: the map\'s prices)|r',
      '## Notes: Not Auctionator itself: Azeroth Atlas, answering the addons that ask Auctionator what an item costs with the auction prices the 3D map keeps (read once an hour from the game\'s own auction lists). It has no auction window of its own. Put here by the box "Auctionator" on the map\'s page, and taken out again when that is unticked. Install the real Auctionator over this folder and the map\'s prices are given through it instead.',
      `## Version: ${VERSIONS.Auctionator}`,
      `## ${MARK}: Auctionator`,
    );
    return { [`${stands}.toc`]: [...top, '', PRICE_FILE, `${stands}.lua`, ''].join('\r\n'), [`${stands}.lua`]: lua };
  }
  top.push(
    '## Title: Questie |cff888888(Azeroth Atlas stand-in: answers only)|r',
    '## Notes: Not Questie itself: Azeroth Atlas, answering the addons that ask Questie where somebody stands or what a quest is, out of QuestieDB with the Atlas database laid over it. It draws no icons and has no quest list. Put here by the box "Questie" on the map\'s page, and taken out again when that is unticked. Install the real Questie over this folder and it reads the same data.',
    `## Version: ${VERSIONS.Questie}`,
    `## ${MARK}: Questie`,
    '## Dependencies: QuestieDB',
    `## OptionalDeps: ${FACTS}`,
  );
  return { [`${stands}.toc`]: [...top, '', `${stands}.lua`, ''].join('\r\n'), [`${stands}.lua`]: lua };
}
/** The file the stand-in for Auctionator reads its prices from, in its own folder (prices.js writes them into it). */
export const PRICE_FILE = 'prices.lua';
const NO_PRICES = '-- Azeroth Atlas: the auction prices the 3D map keeps go here. None have been written yet.\n';
const sameText = (file, text) => { try { return fs.readFileSync(file, 'utf8') === text; } catch { return false; } };
const current = (dir, stands) => Object.entries(standinFiles(stands)).every(([name, text]) => sameText(path.join(dir, stands, name), text));

/** Write a stand-in's files where they are not there as they should be. → { fresh, written } */
function writeStandin(dir, stands) {
  const target = path.join(dir, stands), fresh = !fs.existsSync(target);
  let written = false;
  for (const [name, text] of Object.entries(standinFiles(stands))) {
    const file = path.join(target, name);
    if (sameText(file, text)) continue;
    writeFileAtomic(file, text);
    written = true;
  }
  // (its .toc names the file of prices: there from the first, so the game never looks for one that is not)
  if (stands === 'Auctionator' && !fs.existsSync(path.join(target, PRICE_FILE))) writeFileAtomic(path.join(target, PRICE_FILE), NO_PRICES);
  return { fresh, written };
}
/** Take a stand-in of the map's out again: its own files, and the folder if nothing else is in it. */
function removeStandin(dir, stands) {
  if (!lookFolder(dir, stands, stands).ours) return false;
  for (const name of [...Object.keys(standinFiles(stands)), ...(stands === 'Auctionator' ? [PRICE_FILE] : [])]) { try { fs.rmSync(path.join(dir, stands, name)); } catch { /* not there */ } }
  try { fs.rmdirSync(path.join(dir, stands)); } catch { /* something of yours is in it: left */ }
  return true;
}
/**
 * The addon itself was unpacked over the stand-in: what is left of the stand-in is cleared out
 * of the folder, so that the game cannot take the stand-in's .toc for the addon's. Only what is
 * the stand-in's beyond doubt: a .toc with its mark, its Lua where that is still its own text,
 * the prices where the map wrote them.
 */
function clearLeftover(dir, stands) {
  const folder = path.join(dir, stands);
  let cleared = false;
  for (const file of tocs(folder)) if (said(head(file), MARK) === stands) { fs.rmSync(file, { force: true }); cleared = true; }
  const lua = path.join(folder, `${stands}.lua`);
  if (sameText(lua, standinFiles(stands)[`${stands}.lua`])) fs.rmSync(lua, { force: true });
  if (stands === 'Auctionator' && head(path.join(folder, PRICE_FILE), 64).startsWith('-- Azeroth Atlas:')) fs.rmSync(path.join(folder, PRICE_FILE), { force: true });
  return cleared;
}

// ---- switched off in the game's own list --------------------------------------------------------
const listLine = (folder, state) => new RegExp(`^(${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*)${state}([ \\t]*\\r?)$`, 'im');
/** The characters an addon's folder is switched off for: [{ file, character }]. */
function switchedOff(dir, folder) {
  const out = [], accounts = path.join(path.dirname(path.dirname(dir)), 'WTF', 'Account'), off = listLine(folder, 'disabled');
  for (const account of folders(accounts)) {
    for (const realm of folders(path.join(accounts, account))) {
      for (const character of folders(path.join(accounts, account, realm))) {
        const file = path.join(accounts, account, realm, character, 'AddOns.txt');
        try { if (off.test(fs.readFileSync(file, 'latin1'))) out.push({ file, character }); } catch { /* no list of its own */ }
      }
    }
  }
  return out;
}
/** The folder one of the three is in, where it is the map's to speak of: QuestieDB whoever put it there, a stand-in of the map's. */
function folderOf(cfg, dir, name) {
  if (name === 'QuestieDB') return lookQuestieDb(cfg).present ? 'QuestieDB' : null;
  if (name === 'Questie' || name === 'Auctionator') return lookFolder(dir, name, name).ours ? name : null;
  return null;
}
const offFor = (cfg, dir, name) => { const folder = folderOf(cfg, dir, name); return folder ? [...new Set(switchedOff(dir, folder).map((c) => c.character))].sort((a, b) => a.localeCompare(b)) : []; };

/**
 * Switch one of the three on for every character it is switched off for: the one line of each
 * character's list, and nothing else of it. Only while the game is closed.
 * @returns the status, with  switchedOn: how many characters
 */
export function switchOn(cfg, name, { gameSeen = false } = {}) {
  const dir = addonsDir(cfg);
  if (!dir) throw new Error('game AddOns folder not found');
  const folder = folderOf(cfg, dir, name);
  if (!folder) throw new Error(`there is no ${name} in the game to switch on`);
  const lists = switchedOff(dir, folder);
  if (lists.length && !closed(cfg, dir, gameSeen)) throw new Error('close the game first, then press this again: the game writes its list of addons when it closes');
  let switchedOn = 0;
  for (const { file } of lists) {
    const text = fs.readFileSync(file, 'latin1'), to = text.replace(listLine(folder, 'disabled'), '$1enabled$2');
    if (to === text) continue;
    fs.writeFileSync(file, to, 'latin1');
    switchedOn++;
  }
  return { ...standinStatus(cfg), switchedOn };
}

// ---- how things stand ---------------------------------------------------------------------------
// (the newest QuestieDB there is, as last asked: only "Check for updates" asks, and a box ticked with none in the game)
let newest = null;

/**
 * Each of the three, as it is in the game and what is to be done about it. For the page.
 *
 *   want     its box is ticked            state  'absent', 'ours' (the map put it there), 'real' (yours)
 *   action   'none', 'install' (put in), 'update' (the map's own, to be brought up to date),
 *            'remove' (the map's own, and its box is not ticked any more)
 *   wantedBy the addons that name it in their .toc (told, nothing more)
 *   offFor   the characters the game has it switched off for
 * QuestieDB also: on (it is seen to: its own box, or Questie's), latest, held (why a newer one
 * is not put in), keptFor (the addons a copy the map put in is left in the game for).
 * Auctionator also: routed (the small addon that gives the map's prices through yours is there).
 */
export function standinStatus(cfg) {
  const dir = addonsDir(cfg);
  if (!dir) return { available: false, reason: 'game AddOns folder not found', items: [] };
  const asks = dependents(dir), want = readWants(cfg);
  const who = (list) => list.map((d) => d.addon);
  const state = (look) => (!look.present ? 'absent' : look.ours ? 'ours' : 'real');
  // (a stand-in: put in where there is nothing, written again where it is not as it should be, taken out when unticked)
  const standin = (name, look) => (want[name] ? (!look.present ? 'install' : look.ours && !current(dir, name) ? 'update' : 'none') : look.ours ? 'remove' : 'none');

  // Questie: yours is never touched; where there is none, a stand-in answers for it
  const q = lookFolder(dir, 'Questie', 'Questie');
  const realQuestie = q.present && !q.ours;
  const questie = { name: 'Questie', want: want.Questie, state: state(q), version: realQuestie ? q.version : null, wantedBy: who(asks.Questie), action: standin('Questie', q), leftover: q.leftover };

  // QuestieDB: the database itself. Seen to for its own box, and for Questie's (its answers come out of it).
  const db = lookQuestieDb(cfg);
  const on = want.QuestieDB || want.Questie;
  const neededBy = who(asks.QuestieDB.filter((d) => d.required));
  const newer = !!newest?.version && db.present && laterVersion(newest.version, db.version);
  const questiedb = {
    name: 'QuestieDB', want: want.QuestieDB, on, state: !db.present ? 'absent' : db.ours ? 'ours' : 'real', version: db.version ?? null, latest: newest?.version ?? null,
    wantedBy: who(asks.QuestieDB), action: 'none',
  };
  if (on) {
    if (!db.present) questiedb.action = 'install';
    else if (db.ours && newer) questiedb.action = 'update';
    // (a newer one that a real Questie could not read is not put in under it)
    if (questiedb.action === 'update' && realQuestie && !fitsQuestie(dir)) { questiedb.action = 'none'; questiedb.held = 'the newest QuestieDB is laid out in a way your Questie does not read yet: left until Questie is updated'; }
  } else if (db.ours) {
    // (one the map put in: out again with the box - but not from under an addon that will not load without it)
    if (neededBy.length) questiedb.keptFor = neededBy; else questiedb.action = 'remove';
  }

  // Auctionator: a stand-in with the map's prices; through yours, the map's prices beside its own
  const a = lookFolder(dir, 'Auctionator', 'Auctionator');
  const auctionator = {
    name: 'Auctionator', want: want.Auctionator, state: state(a), version: a.present && !a.ours ? a.version : null, wantedBy: who(asks.Auctionator), action: standin('Auctionator', a), leftover: a.leftover,
    routed: a.present && !a.ours && fs.existsSync(path.join(dir, PRICES, `${PRICES}.toc`)),
  };

  // (switched off for some of your characters, in the game's own list: said, where the map is answering through it)
  questiedb.offFor = on && db.present ? offFor(cfg, dir, 'QuestieDB') : [];
  questie.offFor = want.Questie && q.ours ? offFor(cfg, dir, 'Questie') : [];
  auctionator.offFor = want.Auctionator && a.ours ? offFor(cfg, dir, 'Auctionator') : [];
  return { available: true, items: [questiedb, questie, auctionator], main: fs.existsSync(path.join(dir, MAIN, `${MAIN}.toc`)) };
}

/** Can the Questie in the game read the newest QuestieDB? (It says which layout it was written for.) */
function fitsQuestie(dir) {
  if (!newest?.contract) return true;
  let need = null;
  for (const file of tocs(path.join(dir, 'Questie'))) need ??= Number(said(head(file), 'X-QuestieDB-Contract')) || null;
  if (!need) return true;
  return need <= newest.contract && need >= (newest.minContract ?? 1);
}

// ---- QuestieDB, from where it is published ------------------------------------------------------
const word = (s) => (typeof s === 'string' && /^[\w.+-]{1,120}$/.test(s) ? s : null);

/** The newest release for this game: { version, tag, asset, sha256, bytes, contract, minContract, url }. */
export async function newestQuestieDb(fetch = globalThis.fetch) {
  // The address of "the latest release's note" leads on to that release's own: which release that is, is in where it leads.
  const hop = await fetch(RELEASE, { headers: { 'user-agent': AGENT }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const to = hop.headers?.get('location') ?? '';
  let tag = null;
  try { tag = word(decodeURIComponent(/\/releases\/download\/([^/]+)\/release\.json$/.exec(to)?.[1] ?? '')); } catch { /* not a name */ }
  try { await hop.body?.cancel(); } catch { /* nothing to let go of */ }
  if (hop.status < 300 || hop.status >= 400 || !tag) throw new Error(`QuestieDB's newest release could not be asked about (HTTP ${hop.status})`);
  const res = await fetch(to, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`QuestieDB's release ${tag} could not be asked about (HTTP ${res.status})`);
  const q = (await res.json())?.questiedb ?? {};
  const a = (Array.isArray(q.artifacts) ? q.artifacts : []).find((x) => x?.flavor === FLAVOUR);
  const asset = word(a?.file), version = word(q.version);
  if (!tag || !asset || !version || !/\.zip$/i.test(asset)) throw new Error(`QuestieDB's newest release names no files for ${FLAVOUR}`);
  newest = {
    version, tag, asset, sha256: /^[0-9a-f]{64}$/.test(a.sha256 ?? '') ? a.sha256 : null, bytes: Number.isInteger(a.bytes) ? a.bytes : null,
    contract: Number.isInteger(q.contractVersion) ? q.contractVersion : null, minContract: Number.isInteger(q.minSupportedContract) ? q.minSupportedContract : null,
    url: `https://github.com/Questie/QuestieDB/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`, at: Date.now(),
  };
  return newest;
}

/** The files of a release, checked: Map<path inside the addon's folder, Buffer>. */
async function fetchQuestieDb(rel, fetch) {
  const res = await fetch(rel.url, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw new Error(`${rel.asset}: the download was refused (HTTP ${res.status})`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > LARGEST) throw new Error(`${rel.asset}: far larger than expected`);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  if (rel.sha256 && sha256 !== rel.sha256) throw new Error(`${rel.asset}: not the file the release says it is (damaged on the way?)`);
  const files = new Map();
  for (const [name, data] of unzip(zip)) {
    const inner = name.replace(/^QuestieDB\//, '');
    if (inner === name || !PLAIN.test(inner)) throw new Error(`${rel.asset} holds a file where none belongs (${name}): nothing was changed`);
    files.set(inner, data);
  }
  const toc = files.get(TOC_NAME);
  if (!toc) throw new Error(`${rel.asset} holds no ${TOC_NAME}`);
  const top = toc.toString('latin1', 0, Math.min(toc.length, 16384));
  if (said(top, 'X-Flavor') !== FLAVOUR) throw new Error(`${TOC_NAME} is for "${said(top, 'X-Flavor')}", not ${FLAVOUR}`);
  return { files, sha256, toc: crypto.createHash('sha1').update(toc).digest('hex'), version: said(top, 'Version') ?? rel.version };
}

/** Put a fetched QuestieDB in the game's AddOns folder, in place of whatever is there. */
function placeQuestieDb(dir, got, rel) {
  const target = path.join(dir, 'QuestieDB');
  // (what a run that broke off left behind)
  for (const name of folders(dir)) if (/^QuestieDB\.azeroth-atlas-(new|old)-\d+$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  const staged = path.join(dir, `QuestieDB.azeroth-atlas-new-${process.pid}`), old = path.join(dir, `QuestieDB.azeroth-atlas-old-${process.pid}`);
  try {
    for (const [inner, data] of got.files) {
      const file = path.join(staged, ...inner.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    fs.writeFileSync(path.join(staged, NOTE), JSON.stringify({ by: 'Azeroth Atlas', what: 'QuestieDB as its makers publish it, put here by the 3D map ("Check for updates"). Nothing in it is changed.', version: got.version, tag: rel.tag, from: rel.url, sha256: got.sha256, toc: got.toc, at: new Date().toISOString() }, null, 1) + '\n');
    const had = fs.existsSync(target);
    if (had) fs.renameSync(target, old);
    try { fs.renameSync(staged, target); } catch (err) { if (had) fs.renameSync(old, target); throw err; }
    if (had) fs.rmSync(old, { recursive: true, force: true });
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
}

const closed = (cfg, dir, gameSeen) => !(gameRunning(path.dirname(path.dirname(dir))) ?? !!gameSeen);

// ---- doing it -----------------------------------------------------------------------------------
/**
 * Do what is to be done (see standinStatus), for the boxes as they are ticked. Something that can
 * only be done while the game is closed, and the game is running, waits for the next time.
 *
 * @param opts  gameSeen (the map can see the game's window just now), fetch (the tests name a
 *              stand-in), look (ask where QuestieDB is published whether a newer one is out:
 *              "Check for updates" does; a box being ticked only asks where there is none to put in)
 * @returns the status, with  did: [{ name, what: 'installed' | 'updated' | 'removed', version?, restart }],
 *          waiting: [{ name, why }] and errors: [{ name, error }]
 */
export async function applyStandins(cfg, { gameSeen = false, fetch = globalThis.fetch, look = true } = {}) {
  const dir = addonsDir(cfg);
  if (!dir) throw new Error('game AddOns folder not found');
  const did = [], waiting = [], errors = [];
  const item = (name) => standinStatus(cfg).items.find((i) => i.name === name);
  let looked = null;
  const first = item('QuestieDB');
  if (first.on && (look || first.state === 'absent')) { try { await newestQuestieDb(fetch); } catch (err) { looked = err.message; } }
  let isClosed;
  const gameClosed = () => (isClosed ??= closed(cfg, dir, gameSeen));
  const CLOSE = 'close the game, then check again: the game reads an addon\'s files when it starts';

  // QuestieDB first: the stand-in for Questie reads it
  try {
    const q = item('QuestieDB');
    if (q.action === 'install' || q.action === 'update') {
      if (!newest) throw new Error(looked ?? 'the newest QuestieDB is not known');
      // (a folder the game has open may not be changed under it; a new one it finds when it next starts)
      if (q.action === 'update' && !gameClosed()) waiting.push({ name: 'QuestieDB', why: CLOSE, version: newest.version });
      else {
        const got = await fetchQuestieDb(newest, fetch);
        placeQuestieDb(dir, got, newest);
        prints.clear();
        did.push({ name: 'QuestieDB', what: q.action === 'install' ? 'installed' : 'updated', version: got.version, from: q.version, restart: true });
      }
    } else if (q.action === 'remove') {
      if (!gameClosed()) waiting.push({ name: 'QuestieDB', why: CLOSE, remove: true });
      // (looked at once more: only the very copy the map put in is taken out)
      else if (lookQuestieDb(cfg).ours) {
        fs.rmSync(path.join(dir, 'QuestieDB'), { recursive: true, force: true });
        prints.clear();
        did.push({ name: 'QuestieDB', what: 'removed', from: q.version, restart: false });
      }
    }
  } catch (err) { errors.push({ name: 'QuestieDB', error: err.message }); }

  // Questie and Auctionator: the stand-in where there is none; out again when the box is unticked
  for (const name of ['Questie', 'Auctionator']) {
    try {
      const s = item(name);
      if (s.leftover) clearLeftover(dir, name);
      if (s.action === 'remove') { if (removeStandin(dir, name)) did.push({ name, what: 'removed', restart: false }); }
      else if (s.action === 'install' || s.action === 'update') {
        // (the stand-in for Questie has no use without QuestieDB: where that could not be put in, it waits)
        if (name === 'Questie' && !lookQuestieDb(cfg).present) waiting.push({ name, why: 'QuestieDB first: the stand-in answers out of it' });
        else {
          const r = writeStandin(dir, name);
          if (r.written) did.push({ name, what: s.action === 'install' ? 'installed' : 'updated', restart: r.fresh });
        }
      }
    } catch (err) { errors.push({ name, error: err.message }); }
  }

  return { ...standinStatus(cfg), did, waiting, errors, looked };
}
