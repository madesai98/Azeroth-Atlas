// What the QuestieDB addon keeps beside its data file, in its support folder: how much
// experience each quest gives, and how often each creature drops the things quests ask for.
// Like the data file (see questie.js) these are only read, and read as text: nothing in them
// is run.
//
// The files, under <addon folder>/support/Forever. The addon's toc lists them in the order the
// game loads them; Questie's QuestieXP.lua and dropDB.lua are what use them:
//
//   QuestXP/xpDB-classic.lua    QuestXP.db = { [questId] = {level, xp}, ... }: the original game.
//   QuestXP/xpDB-traces.lua     QuestXP.db[questId] = {level, xp}, a line each: measured in this
//                               game, from players' sessions. Loaded after the first, so where
//                               both name a quest, this is the one that stands.
//   DropTables/classicItemDrops.lua
//                               two tables kept as text, each [itemId] = { [npcId] = per cent }:
//                               wowheadData (every creature Wowhead lists for an item some quest
//                               asks for) and cmangosData (items that only drop while on their
//                               quest, from the cmangos database of the original game).
//   Zones/dungeons.lua         the dungeons, and where each is entered from: [areaId] = { name,
//                               other area ids its quests are filed under, the zone its door is in,
//                               { { zone, x, y }, ... } } - a door as per cent across and down the
//                               zone's map. (What the file changes in that table for later
//                               versions of the game is not this game's, and is not read.)
//   DropTables/itemDropCorrections.lua
//                               rates put right by hand, a table per expansion (Era, Tbc, ...). A
//                               value below zero is not a rate: it says which of the two tables
//                               to believe for that creature (-1 Wowhead, -2 cmangos). This game
//                               counts as the original game, so only the table Era is used.
//
// Asked about one item from one creature, the addon believes, in this order: a rate put right by
// hand, the cmangos table, the Wowhead table. `drops` is that answer for every pair there is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FLAVOUR = 'Forever';
export const DROPS_FROM = 'QuestieDB (Wowhead, original game)';
// where one rate came from, by the addon's own names for them
const WOWHEAD = 'wowhead', CMANGOS = 'cmangos', BY_HAND = 'questie';
// the tables of corrections this game uses, in the order they are laid over each other
const CORRECTIONS_USED = ['Era'];

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
/** Lua source without its comments (none of these files has a text string a `--` could be part of). */
const uncommented = (src) => src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');

/** The `[questId] = {level, xp}` lines of one experience file, as written: Map<questId, [level, xp] | null (taken away)>. */
function xpLines(src) {
  const out = new Map();
  for (const m of uncommented(src).matchAll(/^[ \t]*(?:QuestXP\.db)?\[(\d+)\][ \t]*=[ \t]*(?:\{[ \t]*(-?\d+)[ \t]*,[ \t]*(-?\d+)[ \t]*\}|(nil)\b)/gm)) {
    out.set(+m[1], m[4] ? null : [+m[2], +m[3]]);
  }
  return out;
}

/** A Lua table two levels deep, `[id] = { [id] = value, ... }`: Map<id, Map<id, number | the name written there>>. */
function nested(src) {
  const out = new Map();
  for (const m of src.matchAll(/\[(\d+)\]\s*=\s*\{([^{}]*)\}/g)) {
    const row = new Map();
    for (const e of m[2].matchAll(/\[(\d+)\]\s*=\s*([^,\s]+)/g)) {
      const n = Number(e[2]);
      row.set(+e[1], Number.isFinite(n) ? n : e[2]);
    }
    out.set(+m[1], row); // (an id written twice: the later one stands, as it does in Lua)
  }
  return out;
}

/** Only the real rates of a drop table. */
function rates(table) {
  const out = new Map();
  for (const [item, row] of table) {
    const kept = new Map([...row].filter(([, v]) => typeof v === 'number' && v >= 0));
    if (kept.size) out.set(item, kept);
  }
  return out;
}

const pairsIn = (table) => { let n = 0; for (const row of table.values()) n += row.size; return n; };

/**
 * @param tocFile  the QuestieDB data file (see findQuestieDb()); its support folder is looked for beside it.
 *                 A file or a folder that is not there gives empty maps, never an error.
 * @returns {{
 *   folder: string|null,
 *   xp: Map<questId, { level, xp, from: 'traces'|'classic' }>   level: the quest's level; xp: what it gives a character
 *                                                                 of about that level (the game gives less to one well above it),
 *   xpStats: { classic, traces, both, same, changed, classicOnly, tracesOnly, total, nothing },
 *   drops: Map<itemId, Map<npcId, percent>>,
 *   dropsFrom: 'QuestieDB (Wowhead, original game)',
 *   dropSources: Map<itemId, Map<npcId, 'wowhead'|'cmangos'|'questie'>>   where each rate in `drops` came from (questie: put right by hand),
 *   dropStats: { items, pairs, wowhead, cmangos, questie (how many rates came from each), tables: { wowhead, cmangos, corrections: { items, pairs } },
 *                pointers (corrections that only name a table), pointersUnmet (...which had nothing for them), above100 } }}
 */
/**
 * The dungeons QuestieDB knows, and where each is entered from (Zones/dungeons.lua):
 * { list: [{ area, name, also: [area ids its quests are filed under as well], doors: [{ zone, x, y }]
 * (per cent across and down that zone's map) }], hash (of the file: '' where there is none) }.
 * A dungeon whose door depends on your side (the battlegrounds) is left out.
 */
export function readQuestieDungeons(tocFile) {
  const src = typeof tocFile === 'string' && tocFile ? read(path.join(path.dirname(tocFile), 'support', FLAVOUR, 'Zones', 'dungeons.lua')) : '';
  const list = [];
  // (the table itself: from its opening to the brace that closes it at the start of a line)
  const begin = src.indexOf('local dungeons = {');
  const end = begin < 0 ? -1 : src.slice(begin).search(/^\}/m);
  if (begin >= 0 && end > 0) {
    const body = uncommented(src.slice(begin, begin + end));
    for (const m of body.matchAll(/\[(\d+)\]\s*=\s*\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*(nil|\{[^{}]*\})\s*,\s*\d+\s*,\s*\{((?:\s*\{[^{}()]*\}\s*,?)+)\s*\}\s*\}/g)) {
      const doors = [...m[4].matchAll(/\{\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}/g)].map((d) => ({ zone: +d[1], x: +d[2], y: +d[3] })).filter((d) => d.x >= 0 && d.x <= 100 && d.y >= 0 && d.y <= 100);
      if (doors.length) list.push({ area: +m[1], name: m[2].replace(/\\(.)/g, '$1'), also: m[3] === 'nil' ? [] : [...m[3].matchAll(/\d+/g)].map((n) => +n[0]), doors });
    }
  }
  return { list, hash: src ? crypto.createHash('sha1').update(src).digest('hex').slice(0, 16) : '' };
}

export function readQuestieExtras(tocFile) {
  const folder = typeof tocFile === 'string' && tocFile ? path.join(path.dirname(tocFile), 'support', FLAVOUR) : null;
  const source = (...parts) => (folder ? read(path.join(folder, ...parts)) : '');

  // ---- quest experience ----------------------------------------------------------------------
  const classic = xpLines(source('QuestXP', 'xpDB-classic.lua')), traces = xpLines(source('QuestXP', 'xpDB-traces.lua'));
  const xp = new Map();
  // in the order the game loads them: what a later file says about a quest replaces what was there
  for (const [from, lines] of [['classic', classic], ['traces', traces]]) {
    for (const [id, v] of lines) {
      if (v) xp.set(id, { level: v[0], xp: v[1], from });
      else xp.delete(id);
    }
  }
  const xpStats = { classic: classic.size, traces: traces.size, both: 0, same: 0, changed: 0, classicOnly: 0, tracesOnly: 0, total: xp.size, nothing: 0 };
  for (const [id, v] of traces) {
    const old = classic.get(id);
    if (!old) xpStats.tracesOnly++;
    else { xpStats.both++; if (v && v[0] === old[0] && v[1] === old[1]) xpStats.same++; else xpStats.changed++; }
  }
  xpStats.classicOnly = classic.size - xpStats.both;
  // (a level or an amount that is not above zero: the addon shows no experience for the quest)
  for (const v of xp.values()) if (!(v.level > 0 && v.xp > 0)) xpStats.nothing++;

  // ---- what drops from whom ------------------------------------------------------------------
  const tables = new Map(); // name -> table, for each `Module.name = [[return { ... }]]`
  for (const m of uncommented(source('DropTables', 'classicItemDrops.lua')).matchAll(/\.(\w+)\s*=\s*\[(=*)\[([\s\S]*?)\]\2\]/g)) tables.set(m[1], rates(nested(m[3])));
  const wowhead = tables.get('wowheadData') ?? new Map(), cmangos = tables.get('cmangosData') ?? new Map();

  // corrections: a rate, or the name of the table to believe (DropKeys.WOWHEAD / .PSERVER, or their numbers -1 / -2)
  const byTable = new Map();
  const parts = uncommented(source('DropTables', 'itemDropCorrections.lua')).split(/QuestieItemDropCorrections\.(\w+)\s*=/);
  for (let i = 1; i + 1 < parts.length; i += 2) byTable.set(parts[i], nested(parts[i + 1]));
  const corrections = new Map();
  for (const name of CORRECTIONS_USED) {
    for (const [item, row] of byTable.get(name) ?? []) {
      const kept = new Map();
      for (const [npc, v] of row) {
        if (typeof v === 'number' && v >= 0) kept.set(npc, v);
        else if (v === -1 || /(^|\.)WOWHEAD$/.test(v)) kept.set(npc, WOWHEAD);
        else if (v === -2 || /(^|\.)PSERVER$/.test(v)) kept.set(npc, CMANGOS);
      }
      corrections.set(item, kept); // (a later table's word on an item replaces an earlier table's, whole)
    }
  }

  const drops = new Map(), dropSources = new Map();
  const dropStats = {
    items: 0, pairs: 0, wowhead: 0, cmangos: 0, questie: 0,
    tables: { wowhead: { items: wowhead.size, pairs: pairsIn(wowhead) }, cmangos: { items: cmangos.size, pairs: pairsIn(cmangos) }, corrections: { items: corrections.size, pairs: pairsIn(corrections) } },
    pointers: 0, pointersUnmet: 0, above100: 0,
  };
  const sorted = (keys) => [...new Set(keys)].sort((a, b) => a - b);
  for (const item of sorted([...wowhead.keys(), ...cmangos.keys(), ...corrections.keys()])) {
    const w = wowhead.get(item), c = cmangos.get(item), fix = corrections.get(item);
    const row = new Map(), from = new Map();
    for (const npc of sorted([...(w?.keys() ?? []), ...(c?.keys() ?? []), ...(fix?.keys() ?? [])])) {
      const said = fix?.get(npc), wr = w?.get(npc), cr = c?.get(npc);
      let got = null;
      if (typeof said === 'number') got = [said, BY_HAND];
      else {
        if (said) dropStats.pointers++;
        // a correction that points at a table with nothing to say is passed over
        if (said === WOWHEAD && wr !== undefined) got = [wr, WOWHEAD];
        else if (said === CMANGOS && cr !== undefined) got = [cr, CMANGOS];
        else if (cr !== undefined) got = [cr, CMANGOS];
        else if (wr !== undefined) got = [wr, WOWHEAD];
        if (said && (!got || got[1] !== said)) dropStats.pointersUnmet++;
      }
      if (!got) continue;
      row.set(npc, got[0]);
      from.set(npc, got[1]);
      dropStats[got[1]]++;
      if (got[0] > 100) dropStats.above100++; // (Wowhead's table has a few such; they are passed on as they are)
    }
    if (!row.size) continue;
    drops.set(item, row);
    dropSources.set(item, from);
    dropStats.pairs += row.size;
  }
  dropStats.items = drops.size;

  return { folder, xp, xpStats, drops, dropsFrom: DROPS_FROM, dropSources, dropStats };
}
