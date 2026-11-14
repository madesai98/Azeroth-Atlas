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
// update), and laid over the extracted data from then on.
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
];
export const SEEN = 5;

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
const KEY = 'wfmap.npcs';
const STRIDE = 6;        // floats per marker: position (from the layer's origin), sign, shown at any distance, size
const SIZE = [1, 1.25, 1.3, 1.6, 1.1]; // how big a figure is, by rank: ordinary, elite, rare elite, boss, rare
const TALL = 1.9;        // yards: a figure's height at size 1 (see npcfigures.js)
const SIGN_FAR = 2.4;    // yards above the feet a sign floats on its own...
const signNear = (size) => TALL * size + 0.45; // ...and over the head of a figure

export class NpcLayer {
  constructor(app) {
    this.app = app;
    // (ranks, types: which creatures, by rank and by kind of thing - every one unless switched off)
    this.settings = { enabled: false, kinds: Object.fromEntries(KINDS.map((k) => [k.key, k.on])), search: '', min: null, max: null, myQuests: true, ranks: {}, types: {}, unsure: false, names: true, range: 1200 };
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
    if (!map.npcs) return;
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
      map: map.id, source: meta.source, reference: meta.reference, entries: meta.entries, n, unplaced: meta.unplaced ?? [],
      x: new Float32Array(room), y: new Float32Array(room), z: new Float32Array(room), owner: new Uint32Array(room), src: new Uint8Array(room),
      mask: new BigUint64Array(meta.entries.length + mine.length + 64), spawnCount: null,
      typed: meta.entries.some((e) => e.ct), // (does this map's data say what kind of thing a creature is? One built before that was added does not)
      index: new Map(meta.entries.map((e, i) => [(e.k ? 'o' : 'n') + e.id, i])),
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
      // someone the database has nowhere on this map: known from now on
      if (d.entries.length >= d.mask.length) return -1;
      const known = this.quests?.[r.object ? 'objects' : 'npcs']?.[r.id];
      e = d.entries.length;
      d.entries.push(r.object ? { id: r.id, k: 1, n: known?.[0] ?? `Object ${r.id}` } : { id: r.id, n: known?.[0] ?? `NPC ${r.id}`, a: 2, h: 2, u: 1 });
      d.index.set((r.object ? 'o' : 'n') + r.id, e);
    }
    let i = this.#nearest(e, r.x, r.y, SAME);
    if (vet && i >= 0 && Number.isFinite(d.z[i]) && ((d.src[i] >= 3 && d.src[i] <= 4 && Math.abs(r.z - d.z[i]) > 6) || r.z - d.z[i] > 60)) { this.rejected++; return -1; }
    if (i < 0) {
      if (d.n >= d.owner.length) return -1;
      i = d.n++;
      d.x[i] = r.x; d.y[i] = r.y; d.owner[i] = e;
    }
    d.z[i] = r.z; d.src[i] = SEEN;
    return i;
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

  /** What a quest has you kill, use or collect: the entries of this map, as a Set. */
  #targets(questId, into = new Set()) {
    const d = this.data, Q = this.quests, q = Q?.quests?.[questId];
    if (!q) return into;
    const add = (key) => { const e = d.index.get(key); if (e !== undefined) into.add(e); };
    for (const id of q.oc ?? []) add('n' + id);
    for (const id of q.ok ?? []) add('n' + id);
    for (const id of q.oo ?? []) add('o' + id);
    for (const item of q.oi ?? []) {
      const it = Q.items?.[item];
      for (const id of it?.d ?? []) add('n' + id);
      for (const id of it?.o ?? []) add('o' + id);
    }
    return into;
  }

  /**
   * Where a quest of yours is to be got on with, on this map: the nearest to `from` of what it
   * has you kill, use or collect - or, once it is ready to hand in (or asks for nothing that is
   * on this map), of who takes it.
   * @returns { x, y, z (null where the height is not known), name, done (it is to be handed in) } or null
   */
  questGoal(id, from) {
    const d = this.data, q = this.quests?.quests?.[id];
    if (!d || !q || !from) return null;
    const done = this.mine?.log.get(id) === 1;
    const takers = () => {
      const out = new Set();
      for (const n of q.e ?? []) { const e = d.index.get('n' + n); if (e !== undefined) out.add(e); }
      for (const n of q.eo ?? []) { const e = d.index.get('o' + n); if (e !== undefined) out.add(e); }
      return out;
    };
    let who = done ? takers() : this.#targets(id), handIn = done;
    if (!who.size && !done) { who = takers(); handIn = true; }
    let best = -1, bestD = Infinity;
    for (let i = 0; i < d.n; i++) {
      if (!who.has(d.owner[i])) continue;
      const dist = Math.hypot(d.x[i] - from[0], d.y[i] - from[1]);
      if (dist < bestD) { bestD = dist; best = i; }
    }
    if (best < 0) return null;
    return { x: d.x[best], y: d.y[best], z: Number.isFinite(d.z[best]) ? d.z[best] : null, name: d.entries[d.owner[best]].n, done: handIn };
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
      const hostile = !e.k && e[side] === 2 && !e.u;
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
    const text = s.search.trim().toLowerCase();
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
        if (text) {
          // searching: by name, title, or the name of a quest it starts or ends; the switches are set aside
          const hit = e.n.toLowerCase().includes(text) || (e.s ?? '').toLowerCase().includes(text)
            || (e.qs ?? []).some((id) => Q[id]?.n.toLowerCase().includes(text)) || (e.qe ?? []).some((id) => Q[id]?.n.toLowerCase().includes(text));
          if (hit) { icon[i] = sign(i, first(mask)); far[i] = 1; }
          return;
        }
        const k = first(mask & enabled);
        if (k < 0) return;
        if ((1n << BigInt(k)) & CREATURE) {
          if (s.ranks[e.r ?? 0] === false) return;
          if (d.typed && s.types[e.ct ?? 0] === false) return;
          if (s.min && (e.l?.[1] ?? 0) < s.min) return;
          if (s.max && (e.l?.[0] ?? 99) > s.max) return;
        }
        icon[i] = sign(i, k);
      });
    }
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
    const fig = this.figureDist;
    for (let k = 0; k < this.count; k++) {
      const q = k * STRIDE, size = inst[q + 5];
      const rx = inst[q] + o[0] - camPos[0], ry = inst[q + 1] + o[1] - camPos[1], feet = inst[q + 2] + o[2] - camPos[2];
      const d2 = rx * rx + ry * ry + feet * feet;
      if (!inst[q + 4] && d2 > range * range) continue;
      const figure = d2 < fig * fig;
      const p = project(viewProj, rx, ry, feet + (figure ? signNear(size) : SIGN_FAR));
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * width, sy = (0.5 - p[1] * 0.5) * height;
      let dd = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
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
    const side = this.app.danger.settings.faction === 'horde' ? 'h' : 'a';
    return near.slice(0, limit).map(([dist, k]) => {
      const e = d.entries[d.owner[this.shown[k]]];
      return { kind: 'npc', name: e.n, x: inst[k * STRIDE] + o[0], y: inst[k * STRIDE + 1] + o[1], z: inst[k * STRIDE + 2] + o[2], lift: dist < this.figureDist ? signNear(inst[k * STRIDE + 5]) : SIGN_FAR, minDist: 0, maxDist: reach, prio: 5,
        color: e.k ? '#bcdcff' : e[side] === 2 && !e.u ? '#ffb3a8' : e[side] === 1 ? '#ffe9a3' : e.u && e[side] === 2 ? '#d5d9e0' : '#c4f7cb' };
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
      reaction: e.k ? '' : e.u && e[side] === 2 ? 'side not recorded' : ['friendly', 'neutral', 'hostile'][e[side]] ?? '',
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
    const out = [0, 0, 0, 0, 0, 0];
    if (this.data) for (let i = 0; i < this.data.n; i++) out[this.data.src[i]]++;
    return out;
  }

  // ---- seen in game --------------------------------------------------------------------------

  /** The game says you have opened this NPC's window: you are standing next to it. */
  meet(talk, me) {
    if (!this.data || !me || me.map !== this.data.map) return;
    this.meeting = { id: talk.id, object: !!talk.object, x: me.x, y: me.y, at: performance.now() };
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
    const at = this.#overlay(rec);
    if (at < 0) return;
    (this.seen ??= []).push(rec);
    fetch('/api/npcs/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }).catch(() => { /* kept for this session only */ });
    if (e === undefined) this.#classify();
    this.rebuild();
    const name = d.entries[d.owner[at]].n;
    this.onNote(i < 0 ? `${name}: not where the database has them. Noted here, ${z.toFixed(1)} yd up.`
      : was === null ? `${name}: height noted, ${z.toFixed(1)} yd.`
      : Math.abs(was - z) > 1.5 ? `${name}: height corrected from ${was.toFixed(1)} to ${z.toFixed(1)} yd (it was ${HEIGHT_HOW[wasSrc].split(':')[0]}).`
      : `${name}: height confirmed (${z.toFixed(1)} yd).`, { spawn: at, corrected: was !== null && Math.abs(was - z) > 1.5 });
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
  near: vec4f,    // x: closer than this a marker is a figure standing in the world, and its sign sits over its head; y: a figure's height
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
  if (c.w < 0.3 || fade <= 0.0) { out.clip = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
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
    d[8] = layer.figureDist; d[9] = TALL;
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
