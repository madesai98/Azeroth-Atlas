// Is a quest one you can take now - and of one that is not, why not.
//
// A quest giver in the game shows its "!" only for a quest your character can be given at this
// moment. What decides that is in the quest data (quests.json: QuestieDB's fields, as the map
// build hands them on) and in what the game says of your character over the live link: your
// side and level, your race and class, the quests in your log and the ones you have done, your
// professions and how far you are in each, where you stand with each faction, and whether you
// have learned a few spells quests ask after. A quest is open when nothing here speaks against
// it:
//
//   your side, race and class             the quest is for them (side, rc, c)
//   your level                            high enough (m), not too high (x), and the quest not
//                                         outgrown (l: GREY levels and more under you)
//   your log                              it is not in it; nor a quest that rules it out (ex), one
//                                         that leads to it (bc), or one that closes it while you
//                                         have it (dq); and the quest it is a part of is (par)
//   what you have done                    not this one; one of pre, and all of pa (for each of
//                                         those, a quest that rules it out will do as well); not
//                                         one that rules it out (ex), the one it only leads to
//                                         (bf), the one after it (nx), or the one that ends its
//                                         being offered (au)
//   your professions                      the one it asks for, far enough (sk), of the rank it
//                                         asks for (rk), with or without a specialisation (spz)
//   your standing with a faction          enough (rn), and not too much (rx)
//   what you have learned                 the spell it asks for - or, where it is offered only
//                                         to those who have not, not that spell (sp)
//   the time of year                      a quest of a festival or a world event is taken to be
//                                         closed: whether its event is on is not known here
//   Questie's own lists                   a quest Questie's makers list as not in this game (a
//                                         duplicate, one never finished, a promotion), one they
//                                         show no "!" for (a book brought to a librarian, a sealed
//                                         crate, the fishing tournament's), one of a world event
//                                         that is over (the Ahn'Qiraj war effort), one of a
//                                         festival (questhidden.js: tools/make-quest-hidden.mjs)
//
// What is not known is not held against a quest: without the live link nothing of your log or
// of what you have done is, and a quest is judged by side and level alone; an addon from before
// version 33 does not say your race, class, professions, standings or spells. (So the fewer of
// those are known, the more quest givers count as having something for you.)
//
// Questie's lists are Questie's (they are not in QuestieDB): the map has a copy of them, made
// from a release of Questie. A quest the game has stopped offering since is not told apart until
// they say so.
import { NOT_IN_GAME, NO_MARK, EVENT_OVER, FESTIVAL } from './questhidden.js';

/** Why Questie keeps a quest off its map, by quest: 1 not in this game, 2 no "!" for it, 3 its event is over, 4 a festival's. */
const HIDDEN = new Map([...FESTIVAL.map((id) => [id, 4]), ...EVENT_OVER.map((id) => [id, 3]), ...NO_MARK.map((id) => [id, 2]), ...NOT_IN_GAME.map((id) => [id, 1])]);
const HIDDEN_WHY = { 1: 'not in this game', 2: 'not offered with a "!"', 3: 'its event is over', 4: 'only while its event is on' };

/**
 * Is a quest one that makes whoever gives it a quest giver at all? Not one that is not in this
 * game, nor one the game shows no "!" for: those are no sign of anything to be had there, whatever
 * else is known.
 */
export const givenHere = (id) => { const h = HIDDEN.get(id); return h !== 1 && h !== 2; };

/** A quest this many levels under you is no longer worth doing (the game hides its "!"). */
export const GREY = 7;

/** QuestieDB's mark for each race, by the game's number for the race (LibQuestieDB.Enum.raceMaskById). */
const RACE_MARK = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32, 7: 64, 8: 128, 9: 256, 10: 512, 11: 1024, 22: 2097152, 24: 8388608, 25: 16777216, 26: 33554432, 95: 4294967296, 96: 8589934592 };
export const RACE_NAME = { 1: 'human', 2: 'orc', 3: 'dwarf', 4: 'night elf', 5: 'undead', 6: 'tauren', 7: 'gnome', 8: 'troll', 9: 'goblin', 10: 'blood elf', 11: 'draenei', 95: 'skyborne', 96: 'skyborne' };
/** The classes, by the game's number for each (a quest's mark for a class is 2 to the power of that number less one). */
export const CLASS_NAME = { 1: 'warrior', 2: 'paladin', 3: 'hunter', 4: 'rogue', 5: 'priest', 6: 'death knight', 7: 'shaman', 8: 'mage', 9: 'warlock', 10: 'monk', 11: 'druid' };
export const SKILL_NAME = { 129: 'First Aid', 164: 'Blacksmithing', 165: 'Leatherworking', 171: 'Alchemy', 182: 'Herbalism', 185: 'Cooking', 186: 'Mining', 197: 'Tailoring', 202: 'Engineering', 333: 'Enchanting', 356: 'Fishing', 393: 'Skinning', 755: 'Jewelcrafting', 762: 'Riding', 773: 'Inscription' };
/** The spells that are a profession's specialisations: knowing one is having chosen. */
export const SPECIALISATIONS = { 164: [9788, 9787, 17039, 17040, 17041], 165: [10656, 10658, 10660], 171: [28672, 28675, 28677], 197: [26797, 26798, 26801], 202: [20219, 20222] };
/** How far a profession can be taken at each rank: apprentice, journeyman, expert, artisan, and on. */
const RANK_TOP = [75, 150, 225, 300, 375, 450, 525, 600];
/** The kinds of quest (a quest's zoneOrSort, below zero) that belong to a festival or a world event. */
const EVENTS = new Set([-404, -402, -378, -376, -375, -374, -370, -369, -368, -366, -365, -364, -41, -22, -21]);

/** Is this mark among those? (By arithmetic: a race's mark may be above the 32 the bit operators know.) */
const marked = (marks, mark) => Math.floor(marks / mark) % 2 === 1;
const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
/** The rank a profession has been taken to, by how far it can go now: 1 apprentice, 2 journeyman, 3 expert, 4 artisan... */
const rankOf = (most) => { let r = 0; while (r < RANK_TOP.length && most >= RANK_TOP[r]) r++; return r; };

/**
 * Why a quest is not one you can take now - '' if it is.
 *
 * @param id   the quest's number
 * @param Q    every quest, by its number (quests.json: quests)
 * @param you  what is known of your character:
 *             { side (1 Alliance, 2 Horde), level,
 *               log: Map<quest, state (0 under way, 1 ready to hand in, 2 failed)> | null, done: Set<quest> | null,
 *               race, class (the game's numbers; 0 or none: not known),
 *               skills: Map<skill, [how far you are, how far it can go]> | null,
 *               reps: Map<faction, standing (0 neutral; null: a faction you have not met)> | null,
 *               spells: Map<spell, you know it> | null (the spells asked after) }
 * @param names  { factions: { [id]: name } } - what things are called, where the data says
 */
export function closedWhy(id, Q, you, names = {}) {
  const q = Q?.[id];
  if (!q) return '';
  const { log, done } = you;
  const named = (n) => Q[n]?.n ?? 'another quest';
  const have = (n) => !!log?.has(n), did = (n) => !!done?.has(n);

  if (!(q.side & you.side)) return 'other side';
  if (log) {
    const state = log.get(id);
    if (state !== undefined) return state === 1 ? 'ready to hand in' : state === 2 ? 'failed' : 'in your log';
  }
  if (did(id)) return q.rep ? 'done before, and can be done again' : 'done';
  if (q.ex?.some((x) => did(x) || have(x))) return 'you took another instead';
  // (one Questie's makers keep off their map in this game: questhidden.js)
  const hidden = HIDDEN.get(id);
  if (hidden) return HIDDEN_WHY[hidden];

  // who it is for
  const race = RACE_MARK[you.race];
  if (q.rc && race && !marked(q.rc, race)) return 'for other races';
  if (q.c && you.class > 0 && !marked(q.c, 2 ** (you.class - 1))) {
    const whose = Object.entries(CLASS_NAME).filter(([n]) => marked(q.c, 2 ** (n - 1))).map(([, name]) => `${name}s`);
    return whose.length ? `for ${list(whose)}` : 'for another class';
  }
  if (q.m > you.level) return `from level ${q.m}`;
  if (q.x && you.level > q.x) return 'outgrown';

  // the quests before it, and around it
  if (done) {
    // one of these first; or, where there is no such list, all of those (for each, a quest that rules it out will do as well)
    if (q.pre?.length) { if (!q.pre.some(did)) return `after ${named(q.pre[0])}`; }
    else if (q.pa?.length) {
      const missing = q.pa.find((p) => (p < 0 ? !did(-p) : !did(p) && !Q[p]?.ex?.some(did)));
      if (missing !== undefined) return `after ${named(Math.abs(missing))}`;
    }
    if (q.as && !did(q.as) && !have(q.as)) return `after ${named(q.as)}`;
    if (q.au && did(q.au)) return 'no longer offered';
    if (q.bf && did(q.bf)) return 'you are past it';
    if (q.nx && did(q.nx)) return 'you are past it';
  }
  if (log) {
    if (q.par && !have(q.par)) return `only while you have ${named(q.par)}`;
    if (q.bf && have(q.bf)) return 'you are past it';
    if (q.nx && have(q.nx)) return 'you are past it';
    const leading = q.bc?.find(have);
    if (leading !== undefined) return `hand in ${named(leading)} first`;
    if (q.dq && have(q.dq)) return `not while you have ${named(q.dq)}`;
  }

  // your professions
  const skills = you.skills;
  if (skills) {
    const skill = (n) => SKILL_NAME[n] ?? 'a profession';
    // (yours: [how far you are, how far it goes]; null: you do not have it - said as 0 and 0; undefined: not asked about, so not known)
    const got = (n) => { const s = skills.get(n); return s === undefined ? undefined : s[0] > 0 || s[1] > 0 ? s : null; };
    if (q.sk) {
      const mine = got(q.sk[0]);
      if (mine === null) return `needs ${skill(q.sk[0])}`;
      if (mine && mine[0] < q.sk[1]) return `needs ${skill(q.sk[0])} ${q.sk[1]}`;
    }
    if (q.rk?.length) {
      // a rank asked for: one of these professions, taken that far. A rank below zero: not taken that far yet.
      const asked = q.rk.filter((r) => r[1] > 0), barred = q.rk.filter((r) => r[1] < 0);
      if (asked.length && asked.every(([n]) => got(n) !== undefined) && !asked.some(([n, rank]) => got(n) && rankOf(got(n)[1]) >= rank)) return `needs ${list(asked.map(([n]) => skill(n)))} taken further`;
      if (barred.some(([n, rank]) => got(n) && rankOf(got(n)[1]) >= -rank)) return 'not for a master of the craft';
    }
  }
  const spells = you.spells;
  if (spells) {
    if (q.spz > 0) {
      // a profession: for whoever has not chosen a specialisation of it yet. A specialisation: for whoever has chosen that one.
      const within = SPECIALISATIONS[q.spz];
      if (within) { if (within.some((s) => spells.get(s) === true)) return 'you have chosen a specialisation already'; }
      else if (spells.get(q.spz) === false) return 'needs a specialisation you have not chosen';
    }
    if (q.sp) {
      const known = spells.get(Math.abs(q.sp));
      if (q.sp > 0 && known === false) return 'needs something you have not learned';
      if (q.sp < 0 && known === true) return 'you have learned it already';
    }
  }

  // where you stand with a faction (one you have not met: neither liked nor disliked)
  const reps = you.reps;
  if (reps) {
    const faction = (n) => names.factions?.[n] ?? 'a faction';
    if (q.rn && reps.has(q.rn[0]) && (reps.get(q.rn[0]) ?? 0) < q.rn[1]) return `needs more standing with ${faction(q.rn[0])}`;
    if (q.rx && reps.has(q.rx[0]) && (reps.get(q.rx[0]) ?? 0) >= q.rx[1]) return `your standing with ${faction(q.rx[0])} is too high`;
  }

  if (q.z < 0 && EVENTS.has(q.z)) return 'only while its event is on';
  if (q.l > 0 && q.l < you.level - GREY) return 'outgrown';
  return '';
}

/**
 * What is known of your character, in words (for the panel to say what the quests are held to):
 * { who: 'level 24 night elf hunter', known: [...], missing: [...] }.
 */
export function knownOf(you) {
  const who = [`level ${you.level}`, RACE_NAME[you.race], CLASS_NAME[you.class]].filter(Boolean).join(' ');
  const facts = [['your quest log', !!you.log], ['what you have done', !!you.done], ['your race and class', !!(you.race && you.class)], ['your professions', !!you.skills], ['your standings', !!you.reps], ['what you have learned', !!you.spells]];
  return { who, known: facts.filter((f) => f[1]).map((f) => f[0]), missing: facts.filter((f) => !f[1]).map((f) => f[0]) };
}
