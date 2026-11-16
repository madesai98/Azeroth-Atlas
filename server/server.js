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
import { findQuestieDb, questieStamp } from '../extractor/questie.js';
import { PlayerTracker } from './tracker.js';
import { addonStatus, installAddon, convertGuides, flavourFolder, addonsDir } from './addon.js';
import { SeenStore } from './seen.js';
import { RouteMail, NAME as ADDON } from './mail.js';
import { OLD as OLD_ADDON, legacyInstalled } from './legacy.js';
import { Changes } from './changes.js';
import { AppUpdate } from './appupdate.js';
import { MIME, sendFile, safeJoin } from './http.js';
import { AtlasDb } from './atlasdb.js';
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
// The map tool keeps itself current (appupdate.js). While it writes its files, and while a map
// build runs, server/watch.js is asked not to start the server again.
const job = { running: false, phase: '', done: 0, total: 0, log: [], summary: null, error: null, startedAt: null, finishedAt: null };
let updating = false;
const busy = () => process.send?.({ busy: job.running || updating });
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
const atlas = new AtlasDb(cfg, configFile, { hold: () => job.running });
atlas.start();
// What things cost at the auction house, and how that has moved (see auctions.js).
const auctions = new Auctions(cfg, configFile, { hold: () => job.running });
auctions.start();
const VIEWER_DIR = path.join(PROJECT_ROOT, 'viewer');
// The page's own files, watched: a page that is open loads itself again when they change (changes.js).
const changes = new Changes(VIEWER_DIR);
// "Report a problem": everything that may explain one, in a zip (report.js)
const reports = new Reports({ configFile, cfg, live: { status: () => status(), tracker, mail, atlas, auctions, addon: () => addonStatus(cfg) } });
note('server', 'the settings in use', { game: cfg.installRoot, found: !!cfg.foundGame, flavour: flavourFolder(cfg), data: cfg.dataDir, port: cfg.port, ingame: cfg.ingame !== false, autoUpdate: cfg.autoUpdate ?? true, oldAddonInUse: oldAddon });

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
  // Creature data (spawn zones, NPCs, quests) comes from the QuestieDB addon, which updates on its own
  // schedule: flag it when the installed copy differs from the one the map was built from.
  let creatureStamp = null;
  try { creatureStamp = questieStamp(findQuestieDb(cfg)); } catch { /* treated as not installed */ }
  const newBuild = !!installed && (!manifest || manifest.build.buildKey !== installed.buildKey);
  const newCreatureData = !!installed && !!manifest && !!creatureStamp && manifest.questie?.stamp !== creatureStamp;
  // The map tool itself has been updated since the map was built, and builds some of it differently
  // now (extractor/stamp.js): the page goes on working with the map as it is, and offers to build it again.
  const newTool = !!installed && !!manifest && manifest.tool !== DATA_STAMP;
  return {
    installed, installError,
    extracted: manifest ? { build: manifest.build, revision: manifest.revision, extractedAt: manifest.extractedAt, formatVersion: manifest.formatVersion } : null,
    updateAvailable: newBuild || newCreatureData || newTool,
    updateReason: newBuild ? 'build' : newCreatureData ? 'creatures' : newTool ? 'tool' : null,
    job: { ...job, child: undefined },
    app: appUpdate.status(),
    game: { folder: cfg.installRoot, found: !!cfg.foundGame },
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
  if (p === '/api/database') {
    // the Atlas database: what this copy sends and has fetched (?share=0 or 1: keep what it learns to itself, or send it; ?run=1: now)
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET') { json(200, atlas.status()); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    try {
      if (url.searchParams.has('share')) atlas.setShare(url.searchParams.get('share') === '1');
      if (url.searchParams.get('run') === '1') atlas.run();
      json(200, atlas.status());
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
    // (/guides: "Convert guide packs", see addon.js)
    const install = p.endsWith('/install'), guides = p.endsWith('/guides');
    if (install || guides) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end(); return; }
    }
    try {
      const st = install ? installAddon(cfg, { gameSeen: ['live', 'minimized', 'nosignal'].includes(tracker.state.status) }) : guides ? convertGuides(cfg) : addonStatus(cfg);
      if (install) mail.use(ADDON);
      if (install) note('addon', `the addon was installed in the game's folder: version ${st.installedVersion ?? '?'}`, { restartNeeded: st.restart, carriedOver: st.carried ?? undefined, current: st.current, mailboxes: st.mail });
      else if (guides) note('addon', 'guide packs were converted', { done: st.done });
      else if (changedAddon(st)) note('addon', 'the addon in the game\'s folder', { installed: st.installed, version: st.installedVersion, brought: st.version, current: st.current, mailboxes: st.mail, oldCopy: st.legacy || undefined, guides: st.guides, why: st.reason });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(st));
    } catch (err) {
      note('addon', install ? 'the addon could not be installed' : guides ? 'guide packs could not be converted' : 'the addon could not be looked at', { error: err.message });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
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
  const leave = () => { note('server', 'asked to make way: its code has changed, or the application is closing'); try { tracker.stop(); } catch { /* going anyway */ } try { atlas.stop(); } catch { /* going anyway */ } try { auctions.stop(); } catch { /* going anyway */ } try { if (job.running) job.child?.kill(); } catch { /* gone */ } process.exit(0); };
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
