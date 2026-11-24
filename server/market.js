// What things fetch at the auction houses and how often they sell, handed on to the addon in the
// game - which says, in an item's tooltip, what to do with a thing you are getting rid of: sell
// it to a vendor, put it up at your side's auction house or the neutral one, or disenchant it
// (addon/AzerothAtlas/Advice.lua).
//
// For every item, at this copy's own house and at the neutral house that goes with it:
//
//   the price        the lowest anybody asks for one piece now: what you have to match to be
//                    bought first, and what "how often" below was measured for. Not for sale just
//                    now at your own house: the last going price of the last day it was, with how
//                    many days ago that is.
//   how often        it sells of the times it is put up, for 2, 8 and 24 hours (auctions/sells.js:
//                    chances) - from our own following of every auction of the house (the function
//                    in the cloud: functions/track.js), leaned on the same for the region's houses
//                    together, leaned on TradeSkillMaster's figure for the region where this copy
//                    has it; and on top what became of the auctions the copies' players put up
//                    themselves (atlasdb/sales.js). And which carries it, so that the game can say.
//   how many a day   pieces of it sell at the house, by our own count once that has gone on two
//                    days; TradeSkillMaster's figure for the region till then.
//   what it sells for  the middle of the prices our following saw paid, at the house or else in
//                    the region; TradeSkillMaster's average for the region where we have none.
//
// And for each house the hours of the day: how the pace of the next two and the next eight hours
// stands to the usual, for an auction put up in each hour of the world's clock (sells.js:
// paceTable) - and the same for an item that sells at hours of its own. The game looks at its
// clock and reckons the chance of an auction put up now.
//
// Two things a list of auctions cannot be taken at its word for, and what is done about each:
//
//   an asking price is not a selling price. One auction in four asks half as much again as the
//   thing sells for, and where only one or two are up, one in ten asks ten times it (measured on
//   a house of 6,700 items, 23 November 2026). So the price is reckoned at no more than ASK_MOST
//   times what the thing sells for (above; where nothing is known of that, the middle of our
//   own days' going prices at the house, four days or more). The lowest price asked is handed
//   on as it is, so that the game can say where the two part.
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
// new addon. Those are the game's files' figures; what the houses really asked of the players'
// own auctions and kept of their sales (atlasdb/sales.js) confirms each or stands in its place.
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
import { chances, curveOf, salePrice, soldADay, unpackHours, dayShape, itemShape, paceTable, DURATIONS, FIGURES } from '../auctions/sells.js';
import { readTsm } from '../auctions/tsm.js';
import { readYields } from '../atlasdb/yields.js';
import { readSales, readCosts, settle } from '../atlasdb/sales.js';
import { addonsDir } from './addon.js';

const NAME = 'AzerothAtlas', MARKET = 'AzerothAtlas_Market';
const FORMAT = 2;          // of what is written: raise when the addon is to read it differently (2: the lowest price reckoned with, sales a day, what it sells for, the hours of the day)
const COPPER_MOST = 1e12;  // a price above this is no price
const FROM = { house: 1, region: 2, prior: 3, own: 4 };
const OURS_DAYS = 2;       // days our own count of sales must have gone on before it stands for "so many a day"
const PACE_MOST = 3.5;     // the most a pace is written as (a figure to the tenth, in one sign)
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
const salesFile = (cfg) => path.join(cfg.dataDir, 'atlasdb', 'truth-sale.json');
const costsFile = (cfg) => path.join(cfg.dataDir, 'atlasdb', 'truth-cost.json');
/** 24 paces as 24 signs: each to the tenth, 0 to 3.5, as one digit of base 36. */
const paceText = (list) => list.map((v) => Math.round(Math.min(PACE_MOST, Math.max(0, v)) * 10).toString(36)).join('');
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
  const files = [...houses.flatMap((h) => [store.file(h, 'now.json'), store.file(h, 'sell.json')]), store.file(`all-${region}`, 'sell.json'), store.file('tsm', `${region}-region.json`), yieldsFile(cfg), salesFile(cfg), costsFile(cfg)];
  // (the day counts too: a price of a day gone by is a day older tomorrow)
  return `${FORMAT}|${houses.join(',')}|${files.map(stampOf).join('|')}|${store.days(houses[0]).at(-1) ?? ''}|${Math.floor(Date.now() / 86400000)}`;
}

/**
 * The figures as they stand: { houses: [{ key, side, name, t, cut, deposit, seen (auctions and
 * sales of the copies' players behind the cut and the deposits; 0: the game's files' word only),
 * at (seconds past the hour at which an hour of the day begins here), pace ({ 2: [24], 8: [24] }:
 * sells.js, paceTable - or null: not known yet), items: Map<item, { price, low, age, chance:
 * { 2, 8, 24 } (0..1 or null), from (1 our readings of the house, 2 of the region, 3 a figure from
 * elsewhere, 4 the players' own auctions, 0 not known), n (auctions of ours behind the 24 hours),
 * day (pieces sold a day, or null), dayFrom (1 our count at the house, 3 TradeSkillMaster's for
 * the region), sale (what it sells for, or 0), pace (the item's own, or null) }> }], credit (true:
 * TradeSkillMaster's figure is among what is handed on), curve (sells.js: curveOf), yields:
 * Map<band, { n, got: [[material, pieces]] }> (what disenchanting gave, by every copy's count) } -
 * or null (no house chosen, or nothing fetched yet that may still be handed on).
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
  // (our own readings: only of this making of the figures - sells.js: FIGURES)
  const ours = (x) => (young(x) && x.v === FIGURES ? x.items : {});
  const regionFile = store.sells(`all-${region}`);
  const all = ours(regionFile);
  /** What the thing sells for, as far as that is known (0: not): our own count at the house, in the region, TradeSkillMaster's. */
  const sellsFor = (item, mine) => salePrice(mine?.[item]) ?? salePrice(all[item]) ?? (sale >= 0 ? copper(tsm.items?.[item]?.[sale]) : 0);
  /** ...and the most an asking price is reckoned at - or nothing. */
  const most = (item, mine) => {
    const sold = sellsFor(item, mine);
    if (sold) return ASK_MOST * sold;
    const own = days.get(item);
    return own && own.length >= OWN_DAYS ? ASK_MOST * middle(own) : 0;
  };
  const curve = curveOf(all);
  const exact = readSales(readJson(salesFile(cfg)));
  const taken = readCosts(readJson(costsFile(cfg)));
  /** The hours of the day as a file of figures has them, where they can be gone by: { shape, hours } - or null. */
  const shaped = (x) => { const hours = young(x) && x.v === FIGURES && typeof x.hours === 'string' ? unpackHours(x.hours) : null; const shape = dayShape(hours); return shape ? { shape, hours } : null; };
  const regionShape = shaped(regionFile);
  let credit = false;
  const houses = [];
  const files = new Map();
  const fileOf = (key) => { if (!files.has(key)) files.set(key, store.sells(key)); return files.get(key); };
  const mineOf = (key) => ours(fileOf(key));
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
        // (the lowest anybody asks: what has to be matched to be bought first - and "how often it sells" is of auctions put up at it)
        const cap = most(item, mineOf(key)), asked = low || going;
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
            const cap = most(item, mineOf(key));
            items.set(item, { price: cap && close > cap ? Math.round(cap) : close, low: 0, age });
          }
        }
      }
    }
    if (!items.size) continue;
    const file = fileOf(key), mine = mineOf(key);
    // the hours of the day: the house's own once every hour has been counted on enough days, else the region's
    const day = shaped(file) ?? regionShape;
    const pace = day ? { 2: paceTable(day.shape, day.hours.f, 2), 8: paceTable(day.shape, day.hours.f, 8) } : null;
    const counted = young(file) && file.v === FIGURES && file.from > 0 ? [file.from, file.t] : null;
    for (const [item, row] of items) {
      // (the neutral houses: our own readings of that house and nothing else - see the top of this file)
      const prior = !neutral && rate >= 0 ? soundRate(tsm.items?.[item]?.[rate], perDay >= 0 ? tsm.items?.[item]?.[perDay] : 0) : null;
      const c = chances(mine[item], neutral ? null : all[item], prior, { curve, exact: exact.get(item)?.get(key) ?? null });
      row.chance = {};
      for (const d of DURATIONS) row.chance[d] = c[d].chance;
      // (what carries it: of the longest length there is a figure for - the one most auctions are put up for)
      row.from = FROM[[24, 8, 2].map((d) => c[d].from).find(Boolean)] ?? 0;
      row.n = c[24].ended;
      // (TradeSkillMaster's figure is in every figure it was leaned on, however many readings of ours are on top)
      if (prior !== null) credit = true;
      // how many a day: our own count at the house once it has gone on long enough; TradeSkillMaster's for the region till then
      const own = counted ? soldADay(mine[item], counted[0], counted[1], { least: OURS_DAYS }) : null;
      // (the neutral houses: our own count or nothing - nobody else's figure is of them)
      const theirs = !neutral && perDay >= 0 ? tsm.items?.[item]?.[perDay] : 0;
      if (own !== null) { row.day = own; row.dayFrom = 1; } else if (theirs > 0) { row.day = theirs; row.dayFrom = 3; credit = true; } else { row.day = null; row.dayFrom = 0; }
      row.sale = sellsFor(item, mine) || 0;
      if (row.sale && !salePrice(mine[item]) && !salePrice(all[item])) credit = true;
      // (an item that sells at hours of its own: its own paces)
      const shape = day ? itemShape(mine[item], day.shape, day.hours) : null;
      row.pace = shape ? { 2: paceTable(shape, day.hours.f, 2), 8: paceTable(shape, day.hours.f, 8) } : null;
    }
    // what the house takes: the game's files' figures, each confirmed or put right by what it took of the players' own auctions
    const costs = costsOf(key), found = neutral ? taken.neutral : taken.own;
    const deposit = {};
    for (const d of DURATIONS) deposit[d] = settle(costs.deposit[d], found.deposit[d]).value;
    houses.push({
      key, side: h.side, name: neutral ? 'Neutral' : SIDES[h.side], realm: RULESETS[h.ruleset].name, t: Math.round(list.t),
      cut: settle(costs.cut, found.cut).value, deposit, seen: found.n, at: Math.round(list.t) % 3600, pace, items,
    });
  }
  // (nothing of its own house: nothing to say - the neutral house's prices alone tell nobody what to do)
  if (!houses.length || houses[0].key !== keys[0]) return null;
  return { houses, credit, curve, yields: readYields(readJson(yieldsFile(cfg))) };
}

const mille = (p) => (p === null || p === undefined ? '-' : String(Math.round(p * 1000)));
/** One item's line: for each house "price low age c2 c8 c24 from n day dayfrom sale" (a house that has nothing of it: "0"), the houses parted by "|". */
function lineOf(figures, item) {
  return figures.houses.map((h) => {
    const r = h.items.get(item);
    return r ? `${r.price} ${r.low} ${r.age} ${DURATIONS.map((d) => mille(r.chance[d])).join(' ')} ${r.from} ${Math.min(99999, Math.round(r.n || 0))} ${r.day === null || r.day === undefined ? '-' : Math.min(9999999, Math.round(r.day * 10))} ${r.dayFrom || 0} ${copper(r.sale)}` : '0';
  }).join('|');
}
/** An item's own paces of the day, a house each: the 24 signs for two hours and the 24 for eight (a house where it has none: nothing), parted by "|" - or null where it has none anywhere. */
function paceOf(figures, item) {
  const parts = figures.houses.map((h) => { const p = h.items.get(item)?.pace; return p ? paceText(p[2]) + paceText(p[8]) : ''; });
  return parts.some(Boolean) ? parts.join('|') : null;
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
      '--           seen: how many auctions and sales of the map\'s players are behind the cut and the',
      '--           deposits (0: the game\'s files\' word only); pace: for an auction put up in each',
      '--           hour of the day by the world\'s clock (an hour beginning "at" seconds past the',
      '--           full hour), how the next 2 and the next 8 hours stand to the usual,',
      '--           24 signs each: a digit of base 36, in tenths (a: as usual, k: twice as fast)',
      '--   of      an item, by the game\'s number for it: for each house "price low age c2 c8 c24 from n',
      '--           day dayfrom sale" (a house with nothing of it: "0"), the houses parted by "|". price:',
      '--           the lowest anybody asks for one piece, in copper - no more than twice what the thing',
      '--           sells for, where that is known; low: the lowest asked as it is (0: not for sale now);',
      '--           age: days since that price was seen; c2 c8 c24: how often it sells of the times it',
      '--           is put up for that many hours, in thousandths ("-": not known); from: 1 our own',
      '--           readings of the house, 2 of the region\'s houses, 3 TradeSkillMaster\'s figure for the',
      '--           region, 4 the players\' own auctions, 0 not known; n: auctions of the house behind it;',
      '--           day: pieces sold a day, in tenths ("-": not known), and dayfrom: 1 our count at the',
      '--           house, 3 TradeSkillMaster\'s for the region; sale: what it sells for (0: not known)',
      '--   hours   an item that sells at hours of its own: its own paces, a house each - the 24 signs',
      '--           for 2 hours, then the 24 for 8 (a house where it has none: nothing), parted by "|"',
      '--   yields  what disenchanting things of a band gave, by every copy\'s count ("weapon 2 or armour',
      '--           4 : quality : the band\'s first item level"): "times material=pieces in all ..."',
      `AzerothAtlasMarket = { v = ${FORMAT}, items = ${sorted.length}, credit = ${figures.credit ? 'true' : 'false'}, curve = ${figures.curve?.measured ? 'true' : 'false'}, yields = {`,
      ...[...(figures.yields ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([band, y]) => `[${luaText(band)}]="${y.n} ${y.got.map(([item, pieces]) => `${item}=${pieces}`).join(' ')}",`),
      '}, houses = {',
      ...figures.houses.map((h) => `{ key = ${luaText(h.key)}, side = ${luaText(h.side)}, name = ${luaText(h.name)}, realm = ${luaText(h.realm)}, t = ${h.t}, cut = ${h.cut}, deposit = { [2] = ${h.deposit[2]}, [8] = ${h.deposit[8]}, [24] = ${h.deposit[24]} }, seen = ${h.seen || 0}, at = ${h.at || 0}${h.pace ? `, pace = { [2] = "${paceText(h.pace[2])}", [8] = "${paceText(h.pace[8])}" }` : ''} },`),
      '}, of = {',
      ...sorted.map((id) => `[${id}]="${lineOf(figures, id)}",`),
      '}, hours = {',
      ...sorted.map((id) => [id, paceOf(figures, id)]).filter(([, text]) => text).map(([id, text]) => `[${id}]="${text}",`),
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

/**
 * What selling one piece of an item brings, house by house, as the game's tooltip reckons it
 * (addon/AzerothAtlas/Advice.lua) - for the Prices page:
 * [{ key, name, neutral, cut, seen, price, low, age, net (what lands with you if it sells), sale,
 *    day, dayFrom, from, n, lengths: [{ hours, deposit, usual, pace, chance (put up now), worth (on
 *    average; null: not known how often it sells) }] }] - houses with no price for it left out.
 * @param vendor what a vendor pays for one (copper)
 */
export function sellingOf(figures, item, vendor = 0, now = Date.now() / 1000) {
  const out = [];
  for (const h of figures?.houses ?? []) {
    const r = h.items.get(item);
    if (!r) continue;
    const net = r.price * (1 - h.cut / 100);
    const hour = ((Math.floor((now - (h.at || 0)) / 3600) % 24) + 24) % 24;
    const lengths = DURATIONS.map((d) => {
      // (never less than a copper)
      const deposit = Math.max(1, Math.floor(vendor * h.deposit[d] / 100));
      const usual = r.chance[d];
      if (usual === null || usual === undefined) return { hours: d, deposit, usual: null, pace: 1, chance: null, worth: null };
      // (the pace as the game reads it: to the tenth)
      const table = d >= 24 ? null : r.pace?.[d] ?? h.pace?.[d] ?? null;
      const pace = table ? Math.max(0.05, Math.round(Math.min(PACE_MOST, table[hour]) * 10) / 10) : 1;
      const chance = 1 - (1 - usual) ** pace;
      return { hours: d, deposit, usual, pace, chance, worth: chance * net + (1 - chance) * (vendor - deposit) };
    });
    out.push({ key: h.key, name: h.name, neutral: h.side === 'neutral', cut: h.cut, seen: h.seen, price: r.price, low: r.low, age: r.age, net, sale: r.sale, day: r.day, dayFrom: r.dayFrom, from: r.from, n: r.n, lengths });
  }
  return out;
}

/** Is there anybody to write the figures for: Azeroth Atlas in the game, and a house chosen? */
export function marketWanted(cfg) {
  try {
    const dir = addonsDir(cfg);
    return !!dir && fs.existsSync(path.join(dir, NAME, `${NAME}.toc`)) && housesOf(cfg).length > 0;
  } catch { return false; }
}
