// What you have seen for yourself in the game: where an NPC (or a quest object) really stands,
// noted when you talk to it. Kept in <dataDir>/user/npcs-seen.json, apart from everything the
// map update writes, so it survives every rebuild; the map lays these over the extracted data.
import fs from 'node:fs';
import path from 'node:path';

const SAME = 30; // yards: a sighting of the same NPC this close to an earlier one replaces it

export class SeenStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'user', 'npcs-seen.json');
    this.list = [];
    this.stamp = '';
    this.#sync();
  }

  /** Read the file again if it has changed on disk since it was last read or written (it may be mended by hand). */
  #sync() {
    let stamp = '';
    try { const st = fs.statSync(this.file); stamp = `${st.size}:${st.mtimeMs}`; } catch { /* no file */ }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.list = [];
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.seen)) this.list = d.seen.filter((r) => this.#valid(r));
    } catch { /* nothing seen yet */ }
  }

  #valid(r) {
    return r && Number.isInteger(r.map) && Number.isInteger(r.id) && r.id > 0 && [r.x, r.y, r.z].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 40000);
  }

  all() { this.#sync(); return { version: 1, seen: this.list }; }

  /**
   * Note a sighting: { map, id, object (true for a quest object), x, y, z (where it stands), px, py (where you stood), was (the height the map had before) }.
   * @returns the stored record
   */
  add(input) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    const rec = { map: input.map, id: input.id, object: !!input.object, x: num(input.x), y: num(input.y), z: num(input.z), px: num(input.px), py: num(input.py), was: num(input.was), at: new Date().toISOString() };
    if (!this.#valid(rec)) throw new Error('not a sighting');
    this.#sync();
    this.list = this.list.filter((r) => !(r.map === rec.map && r.id === rec.id && !!r.object === rec.object && Math.hypot(r.x - rec.x, r.y - rec.y) < SAME));
    this.list.push(rec);
    this.#save();
    return rec;
  }

  /** Forget the sightings of one NPC on a map (or, with no id, every sighting). */
  forget(map, id, object) {
    this.#sync();
    const before = this.list.length;
    this.list = id === undefined ? [] : this.list.filter((r) => !(r.map === map && r.id === id && !!r.object === !!object));
    if (this.list.length !== before) this.#save();
    return before - this.list.length;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, seen: this.list }, null, 1));
    fs.renameSync(tmp, this.file);
    try { const st = fs.statSync(this.file); this.stamp = `${st.size}:${st.mtimeMs}`; } catch { /* as it was */ }
  }
}
