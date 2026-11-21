// The auction prices the map keeps, handed on to the game - for the addons there that ask
// Auctionator what an item costs (addon/standins/Auctionator.lua answers them; standins.js says
// when: the box "Auctionator" on the page).
//
// The prices are this copy's own auction house as last fetched (<dataDir>/auctions/<house>/
// now.json: auctions/store.js): for every item for sale, the lowest anybody asks for one piece
// and the going price. What an item is called is the map's own (<dataDir>/items.json), so that
// a shopping list an addon sends by name can be priced.
//
// The game can be handed nothing while it runs but what it loads itself. So, as with the boats'
// times and the drop rates, the prices are written as a file the game loads - where, depends on
// what is in the game (standins.js: pricesMode):
//
//   the map's stand-in is in the folder Auctionator    into that folder (prices.lua), which the
//                                                      stand-in's .toc names before its own file
//   your own Auctionator is there                      as a small addon of the map's own beside
//                                                      it, AzerothAtlas_Prices: the prices, and
//                                                      the same Lua as the stand-in's, which gives
//                                                      them through Auctionator's own questions.
//                                                      It needs Auctionator, so the game loads it
//                                                      after that. Nothing of Auctionator's own
//                                                      folder is written to.
//   the box is not ticked, or neither is there         nowhere: what was handed on is taken out
//
// They are taken up the next time the game loads its addons: when it starts, or on /reload.
// Written when the map starts, each time the prices have been fetched, when the box is ticked
// and by "Check for updates".
//
// What is read from Blizzard's lists may be kept thirty days and no longer (auctions/days.js):
// a list older than that is not handed on, and one that was is taken out of the file again.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { AuctionStore, KEEP_DAYS } from '../auctions/store.js';
import { auctionSettings } from '../auctions/settings.js';
import { parseHouse, houseName, RULESETS } from '../auctions/houses.js';
import { addonsDir } from './addon.js';
import { PROJECT_ROOT } from '../extractor/config.js';
import { PRICES, PRICE_FILE, pricesMode, interfaceVersion } from './standins.js';

const FORMAT = 1;          // of what is written: raise when the stand-in is to read it differently
const COPPER_MOST = 1e12;  // a price above this is no price
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };
/** A text as Lua writes one: between double quotes, with nothing in it that would end it early. */
const luaText = (s) => '"' + String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const copper = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < COPPER_MOST ? Math.round(v) : 0);

/**
 * This copy's auction house as last fetched: { house, name, side, realm, t, low: Map<item,
 * copper>, going: Map, names: Map<item, its name> } - or null (no house chosen, nothing fetched
 * yet, or a list too old to be handed on).
 */
export function priceFigures(cfg, now = Date.now() / 1000) {
  const { on, house } = auctionSettings(cfg);
  const h = on && house ? parseHouse(house) : null;
  if (!h) return null;
  const list = new AuctionStore(cfg.dataDir).now(house);
  if (!list || typeof list.t !== 'number' || !list.items || list.t < now - KEEP_DAYS * 86400) return null;
  const low = new Map(), going = new Map();
  for (const [key, e] of Object.entries(list.items)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0 || !Array.isArray(e)) continue;
    const min = copper(e[0]), mv = copper(e[1]);
    if (min) low.set(id, min);
    if (mv) going.set(id, mv);
  }
  if (!low.size) return null;
  const names = new Map(), items = readJson(path.join(cfg.dataDir, 'items.json'))?.items;
  if (items && typeof items === 'object') {
    for (const id of low.keys()) {
      const name = items[id]?.[0];
      if (typeof name === 'string' && name.trim() && name.length <= 200) names.set(id, name.trim());
    }
  }
  return { house, name: houseName(house), side: h.side, realm: RULESETS[h.ruleset].name, t: Math.round(list.t), low, going, names };
}

/** The prices as the game reads them: the text of prices.lua. (figures null: the file with no prices in it) */
export function pricesLua(figures) {
  const table = (map, write) => ['(function() return {', ...[...map.keys()].sort((a, b) => a - b).map((id) => `[${id}]=${write(map.get(id))},`), '} end)()'].join('\n');
  const body = figures ? [
    `AzerothAtlasPrices = { v = ${FORMAT}, house = ${luaText(figures.house)}, name = ${luaText(figures.name)}, side = ${luaText(figures.side)}, realm = ${luaText(figures.realm)}, t = ${figures.t}, items = ${figures.low.size} }`,
    `AzerothAtlasPrices.low = ${table(figures.low, String)}`,
    `AzerothAtlasPrices.going = ${table(figures.going, String)}`,
    `AzerothAtlasPrices.names = ${table(figures.names, luaText)}`,
  ] : ['AzerothAtlasPrices = nil'];
  return [
    FIRST_LINE,
    '-- Written by the 3D map (server/prices.js): do not edit by hand. low: the lowest anybody asked',
    '-- for one piece, in copper; going: what the cheap end of the market asked, the oddities left',
    '-- out; names: what each item is called. t: when the list was read (seconds since 1970).',
    ...body,
    '',
  ].join('\n');
}

const FIRST_LINE = '-- Azeroth Atlas: what every item costs at your auction house, as the 3D map last read it.';
/** Is this a file of prices as pricesLua writes one? */
const isPrices = (file) => {
  let fd;
  try { fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(FIRST_LINE.length); return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)) === FIRST_LINE; } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const ROUTE_FILE = 'route.lua';
/** The small addon beside your own Auctionator: { name: text }. (figures null: with no prices in it) */
export function pricesAddonFiles(figures, interfaceVersion) {
  return {
    [`${PRICES}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(the map\'s auction prices, through Auctionator)|r',
      '## Notes: What every item costs at your auction house, as the 3D map last read it (once an hour, from the game\'s own auction lists), given to the addons that ask Auctionator what an item costs - where Auctionator has no price of its own, or an older one. Nothing of Auctionator itself is changed: with this switched off it is as its makers published it. Written by the 3D map (the box "Auctionator" on its page).',
      '## Group: AzerothAtlas',
      '## Dependencies: Auctionator',
      '',
      PRICE_FILE,
      ROUTE_FILE,
      '',
    ].join('\r\n'),
    [PRICE_FILE]: pricesLua(figures),
    [ROUTE_FILE]: fs.readFileSync(path.join(PROJECT_ROOT, 'addon', 'standins', 'Auctionator.lua'), 'utf8'),
  };
}

// (what was last looked at, and found written as it should be: nothing is read again until the prices or the names change)
let settled = null;

/** Take the small addon beside your own Auctionator out of the game: the files this wrote, and the folder if nothing else is in it. */
function removePricesAddon(dir) {
  const folder = path.join(dir, PRICES);
  if (!fs.existsSync(folder)) return false;
  for (const name of [`${PRICES}.toc`, PRICE_FILE, ROUTE_FILE]) { try { fs.rmSync(path.join(folder, name)); } catch { /* not there */ } }
  try { fs.rmdirSync(folder); } catch { /* something of yours is in it: left */ }
  settled = null;
  return true;
}

/**
 * Write the prices for the game, where they are not there as they stand - into the stand-in's
 * folder, or as the small addon beside your own Auctionator (see the top of this file).
 * @returns { mode ('standin' | 'route'), written, fresh (a folder is new: the game finds it when it next starts), items, house, t } -
 *          or null where there is nobody to write them for (the box is not ticked, or no
 *          Auctionator of either kind is in the game)
 */
export function writePricesAddon(cfg) {
  const dir = addonsDir(cfg);
  if (!dir) return null;
  const mode = pricesMode(cfg);
  // (the small addon is for your own Auctionator alone: out again once that is gone, or the box unticked)
  if (mode !== 'route') removePricesAddon(dir);
  if (!mode) { settled = null; return null; }
  const folder = path.join(dir, mode === 'route' ? PRICES : 'Auctionator');
  const house = auctionSettings(cfg).house;
  const store = house ? new AuctionStore(cfg.dataDir) : null;
  const key = `${folder}|${FORMAT}|${house}|${house ? stampOf(store.file(house, 'now.json')) : ''}|${stampOf(path.join(cfg.dataDir, 'items.json'))}`;
  // (the file a stand-in put in anew only holds the place: that one is not the prices, and is written over)
  if (settled?.key === key && isPrices(path.join(folder, PRICE_FILE)) && (mode === 'standin' || fs.existsSync(path.join(folder, ROUTE_FILE)))) return { ...settled.said, mode, written: false, fresh: false };
  const figures = priceFigures(cfg);
  const fresh = !fs.existsSync(folder);
  const files = mode === 'route' ? pricesAddonFiles(figures, interfaceVersion()) : { [PRICE_FILE]: pricesLua(figures) };
  let written = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(folder, name);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === text; } catch { /* not there yet */ }
    if (same) continue;
    writeFileAtomic(file, text);
    written = true;
  }
  const said = { items: figures?.low.size ?? 0, house: figures?.house ?? null, t: figures?.t ?? null };
  settled = { key, said };
  return { ...said, mode, written, fresh: fresh && written };
}
