// Every item the game knows: its name, what kind of thing it is, and what it does for whoever
// wears or wields it. → <dataDir>/items.json
//
// Read from the installed game: the Item and ItemSparse tables, and over them what the game was
// sent since its files were made (hotfix.js: four items in ten are known to this game from
// there alone). Used wherever an item is shown (the auction prices, to begin with).
//
//   { v, sig, cache, build, count,
//     items: { <id>: [name, quality, class, subclass, slot, item level, required level, sell price, stack, how it binds] },
//     more:  { <id>: { s: [[kind of stat, how much], …], ar: armor, dm: [min, max, delay in ms, damage per second], bp: a vendor's price for one } },
//     stats: { <kind>: the game's own word for it },  slots: { <slot>: … },  subs: { "<class>:<subclass>": … } }
//
// quality: 0 poor, 1 common, 2 uncommon, 3 rare, 4 epic, 5 legendary. class / subclass / slot are
// the game's own numbers (class 2 weapon, 4 armor, 7 trade goods...). Prices in copper. `more`
// holds only what an item has. How it binds: 0 not at all, 1 when picked up, 2 when equipped,
// 3 when used, 4 and 5 to a quest - such a thing is in a corpse only while a quest of yours wants
// it (server/drops.js goes by that; a list made before it was kept has nine figures to an item,
// and is made again the next time the map looks at the game).
//
// STATS, ARMOR AND DAMAGE ARE WORKED OUT, AS THE GAME WORKS THEM OUT. This game does not keep
// them on the item (the original game did). An item says what share of a budget each of its
// stats takes; the budget comes from the item's level, its quality and where it is worn:
//
//   stat    budget (RandPropPoints: by item level; a column for epic, rare or lesser quality; a place
//           in it for the slot) x the stat's share / 10000, rounded to the nearest whole number
//   armor   quality's factor (ItemArmorQuality) x the armor of that kind at that item level
//           (ItemArmorTotal: cloth, leather, mail, plate) x the slot's share of a suit
//           (ArmorLocation), rounded; a shield's is read straight off ItemArmorShield
//   damage  damage per second for that item level and quality (ItemDamage...: one table for
//           one-handed weapons, one for two-handed, for wands, for thrown; "caster" weapons have
//           their own; bows, guns and crossbows go by the two-handed table) x the weapon's speed
//           is the middle of the range; the range is as wide as the item's "variance" says. The
//           lowest is rounded down and the highest to the nearest.
//
// These are the formulas of the game's own client, as the people who rebuilt its server worked
// them out (TrinityCore); that this game uses them, which table each weapon goes by and how the
// range is rounded was found by the forever-ref project (github.com/alcaras/forever-ref), which
// checked its results against Wowhead's tooltips. The code here is this project's own, and its
// results were held against forever-ref's for every item both know.
//
// The words for the stats are the game's (its GlobalStrings table). Which word belongs to which
// kind is not in any table: for the kinds every version of the game has it is long known; for
// the ones only this game has (83 and up) it follows the order the game holds the words in, and
// that order was checked against items whose names or history tell what they give: Edgemaster's
// Handguards has kinds 93, 96 and 103 (axes, daggers, swords), Mark of the Champion +150 of kinds
// 127 and 128 (attack power against demons and undead), Anathema +69 of kind 88 (shadow damage),
// the Lucky Fishing Hat +5 of kind 117, the "Spell Penetration - Fire (TEST)" items kind 119.
//
// What an item does when used or equipped (its spells) is not taken yet.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../container.js';
import { loadTable, TABLE_FDID } from '../tables.js';
import { readCache, cacheStamp } from '../hotfix.js';

export const ITEMS_VERSION = 2;
export const ITEMS_FILE = 'items.json';
const TABLES = ['Item', 'ItemSparse', 'ItemSubClass', 'RandPropPoints', 'ItemArmorTotal', 'ItemArmorQuality', 'ItemArmorShield', 'ArmorLocation',
  'ItemDamageOneHand', 'ItemDamageTwoHand', 'ItemDamageOneHandCaster', 'ItemDamageTwoHandCaster', 'ItemDamageThrown', 'ItemDamageWand', 'ItemDamageAmmo', 'GlobalStrings'];

// Which place in the budget table a slot has (the game's own grouping: the big pieces, the small
// ones, the jewellery and what is held, one-handed weapons, ranged ones).
const BUDGET_PLACE = { 1: 0, 5: 0, 7: 0, 20: 0, 17: 0, 3: 1, 6: 1, 8: 1, 10: 1, 12: 1, 2: 2, 9: 2, 11: 2, 16: 2, 14: 2, 23: 2, 13: 3, 21: 3, 22: 3, 15: 4, 25: 4, 26: 4, 28: 4 };
const TWO_HANDED = new Set([1, 5, 6, 8, 10, 20]); // weapon subclasses: two-handed axe, mace, polearm, sword; staff; fishing pole
const SHOT = new Set([2, 3, 18]);                 // bow, gun, crossbow
const CASTER_WEAPON = 0x200;                      // (in the item's second word of flags)

// The game's name for each kind of stat (a GlobalStrings tag, without ITEM_MOD_ and _SHORT), and
// what to call it should this game's strings not have the tag.
const STAT_TAG = {
  0: ['MANA', 'Mana'], 1: ['HEALTH', 'Health'], 3: ['AGILITY', 'Agility'], 4: ['STRENGTH', 'Strength'], 5: ['INTELLECT', 'Intellect'], 6: ['SPIRIT', 'Spirit'], 7: ['STAMINA', 'Stamina'],
  12: ['DEFENSE_SKILL_RATING', 'Defense'], 13: ['DODGE_RATING', 'Dodge'], 14: ['PARRY_RATING', 'Parry'], 15: ['BLOCK_RATING', 'Block'],
  16: ['HIT_MELEE_RATING', 'Hit (Melee)'], 17: ['HIT_RANGED_RATING', 'Hit (Ranged)'], 18: ['HIT_SPELL_RATING', 'Hit (Spell)'],
  19: ['CRIT_MELEE_RATING', 'Critical Strike (Melee)'], 20: ['CRIT_RANGED_RATING', 'Critical Strike (Ranged)'], 21: ['CRIT_SPELL_RATING', 'Critical Strike (Spell)'],
  31: ['HIT_RATING', 'Hit'], 32: ['CRIT_RATING', 'Critical Strike'], 35: ['RESILIENCE_RATING', 'Resilience'], 36: ['HASTE_RATING', 'Haste'], 37: ['EXPERTISE_RATING', 'Expertise'],
  38: ['ATTACK_POWER', 'Attack Power'], 39: ['RANGED_ATTACK_POWER', 'Ranged Attack Power'], 41: ['SPELL_HEALING_DONE', 'Spell Healing'], 42: ['SPELL_DAMAGE_DONE', 'Spell Damage'],
  43: ['MANA_REGENERATION', 'Mana Regeneration'], 44: ['ARMOR_PENETRATION_RATING', 'Armor Piercing'], 45: ['SPELL_POWER', 'Spell Power'], 46: ['HEALTH_REGEN', 'Health Regeneration'],
  47: ['SPELL_PENETRATION', 'Spell Piercing'], 48: ['BLOCK_VALUE', 'Block Value'], 49: ['MASTERY_RATING', 'Mastery'], 50: ['EXTRA_ARMOR', 'Bonus Armor'],
};
// (resistances have words of their own, by school: holy 1, fire 2, nature 3, frost 4, shadow 5, arcane 6)
const RESISTANCE = { 51: [2, 'Fire Resistance'], 52: [4, 'Frost Resistance'], 53: [1, 'Holy Resistance'], 54: [5, 'Shadow Resistance'], 55: [3, 'Nature Resistance'], 56: [6, 'Arcane Resistance'] };
// The kinds only this game has, in the order it holds their words: 83 is the first.
const FOREVER_KINDS = ['PHYSICAL_DAMAGE_DONE', 'HOLY_DAMAGE_DONE', 'FIRE_DAMAGE_DONE', 'NATURE_DAMAGE_DONE', 'FROST_DAMAGE_DONE', 'SHADOW_DAMAGE_DONE', 'ARCANE_DAMAGE_DONE',
  'TWOHANDED_AXES', 'TWOHANDED_MACES', 'TWOHANDED_SWORDS', 'AXES', 'BOWS', 'CROSSBOWS', 'DAGGERS', 'DUAL_WIELD', 'FIST_WEAPONS', 'GUNS', 'MACES', 'POLEARMS', 'STAVES', 'SWORDS', 'THROWN', 'WANDS',
  'ALCHEMY', 'BLACKSMITHING', 'ENCHANTING', 'ENGINEERING', 'JEWELCRAFTING', 'LEATHERWORKING', 'HERBALISM', 'MINING', 'SKINNING', 'COOKING', 'FIRST_AID', 'FISHING', 'TAILORING',
  'FIRE_PENETRATION', 'NATURE_PENETRATION', 'FROST_PENETRATION', 'SHADOW_PENETRATION', 'ARCANE_PENETRATION', 'SPELL_RESISTANCE_ALL_SCHOOLS',
  'ATTACK_POWER_VS_HUMANOID', 'ATTACK_POWER_VS_ELEMENTAL', 'ATTACK_POWER_VS_DEMON', 'ATTACK_POWER_VS_UNDEAD', 'ATTACK_POWER_VS_DRAGONKIN', 'ATTACK_POWER_VS_GIANT', 'ATTACK_POWER_VS_BEAST', 'ATTACK_POWER_VS_MECHANICAL',
  'SPELL_DAMAGE_VS_HUMANOID', 'SPELL_DAMAGE_VS_ELEMENTAL', 'SPELL_DAMAGE_VS_DEMON', 'SPELL_DAMAGE_VS_UNDEAD', 'SPELL_DAMAGE_VS_DRAGONKIN', 'SPELL_DAMAGE_VS_GIANT', 'SPELL_DAMAGE_VS_BEAST', 'SPELL_DAMAGE_VS_MECHANICAL'];
FOREVER_KINDS.forEach((tag, i) => { STAT_TAG[83 + i] = [tag, tag.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())]; });
const SLOT_TAG = { 1: 'HEAD', 2: 'NECK', 3: 'SHOULDER', 4: 'BODY', 5: 'CHEST', 6: 'WAIST', 7: 'LEGS', 8: 'FEET', 9: 'WRIST', 10: 'HAND', 11: 'FINGER', 12: 'TRINKET', 13: 'WEAPON', 14: 'SHIELD', 15: 'RANGED', 16: 'CLOAK', 17: '2HWEAPON', 18: 'BAG', 19: 'TABARD', 20: 'ROBE', 21: 'WEAPONMAINHAND', 22: 'WEAPONOFFHAND', 23: 'HOLDABLE', 24: 'AMMO', 25: 'THROWN', 26: 'RANGEDRIGHT', 28: 'RELIC' };

/** What the list is made from, as one fingerprint: it is made again when any of it changes. */
export function itemsSig(casc, cfg) {
  // ('binds': the list has how each item binds from here on - made again for that, and good as it is until then)
  const parts = [ITEMS_VERSION, 'binds', ...TABLES.map((t) => { try { return casc.contentHash(TABLE_FDID[t]); } catch { return null; } }), cacheStamp(cfg)];
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/** The list as it is on disk, or null. */
export function readItems(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, ITEMS_FILE), 'utf8'));
    return j?.v === ITEMS_VERSION && j.items ? j : null;
  } catch { return null; }
}

/**
 * The sums: what an item's stats, armor and damage come to, from the game's tables.
 * @param T { RandPropPoints, ItemArmorTotal, … }: each table's rows
 */
export function itemMath(T) {
  const by = (rows, key = 'ID') => new Map((rows ?? []).map((r) => [r[key], r]));
  const budget = by(T.RandPropPoints);
  const armorTotal = by(T.ItemArmorTotal, 'ItemLevel'), armorQuality = by(T.ItemArmorQuality), armorPlace = by(T.ArmorLocation), shield = by(T.ItemArmorShield, 'ItemLevel');
  const dps = Object.fromEntries(['OneHand', 'TwoHand', 'OneHandCaster', 'TwoHandCaster', 'Thrown', 'Wand', 'Ammo'].map((k) => [k, by(T[`ItemDamage${k}`], 'ItemLevel')]));
  const nearest = (v) => Math.floor(v + 0.5);
  return {
    /** [[kind, how much], …] */
    stats(s) {
      const row = budget.get(s.ItemLevel), place = BUDGET_PLACE[s.InventoryType];
      if (!row || place === undefined) return [];
      const column = s.OverallQualityID >= 4 ? 'Epic' : s.OverallQualityID === 3 ? 'Superior' : 'Good';
      const points = (row[`${column}F`] ?? row[column])?.[place] ?? 0;
      const out = [];
      for (let i = 0; i < 10; i++) {
        const kind = s.StatModifier_bonusStat[i];
        if (kind < 0) continue;
        const value = nearest(points * s.StatPercentEditor[i] / 10000);
        if (value) out.push([kind, value]);
      }
      return out;
    },
    armor(s, k) {
      if (!k || k.ClassID !== 4 || s.OverallQualityID > 6) return 0;
      const q = s.OverallQualityID;
      if (k.SubclassID === 6) return nearest(shield.get(s.ItemLevel)?.Quality?.[q] ?? 0);
      const col = { 1: ['Cloth', 'Clothmodifier'], 2: ['Leather', 'Leathermodifier'], 3: ['Mail', 'Chainmodifier'], 4: ['Plate', 'Platemodifier'] }[k.SubclassID];
      if (!col) return 0;
      const total = armorTotal.get(s.ItemLevel), quality = armorQuality.get(s.ItemLevel), place = armorPlace.get(s.InventoryType === 20 ? 5 : s.InventoryType); // (a robe is a chest piece)
      if (!total || !quality || !place) return 0;
      return nearest(quality.Qualitymod[q] * total[col[0]] * place[col[1]]);
    },
    /** [lowest, highest, delay in ms, damage per second], or [0, 0, 0, dps] for what is shot (it only adds to the weapon's), or null */
    damage(s, k) {
      if (!k) return null;
      const q = s.OverallQualityID === 7 ? 3 : Math.min(s.OverallQualityID, 6);
      if (k.ClassID === 6) { const v = dps.Ammo.get(s.ItemLevel)?.Quality?.[q]; return v ? [0, 0, 0, Math.round(v * 10) / 10] : null; }
      if (k.ClassID !== 2 || !(s.ItemDelay > 0)) return null;
      const caster = (s.Flags?.[1] & CASTER_WEAPON) !== 0;
      const table = TWO_HANDED.has(k.SubclassID) || SHOT.has(k.SubclassID) ? (caster ? 'TwoHandCaster' : 'TwoHand') : k.SubclassID === 16 ? 'Thrown' : k.SubclassID === 19 ? 'Wand' : caster ? 'OneHandCaster' : 'OneHand';
      const perSecond = dps[table].get(s.ItemLevel)?.Quality?.[q];
      if (!perSecond) return null;
      const middle = perSecond * s.ItemDelay / 1000;
      const lo = Math.floor((1 - s.DmgVariance / 2) * middle), hi = nearest((1 + s.DmgVariance / 2) * middle);
      return [lo, hi, s.ItemDelay, Math.round((lo + hi) / 2 / (s.ItemDelay / 1000) * 100) / 100];
    },
  };
}

/** The game's words: for each kind of stat, each slot, each kind of weapon and armor. */
function words(T) {
  const text = new Map((T.GlobalStrings ?? []).map((r) => [r.BaseTag, r.TagText_lang]));
  const stats = {};
  for (const [kind, [tag, plain]] of Object.entries(STAT_TAG)) stats[kind] = text.get(`ITEM_MOD_${tag}_SHORT`) || plain;
  for (const [kind, [school, plain]] of Object.entries(RESISTANCE)) stats[kind] = text.get(`RESISTANCE${school}_NAME`) || plain;
  const slots = {};
  for (const [slot, tag] of Object.entries(SLOT_TAG)) { const w = text.get(`INVTYPE_${tag}`); if (w) slots[slot] = w; }
  const subs = {};
  for (const r of T.ItemSubClass ?? []) { const w = String(r.DisplayName_lang || r.VerboseName_lang || '').trim(); if (w) subs[`${r.ClassID}:${r.SubClassID}`] = w; }
  return { stats, slots, subs };
}

/**
 * Make the list if it is not there or what it is made from has changed.
 * @returns {{ sig, count, built: boolean }} or null when the game's tables cannot be read
 */
export async function ensureItems(casc, cfg, log = () => {}) {
  const sig = itemsSig(casc, cfg);
  const have = readItems(cfg.dataDir);
  if (have?.sig === sig && have.cache !== undefined) return { sig, count: have.count, built: false };
  const cache = readCache(cfg);
  if (!cache) log('items: the game has no hotfix cache yet (it writes one when you play): the items it holds will be missing');
  const T = {};
  for (const name of TABLES) T[name] = (await loadTable(casc, name, log, { cache }))?.rows ?? null;
  if (!T.ItemSparse || !T.Item) return null;
  const sent = (await loadTable(casc, 'ItemSparse', () => {}, { cache }))?.hotfixed ?? 0;
  const kind = new Map(T.Item.map((r) => [r.ID, r]));
  const math = itemMath(T);
  const items = {}, more = {};
  let count = 0, withStats = 0;
  for (const r of T.ItemSparse) {
    const name = String(r.Display_lang ?? '').trim();
    if (!name || !(r.ID > 0)) continue;
    const k = kind.get(r.ID);
    items[r.ID] = [name, r.OverallQualityID | 0, k ? k.ClassID | 0 : -1, k ? k.SubclassID | 0 : -1, r.InventoryType | 0, r.ItemLevel | 0, Math.max(0, r.RequiredLevel | 0), Math.max(0, Number(r.SellPrice) || 0), Math.max(1, r.Stackable | 0), Math.max(0, r.Bonding | 0)];
    count++;
    const m = {};
    const s = math.stats(r);
    if (s.length) { m.s = s; withStats++; }
    const ar = math.armor(r, k);
    if (ar) m.ar = ar;
    const dm = math.damage(r, k);
    if (dm) m.dm = dm;
    // (what a vendor asks for one, where one sells it: the table gives the price of a vendor's stack)
    const bp = Math.round((Number(r.BuyPrice) || 0) / Math.max(1, r.VendorStackCount | 0));
    if (bp > 0) m.bp = bp;
    if (Object.keys(m).length) more[r.ID] = m;
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  // (cache: the hotfix cache this was made from, so that whoever has no game archives open can tell it is still good)
  writeFileAtomic(path.join(cfg.dataDir, ITEMS_FILE), JSON.stringify({ v: ITEMS_VERSION, sig, cache: cacheStamp(cfg), build: casc.build.version, count, items, more, ...words(T) }));
  log(`items: ${count.toLocaleString()} listed (${sent.toLocaleString()} of them from what the game was sent after its files were made), ${withStats.toLocaleString()} with stats`);
  return { sig, count, built: true };
}
