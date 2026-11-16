// What TradeSkillMaster says of the same houses: its public price files.
//
// TradeSkillMaster (tradeskillmaster.com) publishes a plain file of prices for every house and
// one for every region, for anybody's program to read: no key, no sign-in. Its terms allow
// automated reading of exactly these files ("features we provide for that purpose, such as our
// public pricing data files"). They are fetched here by each copy of the map for itself, straight
// from TradeSkillMaster, for the one house it is set to: nothing of them goes into the Atlas
// database or is handed on.
//
// A list of auctions says what is asked. What it cannot say is what SELLS, and that is what
// these files add: for a region, how often an item sells of the times it is put up (saleRate),
// how many sell in a day (soldPerDay) and for how much (avgSalePrice); for a house, TSM's own
// "market value" and its long-run average ("historical"), to hold our going price against.
//
//   https://public-data.tradeskillmaster.com/forever/<region>/realm/<ruleset>-<side>/items.csv
//       itemId,name,marketValue,minBuyout,recent,historical,updatedAt     (changes every few hours)
//   https://public-data.tradeskillmaster.com/forever/<region>/region/items.csv
//       itemId,name,marketValue,historical,avgSalePrice,saleRate,soldPerDay,updatedAt   (daily)
//
// Prices in copper. Kept in <dataDir>/auctions/tsm/ and asked for again no more often than the
// files change.
import { parseHouse, tsmSlug } from './houses.js';

const BASE = 'https://public-data.tradeskillmaster.com/forever';
const HOUSE_EVERY = 3 * 3600 * 1000;
const REGION_EVERY = 12 * 3600 * 1000;

/** One line of a CSV file: commas inside "quotes" belong to the value, "" is a quote. */
export function csvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** A whole file → { updated, names: { id: name }, items: { id: [numbers in the order of `fields`] } } */
export function parseFile(text, fields) {
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  const head = csvLine(lines[0] ?? '');
  const at = (name) => head.indexOf(name);
  if (at('itemId') < 0 || fields.some((f) => at(f) < 0)) throw new Error(`not the file expected (its columns: ${head.join(', ').slice(0, 120)})`);
  const items = {}, names = {};
  let updated = null;
  for (let i = 1; i < lines.length; i++) {
    const c = csvLine(lines[i]);
    const id = Number(c[at('itemId')]);
    if (!Number.isInteger(id) || id <= 0) continue;
    items[id] = fields.map((f) => Number(c[at(f)]) || 0);
    if (at('name') >= 0 && c[at('name')]) names[id] = c[at('name')];
    if (!updated && at('updatedAt') >= 0) updated = c[at('updatedAt')] || null;
  }
  return { updated, names, items };
}

export const HOUSE_FIELDS = ['marketValue', 'minBuyout', 'recent', 'historical'];
export const REGION_FIELDS = ['marketValue', 'historical', 'avgSalePrice', 'saleRate', 'soldPerDay'];

async function fetchFile(url, since) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'azeroth-atlas', ...(since ? { 'If-Modified-Since': since } : {}) } });
    if (res.status === 304) return { status: 304 };
    if (res.status !== 200) return { status: res.status };
    return { status: 200, text: await res.text(), modified: res.headers.get('last-modified') };
  } finally { clearTimeout(timer); }
}

/**
 * Bring TradeSkillMaster's files for one house (and its region) up to date, if they are due.
 * @returns { house: 'fresh'|'same'|'none'|'kept', region: … } ('none': TSM has no such file; 'kept': not due yet)
 */
export async function refreshTsm(store, house, { force = false, log = () => {} } = {}) {
  const h = parseHouse(house);
  if (!h) return { house: 'none', region: 'none' };
  const out = {};
  const slug = tsmSlug(house);
  const jobs = [
    ['house', slug ? `${h.region}-${slug}` : null, slug ? `${BASE}/${h.region}/realm/${slug}/items.csv` : null, HOUSE_FIELDS, HOUSE_EVERY],
    ['region', `${h.region}-region`, `${BASE}/${h.region}/region/items.csv`, REGION_FIELDS, REGION_EVERY],
  ];
  for (const [what, name, url, fields, every] of jobs) {
    if (!url) { out[what] = 'none'; continue; }
    const kept = store.read(`tsm/${name}.json`);
    if (!force && kept && Date.now() - (kept.fetched ?? 0) < every) { out[what] = 'kept'; continue; }
    try {
      const res = await fetchFile(url, kept?.modified ?? null);
      if (res.status === 304) { store.write(`tsm/${name}.json`, { ...kept, fetched: Date.now() }); out[what] = 'same'; continue; }
      if (res.status !== 200) { out[what] = res.status === 404 ? 'none' : `HTTP ${res.status}`; continue; }
      const file = parseFile(res.text, fields);
      store.write(`tsm/${name}.json`, { fields, updated: file.updated, modified: res.modified, fetched: Date.now(), names: file.names, items: file.items });
      out[what] = 'fresh';
      log(`TradeSkillMaster, ${name}: ${Object.keys(file.items).length.toLocaleString()} items, as of ${file.updated ?? '?'}`);
    } catch (err) { out[what] = err.message; }
  }
  return out;
}

/** What is kept of TradeSkillMaster's files for a house: { house: file|null, region: file|null } */
export function readTsm(store, house) {
  const h = parseHouse(house);
  const slug = tsmSlug(house);
  return { house: h && slug ? store.read(`tsm/${h.region}-${slug}.json`) : null, region: h ? store.read(`tsm/${h.region}-region.json`) : null };
}
