// The Atlas database, kept up by the map while it runs (see atlasdb/): what this copy has
// learned about the game world is sent on, and the database as published is fetched.
//
// It runs a little after the map starts, again whenever the game has written its cache (it
// does when you log out or leave the game) or you have seen an NPC for yourself, and every six
// hours besides. The work is done by a program of its own (atlasdb/cli.js auto), so the map
// never waits for it, and nothing that goes wrong there touches the map.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, flavourFolder, readConfigFile } from '../extractor/config.js';
import { databaseSettings } from '../atlasdb/settings.js';

const FIRST = 90 * 1000;          // after the map has started
const LOOK = 10 * 60 * 1000;      // how often the game's cache is looked at for a change
const ANYWAY = 6 * 3600 * 1000;   // and at least this often
const SOON = 5 * 60 * 1000;       // after something new was seen

export class AtlasDb {
  /** @param hold () => true while the map is being built (the two are not run at once) */
  constructor(cfg, configFile, { hold = () => false } = {}) {
    this.cfg = cfg;
    this.configFile = configFile;
    this.hold = hold;
    this.settings = databaseSettings(cfg);
    this.state = { running: false, last: null, result: null, error: null };
    this.stamp = null;
    this.child = null;
    this.timers = [];
  }

  status() {
    const { url, share, maintain } = this.settings;
    return { on: !!url, share, maintain, ...this.state };
  }

  /** The game's cache files as they are now: their sizes and when they were written. */
  #cacheStamp() {
    const folder = flavourFolder(this.cfg);
    if (!folder) return '';
    const root = path.join(this.cfg.installRoot, folder, 'Cache', 'WDB');
    let out = '';
    try {
      for (const lang of fs.readdirSync(root)) {
        for (const f of ['creaturecache.wdb', 'gameobjectcache.wdb', 'questcache.wdb']) {
          try { const st = fs.statSync(path.join(root, lang, f)); out += `${lang}/${f}:${st.size}:${Math.round(st.mtimeMs)};`; } catch { /* not there */ }
        }
      }
    } catch { /* no cache yet */ }
    return out;
  }

  start() {
    if (!this.settings.url) return;
    const later = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); this.timers.push(t); };
    later(FIRST, () => this.run());
    const look = setInterval(() => {
      const due = !this.state.last || Date.now() - this.state.last > ANYWAY;
      if (due || this.#cacheStamp() !== this.stamp) this.run();
    }, LOOK);
    look.unref?.();
    this.timers.push(look);
  }

  /** Something new was seen: send it before long (several in a row make one delivery). */
  nudge() {
    if (!this.settings.url || this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.run(); }, SOON);
    this.soon.unref?.();
  }

  run() {
    if (!this.settings.url || this.state.running || this.hold()) return false;
    this.state.running = true;
    this.stamp = this.#cacheStamp();
    const args = [path.join(PROJECT_ROOT, 'atlasdb', 'cli.js'), 'auto', '--json', `--config=${this.configFile}`];
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let out = '', err = '';
    child.stdout.on('data', (c) => { out = (out + c).slice(-20000); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    const done = (code) => {
      if (!this.state.running) return;
      this.state.running = false;
      this.state.last = Date.now();
      this.child = null;
      let result = null;
      for (const line of out.trim().split('\n').reverse()) { try { result = JSON.parse(line); break; } catch { /* not the result line */ } }
      this.state.result = result;
      this.state.error = result?.errors?.length ? result.errors.join('; ') : code ? (err.trim().split('\n').pop() || `ended with code ${code}`) : null;
    };
    child.on('close', done);
    child.on('error', (e) => { err += e.message; done(1); });
    return true;
  }

  /** Send what this copy learns, or keep it to itself: written to config.json, and held to from now on. */
  setShare(on) {
    let file = {};
    try { file = readConfigFile(this.configFile); } catch { /* a new one */ }
    const db = file.database && typeof file.database === 'object' ? file.database : {};
    file.database = { ...db, share: !!on };
    fs.writeFileSync(this.configFile, JSON.stringify(file, null, 2) + '\n');
    this.cfg.database = file.database;
    this.settings = databaseSettings(this.cfg);
    return this.status();
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    if (this.soon) clearTimeout(this.soon);
    try { this.child?.kill(); } catch { /* gone */ }
  }
}
