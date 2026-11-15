// Live player link. Starts a tiny screen-reader helper (server/strip-reader.cs) that watches the
// coded strip the AzerothAtlas addon draws in the game window, decodes it, and streams the
// result to the viewer. The helper only runs while a map page is listening.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeStrip, NameCache, MAX_BLOCKS } from './strip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'strip-reader.cs');
const BUILD_DIR = path.join(HERE, '.build');
const ROW = 2;                         // pixel row inside the 6 px tall strip
const WIDTH = MAX_BLOCKS * 6 + 80;     // room for squares up to 1.5x their intended width
const LOST_AFTER_MS = 700;             // nothing readable for this long = signal lost

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
    this.opts = { processNames: ['Wow'], pathHint: '', intervalMs: 55, fixed: null, ...opts };
    this.clients = new Set();
    this.child = null;
    this.stopTimer = null;
    this.names = new NameCache();
    this.lastGood = 0;
    this.pending = null;
    this.state = { status: 'off', reason: null, window: null, capture: null, player: null, party: [], target: null, travel: null, transit: null, talk: null, quests: null, mail: null };
    this.mail = opts.mail ?? null; // the route's way into the game (mail.js), told what the addon says of it
    this.talk = null; // the last NPC you met in the game, with when this server first heard of it
    this.quests = { rev: 0, log: null, done: null }; // your quest log and the quests you have done (see /api/player/quests)
    this.questSig = '';
    this.sent = '';
  }

  // ---- subscribers (server-sent events) ---------------------------------------------------
  subscribe(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    clearTimeout(this.stopTimer);
    if (!this.child) this.#start();
    res.write(`data: ${JSON.stringify(this.state)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
      // Nobody is looking at the map any more: stop watching the screen.
      if (!this.clients.size) this.stopTimer = setTimeout(() => this.stop(), 8000);
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
    // (the route mailboxes are only kept filled while the game is being heard from)
    if (this.mail) {
      this.mail.setLive(this.state.status === 'live');
      this.state.mail = this.mail.status();
    }
    this.#publish();
  }

  /** The route mailboxes have something new to say (the map page sent a route). */
  mailChanged() {
    if (this.mail) this.#set({});
  }

  // ---- helper process ----------------------------------------------------------------------
  #start() {
    let exe;
    try { exe = ensureReader(); } catch (err) { this.#set({ status: 'error', reason: err.message.split('\n')[0] }); return; }
    const o = this.opts;
    const args = [o.processNames.join(','), o.pathHint || '-', String(process.pid), String(WIDTH), String(ROW), String(o.intervalMs)];
    if (o.fixed) args.push(String(o.fixed[0]), String(o.fixed[1]));
    this.#set({ status: 'starting', reason: null });
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(line));
    child.on('error', (err) => { if (this.child === child) { this.child = null; this.#set({ status: 'error', reason: err.message }); } });
    child.on('exit', () => {
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
    child?.kill();
    this.state = { ...this.state, status: 'off', reason: null };
    this.mail?.setLive(false);
    this.sent = '';
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
      else if (kind === 'stalled') this.#set({ status: 'nosignal', reason: 'stalled', party: [] });
      return;
    }
    if (!line.startsWith('P ')) return;
    const px = Buffer.from(line.slice(2), 'hex');
    const d = decodeStrip(px, Math.floor(px.length / 3));
    if (!d.ok) {
      // A single unreadable frame is normal (the screen can be read mid-update). Nothing
      // readable for most of a second means the strip really is not visible.
      if (Date.now() - this.lastGood > LOST_AFTER_MS) this.#set({ status: 'nosignal', reason: d.reason, party: [] });
      return;
    }
    this.lastGood = Date.now();
    this.names.add(d.text);
    if (d.text && d.text.kind <= 1 && d.text.last) {
      // a piece of your quests has come in: is a whole new list there now?
      const q = this.names.quests();
      if (q.sig !== this.questSig) { this.questSig = q.sig; this.quests = { rev: this.quests.rev + 1, log: q.log, done: q.done }; }
    }
    const player = {
      map: d.map, mode: d.mode, x: d.x, y: d.y, z: d.z, facing: d.facing, zone: d.zone, level: d.level, inInstance: d.inInstance, dead: d.dead, taxi: d.taxi, indoors: d.indoors, faction: d.faction,
      // how you are moving (null when the addon in the game is an older one that does not say)
      swimming: d.swimming, submerged: d.submerged, falling: d.falling, flying: d.flying, mounted: d.mounted,
    };
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
        if (!confirmed) return;
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
    if (met && (!this.talk || this.talk.seq !== met.seq || this.talk.id !== met.id || this.talk.object !== met.object)) this.talk = { id: met.id, seq: met.seq, object: met.object, at: Date.now() - met.age * 1000 };
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
    });
  }
}
