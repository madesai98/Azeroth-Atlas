// Writes the addon's list of what quests ask after (addon/AzerothAtlas/QuestAsks.lua): the
// professions and skills, the factions and the spells that some quest wants a character to
// have, to stand well with, or to know - from QuestieDB, as the map reads it. Run it when a
// newer QuestieDB has quests that ask after something new:
//   node tools/make-quest-asks.mjs [the data file of a QuestieDB]     (the default: the one the map is built from)
//
// Why the addon wants them: the 3D map shows a quest giver's "!" only for a quest your character
// can take (viewer/js/questopen.js), and so has to know how far you are in a profession, where
// you stand with a faction and whether you know a spell. The game answers such questions one
// at a time, by the number of the thing asked after: this is the list of numbers to ask
// (Self.lua asks, and tells the map). Something a quest asks after that is not on the list is
// not known to the map, and is not held against the quest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../extractor/config.js';
import { findQuestieDb, readQuestie } from '../extractor/questie.js';
import { SPECIALISATIONS } from '../viewer/js/questopen.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? findQuestieDb(loadConfig());
if (!file) throw new Error('no QuestieDB to read (run Update map first, or name its data file)');
const db = readQuestie(file);
const skills = new Set(), factions = new Set(), spells = new Set();
const whole = (v, most) => Number.isInteger(v) && v > 0 && v <= most;
for (const q of db.quests) {
  if (q.requiredSkill) skills.add(q.requiredSkill[0]);
  for (const r of q.requiredRanks ?? []) skills.add(r[0]);
  if (q.requiredMinRep) factions.add(q.requiredMinRep[0]);
  if (q.requiredMaxRep) factions.add(q.requiredMaxRep[0]);
  if (q.requiredSpell) spells.add(Math.abs(q.requiredSpell));
  // (a specialisation asked for by its own spell; a profession stands for "none chosen yet": its specialisations are below)
  if (q.requiredSpecialization > 0 && !SPECIALISATIONS[q.requiredSpecialization]) spells.add(q.requiredSpecialization);
}
for (const list of Object.values(SPECIALISATIONS)) for (const s of list) spells.add(s);
const sorted = (set, most) => [...set].filter((v) => whole(v, most)).sort((a, b) => a - b);
const S = sorted(skills, 65535), F = sorted(factions, 65535), P = sorted(spells, 8388607);
const rows = (list) => { const out = []; for (let i = 0; i < list.length; i += 16) out.push(`    ${list.slice(i, i + 16).join(', ')},`); return out; };

const out = [
  '-- Azeroth Atlas: what quests ask after.',
  `-- Written by tools/make-quest-asks.mjs from QuestieDB ${db.version}: do not edit by hand.`,
  '--',
  '-- The professions and skills, the factions and the spells that some quest wants a character',
  '-- to have, to stand well with, or to know (a profession\'s specialisations among the spells),',
  '-- by the game\'s numbers for them. What they are for: Self.lua.',
  'local shared = AzerothAtlas',
  'if type(shared) ~= "table" then return end',
  '',
  'shared.QuestAsks = {',
  '  skills = {', ...rows(S), '  },',
  '  factions = {', ...rows(F), '  },',
  '  spells = {', ...rows(P), '  },',
  '}',
  '',
].join('\n');
const to = path.join(root, 'addon', 'AzerothAtlas', 'QuestAsks.lua');
fs.writeFileSync(to, out);
console.log(`${to}: ${S.length} skills, ${F.length} factions, ${P.length} spells (QuestieDB ${db.version}, ${db.quests.length} quests)`);
