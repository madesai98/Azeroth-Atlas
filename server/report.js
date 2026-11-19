#!/usr/bin/env node
// "Report a problem": everything that may help find out what went wrong on this computer, in
// one zip file, to hand to whoever looks into it. Nothing is sent anywhere: the file is made,
// and it is for you to pass it on.
//
// What goes in (report.txt, the first file in the zip, lists every file and what was left out):
//
//   report.txt        what you wrote, and a summary of all the rest
//   timeline.txt      the notes below as one list in the order things happened: the server's,
//                     the page's and the addon's own, side by side
//   computer/         Windows, processor, memory, graphics card and driver, drives, the names of
//                     the programs running (overlays and capture programs get in the strip's way)
//   atlas/            this copy of Azeroth Atlas: its version and its own files (name, size and
//                     a digest of each, so that a file gone wrong shows), config.json, what the
//                     server knew at that moment (the game, the addon, your character as the
//                     game reported it, your quest log), its notes (log.js), what the page
//                     showed and noted, a picture of the map, the route mailboxes as they stood,
//                     and - where you were found on the game's minimap inside a dungeon
//                     (minimap.js) - the last small square of the game's picture that was looked
//                     at, where the minimap was taken to be in it, and what the look gave; and
//                     what following you has taught the map of the dungeons (doors, ways, checks)
//   game/             the game: its build, its settings (Config.wtf), the addons installed and
//                     which are switched on, what the Azeroth Atlas addon has saved (with its own
//                     notes of what it did: Route.lua), what the addons it works with have saved,
//                     the game's own logs and its last crash reports, its cache of what the
//                     server told it about creatures, objects and quests
//
// What never goes in: account names (the account's folder is called "account-1" in the zip, and
// the name is struck from every text), passwords or anything like one, your Windows user name
// and the computer's name (struck from paths and texts), e-mail addresses, the game's chat and
// combat logs, your macros, the game's crash dumps, anything of the game itself. What other
// addons have saved goes in only for the ones that work with this one, unless you ask for all.
// Character and realm names do go in: what an addon saves is kept under them.
//
// The server makes the zip and hands it to the page (POST /api/report), which saves it where
// you say. Without a page - the server would not start - the same is to be had from a terminal:
//
//   node server/report.js --out=path/to/report.zip [--text="what went wrong"] [--config=path/to/config.json]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, HOME, CONFIG_FILE, loadConfig, readConfigFile, flavourFolder } from '../extractor/config.js';
import { DATA_STAMP } from '../extractor/stamp.js';
import { json, ownPage } from './http.js';
import { note, notePage, pageLine, openLogs, logDir, logsDir, logFiles, recentEvents } from './log.js';

const ADDON = 'AzerothAtlas';
const KB = 1024, MB = 1024 * 1024;
const LOG_TAIL = 600 * KB;        // of a log that is longer, the end is taken
const CRASH_HEAD = 300 * KB;      // of a crash report, the beginning (what stopped, and where)
const CRASHES = 3;                // the newest crash reports of the game
const SAVED_MAX = 6 * MB;         // a file of saved settings longer than this is left out
const OTHERS_MAX = 40 * MB;       // of the other addons' saved settings, all together
const CACHE_MAX = 6 * MB;         // a cache file
const HOTFIX_MAX = 30 * MB;       // the game's cache of hotfixes
const BODY_MAX = 64 * MB;         // what the page may send with its request (its notes, its picture)
const TIMELINE_HOURS = 8;         // how far back the one list of everything goes
const TIMELINE_LINES = 25000;
// The game's own logs that say something about how the game and its addons are doing. (Not its
// chat and combat logs, nor the ones about your account and what it connects to.)
const GAME_LOGS = /^(FrameXML|taint|gx|cpu|Client|General|DeveloperLog|QuestCache|Model)\.log(\.old)?$/i;
// Addons this one works with: what they have saved may explain what it did.
const RELATED = /^(AzerothAtlas|ForeverMapLink|Guidelime|Questie|QuestieDB|TomTom|ShortestPathForever|DockWatch|ForeverTransport|Nauticus)$/i;
// Settings of the game that name who you are.
const WHO = /account|password|token|e-?mail|login|launch|agent|uid|guid|bnet|battle/i;

// ---- a zip file -------------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = zlib.crc32 ? (buf) => zlib.crc32(buf) >>> 0 : (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/**
 * Files, as one zip: [{ name ('folder/file.txt'), data (Buffer), at (Date, when it was written) }]
 * -> Buffer. Packed where that makes a file smaller, stored where it does not (pictures).
 */
export function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const raw = e.data;
    let packed = zlib.deflateRawSync(raw, { level: 6 }), method = 8;
    if (packed.length >= raw.length) { packed = raw; method = 0; }
    const d = e.at instanceof Date && !Number.isNaN(+e.at) ? e.at : new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(head, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ---- who you are, struck from what is written ----------------------------------------------------
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slashes = (s) => literal(s).replace(/\\\\|\//g, '[\\\\/]+'); // (a path, however its slashes lean and however often they are doubled)

/**
 * @param accounts  the names of the game's account folders
 * @returns { text(string) -> string, name(string) -> string (for a path inside the zip) }
 */
export function redactor(accounts = [], who = { user: os.userInfo().username, host: os.hostname(), home: os.homedir() }) {
  const rules = [];
  if (who.home) rules.push([new RegExp(slashes(who.home), 'gi'), '%USERPROFILE%']);
  if (who.user) rules.push([new RegExp(`([\\\\/]Users[\\\\/]+)${literal(who.user)}(?![\\w.-])`, 'gi'), '$1<user>']);
  // (a name of a few letters is a word like any other: struck only where it is plainly a name, as above)
  if (who.user && who.user.length >= 4) rules.push([new RegExp(`(?<![\\w])${literal(who.user)}(?![\\w])`, 'gi'), '<user>']);
  if (who.host && who.host.length >= 4) rules.push([new RegExp(`(?<![\\w])${literal(who.host)}(?![\\w])`, 'gi'), '<computer>']);
  accounts.forEach((a, i) => { if (a.length >= 3) rules.push([new RegExp(`(?<![\\w])${literal(a)}(?![\\w])`, 'gi'), `account-${i + 1}`]); });
  rules.push([/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<e-mail>']);
  const text = (s) => rules.reduce((t, [re, to]) => t.replace(re, to), s);
  return { text, name: (s) => text(s) };
}

// ---- reading what there is -----------------------------------------------------------------------
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const size = (n) => (n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= KB ? `${Math.round(n / KB)} KB` : `${n} bytes`);
const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };

/** The end of a file (from the start of a line), or all of it: { data, cut }. */
function tail(file, max) {
  const st = fs.statSync(file);
  if (st.size <= max) return { data: fs.readFileSync(file), cut: false, whole: st.size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    fs.readSync(fd, buf, 0, max, st.size - max);
    const nl = buf.indexOf(10);
    return { data: nl >= 0 && nl < 4096 ? buf.subarray(nl + 1) : buf, cut: true, whole: st.size };
  } finally { fs.closeSync(fd); }
}
/** The beginning of a file, or all of it. */
function head(file, max) {
  const st = fs.statSync(file);
  if (st.size <= max) return { data: fs.readFileSync(file), cut: false, whole: st.size };
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(max); fs.readSync(fd, buf, 0, max, 0); return { data: buf, cut: true, whole: st.size }; } finally { fs.closeSync(fd); }
}

/** A value of the settings that is nobody else's business, struck: keys that sound like a secret. */
function withoutSecrets(v) {
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /key|token|secret|password/i.test(k) && typeof x === 'string' ? '<left out>' : withoutSecrets(x)]));
}

/** This computer, as Windows describes it. Resolves to an object (with `error` where it could not be asked). */
function askWindows() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$o = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$o.windows = [ordered]@{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber; release = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion; bits = $os.OSArchitecture; started = "$($os.LastBootUpTime.ToString('s'))" }
$o.computer = [ordered]@{ maker = $cs.Manufacturer; model = $cs.Model; memory = [int64]$cs.TotalPhysicalMemory; memoryFree = [int64]$os.FreePhysicalMemory * 1024 }
$o.processors = @(Get-CimInstance Win32_Processor | ForEach-Object { [ordered]@{ name = "$($_.Name)".Trim(); cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; mhz = $_.MaxClockSpeed } })
$o.graphics = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = $_.Name; driver = $_.DriverVersion; driverDate = "$($_.DriverDate.ToString('yyyy-MM-dd'))"; memory = [int64]$_.AdapterRAM; width = $_.CurrentHorizontalResolution; height = $_.CurrentVerticalResolution; hz = $_.CurrentRefreshRate; status = $_.Status } })
$o.graphicsMemory = @(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { [ordered]@{ name = $_.DriverDesc; memory = [int64]$_.'HardwareInformation.qwMemorySize' } })
$o.drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ drive = $_.DeviceID; size = [int64]$_.Size; free = [int64]$_.FreeSpace; format = $_.FileSystem } })
$o.antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName })
$o.colourFilter = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\ColorFiltering').Active
$o.dotnetFramework4 = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full').Release
$o.programs = @(Get-Process | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object)
$o | ConvertTo-Json -Depth 6 -Compress
`;
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ error: 'not Windows' }); return; }
    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { finish({ error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ error: 'Windows took too long to answer' }); }, 25000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out.slice(out.indexOf('{')))); } catch { finish({ error: `Windows did not answer in a way that could be read${err ? `: ${err.trim().split('\n')[0]}` : ''}` }); }
    });
    child.stdin.end(script);
  });
}

/** The lines the addon noted for itself (Route.lua: shared.Log), out of a file of what it saved: [{ t (ms), text }]. */
export function addonNotes(lua) {
  const out = [];
  // (as the game writes a list of words: "1794852599 1234.5 fetch ...", -- [17] - or, as this
  // game writes it, with no number after it: for want of that, a report once had none of them)
  for (const m of lua.matchAll(/^\s*"(\d{9,11}) (-?[\d.]+) ((?:[^"\\]|\\.)*)",(?: -- \[\d+\])?\s*$/gm)) {
    out.push({ t: +m[1] * 1000, game: +m[2], text: m[3].replace(/\\(.)/g, (_, c) => (c === 'n' ? ' ' : c)) });
  }
  // (kept in a ring: put back in the order they were noted - by the game's own clock, which never goes back within a session)
  return out.sort((a, b) => a.t - b.t || a.game - b.game);
}

// ---- the report ------------------------------------------------------------------------------------
/**
 * @param ctx  { configFile, cfg (the settings in use, or null where the game was not found), problem
 *             (why not, then), live: { status(), tracker, mail, atlas, auctions, minimap } (what the running
 *             server has in hand; none of it when run from a terminal) }
 * @param ask  { text (what went wrong, in the reporter's words), when, include: { shot, cache,
 *             others (every addon's saved settings), hotfixes }, page: { state, log, shot (a
 *             data: URL of the picture) } }
 * @returns { zip: Buffer, name, entries: [{ name, bytes, note }], left: [what was left out, and why], seconds }
 */
export async function buildReport(ctx, ask = {}) {
  const began = Date.now();
  const include = { shot: true, cache: true, others: false, hotfixes: false, ...(ask.include ?? {}) };
  const cfg = ctx.cfg ?? null;
  const flavour = cfg ? flavourFolder(cfg) : null;
  const gameDir = flavour ? path.join(cfg.installRoot, flavour) : null;
  const accountsDir = gameDir ? path.join(gameDir, 'WTF', 'Account') : null;
  // (the folders of the game's accounts: named after the accounts - and one, beside them, that is not an account's)
  const accounts = accountsDir ? list(accountsDir).filter((d) => d.isDirectory() && d.name !== 'SavedVariables').map((d) => d.name) : [];
  const red = redactor(accounts);
  const entries = [], left = [], trouble = [];
  const taken = new Set();
  /** Put a file in. text: true for one that is read as words (who you are is struck from it). */
  const add = (name, data, opts = {}) => {
    let n = red.name(name.replace(/\\/g, '/'));
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = n.replace(/(\.[^./]*)?$/, (ext) => ` (${i})${ext}`);
    taken.add(n.toLowerCase());
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 1), 'utf8');
    if (opts.text !== false && (opts.text || !Buffer.isBuffer(data))) {
      // (a file that is not written as the rest are - an old addon's, in the letters of its own country - keeps every byte that is not a name struck from it)
      const words = buf.toString('utf8');
      buf = words.includes('\uFFFD') ? Buffer.from(red.text(buf.toString('latin1')), 'latin1') : Buffer.from(red.text(words), 'utf8');
    }
    entries.push({ name: n, data: buf, at: opts.at ?? new Date(), note: opts.note ?? '' });
  };
  /** Do one part; whatever goes wrong in it is said in the report and stops nothing else. */
  const part = async (what, fn) => { try { await fn(); } catch (err) { trouble.push(`${what}: ${err.message}`); } };
  /** A file from the disk, as it is or cut to length. */
  const file = (name, from, { max = Infinity, end = true, text = false, skipOver = Infinity } = {}) => {
    const st = stat(from);
    if (!st || !st.isFile()) return false;
    if (st.size > skipOver) { left.push(`${red.name(name)}: ${size(st.size)}, longer than the ${size(skipOver)} taken`); return false; }
    const r = end ? tail(from, max) : head(from, max);
    add(name, r.data, { text, at: st.mtime, note: r.cut ? `the ${end ? 'last' : 'first'} ${size(r.data.length)} of ${size(r.whole)}` : '' });
    return true;
  };
  const digest = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return '(unreadable)'; } };
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')); } catch { return {}; } })();
  const live = ctx.live ?? {};
  const logs = logsDir() ?? logDir(ctx.configFile ?? CONFIG_FILE);
  const summary = []; // lines for report.txt

  // ---- this computer ----
  const windows = askWindows(); // (asked while the rest is gathered)

  // ---- Azeroth Atlas itself ----
  await part('the version of Azeroth Atlas', () => {
    const record = (() => { try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.app-version.json'), 'utf8')); } catch { return null; } })();
    const looked = (() => { try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'server', '.build', 'app-check.json'), 'utf8')); } catch { return null; } })();
    const git = exists(path.join(PROJECT_ROOT, '.git'));
    let commit = record?.sha ?? null, changes = null;
    if (git) {
      const run = (...a) => { const r = spawnSync('git', a, { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true, timeout: 8000 }); return r.status === 0 ? r.stdout.trim() : null; };
      commit = run('rev-parse', 'HEAD') ?? commit;
      changes = run('status', '--porcelain')?.split('\n').filter(Boolean).slice(0, 60) ?? null;
    }
    const about = {
      version: pkg.version ?? null, commit, kind: git ? 'a git checkout' : 'a plain folder', installed: HOME !== PROJECT_ROOT,
      lastUpdate: record ? { to: record.sha, at: record.at, from: record.from, files: record.files?.length ?? null } : null, lastLook: looked,
      changesOfItsOwn: changes, mapDataStamp: DATA_STAMP, folder: PROJECT_ROOT, home: HOME, configFile: ctx.configFile ?? null, logs,
      runBy: { program: path.basename(process.execPath), node: process.versions.node, electron: process.versions.electron ?? null, v8: process.versions.v8, asApplication: !!process.env.AZEROTH_ATLAS_APP, pid: process.pid, upFor: `${Math.round(process.uptime())} s`, memory: process.memoryUsage(), args: process.argv.slice(1) },
    };
    add('atlas/about.json', about);
    summary.push(`Azeroth Atlas ${about.version ?? '?'}${commit ? ` (${String(commit).slice(0, 7)})` : ''}, ${about.kind}${about.installed ? ', installed' : ', run from its folder'}${changes?.length ? `, with ${changes.length} change${changes.length === 1 ? '' : 's'} of its own` : ''}`);
  });
  await part('the files of Azeroth Atlas', () => {
    // (every file the map tool is made of: a file that is not what it should be - an update cut short - shows here)
    const lines = [];
    const walk = (dir, rel) => {
      for (const e of list(dir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (/^(node_modules|\.git|data|dist|wowhead-scraper|\.firebase)$/.test(r) || /^(server\/\.build|extractor\/dbd|functions\/(node_modules|shared))$/.test(r)) continue;
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
        const st = stat(path.join(dir, e.name));
        if (st) lines.push(`${digest(path.join(dir, e.name))}  ${String(st.size).padStart(9)}  ${st.mtime.toISOString()}  ${r}`);
      }
    };
    walk(PROJECT_ROOT, '');
    add('atlas/files.txt', `digest        size       written                   file\n${lines.join('\n')}\n`);
  });
  await part('config.json', () => {
    const f = ctx.configFile ?? CONFIG_FILE;
    let own = null, error = null;
    try { own = exists(f) ? readConfigFile(f) : null; } catch (err) { error = err.message; }
    add('atlas/config.json', { file: f, there: own !== null, unreadable: error ?? undefined, says: withoutSecrets(own), inUse: cfg ? withoutSecrets({ ...cfg }) : null, gameNotFound: ctx.problem?.message ?? undefined });
  });
  await part('what the server knew', () => {
    const state = {};
    const ask1 = (key, fn) => { try { state[key] = fn(); } catch (err) { state[key] = { error: err.message }; } };
    if (live.status) ask1('status', () => live.status());
    if (live.tracker) ask1('game', () => ({ ...live.tracker.state, listeners: live.tracker.clients.size, helperRunning: !!live.tracker.child, lastReadAgo: live.tracker.lastGood ? Date.now() - live.tracker.lastGood : null }));
    if (live.mail) ask1('mailboxes', () => ({ status: live.mail.status(), folder: live.mail.dir, named: live.mail.prefix, found: live.mail.size, report: live.mail.report, target: live.mail.target, delivery: live.mail.written, filled: live.mail.filled, warm: live.mail.warm, olderInARow: live.mail.stale, history: live.mail.history, quest: live.mail.tracked, hearthLeftOut: live.mail.hearth, marker: live.mail.marker, route: live.mail.route && { ...live.mail.route, stretches: live.mail.route.stretches.length, also: live.mail.route.also.length, others: live.mail.route.others.length }, routes: live.mail.whole?.map((o) => ({ ...o, stretches: o.stretches.length, also: o.also.length })) ?? null }));
    if (live.addon) ask1('addon', () => live.addon());
    if (live.atlas) ask1('database', () => live.atlas.status());
    if (live.auctions) ask1('auctions', () => live.auctions.status());
    if (ctx.problem) state.gameNotFound = { message: ctx.problem.message, configured: ctx.problem.configured ?? null };
    if (!Object.keys(state).length) state.note = 'made from a terminal: no server was asked';
    add('atlas/state.json', state);
    if (live.tracker) add('atlas/quests.json', live.tracker.quests ?? null);
    const g = state.game;
    if (g && !g.error) summary.push(`The game: ${g.status}${g.reason ? ` (${g.reason})` : ''}${g.player ? `, a level ${g.player.level} character on map ${g.player.map}` : ''}`);
    if (state.addon && !state.addon.error) summary.push(`The addon: ${state.addon.installed ? `version ${state.addon.installedVersion ?? '?'} installed${state.addon.current ? '' : ` (this copy brings version ${state.addon.version ?? '?'})`}` : 'not installed'}`);
  });
  await part('the minimap', () => {
    // Where you are inside a dungeon is read off the game's minimap (minimap.js). What may explain
    // a place that is wrong, or none at all: the last square of the game's picture that was looked
    // at, as a picture; where the minimap was taken to be (by the addon's word and by its rim on
    // the picture); and the figures of the last look.
    const mm = live.minimap;
    if (!mm) return;
    const s = mm.status();
    add('atlas/minimap/state.json', s);
    // (what each of the last pictures gave, five minutes of them: figures only)
    const kept = mm.trailKept?.();
    if (kept?.rows?.length) add('atlas/minimap/trail.json', JSON.stringify(kept));
    const pic = include.shot ? mm.picture() : null;
    if (pic) add('atlas/minimap/last.png', pic.png, { text: false, at: new Date(pic.at), note: `the square of the game's picture last looked at: ${pic.w} x ${pic.h} pixels${pic.origin ? `, ${pic.origin[0]} across and ${pic.origin[1]} down` : ''}` });
    if (s.wanted || s.pictures) summary.push(`The minimap: ${s.state}${s.why ? ` (${s.why})` : ''}; ${s.found} of ${s.pictures} pictures of it gave a place`);
  });
  await part('the notes of Azeroth Atlas', () => {
    for (const f of logFiles()) file(`atlas/logs/${path.basename(f)}`, f, { max: 3 * MB, text: true });
    if (!logFiles().length && recentEvents().length) add('atlas/logs/events.log', `${recentEvents().join('\n')}\n`, { note: 'the last lines, from memory: the file could not be written' });
    // (the application's own account of itself - app/main.cjs - and what its server has said since it was started)
    for (const f of ['app.json', 'app.log']) file(`atlas/logs/${f}`, path.join(logs, f), { max: LOG_TAIL, text: true });
    for (const f of [path.join(HOME, 'server.log'), path.join(PROJECT_ROOT, 'server', '.build', 'app.log')]) if (file(`atlas/logs/${path.basename(f)}`, f, { max: 1.2 * MB, text: true })) break;
    const build = path.join(PROJECT_ROOT, 'server', '.build');
    add('atlas/logs/built-here.txt', `${list(build).map((e) => { const st = stat(path.join(build, e.name)); return `${e.isDirectory() ? '(folder)' : String(st?.size ?? '?').padStart(9)}  ${st?.mtime.toISOString() ?? ''}  ${e.name}`; }).join('\n')}\n`);
  });
  await part('what the page showed', () => {
    const p = ask.page;
    if (!p || typeof p !== 'object') { left.push('what the map page showed: the report was not made from a page'); return; }
    if (p.state !== undefined) add('atlas/page/state.json', p.state);
    if (Array.isArray(p.log)) add('atlas/page/notes.txt', `${p.log.slice(-5000).map(pageLine).join('\n')}\n`);
    const m = include.shot && typeof p.shot === 'string' ? /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(p.shot) : null;
    if (m) add(`atlas/page/map.${m[1] === 'png' ? 'png' : 'jpg'}`, Buffer.from(m[2], 'base64'), { text: false });
    else left.push(include.shot ? 'a picture of the map: the page could not take one' : 'a picture of the map: you chose to leave it out');
  });
  await part('the map data', () => {
    if (!cfg) return;
    const dir = cfg.dataDir;
    file('atlas/data/manifest.json', path.join(dir, 'manifest.json'), { skipOver: 4 * MB, text: true });
    file('atlas/data/npcs-seen.json', path.join(dir, 'user', 'npcs-seen.json'), { skipOver: 2 * MB });
    // (what following you through the dungeons has taught the map of them: doors, ways, checks - minimap-places.js)
    for (const name of ['dungeon-doors.json', 'dungeon-ways.json', 'dungeon-checks.json']) file(`atlas/data/${name}`, path.join(dir, 'user', name), { skipOver: 1 * MB });
    add('atlas/data/folder.txt', `${dir}\n\n${list(dir).map((e) => { const st = stat(path.join(dir, e.name)); return `${e.isDirectory() ? ' (folder)' : String(st?.size ?? '?').padStart(9)}  ${st?.mtime.toISOString() ?? ''}  ${e.name}`; }).join('\n')}\n`);
  });

  // ---- the game ----
  const notes = []; // the addon's own notes, for the one list of everything: { t, who, text }
  if (!gameDir) left.push(`everything about the game: ${ctx.problem?.message ?? 'its folder was not found'}`);
  else {
    await part('the game\'s folder', () => {
      const info = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return '(not there)\n'; } };
      let text = `The game's folder: ${cfg.installRoot}${cfg.foundGame ? '  (found there; config.json does not name it)' : ''}\nThe flavour asked for: ${cfg.product}, in ${flavour}\n\n.build.info:\n${info(path.join(cfg.installRoot, '.build.info'))}\n`;
      for (const e of list(cfg.installRoot)) if (e.isDirectory() && exists(path.join(cfg.installRoot, e.name, '.flavor.info'))) text += `${e.name}/.flavor.info:\n${info(path.join(cfg.installRoot, e.name, '.flavor.info'))}\n`;
      text += `\nIn ${flavour}:\n${list(gameDir).map((e) => { const st = stat(path.join(gameDir, e.name)); return `${e.isDirectory() ? ' (folder)' : String(st?.size ?? '?').padStart(11)}  ${st?.mtime.toISOString() ?? ''}  ${e.name}`; }).join('\n')}\n`;
      add('game/install.txt', text);
    });
    await part('the game\'s settings', () => {
      const f = path.join(gameDir, 'WTF', 'Config.wtf');
      if (!exists(f)) { left.push('game/Config.wtf: not there'); return; }
      const text = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => { const m = /^(\s*SET\s+)(\S+)(\s+)"(.*)"\s*$/i.exec(l); return m && WHO.test(m[2]) ? `${m[1]}${m[2]}${m[3]}"<left out>"` : l; }).join('\n');
      add('game/Config.wtf', text, { at: stat(f)?.mtime });
    });
    const addonsDir = path.join(gameDir, 'Interface', 'AddOns');
    const related = new Set();
    await part('the addons installed', () => {
      const out = [];
      let boxes = 0;
      for (const e of list(addonsDir)) {
        if (!e.isDirectory()) continue;
        if (/_Mail\d{3}$/.test(e.name)) { boxes++; continue; }
        const dir = path.join(addonsDir, e.name), files = list(dir);
        const tocs = files.filter((f) => /\.toc$/i.test(f.name)).map((f) => f.name);
        const main = tocs.find((t) => t.toLowerCase() === `${e.name.toLowerCase()}.toc`) ?? tocs[0];
        const fields = {};
        if (main) { try { for (const m of fs.readFileSync(path.join(dir, main), 'utf8').matchAll(/^##\s*([\w-]+)\s*:\s*(.*?)\s*$/gm)) if (/^(Title|Version|Interface|Dependencies|RequiredDeps|OptionalDeps|LoadOnDemand|SavedVariables|SavedVariablesPerCharacter|X-AzerothAtlas-Converted|X-ForeverMapLink-Converted)$/i.test(m[1])) fields[m[1]] = m[2].replace(/\|c[0-9a-f]{8}|\|r/gi, ''); } catch { /* unreadable */ } }
        const needs = `${fields.Dependencies ?? ''},${fields.RequiredDeps ?? ''},${fields.OptionalDeps ?? ''}`;
        if (RELATED.test(e.name) || /(^|,)\s*(AzerothAtlas|ForeverMapLink|Guidelime)\s*(,|$)/i.test(needs)) related.add(e.name.toLowerCase());
        out.push({ folder: e.name, tocs, ...fields, files: files.length, written: stat(dir)?.mtime.toISOString() ?? null });
      }
      add('game/addons.json', { folder: addonsDir, routeMailboxes: boxes, addons: out });
      summary.push(`${out.length} addons installed, ${boxes} route mailboxes`);
    });
    await part('the addon as it is installed', () => {
      const bundled = path.join(PROJECT_ROOT, 'addon', ADDON), installed = path.join(addonsDir, ADDON);
      const out = { installed: exists(installed), files: {} };
      const names = new Set([...list(bundled).map((e) => e.name), ...list(installed).map((e) => e.name)]);
      for (const n of [...names].sort()) {
        const a = path.join(bundled, n), b = path.join(installed, n);
        const same = exists(a) && exists(b) && digest(a) === digest(b);
        out.files[n] = { here: exists(a) ? digest(a) : null, inTheGame: exists(b) ? digest(b) : null, same };
        // (a file in the game that is not the one this copy brings: taken as it is)
        if (exists(b) && !same) file(`game/addon-installed/${n}`, b, { skipOver: 2 * MB });
      }
      add('game/addon-installed.json', out);
      // the route mailboxes the game would open next, as they stand
      const mail = live.mail;
      const boxes = mail?.filled ? mail.filled.split(',').map(Number).filter((n) => n > 0) : [1, 2];
      for (const i of boxes.slice(0, 10)) { const name = `${mail?.prefix ?? ADDON}_Mail${String(i).padStart(3, '0')}`; file(`atlas/mailboxes/${name}.lua`, path.join(addonsDir, name, 'mail.lua'), { skipOver: 1 * MB }); }
    });
    await part('what the addons have saved', () => {
      const wtf = path.join(gameDir, 'WTF');
      file('game/wtf/SavedVariables/Blizzard_AddOnList.lua', path.join(wtf, 'SavedVariables', 'Blizzard_AddOnList.lua'), { skipOver: 1 * MB, text: true });
      let others = 0, skipped = 0, newest = 0;
      const saved = (dir, to, who) => {
        for (const e of list(dir)) {
          if (!e.isFile()) continue;
          const m = /^(.+)\.lua(\.bak)?$/i.exec(e.name);
          if (!m) continue;
          const ours = /^(AzerothAtlas|ForeverMapLink)$/i.test(m[1]), from = path.join(dir, e.name), st = stat(from);
          if (!st) continue;
          if (ours && !m[2]) {
            newest = Math.max(newest, st.mtimeMs);
            // (its own notes of what it did, for the one list of everything)
            try { for (const l of addonNotes(fs.readFileSync(from, 'utf8'))) notes.push({ t: l.t, who, text: l.text }); } catch { /* read as a file all the same */ }
          }
          if (m[2] && !ours) continue; // (the copy from the time before: only this addon's)
          if (ours || related.has(m[1].toLowerCase())) { file(`${to}/${e.name}`, from, { skipOver: SAVED_MAX, text: true }); continue; }
          if (!include.others) { skipped++; continue; }
          if (st.size > SAVED_MAX || others + st.size > OTHERS_MAX) { left.push(`${red.name(`${to}/${e.name}`)}: ${size(st.size)}, more than is taken of other addons' saved settings`); continue; }
          others += st.size;
          file(`${to}/${e.name}`, from, { text: true });
        }
      };
      accounts.forEach((account, i) => {
        const dir = path.join(accountsDir, account), to = `game/wtf/account-${i + 1}`;
        for (const f of ['bindings-cache.wtf', 'config-cache.wtf']) file(`${to}/${f}`, path.join(dir, f), { skipOver: 1 * MB, text: true });
        saved(path.join(dir, 'SavedVariables'), `${to}/SavedVariables`, 'addon');
        for (const realm of list(dir)) {
          if (!realm.isDirectory() || realm.name === 'SavedVariables') continue;
          for (const char of list(path.join(dir, realm.name))) {
            if (!char.isDirectory()) continue;
            const cdir = path.join(dir, realm.name, char.name), cto = `${to}/${realm.name}/${char.name}`;
            for (const f of ['AddOns.txt', 'config-cache.wtf']) file(`${cto}/${f}`, path.join(cdir, f), { skipOver: 1 * MB, text: true });
            saved(path.join(cdir, 'SavedVariables'), `${cto}/SavedVariables`, `addon, ${char.name}`);
          }
        }
      });
      if (skipped) left.push(`what ${skipped} other file${skipped === 1 ? '' : 's'} of saved addon settings hold: only this addon's and those of the addons it works with are taken, unless you tick "every addon's saved settings"`);
      if (newest) summary.push(`The addon last saved its settings and notes ${ago(newest)} (the game writes them when you log out or type /reload)`);
    });
    await part('the game\'s logs', () => {
      const dir = path.join(gameDir, 'Logs');
      let n = 0;
      for (const e of list(dir)) if (e.isFile() && GAME_LOGS.test(e.name) && stat(path.join(dir, e.name))?.size) { file(`game/logs/${e.name}`, path.join(dir, e.name), { max: LOG_TAIL, text: true }); n++; }
      add('game/logs/all-of-them.txt', `Only the logs about the game and its addons are taken (${n} here). Every file in the folder:\n\n${list(dir).map((e) => { const st = stat(path.join(dir, e.name)); return `${e.isDirectory() ? ' (folder)' : String(st?.size ?? '?').padStart(11)}  ${st?.mtime.toISOString() ?? ''}  ${e.name}`; }).join('\n')}\n`);
    });
    await part('the game\'s crash reports', () => {
      const dir = path.join(gameDir, 'Errors');
      const all = list(dir).filter((e) => e.isFile()).map((e) => ({ name: e.name, st: stat(path.join(dir, e.name)) })).filter((e) => e.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      if (!all.length) return;
      add('game/errors/all-of-them.txt', `The newest ${CRASHES} reports are taken (their beginning: what stopped, and where). The dumps beside them are not.\n\n${all.map((e) => `${String(e.st.size).padStart(11)}  ${e.st.mtime.toISOString()}  ${e.name}`).join('\n')}\n`);
      for (const e of all.filter((x) => /\.txt$/i.test(x.name)).slice(0, CRASHES)) file(`game/errors/${e.name}`, path.join(dir, e.name), { max: CRASH_HEAD, end: false, text: true });
    });
    await part('the game\'s cache', () => {
      const dir = path.join(gameDir, 'Cache');
      if (!include.cache) left.push('the game\'s cache of what the server told it (creatures, objects, quests): you chose to leave it out');
      else for (const lang of list(path.join(dir, 'WDB'))) if (lang.isDirectory()) for (const e of list(path.join(dir, 'WDB', lang.name))) if (e.isFile() && /\.wdb$/i.test(e.name)) file(`game/cache/WDB/${lang.name}/${e.name}`, path.join(dir, 'WDB', lang.name, e.name), { skipOver: CACHE_MAX });
      for (const lang of list(path.join(dir, 'ADB'))) {
        if (!lang.isDirectory()) continue;
        const f = path.join(dir, 'ADB', lang.name, 'DBCache.bin');
        if (!exists(f)) continue;
        if (include.hotfixes) file(`game/cache/ADB/${lang.name}/DBCache.bin`, f, { skipOver: HOTFIX_MAX });
        else left.push(`game/cache/ADB/${lang.name}/DBCache.bin (${size(stat(f)?.size ?? 0)}): the game's hotfixes, taken only when you tick them`);
      }
    });
  }

  // ---- this computer (asked above) ----
  await part('this computer', async () => {
    const w = await windows;
    const programs = Array.isArray(w.programs) ? w.programs : null;
    delete w.programs;
    add('computer/system.json', {
      ...w,
      asNodeSeesIt: { platform: process.platform, release: os.release(), version: os.version?.() ?? null, arch: process.arch, processors: [...new Set(os.cpus().map((c) => c.model.trim()))], threads: os.cpus().length, memory: os.totalmem(), memoryFree: os.freemem(), upFor: `${Math.round(os.uptime() / 60)} min` },
      clock: { now: new Date().toISOString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset(), locale: Intl.DateTimeFormat().resolvedOptions().locale },
    });
    if (programs) add('computer/programs-running.txt', `The names of the programs running when the report was made (an overlay or a capture program can be in the strip's way):\n\n${programs.join('\n')}\n`);
    if (w.error) trouble.push(`this computer: ${w.error}`);
    else summary.push(`${w.windows?.name ?? 'Windows'} ${w.windows?.release ?? ''} (build ${w.windows?.build ?? '?'}); ${(w.processors ?? []).map((p) => p.name).join(', ')}; ${size(w.computer?.memory ?? 0)} of memory; ${(w.graphics ?? []).map((g) => `${g.name} (driver ${g.driver})`).join(', ')}`);
  });

  // ---- everything that was noted, as one list ----
  await part('the one list of everything', () => {
    const since = Date.now() - TIMELINE_HOURS * 3600 * 1000;
    const lines = [], seen = new Set();
    const take = (text, who) => {
      for (const l of text.split('\n')) {
        const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (\S*)\s+(.*)$/.exec(l);
        const t = m ? Date.parse(m[1]) : NaN;
        if (!(t >= since)) continue;
        const key = `${who}|${l}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({ t, who, about: m[2], text: m[3] });
      }
    };
    for (const e of entries) {
      if (/^atlas\/logs\/events(\.1)?\.log$/.test(e.name)) take(e.data.toString('utf8'), 'server');
      else if (/^atlas\/logs\/page(\.1)?\.log$/.test(e.name) || e.name === 'atlas/page/notes.txt') take(e.data.toString('utf8'), 'page');
    }
    for (const n of notes) if (n.t >= since) lines.push({ t: n.t, who: n.who, about: '', text: n.text });
    lines.sort((a, b) => a.t - b.t);
    const shown = lines.slice(-TIMELINE_LINES);
    const local = (t) => { const d = new Date(t), p = (v, n = 2) => String(v).padStart(n, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };
    add('timeline.txt', `Everything that was noted in the ${TIMELINE_HOURS} hours before the report, in the order it happened, by this computer's clock.\n"server": Azeroth Atlas behind its window. "page": the map itself. "addon": the addon in the game, as of the last time the game\nwrote down what it had saved (a /reload or a logout): whatever it noted after that is not here yet.\n\n${shown.map((l) => `${local(l.t)}  ${l.who.padEnd(7)} ${l.about.padEnd(8)} ${l.text}`).join('\n')}\n`);
    summary.push(`${shown.length} things noted in the last ${TIMELINE_HOURS} hours (timeline.txt), ${notes.length} of the addon's own notes found`);
  });

  // ---- what you wrote, and what is in here ----
  const said = String(ask.text ?? '').trim();
  const when = String(ask.when ?? '').trim();
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  const text = [
    'Azeroth Atlas: a report of a problem',
    `Made ${new Date().toString()}`,
    '',
    'WHAT WENT WRONG, AS REPORTED',
    said || '(nothing was written)',
    ...(when ? ['', `When: ${when}`] : []),
    '',
    'IN SHORT',
    ...summary.map((s) => `- ${s}`),
    ...(trouble.length ? ['', 'COULD NOT BE GATHERED', ...trouble.map((s) => `- ${s}`)] : []),
    ...(left.length ? ['', 'LEFT OUT', ...left.map((s) => `- ${s}`)] : []),
    '',
    'NEVER IN A REPORT',
    '- account names (an account\'s folder is "account-1" here), passwords, e-mail addresses, the Windows user name, the computer\'s name',
    '- the game\'s chat and combat logs, macros, crash dumps, and anything of the game itself',
    '',
    `IN THIS FILE (${entries.length + 1} files, ${size(total)} before packing)`,
    ...entries.map((e) => `${String(e.data.length).padStart(10)}  ${e.name}${e.note ? `   (${e.note})` : ''}`),
    '',
  ].join('\n');
  const all = [{ name: 'report.txt', data: Buffer.from(red.text(text), 'utf8'), at: new Date(), note: '' }, ...entries];
  const packed = zip(all);
  const d = new Date(), p = (v) => String(v).padStart(2, '0');
  const name = `Azeroth-Atlas-report-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
  const seconds = Math.round((Date.now() - began) / 100) / 10;
  note('report', `a report was made: ${all.length} files, ${size(packed.length)}`, { seconds, left: left.length, trouble });
  return { zip: packed, name, entries: all.map((e) => ({ name: e.name, bytes: e.data.length, note: e.note })), left, trouble, seconds };
}

/** When the game last wrote down what the addon had saved (its settings, and its notes of what it did): { savedAt (ms) | null, game (its folder is known) }. */
export function addonSaved(cfg) {
  const flavour = cfg ? flavourFolder(cfg) : null;
  if (!flavour) return { savedAt: null, game: false };
  const root = path.join(cfg.installRoot, flavour, 'WTF', 'Account');
  let newest = 0;
  const look = (dir) => { const st = stat(path.join(dir, 'SavedVariables', `${ADDON}.lua`)); if (st) newest = Math.max(newest, st.mtimeMs); };
  for (const account of list(root)) {
    if (!account.isDirectory() || account.name === 'SavedVariables') continue;
    look(path.join(root, account.name));
    for (const realm of list(path.join(root, account.name))) if (realm.isDirectory() && realm.name !== 'SavedVariables') for (const char of list(path.join(root, account.name, realm.name))) if (char.isDirectory()) look(path.join(root, account.name, realm.name, char.name));
  }
  return { savedAt: newest || null, game: true };
}

// ---- asked for by the page ---------------------------------------------------------------------------
/** Everything a request brought, read whole: a Buffer. */
function readAll(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); reject(new Error('too much sent')); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export class Reports {
  /**
   * @param ctx  as for buildReport (its `live` may change as the server gets going: it is read when a
   *             report is asked for), and `busy(on)`: told while a report is being made and handed over,
   *             so that the server is not started again in the middle of it
   */
  constructor(ctx) { this.ctx = ctx; this.busy = false; }

  /** One of this module's requests? Answered, and true; false: not one of them. */
  handle(req, res, url, p) {
    if (p === '/api/log') {
      // what the page noted, sent on as it goes (viewer/js/log.js)
      if (req.method !== 'POST' || !ownPage(req)) { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return true; }
      readAll(req, 1 * MB).then((body) => { let n = 0; try { n = notePage(JSON.parse(body.toString('utf8')).lines); } catch { /* not lines: nothing noted */ } json(res, 200, { noted: n }); }, () => { res.writeHead(413); res.end(); });
      return true;
    }
    if (p === '/api/report/check') {
      // for the page's form: is the game being heard from, and how long ago did the addon have its notes written down
      const t = this.ctx.live?.tracker;
      json(res, 200, { ...addonSaved(this.ctx.cfg ?? null), heard: t ? t.state.status === 'live' : false, logs: logsDir() });
      return true;
    }
    if (p === '/api/report') {
      if (req.method !== 'POST' || !ownPage(req)) { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return true; }
      if (this.busy) { json(res, 409, { error: 'a report is being made already' }); return true; }
      this.busy = true;
      // (until the page has it, or has gone: an update of the map tool waits that long with starting the server again)
      const done = () => { if (!this.busy) return; this.busy = false; try { this.ctx.busy?.(false); } catch { /* nobody to tell */ } };
      try { this.ctx.busy?.(true); } catch { /* nobody to tell */ }
      res.once('close', done);
      readAll(req, BODY_MAX)
        .then((body) => buildReport(this.ctx, body.length ? JSON.parse(body.toString('utf8')) : {}))
        .then((r) => {
          // (what is in it, in a few words, for the page to say: the file itself is the answer)
          const about = { files: r.entries.length, bytes: r.zip.length, left: r.left.slice(0, 12), trouble: r.trouble.slice(0, 12), seconds: r.seconds };
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': r.zip.length, 'content-disposition': `attachment; filename="${r.name}"`, 'x-report-name': r.name, 'x-report': encodeURIComponent(JSON.stringify(about)), 'cache-control': 'no-store' });
          res.end(r.zip, done);
        })
        .catch((err) => { note('report', 'a report could not be made', { error: err.message }); if (!res.headersSent) json(res, 500, { error: err.message }); else res.destroy(); done(); });
      return true;
    }
    return false;
  }
}

// ---- from a terminal: node server/report.js --out=report.zip [--text="..."] [--config=...] ------------
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const configFile = arg('config') ? path.resolve(arg('config')) : CONFIG_FILE;
  let cfg = null, problem = null;
  try { cfg = loadConfig(configFile); } catch (err) { problem = err; }
  openLogs(logDir(configFile)); // (the notes there are, to be taken; and that a report was made is one more)
  const r = await buildReport({ configFile, cfg, problem }, { text: arg('text') ?? '', when: arg('when') ?? '' });
  const out = path.resolve(arg('out') ?? r.name);
  fs.writeFileSync(out, r.zip);
  console.log(`${out}  (${r.entries.length} files, ${size(r.zip.length)})`);
  for (const t of r.trouble) console.log(`  could not be gathered: ${t}`);
}
