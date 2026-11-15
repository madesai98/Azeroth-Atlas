// Reads the game's own cache of what its server has told it about the things this player has
// met: creatures, quests and objects (Cache/WDB/<locale>/creaturecache.wdb, questcache.wdb and
// gameobjectcache.wdb). For anything new to this game it is the only place that says what kind
// of creature something is (beast, humanoid, elite, which pet family), or how many of each
// thing a quest asks for; and where this game has changed an old quest or creature, it holds
// what the game says now. It only ever holds what this one player has come across, so it adds
// to QuestieDB and the reference database and does not replace them. The files are the game's
// own: they are only read, never modified.
//
// Layout, worked out from the files of client build 1.60.1.70938 and checked against QuestieDB
// and the reference database (all numbers little-endian):
//
//   header, 24 bytes   the kind as four letters stored backwards ("BOMW" = WMOB creatures,
//                      "TSQW" = WQST quests, "BOGW" = WGOB objects), the client build (u32),
//                      the locale backwards ("SUne"), then three more u32: one per kind that is
//                      larger than any record in the file (688 / 12296 / 256: by the look of it
//                      the size of the client's record in memory), a small one per kind
//                      (4 / 12 / 4: by the look of it the version of the record layout), and 0.
//                      What those three mean is a guess; they are passed on as `header`.
//   records            id (u32), length (u32), then `length` bytes; the list ends with an id
//                      and a length of 0, and those are the last eight bytes of the file.
//
// Each record is the body of the server's answer about that one thing (see creature(), quest()
// and object() below for what is in it). Where lengths are packed into bits, the bits fill each
// byte from the top, and whatever follows them starts on a whole byte.
//
// Nothing here is trusted: a record must be used up to its last byte and hold believable
// values, or it is left out and counted; and a file of which less than nine records in ten
// read cleanly is given back empty (`unreadable`), so that a later game build with another
// layout gives nothing rather than rubbish. The body of a cache of any other kind (the game
// keeps a few more beside these, one of them with names players typed in) is never read.
import fs from 'node:fs';

export const WDB_VERSION = 1;

const KINDS = { WMOB: 'creature', WQST: 'quest', WGOB: 'object' };
const HEADER = 24;
const ENOUGH = 0.9; // the share of a file's records that must read cleanly for any of them to be believed

/**
 * What the client's creature classification means as a rank in QuestieDB's numbering
 * (0 normal, 1 elite, 2 rare elite, 3 boss, 4 rare). The client's numbers are the same for 0-4
 * (they equal the reference database's rank for 99.8% of the original game's creatures; where
 * they differ this game has made a creature elite). Later clients also know 5 (trivial) and
 * 6 (minus); neither is in this game's cache, and both are counted as normal here.
 */
const RANK = [0, 1, 2, 3, 4, 0, 0];

/**
 * What each step of reputation is worth. For a quest's reputation the server names a step
 * (1-7, below zero for a loss) and the game looks the amount up in a table of its own, which
 * is not in the cache. These are THIS game's amounts, by QuestieDB's reputation rewards for
 * the same quests (95% of 279 alike; most of the rest are quests where QuestieDB's figure
 * takes in what related factions pass on); a loss is five times the gain of the same step.
 * They are not the original game's: the reference database has 25, 75, 150, 250, 350 and 500
 * for steps 2-7 of the same quests.
 */
const REPUTATION = [0, 10, 25, 50, 75, 100, 150, 200];

/**
 * What a quest objective's `type` says its `id` is. 0-2 agree with the reference database
 * (creature, item, object: 97% of the original game's quests ask for the same things in the
 * same numbers), 3 and 6 with QuestieDB; the others are named as the later game's server
 * names them, which fits the quests they are on.
 */
export const OBJECTIVE_KINDS = {
  0: 'creature',   // kill it, or do whatever its text says to it (count: how many)
  1: 'item',       // have this many of the item (the thing a delivery quest hands you is one of these too)
  2: 'object',     // use the object
  3: 'talk',       // speak to the creature
  6: 'reputation', // id: the faction, count: the standing to reach with it
  10: 'area',      // reach a spot (id: the server's trigger for it, not a zone)
  14: 'criteria',  // something the server keeps count of itself (a skill level, a spell cast); its text says what
  19: 'enter',     // walk into an area (again the server's trigger)
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
const round = (v) => +v.toPrecision(7); // (the files hold single-precision numbers: 1.15 is stored as 1.149999976...)
const believable = (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);

/** Walks one record. Every read past its end throws, and so does text that is not text. */
class Reader {
  constructor(buf) { this.buf = buf; this.at = 0; this.held = 0; this.bitsLeft = 0; }
  get left() { return this.buf.length - this.at; }
  u8() { this.bitsLeft = 0; const v = this.buf.readUInt8(this.at); this.at += 1; return v; }
  i8() { this.bitsLeft = 0; const v = this.buf.readInt8(this.at); this.at += 1; return v; }
  u32() { this.bitsLeft = 0; const v = this.buf.readUInt32LE(this.at); this.at += 4; return v; }
  i32() { this.bitsLeft = 0; const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
  u64() { this.bitsLeft = 0; const v = this.buf.readBigUInt64LE(this.at); this.at += 8; return v; }
  f32() {
    this.bitsLeft = 0;
    const v = this.buf.readFloatLE(this.at);
    this.at += 4;
    if (!Number.isFinite(v)) throw new Error('not a number');
    return round(v);
  }
  /** `n` values of four bytes each that this reader makes nothing of. */
  skip(n) { this.bitsLeft = 0; if (this.at + 4 * n > this.buf.length) throw new RangeError('past the end'); this.at += 4 * n; }
  /** A number packed into `n` bits (see the head of this file). */
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (!this.bitsLeft) { this.held = this.buf.readUInt8(this.at); this.at += 1; this.bitsLeft = 8; }
      this.bitsLeft--;
      v = v * 2 + ((this.held >> this.bitsLeft) & 1);
    }
    return v;
  }
  /** Text of exactly `length` bytes. */
  text(length) {
    this.bitsLeft = 0;
    if (this.at + length > this.buf.length) throw new RangeError('text past the end');
    const s = utf8.decode(this.buf.subarray(this.at, this.at + length));
    this.at += length;
    if (!believable(s)) throw new Error('not text');
    return s;
  }
  /** Text whose counted length takes in its closing NUL (a length of 0 or 1: nothing is stored). */
  counted(length) {
    if (length <= 1) return '';
    const s = this.text(length - 1);
    if (this.u8() !== 0) throw new Error('text not closed');
    return s;
  }
  /** Text that runs up to its closing NUL. */
  cstring() {
    this.bitsLeft = 0;
    const end = this.buf.indexOf(0, this.at);
    if (end < 0) throw new RangeError('text not closed');
    const s = this.text(end - this.at);
    this.at = end + 1;
    return s;
  }
  /** `count` whole numbers, as a list. */
  list(count, most) {
    if (count > most) throw new Error('too many');
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.i32());
    return out;
  }
}

/**
 * One creature. In the order stored:
 *   bits: length of the title (11), of a second title (11), of the pointer name (6), one more
 *         bit, then four times: length of a name (11) and of its other form (11)
 *   the names that have a length (each closed by a NUL, which its length counts)
 *   flags (u32 x 2), a u32 that is always 0, type (u8), family (i32), classification (i8),
 *   two creatures it counts as when killed (i32 x 2), how many looks (u32), a number for all
 *   of them together (f32), then per look: display id (u32), scale (f32), chance (f32);
 *   health multiplier, power multiplier (f32 x 2), how many quest items (u32), another count
 *   (u32), movement id (i32), 3 x i32, class (i32), 3 x i32,
 *   the title, the second title, the pointer name (as far as they have a length), the quest items.
 *
 * Given back: what agrees with the reference database for the original game's creatures (name
 * 99.7%, type 98.6%, family 100%, classification 99.8%, class 99.8%, flags[0] 99.8% once the
 * bit this game adds is set aside, health multiplier 98.6%, power multiplier 100%, looks
 * 98.2%; the differences are things this game has changed, such as every companion pet being
 * type 12 where the reference says beast) and with QuestieDB (name 99%, title 99.8%).
 *   type      1 beast, 2 dragonkin, 3 demon, 4 elemental, 5 giant, 6 undead, 7 humanoid,
 *             8 critter, 9 mechanical, 10 not specified, 11 totem, 12 companion pet
 *   family    the pet family of a beast (1 wolf, 2 cat, 3 spider, ...), 0 for none
 *   flags     [0]: the creature type flags (1: a hunter can tame it; this game also sets
 *             0x08000000 on nearly everything), [1]: a second word of them, not checked against anything
 *   unitClass 1 warrior, 2 paladin, 4 rogue, 8 mage (what its health and mana are worked out as)
 *   movementId  how it moves: 1693 the usual, 1695 slower and 1694 faster on foot (by the
 *             reference database's speeds for the same creatures)
 *   cursor    the pointer the game shows over it ("trainer", "mail", "innkeeper"), or null
 *
 * Read but not given back, because nothing says for sure what they are: the single bit after
 * the pointer name's length (the server's "leader"; it is 0 even for the two faction leaders
 * in the cache); the u32 after the flags (always 0); the second form of each name and names
 * 2-4 (two records have a second name, a plural: "Kobold Workers"); the scale and chance of
 * each look; the count after the quest items (always 0: by later clients, currencies); the
 * three numbers after the movement id (always 0: by later clients two expansion numbers and a
 * map marker) and the three after the class (the first is the creature's own id for every
 * creature of the original game and some other number for every one new to this game; the
 * other two are always 0).
 */
function creature(id, r) {
  const titleLength = r.bits(11), titleAltLength = r.bits(11), cursorLength = r.bits(6);
  r.bits(1);
  const lengths = [];
  for (let i = 0; i < 8; i++) lengths.push(r.bits(11));
  const names = lengths.map((n) => r.counted(n));
  const flags = [r.u32(), r.u32()];
  r.skip(1);
  const type = r.u8(), family = r.i32(), classification = r.i8();
  const killCredit = [r.i32(), r.i32()].filter((n) => n > 0);
  const looks = r.u32();
  r.f32();
  if (looks > 64) throw new Error('too many looks');
  const displays = [];
  for (let i = 0; i < looks; i++) { displays.push(r.u32()); r.f32(); r.f32(); }
  const hpMul = r.f32(), powerMul = r.f32();
  const itemCount = r.u32(), otherCount = r.u32();
  const movementId = r.i32();
  r.skip(3);
  const unitClass = r.i32();
  r.skip(3);
  const title = r.counted(titleLength);
  r.counted(titleAltLength);
  const cursor = r.counted(cursorLength);
  const questItems = r.list(itemCount, 64);
  r.list(otherCount, 64);

  const name = names[0];
  if (!name || /[\r\n\t]/.test(name) || type > 63 || family < 0 || family > 9999 || classification < 0 || classification > 15) throw new Error('not a creature');
  if (hpMul < 0 || powerMul < 0 || questItems.some((n) => n <= 0)) throw new Error('not a creature');
  return {
    id, name, subName: title || null, type, family, rank: RANK[classification] ?? 0, classification,
    flags, unitClass, displays, hpMul, powerMul, questItems, killCredit, movementId, cursor: cursor || null,
  };
}

/**
 * One quest. A fixed part of 488 bytes, in the order stored (i32 unless said):
 *   id, method, level, 0, minimum level, 0, zone or sort, type, suggested group, next quest,
 *   XP difficulty, XP multiplier (f32), money, money difficulty, money multiplier (f32, always
 *   1), 0, how many spells to show, a spell, 0 x 4, 1.0 (f32), 0, start item,
 *   flags (u32), 3 more u32 of flags,
 *   4 x (reward item, how many, item handed out, how many),
 *   6 x (item to choose from, how many, its look),
 *   a point on the map: map, x (f32), y (f32), 0 or 1,
 *   0 x 8, 5 x (faction, step, exact amount x 100, 7 or 4), a word of flags for those,
 *   4 x (currency, how many), two sounds (always 890, 878), 0, time allowed (i64),
 *   how many objectives, races (u64), how many of something after the objectives,
 *   0, -2, 0, 0, 0, how many other descriptions, a second such count, 0, 0
 * then what those counts announce, in this order: the spells to show (3 x i32 each); the
 * objectives; the somethings (i32 each); the other descriptions (i32, i32, a 12-bit length,
 * the text). Each objective is: its own id (u32), type (u32), slot (i8), id of what is wanted
 * (i32), how many (i32), four bytes that hold leftovers and no value, flags (u32), a second
 * word of flags, 0 (f32), how many effects, 0, the effects (i32 each), then bits: length of its
 * text (8) and one set bit, then the text.
 * Last: bits for the lengths of nine texts (9, 12, 12, 9, 10, 8, 10, 8, 11) and two more bits
 * (always 0, 1), then the texts themselves: title, what to do, the story, where to go, four
 * that are always empty here, and what the quest log says once it is done.
 *
 * Given back: what agrees with QuestieDB (name 99.7%, level 100%, minimum level 98%, zone or
 * sort 97%, start item 100%) and with the reference database for the original game's quests
 * (method 100%, type 100%, time allowed 100%, next quest 98%, money 97%, flags 98%, reward
 * items 94%, items to choose from 89% (this game has added choices), items handed out 99%,
 * the map point 100%, the texts).
 *   method      2 for nearly all; 0: there is nothing to do but hand it in; 1 on one quest
 *               (as the reference database has all three)
 *   type        0 ordinary, 1 group, 41 PvP, 62 raid, 81 dungeon
 *   zoneOrSort  a zone's area id, or minus the id of a sort (a profession, a class, a season): as QuestieDB has it
 *   suggestedGroup  0 in every record, even for the two quests the reference database suggests
 *               a group for: its place rests on the fields either side of it and nothing more
 *   xpDifficulty, xpMultiplier  there is NO plain XP amount in the cache. The game looks the
 *               amount up in its own table by quest level and this difficulty step (1-7: about
 *               a tenth, a quarter, half, three quarters, all, 1.25 and 1.5 times the level's
 *               full amount; QuestieDB's traced amounts are one per level and step) and
 *               multiplies it by the multiplier (1 except for dungeon quests)
 *   money       copper given
 *   flags       the quest flags of the original game (8: can be shared, ...)
 *   rewardItems, choiceItems, itemDrops  [item, how many]; itemDrops are what the quest hands
 *               you or lets drop so that it can be done
 *   rewardFactions  [faction, reputation, step]: the server sends a step (1-7, negative for a
 *               loss) and only now and then an exact amount; reputation is the exact amount if
 *               there is one (it is the one that counts where both are sent: QuestieDB has
 *               that amount for all ten such quests), else what the step is worth in this
 *               game (see REPUTATION), else null. It is what the quest gives that faction
 *               itself, without what its friends pass on.
 *   poi         { map, x, y } in world yards, where the quest points you, or null
 *   timeAllowed seconds, 0 for no limit
 *   races       null if anyone may take it, else the races that may, as a 64-bit mask in
 *               hexadecimal text (it does not fit a plain number). Many quests of one side
 *               only are open to all here: the server does not always say.
 *   objectives  { type (see OBJECTIVE_KINDS), id, count, text, flags }. The text is empty where
 *               the game names the thing itself ("Red Wool Bandana: 0/10"). Flags, as the later
 *               game's server names them and as the few examples here bear out: 0x02 only after
 *               the one before it, 0x04 optional, 0x08 not shown (other creatures that count
 *               for the same thing), 0x20 on nearly all.
 *   text        objectives (the short "what to do"; $1oa, $2oa stand for the counts),
 *               description (the story), area (where to go, for quests that end at a place),
 *               completion (the log's line once done), others (other wordings of the story the
 *               server sends for players of some kind: seen twice)
 *
 * Read but not given back: the spell (set on four quests; the reference database has none for
 * the one of them it knows) and the spells to show; money difficulty; the three further words
 * of flags; the look of each item to choose from; the 7 beside each faction and their word of
 * flags; the currencies (one quest: 30 of currency 1792); the sounds; the somethings after the
 * objectives (two quests, one number each); each objective's own id, slot and effects; and
 * every field that is the same in all records.
 */
function quest(id, r) {
  if (r.i32() !== id) throw new Error('not this quest');
  const method = r.i32(), level = r.i32();
  r.skip(1);
  const minLevel = r.i32();
  r.skip(1);
  const zoneOrSort = r.i32(), type = r.i32(), suggestedGroup = r.i32(), next = r.i32();
  const xpDifficulty = r.i32(), xpMultiplier = r.f32();
  const money = r.i32();
  r.i32(); r.f32(); r.skip(1);
  const spells = r.u32();
  r.skip(5); r.f32(); r.skip(1);
  const startItem = r.i32();
  const flags = r.u32();
  r.skip(3);
  const rewardItems = [], itemDrops = [], choiceItems = [], rewardFactions = [];
  for (let i = 0; i < 4; i++) {
    const item = r.i32(), count = r.i32(), drop = r.i32(), dropCount = r.i32();
    if (item > 0) rewardItems.push([item, count]);
    if (drop > 0) itemDrops.push([drop, dropCount]);
  }
  for (let i = 0; i < 6; i++) {
    const item = r.i32(), count = r.i32();
    r.skip(1);
    if (item > 0) choiceItems.push([item, count]);
  }
  const map = r.i32(), x = r.f32(), y = r.f32();
  r.skip(9);
  for (let i = 0; i < 5; i++) {
    const faction = r.i32(), step = r.i32(), exact = r.i32();
    r.skip(1);
    if (faction <= 0) continue;
    const worth = REPUTATION[Math.abs(step)];
    rewardFactions.push([faction, exact ? exact / 100 : step && worth !== undefined ? (step < 0 ? -5 * worth : worth) : null, step]);
  }
  r.skip(1 + 8 + 2 + 1);
  const timeAllowed = r.u64();
  const objectiveCount = r.u32();
  const races = r.u64();
  const somethings = r.u32();
  r.skip(5);
  const otherDescriptions = r.u32(), otherCompletions = r.u32();
  r.skip(2);
  if (spells > 16 || objectiveCount > 64 || somethings > 16 || otherDescriptions > 16 || otherCompletions > 16) throw new Error('not a quest');

  r.skip(3 * spells);
  const objectives = [];
  for (let i = 0; i < objectiveCount; i++) {
    r.skip(1);
    const kind = r.u32();
    r.i8();
    const what = r.i32(), count = r.i32();
    r.skip(1);
    const objectiveFlags = r.u32();
    r.skip(1); r.f32();
    const effects = r.u32();
    r.skip(1);
    r.list(effects, 256);
    const length = r.bits(8);
    r.bits(1);
    if (kind > 255) throw new Error('not an objective');
    objectives.push({ type: kind, id: what, count, text: r.text(length), flags: objectiveFlags });
  }
  r.list(somethings, 16);
  const others = [];
  for (let i = 0; i < otherDescriptions + otherCompletions; i++) {
    r.skip(2);
    const wording = r.text(r.bits(12));
    if (i < otherDescriptions) others.push(wording);
  }
  const lengths = [9, 12, 12, 9, 10, 8, 10, 8, 11].map((n) => r.bits(n));
  r.bits(2);
  const texts = lengths.map((n) => r.text(n));

  const name = texts[0];
  if (!name || /[\r\n\t]/.test(name) || level < -1 || level > 999 || minLevel < -1 || minLevel > 999 || xpDifficulty < 0 || xpDifficulty > 99 || timeAllowed > 0xffffffffn) throw new Error('not a quest');
  return {
    id, name, method, level, minLevel, type, zoneOrSort, suggestedGroup, next, xpDifficulty, xpMultiplier, money, startItem, flags,
    rewardItems, choiceItems, itemDrops, rewardFactions,
    poi: x || y ? { map, x, y } : null,
    timeAllowed: Number(timeAllowed),
    races: races === 0xffffffffffffffffn ? null : `0x${races.toString(16)}`,
    objectives,
    text: { objectives: texts[1], description: texts[2], area: texts[3], completion: texts[8], others },
  };
}

/**
 * One object (a chest, a chair, a door, a herb, a signpost). In the order stored: type (i32),
 * display id (i32), four names, three more texts (each closed by a NUL; all but the first
 * name are empty in nearly every record), 35 numbers whose meaning depends on the type (i32),
 * size (f32), how many quest items (u8), the quest items (i32 each), two more i32.
 *
 * Given back: what agrees with the reference database for the original game's objects (type
 * 100%, display id 99.6%, size 100%, each of the first 20 numbers 98.9% or more) and with
 * QuestieDB (name 100%).
 *   type        3 a chest or anything else you open and take from (data[1]: what it holds, as
 *               the reference database's chests have it), 5 scenery with a name, 7 a chair,
 *               8 something that counts as a forge, a fire, a moonwell, ...
 *   data        always 35 numbers
 *   questItems  the quest items it can hold
 *
 * Read but not given back: names 2-4 and the three texts (one record has the second text set),
 * and the last two numbers (set together on 52 objects, mostly chests new to this game).
 */
function object(id, r) {
  const type = r.i32(), displayId = r.i32();
  const name = r.cstring();
  for (let i = 0; i < 6; i++) r.cstring();
  const data = r.list(35, 35);
  const size = r.f32();
  const questItems = r.list(r.u8(), 64);
  r.skip(2);
  if (type < 0 || type > 255 || displayId < 0 || size < 0 || /[\r\n\t]/.test(name) || questItems.some((n) => n <= 0)) throw new Error('not an object');
  return { id, type, displayId, name, data, size, questItems };
}

const PARSERS = { creature, quest, object };
const backwards = (buf) => { const s = [...buf.toString('latin1')].reverse().join(''); return /^[A-Za-z]{4}$/.test(s) ? s : null; };

/**
 * Read one cache file.
 * @returns {{ kind: 'creature'|'quest'|'object'|null, build: number, locale: string|null, header: number[],
 *   total: number, records: object[], skipped: number, unreadable: boolean }}
 *   kind      what the file holds; null for a file that is missing, too short or of another
 *             kind (nothing more is read of it, and the rest is empty)
 *   total     how many records the file holds; records: those that read cleanly (see
 *             creature(), quest() and object()); skipped: how many did not
 *   unreadable  the list of records does not end where the file does (cut short, or caught
 *             while the game was writing it), or too few of them read cleanly: records is
 *             then empty, whatever was read
 * Never throws.
 */
export function readWdb(file) {
  const out = { kind: null, build: 0, locale: null, header: [], total: 0, records: [], skipped: 0, unreadable: false };
  let body;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(HEADER);
      if (fs.readSync(fd, head, 0, HEADER, 0) < HEADER) return out;
      out.build = head.readUInt32LE(4);
      out.locale = backwards(head.subarray(8, 12));
      out.header = [head.readUInt32LE(12), head.readUInt32LE(16), head.readUInt32LE(20)];
      out.kind = KINDS[backwards(head.subarray(0, 4))] ?? null;
      if (!out.kind) return out;
      body = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - HEADER));
      let got = 0;
      while (got < body.length) {
        const n = fs.readSync(fd, body, got, body.length - got, HEADER + got);
        if (!n) break;
        got += n;
      }
      body = body.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ...out, kind: null };
  }

  // the records, as the file frames them
  const framed = [];
  let at = 0, whole = false;
  while (at + 8 <= body.length) {
    const id = body.readUInt32LE(at), length = body.readUInt32LE(at + 4);
    if (!id && !length) { whole = at + 8 === body.length; break; }
    if (length > body.length - at - 8) break;
    framed.push([id, body.subarray(at + 8, at + 8 + length)]);
    at += 8 + length;
  }
  out.total = framed.length;

  const parse = PARSERS[out.kind];
  const records = [];
  for (const [id, bytes] of framed) {
    try {
      const r = new Reader(bytes);
      const record = parse(id, r);
      if (!id || r.left) throw new Error('not used up');
      records.push(record);
    } catch {
      out.skipped++;
    }
  }
  if (!whole || records.length < framed.length * ENOUGH) out.unreadable = true;
  else out.records = records;
  return out;
}
