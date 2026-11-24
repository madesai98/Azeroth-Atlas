// What disenchanting gives, as the players of the copies found it: read out of the game's saved
// settings, sent to the Atlas database as lines, and put together there for every copy.
//
// The game's files say which things can be disenchanted - weapon or armour, of which quality,
// in which band of item level - and not what each band gives. The addon starts from the
// original game's tables as published and notes what your own disenchanting gives (addon/
// AzerothAtlas/Advice.lua: AzerothAtlasDB.yields, for each band how many times, and how many
// pieces of each material in all). Here that becomes lines, one a band, with nothing of the
// player in them:
//
//   y,<band>,<times disenchanted>,<material>,<pieces in all>[,<material>,<pieces in all> ...]
//
// A band's number is its kind (2 a weapon, 4 armour), its quality (2 to 4) and the first item
// level of the band, written together: "2:2:16" in the addon is 20216 here. A line is the whole
// of what a copy has counted so far, not what is new: a copy's later line of a band stands for
// its earlier ones (the one with the more disenchantings, so that settings written anew do not
// take away what was counted). Put together, every copy's count is added up.
//
// Published as records of a kind of their own (records.js: YIELD), a band each:
//
//   { n: times disenchanted, c: copies that said so, got: [[material, pieces in all], ...] }
//
// Only what is sound passes: whole numbers within their bounds, no more of a material than a
// disenchanting can give. Saved settings of another addon, or broken ones, give no lines;
// nothing here throws.
import { luaValue } from './boats.js';

const ID = 16777215;       // the most an item can be numbered
const TIMES_MOST = 1e6;    // disenchantings of one band by one copy beyond which a line is not believed
const EACH_MOST = 20;      // pieces of one material one disenchanting can give, at the very most
const MATERIALS_MOST = 6;  // materials to one band
const BANDS_MOST = 80;     // bands there can be (two kinds, three qualities, a dozen bands)
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** "2:2:16" (the addon's name of a band) → 20216 - or null: no band. */
export function bandId(key) {
  const m = /^([24]):([234]):(\d{1,2})$/.exec(String(key));
  return m && +m[3] >= 1 ? +m[1] * 10000 + +m[2] * 100 + +m[3] : null;
}
/** 20216 → "2:2:16" - or null: no band's number. */
export function bandKey(id) {
  if (!Number.isInteger(id)) return null;
  const kind = Math.floor(id / 10000), quality = Math.floor(id / 100) % 100, low = id % 100;
  return (kind === 2 || kind === 4) && quality >= 2 && quality <= 4 && low >= 1 ? `${kind}:${quality}:${low}` : null;
}

/** One band's count, where it is sound: { n, got: Map<material, pieces> } - or null. */
function sound(n, pairs) {
  if (!whole(n, 1, TIMES_MOST) || pairs.length > MATERIALS_MOST) return null;
  const got = new Map();
  for (const [item, pieces] of pairs) {
    if (!whole(item, 1, ID) || !whole(pieces, 0, n * EACH_MOST) || got.has(item)) return null;
    if (pieces > 0) got.set(item, pieces);
  }
  return got.size ? { n, got } : null;
}

/**
 * What the addon has noted, out of the text of a SavedVariables/AzerothAtlas.lua.
 * @returns Map<band number, { n, got: Map<material, pieces> }> (empty where there is nothing sound)
 */
export function yieldsIn(text) {
  const out = new Map();
  try {
    if (typeof text !== 'string') return out;
    const at = text.indexOf('AzerothAtlasDB = {');
    if (at < 0) return out;
    const yields = luaValue(text, at + 17)?.yields;
    if (!yields || typeof yields !== 'object') return out;
    for (const [key, rec] of Object.entries(yields)) {
      if (out.size >= BANDS_MOST) break;
      const band = bandId(key);
      if (!band || !rec || typeof rec !== 'object' || !rec.got || typeof rec.got !== 'object') continue;
      const pairs = Object.entries(rec.got).map(([item, pieces]) => [/^\d{1,8}$/.test(item) ? +item : NaN, pieces]);
      const ok = sound(rec.n, pairs);
      if (ok) out.set(band, ok);
    }
  } catch {
    return new Map();
  }
  return out;
}

/** Several accounts' counts (yieldsIn of each) as lines for the database: the accounts of one computer added up, a band a line. */
export function yieldLines(accounts) {
  const sum = new Map();
  for (const one of accounts) {
    for (const [band, rec] of one) {
      let all = sum.get(band);
      if (!all) sum.set(band, (all = { n: 0, got: new Map() }));
      all.n += rec.n;
      for (const [item, pieces] of rec.got) all.got.set(item, (all.got.get(item) ?? 0) + pieces);
    }
  }
  const lines = [];
  for (const band of [...sum.keys()].sort((a, b) => a - b)) {
    const { n, got } = sum.get(band);
    // (the most given first, and no more than a line holds: what is left out is the rarest)
    const pairs = [...got].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MATERIALS_MOST).sort((a, b) => a[0] - b[0]);
    const line = `y,${band},${n},${pairs.map(([item, pieces]) => `${item},${pieces}`).join(',')}`;
    if (sound(n, pairs) && line.length <= 100) lines.push(line);
  }
  return lines;
}

/** A line as it was sent, cut at its commas: { band, n, got: Map } - or null where it is not sound. */
export function readYieldLine(parts) {
  if (!Array.isArray(parts) || parts[0] !== 'y' || parts.length < 5 || parts.length % 2 !== 1 || !parts.slice(1).every((p) => /^\d{1,10}$/.test(p))) return null;
  const band = +parts[1];
  if (!bandKey(band)) return null;
  const pairs = [];
  for (let i = 3; i < parts.length; i += 2) pairs.push([+parts[i], +parts[i + 1]]);
  const ok = sound(+parts[2], pairs);
  return ok ? { band, ...ok } : null;
}

/**
 * Every copy's counts put together.
 * @param byCopy Map<copy, Map<band, { n, got: Map }>> - of each copy, for each band, the line of its with the most disenchantings
 * @returns Map<band number, { n, c, got: [[material, pieces], ...] }>
 */
export function foldYields(byCopy) {
  const sum = new Map();
  for (const bands of byCopy.values()) {
    for (const [band, rec] of bands) {
      let all = sum.get(band);
      if (!all) sum.set(band, (all = { n: 0, c: 0, got: new Map() }));
      all.n += rec.n; all.c++;
      for (const [item, pieces] of rec.got) all.got.set(item, (all.got.get(item) ?? 0) + pieces);
    }
  }
  const out = new Map();
  for (const [band, all] of sum) out.set(band, { n: all.n, c: all.c, got: [...all.got].sort((a, b) => a[0] - b[0]) });
  return out;
}

/**
 * The published counts as a copy last fetched them (truth-yield.json, as the local store reads
 * it): Map<the addon's name of a band, { n, got: [[material, pieces]] }>, the sound ones.
 */
export function readYields(local) {
  const out = new Map();
  if (!local || typeof local !== 'object') return out;
  for (const part of Object.values(local)) {
    for (const [key, rec] of Object.entries(part ?? {})) {
      const name = bandKey(Number(String(key).slice(1)));
      if (!name || !rec || !Array.isArray(rec.got)) continue;
      const ok = sound(rec.n, rec.got.filter(Array.isArray));
      if (ok) out.set(name, { n: ok.n, got: [...ok.got].sort((a, b) => a[0] - b[0]) });
    }
  }
  return out;
}
