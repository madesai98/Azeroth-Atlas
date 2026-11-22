// Writes the map's list of quests Questie keeps off its map in this game (viewer/js/questhidden.js),
// from Questie's own hand-kept lists - which are Questie's, not QuestieDB's, and so not in the
// quest data the map is built from. Run it when a newer Questie has changed them:
//   node tools/make-quest-hidden.mjs <the folder of the Questie addon> [the data file of a QuestieDB]
// (the folder as Questie's makers publish it: the one with Questie_Forever.toc in it. The data
// file: by default the one the map is built from; only quests in it are listed.)
//
// What is read, as text (nothing in it is run), and what each is to the map:
//
//   Database/Corrections/QuestieQuestBlacklist.lua
//       QuestieQuestBlacklist:Load()   [quest] = what to do with it in each kind of game: true is
//                                      "not in the game" (a duplicate, one never finished, one
//                                      taken out, a promotion), HIDE_ON_MAP "no ! for it on the
//                                      map" (a book you bring to a librarian, a sealed crate, the
//                                      fishing tournament's quests, CLUCK!). Each value is a small
//                                      Lua expression, worked out here for this game: WoW Forever
//                                      counts as the original game (Expansions.Current is Era),
//                                      Questie.IsForever is true, every other kind of game false.
//       AQWarEffortQuests, InvasionQuests
//                                      the Ahn'Qiraj war effort and the Scourge invasion, which
//                                      Questie takes to be over for good outside Season of Discovery
//   Database/Corrections/Holidays/quests/*.lua
//       tinsert(eventQuests, {"<festival>", quest, ...})
//                                      a festival's quests: Questie lists them as "not in the
//                                      game" too, and lets them out while the festival is on. The
//                                      map does not know when that is, and says so of them.
//
// Questie's own words for what it does with these: Database/QuestieDB.lua (IsDoable).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../extractor/config.js';
import { findQuestieDb, readQuestie } from '../extractor/questie.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [questieDir, tocArg] = process.argv.slice(2);
if (!questieDir) throw new Error('name the folder of the Questie addon (the one with Questie_Forever.toc in it)');
const corrections = path.join(questieDir, 'Database', 'Corrections');
const version = /^## Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(questieDir, 'Questie_Forever.toc'), 'utf8'))?.[1];
if (!version) throw new Error('no version in Questie_Forever.toc');

// ---- the expressions ----------------------------------------------------------------------------
const HIDE = 'HIDE_ON_MAP';
// What each name in them is in this game. A name not here stops the run: a newer Questie has a
// kind of game or a phase this does not know, and it has to be told what that is here.
const NAMES = {
  'Expansions.Era': 1, 'Expansions.Tbc': 2, 'Expansions.Wotlk': 3, 'Expansions.Cata': 4, 'Expansions.MoP': 5,
  'Expansions.Current': 1,
  'Questie.IsForever': true, 'Questie.IsSoD': false, 'Questie.IsTitanReforged': false, 'Questie.IsChinaRegion': false,
  'Questie.IsClassic': false, 'Questie.IsEra': false, 'Questie.IsSoM': false, 'Questie.IsTBC': false, 'Questie.IsWotlk': false,
  'Questie.IsCata': false, 'Questie.IsMoP': false, 'Questie.IsAnniversaryEra': false, 'Questie.IsAnniversaryHardcore': false, 'Questie.IsHardcore': false,
  'ContentPhases.activePhases.TBC': 4, 'ContentPhases.activePhases.SoD': 7, 'ContentPhases.activePhases.SoM': 5,
  'ContentPhases.activePhases.Anniversary': 6, 'ContentPhases.activePhases.MoP': 5,
  HIDE_ON_MAP: HIDE, true: true, false: false, nil: null,
};
function tokens(text) {
  const out = [], re = /\s*(?:(\d+(?:\.\d+)?)|(>=|<=|==|~=|<|>|\(|\))|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*))/y;
  let at = 0;
  while (at < text.length && !/^\s*$/.test(text.slice(at))) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new Error(`cannot read "${text}" at ${at}`);
    at = re.lastIndex;
    if (m[1]) out.push({ num: +m[1] });
    else if (m[2]) out.push({ op: m[2] });
    else if (['and', 'or', 'not'].includes(m[3])) out.push({ op: m[3] });
    else if (m[3] in NAMES) out.push({ val: NAMES[m[3]] });
    else throw new Error(`"${m[3]}" (in "${text}") is not known here: say what it is in this game, in NAMES`);
  }
  return out;
}
const truthy = (v) => v !== false && v !== null && v !== undefined;
/** A Lua expression of the kinds the lists use (or, and, not, comparisons, brackets), as Lua works it out. */
function evaluate(text) {
  const t = tokens(text);
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const primary = () => {
    const k = next();
    if (!k) throw new Error(`"${text}" ends too soon`);
    if (k.op === '(') { const v = or(); if (next()?.op !== ')') throw new Error(`a bracket not closed in "${text}"`); return v; }
    if (k.op === 'not') return !truthy(primary());
    if ('num' in k) return k.num;
    if ('val' in k) return k.val;
    throw new Error(`"${text}" is not understood`);
  };
  const compare = () => {
    let a = primary();
    while (['>=', '<=', '==', '~=', '<', '>'].includes(peek()?.op)) {
      const op = next().op, b = primary();
      a = op === '>=' ? a >= b : op === '<=' ? a <= b : op === '==' ? a === b : op === '~=' ? a !== b : op === '<' ? a < b : a > b;
    }
    return a;
  };
  const and = () => { let a = compare(); while (peek()?.op === 'and') { next(); const b = compare(); a = truthy(a) ? b : a; } return a; };
  const or = () => { let a = and(); while (peek()?.op === 'or') { next(); const b = and(); a = truthy(a) ? a : b; } return a; };
  const v = or();
  if (i !== t.length) throw new Error(`"${text}" has more in it than is understood`);
  return v;
}

// ---- the tables ---------------------------------------------------------------------------------
const uncommented = (s) => s.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
/** The text inside the table whose "{" is at `open`. */
function inside(s, open) {
  for (let k = open, depth = 0; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return s.slice(open + 1, k);
  }
  throw new Error('a table that does not end');
}
/** [quest, expression] for each line "[quest] = expression," of a table. */
function entries(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*\[(\d+)\]\s*=\s*(.+?)\s*,?\s*$/.exec(line);
    if (!m) throw new Error(`a line not understood: ${line.trim()}`);
    out.push([+m[1], m[2]]);
  }
  return out;
}
const lists = uncommented(fs.readFileSync(path.join(corrections, 'QuestieQuestBlacklist.lua'), 'utf8'));
const loadAt = lists.indexOf('function QuestieQuestBlacklist:Load()');
if (loadAt < 0) throw new Error('no QuestieQuestBlacklist:Load()');
const load = entries(inside(lists, lists.indexOf('{', lists.indexOf('local questsToBlacklist', loadAt))));
const named = (name) => {
  const at = lists.indexOf(`QuestieQuestBlacklist.${name} = {`);
  if (at < 0) throw new Error(`no QuestieQuestBlacklist.${name}`);
  return entries(inside(lists, lists.indexOf('{', at)));
};

const notInGame = new Set(), noMark = new Set(), over = new Set(), festival = new Set();
for (const [id, expr] of load) {
  const v = evaluate(expr);
  // (a later line for the same quest is the one that stands, as in Lua)
  notInGame.delete(id); noMark.delete(id);
  if (v === HIDE) noMark.add(id);
  else if (v === true) notInGame.add(id);
  else if (v !== false && v !== null) throw new Error(`[${id}] = ${expr} comes to ${v}`);
}
for (const name of ['AQWarEffortQuests', 'InvasionQuests']) for (const [id, expr] of named(name)) if (evaluate(expr) === true) over.add(id);
const holidays = path.join(corrections, 'Holidays', 'quests');
for (const file of fs.readdirSync(holidays).filter((f) => f.endsWith('.lua'))) {
  for (const m of uncommented(fs.readFileSync(path.join(holidays, file), 'utf8')).matchAll(/tinsert\(\s*eventQuests\s*,\s*\{\s*"[^"]*"\s*,\s*(\d+)/g)) festival.add(+m[1]);
}

// ---- only the quests the map has ----------------------------------------------------------------
const toc = tocArg ?? findQuestieDb(loadConfig());
if (!toc) throw new Error('no QuestieDB to read (run Update map first, or name its data file)');
const db = readQuestie(toc);
const have = new Set(db.quests.map((q) => q.id));
const kept = (set, ...not) => [...set].filter((id) => have.has(id) && !not.some((n) => n.has(id))).sort((a, b) => a - b);
// (a festival's quest is its festival's, whichever list it is on besides; a quest of a war effort that is over, over)
const FESTIVAL = kept(festival), OVER = kept(over, festival), NOT_IN_GAME = kept(notInGame, festival, over), NO_MARK = kept(noMark, festival, over, notInGame);

const rows = (list) => { const out = []; for (let i = 0; i < list.length; i += 16) out.push(`  ${list.slice(i, i + 16).join(', ')},`); return out; };
const out = [
  '// The quests Questie keeps off its map in this game, by its own hand-kept lists (they are',
  `// Questie's, not QuestieDB's). Written by tools/make-quest-hidden.mjs from Questie ${version}, for the`,
  `// quests of QuestieDB ${db.version}: do not edit by hand. What each list is: that file, and questopen.js.`,
  '',
  `export const HIDDEN_FROM = 'Questie ${version}';`,
  '',
  '/** Not in this game: a duplicate, one never finished or taken out, a promotion. */',
  'export const NOT_IN_GAME = [', ...rows(NOT_IN_GAME), '];',
  '',
  '/** In the game, with no "!" for it: a book brought to a librarian, a sealed crate, the fishing tournament\'s, CLUCK!. */',
  'export const NO_MARK = [', ...rows(NO_MARK), '];',
  '',
  '/** Of a world event that is over for good: the Ahn\'Qiraj war effort, the Scourge invasion. */',
  'export const EVENT_OVER = [', ...rows(OVER), '];',
  '',
  '/** Of a festival: open only while it is on. */',
  'export const FESTIVAL = [', ...rows(FESTIVAL), '];',
  '',
].join('\n');
const to = path.join(root, 'viewer', 'js', 'questhidden.js');
fs.writeFileSync(to, out);
console.log(`${to}: Questie ${version} against QuestieDB ${db.version} (${db.quests.length} quests): ${NOT_IN_GAME.length} not in the game, ${NO_MARK.length} with no "!", ${OVER.length} of an event that is over, ${FESTIVAL.length} of a festival`);
