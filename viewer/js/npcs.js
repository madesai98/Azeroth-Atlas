// The NPC layer: everyone and everything QuestieDB knows on this map, standing in the 3D world.
//
// The extractor gives every spawn point a height and a note of how it is known
// (maps/<id>/npcs.bin; see extractor/jobs/npcs.js), and the quests with who gives and takes
// them (quests.json). This file loads those, decides what each NPC is to YOU (your side and
// level decide who is hostile and which quests count), keeps the list of markers the filters
// leave, draws them, and finds the one under the cursor.
//
// It also keeps the heights honest: when the game says you have opened an NPC's window you
// are standing next to it, so its height is yours. That is noted on the spawn point (source
// "seen in game"), sent to the server to keep (user/npcs-seen.json, which outlives every map
// update), and laid over the extracted data from then on. Someone met far from the one place the
// databases have them is not there in this game: that place is moved to where you met them (#lone).
// A creature you fight says less - it is
// fought where it was chased to - but enough to settle which level of a cave it is on, where
// that was the map's own guess (see #fought).
import { GLOBALS_WGSL, targets } from './gpu.js';
import { unpackContainer, sectionView } from './formats.js';
import { project } from './math.js';

/** How a height is known, by the source number stored with each spawn point. */
export const HEIGHT_HOW = [
  'not known: nothing to stand on there in the map data',
  'a guess: the likeliest of several levels there',
  'the only place to stand there',
  'from the reference database',
  'from the reference database, and the ground agrees',
  'seen in game: you talked to them here',
  'seen in game: you fought them on this level',
  'seen in game by another player, who talked to them here',
  'fought on this level by another player',
];
export const SEEN = 5, FOUGHT = 6, SHARED = 7, FOUGHT_SHARED = 8;

/**
 * Is how this creature stands towards a side a guess? (side: 'a' or 'h'.) `u` marks one with a
 * side not recorded; `ks` says which sides are known all the same - 1 the Alliance's, 2 the
 * Horde's: the game's combat log, or Wowhead, said so by way of the Atlas database.
 */
export const unsure = (e, side) => !!e.u && !((e.ks ?? 0) & (side === 'h' ? 2 : 1));

// What an NPC does, as the game's own flag bits (QuestieDB passes them on): these are certain.
const FLAG = { VENDOR: 4, FLIGHT: 8, TRAINER: 16, SPIRIT: 32 | 64, INN: 128, BANK: 256, PETITION: 512, TABARD: 1024, BATTLE: 2048, AUCTION: 4096, STABLE: 8192, REPAIR: 16384 };
const JOBS = [[FLAG.FLIGHT, 'flight master'], [FLAG.INN, 'innkeeper'], [FLAG.VENDOR, 'vendor'], [FLAG.REPAIR, 'repairs'], [FLAG.TRAINER, 'trainer'], [FLAG.BANK, 'banker'], [FLAG.AUCTION, 'auctioneer'], [FLAG.STABLE, 'stable master'],
  [FLAG.SPIRIT, 'spirit healer'], [FLAG.BATTLE, 'battlemaster'], [FLAG.PETITION, 'guild master'], [FLAG.TABARD, 'tabard designer']];

// What a vendor sells and what a trainer teaches is not in a flag: it is in the title under
// their name ("Leather Armor Merchant", "Journeyman Tailor"). The titles are the game's own, and
// each kind below is told by words that mean one thing; a title that says nothing of the sort
// ("The Argent Dawn", none at all) leaves its owner under "other", where nothing is claimed.
// (The first that fits is taken: "Cooking Supplier" is supplies for a trade before it is food.)
const VENDOR_KINDS = [
  ['v_trade', /Trade (Supplies|Goods|Supplier)|Tradesman|General Trade|(Tailoring|Alchemy|Leatherworking|Blacksmithing|Engineering|Enchanting|Fishing|Cooking|Herbalism|Mining|Skinning|First Aid)\b.*(Suppl|Recipe|Pattern|Schematic|Formula)|\bRecipes\b|^Fisherman$|Herbalist|Potions/i],
  ['v_general', /General (Goods|Supplies)|Supply Officer|Quartermaster|Bag Vendor|Sundries|Provisioner/i],
  ['v_reagent', /Reagent|Poison|Shady Dealer|Arcane Goods/i],
  ['v_weapon', /Weapon|Bowyer|Gunsmith|Blade|Staff|\bAxe|Mace|Fletcher|Gun Merchant|Bow Merchant|\bWand|Sword|Dagger|Hammer|Arrow|Ammunition/i],
  ['v_armor', /Armor|Shield|Clothier|Robe|Cobbler|Tabard/i],
  ['v_food', /Food|Drink|Baker|Butcher|Bartender|Barmaid|Waitress|Chef|\bCook\b|Meat|Fruit|Fish Vendor|Wine|Bread|Mushroom|Cheese|Innkeeper|Brewer|Grocer|Ice Cream|Candy/i],
  ['v_mount', /Breeder|Mount|Handler|\bPets?\b|Kennel|Riding/i],
];
const CLASSES = ['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'];
const PROFESSIONS = [
  ['alchemy', 'Alchemy', /Alchem/i], ['blacksmithing', 'Blacksmithing', /Blacksmith|Armorsmith|Weaponsmith|Armor Crafter|Weapon Crafter/i], ['enchanting', 'Enchanting', /Enchant/i],
  ['engineering', 'Engineering', /Engineer/i], ['herbalism', 'Herbalism', /Herbal/i], ['leatherworking', 'Leatherworking', /Leather/i], ['mining', 'Mining', /Mining|\bMiner\b/i],
  ['skinning', 'Skinning', /Skinn/i], ['tailoring', 'Tailoring', /Tailor/i], ['cooking', 'Cooking', /Cook|Butcher|Chef/i], ['firstaid', 'First aid', /First Aid|Medic|Physician|Trauma Surgeon/i], ['fishing', 'Fishing', /Fish/i],
];
/** Which kind of vendor a title makes someone ('v_other' when it does not say). */
const vendorKind = (title) => VENDOR_KINDS.find(([, words]) => words.test(title))?.[0] ?? 'v_other';
/** Which kind of trainer a title makes someone ('t_other' when it does not say). */
function trainerKind(title) {
  if (/\b(Pet|Demon) Trainer\b/i.test(title)) return 't_pet';
  if (/Portal Trainer/i.test(title)) return 't_mage';
  for (const c of CLASSES) if (new RegExp(`\\b${c}\\b`, 'i').test(title)) return `t_${c.toLowerCase()}`;
  if (/Riding/i.test(title)) return 't_riding';
  if (/Weapon Master/i.test(title)) return 't_weapon';
  return `t_${PROFESSIONS.find(([, , words]) => words.test(title))?.[0] ?? 'other'}`;
}

/** The groups the kinds are listed in. */
export const GROUPS = [
  { key: 'quests', label: 'Quests' }, { key: 'services', label: 'Services' }, { key: 'vendors', label: 'Vendors' },
  { key: 'trainers', label: 'Class trainers' }, { key: 'crafts', label: 'Profession and other trainers' }, { key: 'creatures', label: 'Creatures' }, { key: 'objects', label: 'Objects' },
];
const kind = (key, label, group, icon, on, hint) => ({ key, label, group, icon, on, hint });
/** The kinds you can switch on and off, most important first (an NPC that is several shows as the first that is on). */
export const KINDS = [
  kind('quest', 'Quest givers', 'quests', 0, true, 'Starts a quest that is open to you'),
  kind('turnin', 'Quest turn-ins', 'quests', 1, true, 'Where a quest is handed in. With the live link: the quests in your log, grey until they are finished'),
  kind('target', 'My quest targets', 'quests', 13, true, 'What the unfinished quests in your log have you kill, use or collect (needs the live link)'),
  kind('flight', 'Flight masters', 'services', 2, true),
  kind('inn', 'Innkeepers', 'services', 3, true),
  kind('repair', 'Repairs', 'services', 5, true),
  kind('bank', 'Bankers', 'services', 7, true),
  kind('auction', 'Auctioneers', 'services', 7, true),
  kind('stable', 'Stable masters', 'services', 7, true),
  kind('spirit', 'Spirit healers', 'services', 7, false),
  kind('battle', 'Battlemasters', 'services', 7, false),
  kind('guild', 'Guild, tabards', 'services', 7, false, 'Guild masters and tabard designers'),
  kind('v_general', 'General goods', 'vendors', 4, true, 'General goods and supplies, bags, quartermasters'),
  kind('v_food', 'Food & drink', 'vendors', 4, true, 'Food and drink: bakers, butchers, bartenders, innkeepers'),
  kind('v_trade', 'Trade supplies', 'vendors', 4, true, 'Trade goods, and the supplies and recipes of a profession'),
  kind('v_reagent', 'Reagents, poisons', 'vendors', 4, true),
  kind('v_weapon', 'Weapons', 'vendors', 4, true, 'Weapons and ammunition'),
  kind('v_armor', 'Armour, clothes', 'vendors', 4, true),
  kind('v_mount', 'Mounts, pets', 'vendors', 4, true),
  kind('v_other', 'Other vendors', 'vendors', 4, true, 'Sells something, and the title does not say what'),
  ...CLASSES.map((c) => kind(`t_${c.toLowerCase()}`, c, 'trainers', 6, true, `${c} trainers`)),
  kind('t_pet', 'Pets, demons', 'trainers', 6, true, "Hunters' pet trainers and warlocks' demon trainers"),
  ...PROFESSIONS.map(([key, label]) => kind(`t_${key}`, label, 'crafts', 6, true, `${label} trainers`)),
  kind('t_riding', 'Riding', 'crafts', 6, true),
  kind('t_weapon', 'Weapon masters', 'crafts', 6, true),
  kind('t_other', 'Other trainers', 'crafts', 6, true, 'Teaches something, and the title does not say what'),
  kind('other', 'Friendly', 'creatures', 8, false, 'Friendly to you, with none of the jobs above'),
  kind('neutral', 'Neutral', 'creatures', 9, false, 'Leaves you alone unless attacked'),
  kind('hostile', 'Hostile', 'creatures', 10, false, 'Attacks your side on sight'),
  kind('unknown', 'Side not recorded', 'creatures', 11, false, 'New to this game: the database does not say whose side it is on'),
  kind('object', 'Quest objects', 'objects', 12, false, 'Things quests have you use, open or collect'),
];
// (more kinds than a number has bits for: each NPC's kinds are kept as one wide whole number)
const BIT = Object.fromEntries(KINDS.map((k, i) => [k.key, 1n << BigInt(i)]));
const CREATURE = BIT.other | BIT.neutral | BIT.hostile | BIT.unknown; // kinds the level, rank and type filters apply to
/** How a creature ranks, by the number the data has for it, and what kind of thing it is (from the reference database, where that has it). */
export const RANKS = [[0, 'Ordinary'], [1, 'Elite'], [4, 'Rare'], [2, 'Rare elite'], [3, 'Boss']];
export const TYPES = [[1, 'Beast'], [7, 'Humanoid'], [6, 'Undead'], [3, 'Demon'], [4, 'Elemental'], [2, 'Dragonkin'], [5, 'Giant'], [9, 'Mechanical'], [8, 'Critter'], [0, 'Not recorded']];
const TYPE_NAME = Object.fromEntries(TYPES);
const ICON_TARGET = 13;  // what a quest has you kill or collect
const ICON_WAITING = 14; // where a quest in your log is handed in, once it is finished
const GREY = 7;          // a quest this many levels under you is no longer worth doing
const RANK = ['', 'elite', 'rare elite', 'boss', 'rare'];
const SAME = 40;         // yards: the spawn point of an NPC this close to where you met it is the one you met
const FIGHT_REACH = 30;  // yards: a creature you fought has its spawn point within this far of where you stood
const FIGHT_LEVEL = 3;   // yards above or below your own height that are still your level, where you stand...
const FIGHT_SLOPE = 0.15; // ...and this much more for each yard further off (the floor of a cave slopes)
const FIGHT_CLEAR = 3;   // yards nearer your height the floor on your level has to be than any other at that spot
const KEY = 'wfmap.npcs';
const STRIDE = 6;        // floats per marker: position (from the layer's origin), sign, shown at any distance, size
const DOOR_SAME = 600;   // yards: QuestieDB's pin for a dungeon this near the spot the game itself names for its door is that door, less exactly
const SIZE = [1, 1.25, 1.3, 1.6, 1.1]; // how big a figure is, by rank: ordinary, elite, rare elite, boss, rare
export const TALL = 1.9;     // yards: a figure's height at size 1 (see npcfigures.js)
export const SIGN_FAR = 2.4; // yards above the feet a sign floats on its own...
const signNear = (size) => TALL * size + 0.45; // ...and over the head of a figure

// The signs of quests are big marks standing in the world, solid and outlined (questmarks.js
// draws them; "Big 3D quest marks" in the NPC panel turns them back into the flat signs). By sign:
// which model, how big against the full size, how wide against its height, and its colour.
export const MARKS = {
  0: { model: 'bang', scale: 1, wide: 0.32, color: '#ffd02a' },      // gives a quest open to you
  1: { model: 'hook', scale: 1, wide: 0.6, color: '#ffd02a' },       // takes a quest of yours, finished
  14: { model: 'hook', scale: 0.82, wide: 0.6, color: '#b6bec8' },   // takes a quest of yours not finished yet
  13: { model: 'swords', scale: 0.85, wide: 1.05, color: '#ff4b3a' }, // what a quest of yours has you kill, use or collect
  12: { model: 'gem', scale: 0.58, wide: 0.64, color: '#5aa8ff' },    // a quest object (switched off unless asked for: there are many)
};
// How many CSS pixels tall a mark is: MARK_K over its distance, between these two (the flat signs: 1700, 15 and 30).
export const MARK_K = 4800, MARK_MIN = 46, MARK_MAX = 86;
/**
 * A mark's height in CSS pixels, at a distance (yards) from the camera. fit: smaller in a small
 * picture (the map as a minimap over the game: questmarks.js, markFit).
 */
export const markPx = (icon, dist, fit = 1) => Math.min(MARK_MAX, Math.max(MARK_MIN, MARK_K / Math.max(dist, 0.5))) * fit * (MARKS[icon]?.scale ?? 1);

/**
 * What is searched for: the words in the box, in small letters - or nothing, for fewer than
 * SEARCH_MIN letters. One letter is no search: nearly every name has an "s" in it, and a key
 * meant for the camera or for the game lands in the box easily enough.
 */
export const SEARCH_MIN = 2;
export const searchText = (typed) => { const t = String(typed ?? '').trim().toLowerCase(); return t.length >= SEARCH_MIN ? t : ''; };

export class NpcLayer {
  constructor(app) {
    this.app = app;
    // (ranks, types: which creatures, by rank and by kind of thing - every one unless switched off)
    // (marks: the signs of quests as big marks in the world - questmarks.js)
    this.settings = { enabled: false, kinds: Object.fromEntries(KINDS.map((k) => [k.key, k.on])), search: '', min: null, max: null, myQuests: true, ranks: {}, types: {}, unsure: false, names: true, marks: true, range: 1200 };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved) {
        const kinds = { ...this.settings.kinds, ...(saved.kinds ?? {}) };
        // (kept from before the kinds were divided up: a switch that was off is off for all it has become)
        const was = saved.kinds ?? {};
        for (const k of KINDS) {
          if (was[k.key] !== undefined) continue;
          if (k.group === 'vendors' && was.vendor === false) kinds[k.key] = false;
          if ((k.group === 'trainers' || k.group === 'crafts') && was.trainer === false) kinds[k.key] = false;
          if ((k.key === 'auction' || k.key === 'stable') && was.bank === false) kinds[k.key] = false;
        }
        Object.assign(this.settings, saved, { kinds, ranks: saved.ranks ?? (saved.rare ? { 0: false } : {}), types: saved.types ?? {}, search: '' });
        delete this.settings.rare;
      }
    } catch { /* defaults */ }
    this.data = null;      // this map's NPCs
    this.quests = null;    // quests.json, once it has been fetched
    this.seen = null;      // every sighting (all maps), once fetched
    this.focus = null;     // a quest id: show only who and what that quest involves
    this.mine = null;      // your quests as the game reports them: { log: Map<id, state>, done: Set<id> | null } (null = not known)
    this.rev = 0;          // changes whenever the markers do
    this.count = 0;        // markers the filters leave
    this.inst = new Float32Array(0);
    this.stride = STRIDE;
    this.figureDist = 0;   // markers closer to the camera than this are figures standing in the world (0 = none)
    this.shown = new Uint32Array(0);
    this.origin = [0, 0, 0];
    this.meeting = null;   // the NPC you have just opened a window of, until its height is settled
    this.rejected = 0;     // sightings on file that were not believed (see #overlay)
    this.onChange = () => {};
    this.onNote = () => {};
    this.context = '';     // faction + level the kinds were worked out for
    this.markView = null;  // the quest marks as last drawn (questmarks.js): { perPx: yards a CSS pixel spans a yard away, up: the screen's up, fit: their size against the full } - or null: none
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* not remembered */ } }

  /** Change settings; the markers are worked out again. */
  set(patch) {
    Object.assign(this.settings, patch);
    this.save();
    this.#classify();
    this.rebuild();
  }

  setFocus(questId) { this.focus = questId; this.rebuild(); }

  /**
   * What the game says about your quests: { log: [{ id, state (0 in progress, 1 ready to hand in,
   * 2 failed) }] | null, done: [ids] | null }. From then on a quest giver is someone with a quest
   * you can actually take, and a turn-in is where one of YOUR quests goes.
   */
  setQuestState(d) {
    this.mine = d && Array.isArray(d.log) ? { log: new Map(d.log.map((q) => [q.id, q.state])), done: Array.isArray(d.done) ? new Set(d.done) : null } : null;
    this.#classify();
    this.rebuild();
  }

  async #shared() {
    if (!this.quests) {
      try { const res = await fetch(`/data/quests.json?v=${this.app.manifest.revision}`); if (res.ok) this.quests = await res.json(); } catch { /* no quest data */ }
    }
    if (!this.seen) {
      try { const res = await fetch('/api/npcs/seen'); this.seen = res.ok ? (await res.json()).seen ?? [] : []; } catch { this.seen = []; }
    }
  }

  async load(map) {
    this.data = null;
    this.meeting = null;
    this.focus = null;
    this.rebuild();
    // (another map may be asked for before this one has come: the last one asked for is the one kept)
    const turn = (this.turn = (this.turn ?? 0) + 1);
    // (a map with nobody on it still has the quests: the tracked one's business may be on another map)
    if (!map.npcs) { await this.#shared(); return; }
    const [res] = await Promise.all([fetch(`/data/maps/${map.id}/npcs.bin?v=${map.rev}`), this.#shared()]);
    if (!res.ok || turn !== this.turn) return;
    const buf = await res.arrayBuffer();
    if (turn !== this.turn) return;
    const c = unpackContainer(buf, 'WFP1');
    const ms = c.sections.get(1);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, ms.offset, ms.size)));
    const xyz = sectionView(c, 2, Float32Array), owner = sectionView(c, 3, Uint32Array), source = sectionView(c, 4, Uint8Array);
    const mine = (this.seen ?? []).filter((r) => r.map === map.id);
    const n = owner.length, room = n + mine.length + 64; // (room for the ones you meet that the database has nowhere near)
    const d = {
      map: map.id, source: meta.source, reference: meta.reference, entries: meta.entries, n, unplaced: meta.unplaced ?? [], bosses: meta.bosses ?? [],
      x: new Float32Array(room), y: new Float32Array(room), z: new Float32Array(room), owner: new Uint32Array(room), src: new Uint8Array(room),
      mask: new BigUint64Array(meta.entries.length + mine.length + 64), spawnCount: null,
      typed: meta.entries.some((e) => e.ct), // (does this map's data say what kind of thing a creature is? One built before that was added does not)
      index: new Map(meta.entries.map((e, i) => [(e.k ? 'o' : 'n') + e.id, i])),
      // (the first `base` spots are the databases', the rest what other players' sightings added; `met`:
      // those of the databases' a sighting met and left as they were. null: a map built before the file said - see #lone)
      base: Number.isInteger(meta.base) && meta.base <= n ? meta.base : null, met: new Set(meta.met ?? []),
    };
    for (let i = 0; i < n; i++) { d.x[i] = xyz[i * 3]; d.y[i] = xyz[i * 3 + 1]; d.z[i] = xyz[i * 3 + 2]; }
    d.owner.set(owner); d.src.set(source);
    this.data = d;
    this.rejected = 0;
    for (const r of mine) this.#overlay(r, true);
    this.context = '';
    this.#classify();
    this.rebuild();
  }

  /**
   * Lay one sighting over the data. Returns the spawn point it landed on, or -1.
   * @param vet  one read back from the file: not believed if it contradicts something surer.
   *             A sighting's height is your own at the time, and if the map had lost that (as it
   *             once did in Ironforge, taking you for standing on the mountain over the city), the
   *             sighting carries the mistake: so one that moves someone the reference database
   *             places by more than a storey or two, or lifts anyone sixty yards, is left out.
   */
  #overlay(r, vet = false) {
    const d = this.data;
    let e = d.index.get((r.object ? 'o' : 'n') + r.id);
    if (e === undefined) {
      // someone the database has nowhere on this map: known from now on (not for a fight: see #fought)
      if (r.fight || d.entries.length >= d.mask.length) return -1;
      const known = this.quests?.[r.object ? 'objects' : 'npcs']?.[r.id];
      e = d.entries.length;
      d.entries.push(r.object ? { id: r.id, k: 1, n: known?.[0] ?? `Object ${r.id}` } : { id: r.id, n: known?.[0] ?? `NPC ${r.id}`, a: 2, h: 2, u: 1 });
      d.index.set((r.object ? 'o' : 'n') + r.id, e);
    }
    let i = this.#nearest(e, r.x, r.y, SAME);
    if (vet && i >= 0 && Number.isFinite(d.z[i]) && ((d.src[i] >= 3 && d.src[i] <= 4 && Math.abs(r.z - d.z[i]) > 6) || r.z - d.z[i] > 60)) { this.rejected++; return -1; }
    // (a fight adds nobody, and moves nobody the reference database places, or you or another player have talked to;
    // a level another player's fight settled is no surer than one your own does)
    if (r.fight && (i < 0 || (d.src[i] >= 3 && d.src[i] !== FOUGHT && d.src[i] !== FOUGHT_SHARED))) return -1;
    if (i < 0) {
      // (the one place the databases have them, where nobody has met them: not where they stand in this game - see #lone)
      const one = this.#lone(e);
      if (one >= 0) i = one;
      else {
        if (d.n >= d.owner.length) return -1;
        i = d.n++;
        d.owner[i] = e;
      }
      d.x[i] = r.x; d.y[i] = r.y;
    }
    d.z[i] = r.z; d.src[i] = r.fight ? FOUGHT : SEEN;
    return i;
  }

  /**
   * The one place the databases put someone on this map, where they put them in that one place
   * only and nobody has been met there: no sighting of yours or another player's, no fight. -1
   * where there is none such: several places (a guard, a wanderer), one somebody was met at, or
   * a map built before its file said which spots are the databases' (meta.base).
   * Someone you meet SAME yards and more from it is not there in this game, which has moved
   * some and built places anew (Archmage Ansirem Runeweaver stood at the gate of ruined Dalaran:
   * a wall of the city built over it stands there now, and he is inside). Your sighting takes
   * that place over (#overlay) rather than being one more, which the way to them would lead to
   * whenever it was the nearer of the two. The map build does the same with every copy's
   * sightings (extractor/jobs/npcs.js, resolveHeights).
   */
  #lone(e) {
    const d = this.data;
    if (!Number.isInteger(d.base)) return -1;
    let one = -1;
    for (let i = 0; i < d.base; i++) {
      if (d.owner[i] !== e) continue;
      if (one >= 0) return -1;
      one = i;
    }
    // (seen there, by you or another player, or fought there: 5 to 8 - or met by another player and left as it was)
    if (one < 0 || d.src[one] > 4 || d.met.has(one)) return -1;
    // (nor met there by you: a sighting of yours the reference height turned away still says they stood there)
    const entry = d.entries[e];
    for (const r of this.seen ?? []) {
      if (r.map === d.map && r.id === entry.id && !!r.object === !!entry.k && Math.hypot(r.x - d.x[one], r.y - d.y[one]) < SAME) return -1;
    }
    return one;
  }

  /** The spawn point of an entry nearest a spot, within `reach` yards (or -1). */
  #nearest(e, x, y, reach) {
    const d = this.data;
    let best = -1, bestD = reach;
    for (let i = 0; i < d.n; i++) {
      if (d.owner[i] !== e) continue;
      const dist = Math.hypot(d.x[i] - x, d.y[i] - y);
      if (dist < bestD) { bestD = dist; best = i; }
    }
    return best;
  }

  /**
   * Why a quest is not one you can take now ('' if you can): the other side's, one you have or
   * have done, one that needs another first, or the wrong level for you.
   */
  closed(id) {
    const Q = this.quests?.quests, q = Q?.[id];
    if (!q) return '';
    const s = this.app.danger.settings, me = this.mine;
    if (!(q.side & (s.faction === 'horde' ? 2 : 1))) return 'other side';
    if (me) {
      const state = me.log.get(id);
      if (state !== undefined) return state === 1 ? 'ready to hand in' : state === 2 ? 'failed' : 'in your log';
      if (me.done) {
        if (me.done.has(id) && !q.rep) return 'done';
        if (q.ex?.some((x) => me.done.has(x) || me.log.has(x))) return 'you took another instead';
      }
    }
    if (q.m > s.level) return `from level ${q.m}`;
    if (q.x && s.level > q.x) return 'outgrown';
    if (me?.done) {
      // one of these first / all of these first
      if (q.pre && !q.pre.some((p) => me.done.has(p))) return `after ${Q[q.pre[0]]?.n ?? 'another quest'}`;
      const missing = q.pa?.find((p) => !me.done.has(p));
      if (missing !== undefined) return `after ${Q[missing]?.n ?? 'another quest'}`;
    }
    if (q.l > 0 && q.l < s.level - GREY) return 'outgrown';
    return '';
  }

  /** Is this quest one for you to pick up? With "open to me now" off, anything of your side you have not done or taken. */
  wanted(id) {
    if (!this.quests?.quests?.[id]) return !this.quests; // (no quest data at all: every quest giver counts)
    const why = this.closed(id);
    if (why === '') return true;
    return !this.settings.myQuests && (why.startsWith('from level') || why.startsWith('after') || why === 'outgrown');
  }

  /** Is this quest one to hand in? 0 no; 1 it is in your log but not finished; 2 yes. */
  #handIn(id) {
    const me = this.mine;
    if (me) { const state = me.log.get(id); return state === undefined ? 0 : state === 1 ? 2 : 1; }
    return this.wanted(id) ? 2 : 0; // (not known what is in your log: every quest of your side and level)
  }

  /**
   * Which of the things a quest asks for are still to do, going by what the game says of it:
   * { oc: [for each creature to kill], ok (the kills that count as another's), oo: [each object],
   *   oi: [each item], tr (the place to go to) } - true: still to do. null: the game does not say.
   *
   * The game lists what a quest asks for in its own order, and says of each what kind of thing
   * it is and whether it is done - but not which creature or item it is. The quest data has
   * them kind by kind, in the game's order within a kind (QuestieDB matches the two up that
   * way). So: a kind that is all done, or not begun, is plain. A kind that is partly done is
   * matched up one for one where the game lists as many of it as the data has; where it does
   * not, nothing of that kind is taken for done - better a way to something finished than no
   * way to something that is not.
   * @param progress  { n, done (a bit for each thing, the first the lowest), kinds: [1 a creature, 2 an item, 3 an object, 0 anything else] }
   */
  #left(q, progress) {
    if (!progress || !Array.isArray(progress.kinds)) return null;
    const said = [[], [], [], []]; // for each kind: is each thing of it, in the game's order, still to do?
    progress.kinds.forEach((kind, k) => said[kind]?.push(!((progress.done >> k) & 1)));
    const match = (kind, count, inOrder = true) => {
      const g = said[kind];
      if (!g.length || g.every((v) => v)) return new Array(count).fill(true);
      if (g.every((v) => !v)) return new Array(count).fill(false);
      return inOrder && g.length === count ? g : new Array(count).fill(true);
    };
    // (creatures: each one to kill, and the kills that count as another's - together one more
    // thing, which the game may list before or after the others: with both, a part done is not matched up)
    const oc = q.oc ?? [], credit = q.ok?.length ? 1 : 0;
    const kills = match(1, oc.length + credit, !(credit && oc.length));
    // (a place to go to is among "anything else"; where the game lists things and none of that kind, it does not ask for it)
    const place = said[0].length ? said[0].some((v) => v) : progress.kinds.length === 0;
    return { oc: kills.slice(0, oc.length), ok: credit ? kills[oc.length] : false, oo: match(3, (q.oo ?? []).length), oi: match(2, (q.oi ?? []).length), tr: place };
  }

  /**
   * What a quest has you kill, use or collect: the entries of this map, as a Set.
   * @param left  which of them are still to do (see #left); null: all of them
   */
  #targets(questId, into = new Set(), left = null) {
    const d = this.data, Q = this.quests, q = Q?.quests?.[questId];
    if (!q) return into;
    const add = (key) => { const e = d.index.get(key); if (e !== undefined) into.add(e); };
    (q.oc ?? []).forEach((id, k) => { if (!left || left.oc[k]) add('n' + id); });
    if (!left || left.ok) for (const id of q.ok ?? []) add('n' + id);
    (q.oo ?? []).forEach((id, k) => { if (!left || left.oo[k]) add('o' + id); });
    (q.oi ?? []).forEach((item, k) => {
      if (left && !left.oi[k]) return;
      const it = Q.items?.[item];
      for (const id of it?.d ?? []) add('n' + id);
      for (const id of it?.o ?? []) add('o' + id);
    });
    return into;
  }

  /**
   * Where a quest of yours is to be got on with, on this map: the nearest to `from` of what it
   * still has you kill, use, collect or go to - or, once it is ready to hand in (or asks for
   * nothing that is on this map), of who takes it.
   * @param progress  how far the quest has got, as the game says of the one you track (the
   *                  server's strip.js: heads().tracked): what is done is not led to any more.
   *                  null: not said - then every thing it asks for counts, and whether it is
   *                  ready to hand in is taken from your quest log.
   * Where everything it still asks for is inside a dungeon, it is the dungeon's door (the nearest
   * on this map, else one on another): leading to who takes a quest you have not done yet leads
   * nowhere you want to go.
   * Where none of it is on this map at all (a Westfall quest while you are on Zephras Isle, after
   * a hearthstone), it is on another map: see #elsewhere. The route there is a journey.
   * @returns { x, y, z (null where the height is not known), name, done (it is to be handed in),
   *            map (only where it is not on this map: a dungeon's door, or the quest's business,
   *            on another) } or null
   */
  questGoal(id, from, progress = null) {
    const d = this.data, q = this.quests?.quests?.[id];
    if (!q || !from) return null;
    const done = progress ? progress.state === 1 : this.mine?.log.get(id) === 1;
    const left = done ? null : this.#left(q, progress);
    // (no NPC data for this map at all: there is nothing of it here to look for)
    if (!d) return (done ? null : this.#door(q, from)) ?? this.#elsewhere(q, done, left) ?? (done ? null : this.#elsewhere(q, true, null));
    const takers = () => {
      const out = new Set();
      for (const n of q.e ?? []) { const e = d.index.get('n' + n); if (e !== undefined) out.add(e); }
      for (const n of q.eo ?? []) { const e = d.index.get('o' + n); if (e !== undefined) out.add(e); }
      return out;
    };
    let who = done ? takers() : this.#targets(id, new Set(), left), handIn = done;
    // (a place it has you go to and look at: no one stands there, it is a spot of its own)
    const spots = !done && (!left || left.tr) ? (q.tr?.at ?? []).filter((s) => s[0] === d.map) : [];
    if (!who.size && !spots.length && !done) {
      const door = this.#door(q, from);
      if (door) return door;
      // (what it still asks for is on another map: that is where to go, not to who takes it)
      const far = this.#elsewhere(q, false, left);
      if (far) return far;
      who = takers(); handIn = true;
    }
    let best = -1, bestD = Infinity, spot = null;
    for (let i = 0; i < d.n; i++) {
      if (!who.has(d.owner[i])) continue;
      const dist = Math.hypot(d.x[i] - from[0], d.y[i] - from[1]);
      if (dist < bestD) { bestD = dist; best = i; }
    }
    if (!handIn) for (const s of spots) {
      const dist = Math.hypot(s[1] - from[0], s[2] - from[1]);
      if (dist < bestD) { bestD = dist; spot = s; }
    }
    if (spot) return { x: spot[1], y: spot[2], z: null, name: q.tr.t || 'the place it names', done: false };
    // (nobody it involves stands on this map: who takes it, or what it asks for, is on another)
    if (best < 0) return this.#elsewhere(q, handIn, left);
    return { x: d.x[best], y: d.y[best], z: Number.isFinite(d.z[best]) ? d.z[best] : null, name: d.entries[d.owner[best]].n, done: handIn };
  }

  /**
   * The quest's business where the NPC data of the map in hand has none of it: quests.json keeps
   * one spot for every NPC and object a quest involves (QuestieDB's first: map, x, y), on any map.
   * A spot on another map is where the quest's route goes, as a journey (and once you are on that
   * map, its own NPC data takes over and finds the nearest). With several (something to kill on
   * both continents), the ones in the zone the quest is filed under come first, then the map most
   * of them are on, and of those the one in the middle of the rest.
   * @param handIn  who takes it (true), or what it still asks for (false; `left`: which of it is left)
   * @returns { x, y, z: null, name, done, map (where not the map in hand) } or null
   */
  #elsewhere(q, handIn, left) {
    const Q = this.quests, here = this.data?.map ?? this.app.scene?.map.id;
    const found = [];
    const add = (r) => { if (Array.isArray(r) && r.length >= 4 && Number.isFinite(r[2]) && Number.isFinite(r[3])) found.push({ name: r[0], map: r[1], x: r[2], y: r[3] }); };
    const npc = (n) => add(Q.npcs?.[n]), obj = (n) => add(Q.objects?.[n]);
    if (handIn) {
      (q.e ?? []).forEach(npc);
      (q.eo ?? []).forEach(obj);
    } else {
      (q.oc ?? []).forEach((n, k) => { if (!left || left.oc[k]) npc(n); });
      if (!left || left.ok) (q.ok ?? []).forEach(npc);
      (q.oo ?? []).forEach((n, k) => { if (!left || left.oo[k]) obj(n); });
      (q.oi ?? []).forEach((item, k) => {
        if (left && !left.oi[k]) return;
        const it = Q.items?.[item];
        (it?.d ?? []).forEach(npc);
        (it?.o ?? []).forEach(obj);
      });
      if (!left || left.tr) for (const s of q.tr?.at ?? []) found.push({ name: q.tr.t || 'the place it names', map: s[0], x: s[1], y: s[2] });
    }
    // (nothing it involves is placed anywhere: where the game's own map puts it, if a player's addon has noted that)
    if (!found.length) for (const s of q.gp?.[handIn ? 'e' : 'o'] ?? []) found.push({ name: handIn ? 'where the game\'s map has it handed in' : 'where the game\'s map puts it', map: s[0], x: s[1], y: s[2] });
    if (!found.length) return null;
    // the zone the quest is filed under (a positive number is an area: its zone's rectangle)
    const zone = q.z > 0 ? this.app.world?.zones?.find((z) => z.type === 3 && z.area === q.z) : null;
    const inZone = zone ? found.filter((c) => c.map === zone.map && c.x >= zone.region[0] && c.x <= zone.region[2] && c.y >= zone.region[1] && c.y <= zone.region[3]) : [];
    let pool = inZone.length ? inZone : found;
    const count = new Map();
    for (const c of pool) count.set(c.map, (count.get(c.map) ?? 0) + 1);
    const map = [...count].sort((a, b) => b[1] - a[1])[0][0];
    pool = pool.filter((c) => c.map === map);
    const spread = (c) => pool.reduce((s, o) => s + Math.hypot(o.x - c.x, o.y - c.y), 0);
    const c = pool.reduce((b, o) => (spread(o) < spread(b) ? o : b));
    return { x: c.x, y: c.y, z: null, name: c.name, done: handIn, ...(c.map === here ? {} : { map: c.map }) };
  }

  /**
   * The way in to the dungeon a quest is done in, where the map knows of one (world.json:
   * dungeons - a quest is filed under its dungeon's area): the nearest door on this map, else
   * one on another. { x, y, z: null, name, done: false, map (where not this one) } or null.
   *
   * A door is where QuestieDB pins the dungeon on its zone's map - or, better, the spot the
   * game's own tables name for it (where a ghost goes back in: the door itself). QuestieDB's
   * pin for Gnomeregan is by the top of the lift, three hundred yards and a lift's ride short
   * of the door; from the door, the way to "the way in" led back up and out. So the game's
   * spot stands in for every pin near it.
   */
  #door(q, from) {
    const list = this.app.world?.dungeons;
    if (!list?.length || !(q.z > 0)) return null;
    const dungeon = list.find((x) => x.area === q.z || x.also?.includes(q.z));
    if (!dungeon) return null;
    const here = this.data?.map ?? this.app.scene?.map.id;
    const own = dungeon.ghost ?? null;
    const doors = own ? [own, ...dungeon.doors.filter((d) => !(d.map === own.map && Math.hypot(d.pos[0] - own.pos[0], d.pos[1] - own.pos[1]) <= DOOR_SAME))] : dungeon.doors;
    let best = null, bestD = Infinity;
    for (const door of doors) {
      // (one on the map you are on comes before any that is not)
      const dist = door.map === here ? Math.hypot(door.pos[0] - from[0], door.pos[1] - from[1]) : 1e9;
      if (dist < bestD) { bestD = dist; best = door; }
    }
    if (!best) return null;
    return { x: best.pos[0], y: best.pos[1], z: null, name: `${dungeon.name}, the way in`, done: false, ...(best.map === here ? {} : { map: best.map }) };
  }

  /**
   * Where a ghost goes back in to the dungeon its body is in: the spot the game's own tables
   * name for that dungeon, else its door as QuestieDB has it (the nearest on the map in hand,
   * else one on another map). { map, x, y, name } - or null: the map knows no way in to it.
   * @param map   the dungeon's own map (as the game numbers it)
   * @param from  [x, y] where you are, on the map in hand
   */
  bodyDoor(map, from) {
    const dungeon = (this.app.world?.dungeons ?? []).find((x) => x.map === map);
    if (!dungeon) return null;
    const name = `Your body, in ${dungeon.name}: the way in`;
    if (dungeon.ghost) return { map: dungeon.ghost.map, x: dungeon.ghost.pos[0], y: dungeon.ghost.pos[1], name };
    const here = this.data?.map ?? this.app.scene?.map.id;
    let best = null, bestD = Infinity;
    for (const door of dungeon.doors) {
      const dist = door.map === here && from ? Math.hypot(door.pos[0] - from[0], door.pos[1] - from[1]) : 1e9;
      if (dist < bestD) { bestD = dist; best = door; }
    }
    return best ? { map: best.map, x: best.pos[0], y: best.pos[1], name } : null;
  }

  /** What each NPC is to you: the kinds it counts as, for your side and level. */
  #classify() {
    const d = this.data;
    if (!d) return;
    const s = this.app.danger.settings, side = s.faction === 'horde' ? 'h' : 'a';
    this.context = `${s.faction}/${s.level}`;
    d.ready ??= new Uint8Array(d.mask.length);
    // what the unfinished quests in your log are after
    const after = new Set();
    if (this.mine) for (const [id, state] of this.mine.log) if (state === 0) this.#targets(id, after);
    d.entries.forEach((e, i) => {
      let m = 0n;
      d.ready[i] = 0;
      const hostile = !e.k && e[side] === 2 && !unsure(e, side);
      if (e.k) m |= BIT.object;
      if (!hostile) {
        if (e.qs?.some((id) => this.wanted(id))) m |= BIT.quest;
        let hand = 0;
        for (const id of e.qe ?? []) hand = Math.max(hand, this.#handIn(id));
        if (hand) { m |= BIT.turnin; d.ready[i] = hand === 2 ? 1 : 0; }
        const f = e.f ?? 0, title = e.s ?? '';
        if (f & FLAG.FLIGHT) m |= BIT.flight;
        if (f & FLAG.INN) m |= BIT.inn;
        if (f & FLAG.REPAIR) m |= BIT.repair;
        if (f & FLAG.BANK) m |= BIT.bank;
        if (f & FLAG.AUCTION) m |= BIT.auction;
        if (f & FLAG.STABLE) m |= BIT.stable;
        if (f & FLAG.SPIRIT) m |= BIT.spirit;
        if (f & FLAG.BATTLE) m |= BIT.battle;
        if (f & (FLAG.PETITION | FLAG.TABARD)) m |= BIT.guild;
        // (a demon trainer sells its grimoires, and is filed as a vendor: it is a trainer all the same)
        const teaches = f & FLAG.TRAINER || /(Pet|Demon) Trainer/i.test(title);
        if (teaches) m |= BIT[trainerKind(title)];
        else if (f & FLAG.VENDOR) m |= BIT[vendorKind(title)];
      }
      if (!e.k && !m) m = hostile ? BIT.hostile : e[side] === 0 ? BIT.other : e[side] === 1 ? BIT.neutral : BIT.unknown;
      if (after.has(i)) m |= BIT.target;
      d.mask[i] = m;
    });
  }

  /**
   * Where the people of use and the business of your quests are on this map, for the following
   * camera's automatic zoom (places.js): { n, x, y, who (the entry each belongs to), bits } with
   * bits 1 = someone with a job (vendor, trainer, flight master, banker...; whichever side they
   * are on: a town is a town), 2 = an innkeeper, 4 = a quest of yours (who gives one open to
   * you, what one in your log has you kill, use or collect, where one is handed in).
   * Worked out again only when the markers have been.
   */
  spots() {
    const d = this.data;
    if (!d) return null;
    if (this.spotsOf?.data === d && this.spotsOf.rev === this.rev) return this.spotsOf;
    const JOB = FLAG.VENDOR | FLAG.FLIGHT | FLAG.TRAINER | FLAG.INN | FLAG.BANK | FLAG.AUCTION | FLAG.STABLE | FLAG.REPAIR;
    const QUEST = BIT.quest | BIT.turnin | BIT.target;
    const bits = new Uint8Array(d.entries.length);
    d.entries.forEach((e, i) => {
      const f = e.k ? 0 : e.f ?? 0;
      bits[i] = (f & JOB ? 1 : 0) | (f & FLAG.INN ? 2 : 0) | (d.mask[i] & QUEST ? 4 : 0);
    });
    const at = [];
    for (let i = 0; i < d.n; i++) if (bits[d.owner[i]]) at.push(i);
    const s = { data: d, rev: this.rev, map: d.map, n: at.length, x: new Float32Array(at.length), y: new Float32Array(at.length), who: new Uint32Array(at.length), bits: new Uint8Array(at.length) };
    at.forEach((i, k) => { s.x[k] = d.x[i]; s.y[k] = d.y[i]; s.who[k] = d.owner[i]; s.bits[k] = bits[d.owner[i]]; });
    this.spotsOf = s;
    return s;
  }

  /** Everyone and everything a quest involves: Map<entry index, icon>. */
  #cast(questId) {
    const d = this.data, Q = this.quests, q = Q?.quests?.[questId], out = new Map();
    if (!q) return out;
    const add = (key, icon) => { const e = d.index.get(key); if (e !== undefined && (!out.has(e) || icon < out.get(e))) out.set(e, icon); };
    for (const e of this.#targets(questId)) out.set(e, ICON_TARGET);
    for (const item of q.oi ?? []) for (const id of Q.items?.[item]?.v ?? []) add('n' + id, 4);
    for (const id of q.s ?? []) add('n' + id, 0);
    for (const id of q.so ?? []) add('o' + id, 0);
    for (const id of q.e ?? []) add('n' + id, 1);
    for (const id of q.eo ?? []) add('o' + id, 1);
    return out;
  }

  /** Work out the markers the filters leave. */
  rebuild() {
    const d = this.data, s = this.settings;
    this.rev++;
    this.count = 0;
    if (!d || !s.enabled) { this.onChange(); return; }
    const now = this.app.danger.settings;
    if (this.context !== `${now.faction}/${now.level}`) this.#classify();
    let enabled = 0n;
    KINDS.forEach((k) => { if (s.kinds[k.key]) enabled |= BIT[k.key]; });
    const text = searchText(s.search);
    // (searching: how many more go by that name and are switched off - said under the box)
    let off = 0;
    const Q = this.quests?.quests ?? {};
    // per entry: the icon to draw (-1 = not shown) and whether it shows at any distance
    const icon = new Int8Array(d.entries.length).fill(-1), far = new Uint8Array(d.entries.length);
    const first = (mask) => { if (mask) for (let k = 0; k < KINDS.length; k++) if (mask & (1n << BigInt(k))) return k; return -1; };
    // (a turn-in for a quest of yours that is not finished yet is the grey question mark)
    const sign = (i, k) => (k < 0 ? 8 : KINDS[k].key === 'turnin' && this.mine && !d.ready[i] ? ICON_WAITING : KINDS[k].icon);
    if (this.focus !== null) {
      for (const [e, ic] of this.#cast(this.focus)) { icon[e] = ic; far[e] = 1; }
    } else {
      d.entries.forEach((e, i) => {
        const mask = d.mask[i];
        // Searching: by name, title, or the name of a quest it starts or ends - among those the
        // switches leave. (Until 0.5.0 a search set the switches aside: one letter that strayed
        // into the box showed everybody and everything, whatever was switched off.)
        if (text && !(e.n.toLowerCase().includes(text) || (e.s ?? '').toLowerCase().includes(text)
          // (an object also by what it asks and what it is to a profession: "herbalism", "anvil")
          || (e.nd ?? '').toLowerCase().includes(text) || (e.fo ?? '').toLowerCase().includes(text)
          || (e.qs ?? []).some((id) => Q[id]?.n.toLowerCase().includes(text)) || (e.qe ?? []).some((id) => Q[id]?.n.toLowerCase().includes(text)))) return;
        const k = first(mask & enabled);
        let on = k >= 0;
        if (on && ((1n << BigInt(k)) & CREATURE)) {
          on = !(s.ranks[e.r ?? 0] === false || (d.typed && s.types[e.ct ?? 0] === false) || (s.min && (e.l?.[1] ?? 0) < s.min) || (s.max && (e.l?.[0] ?? 99) > s.max));
        }
        if (!on) { if (text) off++; return; }
        icon[i] = sign(i, k);
        // (someone you can hand a finished quest of yours to, who has another to give: the "?"
        // comes first, as in the game - it is what you go to them for now)
        if (KINDS[k].key === 'quest' && this.mine && d.ready[i] && (mask & enabled & BIT.turnin)) icon[i] = KINDS.find((x) => x.key === 'turnin').icon;
        // (what a search finds is shown at any distance: it is what you are looking for)
        if (text) far[i] = 1;
      });
    }
    this.searchOff = off;
    let n = 0;
    for (let i = 0; i < d.n; i++) if (icon[d.owner[i]] >= 0 && !(s.unsure && d.src[i] > 1)) n++;
    const inst = new Float32Array(n * STRIDE), shown = new Uint32Array(n);
    const scene = this.app.scene;
    let o = null, w = 0;
    for (let i = 0; i < d.n; i++) {
      const e = d.owner[i];
      if (icon[e] < 0 || (s.unsure && d.src[i] > 1)) continue;
      let z = d.z[i];
      if (!Number.isFinite(z)) z = scene?.heightAt(d.x[i], d.y[i]) ?? 0;
      if (!o) o = [d.x[i], d.y[i], z];
      inst[w * STRIDE] = d.x[i] - o[0]; inst[w * STRIDE + 1] = d.y[i] - o[1]; inst[w * STRIDE + 2] = z - o[2];
      inst[w * STRIDE + 3] = icon[e]; inst[w * STRIDE + 4] = far[e];
      inst[w * STRIDE + 5] = d.entries[e].k ? 1 : SIZE[d.entries[e].r ?? 0] ?? 1;
      shown[w++] = i;
    }
    this.inst = inst; this.shown = shown; this.count = n;
    this.origin = o ?? [0, 0, 0];
    this.onChange();
  }

  /** The marker under a point of the screen (CSS pixels), as a spawn index, or -1. */
  pick(camPos, viewProj, width, height, mx, my) {
    if (!this.count) return -1;
    const o = this.origin, inst = this.inst, range = this.settings.range;
    let best = -1, bestD = 16 * 16;
    const fig = this.figureDist, marks = this.markView;
    for (let k = 0; k < this.count; k++) {
      const q = k * STRIDE, size = inst[q + 5];
      const rx = inst[q] + o[0] - camPos[0], ry = inst[q + 1] + o[1] - camPos[1], feet = inst[q + 2] + o[2] - camPos[2];
      const d2 = rx * rx + ry * ry + feet * feet;
      if (!inst[q + 4] && d2 > range * range) continue;
      const figure = d2 < fig * fig, lift = figure ? signNear(size) : SIGN_FAR;
      const p = project(viewProj, rx, ry, feet + lift);
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * width, sy = (0.5 - p[1] * 0.5) * height;
      let dd = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      const mark = marks ? MARKS[inst[q + 3]] : null;
      if (mark) {
        // A big quest mark stands up from where the sign was, and can be pointed at anywhere on
        // it (the nearer of two that overlap); beside it is not on it.
        const px = markPx(inst[q + 3], Math.hypot(rx, ry, feet + lift), marks.fit), half = Math.max(8, (px * mark.wide) / 2 + 3);
        dd = mx >= sx - half && mx <= sx + half && my >= sy - px - 3 && my <= sy + 6 ? 1 + Math.sqrt(d2) * 1e-3 : Infinity;
      }
      if (figure) {
        // a figure can be pointed at anywhere on its body, not only at the sign over its head
        const f = project(viewProj, rx, ry, feet);
        if (f) {
          const fy = (0.5 - f[1] * 0.5) * height, tall = fy - sy;
          if (my >= sy && my <= fy + 3 && Math.abs(mx - sx) <= Math.max(6, tall * 0.22)) dd = Math.min(dd, 1 + Math.sqrt(d2) * 1e-3); // (the nearer of two that overlap)
        }
      }
      if (dd < bestD) { bestD = dd; best = this.shown[k]; }
    }
    return best;
  }

  /** Names to write over the markers nearest the camera. */
  names(camPos, limit = 36, reach = 130) {
    if (!this.count || !this.settings.names) return [];
    const d = this.data, o = this.origin, inst = this.inst, near = [];
    for (let k = 0; k < this.count; k++) {
      const dist = Math.hypot(inst[k * STRIDE] + o[0] - camPos[0], inst[k * STRIDE + 1] + o[1] - camPos[1], inst[k * STRIDE + 2] + o[2] - camPos[2]);
      if (dist < reach) near.push([dist, k]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const side = this.app.danger.settings.faction === 'horde' ? 'h' : 'a', marks = this.markView;
    return near.slice(0, limit).map(([dist, k]) => {
      const e = d.entries[d.owner[this.shown[k]]], icon = inst[k * STRIDE + 3];
      const lift = dist < this.figureDist ? signNear(inst[k * STRIDE + 5]) : SIGN_FAR;
      // (over a big quest mark, which stands up the screen from where the sign was: its height there, and a little more)
      const over = marks && MARKS[icon] ? markPx(icon, dist, marks.fit) * dist * marks.perPx * 1.08 + 0.2 : 0, up = marks?.up ?? [0, 0, 1];
      return { kind: 'npc', name: e.n, x: inst[k * STRIDE] + o[0] + up[0] * over, y: inst[k * STRIDE + 1] + o[1] + up[1] * over, z: inst[k * STRIDE + 2] + o[2] + up[2] * over, lift, minDist: 0, maxDist: reach, prio: 5,
        color: e.k ? '#bcdcff' : e[side] === 2 && !unsure(e, side) ? '#ffb3a8' : e[side] === 1 ? '#ffe9a3' : unsure(e, side) && e[side] === 2 ? '#d5d9e0' : '#c4f7cb' };
    });
  }

  /**
   * The markers within `reach` yards of the camera, as figures to stand in the world (see
   * npcfigures.js): people first, then things; each is position, size, colour, spare.
   * @returns { data: Float32Array (8 floats each), people, things }
   */
  near(camPos, reach, cap = 700) {
    const d = this.data, o = this.origin, inst = this.inst;
    let list = [];
    for (let k = 0; k < this.count; k++) {
      const dx = inst[k * STRIDE] + o[0] - camPos[0], dy = inst[k * STRIDE + 1] + o[1] - camPos[1], dz = inst[k * STRIDE + 2] + o[2] - camPos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < reach * reach) list.push([d2, k]);
    }
    if (list.length > cap) list = list.sort((a, b) => a[0] - b[0]).slice(0, cap); // (a crowd: the nearest)
    const data = new Float32Array(list.length * 8);
    let w = 0, people = 0;
    for (const thing of [0, 1]) {
      for (const [, k] of list) {
        const e = d.entries[d.owner[this.shown[k]]];
        if ((e.k ? 1 : 0) !== thing) continue;
        const q = k * STRIDE, c = ICON_RGB[inst[q + 3]] ?? ICON_RGB[8];
        data[w] = inst[q]; data[w + 1] = inst[q + 1]; data[w + 2] = inst[q + 2]; data[w + 3] = inst[q + 5];
        data[w + 4] = c[0]; data[w + 5] = c[1]; data[w + 6] = c[2]; data[w + 7] = 1;
        w += 8;
        if (!thing) people++;
      }
    }
    return { data, people, things: list.length - people };
  }

  /** Everything known about one spawn point, for the details card. */
  describe(i) {
    const d = this.data, e = d.entries[d.owner[i]], Q = this.quests?.quests ?? {};
    const s = this.app.danger.settings, side = s.faction === 'horde' ? 'h' : 'a';
    const quest = (id) => {
      const q = Q[id];
      if (!q) return { id, name: `Quest ${id}`, level: null, note: '', live: false };
      const note = this.closed(id);
      return { id, name: q.n, level: q.l > 0 ? q.l : null, note, live: note === 'ready to hand in' || note === 'in your log' };
    };
    let places = 0;
    for (let k = 0; k < d.n; k++) if (d.owner[k] === d.owner[i]) places++;
    return {
      spawn: i, id: e.id, object: !!e.k, name: e.n, title: e.s ?? '', level: e.l ? (e.l[0] === e.l[1] ? `${e.l[1]}` : `${e.l[0]}-${e.l[1]}`) : '', rank: RANK[e.r ?? 0] ?? '',
      reaction: e.k ? '' : unsure(e, side) && e[side] === 2 ? 'side not recorded' : ['friendly', 'neutral', 'hostile'][e[side]] ?? '',
      // (its health as fights in this game measured it: one figure, or lowest level to highest; a boss by the game's own list)
      health: e.hp ? e.hp.map((v) => v.toLocaleString()).join('-') : '', boss: !!e.b,
      // (an object: what it asks of whoever would open it, and what it is to a profession)
      needs: e.nd ?? '', spot: e.fo ?? '',
      // (a vendor's goods as its window showed them - [item, copper, name] - and how many more; how many things a trainer teaches)
      sells: e.sl ?? [], sellsMore: e.sm ?? 0, teaches: e.tc ?? 0,
      jobs: JOBS.filter(([bit]) => (e.f ?? 0) & bit).map(([, name]) => name),
      type: e.k || !e.ct ? '' : (TYPE_NAME[e.ct] ?? '').toLowerCase(),
      starts: (e.qs ?? []).map(quest), ends: (e.qe ?? []).map(quest),
      x: d.x[i], y: d.y[i], z: Number.isFinite(d.z[i]) ? d.z[i] : null, src: d.src[i], how: HEIGHT_HOW[d.src[i]] ?? '', places,
    };
  }

  /** What a quest asks for and who is involved, for the card. */
  describeQuest(id) {
    const Q = this.quests, q = Q?.quests?.[id];
    if (!q) return null;
    const d = this.data;
    const who = (ids, table, key) => (ids ?? []).map((n) => ({ name: Q[table]?.[n]?.[0] ?? `${table === 'npcs' ? 'NPC' : 'Object'} ${n}`, here: d?.index.has(key + n) ?? false, map: Q[table]?.[n]?.[1] ?? null }));
    const items = (q.oi ?? []).map((n) => ({ name: Q.items?.[n]?.n ?? `Item ${n}`, from: [...who(Q.items?.[n]?.d, 'npcs', 'n'), ...who(Q.items?.[n]?.o, 'objects', 'o')] }));
    return {
      id, name: q.n, level: q.l > 0 ? q.l : null, min: q.m, text: q.t ?? '', side: q.side,
      starts: [...who(q.s, 'npcs', 'n'), ...who(q.so, 'objects', 'o')], ends: [...who(q.e, 'npcs', 'n'), ...who(q.eo, 'objects', 'o')],
      kill: [...who(q.oc, 'npcs', 'n'), ...who(q.ok, 'npcs', 'n')], use: who(q.oo, 'objects', 'o'), items,
      before: (q.pre ?? []).concat(q.pa ?? []).map((n) => Q.quests[n]?.n ?? `Quest ${n}`), next: q.nx ? Q.quests[q.nx]?.n ?? null : null,
    };
  }

  /**
   * Who stands at a spot: the NPC or quest object nearest it, within `reach` yards, whose height
   * is known. A waypoint from the game is a spot on the map with no height; when it is on someone
   * the map knows, that is who you are heading for, on the floor they are on.
   * @returns { spawn, name, z, src } or null
   */
  at(x, y, reach = 6) {
    const d = this.data;
    if (!d) return null;
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < d.n; i++) {
      const dx = d.x[i] - x, dy = d.y[i] - y;
      if (dx > reach || dx < -reach || dy > reach || dy < -reach || !Number.isFinite(d.z[i])) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > reach) continue;
      // someone a quest of yours sends you to, or anyone you talk to, before whatever else is there
      const e = d.owner[i], m = d.mask[e];
      const score = dist - (m & BIT.turnin ? 4 : 0) - (m & BIT.quest ? 3 : 0) - (m & CREATURE ? 0 : 1.5);
      // (BigInt flags: each test above is a wide whole number, true when not zero)
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best < 0 ? null : { spawn: best, name: d.entries[d.owner[best]].n, z: d.z[best], src: d.src[best] };
  }

  /** How the heights of this map are known: counts by source. */
  heights() {
    const out = HEIGHT_HOW.map(() => 0);
    if (this.data) for (let i = 0; i < this.data.n; i++) out[this.data.src[i]]++;
    return out;
  }

  // ---- seen in game --------------------------------------------------------------------------

  /** The game says you have opened this NPC's window: you are standing next to it. (Or, with talk.fight, that you fought this creature and were beside it.) */
  meet(talk, me) {
    if (!this.data || !me || me.map !== this.data.map) return;
    // (a fight does not take the place of a talk still being settled)
    if (talk.fight && this.meeting && !this.meeting.fight) return;
    this.meeting = { id: talk.id, object: !!talk.object, fight: !!talk.fight && !talk.object, x: me.x, y: me.y, at: performance.now() };
  }

  /**
   * Settle a meeting once your own height is certain (called every frame).
   * @param me      { map, x, y } where you are   @param tracker  the HeightTracker
   */
  update(me, tracker) {
    const m = this.meeting, d = this.data;
    if (!m || !d) return;
    const age = performance.now() - m.at;
    // you walked off, or it took too long: your height now says nothing about where they stand
    if (!me || me.map !== d.map || Math.hypot(me.x - m.x, me.y - m.y) > 6 || age > 20000) { this.meeting = null; return; }
    if (tracker.z === null || tracker.z === undefined) return;
    if (!tracker.sure && age < 4000) return; // (give the height a moment to be sure of itself)
    this.meeting = null;
    if (m.fight) { this.#fought(m, me, tracker); return; }
    const key = (m.object ? 'o' : 'n') + m.id;
    const e = d.index.get(key);
    const i = e === undefined ? -1 : this.#nearest(e, m.x, m.y, SAME);
    const was = i >= 0 && Number.isFinite(d.z[i]) ? d.z[i] : null, wasSrc = i >= 0 ? d.src[i] : -1;
    const sx = i >= 0 ? d.x[i] : m.x, sy = i >= 0 ? d.y[i] : m.y;
    // Who is surer? Someone the reference database places is surer of where they stand than the
    // map is of where you do: if the two disagree it is your height that was wrong, and theirs puts it right.
    if (i >= 0 && wasSrc >= 3 && wasSrc <= 4 && was !== null && Math.abs(tracker.z - was) > 4) {
      const before = tracker.z, now = tracker.anchor(me.x, me.y, was);
      const rec = { map: d.map, id: m.id, object: m.object, x: sx, y: sy, z: Math.round(was * 100) / 100, px: m.x, py: m.y, was, sure: true };
      d.src[i] = SEEN;
      (this.seen ??= []).push(rec);
      fetch('/api/npcs/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }).catch(() => { /* kept for this session only */ });
      this.rebuild();
      this.onNote(`${d.entries[d.owner[i]].n} stands at ${was.toFixed(1)} yd, so that is where you are: the map had you at ${before.toFixed(1)} and has put that right (now ${now.toFixed(1)}).`, { spawn: i, corrected: true });
      return;
    }
    // The game says you are indoors, yet your height is the open top of everything here with floors below it: the map has lost you. Not something to move anyone by.
    const mine = tracker.standableAt?.(me.x, me.y) ?? [];
    if (me.indoors && mine.length > 1 && Math.abs(tracker.z - mine[mine.length - 1]) < 1.5) {
      this.onNote(`${e === undefined ? 'They' : d.entries[e].n}: not noted, because the map is not sure which floor you are on yourself.`, { spawn: i, corrected: false });
      return;
    }
    // They are within arm's reach, so on your level: the floor at their own spot nearest your height, if there is one.
    let z = tracker.z;
    const floors = tracker.standableAt?.(sx, sy) ?? [];
    let near = null;
    for (const f of floors) if (Math.abs(f - tracker.z) <= 2.5 && (near === null || Math.abs(f - tracker.z) < Math.abs(near - tracker.z))) near = f;
    if (near !== null) z = near;
    const rec = { map: d.map, id: m.id, object: m.object, x: sx, y: sy, z: Math.round(z * 100) / 100, px: m.x, py: m.y, was, sure: !!tracker.sure };
    // (met far from the one place the databases have them: that place is moved here - #lone)
    const lone = i < 0 && e !== undefined ? this.#lone(e) : -1;
    const off = lone >= 0 ? Math.hypot(d.x[lone] - sx, d.y[lone] - sy) : 0;
    const at = this.#overlay(rec);
    if (at < 0) return;
    (this.seen ??= []).push(rec);
    fetch('/api/npcs/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }).catch(() => { /* kept for this session only */ });
    if (e === undefined) this.#classify();
    this.rebuild();
    const name = d.entries[d.owner[at]].n, moved = lone >= 0 && at === lone;
    this.onNote(moved ? `${name}: ${Math.round(off)} yd from the one place the database has them, so not there in this game. Moved here, ${z.toFixed(1)} yd up.`
      : i < 0 ? `${name}: not where the database has them. Noted here, ${z.toFixed(1)} yd up.`
      : was === null ? `${name}: height noted, ${z.toFixed(1)} yd.`
      : Math.abs(was - z) > 1.5 ? `${name}: height corrected from ${was.toFixed(1)} to ${z.toFixed(1)} yd (it was ${HEIGHT_HOW[wasSrc].split(':')[0]}).`
      : `${name}: height confirmed (${z.toFixed(1)} yd).`, { spawn: at, corrected: moved || (was !== null && Math.abs(was - z) > 1.5) });
  }

  /**
   * You fought a creature and were beside it: the addon says so when you loot it, or when it is
   * within ten yards of you, dead or on you. That is worth less than a talk - a creature is
   * fought where it was chased to, and ten yards can be the floor above - so it settles one
   * thing only: which LEVEL a creature is on, where that was the map's own guess.
   *  - Of its spawn points within FIGHT_REACH of you: if one is on your level already, nothing
   *    is touched (that may well be the one you fought).
   *  - Otherwise the nearest of them whose height the map guessed (or an earlier fight set, yours or another player's) is
   *    put on the floor at its own spot that is on your level - if there is one there, and no
   *    other floor at that spot is nearly as near your height.
   *  - Nobody is added; nobody the reference database places, or you have talked to, is moved;
   *    your own height is never put right by it; and it waits for the map to be sure of that.
   * Nothing is said, or kept, unless something was put right.
   */
  #fought(m, me, tracker) {
    const d = this.data, e = d.index.get('n' + m.id);
    if (e === undefined || !tracker.sure) return;
    // (the game says you are indoors, yet your height is the open top of everything here: the map has lost you)
    const mine = tracker.standableAt?.(me.x, me.y) ?? [];
    if (me.indoors && mine.length > 1 && Math.abs(tracker.z - mine[mine.length - 1]) < 1.5) return;
    const mineZ = tracker.z, level = (dist) => FIGHT_LEVEL + FIGHT_SLOPE * dist;
    let pick = -1, pickD = Infinity, pickZ = 0;
    for (let i = 0; i < d.n; i++) {
      if (d.owner[i] !== e) continue;
      const dist = Math.hypot(d.x[i] - m.x, d.y[i] - m.y);
      if (dist > FIGHT_REACH) continue;
      if (Number.isFinite(d.z[i]) && Math.abs(d.z[i] - mineZ) <= level(dist)) return;
      if ((d.src[i] > 2 && d.src[i] !== FOUGHT && d.src[i] !== FOUGHT_SHARED) || dist >= pickD) continue;
      const floors = (tracker.standableAt?.(d.x[i], d.y[i]) ?? []).slice().sort((a, b) => Math.abs(a - mineZ) - Math.abs(b - mineZ));
      if (!floors.length || Math.abs(floors[0] - mineZ) > level(dist)) continue;
      if (floors.length > 1 && Math.abs(floors[1] - mineZ) - Math.abs(floors[0] - mineZ) < FIGHT_CLEAR) continue;
      pick = i; pickD = dist; pickZ = floors[0];
    }
    if (pick < 0) return;
    const was = Number.isFinite(d.z[pick]) ? d.z[pick] : null, wasSrc = d.src[pick];
    const rec = { map: d.map, id: m.id, object: false, fight: true, x: d.x[pick], y: d.y[pick], z: Math.round(pickZ * 100) / 100, px: m.x, py: m.y, was, sure: true };
    if (this.#overlay(rec) < 0) return;
    (this.seen ??= []).push(rec);
    fetch('/api/npcs/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }).catch(() => { /* kept for this session only */ });
    this.rebuild();
    const name = d.entries[e].n;
    this.onNote(was === null ? `${name}: you fought them on this level. Height noted, ${pickZ.toFixed(1)} yd.`
      : `${name}: you fought them on this level. Height corrected from ${was.toFixed(1)} to ${pickZ.toFixed(1)} yd (it was ${HEIGHT_HOW[wasSrc].split(':')[0]}).`, { spawn: pick, corrected: true });
  }
}

// ---- drawing ------------------------------------------------------------------------------------

const COLS = 8, ROWS = 2, CELL = 64;
/** The markers, drawn once into a sheet: [colour, sign, size of the disc (0..1)]. */
const ICONS = [
  ['#f5c542', '!', 1], ['#f5c542', '?', 1], ['#63b8ff', '✈', 1], ['#d8a86b', '⌂', 1],
  ['#6fd07c', '$', 1], ['#aeb7c4', '⚒', 1], ['#c59bff', 'T', 1], ['#e3d27a', 'B', 1],
  ['#7fdc8c', '', 0.5], ['#f0d870', '', 0.5], ['#ff6a5a', '', 0.5], ['#aab2be', '', 0.5],
  ['#6fb3ff', '◆', 0.8], ['#ff5a4d', '⚔', 1], ['#9aa3ae', '?', 1], ['#ffffff', '', 0.5],
];

const linear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
/** Each sign's colour as linear red, green, blue: a figure is the colour of its sign. */
const ICON_RGB = ICONS.map(([hex]) => { const n = parseInt(hex.slice(1), 16); return [linear((n >> 16) & 255), linear((n >> 8) & 255), linear(n & 255)]; });

export function makeIconSheet() {
  const c = document.createElement('canvas');
  c.width = COLS * CELL; c.height = ROWS * CELL;
  const g = c.getContext('2d');
  ICONS.forEach(([color, sign, size], i) => {
    const cx = (i % COLS) * CELL + CELL / 2, cy = Math.floor(i / COLS) * CELL + CELL / 2, r = (CELL / 2 - 5) * size;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    g.lineWidth = 5; g.strokeStyle = 'rgba(10, 12, 16, 0.92)'; g.stroke();
    if (sign) {
      g.font = `700 ${Math.round(r * 1.45)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(12, 14, 18, 0.95)';
      g.fillText(sign, cx, cy + r * 0.06);
    }
  });
  return c;
}
/** CSS for a small copy of one marker (for the list of switches). */
export const iconStyle = (sheetUrl, icon, px = 16) => `display:inline-block;flex:none;width:${px}px;height:${px}px;background:url(${sheetUrl}) ${-(icon % COLS) * px}px ${-Math.floor(icon / COLS) * px}px / ${COLS * px}px ${ROWS * px}px`;
export const kindIcon = (key) => KINDS.find((k) => k.key === key)?.icon ?? 8;

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Layer {
  origin: vec4f,  // the markers' own origin, camera-relative
  view: vec4f,    // x, y: one pixel in clip units; z: how far markers show; w: how high above the feet they float
  near: vec4f,    // x: closer than this a marker is a figure standing in the world, and its sign sits over its head; y: a figure's height; z: 1 - the signs of quests are big marks instead (questmarks.js)
};
@group(1) @binding(0) var<uniform> L: Layer;
@group(1) @binding(1) var sheet: texture_2d<f32>;
@group(1) @binding(2) var sheetSampler: sampler;
override GHOST: f32 = 0.0;

struct VSOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) alpha: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) pos: vec3f, @location(1) icon: f32, @location(2) far: f32, @location(3) size: f32) -> VSOut {
  var out: VSOut;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let feet = pos + L.origin.xyz;
  let figure = length(feet) < L.near.x;
  let rel = feet + vec3f(0.0, 0.0, select(L.view.w, L.near.y * size + 0.45, figure));
  let dist = length(rel);
  let limit = select(L.view.z, 1.0e9, far > 0.5);
  let fade = clamp((limit - dist) / (limit * 0.12), 0.0, 1.0);
  var c = G.viewProj * vec4f(rel, 1.0);
  let mark = L.near.z > 0.5 && (${Object.keys(MARKS).map((k) => `abs(icon - ${k}.0) < 0.5`).join(' || ')});
  if (c.w < 0.3 || fade <= 0.0 || mark) { out.clip = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  // big when you are close, never smaller than a readable dot
  let px = clamp(1700.0 / dist, 15.0, 30.0) * select(1.0, 0.72, figure);
  c = vec4f(c.xy + (corner - vec2f(0.5)) * L.view.xy * px * c.w, c.z, c.w);
  out.clip = c;
  let cell = vec2f(icon % ${COLS}.0, floor(icon / ${COLS}.0));
  out.uv = (cell + vec2f(corner.x, 1.0 - corner.y)) / vec2f(${COLS}.0, ${ROWS}.0);
  out.alpha = fade;
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let t = textureSample(sheet, sheetSampler, in.uv);
  let a = in.alpha * select(1.0, GHOST, GHOST > 0.0);
  return t * a; // (the sheet's colours are already multiplied by its alpha)
}
`;
const PREMULTIPLIED = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

/** Draws the markers: each a small sign floating over its NPC's head, faint where something is in the way. */
export class NpcRenderer {
  constructor(gpu, sheetCanvas) {
    this.gpu = gpu;
    const { device } = gpu;
    this.uniform = device.createBuffer({ label: 'npc-uniform', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(12);
    const texture = device.createTexture({ label: 'npc-icons', size: [sheetCanvas.width, sheetCanvas.height], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    device.queue.copyExternalImageToTexture({ source: sheetCanvas }, { texture, premultipliedAlpha: true }, [sheetCanvas.width, sheetCanvas.height]);
    const layout = device.createBindGroupLayout({ label: 'npcs', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] });
    this.group = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ] });
    const module = device.createShaderModule({ label: 'npcs', code: SHADER });
    const buffers = [{ arrayStride: STRIDE * 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32' }, { shaderLocation: 2, offset: 16, format: 'float32' }, { shaderLocation: 3, offset: 20, format: 'float32' }] }];
    const common = { layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] }), vertex: { module, entryPoint: 'vs', buffers }, primitive: { topology: 'triangle-strip', cullMode: 'none' }, multisample: { count: gpu.sampleCount } };
    this.solid = device.createRenderPipeline({ label: 'npcs', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu, PREMULTIPLIED) }, depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' } });
    this.ghost = device.createRenderPipeline({ label: 'npcs-ghost', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu, PREMULTIPLIED), constants: { GHOST: 0.6 } }, depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'less' } });
    this.instances = null;
    this.count = 0;
    this.rev = -1;
  }

  /** @param layer NpcLayer */
  draw(pass, layer, camera) {
    if (layer.rev !== this.rev) {
      this.rev = layer.rev;
      this.count = layer.count;
      if (this.count) {
        const bytes = layer.inst.byteLength;
        if (!this.instances || this.instances.size < bytes) {
          this.instances?.destroy();
          this.instances = this.gpu.device.createBuffer({ label: 'npc-instances', size: Math.max(bytes, 1 << 16), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.gpu.device.queue.writeBuffer(this.instances, 0, layer.inst);
      }
    }
    if (!this.count) return;
    const gpu = this.gpu, d = this.data, ratio = gpu.pixelRatio || 1;
    d[0] = layer.origin[0] - camera.pos[0]; d[1] = layer.origin[1] - camera.pos[1]; d[2] = layer.origin[2] - camera.pos[2];
    d[4] = (2 * ratio) / gpu.width; d[5] = (2 * ratio) / gpu.height; d[6] = layer.settings.range; d[7] = SIGN_FAR;
    d[8] = layer.figureDist; d[9] = TALL; d[10] = layer.settings.marks ? 1 : 0;
    gpu.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setBindGroup(0, gpu.globalsGroup);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(0, this.instances);
    pass.setPipeline(this.ghost);
    pass.draw(4, this.count);
    pass.setPipeline(this.solid);
    pass.draw(4, this.count);
  }
}
