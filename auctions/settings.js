// What a copy of the map does about auction prices.
//
// In config.json:
//
//   "auctions": {
//     "house": "us-110"        the auction house whose prices this copy shows (houses.js; chosen on
//                              the map's Prices page, which writes it here)
//   }
//
// "auctions": false switches the whole thing off.
import fs from 'node:fs';
import { readConfigFile } from '../extractor/config.js';
import { parseHouse } from './houses.js';

/** @returns {{ on: boolean, house: string|null }} */
export function auctionSettings(cfg) {
  const own = cfg?.auctions;
  if (own === false) return { on: false, house: null };
  return { on: true, house: parseHouse(own?.house)?.key ?? null };
}

/** Choose this copy's house: written to config.json, and into the settings in hand. */
export function setHouse(cfg, configFile, key) {
  const house = parseHouse(key);
  if (!house) throw new Error(`no such auction house: ${key}`);
  let file = {};
  try { file = readConfigFile(configFile); } catch { /* a new one */ }
  const own = file.auctions && typeof file.auctions === 'object' ? file.auctions : {};
  file.auctions = { ...own, house: house.key };
  fs.writeFileSync(configFile, JSON.stringify(file, null, 2) + '\n');
  cfg.auctions = file.auctions;
  return auctionSettings(cfg);
}
