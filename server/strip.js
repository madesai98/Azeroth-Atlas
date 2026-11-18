// Decoder for the coded strip the AzerothAtlas addon draws in a corner of the game window (the
// top-left one unless you move it; the reader finds it wherever it is: strip-reader.cs).
// Format (must match addon/AzerothAtlas/AzerothAtlas.lua): squares showing one
// base-8 digit each as a colour (red = 4, green = 2, blue = 1):
//   7 0 7 0 4 2 1     sync pattern + colour check
//   version(1) layout(1) seq(1) flags(6) map(5) x(8) y(8) facing(4) zoneMap(5) level(2) height(6) speed(4) place(5)
//   [party]   4 x ( flags(1) x(7) y(7) )            when layout has 1
//   [target]  kind(1) map(5) x(8) y(8)              when layout has 4 (your current waypoint; version 5.
//                                                   kind: 1 your guide's step, 2 a journey of your own
//                                                   in Shortest Path Forever, 3 a pin on the game's map,
//                                                   4 a quick waypoint: a Shift-click on the game's map)
//   [text]    kind(1) key(2) part(1) 9 bytes(24)    when layout has 2 (names and travel facts, a piece per frame)
//   [fix]     seq(1) 2 x ( kind(1) id(5) h(5) d(4) ) when layout has 8 (version 6, whose layout has two digits:
//                                                   your height as the game measured it - see below)
//   checksum(4)
//   0 7               end marker
// Older versions are still read, so the link keeps working until the addon in the game has been
// updated and reloaded: 3 had flags(3) (nothing about how you are moving), 4 had no waypoint,
// 5 had flags(5), neither speed nor place nor a fix (the map then works your height out without them).
//
// The fix. The game does not say how high you are, but it does say how far you are from a
// flight master or a landmark of its map when its marker is pointed at one, and that distance
// counts height. The addon points the marker at two of them for a frame each, and sends for
// each: kind (1 flight master, 2 landmark; 0 none; 4 more: your spot was had finely, not rounded to a tenth of a yard), id (the game's own number for it), h (how
// far above or below it you are, in 16ths of a yard: what is left of the distance once the way
// across the map is taken off - it does not say which of the two) and d (how far off it is, in
// 8 yards: the further, the less h is worth). seq counts the fixes, 1 to 7 and round again.
export const PROTOCOL = 6;
const HEADER = [7, 0, 7, 0, 4, 2, 1];
const TRAILER = [0, 7];
const FLAG_DIGITS = { 3: 3, 4: 5, 5: 5, 6: 6 }; // by version
const LAYOUT_DIGITS = { 3: 1, 4: 1, 5: 1, 6: 2 };
const BASE = { 3: 41, 4: 41, 5: 41, 6: 51 }, PARTY = 4 * 15, TARGET = 22, TEXT = 28, FIX = 31, CHECK = 4; // BASE excludes the flags
export const MAX_BLOCKS = HEADER.length + BASE[PROTOCOL] + FLAG_DIGITS[PROTOCOL] + PARTY + TARGET + TEXT + FIX + CHECK + TRAILER.length;
export const FIX_KIND = { 1: 'taxi', 2: 'poi' };
// text kinds: a party member's name; speeds and hearthstone; the hearthstone's inn (name, spot); known flight points
export const TEXT_KIND = { QLOG: 0, QDONE: 1, PARTY: 2, STATS: 3, BIND: 4, BINDPOS: 5, FLIGHTS: 6, TALK: 7 };
export const FLAGS = {
  WORLD: 1, ZONE: 2, INSTANCE: 4, DEAD: 8, TAXI: 16, FACING: 32, HEIGHT: 64, INDOORS: 128, HORDE: 256,
  SWIMMING: 512, FALLING: 1024, FLYING: 2048, SUBMERGED: 4096, MOUNTED: 8192,
  JUMPED: 16384, ASCEND: 32768, DESCEND: 65536, SPEED: 131072,
};

/**
 * What the game calls a place - the words over its minimap - as the number the addon sends for
 * it (AzerothAtlas.lua, Place): 1 to 32749, 0 for no words. The map works the same number out
 * for the names of the rooms it knows, and so can tell which of them you stand in.
 */
export function placeNumber(name) {
  const bytes = Buffer.from(String(name ?? ''), 'utf8');
  if (!bytes.length) return 0;
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) % 32749;
  return h + 1;
}

const checksum = (digits, n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum * 31 + digits[i] + 1) % 4093;
  return sum;
};
const dataLength = (version, layout) => BASE[version] + FLAG_DIGITS[version] + (layout & 1 ? PARTY : 0) + (version >= 5 && layout & 4 ? TARGET : 0) + (layout & 2 ? TEXT : 0) + (version >= 6 && layout & 8 ? FIX : 0) + CHECK;

/**
 * Decode one row of screen pixels (RGB bytes, starting at the game window's left edge).
 * Works at any block width (so a UI scale surprise does not break it) and with the game's
 * brightness / contrast / gamma changed (colours are judged relative to the strip's own
 * black and white squares). Never returns data that fails the checksum.
 * @returns {{ok:true, ...}|{ok:false, reason:string}}
 */
export function decodeStrip(px, width) {
  // Black / white reference levels from the start of the strip.
  const span = Math.min(width, 64);
  const lo = [255, 255, 255], hi = [0, 0, 0];
  for (let x = 0; x < span; x++) for (let c = 0; c < 3; c++) {
    const v = px[x * 3 + c];
    if (v < lo[c]) lo[c] = v;
    if (v > hi[c]) hi[c] = v;
  }
  for (let c = 0; c < 3; c++) if (hi[c] - lo[c] < 60) return { ok: false, reason: 'nosignal' };
  const thr = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const digitAt = (x) => (px[x * 3] > thr[0] ? 4 : 0) | (px[x * 3 + 1] > thr[1] ? 2 : 0) | (px[x * 3 + 2] > thr[2] ? 1 : 0);

  // Rough block width from the white-black-white-black sync pattern.
  let x = 0;
  const runs = [];
  for (let k = 0; k < 4; k++) {
    const want = HEADER[k];
    if (x < width && digitAt(x) !== want && x + 1 < width && digitAt(x + 1) === want) x++; // one blended edge pixel
    const start = x;
    while (x < width && digitAt(x) === want) x++;
    const len = x - start;
    if (len < 2 || len > 32) return { ok: false, reason: 'nosignal' };
    runs.push(len);
  }
  const w0 = x / 4;
  if (runs.some((r) => Math.abs(r - w0) > 1.25)) return { ok: false, reason: 'nosignal' };

  // The rough width can be off by a fraction of a pixel, which adds up over a long strip, so
  // try nearby widths (closest first) and take the one whose checksum verifies.
  let firstFailure = null;
  for (let k = 0; k <= 120; k++) {
    const w = w0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.005;
    const r = readAt(digitAt, width, w);
    if (r.ok) return r;
    if (k === 0) firstFailure = r;
  }
  return firstFailure;
}

function readAt(digitAt, width, w) {
  const at = (i) => Math.floor((i + 0.5) * w);
  if (at(HEADER.length + 2) >= width) return { ok: false, reason: 'short' };
  for (let i = 0; i < HEADER.length; i++) if (digitAt(at(i)) !== HEADER[i]) return { ok: false, reason: i < 4 ? 'nosignal' : 'colors' };
  const version = digitAt(at(HEADER.length));
  if (!FLAG_DIGITS[version]) return { ok: false, reason: 'version', version };
  const layout = LAYOUT_DIGITS[version] === 2 ? digitAt(at(HEADER.length + 1)) * 8 + digitAt(at(HEADER.length + 2)) : digitAt(at(HEADER.length + 1));
  const n = dataLength(version, layout);
  const total = HEADER.length + n + TRAILER.length;
  if (at(total - 1) >= width) return { ok: false, reason: 'short' };
  for (let i = 0; i < TRAILER.length; i++) if (digitAt(at(HEADER.length + n + i)) !== TRAILER[i]) return { ok: false, reason: 'covered' };
  const d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = digitAt(at(HEADER.length + i));
  let p = n - CHECK;
  const take = (count) => { let v = 0; for (let i = 0; i < count; i++) v = v * 8 + d[p++]; return v; };
  if (take(CHECK) !== checksum(d, n - CHECK)) return { ok: false, reason: 'checksum' };

  p = 1 + LAYOUT_DIGITS[version];
  const seq = take(1), flags = take(FLAG_DIGITS[version]), map = take(5), rx = take(8), ry = take(8), rf = take(4), zone = take(5), level = take(2), rz = take(6);
  // (since version 6) how fast the game says you move, and what it calls the place you stand in
  const rs = version >= 6 ? take(4) : 0, place = version >= 6 ? take(5) : null;
  // How you are moving: only the current addon reports it (null = not known).
  const moving = version >= 4 ? (bit) => !!(flags & bit) : () => null;
  const newer = version >= 6 ? (bit) => !!(flags & bit) : () => null;
  const out = {
    ok: true, version, seq, map, zone, level, blockWidth: Math.round(w * 100) / 100, blocks: total,
    swimming: moving(FLAGS.SWIMMING), falling: moving(FLAGS.FALLING), flying: moving(FLAGS.FLYING), submerged: moving(FLAGS.SUBMERGED), mounted: moving(FLAGS.MOUNTED),
    // jumped: the time in the air began with a jump; ascend / descend: the key that takes you up / down is held (in water);
    // speed: yards a second, as the game has it (null: it does not say); place: the number of the place's name (0: no name)
    jumped: newer(FLAGS.JUMPED), ascend: newer(FLAGS.ASCEND), descend: newer(FLAGS.DESCEND),
    speed: version >= 6 && flags & FLAGS.SPEED ? rs / 32 : null, place,
    mode: flags & FLAGS.WORLD ? 'world' : flags & FLAGS.ZONE ? 'zone' : 'none',
    x: null, y: null,
    z: flags & FLAGS.HEIGHT ? rz / 8 - 8192 : null, // null when the game does not report a height
    facing: flags & FLAGS.FACING ? (rf / 4096) * 2 * Math.PI : null, // radians, 0 = north, counter-clockwise
    inInstance: !!(flags & FLAGS.INSTANCE), dead: !!(flags & FLAGS.DEAD), taxi: !!(flags & FLAGS.TAXI), indoors: !!(flags & FLAGS.INDOORS),
    faction: flags & FLAGS.HORDE ? 'horde' : 'alliance',
    party: [], target: null, text: null, fix: null,
  };
  if (out.mode === 'world') { out.x = rx / 128 - 32768; out.y = ry / 128 - 32768; }
  else if (out.mode === 'zone') { out.x = rx / 16777215; out.y = ry / 16777215; }
  if (layout & 1) {
    for (let slot = 1; slot <= 4; slot++) {
      const f = take(1), mx = take(7), my = take(7);
      if (f & 1) out.party.push({ slot, x: f & 2 ? mx / 16 - 32768 : null, y: f & 2 ? my / 16 - 32768 : null, dead: !!(f & 4) });
    }
  }
  if (version >= 5 && layout & 4) {
    // where you are heading (kind 1: your guide's current step, 3: a pin on the game's map), in world coordinates
    const kind = take(1), tmap = take(5), tx = take(8), ty = take(8);
    out.target = { kind, map: tmap, x: tx / 128 - 32768, y: ty / 128 - 32768 };
  }
  if (layout & 2) {
    const kind = take(1), key = take(2), part = take(1);
    const bytes = [];
    for (let g = 0; g < 3; g++) { const v = take(8); bytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255); }
    out.text = { kind, key, part: part & 3, last: !!(part & 4), bytes };
  }
  if (version >= 6 && layout & 8) {
    // your height as the game measured it (see the top of this file): how far above or below two places of its map you are
    const fseq = take(1), refs = [];
    for (let k = 0; k < 2; k++) {
      const kind = take(1), id = take(5), h = take(5), dq = take(4);
      if (FIX_KIND[kind & 3]) refs.push({ kind: FIX_KIND[kind & 3], id, h: h / 16, d: dq * 8, fine: !!(kind & 4) });
    }
    if (fseq && refs.length) out.fix = { seq: fseq, refs };
  }
  return out;
}

/**
 * Reassembles what arrives a few bytes per frame through the strip's text channel: party
 * members' names, and the travel facts (speeds, hearthstone, known flight points).
 */
export class NameCache {
  constructor() { this.names = new Map(); this.parts = new Map(); this.raw = new Map(); }
  add(t) {
    if (!t) return;
    const id = `${t.kind}:${t.key}`;
    let p = this.parts.get(id);
    if (!p || t.part === 0) { p = []; this.parts.set(id, p); }
    if (p.length !== t.part) { this.parts.delete(id); return; } // missed a piece; wait for the next round
    p.push(t.bytes);
    if (!t.last) return;
    const bytes = p.flat();
    this.raw.set(id, Buffer.from(bytes)); // as sent (padded with zeros to a multiple of 9 bytes)
    while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
    this.names.set(id, Buffer.from(bytes).toString('utf8'));
    this.parts.delete(id);
  }
  party(slot) { return this.names.get(`2:${slot}`) ?? null; }

  /**
   * Your quests, as far as they have arrived: { log: [{ id, state (0 in progress, 1 ready to hand
   * in, 2 failed) }] | null, done: [quest ids] | null, sig }. Each list comes in pieces that
   * name the edition they belong to; a list is replaced only when every piece of a newer
   * edition is in, so what is returned is always one whole list as the game had it.
   */
  quests() {
    const l0 = this.raw.get(`${TEXT_KIND.QLOG}:0`);
    if (l0 && l0.length >= 2) {
      const gen = l0[0], count = l0[1], list = [];
      let whole = true;
      for (let chunk = 0; chunk < Math.max(1, Math.ceil(count / 11)); chunk++) {
        const b = this.raw.get(`${TEXT_KIND.QLOG}:${chunk}`);
        if (!b || b[0] !== gen || b[1] !== count) { whole = false; break; }
        for (let i = 2; i + 2 < b.length && list.length < count; i += 3) { const v = b[i] * 65536 + b[i + 1] * 256 + b[i + 2]; list.push({ id: v >> 2, state: v & 3 }); }
      }
      if (whole && list.length === count) this.log = { gen, list };
    }
    const d0 = this.raw.get(`${TEXT_KIND.QDONE}:0`);
    if (d0 && d0.length >= 2) {
      const gen = d0[0], n = d0[1], pieces = [];
      for (let chunk = 0; chunk < n; chunk++) {
        // (the first 64 pieces have a kind to themselves; the rest share the quest log's, from key 8)
        const b = this.raw.get(chunk < 64 ? `${TEXT_KIND.QDONE}:${chunk}` : `${TEXT_KIND.QLOG}:${chunk - 64 + 8}`);
        if (!b || b[0] !== gen || b[1] !== n) break;
        pieces.push(b.subarray(2, 36));
      }
      if (n > 0 && pieces.length === n) {
        // each quest is the step up from the one before, in 7-bit pieces, lowest first; a zero ends the list
        const ids = [];
        let id = 0, step = 0, scale = 1;
        read: for (const piece of pieces) for (const byte of piece) {
          if (byte === 0 && scale === 1) break read;
          step += (byte & 127) * scale;
          if (byte & 128) scale *= 128;
          else { id += step; ids.push(id); step = 0; scale = 1; }
        }
        this.done = { gen, ids };
      }
    }
    return { log: this.log?.list ?? null, done: this.done?.ids ?? null, sig: `${this.log?.gen ?? '-'}.${this.log?.list.length ?? '-'}.${this.done?.gen ?? '-'}.${this.done?.ids.length ?? '-'}` };
  }

  /**
   * The NPC (or quest object) whose window you last opened in the game, or the creature you
   * last fought (an addon of version 25 or later says that too), or null:
   * { id, seq (goes up by one with each new meeting), object (true for a quest object), fight
   *   (true for a creature you fought: you looted it, or it was within ten yards of you, dead
   *   or on you), age (seconds since, as the game counted) }
   */
  talk() {
    const b = this.raw.get(`${TEXT_KIND.TALK}:0`);
    if (!b || b.length < 6) return null;
    const id = b[0] * 65536 + b[1] * 256 + b[2];
    return id > 0 && b[3] > 0 ? { id, seq: b[3], object: b[4] === 1, fight: b[4] === 2, age: b[5] } : null;
  }

  /**
   * The addon's account of its route mailboxes (see mail.js), or null from an addon that has none:
   * { session (changes with every /reload), next (the mailbox it opens next), size (how many it
   *   found), have (the delivery it last read), flags (1 a route is drawn, 2 waiting for one,
   *   4 given up on this waypoint, 8 nobody is writing) }
   */
  mail() {
    const b = this.raw.get(`${TEXT_KIND.TALK}:1`);
    if (!b || b.length < 9 || b[8] !== 1) return null;
    return { session: b[0], next: b[1] * 256 + b[2], size: b[3] * 256 + b[4], have: b[5] * 256 + b[6], flags: b[7] };
  }

  /**
   * The level you chose in the game for a waypoint with more than one under it, or null:
   * { id (the list of levels the choice is from, as the map page numbered it), index (which of
   *   them, from 1), seq (goes up with every choice made), session (which /reload of the game) }
   */
  choice() {
    const b = this.raw.get(`${TEXT_KIND.TALK}:2`);
    if (!b || b.length < 6 || b[4] !== 1 || !b[2]) return null;
    return { id: b[0] * 256 + b[1], index: b[2], seq: b[3], session: b[5] };
  }

  /**
   * Every place you could be heading for, each said on its own (addon version 6), or null from
   * an addon that names only the one that leads: { guide, waypoint, corpse: { map, x, y } | null
   * (your guide's step; the newest waypoint you placed yourself; your body while you are a ghost),
   * quest: the number of the quest you are tracking (0: none),
   * tracked: how far that quest has got, as the game's own list of what it asks for has it -
   *   { id, state (0 under way, 1 ready to hand in, 2 failed), n (how many things it asks for),
   *     done (which of them are done: a bit each, the first the lowest), kinds: [of each: 1 a
   *     creature, 2 an item, 3 an object, 0 anything else] } - or null where the game (or an
   *     addon from before) does not say }
   */
  heads() {
    const spot = (key) => {
      const b = this.raw.get(`${TEXT_KIND.TALK}:${key}`);
      if (!b || b.length < 9 || !(b[0] & 128)) return undefined;
      return b[0] & 1 ? { map: b[1] * 256 + b[2], x: (b[3] * 65536 + b[4] * 256 + b[5]) / 128 - 32768, y: (b[6] * 65536 + b[7] * 256 + b[8]) / 128 - 32768 } : null;
    };
    const guide = spot(3), waypoint = spot(4), corpse = spot(5);
    const q = this.raw.get(`${TEXT_KIND.TALK}:6`);
    const quest = q && q.length >= 9 && q[0] & 128 && q[8] === 1 ? (q[0] & 1 ? q[1] * 65536 + q[2] * 256 + q[3] : 0) : undefined;
    if (guide === undefined && waypoint === undefined && corpse === undefined && quest === undefined) return null;
    let tracked = null;
    if (quest && q[0] & 2) {
      const n = Math.min(8, q[4] >> 2), kinds = q[6] * 256 + q[7];
      tracked = { id: quest, state: q[4] & 3, n, done: q[5] & (2 ** n - 1), kinds: Array.from({ length: n }, (_, k) => (kinds >> (k * 2)) & 3) };
    }
    return { guide: guide ?? null, waypoint: waypoint ?? null, corpse: corpse ?? null, quest: quest ?? 0, tracked };
  }

  /**
   * When the boats, zeppelins and tram run, as far as the addon knows (Transit.lua), or null
   * before it has said: { clock (the game server's time minus this computer's, in ms), lines:
   * { [the line's number in transit.json]: null (too unsure to name a moment by) or
   *   { src (what it rests on: 'clock' the server's clock alone, 'own' your ride, 'dw' / 'ft' /
   *     'nau' / 'tv' other players, by way of DockWatch, ForeverTransport, Nauticus or Azeroth
   *     Tripview), leaves (server time, seconds: a moment a craft
   *     leaves the line's first stop), gap (how far the time from one craft to the next is off
   *     the measured one, seconds), unsure (seconds), lane (the tram track of that departure: 1,
   *     2 or null), age (when it was last seen: 0 under ten minutes ago, 1 under an hour, 2 under
   *     six, 3 longer) } } }
   */
  transit() {
    const c = this.raw.get(`${TEXT_KIND.TALK}:8`);
    if (!c || c.length < 9 || c[0] !== 128 || c[8] !== 1) return null;
    const u40 = (b, o) => b[o] * 4294967296 + b[o + 1] * 16777216 + b[o + 2] * 65536 + b[o + 3] * 256 + b[o + 4];
    const lines = {};
    for (let n = 1; n <= 48; n++) {
      const b = this.raw.get(`${TEXT_KIND.TALK}:${15 + n}`);
      if (!b || b.length < 9) continue;
      if (!(b[0] & 128)) { if (b[0] === 64) lines[n] = null; continue; }
      lines[n] = {
        src: [null, 'own', 'dw', 'ft', 'nau', 'clock', 'tv'][b[0] & 7] ?? null, leaves: u40(b, 1) / 100, gap: (b[6] * 256 + b[7] - 32768) / 1000, unsure: b[8] / 10,
        lane: b[0] & 8 ? (b[0] & 16 ? 2 : 1) : null, age: (b[0] >> 5) & 3,
      };
    }
    return { clock: u40(c, 1) - 549755813888, lines };
  }

  /**
   * The travel facts received so far, or null before the first of them:
   * { run, swim (yards per second; 0 = not reported), hearth: { has, avoid (you have said in the
   *   game that routes are to leave it out), cooldown (seconds), name, map, x, y }, flights: [taxi node ids] | null }
   */
  travel() {
    const s = this.raw.get(`${TEXT_KIND.STATS}:0`);
    if (!s || s.length < 9) return null;
    const u16 = (b, o) => b[o] * 256 + b[o + 1], u24 = (b, o) => b[o] * 65536 + b[o + 1] * 256 + b[o + 2];
    const count = u16(s, 7);
    const cooldown = u16(s, 4);
    const out = { run: u16(s, 0) / 100, swim: u16(s, 2) / 100, hearth: { has: !!(s[6] & 1), avoid: !!(s[6] & 2), cooldown: cooldown === 65535 ? null : Math.ceil(cooldown / 5) * 5, name: this.names.get(`${TEXT_KIND.BIND}:0`) ?? null, map: null, x: null, y: null }, flights: null };
    const pos = this.raw.get(`${TEXT_KIND.BINDPOS}:0`);
    if (pos && pos.length >= 9 && pos[8]) { out.hearth.map = u16(pos, 0); out.hearth.x = u24(pos, 2) / 128 - 32768; out.hearth.y = u24(pos, 5) / 128 - 32768; }
    // the flight points arrive 18 to a message; the list is known once every message is in
    const ids = [];
    for (let chunk = 0; chunk < Math.ceil(count / 18); chunk++) {
      const b = this.raw.get(`${TEXT_KIND.FLIGHTS}:${chunk}`);
      if (!b) return out;
      for (let i = 0; i + 1 < b.length; i += 2) { const id = u16(b, i); if (id) ids.push(id); }
    }
    out.flights = ids.slice(0, count);
    return out;
  }
}
