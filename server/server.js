#!/usr/bin/env node
// Local-only server for the 3D map: serves the viewer and the extracted data, reports whether
// the installed game is newer than the extracted map, and runs the extractor on request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, readConfigFile, PROJECT_ROOT, CONFIG_FILE } from '../extractor/config.js';
import { DATA_STAMP } from '../extractor/stamp.js';
import { installedBuild } from '../extractor/casc/casc.js';
import { findQuestieDb, builtFromQuestie } from '../extractor/questie.js';
import { atlasStamp } from '../extractor/atlas.js';
import { PlayerTracker } from './tracker.js';
import { addonStatus, installAddon, teachGuideAddons, flavourFolder, addonsDir } from './addon.js';
import { SeenStore } from './seen.js';
import { RouteMail, NAME as ADDON } from './mail.js';
import { OLD as OLD_ADDON, legacyInstalled } from './legacy.js';
import { Changes } from './changes.js';
import { AppUpdate } from './appupdate.js';
import { MIME, sendFile, safeJoin } from './http.js';
import { AtlasDb } from './atlasdb.js';
import { CombatLog } from './combatlog.js';
import { Fights, measuredHealth } from './fights.js';
import { Minimap } from './minimap.js';
import { Dots } from './dots.js';
import { clockFigures, writeClockAddon } from './boats.js';
import { writeDropsAddon } from './drops.js';
import { writeBookAddon } from './questbook.js';
import { standinStatus, applyStandins, setWant, switchOn, pricesMode } from './standins.js';
import { writePricesAddon } from './prices.js';
import { writeFactsAddon } from './facts.js';
import { Auctions } from './auctions.js';
import { openLogs, logDir, note, noteCrashes } from './log.js';
import { Reports } from './report.js';

// node server/server.js [--open] [--config=path/to/config.json]
// (server/watch.js runs this and starts it again whenever the map's code changes)
const configArg = process.argv.find((a) => a.startsWith('--config='));
const configFile = configArg ? path.resolve(configArg.slice(9)) : CONFIG_FILE;
// What happens from here on is noted (log.js), for "Report a problem" to pack (report.js).
openLogs(logDir(configFile));
noteCrashes('the map server');
note('server', 'starting', { node: process.versions.node, electron: process.versions.electron ?? null, asApplication: !!process.env.AZEROTH_ATLAS_APP, folder: PROJECT_ROOT, config: configFile, pid: process.pid });
// The map tool keeps itself current (appupdate.js). While it writes its files, while a map
// build runs, and while a report of a problem is being made, server/watch.js is asked not to
// start the server again.
const job = { running: false, phase: '', done: 0, total: 0, log: [], summary: null, error: null, startedAt: null, finishedAt: null };
let updating = false, reporting = false, standing = false;
const busy = () => process.send?.({ busy: job.running || updating || reporting || standing });
let cfg;
try { cfg = loadConfig(configFile); } catch (err) {
  if (err.code !== 'NO_GAME') { note('server', 'the settings could not be taken', { error: err.message }); throw err; }
  note('server', 'the game was not found: the page asks where it is', { error: err.message, configured: err.configured ?? null });
  // The game could not be found: the page asks where it is (setup.js), and this starts again once it has been told.
  const { runSetup } = await import('./setup.js');
  // (whether it may update itself is in the settings all the same, and holds here as anywhere)
  let how = true;
  try { how = readConfigFile(configFile).autoUpdate; } catch { /* settings that cannot be read: asked about on the page */ }
  const app = new AppUpdate(PROJECT_ROOT, { auto: how !== false && how !== 'never', never: how === 'never', busy: (on) => { updating = on; busy(); } });
  app.start();
  await runSetup(err, configFile, app);
}
const appUpdate = new AppUpdate(PROJECT_ROOT, { auto: cfg.autoUpdate !== false && cfg.autoUpdate !== 'never', never: cfg.autoUpdate === 'never', hold: () => job.running, busy: (on) => { updating = on; busy(); } });
appUpdate.start();
// Live player link: only watches the screen while a map page is open (see tracker.js).
// The route's way into the game: mailboxes beside the addon, kept filled while you play (see mail.js).
// ("ingame": false in config.json switches it off)
// (a copy of the addon from before its new name, not yet replaced: its mailboxes are the ones the game opens - see legacy.js)
const oldAddon = legacyInstalled(addonsDir(cfg)) && !fs.existsSync(path.join(addonsDir(cfg), ADDON, `${ADDON}.toc`));
const mail = new RouteMail(cfg.ingame === false ? null : addonsDir(cfg), oldAddon ? OLD_ADDON : ADDON);
const tracker = new PlayerTracker({ pathHint: flavourFolder(cfg) ?? '', ...(cfg.tracker ?? {}), mail });
// Where NPCs really stand, as you have seen for yourself in the game (see seen.js).
const seen = new SeenStore(cfg.dataDir);
// What every copy of the map learns about the game world, put together in one database (see atlasdb.js).
// (after each time it has sent and fetched: the boats' figures, where they have changed, are written for the addon to read - boats.js)
const handBoats = () => {
  try {
    const r = writeClockAddon(cfg, cfg.dataDir);
    if (r?.written) note('database', 'the boats: where each line stands on the server\'s clock, as the Atlas database has measured it, written for the addon', { lines: r.lines, fresh: r.fresh || undefined });
  } catch (err) { note('database', 'the boats\' figures could not be written for the addon', { error: err.message }); }
};
// (and how often each creature drops what quests ask for, which the addon shows in the game's own tooltip - drops.js.
// Looked at when the map starts, each time the database has been fetched, and when the addon is installed.)
const handDrops = () => {
  try {
    const r = writeDropsAddon(cfg, cfg.dataDir);
    if (r?.written) note('database', 'drop rates: how often each creature drops what quests ask for, as the Atlas database has it, written for the addon', { creatures: r.creatures, rates: r.rates, itemsNamed: r.named, fresh: r.fresh || undefined });
    return r;
  } catch (err) { note('database', 'the drop rates could not be written for the addon', { error: err.message }); return null; }
};
// (and what each quest gives and which quests lead to which dungeon, by which the addon orders the quests it tracks for
// you and tracks a dungeon's quests with those leading up to them - questbook.js. Looked at when the drop rates are.)
const handBook = () => {
  try {
    const r = writeBookAddon(cfg, cfg.dataDir);
    if (r?.written) note('database', 'quests: what each gives and which lead to which dungeon, as the Atlas database has it, written for the addon', { quests: r.quests, itemsPriced: r.items, dungeons: r.dungeons, fresh: r.fresh || undefined });
    return r;
  } catch (err) { note('database', 'what quests give could not be written for the addon', { error: err.message }); return null; }
};
// (and what the database knows beyond QuestieDB, laid over the QuestieDB in the game for every addon that reads it -
// facts.js, where the box "QuestieDB" or "Questie" on the page is ticked. Worked out in a thread of its own; looked
// at when the map starts, each time the database has been fetched, when a box is ticked, and by "Check for updates".)
const handFacts = async () => {
  try {
    const r = await writeFactsAddon(cfg);
    if (r?.written) note('database', 'what the Atlas database knows beyond QuestieDB, written for the game to lay over QuestieDB', { creatures: r.npc, objects: r.object, quests: r.quest, names: r.named, movedToWhereTheyWereMet: r.moved, mailboxes: r.mailboxes, questiedb: r.version, fresh: r.fresh || undefined });
    return r;
  } catch (err) { note('database', 'what the database knows beyond QuestieDB could not be written for the game', { error: err.message }); return null; }
};
// (and the auction prices, for the addons that ask Auctionator what an item costs - prices.js, where the box
// "Auctionator" on the page is ticked. Looked at when the map starts, each time the prices have been fetched, when
// the box is ticked, and by "Check for updates".)
const handPrices = () => {
  try {
    const r = writePricesAddon(cfg);
    if (r?.written) note('auctions', r.mode === 'route' ? 'auction prices written for the game, to be given through your Auctionator' : 'auction prices written for the game, for the stand-in that answers in Auctionator\'s place', { items: r.items, house: r.house, listed: r.t, fresh: r.fresh || undefined });
    return r;
  } catch (err) { note('auctions', 'the auction prices could not be written for the game', { error: err.message }); return null; }
};
// The database fetched anew: the map's creatures, NPCs and quests are built again with it, by
// itself. A short job - only the maps the database changed anything on are done again - and
// the one way what the other copies have learned reaches this one's map without anybody having
// to press a button for it. Once for each database, so that one the map cannot be built with
// is not tried over and over. ("database": { "apply": false } in config.json leaves it to the
// Update map button; so does a map that also wants building for another reason.)
let appliedFor = null;
const applyDatabase = () => {
  try {
    if (job.running || cfg.database === false || cfg.database?.apply === false) return;
    const st = status();
    if (!st.extracted || st.updateReason !== 'database') return;
    const now = atlasStamp(cfg.dataDir)?.hash ?? null;
    if (now === appliedFor) return;
    appliedFor = now;
    note('map', 'the Atlas database has been fetched anew: the map is updated with it');
    startUpdate(false);
  } catch (err) { note('map', 'the map could not be updated with the Atlas database by itself', { error: err.message }); }
};
const atlas = new AtlasDb(cfg, configFile, { hold: () => job.running, after: () => { handBoats(); handDrops(); handBook(); handFacts(); applyDatabase(); } });
atlas.start();
handBoats();
handDrops();
handBook();
handFacts();
setTimeout(applyDatabase, 8000).unref?.();
// Where you are inside a dungeon, read off the game's minimap: the game hides it from the addon
// there, and the minimap's picture shows it (see minimap.js). Only while a map page is open and
// you are in a dungeon the map has a plan of. ("minimap": false in config.json switches it off)
// (what following you through a dungeon teaches of the dungeon itself - a door, a way its floors
// do not have, how far off the minimap's place is - goes to the Atlas database with the rest)
const minimap = cfg.minimap === false ? null : new Minimap(cfg, { tracker, onLearned: () => atlas.nudge() });
if (minimap) { tracker.eyes = minimap; minimap.start(); }
// What the game's minimap shows as dots - what you track, your target, your pet - as places on
// the map, read off the same picture (see dots.js). Only while a map page is open that shows
// any of them. ("dots": false in config.json switches it off)
const dots = cfg.dots === false ? null : new Dots({ tracker, inside: (map) => minimap?.where(map) ?? null });
if (dots) tracker.dots = dots;
// What the game's own combat log says of the creatures you fight: where each was, its level and
// health, how it stands towards your side - and, inside a dungeon, where you are (see combatlog.js).
// ("combatLog": false in config.json leaves the log unread)
// (and how your own fights go, for the quest explorer to reckon a kill by: fights.js. Which level
// you are is the live link's to say - the log's own "level" of a player is that of what they wear.)
const fights = cfg.combatLog === false ? null : new Fights(cfg, { level: () => (tracker.state?.status === 'live' ? tracker.state.player?.level ?? null : null) });
const combat = cfg.combatLog === false ? null : new CombatLog(cfg, {
  fights,
  side: () => { const f = tracker.state?.status === 'live' ? tracker.state.player?.faction : null; return f === 'horde' ? 'H' : f === 'alliance' ? 'A' : null; },
  onNew: () => atlas.nudge(),
  // (where you are is worth showing while it is news: a log read hours later says where you were.
  // And not while the minimap has you: that is where you are now, the log where you were at a
  // blow - which the minimap's place is held against, and looked for near - minimap.js, logged)
  onFix: (fix) => { if (Date.now() - fix.at < 60000 && !minimap?.logged(fix)) tracker.placed(fix); },
});
combat?.start();
// What things cost at the auction house, and how that has moved (see auctions.js).
// (Where the box "Auctionator" is ticked and the game has one - the map's stand-in, or your own with the map's
// prices given through it - the addons there are answered with these prices: they are kept fresh while the game
// runs, looked at once as the map starts, and handed on after every look.)
const pricesWanted = () => { try { return !!pricesMode(cfg); } catch { return false; } };
const auctions = new Auctions(cfg, configFile, {
  hold: () => job.running,
  wanted: () => ['live', 'minimized', 'nosignal'].includes(tracker.state?.status) && pricesWanted(),
  after: () => handPrices(),
});
auctions.start();
handPrices();
if (pricesWanted()) auctions.touch();
const VIEWER_DIR = path.join(PROJECT_ROOT, 'viewer');
// The page's own files, watched: a page that is open loads itself again when they change (changes.js).
const changes = new Changes(VIEWER_DIR);
// "Report a problem": everything that may explain one, in a zip (report.js)
const reports = new Reports({ configFile, cfg, busy: (on) => { reporting = on; busy(); }, live: { status: () => status(), tracker, mail, atlas, auctions, minimap, dots, addon: () => addonStatus(cfg), standins: () => standinStatus(cfg) } });
note('server', 'the settings in use', { game: cfg.installRoot, found: !!cfg.foundGame, flavour: flavourFolder(cfg), data: cfg.dataDir, port: cfg.port, ingame: cfg.ingame !== false, minimap: cfg.minimap !== false, dots: cfg.dots !== false, autoUpdate: cfg.autoUpdate ?? true, oldAddonInUse: oldAddon });

// ---- update job ---------------------------------------------------------------------------

function startUpdate(force) {
  if (job.running) return false;
  Object.assign(job, { running: true, phase: 'Starting', done: 0, total: 0, log: [], summary: null, error: null, startedAt: Date.now(), finishedAt: null });
  const args = [path.join(PROJECT_ROOT, 'extractor', 'extract.js'), '--json'];
  if (force) args.push('--force');
  const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  job.child = child;
  note('map', force ? 'the map is being built again, all of it' : 'the map is being built or updated');
  busy(); // (not to be started again by watch.js in the middle of this)
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'phase') { job.phase = ev.name; job.done = 0; job.total = ev.total ?? 0; }
      else if (ev.type === 'progress') { job.done = ev.done; job.total = ev.total; }
      else if (ev.type === 'log') { job.log.push(ev.msg); if (job.log.length > 200) job.log.shift(); }
      else if (ev.type === 'done') job.summary = ev.summary;
      else if (ev.type === 'error') job.error = ev.message;
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  child.on('close', (code) => {
    job.running = false;
    job.finishedAt = Date.now();
    if (code !== 0 && !job.error) job.error = stderr.trim() || `extractor exited with code ${code}`;
    note('map', job.error ? 'the map build failed' : 'the map build is done', { seconds: Math.round((job.finishedAt - job.startedAt) / 1000), error: job.error ?? undefined, summary: job.summary ?? undefined, lastSaid: job.error ? job.log.slice(-12) : undefined, stderr: job.error && stderr ? stderr.slice(-1500) : undefined });
    busy();
  });
  return true;
}

function status() {
  let installed = null, installError = null, manifest = null;
  try { installed = installedBuild(cfg.installRoot, cfg.product); } catch (err) { installError = err.message; }
  try { manifest = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'manifest.json'), 'utf8')); } catch { /* not extracted yet */ }
  // Creature data (spawn zones, NPCs, quests) comes from QuestieDB, which has new versions on its own
  // schedule (fetched from the Atlas database by atlasdb.js as they come out; or the addon in the game's
  // folder): flag it when the copy on this disk differs from the one the map was built from.
  let creatureFile = null;
  try { creatureFile = findQuestieDb(cfg); } catch { /* treated as not there */ }
  const newBuild = !!installed && (!manifest || manifest.build.buildKey !== installed.buildKey);
  let newCreatureData = false;
  try { newCreatureData = !!installed && !!manifest && !!creatureFile && !builtFromQuestie(cfg, creatureFile, manifest.questie); } catch { /* as it was */ }
  // The map tool itself has been updated since the map was built, and builds some of it differently
  // now (extractor/stamp.js): the page goes on working with the map as it is, and offers to build it again.
  const newTool = !!installed && !!manifest && manifest.tool !== DATA_STAMP;
  // The Atlas database has been fetched anew since the map's creatures, NPCs and quests were
  // built with it (extractor/atlas.js lays it over QuestieDB): what every copy has learned since
  // is on this disk and not yet on the map.
  let newDatabase = false;
  // (a database on this disk that is another than the map was built with. None on the disk -
  // not fetched yet, or its folder gone - is nothing new: building again would only take out
  // what the last one put in, and it is fetched again by itself)
  try { const have = cfg.atlas === false ? null : atlasStamp(cfg.dataDir); newDatabase = !!installed && !!manifest && !!have && have.hash !== (manifest.atlas?.hash ?? null); } catch { /* as it was */ }
  return {
    installed, installError,
    extracted: manifest ? { build: manifest.build, revision: manifest.revision, extractedAt: manifest.extractedAt, formatVersion: manifest.formatVersion } : null,
    updateAvailable: newBuild || newCreatureData || newTool || newDatabase,
    updateReason: newBuild ? 'build' : newCreatureData ? 'creatures' : newTool ? 'tool' : newDatabase ? 'database' : null,
    job: { ...job, child: undefined },
    app: appUpdate.status(),
    game: { folder: cfg.installRoot, found: !!cfg.foundGame },
    // finding you on the game's minimap inside a dungeon (minimap.js): how it stands, and its last figures (null: switched off)
    minimap: minimap?.status() ?? null,
    // the dots of the game's minimap, as places on the map (dots.js): how reading them stands, and what the last picture gave (null: switched off)
    dots: dots?.status() ?? null,
  };
}

// ---- http ---------------------------------------------------------------------------------
// (how the addon in the game's folder stands is asked for often: noted when it is another answer than before)
let addonSaid = '';
const changedAddon = (st) => { const now = JSON.stringify([st.installed, st.installedVersion, st.version, st.current, st.mail, st.legacy, st.guides, st.reason]); if (now === addonSaid) return false; addonSaid = now; return true; };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  // Only this machine may talk to the server (defends against other sites / DNS rebinding).
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); res.end(); return; }

  if (reports.handle(req, res, url, p)) return;
  if (p === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status()));
    return;
  }
  if (p === '/api/update') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    const started = startUpdate(url.searchParams.get('force') === '1');
    res.writeHead(started ? 202 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ started }));
    return;
  }
  if (p === '/api/app/check') {
    // look for a newer version of the map tool now (?apply=1: and put it in, whatever "autoUpdate" says)
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    note('update', url.searchParams.get('apply') === '1' ? 'asked on the page: look for a newer version and put it in' : 'asked on the page: look for a newer version');
    appUpdate.check({ apply: url.searchParams.get('apply') === '1' ? true : undefined });
    res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(appUpdate.status()));
    return;
  }
  if (p === '/api/player/events') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    tracker.subscribe(req, res);
    return;
  }
  if (p === '/api/player/dots') {
    // a map page says whether it shows any of the minimap's dots (what you track, your target, your pet): the minimap is looked at for them only while one does
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    dots?.want(url.searchParams.get('on') !== '0');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ on: dots ? dots.on : false, off: !dots }));
    return;
  }
  if (p === '/api/changes') {
    // told when the page's own files change, a page loads itself again
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    changes.subscribe(req, res);
    return;
  }
  if (p === '/api/player/quests') {
    // your quest log and the quests you have done, as the game last reported them
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(tracker.quests));
    return;
  }
  if (p === '/api/npcs/seen') {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET') { json(200, seen.all()); return; }
    if (req.method !== 'POST' && req.method !== 'DELETE') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    // a small JSON body: one sighting to note, or which NPC's sightings to forget
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const d = body ? JSON.parse(body) : {};
        if (req.method === 'POST') { json(200, { ok: true, record: seen.add(d), count: seen.list.length }); note('seen', `where ${d.object ? 'object' : 'NPC'} ${d.id} stands was noted`, { map: d.map, at: [d.x, d.y, d.z] }); atlas.nudge(); }
        else json(200, { ok: true, forgotten: seen.forget(d.map, d.id, d.object), count: seen.list.length });
      } catch (err) { json(400, { error: err.message }); }
    });
    return;
  }
  if (p === '/api/fights') {
    // how your own fights go (the last sixty you fought alone: fights.js), and which creatures' health
    // has been measured in this game, at what - for the quest explorer (viewer/js/quests.js, pace.js)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    let health = {};
    try { health = measuredHealth(cfg.dataDir, combat?.store.levels ?? null, combat?.healthRev ?? 0); } catch { /* none to tell of */ }
    res.end(JSON.stringify({ ...(fights?.figures() ?? { v: 1, fights: [], keep: 0, counted: null }), read: !!combat, health }));
    return;
  }
  if (p === '/api/transit/clock') {
    // where each boat line stands on the server's clock, as the Atlas database has measured it (none fetched yet: no lines)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(clockFigures(cfg.dataDir) ?? { v: 1, lines: {} }));
    return;
  }
  if (p === '/api/database') {
    // the Atlas database: what this copy sends and has fetched (?share=0 or 1: keep what it learns to itself, or send it; ?run=1: now)
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    // (fights: what the game's combat log has given so far - combatlog.js; null where it is left unread)
    const said = () => ({ ...atlas.status(), fights: combat?.status() ?? null });
    if (req.method === 'GET') { json(200, said()); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    try {
      if (url.searchParams.has('share')) atlas.setShare(url.searchParams.get('share') === '1');
      if (url.searchParams.get('run') === '1') atlas.run();
      json(200, said());
    } catch (err) { json(500, { error: err.message }); }
    return;
  }
  if (p === '/api/prices' || p === '/api/prices/list' || p === '/api/prices/item' || p === '/api/prices/recipes') {
    // auction prices: what this copy shows and where it has them from (POST ?house=us-110: choose the
    // house; ?run=1: look now), a house's whole list (/list), one item's history (/item?id=), every
    // recipe costed at the house's prices (/recipes)
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      if (req.method === 'POST' && p === '/api/prices') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
        if (url.searchParams.has('house')) auctions.setHouse(url.searchParams.get('house'));
        else if (url.searchParams.get('run') === '1') auctions.run();
        json(200, { ...auctions.status(), regions: auctions.houses() });
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      auctions.touch();
      const house = url.searchParams.get('house') || undefined;
      if (p === '/api/prices') json(200, { ...auctions.status(), regions: auctions.houses() });
      else if (p === '/api/prices/list') json(200, auctions.list(house) ?? { none: true });
      else if (p === '/api/prices/recipes') json(200, auctions.recipes(house) ?? { none: true });
      else json(200, auctions.item(Number(url.searchParams.get('id')), house) ?? { none: true });
    } catch (err) { json(err.message.startsWith('no such auction house') ? 400 : 500, { error: err.message }); }
    return;
  }
  if (p === '/api/ingame/route') {
    // the route the map page shows now, to be drawn in the game as well
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET') { json(200, mail.status()); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 400000) req.destroy(); });
    req.on('end', () => {
      try {
        const st = mail.setRoute(JSON.parse(body));
        tracker.mailChanged();
        json(200, st);
      } catch (err) { note('mail', 'what the page sent as its route could not be taken', { error: err.message, sent: body.slice(0, 600) }); json(400, { error: err.message }); }
    });
    return;
  }
  if (p === '/api/addon' || p === '/api/addon/install' || p === '/api/addon/guides') {
    // (/guides: the guide addons the addon follows are taught about floors, or put back as their
    // makers wrote them - guidepatch.js. ?teach=1 or 0 switches that on or off first, for good.)
    const install = p.endsWith('/install'), guides = p.endsWith('/guides');
    if (install || guides) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    }
    try {
      if (guides && url.searchParams.has('teach')) {
        const on = url.searchParams.get('teach') === '1';
        let file = {};
        try { file = readConfigFile(configFile); } catch { /* a new one */ }
        // (on is how it is unless said otherwise: only "off" is written down)
        if (on) delete file.guidePatches; else file.guidePatches = false;
        fs.writeFileSync(configFile, JSON.stringify(file, null, 2) + '\n');
        if (on) delete cfg.guidePatches; else cfg.guidePatches = false;
        note('addon', on ? 'guide addons are to be taught about floors' : 'guide addons are to be left as their makers wrote them');
      }
      const st = install ? installAddon(cfg, { gameSeen: ['live', 'minimized', 'nosignal'].includes(tracker.state.status) }) : guides ? teachGuideAddons(cfg) : addonStatus(cfg);
      if (install) mail.use(ADDON);
      // (the drop rates go in with it: a folder of their own, which the game finds when it next starts)
      if (install && handDrops()?.fresh) st.restart = true;
      // (and what quests give, likewise)
      if (install && handBook()?.fresh) st.restart = true;
      if (install) note('addon', `the addon was installed in the game's folder: version ${st.installedVersion ?? '?'}`, { restartNeeded: st.restart, carriedOver: st.carried ?? undefined, current: st.current, mailboxes: st.mail });
      else if (guides) note('addon', st.taught ? 'guide addons taught about floors' : 'guide addons put back as their makers wrote them', { changed: st.done, asTheyAre: st.guides?.addons });
      else if (changedAddon(st)) note('addon', 'the addon in the game\'s folder', { installed: st.installed, version: st.installedVersion, brought: st.version, current: st.current, mailboxes: st.mail, oldCopy: st.legacy || undefined, guides: st.guides, why: st.reason });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(st));
    } catch (err) {
      note('addon', install ? 'the addon could not be installed' : guides ? 'the guide addons could not be changed' : 'the addon could not be looked at', { error: err.message });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (p === '/api/standins' || p === '/api/standins/apply' || p === '/api/standins/want' || p === '/api/standins/enable') {
    // What other addons ask of QuestieDB, Questie and Auctionator, answered out of the map's own data (standins.js),
    // for each of the three whose box on the page is ticked: how each stands in the game (GET); /want?name=&on=1|0:
    // a box ticked or unticked, and seen to there and then; /apply: all of them seen to ("Check for updates" does);
    // /enable?name=: switched on for the characters it is switched off for, in the game's own list of addons.
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const act = p.slice('/api/standins'.length);
    if (!act) { if (req.method !== 'GET') { res.writeHead(405); res.end(); return; } try { json(200, standinStatus(cfg)); } catch (err) { json(500, { error: err.message }); } return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    const gameSeen = ['live', 'minimized', 'nosignal'].includes(tracker.state?.status);
    const name = url.searchParams.get('name');
    (async () => {
      if (standing) throw new Error('this is being seen to already: a moment');
      // (the game's addon folders are being written: the server is not started again in the middle - watch.js)
      standing = true; busy();
      try {
        if (act === '/enable') {
          const st = switchOn(cfg, name, { gameSeen });
          note('standins', `${name}: switched on in the game's list of addons`, { characters: st.switchedOn });
          return st;
        }
        if (act === '/want') {
          const on = url.searchParams.get('on') === '1';
          setWant(cfg, name, on);
          note('standins', `the box "${name}" on the page: ${on ? 'ticked' : 'unticked'}`);
        }
        // (a box ticked asks where QuestieDB is published only where there is none to put in; "Check for updates" asks whether a newer one is out)
        const st = await applyStandins(cfg, { gameSeen, look: act === '/apply' });
        // (what they answer with goes in with them: the prices and the Atlas database's rows, which the game finds when it next loads its addons)
        const prices = handPrices(), facts = await handFacts();
        if (st.did.length || st.errors.length || st.waiting.length) note('standins', 'what other addons ask of QuestieDB, Questie and Auctionator: seen to', { did: st.did, waiting: st.waiting, errors: st.errors, couldNotLook: st.looked ?? undefined });
        if (pricesWanted()) auctions.touch();
        return { ...standinStatus(cfg), did: st.did, waiting: st.waiting, errors: st.errors, looked: st.looked, prices: prices ? { mode: prices.mode, items: prices.items, written: prices.written, fresh: prices.fresh } : null, facts: facts ? { written: facts.written, fresh: facts.fresh } : null };
      } finally { standing = false; busy(); }
    })().then((st) => json(200, st), (err) => { note('standins', 'what other addons ask could not be seen to', { error: err.message, what: act, name: name ?? undefined }); json(500, { error: err.message }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (p.startsWith('/data/')) {
    const file = safeJoin(cfg.dataDir, p.slice(6));
    if (!file) { res.writeHead(400); res.end(); return; }
    sendFile(req, res, file, url.searchParams.has('v'));
    return;
  }
  const file = safeJoin(VIEWER_DIR, p === '/' ? 'index.html' : p);
  if (!file) { res.writeHead(400); res.end(); return; }
  if (file === path.join(VIEWER_DIR, 'index.html')) {
    // the page itself: sent with the stamp of the files it is made of (changes.js)
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : changes.page(html));
    });
    return;
  }
  sendFile(req, res, file, false);
});

// Run by server/watch.js: asked to make way when the map's code has changed (the helper that
// reads the game window is put away first), and not left behind should the watcher go.
if (process.send) {
  // (a map build in hand goes with it: nobody would see it finish, and the next one picks up where it stopped)
  const leave = () => { note('server', 'asked to make way: its code has changed, or the application is closing'); try { tracker.stop(); } catch { /* going anyway */ } try { minimap?.stop(); } catch { /* going anyway */ } try { atlas.stop(); } catch { /* going anyway */ } try { combat?.stop(); } catch { /* going anyway */ } try { auctions.stop(); } catch { /* going anyway */ } try { if (job.running) job.child?.kill(); } catch { /* gone */ } process.exit(0); };
  process.on('message', (m) => { if (m?.stop) leave(); });
  process.on('disconnect', leave);
}

server.listen(cfg.port, '127.0.0.1', () => {
  const url = `http://localhost:${cfg.port}/`;
  console.log(`Azeroth Atlas: ${url}`);
  console.log(`  game:  ${cfg.installRoot}${cfg.foundGame ? '  (found there: "installRoot" in config.json names another)' : ''}`);
  console.log(`  data:  ${cfg.dataDir}`);
  note('server', `answering on port ${cfg.port}`);
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use (is the map already running?)` : err.message);
  note('server', err.code === 'EADDRINUSE' ? `port ${cfg.port} is in use by another program` : 'the server could not start answering', { error: err.message });
  process.exit(err.code === 'EADDRINUSE' ? 3 : 1); // (3: watch.js gives up on this one, where it would otherwise wait for a fix)
});
