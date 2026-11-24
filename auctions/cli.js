#!/usr/bin/env node
// The auction prices by hand. The map does the last of these by itself while it runs.
//
// A copy of the map only ever READS prices: they are put into the Atlas database by a scheduled
// function in the cloud (functions/), and fetched from there. Nothing here goes to Blizzard.
//
//   node auctions/cli.js status            what this computer has of the auction houses
//   node auctions/cli.js house us-110      choose the house this copy shows ("houses" lists them)
//   node auctions/cli.js show <item>       an item's price now and day by day (its number, or part of its name)
//   node auctions/cli.js pull              fetch this copy's house from the Atlas database
//   node auctions/cli.js tsm               fetch TradeSkillMaster's public files for this copy's house
//   node auctions/cli.js houses [--check]  the houses; --check: hold each house's prices in the Atlas database
//                                          against TradeSkillMaster's file for it, to see that houses.js
//                                          still says which is which
//   node auctions/cli.js auto              what the map does by itself: pull, tsm, the lists of items and
//                                          recipes, delete what is too old
//
//   --house=us-110        another house than this copy's
//   --region=eu           houses: another region (us)
//   --json                auto: the outcome as one line of JSON (the last line written)
//   --config=path         another config.json
import path from 'node:path';
import { loadConfig, CONFIG_FILE } from '../extractor/config.js';
import { Casc } from '../extractor/casc/casc.js';
import { ensureItems, readItems } from '../extractor/jobs/items.js';
import { ensureRecipes, readRecipes } from '../extractor/jobs/recipes.js';
import { cacheStamp } from '../extractor/hotfix.js';
import { Rtdb } from '../atlasdb/rtdb.js';
import { LocalStore } from '../atlasdb/local.js';
import { databaseSettings } from '../atlasdb/settings.js';
import { signIn } from '../atlasdb/signin.js';
import { AuctionStore, KEEP_DAYS } from './store.js';
import { auctionSettings, setHouse } from './settings.js';
import { HOUSES, housesOf, houseName, neutralOf, parseHouse, tsmSlug } from './houses.js';
import { pullMarket, pullNow, pullSells } from './share.js';
import { unpack } from './pack.js';
import { refreshTsm, parseFile, HOUSE_FIELDS } from './tsm.js';
import { listHouse, itemHistory } from './view.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const words = args.filter((a) => !a.startsWith('--'));
const configFile = value('config') ? path.resolve(value('config')) : CONFIG_FILE;
const cfg = loadConfig(configFile);
const json = flag('json');
const log = json ? () => {} : (msg) => console.log(msg);
const command = words[0] ?? 'status';
const fail = (message, code = 1) => {
  if (json) console.log(JSON.stringify({ errors: [message] }));
  else console.error(message);
  process.exitCode = json ? 0 : code;
};
const settings = auctionSettings(cfg);
const store = new AuctionStore(cfg.dataDir);
const house = parseHouse(value('house'))?.key ?? settings.house;
/** 12345 copper → "1g 23s 45c" */
const money = (c) => { c = Math.round(c); if (!c) return '-'; const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100; return [g ? `${g}g` : '', g || s ? `${s}s` : '', `${k}c`].filter(Boolean).join(' '); };
const when = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** The Atlas database, signed in to as this copy (null: this copy uses none). */
async function atlas() {
  const s = databaseSettings(cfg);
  if (!s.url) return null;
  const me = s.apiKey ? await signIn(s.apiKey, new LocalStore(cfg.dataDir)) : null;
  return new Rtdb(s.url, { auth: me?.token ?? null });
}
const said = (err) => (err.status === 401 || err.status === 403 ? `the Atlas database does not let this copy do that (${err.server || `HTTP ${err.status}`})` : err.message);

/** The lists of items (names, kinds, stats) and of recipes, made again when the game has been sent new records. */
async function items() {
  const have = readItems(cfg.dataDir), book = readRecipes(cfg.dataDir);
  const stamp = cacheStamp(cfg);
  if (have && have.cache === stamp && book && book.cache === stamp) return { count: have.count, recipes: book.recipes.length, built: false };
  const casc = new Casc(cfg.installRoot, cfg.product);
  try {
    casc.root;
    const a = await ensureItems(casc, cfg, log), b = await ensureRecipes(casc, cfg, log);
    return { count: a?.count ?? 0, recipes: b?.count ?? 0, built: !!(a?.built || b?.built) };
  } finally { casc.close?.(); }
}

try {
  if (!settings.on) {
    fail('auction prices are switched off ("auctions": false in config.json)', 2);
  } else if (command === 'status') {
    console.log(house ? `this copy's house: ${house}, ${houseName(house)}` : 'no house chosen yet ("house us-110"; "houses" lists them)');
    for (const h of store.houses().sort()) {
      const now = store.now(h), days = store.days(h);
      if (!now) continue;
      console.log(`  ${h.padEnd(7)} ${houseName(h).padEnd(40)} ${String(Object.keys(now.items).length).padStart(6)} items, listed ${when(now.t)}, ${days.length} ${days.length === 1 ? 'day' : 'days'} kept (${days[0]} to ${days[days.length - 1]})`);
    }
    console.log(`prices come from the Atlas database; nothing is kept longer than ${KEEP_DAYS} days`);
  } else if (command === 'houses') {
    const region = value('region') ?? 'us';
    for (const k of housesOf(region)) console.log(`  ${k.padEnd(7)} ${houseName(k)}${HOUSES[parseHouse(k).id].taken ? '   (by its place in Blizzard\'s list: there is no file to hold it against)' : ''}`);
    if (flag('check')) {
      const db = await atlas();
      if (!db) fail('this copy uses no Atlas database', 2);
      else {
        // each house's lowest prices as the database has them now
        const lists = new Map();
        for (const k of housesOf(region)) lists.set(k, unpack(await db.get(`market/now/${k}`)));
        if (![...lists.values()].some((l) => Object.keys(l).length)) fail(`the Atlas database has no prices for ${region}`, 2);
        else {
          let wrong = 0, fit = 0, unchecked = 0;
          for (const k of housesOf(region)) {
            const slug = tsmSlug(k);
            if (!slug) continue;
            const res = await fetch(`https://public-data.tradeskillmaster.com/forever/${region}/realm/${slug}/items.csv`, { headers: { 'User-Agent': 'azeroth-atlas' } });
            await new Promise((done) => setTimeout(done, 2500)); // (one file after the other, unhurried: asked for many at once, TradeSkillMaster answers 429)
            if (res.status !== 200) { unchecked++; console.log(`  ${k}: not checked. TradeSkillMaster ${res.status === 404 ? `has no file "${slug}"` : `did not hand over "${slug}" (HTTP ${res.status})`}`); continue; }
            const file = parseFile(await res.text(), HOUSE_FIELDS);
            const scores = [...lists].map(([other, l]) => {
              let both = 0, same = 0;
              for (const [id, row] of Object.entries(file.items)) { const mine = l[id]; if (!mine) continue; both++; if (mine[0] === row[1]) same++; }
              return [other, same, both];
            }).sort((x, y) => y[1] - x[1]);
            const ok = scores[0][0] === k;
            if (ok) fit++; else wrong++;
            console.log(`  ${k} against TradeSkillMaster's "${slug}" (as of ${file.updated}): ${ok ? 'fits' : 'DOES NOT FIT'}. Same lowest price for ${scores[0][1]} of ${scores[0][2]} items in house ${scores[0][0]}; next best ${scores[1][0]} with ${scores[1][1]} of ${scores[1][2]}`);
          }
          console.log(wrong ? `${wrong} of the houses are NOT what houses.js says` : !fit ? `none of the houses could be checked (${unchecked} tried)` : `${fit} houses checked: each is what houses.js says${unchecked ? `; ${unchecked} could not be checked` : ''}`);
          if (wrong) process.exitCode = 1;
        }
      }
    }
  } else if (command === 'house') {
    if (!parseHouse(words[1])) fail(`house <key>: one of ${housesOf('us').join(', ')} (or the same in eu, kr, tw)`, 2);
    else { const s = setHouse(cfg, configFile, words[1]); console.log(`this copy's house is ${s.house}, ${houseName(s.house)}`); }
  } else if (command === 'pull') {
    const db = await atlas();
    if (!db) fail('this copy uses no Atlas database', 2);
    else if (!house) fail('no house chosen ("house us-110")', 2);
    else { const r = await pullMarket(db, store, house, log); log(r ? `have ${house} as listed ${when(r.t)}` : `${house} is not in the Atlas database (yet)`); }
  } else if (command === 'tsm') {
    if (!house) fail('no house chosen ("house us-110")', 2);
    else console.log(JSON.stringify(await refreshTsm(store, house, { force: flag('force'), log })));
  } else if (command === 'show') {
    if (!house) fail('no house chosen ("house us-110")', 2);
    else {
      const list = listHouse(store, cfg.dataDir, house);
      if (!list) fail(`nothing is kept of ${house} yet ("auto")`, 2);
      else {
        const want = words.slice(1).join(' ').toLowerCase();
        const hits = /^\d+$/.test(want) ? list.rows.filter((r) => r[0] === Number(want)) : list.rows.filter((r) => r[1].toLowerCase().includes(want));
        hits.sort((x, y) => (x[1].toLowerCase() === want ? -1 : 0) - (y[1].toLowerCase() === want ? -1 : 0) || y[9] - x[9]);
        console.log(`${list.name}, listed ${when(list.t)}: ${hits.length} of ${list.rows.length} items match`);
        for (const r of hits.slice(0, flag('all') ? hits.length : 12)) console.log(`  ${String(r[0]).padStart(6)} ${r[1].padEnd(38).slice(0, 38)} lowest ${money(r[6]).padStart(13)}  going ${money(r[7]).padStart(13)}  ${String(r[9]).padStart(6)} pieces in ${String(r[8]).padStart(5)} auctions${r[12] ? `  sells ${(r[12] * 100).toFixed(0)}% of the time, ${r[13]} a day (TSM, region)` : ''}`);
        if (hits.length === 1 || /^\d+$/.test(want)) {
          const h = itemHistory(store, cfg.dataDir, house, hits[0]?.[0] ?? Number(want));
          if (h.does) console.log(`    gives: ${[h.does.armor ? `${h.does.armor} Armor` : null, h.does.damage?.[2] ? `${h.does.damage[0]} - ${h.does.damage[1]} Damage, speed ${(h.does.damage[2] / 1000).toFixed(2)}` : null, ...h.does.stats.map(([w, v]) => `${v < 0 ? '' : '+'}${v} ${w}`)].filter(Boolean).join(', ')}`);
          for (const m of h.made) console.log(`    made by ${m.skill}: ${m.parts.map((p) => `${p[3]} ${p[1]}`).join(', ')}; costs ${m.missing ? `${money(m.cost)} and ${m.missing} with no price` : money(m.cost)}${m.value ? `, goes for ${money(m.value)}` : ''}`);
          for (const d of h.days) console.log(`    ${d[0]}: going price ${money(d[1])} to ${money(d[2])}, last ${money(d[3])}; lowest asked ${money(d[4])}; ${d[5]} pieces`);
          console.log(`    ${h.hours.length} looks kept: ${h.hours.slice(-8).map((x) => `${when(x[0]).slice(11, 16)} ${money(x[2])}`).join(' | ')}`);
          if (h.tsm.house) console.log(`    TradeSkillMaster, this house (as of ${h.tsm.house.updated}): market value ${money(h.tsm.house.marketValue)}, lowest ${money(h.tsm.house.minBuyout)}, long-run average ${money(h.tsm.house.historical)}`);
          if (h.tsm.region) console.log(`    TradeSkillMaster, region: market value ${money(h.tsm.region.marketValue)}, average sale ${money(h.tsm.region.avgSalePrice)}, sells ${(h.tsm.region.saleRate * 100).toFixed(0)}% of the time, ${h.tsm.region.soldPerDay} a day`);
        }
      }
    }
  } else if (command === 'auto') {
    // each step on its own: one that fails does not stop the next
    const out = { errors: [] };
    const step = async (name, fn) => { try { out[name] = await fn(); } catch (err) { out.errors.push(`${name}: ${said(err)}`); } };
    if (house) {
      let asked = null;
      const db = () => (asked ??= atlas()); // (signed in once for all of it)
      await step('pull', async () => { const d = await db(); return d ? pullMarket(d, store, house, log) : null; });
      // the neutral house that goes with this one: what it holds now (its prices, for what an item would fetch there)
      const neutral = neutralOf(house);
      if (neutral && neutral !== house) await step('neutral', async () => { const d = await db(); return d ? pullNow(d, store, neutral) : null; });
      // what sells, as measured in the cloud: here, at the neutral house, and in the region's houses together
      await step('sells', async () => {
        const d = await db();
        if (!d) return null;
        const got = {};
        for (const key of new Set([house, neutral, `all-${parseHouse(house).region}`].filter(Boolean))) got[key] = (await pullSells(d, store, key))?.fetched ?? null;
        return got;
      });
      await step('tsm', () => refreshTsm(store, house, { log }));
    }
    await step('items', items);
    await step('pruned', async () => store.prune());
    out.house = house;
    out.t = house ? store.now(house)?.t ?? null : null;
    console.log(json ? JSON.stringify(out) : JSON.stringify(out, null, 1));
  } else {
    fail(`unknown command "${command}": status, house, houses, show, pull, tsm, auto`, 2);
  }
} catch (err) {
  fail(said(err));
}
