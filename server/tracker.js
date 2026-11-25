// Live player link. Starts a tiny screen-reader helper (server/strip-reader.cs) that watches the
// coded strip the AzerothAtlas addon draws in the game window (finding it in whichever corner
// it has been put), decodes it, and streams the result to the viewer. The helper only runs
// while a map page is listening.
//
// The same helper hands over the small square of the game's picture the minimap is in, while it
// is asked to (look): inside a dungeon, where the game hides where you are, the minimap is what
// shows it (minimap.js, which is told of every reading of the strip and of every such square).
// And the dots on that minimap - what you track, your target, your pet - are read off the same
// square, wherever you are (dots.js, told and handed the same).
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeStrip, NameCache, MAX_BLOCKS, TEXT_KIND, LOOT_KEY, readLoot } from './strip.js';
import { note, changed } from './log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'strip-reader.cs');
const BUILD_DIR = path.join(HERE, '.build');
const ROW = 2;                         // pixel row inside the 6 px tall strip
const WIDTH = MAX_BLOCKS * 6 + 80;     // room for squares up to 1.5x their intended width
const LOST_AFTER_MS = 700;             // nothing readable for this long = signal lost
const WHERE_EVERY = 30000;             // how often where you are is noted (log.js), while the game is heard from
const READS_EVERY = 60000;             // ...and how the reading of the strip has gone, where some of it could not be read

/** Compile the helper with the C# compiler that is part of Windows (no downloads, no installs). */
export function ensureReader() {
  const source = fs.readFileSync(SOURCE);
  const hash = crypto.createHash('sha1').update(source).digest('hex');
  // Named after the source it is built from, so a helper built from an older source that is
  // still running (Windows will not let its file be replaced) is never in the way of a new one.
  const EXE = path.join(BUILD_DIR, `strip-reader-${hash.slice(0, 12)}.exe`);
  if (fs.existsSync(EXE)) return EXE;
  const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('The Windows C# compiler (csc.exe) was not found; the player link needs the .NET Framework 4.');
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const fresh = EXE + '.new';
  const base = ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${fresh}`, '/r:System.Drawing.dll'];
  // Window capture (Windows.Graphics.Capture) is described by metadata files that are part of
  // Windows 10 and 11. If this Windows cannot build it, build the screen-only reader instead.
  const win = process.env.WINDIR ?? 'C:\\Windows';
  const meta = path.join(win, 'System32', 'WinMetadata');
  const framework = path.dirname(csc);
  const capture = ['/define:WGC', '/nowarn:1701,1702',
    ...['Windows.Graphics.winmd', 'Windows.Foundation.winmd', 'Windows.Security.winmd'].map((f) => `/r:${path.join(meta, f)}`),
    ...['System.Runtime.dll', 'System.Runtime.WindowsRuntime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll', 'System.Threading.Tasks.dll'].map((f) => `/r:${path.join(framework, f)}`)];
  try {
    execFileSync(csc, [...base, ...capture, SOURCE], { windowsHide: true, stdio: 'pipe' });
  } catch {
    execFileSync(csc, [...base, SOURCE], { windowsHide: true, stdio: 'pipe' });
  }
  fs.renameSync(fresh, EXE);
  // Tidy up helpers built from older sources (one that is still running stays until it is not).
  for (const f of fs.readdirSync(BUILD_DIR)) {
    if (!/^strip-reader.*\.(exe|hash|new)$/.test(f) || path.join(BUILD_DIR, f) === EXE) continue;
    try { fs.unlinkSync(path.join(BUILD_DIR, f)); } catch { /* in use */ }
  }
  return EXE;
}

export class PlayerTracker {
  /** @param opts { processNames?: string[], pathHint?: string, intervalMs?: number, fixed?: [x, y] } */
  constructor(opts = {}) {
    // (intervalMs: how long the helper waits between two looks at the strip. The addon draws a new
    // piece of what it has to say every 50 ms or so, and a piece the helper misses spoils the
    // message it is part of until that comes round again. Windows hands the helper a picture of
    // the game every 20 ms at most (strip-reader.cs), and a wait of 15 - one step of Windows'
    // clock, 15.6 ms - is shorter than that: no picture is passed over. Measured on the game on
    // 21 Nov 2026, twenty seconds each: at 55 ms 91 pieces drawn and never seen, at 25 ms 23, at
    // 15 none; the helper then takes 2.3% of one processor core, against 1.3% at 55.)
    this.opts = { processNames: ['Wow'], pathHint: '', intervalMs: 15, fixed: null, ...opts };
    this.clients = new Set();
    this.child = null;
    this.stopTimer = null;
    this.names = new NameCache();
    this.lastGood = 0;
    this.pending = null;
    this.state = { status: 'off', reason: null, window: null, capture: null, player: null, party: [], target: null, travel: null, transit: null, talk: null, quests: null, mail: null, dots: [], tracking: null };
    this.mail = opts.mail ?? null; // the route's way into the game (mail.js), told what the addon says of it
    this.talk = null; // the last NPC you met in the game (or creature you fought), with when this server first heard of it
    this.quests = { rev: 0, log: null, done: null, me: null }; // your quest log, the quests you have done, and who your character is (see /api/player/quests)
    this.questSig = '';
    this.sent = '';
    this.reads = { ok: 0, bad: {}, since: Date.now(), first: true }; // how reading the strip has gone, for the notes (log.js)
    this.whereAt = 0;
    // What finds you on the game's minimap inside a dungeon (minimap.js; server.js sets it): told
    // what the strip says (heard), handed the squares of the picture it asks for (crop), told when
    // the game is no longer heard from (quiet).
    this.eyes = null;
    this.square = null;   // the square of the game's picture the helper is asked for: [x, y, w, h, every ms] - or null
    this.squares = 0;     // how many have come
    // What reads the dots off the same square (dots.js; server.js sets it): told and handed what the eyes are.
    this.dots = null;
    this.asked = { place: null, dots: null }; // the square each of the two asks for
    // What keeps the count of what was in the corpses you loot (loot.js; server.js sets it): told each message of it.
    this.loot = null;
  }

  // ---- subscribers (server-sent events) ---------------------------------------------------
  subscribe(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    if (this.clients.size === 1) note('link', 'a map page is listening');
    clearTimeout(this.stopTimer);
    if (!this.child) this.#start();
    res.write(`data: ${JSON.stringify(this.state)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
      // Nobody is looking at the map any more: stop watching the screen.
      if (!this.clients.size) { note('link', 'no map page is listening any more'); this.stopTimer = setTimeout(() => this.stop(), 8000); }
    });
  }

  #publish() {
    const json = JSON.stringify(this.state);
    if (json === this.sent) return;
    this.sent = json;
    for (const res of this.clients) res.write(`data: ${json}\n\n`);
  }

  #set(patch) {
    Object.assign(this.state, patch);
    // (the game no longer heard from: its minimap is no longer looked at)
    if (this.state.status !== 'live' && 'status' in patch) {
      try { this.eyes?.quiet(); } catch { /* its own affair */ }
      try { this.dots?.quiet(); } catch { /* its own affair */ }
      this.state.dots = []; // (dots are of the moment: none are shown from before the game went quiet)
    }
    // (the route mailboxes are only kept filled while the game is being heard from)
    if (this.mail) {
      this.mail.setLive(this.state.status === 'live');
      this.state.mail = this.mail.status();
    }
    const s = this.state;
    if (changed('link', [s.status, s.reason, s.capture])) note('link', `${s.status}${s.reason ? `: ${s.reason}` : ''}`, { capture: s.capture, window: s.window, strip: s.strip ?? null });
    this.#publish();
  }

  /**
   * Where you are, as something other than the strip says it. Inside a dungeon the game tells
   * the addon which dungeon and nothing of where; its combat log does say where, with every
   * blow of yours (combatlog.js). Handed to the page beside what the strip says: { map, x, y,
   * facing (or null), t (when the game wrote it, ms), from: 'log' }.
   */
  placed(fix) {
    // (band: from the minimap - the heights the rooms you may be in span, lowest and highest, where it can tell)
    // (guess: the minimap had something over it - where you would have got to going on as you were)
    this.#set({ placed: fix ? { map: fix.map, x: fix.x, y: fix.y, facing: fix.facing ?? null, t: fix.at, from: fix.from ?? 'log', ...(fix.band ? { band: fix.band } : {}), ...(fix.guess ? { guess: true } : {}) } : null });
  }

  /** How finding you on the minimap is going (minimap.js), for the page to say. */
  minimapState(brief) {
    this.#set({ minimap: brief });
  }

  /**
   * Ask the helper for a square of the game's picture - the one the minimap is in - every so
   * many milliseconds, or (null) for none. [x, y, w, h], counted from the top left corner of
   * the area the game draws in.
   * Two ask (who): what finds you inside a dungeon ('place'), and what reads the minimap's dots
   * ('dots'). One square is sent for both: where both ask, the one for finding you - it has the
   * minimap's rim on it, and the dots are inside the rim - as often as the keener of the two
   * wants it.
   */
  look(square, every = 200, who = 'place') {
    this.asked[who] = square ? [...square.map(Math.round), every] : null;
    const a = this.asked.place ?? this.asked.dots;
    this.square = a ? [...a.slice(0, 4), Math.min(...Object.values(this.asked).filter(Boolean).map((q) => q[4]))] : null;
    this.#ask();
  }

  /** The dots of the minimap as they are to be shown, and what is tracked (dots.js) - whatever goes wrong there must not stop the link. */
  #dotsNow() {
    try { return { dots: this.dots?.list() ?? [], tracking: this.dots?.tracking() ?? null }; } catch (err) { if (changed('dots list', err.message)) note('dots', 'the dots could not be told', { error: err.message }); return { dots: [], tracking: null }; }
  }

  #ask() {
    const pipe = this.child?.stdin;
    if (!pipe || pipe.destroyed || !pipe.writable) return;
    try { pipe.write(this.square ? `M ${this.square.join(' ')}\n` : 'M off\n'); } catch { /* the helper is going: asked again when it is back */ }
  }

  /** The route mailboxes have something new to say (the map page sent a route). */
  mailChanged() {
    if (this.mail) this.#set({});
  }

  // ---- helper process ----------------------------------------------------------------------
  #start() {
    let exe;
    try { exe = ensureReader(); } catch (err) { note('link', 'the helper that reads the game window could not be built', { error: String(err.message).slice(0, 1500), output: String(err.stdout ?? '').slice(0, 1500) }); this.#set({ status: 'error', reason: err.message.split('\n')[0] }); return; }
    const o = this.opts;
    const args = [o.processNames.join(','), o.pathHint || '-', String(process.pid), String(WIDTH), String(ROW), String(o.intervalMs)];
    if (o.fixed) args.push(String(o.fixed[0]), String(o.fixed[1]));
    this.#set({ status: 'starting', reason: null });
    // (its input: what it is asked for besides the strip - see look)
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => { /* the helper has gone: said by its ending */ });
    this.#ask();
    note('link', 'watching for the game', { helper: path.basename(exe), looksFor: o.processNames, in: o.pathHint || null, every: o.intervalMs, fixed: o.fixed });
    this.reads = { ok: 0, bad: {}, since: Date.now(), first: true };
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(line));
    // (what the helper has to say for itself when something is wrong with it)
    let grumble = '';
    child.stderr.on('data', (c) => { grumble = (grumble + c).slice(-1500); });
    child.on('error', (err) => { note('link', 'the helper could not be started', { error: err.message }); if (this.child === child) { this.child = null; this.#set({ status: 'error', reason: err.message }); } });
    child.on('exit', (code, signal) => {
      if (this.child === child || grumble) note('link', 'the helper stopped', { code, signal, said: grumble || undefined, meant: this.child !== child });
      if (this.child !== child) return;
      this.child = null;
      if (!this.clients.size) return;
      this.#set({ status: 'error', reason: 'screen reader stopped' });
      setTimeout(() => { if (this.clients.size && !this.child) this.#start(); }, 3000);
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    try { this.eyes?.quiet(); } catch { /* its own affair */ }
    try { this.dots?.quiet(); } catch { /* its own affair */ }
    child?.kill();
    if (child) note('link', 'the game is no longer watched (no map page is open)');
    changed('link', 'off');
    this.state = { ...this.state, status: 'off', reason: null };
    this.mail?.setLive(false);
    this.sent = '';
  }

  /** How reading the strip goes: the first reading, and from then on whatever could not be read. */
  #noteReads(d) {
    const r = this.reads, now = Date.now();
    if (d.ok) {
      r.ok++;
      if (r.first) { r.first = false; note('link', 'the strip is read', { addonSpeaks: d.version, squareWidth: d.blockWidth, squares: d.blocks }); }
    } else r.bad[d.reason] = (r.bad[d.reason] ?? 0) + 1;
    if (now - r.since < READS_EVERY) return;
    if (Object.keys(r.bad).length) note('link', 'readings of the strip in the last minute', { read: r.ok, not: r.bad });
    r.ok = 0; r.bad = {}; r.since = now;
  }

  /** What the game says of you, noted where it has changed (and where you are, now and then). */
  #noteGame(d, player) {
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
    const spot = (s) => (s ? [s.map, round(s.x), round(s.y)] : null);
    const now = Date.now();
    // (looked at four times a second, not with every reading: what has changed is still so a moment later)
    if (now - (this.notedAt ?? 0) < 250) return;
    this.notedAt = now;
    const where = { map: player.map, mode: player.mode, zone: player.zone, level: player.level, dead: player.dead, taxi: player.taxi, inInstance: player.inInstance, faction: player.faction };
    if (changed('where', where) || now - this.whereAt > WHERE_EVERY) {
      this.whereAt = now;
      note('game', 'you are at', { ...where, x: round(player.x), y: round(player.y), z: round(player.z), facing: round(player.facing), indoors: player.indoors, swimming: player.swimming || undefined, falling: player.falling || undefined, flying: player.flying || undefined, mounted: player.mounted || undefined });
    }
    const target = d.target ? { kind: d.target.kind, at: spot(d.target) } : null;
    if (changed('target', target)) note('game', target ? `the game heads for a waypoint (kind ${target.kind}: 1 guide, 2 journey, 3 pin, 4 quick)` : 'the game has no waypoint', target ?? undefined);
    const h = this.names.heads();
    if (changed('heads', h)) note('game', 'what you could be heading for', h ? { guide: spot(h.guide), waypoint: spot(h.waypoint), corpse: spot(h.corpse), quest: h.quest, tracked: h.tracked } : { said: false });
    // (of a quest that is part done, which of the things it asks for are done: "4281:0 (1 of 3 done: 100)" - the first of three)
    if (changed('quests', this.quests.rev)) note('game', 'your quest log', { rev: this.quests.rev, log: this.quests.log?.map((q) => `${q.id}:${q.state}${q.goals ? ` (${q.goals.kinds.filter((_, k) => (q.goals.done >> k) & 1).length} of ${q.goals.n} done: ${q.goals.kinds.map((_, k) => (q.goals.done >> k) & 1).join('')})` : ''}`) ?? null, done: this.quests.done?.length ?? null,
      // (who your character is, as far as the addon says: what a quest's requirements are held against)
      you: this.quests.me ? { class: this.quests.me.class, race: this.quests.me.race, professions: this.quests.me.skills?.filter((s) => s[1] || s[2]).map((s) => `${s[0]}:${s[1]}/${s[2]}`) ?? null, standingsKnown: this.quests.me.reps?.filter((r) => r[1] !== null).length ?? null, spellsKnown: this.quests.me.spells?.filter((s) => s[1]).length ?? null } : null });
    const t = this.names.travel();
    const travel = t ? { hearth: { has: t.hearth.has, avoid: t.hearth.avoid, ready: t.hearth.cooldown === 0, known: t.hearth.cooldown !== null, name: t.hearth.name, spot: t.hearth.x === null ? null : [t.hearth.map, round(t.hearth.x), round(t.hearth.y)] }, flights: t.flights ? t.flights.length : null } : null;
    if (changed('travel', travel)) note('game', 'how you can travel', travel ? { ...travel, run: t.run, swim: t.swim, cooldown: t.hearth.cooldown, flightPoints: t.flights } : { said: false });
    const choice = this.names.choice();
    if (changed('choice', choice) && choice) note('game', 'you chose a level in the game', choice);
    const transit = this.names.transit();
    if (changed('transit', transit ? Object.keys(transit.lines).filter((n) => transit.lines[n]).join(',') : null)) note('game', 'boats, zeppelins and the tram: the lines whose times are known', transit ? { clock: transit.clock, lines: Object.fromEntries(Object.entries(transit.lines).filter(([, l]) => l).map(([n, l]) => [n, `${l.src} ±${l.unsure}s`])) } : { said: false });
  }

  #line(line) {
    if (line.startsWith('S ')) {
      const [kind, ...rest] = line.slice(2).split(' ');
      if (kind === 'nowindow') this.#set({ status: 'nogame', reason: null, window: null });
      else if (kind === 'minimized') this.#set({ status: 'minimized', reason: null });
      else if (kind === 'window') { const [x, y, w, h] = rest.map(Number); this.#set({ window: { x, y, w, h } }); }
      else if (kind === 'capturefailed') this.#set({ status: 'error', reason: 'could not read the screen' });
      // How the helper is looking: 'window' = the game window's own picture (works with other
      // windows in front), 'screen' = that spot of the screen (needs the game's corner uncovered).
      else if (kind === 'method') this.#set({ capture: rest[0] });
      // Where the strip was found, counted from the corner of the area the game draws in (0, 0:
      // the top-left corner, where it is unless you have moved it in the addon's options).
      else if (kind === 'strip') { const [x, y] = rest.map(Number); this.#set({ strip: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null }); }
      else if (kind === 'stalled') this.#set({ status: 'nosignal', reason: 'stalled', party: [] });
      return;
    }
    if (line.startsWith('M ')) {
      // a square of the game's picture that was asked for (look): where it is, how big, its pixels
      const [, x, y, w, h, data] = line.split(' ');
      const [X, Y, W, H] = [x, y, w, h].map(Number);
      if (!data || ![X, Y, W, H].every(Number.isInteger) || W < 8 || H < 8) return;
      const rgb = Buffer.from(data, 'base64');
      if (rgb.length !== W * H * 3) return;
      this.squares++;
      try { this.eyes?.crop({ x: X, y: Y, w: W, h: H, data: rgb }); } catch (err) { if (changed('eyes', err.message)) note('minimap', 'a picture of the minimap could not be taken in', { error: err.message }); }
      try { this.dots?.crop({ x: X, y: Y, w: W, h: H, data: rgb }); } catch (err) { if (changed('dots crop', err.message)) note('dots', 'a picture of the minimap could not be looked at for its dots', { error: err.message }); }
      return;
    }
    if (!line.startsWith('P ')) return;
    const px = Buffer.from(line.slice(2), 'hex');
    const d = decodeStrip(px, Math.floor(px.length / 3));
    this.#noteReads(d);
    if (!d.ok) {
      // A single unreadable frame is normal (the screen can be read mid-update). Nothing
      // readable for most of a second means the strip really is not visible.
      if (Date.now() - this.lastGood > LOST_AFTER_MS) this.#set({ status: 'nosignal', reason: d.reason, party: [] });
      return;
    }
    this.lastGood = Date.now();
    this.names.add(d.text);
    if (d.text && d.text.last && (d.text.kind <= 1 || (d.text.kind === TEXT_KIND.STATS && d.text.key >= 8) || (d.text.kind === TEXT_KIND.TALK && d.text.key === 10))) {
      // a piece of your quests has come in, or of who your character is, or the quests you have
      // just handed in: is a whole new list there now?
      // (who you are goes with your quests: the two together say which quests are open to you)
      const q = this.names.quests(), who = this.names.self();
      const sig = `${q.sig}/${who?.gen ?? '-'}`;
      if (sig !== this.questSig) {
        this.questSig = sig;
        this.quests = { rev: this.quests.rev + 1, log: q.log, done: q.done, me: who ? { class: who.class, race: who.race, skills: who.skills, reps: who.reps, spells: who.spells } : null };
      }
    }
    // What was in the corpses of a creature you have just looted (the addon's Drops.lua): a message
    // that is whole in itself, taken the moment its last piece is in (loot.js keeps the count).
    if (d.text && d.text.last && d.text.kind === TEXT_KIND.STATS && d.text.key === LOOT_KEY && this.loot) {
      try {
        const said = readLoot(this.names.raw.get(`${TEXT_KIND.STATS}:${LOOT_KEY}`));
        if (said && this.loot.heard(said)) note('game', `what was in the corpses of creature ${said.creature}: ${said.n} looted so far`, { things: said.items.length });
      } catch (err) { if (changed('loot heard', err.message)) note('game', 'what the strip said of a corpse could not be taken in', { error: err.message }); }
    }
    // Where the game's own interface is on the screen (the addon's Windows.lua): for the map drawn
    // over the game, where it is set to lie behind the interface (viewer/js/overlay.js). Taken
    // when a piece of it has come in: { n (the edition), r: [left, top, right, bottom, ... in
    // 1023rds of the game's picture] } - or null: the addon does not say.
    if (d.text && d.text.last && d.text.kind === TEXT_KIND.TALK && d.text.key >= 11 && d.text.key <= 14) {
      const ui = this.names.ui();
      const said = ui ? `${ui.gen}:${ui.rects.join()}` : '';
      if (said !== this.uiSaid) {
        this.uiSaid = said;
        this.ui = ui ? { n: ui.gen, r: ui.rects } : null;
        if (changed('ui', ui ? ui.rects.length / 4 : null)) note('game', ui ? 'where the game\'s interface is on the screen: so many rectangles' : 'the game no longer says where its interface is', ui ? { rectangles: ui.rects.length / 4 } : undefined);
      }
    }
    const player = {
      map: d.map, mode: d.mode, x: d.x, y: d.y, z: d.z, facing: d.facing, zone: d.zone, level: d.level, inInstance: d.inInstance, dead: d.dead, taxi: d.taxi, indoors: d.indoors, faction: d.faction,
      // how you are moving (null when the addon in the game is an older one that does not say)
      swimming: d.swimming, submerged: d.submerged, falling: d.falling, flying: d.flying, mounted: d.mounted,
      // (addon version 6) a time in the air that began with a jump; the keys that take you up and down in water; how fast
      // the game says you move; the number of what it calls the place (strip.js, placeNumber)
      jumped: d.jumped, ascend: d.ascend, descend: d.descend, speed: d.speed, place: d.place,
      // (addon version 31) you are in a fight, as the game counts it - for the overlays over the game
      combat: d.combat ?? null,
    };
    // Your height as the game measured it (strip.js: the fix). It is drawn in the strip for a
    // few seconds; each one is numbered when it first comes, and kept with where and when that
    // was - the map holds it against where you were then, once.
    if (d.fix && d.fix.seq !== this.fixSeq) {
      this.fixSeq = d.fix.seq;
      this.fixCount = (this.fixCount ?? 0) + 1;
      this.fix = { n: this.fixCount, refs: d.fix.refs, map: d.map, x: d.x, y: d.y, t: Date.now() };
    } else if (!d.fix) this.fixSeq = null;
    if (this.fix && d.mode === 'world') player.fix = this.fix;
    // When this was read off the game's window (this computer's clock, ms): the map times your
    // falls and your speed by it. (A reading that says what the one before said keeps that one's
    // time: nothing has happened, and nothing is sent on.)
    const said = JSON.stringify(player);
    player.t = said === this.saidLast && this.state.player?.t ? this.state.player.t : Date.now();
    this.saidLast = said;
    // A corrupted read can very occasionally pass the checksum. A real jump (teleport, map
    // change) persists, so only believe one once the next frame agrees with it.
    const prev = this.state.player;
    if (prev && this.state.status === 'live') {
      const jump = prev.map !== player.map || prev.mode !== player.mode
        || (player.mode === 'world' && Math.hypot(player.x - prev.x, player.y - prev.y) > 150);
      if (jump) {
        const p = this.pending;
        const confirmed = p && p.map === player.map && p.mode === player.mode && (player.mode !== 'world' || Math.hypot(player.x - p.x, player.y - p.y) < 60);
        this.pending = player;
        if (!confirmed) { if (!p) note('game', 'you seem to be somewhere else all at once: believed when the next reading agrees', { from: [prev.map, Math.round(prev.x), Math.round(prev.y)], to: [player.map, Math.round(player.x), Math.round(player.y)] }); return; }
      }
    }
    this.pending = null;
    // the route's way into the game: where the game says you are heading, and what the addon says of its mailboxes
    if (this.mail) {
      this.mail.setTarget(d.target);
      const report = this.names.mail();
      if (report) this.mail.setReport(report);
    }
    // who you are talking to (the addon repeats it for half a minute; a new meeting has a new number)
    const met = this.names.talk();
    if (met && (!this.talk || this.talk.seq !== met.seq || this.talk.id !== met.id || this.talk.object !== met.object || !!this.talk.fight !== met.fight)) { this.talk = { id: met.id, seq: met.seq, object: met.object, fight: met.fight, at: Date.now() - met.age * 1000 }; note('game', met.fight ? `you fought creature ${met.id}, and were beside it` : `you opened the window of ${met.object ? 'object' : 'NPC'} ${met.id}`); }
    this.#noteGame(d, player);
    // (inside a dungeon the game hides where you are: its minimap is looked at - minimap.js)
    try { this.eyes?.heard(d, this.names.minimap(), this.state.window); } catch (err) { if (changed('eyes', err.message)) note('minimap', 'what the strip said could not be taken in', { error: err.message }); }
    // (the dots on that minimap - what you track, your target, your pet - are read off the same picture, wherever you are: dots.js)
    try { this.dots?.heard(d, this.names.minimap(), this.state.window, this.names.yours()); } catch (err) { if (changed('dots heard', err.message)) note('dots', 'what the strip said could not be taken in', { error: err.message }); }
    this.#set({
      status: 'live', reason: null, player, talk: this.talk, heads: this.names.heads(),
      // (the lists themselves are fetched when this changes: they are long, and this goes out many times a second)
      quests: { rev: this.quests.rev, log: this.quests.log?.length ?? null, done: this.quests.done?.length ?? null },
      // where you are heading (the guide's step, a journey of your own or a map pin), and how you can travel: speeds, hearthstone, flight points
      // (quick: a Shift-click on the game's map)
      target: d.target ? { map: d.target.map, x: d.target.x, y: d.target.y, source: d.target.kind === 1 ? 'guide' : d.target.kind === 2 ? 'journey' : d.target.kind === 4 ? 'quick' : 'pin' } : null,
      // the level you chose in the game, where a waypoint's spot has more than one
      choice: this.names.choice(),
      travel: this.names.travel(),
      // when the boats, zeppelins and tram run, as far as the addon knows (kept after the game is closed: boats sail on)
      transit: this.names.transit() ?? this.state.transit ?? null,
      party: d.party.map((m) => ({ slot: m.slot, name: this.names.party(m.slot), x: m.x, y: m.y, dead: m.dead })),
      // what the game's minimap shows as dots, as places in the world, and what your tracking is set to (dots.js)
      ...this.#dotsNow(),
      // where the game's own interface is on the screen, for the map drawn behind it
      ui: this.ui ?? null,
    });
  }
}
