// What things fetch at the auction houses and how often they sell, handed on to the addon in the
// game - which says, in an item's tooltip, what to do with a thing you are getting rid of: sell
// it to a vendor, put it up at your side's auction house or the neutral one, or disenchant it
// (addon/AzerothAtlas/Advice.lua).
//
// For every item, at this copy's own house and at the neutral house that goes with it:
//
//   the price        what the cheap end of the market asks for one piece now (the going price),
//                    and the lowest anybody asks. Not for sale just now at your own house: the
//                    last going price of the last day it was, with how many days ago that is.
//   how often        it sells of the times it is put up, for 2, 8 and 24 hours (auctions/sells.js:
//                    chances) - from our own following of every auction of the house (the function
//                    in the cloud: functions/track.js), leaned on the same for the region's houses
//                    together, leaned on TradeSkillMaster's figure for the region where this copy
//                    has it. And which of the three carries it, so that the game can say.
//
// Two things a list of auctions cannot be taken at its word for, and what is done about each:
//
//   an asking price is not a selling price. One auction in four asks half as much again as the
//   thing sells for, and where only one or two are up, one in ten asks ten times it (measured on
//   a house of 6,700 items, 23 November 2026). So the price is reckoned at no more than ASK_MOST
//   times what the thing sells for - TradeSkillMaster's average sale price of the region where
//   this copy has it, else the middle of our own days' prices at the house (four days or more).
//   The lowest price asked is handed on as it is, so that the game can say where the two part.
//
//   a sale rate from next to no sales says nothing ("sells every time": it sold once). So
//   TradeSkillMaster's rate counts by how many it has seen sold in a day: at SOLD_ENOUGH a day
//   for half, with the rest made up of what is usual for things that hardly sell (SLOW_RATE: the
//   middle of its own figures for things selling less than once a day, same measurement).
//
// The neutral houses have no figure from elsewhere: nobody publishes any. What is known of how
// often a thing sells there is our own readings of that house and nothing else - until there are
// enough, it is "not known", and the addon does not send anybody there on a guess.
//
// And what disenchanting gives, as the players of every copy found it: the Atlas database has it
// band by band (atlasdb/yields.js), and it goes to the game with the prices, for the addon to
// lean the original game's tables on.
//
// What an auction costs - the house's cut, the deposit by length - goes with it (auctions/
// houses.js: HOUSE_COSTS), so that a figure corrected here is corrected in the game without a
// new addon.
//
// The game can be handed nothing while it runs but what it loads itself. So, as with the drop
// rates and what quests give, it is written as a small addon of its own beside Azeroth Atlas,
// AzerothAtlas_Market: one file that sets it all, which the game loads before Azeroth Atlas.
// Taken up the next time the game loads its addons: when it starts, or on /reload (the folder
// itself is only found when the game starts). Written when the map starts and each time the
// prices have been fetched.
//
// What is read from Blizzard's lists may be kept thirty days and no longer (auctions/days.js):
// a list older than that is not handed on, and one that was is taken out of the file again.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { AuctionStore, KEEP_DAYS, dayOf, dayStart } from '../auctions/store.js';
import { auctionSettings } from '../auctions/settings.js';
import { parseHouse, neutralOf, costsOf, SIDES, RULESETS } from '../auctions/houses.js';
import { chances, DURATIONS, FIGURES } from '../auctions/sells.js';
import { readTsm } from '../auctions/tsm.js';
import { readYields } from '../atlasdb/yields.js';
import { addonsDir } from './addon.js';

const NAME = 'AzerothAtlas', MARKET = 'AzerothAtlas_Market';
const FORMAT = 1;          // of what is written: raise when the addon is to read it differently
const COPPER_MOST = 1e12;  // a price above this is no price
const FROM = { house: 1, region: 2, prior: 3 };
const ASK_MOST = 2;        // an asking price is reckoned at no more than this many times what the thing sells for
const OWN_DAYS = 4;        // days of our own prices it takes for their middle to stand for "what it sells for"
const SOLD_ENOUGH = 0.5;   // sold in a day (TradeSkillMaster's count) at which its sale rate counts for half
const SLOW_RATE = 0.15;    // how often a thing sells of which next to none are seen sold

/** TradeSkillMaster's sale rate as far as it can be leaned on: by how many it has seen sold in a day (null: it has none). */
export function soundRate(rate, perDay) {
  if (!(rate > 0)) return null;
  const w = perDay > 0 ? perDay / (perDay + SOLD_ENOUGH) : 0;
  return Math.min(1, w * Math.min(1, rate) + (1 - w) * SLOW_RATE);
}
const middle = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const yieldsFile = (cfg) => path.join(cfg.dataDir, 'atlasdb', 'truth-yield.json');
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };
const copper = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < COPPER_MOST ? Math.round(v) : 0);
/** A text as Lua writes one: between double quotes, with nothing in it that would end it early. */
const luaText = (s) => '"' + String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** The houses a copy's figures are of: its own, and the neutral one that goes with it (one house, where its own is the neutral one). */
function housesOf(cfg) {
  const { on, house } = auctionSettings(cfg);
  if (!on || !parseHouse(house)) return [];
  const neutral = neutralOf(house);
  return neutral && neutral !== house ? [house, neutral] : [house];
}

/** What the figures are made from, as it stands on the disk: another text for other prices or other figures - or null (no house chosen). */
export function marketKey(cfg) {
  const houses = housesOf(cfg);
  if (!houses.length) return null;
  const store = new AuctionStore(cfg.dataDir), region = parseHouse(houses[0]).region;
  const files = [...houses.flatMap((h) => [store.file(h, 'now.json'), store.file(h, 'sell.json')]), store.file(`all-${region}`, 'sell.json'), store.file('tsm', `${region}-region.json`), yieldsFile(cfg)];
  // (the day counts too: a price of a day gone by is a day older tomorrow)
  return `${FORMAT}|${houses.join(',')}|${files.map(stampOf).join('|')}|${store.days(houses[0]).at(-1) ?? ''}|${Math.floor(Date.now() / 86400000)}`;
}

/**
 * The figures as they stand: { houses: [{ key, side, name, t, cut, deposit, items: Map<item,
 * { price, low, age, chance: { 2, 8, 24 } (0..1 or null), from (1 our readings of the house, 2 of
 * the region, 3 a figure from elsewhere, 0 not known) }> }], credit (true: TradeSkillMaster's
 * figure is among what is handed on), yields: Map<band, { n, got: [[material, pieces]] }> (what
 * disenchanting gave, by every copy's count) } - or null (no house chosen, or nothing fetched yet that
 * may still be handed on).
 */
export function marketFigures(cfg, now = Date.now() / 1000) {
  const keys = housesOf(cfg);
  if (!keys.length) return null;
  const store = new AuctionStore(cfg.dataDir), region = parseHouse(keys[0]).region;
  const young = (x) => x && typeof x.t === 'number' && x.t >= now - KEEP_DAYS * 86400 && x.items && typeof x.items === 'object';
  const tsm = readTsm(store, keys[0]).region;
  const rate = tsm?.fields?.indexOf('saleRate') ?? -1, perDay = tsm?.fields?.indexOf('soldPerDay') ?? -1, sale = tsm?.fields?.indexOf('avgSalePrice') ?? -1;
  // (our own days at the copy's house: every day's last going price, for the middle of them)
  const days = new Map();
  for (const day of store.days(keys[0])) {
    const line = store.day(keys[0], day);
    if (!line?.items || !(line.t >= now - KEEP_DAYS * 86400)) continue;
    for (const [id, r] of Object.entries(line.items)) if (copper(r?.[2])) { let l = days.get(Number(id)); if (!l) days.set(Number(id), (l = [])); l.push(copper(r[2])); }
  }
  /** What the thing sells for, as far as that is known: the most an asking price is reckoned at - or nothing. */
  const most = (item) => {
    const sold = sale >= 0 ? copper(tsm.items?.[item]?.[sale]) : 0;
    if (sold) return ASK_MOST * sold;
    const own = days.get(item);
    return own && own.length >= OWN_DAYS ? ASK_MOST * middle(own) : 0;
  };
  // (our own readings: only of this making of the figures - sells.js: FIGURES)
  const ours = (x) => (young(x) && x.v === FIGURES ? x.items : {});
  const all = ours(store.sells(`all-${region}`));
  let credit = false;
  const houses = [];
  for (const key of keys) {
    const h = parseHouse(key), list = store.now(key);
    const items = new Map();
    const neutral = h.side === 'neutral';
    if (young(list)) {
      for (const [id, e] of Object.entries(list.items)) {
        const item = Number(id);
        if (!Number.isInteger(item) || item <= 0 || !Array.isArray(e)) continue;
        const low = copper(e[0]), going = copper(e[1]);
        if (!low && !going) continue;
        const cap = most(item), asked = going || low;
        items.set(item, { price: cap && asked > cap ? Math.round(cap) : asked, low: low || going, age: 0 });
      }
      // (its own house: what was for sale on a day gone by and is not now - the last going price, and how old it is)
      if (key === keys[0]) {
        const today = dayStart(dayOf(list.t));
        for (const day of store.days(key).reverse()) {
          const line = store.day(key, day);
          if (!line?.items || !(line.t >= now - KEEP_DAYS * 86400)) continue;
          const age = Math.max(1, Math.round((today - dayStart(day)) / 86400));
          for (const [id, r] of Object.entries(line.items)) {
            const item = Number(id), close = copper(r?.[2]);
            if (!Number.isInteger(item) || item <= 0 || !close || items.has(item)) continue;
            const cap = most(item);
            items.set(item, { price: cap && close > cap ? Math.round(cap) : close, low: 0, age });
          }
        }
      }
    }
    if (!items.size) continue;
    const mine = ours(store.sells(key));
    for (const [item, row] of items) {
      // (the neutral houses: our own readings of that house and nothing else - see the top of this file)
      const prior = !neutral && rate >= 0 ? soundRate(tsm.items?.[item]?.[rate], perDay >= 0 ? tsm.items?.[item]?.[perDay] : 0) : null;
      const c = chances(mine[item], neutral ? null : all[item], prior);
      row.chance = {};
      for (const d of DURATIONS) row.chance[d] = c[d].chance;
      // (what carries it: of the longest length there is a figure for - the one most auctions are put up for)
      row.from = FROM[[24, 8, 2].map((d) => c[d].from).find(Boolean)] ?? 0;
      // (TradeSkillMaster's figure is in every figure it was leaned on, however many readings of ours are on top)
      if (prior !== null) credit = true;
    }
    const costs = costsOf(key);
    houses.push({ key, side: h.side, name: neutral ? 'Neutral' : SIDES[h.side], realm: RULESETS[h.ruleset].name, t: Math.round(list.t), cut: costs.cut, deposit: costs.deposit, items });
  }
  // (nothing of its own house: nothing to say - the neutral house's prices alone tell nobody what to do)
  if (!houses.length || houses[0].key !== keys[0]) return null;
  return { houses, credit, yields: readYields(readJson(yieldsFile(cfg))) };
}

const mille = (p) => (p === null || p === undefined ? '-' : String(Math.round(p * 1000)));
/** One item's line: for each house "price low age c2 c8 c24 from" (a house that has nothing of it: "0"), the houses parted by "|". */
function lineOf(figures, item) {
  return figures.houses.map((h) => {
    const r = h.items.get(item);
    return r ? `${r.price} ${r.low} ${r.age} ${DURATIONS.map((d) => mille(r.chance[d])).join(' ')} ${r.from}` : '0';
  }).join('|');
}

/** The small addon's files: { name: text }. */
export function marketAddonFiles(figures, interfaceVersion) {
  const ids = new Set();
  for (const h of figures.houses) for (const id of h.items.keys()) ids.add(id);
  const sorted = [...ids].sort((a, b) => a - b);
  return {
    [`${MARKET}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(auction prices and what sells)|r',
      '## Notes: What every item fetches at your auction house and the neutral one, and how often it sells of the times it is put up. Written by the 3D map; Azeroth Atlas reads it as the game starts, and says in an item\'s tooltip what to do with a thing you are getting rid of. There is nothing to turn on or off here: /atlas advice does that.',
      '## Group: AzerothAtlas',
      '',
      'market.lua',
      '',
    ].join('\r\n'),
    'market.lua': [
      FIRST_LINE,
      '-- Written by the 3D map (server/market.js): do not edit by hand.',
      '--   houses  your own, then the neutral one: what it is called, when its list was read (seconds',
      '--           since 1970), the per cent it keeps of a sale (cut), and the deposit for 2, 8 and 24',
      '--           hours in per cent of what a vendor pays',
      '--   of      an item, by the game\'s number for it: for each house "price low age c2 c8 c24 from"',
      '--           (a house with nothing of it: "0"), the houses parted by "|". price: what the cheap',
      '--           end of the market asks for one piece, in copper - no more than twice what the thing',
      '--           sells for, where that is known; low: the lowest anybody asks (0: not for sale now);',
      '--           age: days since that price was seen; c2 c8 c24: how often it sells of',
      '--           the times it is put up for that many hours, in thousandths ("-": not known); from: 1',
      '--           our own readings of the house, 2 of the region\'s houses, 3 TradeSkillMaster\'s figure',
      '--           for the region, 0 not known',
      '--   yields  what disenchanting things of a band gave, by every copy\'s count ("weapon 2 or armour',
      '--           4 : quality : the band\'s first item level"): "times material=pieces in all ..."',
      `AzerothAtlasMarket = { v = ${FORMAT}, items = ${sorted.length}, credit = ${figures.credit ? 'true' : 'false'}, yields = {`,
      ...[...(figures.yields ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([band, y]) => `[${luaText(band)}]="${y.n} ${y.got.map(([item, pieces]) => `${item}=${pieces}`).join(' ')}",`),
      '}, houses = {',
      ...figures.houses.map((h) => `{ key = ${luaText(h.key)}, side = ${luaText(h.side)}, name = ${luaText(h.name)}, realm = ${luaText(h.realm)}, t = ${h.t}, cut = ${h.cut}, deposit = { [2] = ${h.deposit[2]}, [8] = ${h.deposit[8]}, [24] = ${h.deposit[24]} } },`),
      '}, of = {',
      ...sorted.map((id) => `[${id}]="${lineOf(figures, id)}",`),
      '} }',
      '',
    ].join('\n'),
  };
}
const FIRST_LINE = '-- Azeroth Atlas: what every item fetches at the auction houses and how often it sells, as the 3D map last had it.';

// (what was last looked at, and found written as it should be: nothing is read again until the prices or the figures change)
let settled = null;

/**
 * Write the figures for the addon, where they are not there as they stand.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), items, house, t } -
 *          or null where there is nothing to write (no house chosen, nothing fetched yet), or no
 *          Azeroth Atlas in the game to write it for
 */
export function writeMarketAddon(cfg) {
  const dir = addonsDir(cfg);
  if (!dir || !fs.existsSync(path.join(dir, NAME, `${NAME}.toc`))) return null;
  const folder = path.join(dir, MARKET);
  let iface = '0';
  try { iface = /^## Interface:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, NAME, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? '0'; } catch { /* as it is */ }
  const key = marketKey(cfg);
  const now = `${folder}|${iface}|${key}`;
  if (key && settled?.key === now && fs.existsSync(path.join(folder, 'market.lua')) && fs.existsSync(path.join(folder, `${MARKET}.toc`))) return { ...settled.said, written: false, fresh: false };
  const figures = key ? marketFigures(cfg) : null;
  if (!figures) {
    // (nothing that may be handed on: what was handed on before is taken out again - the prices of a list too old to be kept among it)
    let written = false;
    const file = path.join(folder, 'market.lua');
    if (fs.existsSync(file)) {
      const empty = [FIRST_LINE, '-- Written by the 3D map (server/market.js): nothing to hand on just now.', 'AzerothAtlasMarket = nil', ''].join('\n');
      let same = false;
      try { same = fs.readFileSync(file, 'utf8') === empty; } catch { /* written anew */ }
      if (!same) { writeFileAtomic(file, empty); written = true; }
    }
    settled = null;
    return written ? { written: true, fresh: false, items: 0, house: null, t: null } : null;
  }
  const files = marketAddonFiles(figures, iface);
  const fresh = !fs.existsSync(folder);
  let written = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(folder, name);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === text; } catch { /* not there yet */ }
    if (same) continue;
    fs.mkdirSync(folder, { recursive: true });
    writeFileAtomic(file, text);
    written = true;
  }
  const said = { items: new Set(figures.houses.flatMap((h) => [...h.items.keys()])).size, house: figures.houses[0].key, neutral: figures.houses[1]?.key ?? null, t: figures.houses[0].t };
  settled = { key: now, said };
  return { ...said, written, fresh: fresh && written };
}

/** Is there anybody to write the figures for: Azeroth Atlas in the game, and a house chosen? */
export function marketWanted(cfg) {
  try {
    const dir = addonsDir(cfg);
    return !!dir && fs.existsSync(path.join(dir, NAME, `${NAME}.toc`)) && housesOf(cfg).length > 0;
  } catch { return false; }
}
