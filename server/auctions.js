// Auction prices, kept up by the map while it runs (see auctions/).
//
// A copy of the map only reads prices. They get into the Atlas database from a scheduled
// function in the cloud (functions/), once an hour, with nobody's computer on; this fetches the
// one house the copy is set to from there, and only while somebody is looking at prices: a copy
// nobody asks costs the database nothing. Nothing here goes to Blizzard.
//
// "Somebody" is the Prices page - or the game: where the box "Auctionator" on the page is ticked
// (standins.js), the addons there that ask Auctionator what an item costs are answered with
// these prices, so they are fetched while the game runs as well, and handed on each time
// (prices.js).
//
// The work is done by a program of its own (auctions/cli.js auto), so the map never waits for
// it, and nothing that goes wrong there touches the map.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../extractor/config.js';
import { AuctionStore } from '../auctions/store.js';
import { auctionSettings, setHouse } from '../auctions/settings.js';
import { HOUSES, REGION_NAMES, REGION_RULESETS, RULESETS, SIDES, housesOf, houseName, houseOf } from '../auctions/houses.js';
import { flavourFolder } from '../extractor/config.js';
import { listHouse, listRecipes, itemHistory } from '../auctions/view.js';
import { marketFigures, marketKey, sellingOf } from './market.js';
import { note } from './log.js';

const TICK = 5 * 60 * 1000;        // how often it is asked whether a fetch is due, while prices are being looked at
const HOUR = 3600;                 // Blizzard's lists: one an hour
const SLACK = 240;                 // seconds after the hour is up before the Atlas database is asked: the function in the cloud
                                   // runs about two minutes after Blizzard's new list is out, and takes half a minute
const ASKED_FOR = 20 * 60 * 1000;  // how long after the page last asked this goes on fetching

/**
 * The auction house of whoever plays here, where the game itself says enough: the region it is
 * set to (Config.wtf: SET portal "US"), the realm its characters are on (the folders under
 * WTF/Account/<account>, which are named by the realm's number: houses.js knows which ruleset
 * some of them are of) and the side of the character in the game now. Null where any of that
 * is not known, or where characters are kept on realms of more than one ruleset - then it is
 * for the player to choose, on the Prices page. Read only.
 * @param faction 'alliance' or 'horde': the side of the character in the game now
 */
export function guessHouse(cfg, faction) {
  try {
    if (faction !== 'alliance' && faction !== 'horde') return null;
    const folder = flavourFolder(cfg);
    if (!folder) return null;
    const wtf = path.join(cfg.installRoot, folder, 'WTF');
    const region = /^SET portal "([A-Za-z]{2})"/m.exec(fs.readFileSync(path.join(wtf, 'Config.wtf'), 'utf8'))?.[1].toLowerCase();
    if (!region || !REGION_RULESETS[region]) return null;
    const houses = new Set();
    for (const account of fs.readdirSync(path.join(wtf, 'Account'))) {
      let realms = [];
      try { realms = fs.readdirSync(path.join(wtf, 'Account', account)); } catch { continue; }
      for (const realm of realms) {
        if (!/^\d+$/.test(realm)) continue;
        // (a realm somebody plays on: with a character's folder in it)
        let played = false;
        try { played = fs.readdirSync(path.join(wtf, 'Account', account, realm), { withFileTypes: true }).some((d) => d.isDirectory()); } catch { /* not that one */ }
        if (played) houses.add(houseOf(region, realm, faction) ?? '?');
      }
    }
    return houses.size === 1 && !houses.has('?') ? [...houses][0] : null;
  } catch { return null; }
}

export class Auctions {
  /**
   * @param hold    () => true while the map is being built (the two are not run at once)
   * @param wanted  () => true while the prices are wanted without the page asking (the game is
   *                running, and they are handed on to it)
   * @param after   () => {} called each time a look has ended
   */
  constructor(cfg, configFile, { hold = () => false, wanted = () => false, after = () => {} } = {}) {
    this.cfg = cfg;
    this.configFile = configFile;
    this.hold = hold;
    this.wanted = wanted;
    this.after = after;
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
    const { on, house, auto } = this.settings;
    const now = house ? this.store.now(house) : null;
    return {
      on, house, name: house ? houseName(house) : null, auto,
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
    if (Date.now() - this.asked > ASKED_FOR && !this.#wanted()) return false; // (nobody is looking at prices)
    const listed = this.store.state().houses?.[this.settings.house]?.t ?? 0;
    if (!listed) return !this.state.last || Date.now() - this.state.last > TICK;
    // a new list is out an hour after the last one; where the last try found none, the next tick tries again
    return Date.now() / 1000 >= listed + HOUR + SLACK && (!this.state.last || Date.now() - this.state.last >= TICK - 5000);
  }

  #wanted() { try { return !!this.wanted(); } catch { return false; } }

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
      try { this.after(); } catch { /* whoever wanted to know could not take it */ }
    };
    child.on('close', done);
    child.on('error', (e) => { err += e.message; done(1); });
    return true;
  }

  /** Choose this copy's house: written to config.json, and fetched straight away. (auto: taken from the game - guessHouse - not chosen by anybody.) */
  setHouse(key, { auto = false } = {}) {
    this.settings = setHouse(this.cfg, this.configFile, key, { auto });
    this.asked = Date.now();
    this.state.last = null;
    this.run();
    return this.status();
  }

  #stampOf(rel) {
    try { const st = fs.statSync(this.store.file(rel)); return st.isDirectory() ? fs.readdirSync(this.store.file(rel)).map((f) => fs.statSync(this.store.file(rel, f)).mtimeMs).join(',') : String(st.mtimeMs); } catch { return ''; }
  }

  /** What the game's tooltip goes by (market.js), for this copy's own house - made anew when the prices or the figures change. */
  #figures() {
    try {
      const key = marketKey(this.cfg);
      if (!key) return null;
      if (this.figures?.key !== key) this.figures = { key, value: marketFigures(this.cfg) };
      return this.figures.value;
    } catch { return null; }
  }

  /**
   * How often a thing sells and how many a day, as the tooltip goes by them, put in the place of
   * TradeSkillMaster's figures in a list's rows (`rate`, `perDay`: the columns given) - for this
   * copy's own house; another house's list keeps TradeSkillMaster's. → true where they were put in
   */
  #ours(house, rows, item, rate, perDay) {
    if (house !== this.settings.house) return false;
    const own = this.#figures()?.houses[0];
    if (!own || own.key !== house) return false;
    for (const r of rows) {
      const f = own.items.get(r[item]);
      if (!f) continue;
      if (f.chance[24] !== null && f.chance[24] !== undefined) r[rate] = Math.round(f.chance[24] * 1000) / 1000;
      if (f.day !== null && f.day !== undefined) r[perDay] = Math.round(f.day * 10) / 10;
    }
    return true;
  }

  /** The house's list as the page takes it (JSON text), or null when nothing is kept of it yet. */
  list(house = this.settings.house) {
    if (!house) return null;
    let stamp;
    try { stamp = `${fs.statSync(this.store.file(house, 'now.json')).mtimeMs}:${this.#stampOf('tsm')}:${this.#stampOf('../items.json')}:${marketKey(this.cfg) ?? ''}`; } catch { return null; }
    const had = this.cache.get(house);
    if (had?.key === stamp) return had.text;
    const list = listHouse(this.store, this.cfg.dataDir, house);
    if (!list) return null;
    // (how often things sell: as the game's tooltip goes by it, where this is the copy's own house)
    list.ours = this.#ours(house, list.rows, 0, 12, 13);
    const text = JSON.stringify(list);
    this.cache.clear(); // (one house at a time is looked at: no use keeping the others)
    this.cache.set(house, { key: stamp, text });
    return text;
  }

  /** Every recipe costed at the house's prices (JSON text), or null when there is nothing to cost them with. */
  recipes(house = this.settings.house) {
    if (!house) return null;
    let stamp;
    try { stamp = `${fs.statSync(this.store.file(house, 'now.json')).mtimeMs}:${this.#stampOf('tsm')}:${this.#stampOf('../items.json')}:${this.#stampOf('../recipes.json')}:${marketKey(this.cfg) ?? ''}`; } catch { return null; }
    const had = this.crafts.get(house);
    if (had?.key === stamp) return had.text;
    const list = listRecipes(this.store, this.cfg.dataDir, house);
    if (!list) return null;
    list.ours = this.#ours(house, list.rows, 6, 13, 14);
    const text = JSON.stringify(list);
    this.crafts.clear();
    this.crafts.set(house, { key: stamp, text });
    return text;
  }

  item(id, house = this.settings.house) {
    if (!house || !Number.isInteger(id) || id <= 0) return null;
    const d = itemHistory(this.store, this.cfg.dataDir, house, id);
    // (what selling one brings, as the game's tooltip reckons it: for the copy's own house and its neutral one)
    if (d && house === this.settings.house) {
      const figures = this.#figures();
      if (figures) d.selling = { houses: sellingOf(figures, id, d.item?.sell ?? 0), credit: figures.credit };
    }
    return d;
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    try { this.child?.kill(); } catch { /* gone */ }
  }
}
