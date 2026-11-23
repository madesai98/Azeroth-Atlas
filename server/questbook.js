// What each quest gives, and which quests lead to which dungeon, as the Atlas database has it,
// handed on to the addon in the game - which orders the quests it tracks for you by what they
// give, and tracks the quests of one dungeon with the quests that lead up to them
// (addon/AzerothAtlas/Tracked.lua).
//
// The game answers what a quest of your log gives (its experience for your level, its money,
// the things it hands out or lets you choose from). It does not say what a vendor pays for a
// thing it has not shown you yet, and it knows nothing of which quest comes before which. So:
//
//   gives     for each quest, as the database has it: experience, copper, and the things given
//             and the things to choose one of. Used where the game does not say.
//   sell      what a vendor pays for one of each of those things: the map's own, read out of the
//             game's files (<dataDir>/items.json).
//   dungeons  the dungeons the map knows (<dataDir>/world.json, as the 3D map leads you to
//             their doors), each with the quests done in it - the quests the database files
//             under the dungeon's own area - and the quests that lead up to those: every quest
//             one of them asks for first (one of `pre`, all of `preAll`), every quest that names
//             one as what comes next (`nx`) or as what it sends you on to (`crumbFor`), and so
//             on back along the chain.
//
// Written, like the drop rates (drops.js), as a small addon of its own beside Azeroth Atlas,
// AzerothAtlas_Quests: one file that sets it all, which the game loads before Azeroth Atlas.
// Taken up the next time the game loads its addons: when it starts, or on /reload. (The folder
// itself is only found when the game starts.) Only ever written where Azeroth Atlas is
// installed, and only that one folder.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { atlasStamp, readAtlas } from '../extractor/atlas.js';
import { addonsDir } from './addon.js';

const NAME = 'AzerothAtlas', BOOK = 'AzerothAtlas_Quests';
const FORMAT = 1;        // of what is written: raise when the addon is to read it differently
const ID_MOST = 16777215;
const CHAIN_MOST = 600;  // quests leading up to one dungeon's, at most (a chain that long is a mistake in the data)
const SELL = 7;          // where an item's row in items.json has what a vendor pays for it

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };
const whole = (v) => Number.isInteger(v) && v > 0 && v <= ID_MOST;
const ids = (list) => (Array.isArray(list) ? list.filter(whole) : []);
const pairs = (list) => (Array.isArray(list) ? list.filter((p) => Array.isArray(p) && whole(p[0])).map((p) => [p[0], whole(p[1]) ? Math.min(p[1], 9999) : 1]) : []);

/** What it is made from, as it stands on the disk: another text for another database, other items or other dungeons - or null (no database fetched). */
export function bookKey(dataDir) {
  const stamp = atlasStamp(dataDir);
  return stamp ? `${FORMAT}:${stamp.hash}:${stampOf(path.join(dataDir, 'items.json'))}:${stampOf(path.join(dataDir, 'world.json'))}:${stampOf(path.join(dataDir, 'manifest.json'))}` : null;
}

/**
 * The book, from the database as last fetched:
 *   { rev, gives: Map<quest, { xp, money, given: [[item, how many]], choice: [[item, how many]] }>,
 *     sell: Map<item, copper>, dungeons: [{ name, map, level, own: [quest], up: [quest] }] }
 * - or null where no database has been fetched. `own`: the quests done in the dungeon; `up`: the
 * quests that lead up to them (none of them among `own`). The dungeons by the level their quests
 * ask for, lowest first.
 */
export function questBook(dataDir) {
  const atlas = readAtlas(dataDir);
  if (!atlas) return null;
  const items = readJson(path.join(dataDir, 'items.json'))?.items ?? null;
  const gives = new Map(), sell = new Map();
  for (const [id, q] of atlas.quest) {
    if (!whole(id)) continue;
    const xp = whole(q.xp) ? q.xp : 0, money = whole(q.money) ? q.money : 0;
    const given = pairs(q.ri), choice = pairs(q.rc);
    if (!xp && !money && !given.length && !choice.length) continue;
    gives.set(id, { xp, money, given, choice });
    for (const [item] of [...given, ...choice]) {
      const price = items?.[item]?.[SELL];
      if (Number.isInteger(price) && price > 0 && !sell.has(item)) sell.set(item, price);
    }
  }
  // what has to be done before each quest: what it asks for, and what names it as coming next
  const before = new Map();
  const lead = (from, to) => { if (!whole(from) || !whole(to) || from === to) return; let s = before.get(to); if (!s) before.set(to, (s = new Set())); s.add(from); };
  for (const [id, q] of atlas.quest) {
    for (const p of [...ids(q.pre), ...ids(q.preAll)]) lead(p, id);
    lead(id, q.nx);
    lead(id, q.crumbFor);
  }
  const dungeons = [];
  // (a place the game does not count as a dungeon or a raid - the Deeprun Tram, which the map
  // leads you into like one - is none here: by the game's own word for each map, where the
  // map's data has it)
  const kindOf = new Map((readJson(path.join(dataDir, 'manifest.json'))?.maps ?? []).filter((m) => m && Number.isInteger(m.id)).map((m) => [m.id, m.instanceType]));
  for (const d of readJson(path.join(dataDir, 'world.json'))?.dungeons ?? []) {
    if (!d || typeof d.name !== 'string' || !d.name.trim()) continue;
    if (kindOf.get(d.map) === 0) continue;
    const areas = new Set([d.area, ...(Array.isArray(d.also) ? d.also : [])].filter(whole));
    const own = [];
    for (const [id, q] of atlas.quest) if (whole(id) && areas.has(q.z)) own.push(id);
    if (!own.length) continue;
    const mine = new Set(own), up = new Set(), queue = [...own];
    for (let i = 0; i < queue.length && up.size < CHAIN_MOST; i++) {
      for (const p of before.get(queue[i]) ?? []) {
        if (mine.has(p) || up.has(p)) continue;
        up.add(p);
        queue.push(p);
      }
    }
    // (the level of its quests, for the order the dungeons are listed in: the middle one - a stray quest for beginners does not make Blackrock Depths a beginner's)
    const levels = own.map((id) => atlas.quest.get(id)).map((q) => (whole(q.l) ? q.l : whole(q.m) ? q.m : 0)).filter((v) => v > 0 && v < 200).sort((a, b) => a - b);
    dungeons.push({ name: d.name.trim().slice(0, 80), map: whole(d.map) ? d.map : 0, level: levels.length ? levels[Math.floor(levels.length / 2)] : 0, own: own.sort((a, b) => a - b), up: [...up].sort((a, b) => a - b) });
  }
  dungeons.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  return { rev: atlas.rev, gives, sell, dungeons };
}

/** A text as Lua writes one: between double quotes, with nothing in it that would end it early. */
const luaText = (s) => '"' + s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const things = (list) => list.map(([item, many]) => (many > 1 ? `${item}*${many}` : `${item}`)).join(' ');

/** The small addon's files: { name: text }. */
export function bookAddonFiles(book, interfaceVersion) {
  const quests = [...book.gives.keys()].sort((a, b) => a - b), sold = [...book.sell.keys()].sort((a, b) => a - b);
  const line = (id) => { const g = book.gives.get(id); return `${g.xp} ${g.money}${g.given.length || g.choice.length ? ` ${things(g.given)}|${things(g.choice)}` : ''}`; };
  return {
    [`${BOOK}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(quests)|r',
      '## Notes: What each quest gives and which quests lead to which dungeon, as the Atlas database has it. Written by the 3D map; Azeroth Atlas reads it as the game starts, to order the quests it tracks for you and to track a dungeon\'s quests with those that lead up to them. There is nothing to turn on or off here.',
      '## Group: AzerothAtlas',
      '',
      'quests.lua',
      '',
    ].join('\r\n'),
    'quests.lua': [
      '-- Azeroth Atlas: what each quest gives, and which quests lead to which dungeon, as the Atlas',
      '-- database has it. Written by the 3D map (server/questbook.js): do not edit by hand.',
      '--   gives     a quest, by the game\'s number for it: "experience copper", and where it gives',
      '--             things, " given|to choose one of" (each "item" or "item*how many")',
      '--   sell      what a vendor pays for one of each of those things, in copper',
      '--   dungeons  each with the quests done in it (own) and the quests that lead up to those (up)',
      `AzerothAtlasQuests = { v = ${FORMAT}, quests = ${quests.length}, gives = {`,
      ...quests.map((id) => `[${id}]="${line(id)}",`),
      '}, sell = {',
      ...sold.map((item) => `[${item}]=${book.sell.get(item)},`),
      '}, dungeons = {',
      ...book.dungeons.map((d) => `{ name = ${luaText(d.name)}, map = ${d.map}, level = ${d.level}, own = "${d.own.join(' ')}", up = "${d.up.join(' ')}" },`),
      '} }',
      '',
    ].join('\n'),
  };
}

// (what was last looked at, and found written as it should be: nothing is read again until the database, the items or the dungeons change)
let settled = null;

/**
 * Write the book for the addon, where it is not there as it stands.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), quests, items, dungeons } -
 *          or null where there is nothing to write (no database fetched), or no Azeroth Atlas in
 *          the game to write it for
 */
export function writeBookAddon(cfg, dataDir) {
  const dir = addonsDir(cfg);
  if (!dir || !fs.existsSync(path.join(dir, NAME, `${NAME}.toc`))) return null;
  const folder = path.join(dir, BOOK);
  let iface = '0';
  try { iface = /^## Interface:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, NAME, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? '0'; } catch { /* as it is */ }
  const key = bookKey(dataDir);
  if (!key) return null;
  const now = `${folder}|${iface}|${key}`;
  if (settled?.key === now && fs.existsSync(path.join(folder, 'quests.lua')) && fs.existsSync(path.join(folder, `${BOOK}.toc`))) return { ...settled.said, written: false, fresh: false };
  const book = questBook(dataDir);
  if (!book || !book.gives.size) return null;
  const files = bookAddonFiles(book, iface);
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
  const said = { quests: book.gives.size, items: book.sell.size, dungeons: book.dungeons.length };
  settled = { key: now, said };
  return { ...said, written, fresh: fresh && written };
}
