// Everything the professions make, and out of what. → <dataDir>/recipes.json
//
// Read from the installed game's tables (and what it was sent since its files were made:
// hotfix.js), which hold every recipe whether or not you know it:
//
//   SkillLine          the professions
//   SkillLineAbility   which spell belongs to which profession, and at what skill it turns yellow
//                      and grey (it gives fewer skill points from the one, none from the other)
//   SpellReagents      what the spell uses up
//   SpellEffect        what it makes, and how many (its "create item" effect)
//   SpellName          what it is called
//   ItemEffect,        which item teaches it, where one does (a recipe, a pattern, plans...)
//   ItemXItemEffect
//
//   { v, sig, cache, build,
//     skills:  { <skill id>: name },
//     recipes: [[spell, name, skill, learnt at, yellow at, grey at, item made, how many, [[reagent, how many], …], item that teaches it], …],
//     sold:    [item, …] }
//
// (0 where there is none: a spell that makes no item, such as an enchantment; a recipe no item
// teaches. "learnt at" is the skill the table gives, which for most trainer-taught recipes is 1:
// the skill a trainer asks for is the trainer's to say, and is not in the game's files.)
//
// `sold` lists the reagents some vendor sells, as far as QuestieDB knows (its item data names
// the vendors of each item): thread, vials, flux and the like, which cost what the vendor asks
// however dear the auction house makes them. Where QuestieDB is not to be had (neither fetched
// from the Atlas database nor an addon in the game: extractor/questie.js) the list is empty, and
// such a reagent is priced by the auction house alone.
//
// That the game's tables hold all this, and where, was laid out by the forever-ref project
// (github.com/alcaras/forever-ref); the code here is this project's own, and its results were
// held against forever-ref's for every recipe both know.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../container.js';
import { loadTable, TABLE_FDID } from '../tables.js';
import { readCache, cacheStamp } from '../hotfix.js';
import { findQuestieDb, questieStamp, readQuestie } from '../questie.js';
import { readAtlas } from '../atlas.js';

export const RECIPES_VERSION = 3;

/**
 * What the Atlas database knows from vendors' and trainers' own windows (the addon's notes, from
 * every copy): the things some vendor sells for money, and the skill a trainer asks before
 * teaching a spell (the lowest any of them asks). With a mark of the two, so that the list is
 * made again when they change and not whenever the database does.
 */
function learned(cfg) {
  const sold = new Set(), asks = new Map();
  try {
    const atlas = cfg.atlas === false ? null : readAtlas(cfg.dataDir);
    for (const r of atlas?.npc.values() ?? []) {
      for (const s of Array.isArray(r.sells) ? r.sells : []) if (Array.isArray(s) && Number.isInteger(s[0]) && s[1] > 0) sold.add(s[0]);
      for (const t of Array.isArray(r.teaches) ? r.teaches : []) if (Array.isArray(t) && Number.isInteger(t[0]) && t[3] > 0) asks.set(t[0], Math.min(asks.get(t[0]) ?? Infinity, t[3]));
    }
  } catch { /* no database fetched: QuestieDB and the game's tables alone */ }
  const mark = crypto.createHash('sha1').update(JSON.stringify([[...sold].sort((a, b) => a - b), [...asks].sort((a, b) => a[0] - b[0])])).digest('hex').slice(0, 12);
  return { sold, asks, mark };
}
export const RECIPES_FILE = 'recipes.json';
const TABLES = ['SkillLine', 'SkillLineAbility', 'SpellReagents', 'SpellEffect', 'SpellName', 'ItemEffect', 'ItemXItemEffect'];
const PROFESSIONS = new Set([11, 9]); // the kinds of skill line: professions, and the ones everybody may have (cooking, first aid, fishing)
const CREATE_ITEM = 24;               // the effect of a spell that makes an item
const TEACHES = 6;                    // an item's effect that teaches its spell when used

function questieFile(cfg) { try { return findQuestieDb(cfg); } catch { return null; } }

/** What the list is made from, as one fingerprint. */
export function recipesSig(casc, cfg) {
  let questie = null;
  try { const f = questieFile(cfg); questie = f ? questieStamp(f) : null; } catch { /* not installed */ }
  const parts = [RECIPES_VERSION, ...TABLES.map((t) => { try { return casc.contentHash(TABLE_FDID[t]); } catch { return null; } }), cacheStamp(cfg), questie, learned(cfg).mark];
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/** The list as it is on disk, or null. */
export function readRecipes(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, RECIPES_FILE), 'utf8'));
    return j?.v === RECIPES_VERSION && Array.isArray(j.recipes) ? j : null;
  } catch { return null; }
}

/**
 * Make the list if it is not there or what it is made from has changed.
 * @returns {{ sig, count, built: boolean }} or null when the game's tables cannot be read
 */
export async function ensureRecipes(casc, cfg, log = () => {}) {
  const sig = recipesSig(casc, cfg);
  const have = readRecipes(cfg.dataDir);
  if (have?.sig === sig) return { sig, count: have.recipes.length, built: false };
  const cache = readCache(cfg);
  const T = {};
  for (const name of TABLES) T[name] = (await loadTable(casc, name, log, { cache }))?.rows ?? null;
  if (!T.SkillLine || !T.SkillLineAbility || !T.SpellReagents || !T.SpellEffect || !T.SpellName) return null;

  const skills = {};
  // (what the game's makers left lying about for their own trials is no profession: "Test Profession [DNT]")
  for (const r of T.SkillLine) if (PROFESSIONS.has(r.CategoryID)) { const n = String(r.DisplayName_lang ?? '').trim(); if (n && !n.includes('[DNT]') && !n.toLowerCase().startsWith('test ')) skills[r.ID] = n; }
  const names = new Map(T.SpellName.map((r) => [r.ID, String(r.Name_lang ?? '').trim()]));
  const reagents = new Map();
  for (const r of T.SpellReagents) {
    const list = [];
    for (let i = 0; i < r.Reagent.length; i++) if (r.Reagent[i] > 0 && r.ReagentCount[i] > 0) list.push([r.Reagent[i], r.ReagentCount[i]]);
    if (list.length) reagents.set(r.SpellID, list);
  }
  const made = new Map();
  for (const e of T.SpellEffect) {
    if (e.Effect !== CREATE_ITEM || !(e.EffectItemType > 0) || e.DifficultyID || made.has(e.SpellID)) continue;
    made.set(e.SpellID, [e.EffectItemType, Math.max(1, Math.round(Number(e.EffectBasePointsF) || 0))]);
  }
  // which item teaches a spell (the first, where several do)
  const taught = new Map();
  if (T.ItemEffect && T.ItemXItemEffect) {
    const teaching = new Map(T.ItemEffect.filter((e) => e.TriggerType === TEACHES && e.SpellID > 0).map((e) => [e.ID, e.SpellID]));
    for (const x of [...T.ItemXItemEffect].sort((a, b) => a.ItemID - b.ItemID)) {
      const spell = teaching.get(x.ItemEffectID);
      if (spell && !taught.has(spell)) taught.set(spell, x.ItemID);
    }
  }
  const known = learned(cfg);
  const recipes = [], seen = new Set();
  for (const a of [...T.SkillLineAbility].sort((x, y) => x.SkillLine - y.SkillLine || x.Spell - y.Spell)) {
    if (!skills[a.SkillLine] || seen.has(a.Spell)) continue;
    const uses = reagents.get(a.Spell), makes = made.get(a.Spell), name = names.get(a.Spell);
    if (!name || (!uses && !makes)) continue; // (not a recipe: the profession itself, finding herbs, a rank of the skill...)
    if (!uses) continue;                      // (made out of nothing: nothing to cost)
    seen.add(a.Spell);
    // (learnt at: the game's table has 1 for most of what a trainer teaches; a trainer's own window says what it asks)
    recipes.push([a.Spell, name, a.SkillLine, Math.max(0, a.MinSkillLineRank | 0, known.asks.get(a.Spell) ?? 0), Math.max(0, a.TrivialSkillLineRankLow | 0), Math.max(0, a.TrivialSkillLineRankHigh | 0), makes?.[0] ?? 0, makes?.[1] ?? 0, uses, taught.get(a.Spell) ?? 0]);
  }
  // the reagents a vendor sells, where QuestieDB is there to say
  const sold = [];
  const wantedAll = new Set(recipes.flatMap((r) => r[8].map((x) => x[0])));
  try {
    const file = questieFile(cfg);
    if (file) {
      const db = readQuestie(file);
      const wanted = new Set(recipes.flatMap((r) => r[8].map((x) => x[0])));
      for (const id of [...wanted].sort((a, b) => a - b)) if (db.item(id)?.vendors?.length) sold.push(id);
    } else log('recipes: QuestieDB is not on this computer yet (Update map fetches it): which reagents a vendor sells is not known');
  } catch (err) { log(`recipes: QuestieDB could not be read (${err.message}): which reagents a vendor sells is not known`); }
  // (and the ones a vendor's own window showed for sale, where the Atlas database has it)
  { const have = new Set(sold); for (const id of [...wantedAll].sort((a, b) => a - b)) if (!have.has(id) && known.sold.has(id)) sold.push(id); sold.sort((a, b) => a - b); }
  const used = new Set(recipes.map((r) => r[2]));
  for (const id of Object.keys(skills)) if (!used.has(Number(id))) delete skills[id];
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  writeFileAtomic(path.join(cfg.dataDir, RECIPES_FILE), JSON.stringify({ v: RECIPES_VERSION, sig, cache: cacheStamp(cfg), build: casc.build.version, skills, recipes, sold }));
  log(`recipes: ${recipes.length.toLocaleString()} of ${Object.keys(skills).length} professions; ${sold.length} of their reagents are sold by a vendor`);
  return { sig, count: recipes.length, built: true };
}
