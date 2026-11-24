// The prices as they are shown: one house's list, one item's history, and the recipes costed.
//
// Put together from what this computer keeps (store.js): the house as last listed, the days
// before it, each item's name, kind and stats and every recipe from the game's own tables
// (extractor/jobs/items.js, recipes.js), and what TradeSkillMaster says of the same item (tsm.js).
import { readItems } from '../extractor/jobs/items.js';
import { readRecipes } from '../extractor/jobs/recipes.js';
import { dayOf, dayStart } from './days.js';
import { houseName, parseHouse, costsOf } from './houses.js';
import { readTsm } from './tsm.js';
import { costRecipe } from './craft.js';

/** The day so many days before another, as 20261109. */
const daysBefore = (day, n) => dayOf(dayStart(day) - n * 86400 + 43200);

/**
 * Names and kinds, from the game's tables where it has them and TradeSkillMaster's names where
 * it does not (an item the game has not been sent yet).
 */
export function itemInfo(dataDir, tsm, list = readItems(dataDir)) {
  const game = list?.items ?? {};
  return (id) => {
    const g = game[id];
    if (g) return g;
    const name = tsm?.house?.names?.[id] ?? tsm?.region?.names?.[id];
    return name ? [name, -1, -1, -1, 0, 0, 0, 0, 1] : null;
  };
}

/**
 * One house, every item in it now.
 * rows: [id, name, quality, class, subclass, required level, min, mv, auctions, pieces,
 *        going price a day ago, a week ago, TSM sale rate, TSM sold per day]
 * (0 where a thing is not known: no price that day, no such figure from TSM)
 */
export function listHouse(store, dataDir, house) {
  const now = store.now(house);
  if (!now) return null;
  const tsm = readTsm(store, house);
  const info = itemInfo(dataDir, tsm);
  const today = dayOf(now.t);
  const days = store.days(house);
  // "a day ago": the last going price of the day before; "a week ago": of the seventh day back, or
  // the nearest day kept after it
  const closeOf = (want) => {
    const day = days.find((d) => d >= want && d < today);
    return day ? store.day(house, day)?.items ?? {} : {};
  };
  const d1 = closeOf(daysBefore(today, 1)), d7 = closeOf(daysBefore(today, 7));
  const reg = tsm.region?.items ?? {};
  const rows = [];
  for (const [id, e] of Object.entries(now.items)) {
    const i = info(id);
    const r = reg[id];
    rows.push([Number(id), i?.[0] ?? `Item ${id}`, i?.[1] ?? -1, i?.[2] ?? -1, i?.[3] ?? -1, i?.[6] ?? 0, e[0], e[1], e[2], e[3], d1[id]?.[2] ?? 0, d7[id]?.[2] ?? 0, r?.[3] ?? 0, r?.[4] ?? 0]);
  }
  const state = store.state().houses?.[house] ?? {};
  return {
    house, name: houseName(house), taken: !!parseHouse(house)?.taken, t: now.t, by: state.by ?? null,
    days: days.length, firstDay: days[0] ?? null,
    tsm: { house: tsm.house?.updated ?? null, region: tsm.region?.updated ?? null },
    rows,
  };
}

/**
 * Every recipe, costed at the house's prices now.
 * rows: [spell, name, skill, learnt at, yellow at, grey at, item made, its name, its quality, how many,
 *        cost of the reagents that have a price, reagents with none, what the things made go for,
 *        TSM sale rate of the thing made, TSM sold per day, item that teaches it]
 */
export function listRecipes(store, dataDir, house) {
  const book = readRecipes(dataDir);
  const now = store.now(house);
  if (!book || !now) return null;
  const list = readItems(dataDir);
  const tsm = readTsm(store, house);
  const info = itemInfo(dataDir, tsm, list);
  const sold = new Set(book.sold ?? []);
  const reg = tsm.region?.items ?? {};
  const rows = [];
  for (const r of book.recipes) {
    const c = costRecipe(r, now.items, list?.more, sold);
    const made = r[6] ? info(r[6]) : null;
    const t = r[6] ? reg[r[6]] : null;
    rows.push([r[0], r[1], r[2], r[3], r[4], r[5], r[6], made?.[0] ?? (r[6] ? `Item ${r[6]}` : ''), made?.[1] ?? -1, r[7], Math.round(c.cost), c.missing, Math.round(c.value), t?.[3] ?? 0, t?.[4] ?? 0, r[9]]);
  }
  // (cut: the per cent the house keeps of a sale - the page takes it off what the things made go for)
  return { house, name: houseName(house), t: now.t, skills: book.skills, vendors: sold.size, cut: costsOf(house).cut, rows };
}

/**
 * One item in one house: what it is, now, day by day, look by look for the last days, what
 * makes it and what it goes into.
 * days: [[day, low, high, close, min, pieces], …]   hours: [[t, min, mv, pieces], …]
 */
export function itemHistory(store, dataDir, house, id) {
  id = Number(id);
  const now = store.now(house);
  const tsm = readTsm(store, house);
  const list = readItems(dataDir);
  const info = itemInfo(dataDir, tsm, list);
  const i = info(id);
  const days = [];
  for (const day of store.days(house)) {
    const c = store.day(house, day)?.items?.[id];
    if (c) days.push([day, ...c]);
  }
  const hours = [];
  for (const day of store.days(house, 'hours')) {
    const h = store.hours(house, day);
    const row = h?.items?.[id];
    if (!row) continue;
    for (let k = 0; k < h.t.length; k++) hours.push([h.t[k], row[k * 3] ?? 0, row[k * 3 + 1] ?? 0, row[k * 3 + 2] ?? 0]);
  }
  hours.sort((a, b) => a[0] - b[0]);
  const named = (file, fields) => (file?.items?.[id] ? { ...Object.fromEntries(fields.map((f, k) => [f, file.items[id][k]])), updated: file.updated } : null);
  // what it does for whoever wears or wields it, in the game's own words
  const m = list?.more?.[id];
  const does = m && (m.s || m.ar || m.dm) ? {
    stats: (m.s ?? []).map(([kind, value]) => [list.stats?.[kind] ?? `Stat ${kind}`, value]),
    armor: m.ar ?? 0,
    damage: m.dm ?? null,
  } : null;
  // the recipes that make it, costed; and the ones it goes into
  const book = readRecipes(dataDir);
  const made = [], uses = [];
  if (book) {
    const sold = new Set(book.sold ?? []);
    const nameOf = (item) => { const x = info(item); return [item, x?.[0] ?? `Item ${item}`, x?.[1] ?? -1]; };
    for (const r of book.recipes) {
      if (r[6] === id) {
        const c = costRecipe(r, now?.items, list?.more, sold, costsOf(house).cut);
        made.push({ spell: r[0], name: r[1], skill: book.skills[r[2]] ?? '', learnt: r[3], yellow: r[4], grey: r[5], count: r[7], taught: r[9] ? nameOf(r[9]) : null,
          parts: c.parts.map(([item, n, price, where]) => [...nameOf(item), n, price, where]), cost: Math.round(c.cost), missing: c.missing, value: Math.round(c.value), net: Math.round(c.net) });
      }
      const use = r[8].find((x) => x[0] === id);
      if (use) uses.push([r[0], r[1], book.skills[r[2]] ?? '', use[1], ...(r[6] ? nameOf(r[6]) : [0, '', -1])]);
    }
  }
  return {
    house, id, t: now?.t ?? null,
    item: i ? { name: i[0], quality: i[1], class: i[2], subclass: i[3], slot: i[4], level: i[5], requires: i[6], sell: i[7], stack: i[8],
      kind: list?.subs?.[`${i[2]}:${i[3]}`] ?? null, where: list?.slots?.[i[4]] ?? null } : null,
    does,
    now: now?.items?.[id] ?? null,
    days, hours,
    tsm: { house: named(tsm.house, tsm.house?.fields ?? []), region: named(tsm.region, tsm.region?.fields ?? []) },
    made, uses,
  };
}
