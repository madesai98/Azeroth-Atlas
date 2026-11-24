// What a copy of the map does about auction prices.
//
// In config.json:
//
//   "auctions": {
//     "house": "us-110",       the auction house whose prices this copy shows (houses.js; chosen on
//                              the map's Prices page, which writes it here)
//     "auto": true             ...where nobody chose it: the map took it from the game (the region,
//                              the realm you play on, your side: server/auctions.js, guessHouse)
//   }
//
// "auctions": false switches the whole thing off.
import fs from 'node:fs';
import { readConfigFile } from '../extractor/config.js';
import { parseHouse } from './houses.js';

/** @returns {{ on: boolean, house: string|null, auto: boolean }} (auto: the house was taken from the game, not chosen) */
export function auctionSettings(cfg) {
  const own = cfg?.auctions;
  if (own === false) return { on: false, house: null, auto: false };
  const house = parseHouse(own?.house)?.key ?? null;
  return { on: true, house, auto: !!house && own?.auto === true };
}

/** Choose this copy's house: written to config.json, and into the settings in hand. (auto: taken from the game, not chosen by anybody.) */
export function setHouse(cfg, configFile, key, { auto = false } = {}) {
  const house = parseHouse(key);
  if (!house) throw new Error(`no such auction house: ${key}`);
  let file = {};
  try { file = readConfigFile(configFile); } catch { /* a new one */ }
  const own = file.auctions && typeof file.auctions === 'object' ? file.auctions : {};
  file.auctions = { ...own, house: house.key };
  if (auto) file.auctions.auto = true; else delete file.auctions.auto;
  fs.writeFileSync(configFile, JSON.stringify(file, null, 2) + '\n');
  cfg.auctions = file.auctions;
  return auctionSettings(cfg);
}
