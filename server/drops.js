// How often each creature drops what quests ask for, as the Atlas database has it, handed on to
// the addon in the game - which puts the figure after the line of the game's own tooltip that
// says what your quest still wants of the creature under the mouse ("0/15 Bloodscalp Ear (22%)":
// addon/AzerothAtlas/Drops.lua).
//
// The figures are the database's, not the addon's: every creature's record has `drops`, [[item
// a quest wants, how often in per cent]] (atlasdb/records.js), and this copy has the database
// as it last fetched it (<dataDir>/atlasdb/truth-npc.json). What an item is called is the map's
// own (<dataDir>/items.json, read out of the game's files): the game's tooltip names the item
// and gives no number for it, so the name is how the line is told.
//
// The addon can be handed nothing while the game runs but what the game itself loads. So, as
// with the boats' times (boats.js), the figures are written as a small addon of their own
// beside it, AzerothAtlas_Drops: one file that sets them, which the game loads before Azeroth
// Atlas (which names it as one to load first, if it is there). They are taken up the next time
// the game loads its addons: when it starts, or on /reload. (The folder itself is only found
// when the game starts.) Only ever written where Azeroth Atlas is installed, and only that one
// folder.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { atlasStamp } from '../extractor/atlas.js';
import { addonsDir } from './addon.js';

const NAME = 'AzerothAtlas', DROPS = 'AzerothAtlas_Drops';
const FORMAT = 1;      // of what is written: raise when the addon is to read it differently
const ID_MOST = 16777215;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };
const whole = (v) => Number.isInteger(v) && v > 0 && v <= ID_MOST;

/** What the figures are made from, as it stands on the disk: another text for another database or other names - or null (no database fetched). */
export function dropsKey(dataDir) {
  const stamp = atlasStamp(dataDir);
  return stamp ? `${FORMAT}:${stamp.hash}:${stampOf(path.join(dataDir, 'items.json'))}` : null;
}

/**
 * The figures of the database as last fetched: { rev, of: Map<creature, [[item, per cent], ...]>,
 * names: Map<item, its name>, rates (how many figures) } - or null where no database has been
 * fetched. A figure that is not above nought, or not a figure, is left out; one above a hundred
 * is a hundred.
 */
export function dropFigures(dataDir) {
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
  // what each of those items is called, in the game's own words (none where the map has not been built: the addon asks the game)
  const names = new Map();
  const items = readJson(path.join(dataDir, 'items.json'))?.items;
  if (items && typeof items === 'object') {
    for (const item of wanted) {
      const name = items[item]?.[0];
      if (typeof name === 'string' && name.trim() && name.length <= 200) names.set(item, name.trim());
    }
  }
  return { rev: stamp.rev, of, names, rates };
}

/** A text as Lua writes one: between double quotes, with nothing in it that would end it early. */
const luaText = (s) => '"' + s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** The small addon's files: { name: text }. */
export function dropsAddonFiles(figures, interfaceVersion) {
  const creatures = [...figures.of.keys()].sort((a, b) => a - b);
  const named = [...figures.names.keys()].sort((a, b) => a - b);
  return {
    [`${DROPS}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(drop rates)|r',
      '## Notes: How often each creature drops what quests ask for, as the Atlas database has it. Written by the 3D map; Azeroth Atlas reads it as the game starts, and shows it in a creature\'s tooltip beside what your quest wants of it. There is nothing to turn on or off here: /atlas drops does that.',
      '## Group: AzerothAtlas',
      '',
      'drops.lua',
      '',
    ].join('\r\n'),
    'drops.lua': [
      '-- Azeroth Atlas: how often each creature drops what quests ask for, as the Atlas database has',
      '-- it. Written by the 3D map (server/drops.js): do not edit by hand. A creature, by the game\'s',
      '-- number for it: the items, each with how often it drops in per cent ("item=per cent ..."). And',
      '-- what each of those items is called, as the game\'s own files have it.',
      `AzerothAtlasDrops = { v = ${FORMAT}, creatures = ${creatures.length}, rates = ${figures.rates}, of = {`,
      ...creatures.map((id) => `[${id}]="${figures.of.get(id).map(([item, pct]) => `${item}=${pct}`).join(' ')}",`),
      '}, names = {',
      ...named.map((item) => `[${item}]=${luaText(figures.names.get(item))},`),
      '} }',
      '',
    ].join('\n'),
  };
}

// (what was last looked at, and found written as it should be: nothing is read again until the database or the names change)
let settled = null;

/**
 * Write the figures for the addon, where they are not there as they stand.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), creatures, rates, named } -
 *          or null where there is nothing to write (no database fetched, none of its creatures
 *          with a figure), or no Azeroth Atlas in the game to write it for
 */
export function writeDropsAddon(cfg, dataDir) {
  const dir = addonsDir(cfg);
  if (!dir || !fs.existsSync(path.join(dir, NAME, `${NAME}.toc`))) return null;
  const folder = path.join(dir, DROPS);
  let iface = '0';
  try { iface = /^## Interface:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, NAME, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? '0'; } catch { /* as it is */ }
  const key = dropsKey(dataDir);
  if (!key) return null;
  const now = `${folder}|${iface}|${key}`;
  if (settled?.key === now && fs.existsSync(path.join(folder, 'drops.lua')) && fs.existsSync(path.join(folder, `${DROPS}.toc`))) return { ...settled.said, written: false, fresh: false };
  const figures = dropFigures(dataDir);
  if (!figures || !figures.of.size) return null;
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
  const said = { creatures: figures.of.size, rates: figures.rates, named: figures.names.size };
  settled = { key: now, said };
  return { ...said, written, fresh: fresh && written };
}
