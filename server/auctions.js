// Auction prices, kept up by the map while it runs (see auctions/).
//
// A copy of the map only reads prices. They get into the Atlas database from a scheduled
// function in the cloud (functions/), once an hour, with nobody's computer on; this fetches the
// one house the copy is set to from there, and only while somebody is looking at prices: a copy
// nobody asks costs the database nothing. Nothing here goes to Blizzard.
//
// The work is done by a program of its own (auctions/cli.js auto), so the map never waits for
// it, and nothing that goes wrong there touches the map.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../extractor/config.js';
import { AuctionStore } from '../auctions/store.js';
import { auctionSettings, setHouse } from '../auctions/settings.js';
import { HOUSES, REGION_NAMES, REGION_RULESETS, RULESETS, SIDES, housesOf, houseName } from '../auctions/houses.js';
import { listHouse, listRecipes, itemHistory } from '../auctions/view.js';
import { note } from './log.js';

const TICK = 5 * 60 * 1000;        // how often it is asked whether a fetch is due, while prices are being looked at
const HOUR = 3600;                 // Blizzard's lists: one an hour
const SLACK = 240;                 // seconds after the hour is up before the Atlas database is asked: the function in the cloud
                                   // runs about two minutes after Blizzard's new list is out, and takes half a minute
const ASKED_FOR = 20 * 60 * 1000;  // how long after the page last asked this goes on fetching

export class Auctions {
  /** @param hold () => true while the map is being built (the two are not run at once) */
  constructor(cfg, configFile, { hold = () => false } = {}) {
    this.cfg = cfg;
    this.configFile = configFile;
    this.hold = hold;
    this.settings = auctionSettings(cfg);
    this.store = new AuctionStore(cfg.dataDir);
    this.state = { running: false, last: null, result: null, error: null };
    this.asked = 0;
    this.child = null;
    this.timers = [];
    this.cache = new Map();  // house → { key, text }: the list as last sent to the page
    this.crafts = new Map(); // and the recipes costed, likewise
  }

  status() {
    const { on, house } = this.settings;
    const now = house ? this.store.now(house) : null;
    return {
      on, house, name: house ? houseName(house) : null,
      t: now?.t ?? null, items: now ? Object.keys(now.items).length : 0,
      ...this.state,
    };
  }

  /** The houses there are to choose from, region by region. */
  houses() {
    return Object.keys(REGION_RULESETS).map((region) => ({
      region, name: REGION_NAMES[region],
      houses: housesOf(region).map((key) => { const h = HOUSES[key.slice(3)]; return { key, name: `${RULESETS[h.ruleset].name} · ${SIDES[h.side]}` }; }),
    }));
  }

  #due() {
    if (!this.settings.on || !this.settings.house || this.state.running || this.hold()) return false;
    if (Date.now() - this.asked > ASKED_FOR) return false; // (nobody is looking at prices)
    const listed = this.store.state().houses?.[this.settings.house]?.t ?? 0;
    if (!listed) return !this.state.last || Date.now() - this.state.last > TICK;
    // a new list is out an hour after the last one; where the last try found none, the next tick tries again
    return Date.now() / 1000 >= listed + HOUR + SLACK && (!this.state.last || Date.now() - this.state.last >= TICK - 5000);
  }

  start() {
    if (!this.settings.on) return;
    const tick = setInterval(() => { if (this.#due()) this.run(); }, TICK);
    tick.unref?.();
    this.timers.push(tick);
  }

  /** The Prices page asked for something: the house is fetched, if it is time. */
  touch() {
    this.asked = Date.now();
    if (this.#due()) this.run();
  }

  run() {
    if (!this.settings.on || this.state.running || this.hold()) return false;
    this.state.running = true;
    const args = [path.join(PROJECT_ROOT, 'auctions', 'cli.js'), 'auto', '--json', `--config=${this.configFile}`];
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
      this.state.result = result ? { pulled: result.pull?.fetched ?? 0, tsm: result.tsm ?? null, t: result.t ?? null } : null;
      this.state.error = result?.errors?.length ? result.errors.join('; ') : code ? (err.trim().split('\n').pop() || `ended with code ${code}`) : null;
      note('auctions', this.state.error ? 'auction prices: something went wrong' : 'auction prices: looked', { error: this.state.error ?? undefined, result: this.state.result ?? undefined, code: code || undefined, said: this.state.error ? err.slice(-800) : undefined });
    };
    child.on('close', done);
    child.on('error', (e) => { err += e.message; done(1); });
    return true;
  }

  /** Choose this copy's house: written to config.json, and fetched straight away. */
  setHouse(key) {
    this.settings = setHouse(this.cfg, this.configFile, key);
    this.asked = Date.now();
    this.state.last = null;
    this.run();
    return this.status();
  }

  #stampOf(rel) {
    try { const st = fs.statSync(this.store.file(rel)); return st.isDirectory() ? fs.readdirSync(this.store.file(rel)).map((f) => fs.statSync(this.store.file(rel, f)).mtimeMs).join(',') : String(st.mtimeMs); } catch { return ''; }
  }

  /** The house's list as the page takes it (JSON text), or null when nothing is kept of it yet. */
  list(house = this.settings.house) {
    if (!house) return null;
    let stamp;
    try { stamp = `${fs.statSync(this.store.file(house, 'now.json')).mtimeMs}:${this.#stampOf('tsm')}:${this.#stampOf('../items.json')}`; } catch { return null; }
    const had = this.cache.get(house);
    if (had?.key === stamp) return had.text;
    const list = listHouse(this.store, this.cfg.dataDir, house);
    if (!list) return null;
    const text = JSON.stringify(list);
    this.cache.clear(); // (one house at a time is looked at: no use keeping the others)
    this.cache.set(house, { key: stamp, text });
    return text;
  }

  /** Every recipe costed at the house's prices (JSON text), or null when there is nothing to cost them with. */
  recipes(house = this.settings.house) {
    if (!house) return null;
    let stamp;
    try { stamp = `${fs.statSync(this.store.file(house, 'now.json')).mtimeMs}:${this.#stampOf('tsm')}:${this.#stampOf('../items.json')}:${this.#stampOf('../recipes.json')}`; } catch { return null; }
    const had = this.crafts.get(house);
    if (had?.key === stamp) return had.text;
    const list = listRecipes(this.store, this.cfg.dataDir, house);
    if (!list) return null;
    const text = JSON.stringify(list);
    this.crafts.clear();
    this.crafts.set(house, { key: stamp, text });
    return text;
  }

  item(id, house = this.settings.house) {
    if (!house || !Number.isInteger(id) || id <= 0) return null;
    return itemHistory(this.store, this.cfg.dataDir, house, id);
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    try { this.child?.kill(); } catch { /* gone */ }
  }
}
