#!/usr/bin/env node
// Runs the map server and keeps it current: whenever the server's own code changes on disk (an
// update of the map), the server is stopped and started again, by itself. The map page looks
// after itself in the same way (server/changes.js, viewer/js/reload.js), so after an update
// there is nothing to restart or reload by hand. "Start Map.bat" and "npm start" run this.
//
//   node server/watch.js [--open] [--config=path/to/config.json]
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../extractor/config.js';
import { openLogs, logDir, note, noteCrashes } from './log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(HERE, 'server.js');
const PORT_TAKEN = 3;   // the server's way of saying another copy is already running (see server.js)
const AGAIN = 75;       // this watcher's way of asking Start Map.bat to start it again (its own code has changed)
const SELF = fileURLToPath(import.meta.url);
const SETTLE_MS = 350;  // an update writes several files: wait until it has gone quiet
const args = process.argv.slice(2);
const configArg = args.find((a) => a.startsWith('--config='));
// (where the settings are: beside the map tool - or, in the installed application, where it keeps what is yours)
const CONFIG = configArg ? path.resolve(configArg.slice(9)) : CONFIG_FILE;
// What the server is made of: its own folder, and the code it shares with the extractor, the
// Atlas database and the auction prices (it runs parts of each inside itself).
const FOLDERS = [path.join(ROOT, 'server'), path.join(ROOT, 'extractor'), path.join(ROOT, 'atlasdb'), path.join(ROOT, 'auctions')];
const CODE = /\.(js|mjs|cs)$/i;
const NOT_CODE = /(^|[\\/])(\.build|node_modules)([\\/]|$)/;

// (what is said here is noted as well: log.js)
openLogs(logDir(CONFIG));
noteCrashes('the map\'s starter');
const say = (text) => { console.log(`[${new Date().toLocaleTimeString()}] ${text}`); note('starter', text); };
if (+process.versions.node.split('.')[0] < 20) {
  console.error(`Node.js ${process.versions.node} is too old for the map: it needs version 20 or newer. Install the LTS version from https://nodejs.org and start the map again.`);
  process.exit(1);
}
let child = null;      // the server running now
let opened = false;    // the browser has been opened (once is enough)
let busy = false;      // the server is in the middle of a map update: not to be interrupted
let waiting = false;   // a restart is owed once it is no longer busy
let stopping = false;  // the server has been asked to make way
let quitting = false;
let renew = false;     // this file itself has changed (an update of the map tool): to be started afresh
let timer = 0;

function start() {
  const mine = fork(SERVER, args.filter((a) => a !== '--open' || !opened), { cwd: ROOT, stdio: 'inherit' });
  child = mine;
  opened = true;
  busy = false;
  mine.on('message', (m) => {
    if (child !== mine || typeof m?.busy !== 'boolean') return;
    busy = m.busy;
    process.send?.({ busy }); // (the application, where it is what runs this, waits with starting itself again too)
    if (!busy && waiting) restart();
  });
  mine.on('exit', (code, signal) => {
    if (child !== mine) return;
    child = null;
    note('starter', 'the map server has gone', { code, signal, wanted: quitting || stopping || waiting });
    if (quitting) return;
    if (stopping || waiting) { stopping = false; waiting = false; start(); return; }
    if (code === PORT_TAKEN) { quitting = true; process.exitCode = 1; for (const w of watchers) w.close(); return; }
    say(code ? 'The map server stopped on an error (above). It starts again as soon as its files change.' : 'The map server has stopped. It starts again as soon as its files change.');
  });
}

/** This watcher's own code has changed: the server is put away and Start Map.bat starts everything again. */
function relaunch() {
  // (Start Map.bat starts it again on this; run by hand - npm start - it is for you to start again)
  say('The map\'s own starter has been updated: starting everything again. (If nothing follows, start the map again yourself.)');
  quitting = true;
  for (const w of watchers) w.close();
  const go = () => process.exit(AGAIN);
  const mine = child;
  if (!mine) { go(); return; }
  mine.once('exit', go);
  try { mine.send({ stop: true }); } catch { /* it is going anyway */ }
  setTimeout(() => { try { mine.kill(); } catch { /* gone */ } setTimeout(go, 300); }, 2500);
}

function restart() {
  waiting = false;
  if (quitting || stopping) return;
  if (renew) {
    if (busy) { waiting = true; return; }
    relaunch();
    return;
  }
  if (!child) { say('The map has changed: starting the server.'); start(); return; }
  if (busy) { waiting = true; say('The map has changed: the server starts again once the map update it is running has finished.'); return; }
  stopping = true;
  say('The map has changed: starting the server again.');
  const mine = child;
  // (asked first, so that it can put its helper away; made to, should it not answer)
  try { mine.send({ stop: true }); } catch { /* it is going anyway */ }
  setTimeout(() => { if (child === mine) mine.kill(); }, 2500);
}

// What the server is made of, as it stands on the disk: the name, size and date of every file of
// its code, and of the settings. Windows tells a watcher of a file that was only READ, too (it
// keeps the time a file was last read, an hour at a time): so being told is only a reason to
// look, and the server is started again only where something has been written. (Once, it started
// itself again four times every hour, and "Report a problem", which reads every file of the map
// tool, took the whole application down with it.)
function stamp() {
  const lines = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = rel + e.name;
      if (NOT_CODE.test(name)) continue;
      if (e.isDirectory()) { walk(path.join(dir, e.name), `${name}/`); continue; }
      if (!CODE.test(e.name)) continue;
      try { const st = fs.statSync(path.join(dir, e.name)); lines.push(`${dir}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`); } catch { /* gone again */ }
    }
  };
  for (const dir of FOLDERS) walk(dir, '');
  try { const st = fs.statSync(CONFIG); lines.push(`${CONFIG}|${st.size}|${Math.floor(st.mtimeMs)}`); } catch { lines.push(`${CONFIG}|not there`); }
  return lines.sort().join('\n');
}
const own = () => { try { const st = fs.statSync(SELF); return `${st.size}|${Math.floor(st.mtimeMs)}`; } catch { return ''; } };
let made = stamp(), madeOwn = own();
const look = () => {
  const now = stamp();
  if (now === made) return; // (read, not written)
  made = now;
  if (own() !== madeOwn) renew = true;
  restart();
};
const changed = () => { clearTimeout(timer); timer = setTimeout(look, SETTLE_MS); };
const watchers = [];
for (const dir of FOLDERS) {
  try {
    watchers.push(fs.watch(dir, { recursive: true }, (event, name) => {
      if (name && CODE.test(name) && !NOT_CODE.test(name)) changed();
    }));
  } catch (err) { say(`Cannot watch ${dir} for changes (${err.message}): after an update there, close this window and start the map again.`); }
}
try {
  // (a file is watched through its folder: editors replace files, and a watch on the file itself would be lost)
  watchers.push(fs.watch(path.dirname(CONFIG), (event, name) => { if (name && name.toLowerCase() === path.basename(CONFIG).toLowerCase()) changed(); }));
} catch { /* the settings file is read when the server starts */ }

// (asked first, so that the server can put its helpers away; made to, should it not answer)
const quit = () => {
  if (quitting) return;
  quitting = true;
  note('starter', 'closing: the map server is put away');
  const mine = child;
  if (!mine) process.exit(0);
  mine.once('exit', () => process.exit(0));
  try { mine.send({ stop: true }); } catch { /* it is going anyway */ }
  setTimeout(() => { try { mine.kill(); } catch { /* gone */ } process.exit(0); }, 2000);
};
// Run by the application (app/main.cjs): told to go when its window is closed, and not left behind should it go without saying.
if (process.send) {
  process.on('message', (m) => { if (m?.quit) quit(); });
  process.on('disconnect', quit);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
start();
