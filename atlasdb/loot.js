// What creatures give, as the players of the copies found it: counted by the addon in the game,
// sent to the Atlas database as lines, and put together there for every copy.
//
// The sources published until now say how often a creature gives a thing a quest wants - for
// the original game. What this game's creatures really give, and how often, nobody publishes.
// So the addon counts it (addon/AzerothAtlas/Drops.lua): every corpse you loot alone, once, with
// everything that was in it. Kept in the game's saved settings (AzerothAtlasDB.loot), and said
// through the strip the moment it happens, so that it need not wait for the game to write its
// settings (server/loot.js keeps what the strip said in <dataDir>/user/loot.json).
//
// Two kinds of thing, counted two ways:
//
//   what drops for anybody    of a creature: how many corpses were looted (n), and in how many of
//                             them the thing was (k). Its rate is k of n.
//   what drops with a quest   a thing the game binds to a quest is in a corpse only while a quest
//                             of yours wants it (which things those are, the addon and the map's
//                             server/drops.js tell by the item, not this: a count may have a thing
//                             both ways - from an addon before 48, which went by the item's kind,
//                             and from one since). So its corpses are counted on their own: those
//                             looted while your quest log asked for the thing (t), and those of
//                             them it was in (k). Its rate is k of t - not k of every corpse,
//                             which would say less the longer you fought there without the quest.
//
// And, for what a kill brings (the addon reckons that: Drops.lua), two things more are counted:
//
//   how many pieces           of a thing that drops for anybody: the pieces beyond the first of
//                             each find, in all (m). A corpse that has it gives 1 + m / k pieces.
//   the coin                  the corpses whose coin was read (cn - one with none in it among
//                             them), and the copper in them, in all.
//
// Here that becomes lines, with nothing of the player in them:
//
//   p,<creature>,<corpses>[,<item>,<found in so many>]...          what drops for anybody
//   w,<creature>,<item>,<found in so many>,<of so many>[,...]...   what drops with a quest
//   m,<creature>,<item>,<pieces beyond the first of each find>[,...]...
//   g,<creature>,<corpses whose coin was read>,<copper in them>
//
// A line is the whole of what a copy has counted so far, not what is new: every figure only ever
// grows, so of a copy's lines about a creature the largest of each figure stands. A creature
// with much to give has several lines. Put together, every copy's count is added up: one copy's
// word is enough, and nothing waits for a second.
//
// Published as records of a kind of their own (records.js: LOOT), a creature each:
//
//   { n: corpses looted, c: copies that looted any, got: [[item, found in so many], ...],
//     on: [[item, found in so many, of so many], ...],
//     more: [[item, pieces beyond the first of each find], ...], coin: [corpses, copper],
//     ref: [[item, per cent, pieces to a find where that is more than one], ...], gold: copper }
//
// `ref` is no count: it is what the reference database's loot table for the creature gives
// (the original game: extractor/reference.js, lootOf), there for a creature nobody has looted
// yet, and leaned on less and less as the counts mount up (the addon does that: see Drops.lua).
// Nor is `gold`: the coin the reference database has a corpse of the creature give, on average.
//
// Only what is sound passes: whole numbers within their bounds, a thing found in no more
// corpses than were looted. Saved settings of another addon, or broken ones, give nothing;
// nothing here throws.
import fs from 'node:fs';
import path from 'node:path';
import { luaValue } from './boats.js';

const ID = 16777215;        // the most a creature or an item can be numbered
const CORPSES_MOST = 1e6;   // corpses of one creature looted by one copy beyond which a count is not believed
const ITEMS_MOST = 400;     // things kept of one creature
const CREATURES_MOST = 20000; // creatures kept of one copy
const LINE_MOST = 100;      // letters to a line (the database's rule for what a copy sends)
const PIECES_MOST = 1e8;    // pieces of one thing beyond the first of each find, of one creature, beyond which a count is not believed
const COPPER_MOST = 4e9;    // copper found on one creature's corpses by one copy...
const COPPER_EACH = 1e6;    // ...and on one of them on average (a hundred gold), beyond which it is not believed
const EACH_MOST = 1000;     // pieces to a find the reference database is believed to say
export const TAG_MOST = 16777215; // the made-up number a game's saved settings go by
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * One creature's count: { n, got: Map<item, k>, on: Map<item, [k, t]>, more: Map<item, pieces
 * beyond the first of each find>, coin: [corpses whose coin was read, copper in them] }. (A
 * count from before pieces and coin were counted has neither: read as none.)
 */
const blank = () => ({ n: 0, got: new Map(), on: new Map(), more: new Map(), coin: [0, 0] });
const coinOf = (rec) => (Array.isArray(rec?.coin) && rec.coin.length === 2 ? rec.coin : [0, 0]);

/**
 * One creature's count as far as it is sound - or null where nothing of it is. What is not sound
 * is left out and the rest kept; a thing found in more corpses than were looted is cut to those.
 */
function sound(rec) {
  if (!rec || !whole(rec.n, 0, CORPSES_MOST)) return null;
  const out = blank();
  out.n = rec.n;
  for (const [item, k] of rec.got ?? []) {
    if (out.got.size >= ITEMS_MOST) break;
    if (whole(item, 1, ID) && whole(k, 1, CORPSES_MOST)) out.got.set(item, Math.min(k, rec.n));
  }
  for (const [item, pair] of rec.on ?? []) {
    if (out.on.size >= ITEMS_MOST) break;
    const [k, t] = Array.isArray(pair) ? pair : [];
    if (whole(item, 1, ID) && whole(t, 1, CORPSES_MOST) && whole(k, 0, CORPSES_MOST)) out.on.set(item, [Math.min(k, t), t]);
  }
  for (const [item, m] of rec.more ?? []) {
    if (out.more.size >= ITEMS_MOST) break;
    if (whole(item, 1, ID) && whole(m, 1, PIECES_MOST)) out.more.set(item, m);
  }
  const [cn, copper] = coinOf(rec);
  if (whole(cn, 1, CORPSES_MOST) && whole(copper, 0, COPPER_MOST) && copper <= cn * COPPER_EACH) out.coin = [cn, copper];
  // (a thing never found among corpses never looted says nothing)
  for (const [item, k] of out.got) if (!(k > 0)) out.got.delete(item);
  return out.n > 0 || out.on.size || out.more.size || out.coin[0] > 0 ? out : null;
}

/** The larger of two counts of one creature, figure by figure (each only ever grows). */
function larger(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { n: Math.max(a.n, b.n), got: new Map(a.got), on: new Map(a.on), more: new Map(a.more ?? []), coin: [...coinOf(a)] };
  for (const [item, k] of b.got) out.got.set(item, Math.max(out.got.get(item) ?? 0, k));
  for (const [item, [k, t]] of b.on) { const had = out.on.get(item); out.on.set(item, had ? [Math.max(had[0], k), Math.max(had[1], t)] : [k, t]); }
  for (const [item, m] of b.more ?? []) out.more.set(item, Math.max(out.more.get(item) ?? 0, m));
  const [cn, copper] = coinOf(b);
  out.coin = [Math.max(out.coin[0], cn), Math.max(out.coin[1], copper)];
  return out;
}

/** Two counts of one creature added up (two accounts, two copies). */
function added(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { n: a.n + b.n, got: new Map(a.got), on: new Map(a.on), more: new Map(a.more ?? []), coin: [...coinOf(a)] };
  for (const [item, k] of b.got) out.got.set(item, (out.got.get(item) ?? 0) + k);
  for (const [item, [k, t]] of b.on) { const had = out.on.get(item) ?? [0, 0]; out.on.set(item, [had[0] + k, had[1] + t]); }
  for (const [item, m] of b.more ?? []) out.more.set(item, (out.more.get(item) ?? 0) + m);
  const [cn, copper] = coinOf(b);
  out.coin = [out.coin[0] + cn, out.coin[1] + copper];
  return out;
}

/**
 * What the addon has counted, out of the text of a SavedVariables/AzerothAtlas.lua.
 * @returns { tag (the made-up number these saved settings go by), of: Map<creature, count> } -
 *          or null where there is nothing sound
 */
export function lootIn(text) {
  try {
    if (typeof text !== 'string') return null;
    const at = text.indexOf('AzerothAtlasDB = {');
    if (at < 0) return null;
    const loot = luaValue(text, at + 17)?.loot;
    if (!loot || typeof loot !== 'object' || !whole(loot.id, 1, TAG_MOST) || !loot.of || typeof loot.of !== 'object') return null;
    const of = new Map();
    for (const [key, rec] of Object.entries(loot.of)) {
      if (of.size >= CREATURES_MOST) break;
      const creature = /^\d{1,8}$/.test(key) ? +key : NaN;
      if (!whole(creature, 1, ID) || !rec || typeof rec !== 'object') continue;
      const pairs = (t) => (t && typeof t === 'object' ? Object.entries(t).map(([item, v]) => [/^\d{1,8}$/.test(item) ? +item : NaN, v]) : []);
      const got = new Map(pairs(rec.got)), tried = new Map(pairs(rec.tried));
      // (a thing that drops with a quest has its own count of corpses: it is no part of what drops for anybody)
      const on = new Map();
      for (const [item, t] of tried) { on.set(item, [got.get(item) ?? 0, t]); got.delete(item); }
      const ok = sound({ n: rec.n ?? 0, got, on, more: new Map(pairs(rec.more)), coin: [rec.cn, rec.coin] });
      if (ok) of.set(creature, ok);
    }
    return of.size ? { tag: loot.id, of } : null;
  } catch {
    return null;
  }
}

// ---- what the strip said, kept by the map's server (server/loot.js) -------------------------------
/**
 * A count as it is kept in a file: { n, got: { item: k }, on: { item: [k, t] }, more: { item: m },
 * coin: [corpses, copper] } (the last two only where there is any), and back.
 */
export const plain = (rec) => ({
  n: rec.n, got: Object.fromEntries(rec.got), on: Object.fromEntries(rec.on),
  ...(rec.more?.size ? { more: Object.fromEntries(rec.more) } : {}),
  ...(coinOf(rec)[0] > 0 ? { coin: [...coinOf(rec)] } : {}),
});
export function fromPlain(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const pairs = (t) => (t && typeof t === 'object' ? Object.entries(t).map(([item, v]) => [/^\d{1,8}$/.test(item) ? +item : NaN, v]) : []);
  return sound({ n: rec.n ?? 0, got: new Map(pairs(rec.got)), on: new Map(pairs(rec.on)), more: new Map(pairs(rec.more)), coin: rec.coin });
}

/** What the strip has said so far (<dataDir>/user/loot.json): Map<tag, Map<creature, count>>. */
export function lootHeard(dataDir) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dataDir, 'user', 'loot.json'), 'utf8')); } catch { return new Map(); }
  return fromTags(d);
}

/**
 * Counts by the number of the settings that made them, as they are kept in a file
 * ({ v: 1, by: { tag: { creature: { n, got, on } } } }): Map<tag, Map<creature, count>>, the sound ones - and back.
 */
export function fromTags(d) {
  const out = new Map();
  if (!d || d.v !== 1 || !d.by || typeof d.by !== 'object') return out;
  for (const [tagKey, creatures] of Object.entries(d.by)) {
    const tag = +tagKey;
    if (!whole(tag, 1, TAG_MOST) || !creatures || typeof creatures !== 'object') continue;
    const of = new Map();
    for (const [key, rec] of Object.entries(creatures)) {
      const ok = whole(+key, 1, ID) ? fromPlain(rec) : null;
      if (ok) of.set(+key, ok);
    }
    if (of.size) out.set(tag, of);
  }
  return out;
}

export function toTags(byTag) {
  const by = {};
  for (const [tag, creatures] of byTag) {
    by[tag] = {};
    for (const [creature, rec] of creatures) by[tag][creature] = plain(rec);
  }
  return { v: 1, by };
}

/**
 * Everything this computer has counted: each game's saved settings (lootIn of each) and what
 * the strip said since they were written, the larger of the two for each (they are the same
 * count, the strip's the newer), by the number the saved settings go by.
 * @param more  further such counts to take the larger of (what a copy has kept of its own: see collect.js)
 * @returns Map<tag, Map<creature, count>>
 */
export function lootByTag(accounts, heard = new Map(), more = new Map()) {
  const by = new Map();
  const take = (tag, of) => {
    let mine = by.get(tag);
    if (!mine) by.set(tag, (mine = new Map()));
    for (const [creature, rec] of of) mine.set(creature, larger(mine.get(creature), rec));
  };
  for (const one of accounts) if (one) take(one.tag, one.of);
  for (const [tag, of] of heard) take(tag, of);
  for (const [tag, of] of more) take(tag, of);
  return by;
}

/** ...and all of them added up: what this copy has to say. Map<creature, count> */
export function lootTotals(byTag) {
  const sum = new Map();
  for (const of of byTag.values()) for (const [creature, rec] of of) sum.set(creature, added(sum.get(creature), rec));
  return sum;
}

/** One creature's count as the lines it is sent as (several where one would be too long). */
export function lootLines(creature, rec) {
  const lines = [];
  const fill = (head, parts) => {
    let line = head;
    for (const part of parts) {
      if (line !== head && line.length + part.length + 1 > LINE_MOST) { lines.push(line); line = head; }
      line += `,${part}`;
    }
    return line;
  };
  // (how many corpses is said with what drops for anybody: once at least, though nothing was in any)
  const got = [...rec.got].sort((a, b) => a[0] - b[0]).map(([item, k]) => `${item},${k}`);
  if (rec.n > 0) lines.push(fill(`p,${creature},${rec.n}`, got));
  const on = [...rec.on].sort((a, b) => a[0] - b[0]).map(([item, [k, t]]) => `${item},${k},${t}`);
  if (on.length) lines.push(fill(`w,${creature}`, on));
  // (the pieces beyond the first of each find, and the coin: what a kill brings is reckoned from them)
  const more = [...(rec.more ?? [])].sort((a, b) => a[0] - b[0]).map(([item, m]) => `${item},${m}`);
  if (more.length) lines.push(fill(`m,${creature}`, more));
  const [cn, copper] = coinOf(rec);
  if (cn > 0) lines.push(`g,${creature},${cn},${copper}`);
  return lines;
}

/** The letters a line of these begins with (publish.js hands such lines on to readLootLine). */
export const LOOT_LINES = ['p', 'w', 'm', 'g'];

/** A line as it was sent, cut at its commas: { creature, count } - or null where it is not sound. */
export function readLootLine(parts) {
  if (!Array.isArray(parts) || !LOOT_LINES.includes(parts[0])) return null;
  // (whole numbers of eight figures at the most - the copper, which mounts up, of ten)
  if (!parts.slice(1).every((p, i) => (parts[0] === 'g' && i === 2 ? /^\d{1,10}$/ : /^\d{1,8}$/).test(p))) return null;
  const creature = +parts[1];
  if (!whole(creature, 1, ID)) return null;
  const rec = blank();
  if (parts[0] === 'p') {
    if (parts.length < 3 || parts.length % 2 !== 1) return null;
    rec.n = +parts[2];
    if (!whole(rec.n, 1, CORPSES_MOST)) return null;
    for (let i = 3; i < parts.length; i += 2) { if (+parts[i + 1] > rec.n) return null; rec.got.set(+parts[i], +parts[i + 1]); }
  } else if (parts[0] === 'w') {
    if (parts.length < 5 || (parts.length - 2) % 3 !== 0) return null;
    for (let i = 2; i < parts.length; i += 3) { if (+parts[i + 1] > +parts[i + 2]) return null; rec.on.set(+parts[i], [+parts[i + 1], +parts[i + 2]]); }
  } else if (parts[0] === 'm') {
    if (parts.length < 4 || parts.length % 2 !== 0) return null;
    for (let i = 2; i < parts.length; i += 2) rec.more.set(+parts[i], +parts[i + 1]);
  } else {
    if (parts.length !== 4) return null;
    rec.coin = [+parts[2], +parts[3]];
  }
  const ok = sound(rec);
  return ok ? { creature, count: ok } : null;
}

/** One copy's lines about a creature, taken one after another: the largest of each figure stands. */
export function takeLootLine(mine, said) {
  mine.set(said.creature, larger(mine.get(said.creature), said.count));
}

/**
 * Every copy's counts put together.
 * @param byCopy Map<copy, Map<creature, count>>
 * @param ref    Map<creature, [[item, per cent, pieces to a find where more than one], ...]>: the reference database's loot tables, or nothing
 * @param gold   Map<creature, copper>: the coin the reference database has a corpse give on average, or nothing
 * @returns Map<creature, { n, c, got: [[item, k]], on: [[item, k, t]], more: [[item, m]], coin: [corpses, copper], ref, gold }>
 */
export function foldLoot(byCopy, ref = null, gold = null) {
  const sum = new Map(), copies = new Map();
  for (const of of byCopy.values()) {
    for (const [creature, rec] of of) {
      sum.set(creature, added(sum.get(creature), rec));
      copies.set(creature, (copies.get(creature) ?? 0) + 1);
    }
  }
  const out = new Map();
  for (const [creature, rec] of sum) {
    const one = { n: rec.n, c: copies.get(creature) };
    if (rec.got.size) one.got = [...rec.got].sort((a, b) => a[0] - b[0]);
    if (rec.on.size) one.on = [...rec.on].sort((a, b) => a[0] - b[0]).map(([item, [k, t]]) => [item, k, t]);
    // (pieces of a thing nobody is counted as having found say nothing)
    const more = [...(rec.more ?? [])].filter(([item]) => rec.got.has(item)).sort((a, b) => a[0] - b[0]);
    if (more.length) one.more = more;
    const [cn, copper] = coinOf(rec);
    if (cn > 0) one.coin = [cn, copper];
    out.set(creature, one);
  }
  for (const [creature, list] of ref ?? []) {
    if (!Array.isArray(list) || !list.length) continue;
    const one = out.get(creature) ?? {};
    one.ref = list;
    out.set(creature, one);
  }
  for (const [creature, copper] of gold ?? []) {
    if (!(copper > 0)) continue;
    const one = out.get(creature) ?? {};
    one.gold = copper;
    out.set(creature, one);
  }
  return out;
}

/**
 * The published counts as a copy last fetched them (truth-loot.json, as the local store reads
 * it): Map<creature, { n, got: Map<item, k>, on: Map<item, [k, t]>, more: Map<item, m>, coin:
 * [corpses, copper], ref: Map<item, per cent>, each: Map<item, pieces to a find, where the
 * reference database has more than one>, gold: the reference database's coin to a corpse (0: none) }>.
 */
export function readLoot(local) {
  const out = new Map();
  if (!local || typeof local !== 'object') return out;
  for (const part of Object.values(local)) {
    for (const [key, rec] of Object.entries(part ?? {})) {
      const creature = Number(String(key).slice(1));
      if (!whole(creature, 1, ID) || !rec || typeof rec !== 'object') continue;
      const list = (v) => (Array.isArray(v) ? v.filter(Array.isArray) : []);
      const counted = sound({
        n: rec.n ?? 0, got: new Map(list(rec.got).map(([item, k]) => [item, k])), on: new Map(list(rec.on).map(([item, k, t]) => [item, [k, t]])),
        more: new Map(list(rec.more).map(([item, m]) => [item, m])), coin: rec.coin,
      }) ?? blank();
      const ref = new Map(), each = new Map();
      for (const [item, pct, pieces] of list(rec.ref)) {
        if (!(whole(item, 1, ID) && typeof pct === 'number' && Number.isFinite(pct) && pct > 0)) continue;
        ref.set(item, Math.min(100, pct));
        if (typeof pieces === 'number' && pieces > 1 && pieces <= EACH_MOST) each.set(item, pieces);
      }
      const gold = typeof rec.gold === 'number' && rec.gold > 0 && rec.gold <= COPPER_EACH ? rec.gold : 0;
      if (counted.n > 0 || counted.on.size || ref.size || gold > 0) out.set(creature, { ...counted, ref, each, gold });
    }
  }
  return out;
}

/**
 * What a copy last sent of its counts (loot-sent.json in the local store), and what it has to
 * say now: the creatures whose count has grown since, each with its lines.
 * @param sent   { [creature]: the count as it was sent (plain) }
 * @param totals Map<creature, count> (lootTotals)
 * @returns { lines: [a line as it is sent], now: { [creature]: plain } (what will have been sent, once these have gone) }
 */
export function lootNews(sent, totals) {
  const lines = [], now = {};
  const was = sent && typeof sent === 'object' ? sent : {};
  for (const [creature, rec] of [...totals].sort((a, b) => a[0] - b[0])) {
    const said = plain(rec);
    now[creature] = said;
    if (JSON.stringify(canon(was[creature])) === JSON.stringify(canon(said))) continue;
    for (const line of lootLines(creature, rec)) lines.push(line);
  }
  return { lines, now };
}
/** (a count as one text, whatever order it was written in) */
function canon(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const sorted = (o) => Object.entries(o ?? {}).sort((a, b) => +a[0] - +b[0]);
  return [rec.n ?? 0, sorted(rec.got), sorted(rec.on), sorted(rec.more), coinOf(rec)];
}

/**
 * What others have counted: the published count of a creature without what this copy sent of it
 * (what a copy sent is in what is published once that is made anew; until then a little of the
 * others' is taken off in its place, never more than there is).
 * @param published a record of readLoot()
 * @param mine      this copy's count as it last sent it (plain), or nothing
 */
export function others(published, mine) {
  const out = { n: published.n, got: new Map(published.got), on: new Map(published.on), more: new Map(published.more ?? []), coin: [...coinOf(published)] };
  const sent = fromPlain(mine);
  if (!sent) return out;
  out.n = Math.max(0, out.n - sent.n);
  for (const [item, m] of sent.more) { const left = Math.max(0, (out.more.get(item) ?? 0) - m); if (left > 0) out.more.set(item, left); else out.more.delete(item); }
  {
    const [cn, copper] = coinOf(sent);
    const left = [Math.max(0, out.coin[0] - cn), Math.max(0, out.coin[1] - copper)];
    out.coin = left[0] > 0 ? left : [0, 0];
  }
  for (const [item, k] of sent.got) { const left = Math.max(0, (out.got.get(item) ?? 0) - k); if (left > 0) out.got.set(item, left); else out.got.delete(item); }
  for (const [item, [k, t]] of sent.on) {
    const had = out.on.get(item);
    if (!had) continue;
    const left = [Math.max(0, had[0] - k), Math.max(0, had[1] - t)];
    if (left[1] > 0) out.on.set(item, [Math.min(left[0], left[1]), left[1]]); else out.on.delete(item);
  }
  // (a thing found in more corpses than are left: no more than those)
  for (const [item, k] of out.got) if (k > out.n) out.got.set(item, out.n);
  for (const [item] of out.got) if (!(out.got.get(item) > 0)) out.got.delete(item);
  return out;
}

export { added as addLoot, larger as largerLoot };
