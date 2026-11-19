// What the addon has noted of vendors, trainers and the game map's quest pins, read out of the
// game's saved settings as lines for the Atlas database.
//
// The addon (addon/AzerothAtlas/Learned.lua) notes what the game shows a player and no file
// has: what a vendor sells and for how much, what a trainer teaches and what it asks, and where
// the game's own map puts a quest. It keeps them in AzerothAtlasDB.learned, which the game
// writes to WTF/Account/<account>/SavedVariables/AzerothAtlas.lua at logout or /reload. Here
// that file's text becomes lines, one fact a line, with nothing of the player in them:
//
//   v,<vendor>,<item>,<copper for one purchase>,<how many one purchase gives>,<1: its stock runs out, 0: it never does>
//   t,<trainer>,<spell>,<copper>,<profession: its skill line, or 0>,<skill asked, or 0>,<level asked, or 0>
//   q,<quest>,<s|o|e>,<the game map's uiMapID>,<x per cent>,<y per cent>
//
// A vendor and a trainer are creatures, by their number. A price is the one a player was
// shown (a better standing lowers it: whoever puts the lines together goes by the highest).
// Of a trainer's line, profession 0 with a skill above 0 says: it asks for that much of a
// profession the game named but gave no number for. A quest's letter: s where it starts, o
// something of it still to do, e where it is handed in; its place is in per cent of that map,
// 0 to 100, always with two decimals.
//
// Only what is sound passes: whole numbers within their bounds, written the way the addon
// writes them. Saved settings of another addon, or broken ones, give no lines; nothing here
// throws.
import { luaValue } from './boats.js';

const ID = 16777215;      // the most a creature, item, spell, quest or map can be numbered
const COPPER = 2e9;
/** No more than the addon keeps (Learned.lua): of a list, and of one vendor, trainer or quest in it. */
const MOST = { v: [600, 200], t: [300, 400], q: [3000, 12] };

const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** "12,0,3" as its numbers - or null: not `count` whole numbers written plainly. */
function numbers(text, count) {
  if (typeof text !== 'string' || text.length > 48) return null;
  const parts = text.split(',');
  if (parts.length !== count || !parts.every((p) => /^\d{1,10}$/.test(p))) return null;
  return parts.map(Number);
}
/** "42.31" as hundredths of a per cent (4231) - or null: not a per cent of 0 to 100 with two decimals. */
function hundredths(text) {
  const m = /^(\d{1,3})\.(\d\d)$/.exec(text);
  if (!m) return null;
  const v = +m[1] * 100 + +m[2];
  return v <= 10000 ? v : null;
}
/** What is kept of one kind: [[its number, what is kept of it]], the sound ones, no more than the addon keeps. */
function kept(learned, kind) {
  const of = learned[kind]?.of;
  if (!of || typeof of !== 'object') return [];
  const out = [];
  for (const [id, rec] of Object.entries(of)) {
    if (out.length >= MOST[kind][0]) break;
    if (!/^\d{1,8}$/.test(id) || !whole(+id, 1, ID) || !rec || typeof rec !== 'object') continue;
    out.push([+id, Object.entries(rec).slice(0, MOST[kind][1])]);
  }
  return out;
}

/**
 * The lines of what the addon has noted, out of the text of a SavedVariables/AzerothAtlas.lua.
 * @returns {string[]} "v,...", "t,..." and "q,..." lines as above (none where there is nothing sound)
 */
export function learnedIn(text) {
  const lines = [];
  try {
    if (typeof text !== 'string') return [];
    const at = text.indexOf('AzerothAtlasDB = {');
    if (at < 0) return [];
    const learned = luaValue(text, at + 17)?.learned;
    if (!learned || typeof learned !== 'object') return [];
    for (const [npc, goods] of kept(learned, 'v')) {
      for (const [item, value] of goods) {
        const f = numbers(value, 3);
        if (!/^\d{1,8}$/.test(item) || !whole(+item, 1, ID) || !f) continue;
        const [copper, count, limited] = f;
        if (whole(copper, 0, COPPER) && whole(count, 1, 10000) && limited <= 1) lines.push(`v,${npc},${+item},${copper},${count},${limited}`);
      }
    }
    for (const [npc, lessons] of kept(learned, 't')) {
      for (const [spell, value] of lessons) {
        const f = numbers(value, 4);
        if (!/^\d{1,8}$/.test(spell) || !whole(+spell, 1, ID) || !f) continue;
        const [copper, skill, rank, level] = f;
        // (a profession with no number and no skill asked of it would say "asks for nothing": the addon notes no such line)
        if (whole(copper, 0, COPPER) && whole(skill, 0, ID) && whole(rank, 0, 1000) && whole(level, 0, 99)) lines.push(`t,${npc},${+spell},${copper},${skill},${rank},${level}`);
      }
    }
    for (const [quest, pins] of kept(learned, 'q')) {
      for (const [name, value] of pins) {
        // the pin's name: its letter, the map, and its place to the nearest per cent; its value: the place to two decimals
        const m = /^([soe]):(\d{1,8}):(\d{1,3}):(\d{1,3})$/.exec(name);
        const place = typeof value === 'string' && value.length <= 16 ? value.split(',') : [];
        if (!m || place.length !== 2) continue;
        const x = hundredths(place[0]), y = hundredths(place[1]);
        if (x === null || y === null || !whole(+m[2], 1, ID)) continue;
        if (Math.floor((x + 50) / 100) !== +m[3] || Math.floor((y + 50) / 100) !== +m[4]) continue;
        lines.push(`q,${quest},${m[1]},${+m[2]},${(x / 100).toFixed(2)},${(y / 100).toFixed(2)}`);
      }
    }
  } catch {
    return [];
  }
  return lines.filter((line) => line.length <= 100);
}
