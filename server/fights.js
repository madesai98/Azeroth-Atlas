// How your own fights go, as the game's combat log has them: what you deal in a second, and how
// long you are from one kill to the next. The quest explorer reckons the time a quest takes by
// these, in place of a round figure for your level (viewer/js/pace.js says why; quests.js).
//
// The log is read by combatlog.js, line by line, for where creatures stand and what health they
// have; each line is passed on here. Followed here is only what you (and your pet, your totem,
// whatever fights for you) do to the creatures of the world, and they to you:
//
//   a fight       begins with the first blow between you and a creature while you are in none,
//                 takes in every creature that joins it, and ends when the last of them is dead.
//                 Two at once are one fight with two kills: the seconds are counted once.
//   kept of it    how long it lasted, what you dealt in it (what was needed to kill, not what a
//                 last blow dealt beyond that), how many creatures died in it and of which level,
//                 which level you were (the live link says: the log's own "level" of a player is
//                 the level of what they wear), and how long it began after the fight before -
//                 if that was within three minutes: longer is a walk elsewhere or a break, not
//                 "from one to the next".
//   not kept      a fight somebody else had a hand in (a tenth of the damage or more: the pace
//                 is yours alone, and the reckoning is for one player); one in which a creature
//                 got away, or you died; one that went quiet for twenty seconds (it was left);
//                 one read from a log of another day (which level you were then is not known).
//
// The last sixty fights of each character of yours are kept (<dataDir>/user/fights.json), under
// the same scrambled form of the game's name for the character that combatlog.js uses - never
// the name. That is a rolling figure: sixty fights are an hour or so of questing, and as you
// level and change what you wear the old ones fall out. It is yours: it stays on this disk, and
// is no part of what goes to the Atlas database (atlasdb/collect.js reads other files).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../extractor/container.js';
import { atlasStamp } from '../extractor/atlas.js';
import { note } from './log.js';

const KEEP = 60;            // fights kept of one character
const CHARACTERS = 12;      // characters kept (the ones longest unplayed go)
const QUIET = 20000;        // ms without a blow: the fight was left
const NEXT = 180000;        // ms: a fight begun later than this after the one before is not "the next one"
const FRESH = 120000;       // ms: a line older than this was not written while the live link said which level you are
const LONGEST = 300;        // seconds: a fight longer than this is something else (a chase, a wait)
const SHORTEST = 2;
const SAVE = 20000;         // ms: written to disk no more often than this
const ALONE = 0.1;          // others may have dealt up to this share of it
const MOSTLY = 0.7;         // ...and you this share of the health of what died, at least

const MINE = 0x1, PLAYERS = 0x100, NPC = 0x800, PET = 0x1000, GUARDIAN = 0x2000;
const BLOWS = new Set(['SWING_DAMAGE', 'RANGE_DAMAGE', 'SPELL_DAMAGE', 'SPELL_PERIODIC_DAMAGE', 'SPELL_BUILDING_DAMAGE', 'DAMAGE_SHIELD']);
const TRIES = new Set(['SWING_MISSED', 'RANGE_MISSED', 'SPELL_MISSED', 'SPELL_PERIODIC_MISSED', 'DAMAGE_SHIELD_MISSED', 'SWING_DAMAGE_LANDED']);
const round1 = (v) => Math.round(v * 10) / 10;

const isCreature = (guid, flags) => typeof guid === 'string' && (guid.startsWith('Creature-') || guid.startsWith('Vehicle-')) && Number.isFinite(flags) && (flags & NPC) !== 0 && (flags & (PLAYERS | PET | GUARDIAN)) === 0;

export class Fights {
  /**
   * @param level  () => the level of the character you are playing now, as the live link has it (null: not known)
   * @param now    () => ms (the tests' own clock)
   */
  constructor(cfg, { level = () => null, now = () => Date.now() } = {}) {
    this.file = path.join(cfg.dataDir, 'user', 'fights.json');
    this.level = level; this.now = now;
    this.store = { v: 1, who: {}, last: null };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d?.v === 1 && d.who && typeof d.who === 'object' && !Array.isArray(d.who)) {
        for (const [key, c] of Object.entries(d.who)) if (Array.isArray(c?.fights)) this.store.who[key] = { fights: c.fights.filter((f) => f && f.s > 0 && f.d > 0 && f.n >= 1).slice(-KEEP), at: Number(c.at) || 0 };
        if (typeof d.last === 'string' && this.store.who[d.last]) this.store.last = d.last;
      }
    } catch { /* none kept yet */ }
    this.me = null;        // the character whose log is being read, as the game names it (in memory only)
    this.key = null;       // ...scrambled, as it is kept
    this.open = new Map(); // the creatures of the fight you are in: its own name for each -> { mine, others, hp, lv }
    this.fight = null;     // the fight you are in: { start, last, mine, others, dead: [...], level, gap, left }
    this.ended = null;     // when the fight before ended (null: not known, or you died since)
    this.dirty = false; this.savedAt = 0;
    this.counts = { kept: 0, shared: 0, left: 0, old: 0 };
  }

  /** Another log is being read: whose it is, and what they were in the middle of, is not carried over. */
  reset() { this.me = null; this.key = null; this.open.clear(); this.fight = null; this.ended = null; }

  /** One line of the log, as combatlog.js's parseLine has it. */
  line(l) {
    if (!l || !l.at) return;
    if (l.mine && l.mine !== this.me) { this.reset(); this.me = l.mine; this.key = crypto.createHash('sha1').update(l.mine).digest('hex').slice(0, 12); }
    if (!this.me) return;
    // (a fight nobody has struck a blow in for a while was left: the creature ran, or you did)
    if (this.fight && l.at - this.fight.last > QUIET) this.#end(this.fight.last, false);
    const ev = l.event;
    if (ev === 'UNIT_DIED' || ev === 'UNIT_DESTROYED') {
      if (l.dst === this.me) { if (this.fight) this.#end(l.at, false); this.ended = null; return; }
      const c = this.open.get(l.dst);
      if (!c) return;
      this.open.delete(l.dst);
      this.fight.dead.push(c);
      this.fight.last = l.at;
      if (!this.open.size) this.#end(l.at, true);
      return;
    }
    const blow = BLOWS.has(ev);
    if (!blow && !TRIES.has(ev)) return;
    const fromMe = l.src === this.me || ((l.sflags & MINE) !== 0 && (l.sflags & (PET | GUARDIAN)) !== 0);
    const atMe = l.dst === this.me || ((l.dflags & MINE) !== 0 && (l.dflags & (PET | GUARDIAN)) !== 0);
    let guid = null;
    if (fromMe && isCreature(l.dst, l.dflags)) guid = l.dst;
    else if (atMe && isCreature(l.src, l.sflags)) guid = l.src;
    if (guid) {
      const c = this.#join(guid, l.at);
      if (blow && guid === l.dst && l.amount > 0) { c.mine += l.amount; this.fight.mine += l.amount; }
      this.#seen(c, guid, l.unit);
      this.fight.last = l.at;
      return;
    }
    // somebody else's blow at a creature of your fight
    const c = isCreature(l.dst, l.dflags) ? this.open.get(l.dst) : null;
    if (!c) return;
    if (blow && l.amount > 0) { c.others += l.amount; this.fight.others += l.amount; }
    this.#seen(c, l.dst, l.unit);
  }

  /** What the log's row of figures says of a creature: its health and level. */
  #seen(c, guid, unit) {
    if (unit && unit.guid === guid && Number.isFinite(unit.most) && unit.most > 0) { c.hp = unit.most; if (Number.isInteger(unit.level) && unit.level >= 1 && unit.level <= 99) c.lv = unit.level; }
  }

  /** A creature in the fight you are in - a fight begun with it, where you were in none. */
  #join(guid, at) {
    if (!this.fight) {
      // (which level you are is the live link's to say, and only of now: of a line just written)
      const fresh = Math.abs(this.now() - at) < FRESH;
      const level = fresh ? this.level() : null;
      this.fight = { start: at, last: at, mine: 0, others: 0, dead: [], fresh, level: Number.isInteger(level) && level >= 1 ? level : null, gap: this.ended !== null && at - this.ended >= 0 && at - this.ended <= NEXT ? (at - this.ended) / 1000 : null };
    }
    let c = this.open.get(guid);
    if (!c) { c = { mine: 0, others: 0, hp: null, lv: null }; this.open.set(guid, c); }
    return c;
  }

  /** The fight is over. whole: every creature of it is dead (else it was left, or you died). */
  #end(at, whole) {
    const f = this.fight;
    this.fight = null; this.open.clear();
    this.ended = at;
    if (!f) return;
    if (!whole || !f.dead.length) { this.counts.left++; return; }
    const seconds = (at - f.start) / 1000;
    // (the health of what died: where the log never said it, what it took to kill)
    const health = f.dead.reduce((s, c) => s + (c.hp ?? c.mine + c.others), 0);
    const dealt = f.mine + f.others;
    if (f.others > ALONE * dealt || f.mine < MOSTLY * health) { this.counts.shared++; return; }
    if (!(seconds >= SHORTEST && seconds <= LONGEST)) { this.counts.left++; return; }
    if (!f.fresh || f.level === null || !this.key) { this.counts.old++; return; }
    const levels = f.dead.filter((c) => c.lv !== null);
    if (!levels.length) { this.counts.left++; return; }
    const lv = levels.reduce((s, c) => s + c.lv * (c.hp ?? 1), 0) / levels.reduce((s, c) => s + (c.hp ?? 1), 0);
    const who = (this.store.who[this.key] ??= { fights: [], at: 0 });
    who.fights.push({ at, s: round1(seconds), d: Math.round(f.mine), n: f.dead.length, lv: round1(lv), my: f.level, g: f.gap === null ? null : round1(f.gap) });
    if (who.fights.length > KEEP) who.fights.splice(0, who.fights.length - KEEP);
    who.at = at;
    this.store.last = this.key;
    const keys = Object.keys(this.store.who);
    if (keys.length > CHARACTERS) for (const k of keys.sort((a, b) => this.store.who[a].at - this.store.who[b].at).slice(0, keys.length - CHARACTERS)) delete this.store.who[k];
    this.counts.kept++;
    this.dirty = true;
  }

  /** What the page is handed: the fights of the character last played with the log kept. */
  figures() {
    // (the character whose log is being read now - with none kept yet, none: another character's
    // pace is not theirs; with no log read since the map started, the one last fought with)
    const key = this.key ?? this.store.last;
    const who = key ? this.store.who[key] : null;
    return { v: 1, fights: who ? who.fights : [], keep: KEEP, counted: { ...this.counts } };
  }

  save(now = false) {
    if (!this.dirty || (!now && this.now() - this.savedAt < SAVE)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.store));
      this.dirty = false; this.savedAt = this.now();
    } catch (err) { note('combatlog', 'how your fights went could not be kept', { error: err.message }); }
  }
}

// ---- the health the game really gives creatures -----------------------------------------------
// The quest explorer's table has each creature's health from the original game, or - where a
// fight has been logged, by this copy or any other - as this game gives it (the Atlas database
// carries those, and the map is built with them: extractor/atlas.js). The page cannot tell the
// two apart in its table, and the first are too low here (pace.js, healthHere). So it is told
// which creatures have been measured, and at what: from the database as last fetched, and from
// this copy's own log, which is the newer of the two for what you fought today.
let healthKept = null; // { key, of }
export function measuredHealth(dataDir, own = null, rev = 0) {
  const stamp = atlasStamp(dataDir);
  const key = `${stamp?.hash ?? ''}|${rev}`;
  if (healthKept?.key === key) return healthKept.of;
  const of = {};
  try {
    const parts = stamp ? JSON.parse(fs.readFileSync(path.join(dataDir, 'atlasdb', 'truth-npc.json'), 'utf8')) : null;
    for (const part of Object.values(parts ?? {})) {
      for (const [k, r] of Object.entries(part ?? {})) {
        const id = Number(k.slice(1));
        if (Number.isInteger(id) && id > 0 && r && Array.isArray(r.hp) && r.hp[1] > 0 && r.src?.hp === 'l') of[id] = Math.round(((r.hp[0] || r.hp[1]) + r.hp[1]) / 2);
      }
    }
  } catch { /* no database fetched: this copy's own log alone */ }
  for (const [id, by] of Object.entries(own ?? {})) {
    const all = Object.values(by ?? {}).filter((v) => Number.isFinite(v) && v > 0);
    if (all.length) of[id] = Math.round(all.reduce((s, v) => s + v, 0) / all.length);
  }
  healthKept = { key, of };
  return of;
}
