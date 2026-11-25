// What each creature gives and how often, as the Atlas database has it and as this computer's
// own looting counted it, handed on to the addon in the game - which writes it into the
// creature's tooltip: after the line of the game's own that says what your quest still wants of
// it ("0/15 Bloodscalp Ear (22%)"), and as a list of everything else it gives (addon/
// AzerothAtlas/Drops.lua).
//
// What it is made from:
//
//   the original game's figures   every creature's record has `drops`, [[item a quest wants, how
//                                 often in per cent]] (atlasdb/records.js: QuestieDB's table), and
//                                 its record of what it gives has `ref`, the reference database's
//                                 loot table for it (atlasdb/loot.js). For the original game: a
//                                 place to start from, not a measurement of this one.
//   everybody's counts            the same record of what it gives: how many of its corpses the
//                                 copies' players looted, and in how many each thing was.
//   this computer's own counts    what the addon counted in the game's saved settings, and what it
//                                 has said through the strip since those were written
//                                 (<dataDir>/user/loot.json: loot.js) - the newest there is,
//                                 whether or not it has reached the database yet.
//
// The counts are handed on as counts, not as rates: the addon puts the rate together itself,
// leaning on the original game's figure less the more corpses there are (Drops.lua says how),
// because it goes on counting while you play and what it adds must weigh as much as what was
// here. For that it is told, of the counts written here, which part was its own - by the number
// the game's saved settings go by - so that nothing of yours is counted twice.
//
// What others counted is what is published without what this copy sent (atlasdb/loot.js, others).
//
// The addon can be handed nothing while the game runs but what the game itself loads. So, as
// with the boats' times (boats.js), all this is written as a small addon of its own beside it,
// AzerothAtlas_Drops: one file that sets it, which the game loads before Azeroth Atlas (which
// names it as one to load first, if it is there). It is taken up the next time the game loads
// its addons: when it starts, or on /reload. (The folder itself is only found when the game
// starts.) What you loot yourself needs no reload: the addon has that at once. Only ever
// written where Azeroth Atlas is installed, and only that one folder.
//
// The file, for two ages of the addon at once:
//
//   v, of, names, creatures, rates   as it has been since the first: of each creature the things a
//                                    quest wants, each with the original game's rate ("item=per
//                                    cent ..."), and what each thing is called. An addon from
//                                    before it counted anything (44 and older) reads these.
//   all       of each creature everything it gives: "<corpses> <item>=<per cent>/<k>/<t> ..." -
//             the original game's rate (nothing: none is known), and the count: in k of the
//             corpses (two figures), or in k of t corpses looted while a quest wanted it (three:
//             a thing that drops only with its quest). No count: nobody has found it yet.
//             For what a kill brings (the addon from 46 on reads these; one before it passes them
//             over), a thing may have two figures more, "<per cent>/<k>/<t>/<m>/<e>": the pieces
//             beyond the first of each find, in all, and how many pieces a corpse that has it
//             gives in the original game (where that is more than one) - and after the corpses
//             may stand the coin, "c<corpses whose coin was read>/<copper in them>/<the original
//             game's coin to a corpse>". What is not known is left empty.
//   kinds     of each thing: its quality (0 poor to 5 legendary), and 10 more where it is of the
//             game's "quest" kind - which only drops while a quest of yours wants it
//   mine      by the number a game's saved settings go by: of each creature the part of `all`
//             that those settings counted, laid out the same way without the rates
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { atlasStamp } from '../extractor/atlas.js';
import { flavourFolder } from '../extractor/config.js';
import { addonsDir } from './addon.js';
import { readLoot, lootIn, lootHeard, lootByTag, lootTotals, others, addLoot, largerLoot, fromPlain, fromTags } from '../atlasdb/loot.js';

const NAME = 'AzerothAtlas', DROPS = 'AzerothAtlas_Drops';
const FORMAT = 1;      // of what an addon from before 45 reads: raise when it is to read it differently
const LAYOUT = 2;      // of the rest: raise when the addon is to read `all`, `kinds` or `mine` differently
const ID_MOST = 16777215;
const QUEST_CLASS = 12; // the game's kind of item that is of a quest
const THINGS_MOST = 120; // things written of one creature (the likeliest)

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };
const whole = (v) => Number.isInteger(v) && v > 0 && v <= ID_MOST;

/** The game's saved settings of the addon, of every account: [file]. */
function savedSettings(cfg) {
  const out = [];
  try {
    const folder = flavourFolder(cfg);
    if (!folder) return out;
    const accounts = path.join(cfg.installRoot, folder, 'WTF', 'Account');
    for (const account of fs.readdirSync(accounts).sort()) out.push(path.join(accounts, account, 'SavedVariables', 'AzerothAtlas.lua'));
  } catch { /* no saved settings yet */ }
  return out;
}

/**
 * What the file is made from, as it stands on the disk: another text for another database,
 * other names, or another count of this computer's own - or null (no database fetched).
 * @param cfg  the configuration (for the game's saved settings); without it only the database counts
 */
export function dropsKey(dataDir, cfg = null) {
  const stamp = atlasStamp(dataDir);
  if (!stamp) return null;
  const loot = JSON.stringify(Object.entries(readJson(path.join(dataDir, 'atlasdb', 'truth-meta.json'))?.shards?.loot ?? {}).sort());
  const own = [stampOf(path.join(dataDir, 'user', 'loot.json')), stampOf(path.join(dataDir, 'atlasdb', 'loot-sent.json')), stampOf(path.join(dataDir, 'atlasdb', 'loot-own.json')), ...(cfg ? savedSettings(cfg).map(stampOf) : [])].join('|');
  return `${FORMAT}.${LAYOUT}:${stamp.hash}:${stampOf(path.join(dataDir, 'items.json'))}:${loot.length}.${hashText(loot)}:${own}`;
}
function hashText(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); }

/**
 * This computer's own counts, by the number each game's saved settings go by:
 * Map<tag, Map<creature, { n, got: Map<item, k>, on: Map<item, [k, t]> }>>. The game's saved
 * settings, what the strip has said since, and what this copy has kept of settings that are no
 * longer there (atlasdb/collect.js: loot-own.json) - of each figure the largest.
 */
export function ownLoot(dataDir, cfg = null) {
  const accounts = [];
  for (const file of cfg ? savedSettings(cfg) : []) { try { accounts.push(lootIn(fs.readFileSync(file, 'utf8'))); } catch { /* not there */ } }
  return lootByTag(accounts, lootHeard(dataDir), fromTags(readJson(path.join(dataDir, 'atlasdb', 'loot-own.json'))));
}

/**
 * Everything there is to hand on: { rev, of: Map<creature, [[item, per cent], ...]> (the things
 * quests want, with the original game's rates: what an addon from before 45 reads), names:
 * Map<item, its name>, rates (how many figures in `of`),
 *   all: Map<creature, { n (corpses looted), things: Map<item, { pct (the original game's rate, or null), k, t (null: of the n corpses),
 *     m (pieces beyond the first of each find; 0: none), e (pieces to a find in the original game, where more than one; else null) }>,
 *     coin: [corpses whose coin was read, the copper in them], gold (the original game's coin to a corpse; 0: none) }>,
 *   kinds: Map<item, quality + 10 where it is of the quest kind>, mine: Map<tag, Map<creature, count>>,
 *   things (how many in `all`), looted (corpses in `all`) }
 * - or null where no database has been fetched. A figure that is not above nought, or not a
 * figure, is left out; one above a hundred is a hundred.
 */
export function dropFigures(dataDir, cfg = null) {
  const stamp = atlasStamp(dataDir);
  const parts = stamp ? readJson(path.join(dataDir, 'atlasdb', 'truth-npc.json')) : null;
  if (!parts || typeof parts !== 'object') return null;
  const of = new Map(), wanted = new Set();
  let rates = 0;
  for (const part of Object.values(parts)) {
    for (const [key, rec] of Object.entries(part ?? {})) {
      const id = Number(key.slice(1));
      if (!whole(id) || !rec || !Array.isArray(rec.drops)) continue;
      const row = new Map();
      for (const pair of rec.drops) {
        if (!Array.isArray(pair)) continue;
        const [item, pct] = pair;
        if (whole(item) && typeof pct === 'number' && Number.isFinite(pct) && pct > 0) row.set(item, Math.min(100, Math.round(pct * 100) / 100));
      }
      // (a figure that rounds to nothing says nothing)
      for (const [item, pct] of row) if (!(pct > 0)) row.delete(item);
      if (!row.size) continue;
      of.set(id, [...row].sort((a, b) => a[0] - b[0]));
      rates += row.size;
      for (const item of row.keys()) wanted.add(item);
    }
  }
  const items = readJson(path.join(dataDir, 'items.json'))?.items;
  const known = items && typeof items === 'object' ? items : {};
  const hasItems = Object.keys(known).length > 1000; // (the map has been built: its list of the game's items is whole)
  const questKind = (item) => known[item]?.[2] === QUEST_CLASS;

  // ---- everything a creature gives: the original game's figures, everybody's counts, this computer's own
  const published = readLoot(readJson(path.join(dataDir, 'atlasdb', 'truth-loot.json')));
  const sent = readJson(path.join(dataDir, 'atlasdb', 'loot-sent.json')) ?? {};
  const mine = ownLoot(dataDir, cfg);
  const own = lootTotals(mine);
  const all = new Map(), kinds = new Map();
  let things = 0, looted = 0;
  for (const creature of new Set([...of.keys(), ...published.keys(), ...own.keys()])) {
    const pub = published.get(creature);
    // (this computer's own: what it counts now - and never less than what it has sent, which is in what is published)
    const counted = addLoot(pub ? others(pub, sent[creature]) : null, largerLoot(own.get(creature), pub ? fromPlain(sent[creature]) : null)) ?? { n: 0, got: new Map(), on: new Map() };
    const first = new Map(of.get(creature) ?? []), ref = pub?.ref ?? new Map();
    // (for what a kill brings: the pieces beyond the first of each find, the original game's pieces to a find, and the coin)
    const more = counted.more ?? new Map(), each = pub?.each ?? new Map();
    const coin = Array.isArray(counted.coin) && counted.coin[0] > 0 ? counted.coin : [0, 0], gold = pub?.gold > 0 ? pub.gold : 0;
    const row = new Map();
    for (const item of new Set([...first.keys(), ...ref.keys(), ...counted.got.keys(), ...counted.on.keys()])) {
      if (!whole(item)) continue;
      const pct = first.get(item) ?? (ref.has(item) ? Math.round(ref.get(item) * 100) / 100 : null);
      const got = counted.got.get(item), on = counted.on.get(item);
      // (counted both ways, as two copies may: the way the thing's own kind says)
      const quest = on && got ? questKind(item) : !!on;
      const thing = { pct: pct > 0 ? pct : null, k: 0, t: null, m: 0, e: null };
      if (quest) { thing.k = on[0]; thing.t = on[1]; } else if (got) thing.k = Math.min(got, counted.n);
      if (!quest && thing.k > 0 && more.get(item) > 0) thing.m = more.get(item);
      if (!quest && each.get(item) > 1) thing.e = Math.round(each.get(item) * 100) / 100;
      if (thing.pct === null && !thing.k && !(thing.t > 0)) continue;
      // (a thing of the original game's tables that this game's own files do not have, and nobody has found: not of this game)
      if (hasItems && !known[item] && !thing.k && !(thing.t > 0)) continue;
      row.set(item, thing);
      // (its kind: the game's own word on the item - or, of a thing the map's data does not have, how it was counted)
      kinds.set(item, Math.max(kinds.get(item) ?? 0, (Number.isInteger(known[item]?.[1]) ? Math.max(0, Math.min(9, known[item][1])) : 1) + (questKind(item) || (quest && !known[item]) ? 10 : 0)));
    }
    if (!row.size && !(counted.n > 0) && !(gold > 0)) continue;
    // (no more than a row holds: the likeliest, by what was counted and else by the original game's figure)
    const rate = (x) => (x.t > 0 ? x.k / x.t : x.t === null && counted.n > 0 && x.k > 0 ? x.k / counted.n : (x.pct ?? 0) / 100);
    const kept = [...row].sort((a, b) => rate(b[1]) - rate(a[1]) || a[0] - b[0]).slice(0, THINGS_MOST).sort((a, b) => a[0] - b[0]);
    all.set(creature, { n: counted.n, things: new Map(kept), coin, gold });
    things += kept.length; looted += counted.n;
    for (const [item] of kept) wanted.add(item);
  }
  for (const item of kinds.keys()) if (!wanted.has(item)) kinds.delete(item);
  // what each of those items is called, in the game's own words (none where the map has not been built: the addon asks the game)
  const names = new Map();
  for (const item of wanted) {
    const name = known[item]?.[0];
    if (typeof name === 'string' && name.trim() && name.length <= 200) names.set(item, name.trim());
  }
  return { rev: stamp.rev, of, names, rates, all, kinds, mine, things, looted };
}

/** A text as Lua writes one: between double quotes, with nothing in it that would end it early. */
const luaText = (s) => '"' + s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** A thing's figures, one after the other with a stroke between: what is not known is empty, and what is empty at the end is left off. */
function figuresText(list) {
  const parts = list.map((v) => (v === null || v === undefined || v === '' ? '' : String(v)));
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.join('/');
}
/** The coin after a row's corpses: " c<corpses whose coin was read>/<copper>/<the original game's>" - or nothing where none is known. */
function coinText(coin, gold) {
  const [cn, copper] = Array.isArray(coin) ? coin : [0, 0];
  if (!(cn > 0) && !(gold > 0)) return '';
  return ` c${cn > 0 ? cn : ''}/${cn > 0 ? copper : ''}/${gold > 0 ? gold : ''}`;
}
/** One creature's row of `all`: "<corpses> c<coin> <item>=<per cent>/<k>/<t>/<m>/<e> ...". */
function rowText(n, things, coin = null, gold = 0) {
  const out = [String(n) + coinText(coin, gold)];
  for (const [item, x] of things) out.push(`${item}=${figuresText([x.pct, x.t > 0 || x.k > 0 ? x.k : null, x.t > 0 ? x.t : null, x.m > 0 ? x.m : null, x.e > 1 ? x.e : null])}`);
  return out.join(' ');
}
/** ...and of `mine`: a count, laid out the same way without the rates. */
function countText(rec) {
  const out = [String(rec.n) + coinText(rec.coin, 0)];
  const ids = [...new Set([...rec.got.keys(), ...rec.on.keys()])].sort((a, b) => a - b);
  for (const item of ids) {
    const on = rec.on.get(item), more = on ? 0 : rec.more?.get(item);
    out.push(`${item}=${figuresText(['', on ? on[0] : rec.got.get(item), on ? on[1] : null, more > 0 ? more : null])}`);
  }
  return out.join(' ');
}

/** The small addon's files: { name: text }. */
export function dropsAddonFiles(figures, interfaceVersion) {
  const creatures = [...figures.of.keys()].sort((a, b) => a - b);
  const named = [...figures.names.keys()].sort((a, b) => a - b);
  const all = [...(figures.all ?? new Map())].sort((a, b) => a[0] - b[0]);
  const kinds = [...(figures.kinds ?? new Map())].sort((a, b) => a[0] - b[0]);
  const mine = [...(figures.mine ?? new Map())].sort((a, b) => a[0] - b[0]);
  return {
    [`${DROPS}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(drop rates)|r',
      '## Notes: What each creature gives and how often: the original game\'s figures, what every player of the map has counted, and what you have counted yourself. Written by the 3D map; Azeroth Atlas reads it as the game starts, and shows it in a creature\'s tooltip. There is nothing to turn on or off here: /atlas drops does that.',
      '## Group: AzerothAtlas',
      '',
      'drops.lua',
      '',
    ].join('\r\n'),
    'drops.lua': [
      '-- Azeroth Atlas: what each creature gives and how often. Written by the 3D map (server/drops.js):',
      '-- do not edit by hand. of: a creature, by the game\'s number for it - the things quests want, each',
      '-- with the original game\'s rate in per cent ("item=per cent ..."). names: what each thing is called,',
      '-- as the game\'s own files have it. all: everything a creature gives ("corpses looted',
      '-- item=per cent/found in so many/of so many ..."), kinds: each thing\'s quality, and 10 more where it',
      '-- is of a quest; mine: the part of `all` that each game\'s saved settings counted themselves.',
      `AzerothAtlasDrops = { v = ${FORMAT}, creatures = ${creatures.length}, rates = ${figures.rates}, of = {`,
      ...creatures.map((id) => `[${id}]="${figures.of.get(id).map(([item, pct]) => `${item}=${pct}`).join(' ')}",`),
      '}, names = {',
      ...named.map((item) => `[${item}]=${luaText(figures.names.get(item))},`),
      `}, f = ${LAYOUT}, things = ${figures.things ?? 0}, looted = ${figures.looted ?? 0}, all = {`,
      ...all.map(([id, row]) => `[${id}]="${rowText(row.n, row.things, row.coin, row.gold)}",`),
      '}, kinds = {',
      ...kinds.map(([item, kind]) => `[${item}]=${kind},`),
      '}, mine = {',
      ...mine.flatMap(([tag, creatures2]) => [`[${tag}]={`, ...[...creatures2].sort((a, b) => a[0] - b[0]).map(([id, rec]) => `[${id}]="${countText(rec)}",`), '},']),
      '} }',
      '',
    ].join('\n'),
  };
}

// (what was last looked at, and found written as it should be: nothing is read again until the database, the names or this computer's own count change)
let settled = null;

/**
 * Write the file for the addon, where it is not there as it stands.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), creatures, rates, named, things, looted } -
 *          or null where there is nothing to write (no database fetched, none of its creatures
 *          with a figure), or no Azeroth Atlas in the game to write it for
 */
export function writeDropsAddon(cfg, dataDir) {
  const dir = addonsDir(cfg);
  if (!dir || !fs.existsSync(path.join(dir, NAME, `${NAME}.toc`))) return null;
  const folder = path.join(dir, DROPS);
  let iface = '0';
  try { iface = /^## Interface:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, NAME, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? '0'; } catch { /* as it is */ }
  const key = dropsKey(dataDir, cfg);
  if (!key) return null;
  const now = `${folder}|${iface}|${key}`;
  if (settled?.key === now && fs.existsSync(path.join(folder, 'drops.lua')) && fs.existsSync(path.join(folder, `${DROPS}.toc`))) return { ...settled.said, written: false, fresh: false };
  const figures = dropFigures(dataDir, cfg);
  if (!figures || (!figures.of.size && !figures.all.size)) return null;
  const files = dropsAddonFiles(figures, iface);
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
  const said = { creatures: figures.of.size, rates: figures.rates, named: figures.names.size, things: figures.things, looted: figures.looted };
  settled = { key: now, said };
  return { ...said, written, fresh: fresh && written };
}
