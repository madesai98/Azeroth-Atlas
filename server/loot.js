// What was in the corpses you loot, as the addon says it through the strip the moment it
// happens - kept here until it has gone to the Atlas database.
//
// The addon counts what creatures give (addon/AzerothAtlas/Drops.lua): of each creature how many
// corpses you looted, and in how many of them each thing was. It keeps the count in the game's
// saved settings - which the game writes only when you log out, leave or /reload. So that the
// count need not wait for that, the addon also says each creature's figures through the strip
// when they change (strip.js, readLoot): which game's settings they are of (a made-up number),
// the creature, its corpses, and up to three things with their figures.
//
// Every figure only ever grows, so what is said is taken figure by figure where it is larger
// than what was known; said twice, or late, it changes nothing. Kept in <dataDir>/user/loot.json:
//
//   { "v": 1, "by": { "<the settings' number>": { "<creature>": { "n": corpses, "got": { "<item>": in how many },
//                                                                "on": { "<item>": [in how many, of how many] } } } } }
//
// The map's own program for the database (atlasdb/collect.js) reads this file beside the saved
// settings, takes the larger of the two for each figure, and sends what has grown. Nothing of
// you is in it: creatures, items and numbers.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { lootHeard, plain, largerLoot } from '../atlasdb/loot.js';

const SAVE_AFTER = 3000; // ms: several things said in a row are written once

export class LootStore {
  /** @param onNew () => called when something larger than what was known has been said */
  constructor(dataDir, { onNew = null } = {}) {
    this.file = path.join(dataDir, 'user', 'loot.json');
    this.dataDir = dataDir;
    this.onNew = onNew;
    this.by = lootHeard(dataDir); // Map<tag, Map<creature, { n, got: Map, on: Map }>>
    this.timer = null;
    this.heardCount = 0;
    this.news = 0;
  }

  /**
   * One message of the strip, as readLoot gives it: { tag, creature, n, items: [[item, k, t]] }
   * (t 0: a thing that drops for anybody - in k of the n corpses; else: in k of t corpses looted
   * while a quest wanted it). @returns true where it said something new
   */
  heard(said) {
    if (!said) return false;
    this.heardCount++;
    const now = { n: said.n, got: new Map(), on: new Map() };
    for (const [item, k, t] of said.items) {
      if (t > 0) now.on.set(item, [Math.min(k, t), t]);
      else if (k > 0) now.got.set(item, Math.min(k, said.n));
    }
    let mine = this.by.get(said.tag);
    if (!mine) this.by.set(said.tag, (mine = new Map()));
    const had = mine.get(said.creature);
    const both = largerLoot(had, now);
    if (had && same(had, both)) return false;
    mine.set(said.creature, both);
    this.news++;
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.save(); }, SAVE_AFTER); this.timer.unref?.(); }
    try { this.onNew?.(said); } catch { /* its own affair */ }
    return true;
  }

  save() {
    const by = {};
    for (const [tag, creatures] of this.by) {
      by[tag] = {};
      for (const [creature, rec] of creatures) by[tag][creature] = plain(rec);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify({ v: 1, by }));
    } catch { /* tried again with the next thing said */ }
  }

  /** How much is kept: { settings, creatures, corpses }. */
  status() {
    let creatures = 0, corpses = 0;
    for (const of of this.by.values()) for (const rec of of.values()) { creatures++; corpses += rec.n; }
    return { settings: this.by.size, creatures, corpses, heard: this.heardCount, news: this.news };
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.save(); }
  }
}

function same(a, b) {
  if (a.n !== b.n || a.got.size !== b.got.size || a.on.size !== b.on.size) return false;
  for (const [item, k] of a.got) if (b.got.get(item) !== k) return false;
  for (const [item, [k, t]] of a.on) { const o = b.on.get(item); if (!o || o[0] !== k || o[1] !== t) return false; }
  return true;
}
