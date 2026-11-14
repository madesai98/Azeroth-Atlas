// The map tool keeping itself current.
//
// Whoever has a copy of the map tool has one of two kinds, and each is brought up to date in
// its own way, from the place the copy came from:
//
//   a git checkout   (there is a .git folder)   git fetch, then a fast-forward to what was
//                    fetched. Only that: a copy with changes of its own, or with commits of
//                    its own, is left exactly as it is and says so.
//   a plain folder   (unpacked from a zip)      the newest commit of the repository named in
//                    package.json ("repository") is asked for from GitHub; if it is not the one
//                    this copy was last brought up to, its files are downloaded as one zip and
//                    the ones that differ are written. Files that were part of the map tool
//                    and no longer are, are removed.
//
// Either way only the map tool's own files are touched. What is yours stays: config.json, the
// map data, the notes of where you have seen NPCs stand, the addon in the game's folder (the
// page offers "Update addon" when the one in the game is older than the one here).
//
// Nothing has to be restarted afterwards: the server starts itself again when its own code
// changes (server/watch.js) and the page loads itself again when its files do (changes.js).
// While files are being written the watcher is asked to wait, so that it does not start a
// server that is half old and half new.
//
// It looks when the server starts and every few hours after, never in the middle of a map
// build. "autoUpdate": false in config.json makes it only say that there is something newer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

const CHECK_EVERY = 6 * 3600 * 1000;  // how often it looks while the map is running
const NOT_AGAIN_FOR = 30 * 60 * 1000; // a start of the server soon after a look does not look again
const HELD_RETRY = 5 * 60 * 1000;     // something was in the way (a map build): tried again after this
const AGENT = 'wow-forever-3d-map';
const NO_SOURCE = 'This copy does not say where it came from (no "repository" in package.json): it cannot look for a newer one.';
/** Never written and never removed by an update, whatever a download holds. */
const YOURS = [/^config\.json$/i, /^data(\/|$)/i, /^\.git(\/|$)/i, /^server\/\.build(\/|$)/i, /^\.app-version\.json$/i, /^node_modules(\/|$)/i, /^extractor\/dbd(\/|$)/i];
const yours = (rel) => YOURS.some((re) => re.test(rel));

/** Where a copy without git is updated from: { repo: 'owner/name', branch } out of package.json, or null. */
export function sourceOf(pkg) {
  const r = pkg?.repository;
  const url = typeof r === 'string' ? r : r?.url ?? '';
  const m = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { repo: `${m[1]}/${m[2]}`, branch: typeof pkg.updateBranch === 'string' ? pkg.updateBranch : 'main' } : null;
}

// ---- reading a zip (the files of a repository as GitHub hands them over) ------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** The files in a zip: Map<name, Buffer> (folders left out). Every file is checked against the zip's own checksum. */
export function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip file is damaged');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), packed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), noteLen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + noteLen;
    if (name.endsWith('/')) continue;
    if (packed === 0xffffffff || size === 0xffffffff || at === 0xffffffff) throw new Error('the zip file is of a kind too large to read');
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new Error('the zip file is damaged');
    const from = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(from, from + packed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: packed in a way that cannot be read`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: damaged on the way`);
    out.set(name, data);
  }
  return out;
}

const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  // (never to stop and ask for a name or a password: it runs where nobody is looking)
  execFile(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 90000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (err, stdout, stderr) => {
    if (err?.code === 'ENOENT') reject(new Error('git is not installed'));
    else if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n').pop()));
    else resolve(stdout.trim());
  });
});

export class AppUpdate {
  /**
   * @param root  the map tool's folder
   * @param opts  auto (false: only say that something newer is out), hold() (true while an update
   *              must wait: a map build is running), busy(on) (told while files are being written),
   *              api / codeload (where GitHub is: the tests name a stand-in)
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.auto = opts.auto !== false;
    this.hold = opts.hold ?? (() => false);
    this.busy = opts.busy ?? (() => {});
    this.api = opts.api ?? 'https://api.github.com';
    this.codeload = opts.codeload ?? 'https://codeload.github.com';
    this.recordFile = path.join(root, '.app-version.json');       // which commit a plain folder was last brought up to, and its files
    this.lookedFile = path.join(root, 'server', '.build', 'app-check.json'); // when it last looked, and what it found
    this.running = null;
    this.timers = [];
    this.s = { state: 'idle', available: false, canApply: false, latest: null, checkedAt: null, updated: null, error: null, note: null };
    this.commit = this.git ? null : this.#record()?.sha ?? null; // (a checkout's is read when it first looks)
    // What the last look found, kept across a start of the server (which every update of its own
    // code brings): believed for as long as this copy is still the one that look was about.
    this.looked = null;
    try { this.looked = JSON.parse(fs.readFileSync(this.lookedFile, 'utf8')); } catch { /* never looked */ }
    if (this.looked && (this.git || this.looked.commit === this.commit)) this.#believe();
    else if (this.looked) this.s.checkedAt = null; // (another copy now: it looks afresh)
    if (!this.git && !sourceOf(this.#pkg())) this.s.note = NO_SOURCE;
  }

  #believe() {
    const l = this.looked;
    Object.assign(this.s, { checkedAt: l.checkedAt ?? null, available: !!l.available, canApply: !!l.canApply, latest: l.latest ?? null, note: l.note ?? null, error: l.error ?? null, updated: l.updated ?? null });
  }

  #remember() {
    const { checkedAt, available, canApply, latest, note, error, updated } = this.s;
    try { fs.mkdirSync(path.dirname(this.lookedFile), { recursive: true }); fs.writeFileSync(this.lookedFile, JSON.stringify({ commit: this.commit, checkedAt, available, canApply, latest, note, error, updated })); } catch { /* it looks again sooner, that is all */ }
  }

  /**
   * Is this copy a git checkout? Asked every time, not once: a folder made into a repository
   * while the server runs must not go on being treated as a plain one (that would write the
   * published files over work of your own that is not committed yet).
   */
  get git() { return fs.existsSync(path.join(this.root, '.git')); }

  #pkg() { try { return JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8')); } catch { return {}; } }
  #record() { try { return JSON.parse(fs.readFileSync(this.recordFile, 'utf8')); } catch { return null; } }

  /** For the page: { version, commit, kind, from, auto, state, available, canApply, latest, checkedAt, updated, error, note } */
  status() {
    const pkg = this.#pkg(), src = sourceOf(pkg);
    return {
      version: pkg.version ?? '?', commit: this.commit ? this.commit.slice(0, 7) : null, kind: this.git ? 'git' : 'zip',
      from: this.git ? this.upstream ?? null : src ? `github.com/${src.repo}` : null, auto: this.auto,
      ...this.s, latest: this.s.latest ? this.s.latest.slice(0, 7) : null,
    };
  }

  /** Look now and from time to time. (Not straight after a look: the server is started again with every change of its code.) */
  start() {
    const soon = () => { const t = setTimeout(() => this.check(), 4000); t.unref(); this.timers.push(t); };
    const since = Date.now() - (this.s.checkedAt ?? 0);
    if (since < NOT_AGAIN_FOR) { const t = setTimeout(() => this.check(), NOT_AGAIN_FOR - since); t.unref(); this.timers.push(t); } else soon();
    const every = setInterval(() => this.check(), CHECK_EVERY);
    every.unref();
    this.timers.push(every);
    if (this.git) run('git', ['rev-parse', 'HEAD'], this.root).then((sha) => {
      this.commit = sha;
      // (the checkout has moved on since the last look - a pull by hand: what was found then no longer holds)
      if (this.looked && this.looked.commit !== sha && !this.running) { Object.assign(this.s, { available: false, canApply: false, note: null, error: null, checkedAt: null }); if (since < NOT_AGAIN_FOR) soon(); }
    }, () => {});
  }

  /**
   * Look for something newer, and bring this copy up to it.
   * @param apply  false: only look (the default is what config.json says: "autoUpdate")
   */
  check({ apply = this.auto } = {}) {
    if (this.running) return this.running;
    this.s.state = 'checking';
    this.s.error = null;
    this.running = (this.git ? this.#git(apply) : this.#zip(apply))
      .catch((err) => { this.s.error = err.message; })
      .then(() => {
        this.running = null;
        this.s.state = 'idle';
        this.s.checkedAt = Date.now();
        this.#remember();
        return this.status();
      });
    return this.running;
  }

  /** Something an update must not interrupt is going on: it is tried again in a while. */
  #held() {
    if (!this.hold()) return false;
    this.s.note = 'A newer version is out: it is put in once the map build has finished.';
    const t = setTimeout(() => this.check({ apply: true }), HELD_RETRY);
    t.unref();
    this.timers.push(t);
    return true;
  }

  #done(from, to) {
    this.commit = to;
    Object.assign(this.s, { available: false, canApply: false, note: null, updated: { from: from ? from.slice(0, 7) : null, to: to.slice(0, 7), at: Date.now() } });
  }

  // ---- a git checkout: fetch, and fast-forward where that is all it takes ----
  async #git(apply) {
    const git = (...args) => run('git', args, this.root);
    const head = await git('rev-parse', 'HEAD');
    this.commit = head;
    let up;
    try { up = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); }
    catch { Object.assign(this.s, { available: false, canApply: false, note: 'This copy is a git checkout that follows no published branch yet: there is nowhere to update from.' }); return; }
    this.upstream = up;
    await git('fetch', '--quiet', up.split('/')[0]);
    const latest = await git('rev-parse', '@{u}');
    const behind = +(await git('rev-list', '--count', 'HEAD..@{u}')), ahead = +(await git('rev-list', '--count', '@{u}..HEAD'));
    const changed = (await git('status', '--porcelain', '--untracked-files=no')) !== '';
    this.s.latest = latest;
    this.s.available = behind > 0;
    this.s.canApply = behind > 0 && !ahead && !changed;
    if (!behind) { this.s.note = ahead ? `This copy has ${ahead} commit${ahead === 1 ? '' : 's'} of its own that ${ahead === 1 ? 'is' : 'are'} not published yet.` : changed ? 'This copy has changes of its own that are not committed.' : null; return; }
    if (!this.s.canApply) { this.s.note = 'A newer version is out, but this copy has changes of its own: bring it up to date with git (git pull).'; return; }
    this.s.note = 'A newer version is out.';
    if (!apply || this.#held()) return;
    this.s.state = 'updating';
    this.busy(true);
    try { await git('merge', '--ff-only', '--quiet', '@{u}'); } finally { this.busy(false); }
    this.#done(head, latest);
  }

  // ---- a plain folder: the newest commit's files, as one zip from GitHub ----
  async #zip(apply) {
    const src = sourceOf(this.#pkg());
    if (!src) { Object.assign(this.s, { available: false, canApply: false, note: NO_SOURCE }); return; }
    const res = await fetch(`${this.api}/repos/${src.repo}/commits/${encodeURIComponent(src.branch)}`, { headers: { accept: 'application/vnd.github.sha', 'user-agent': AGENT }, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) throw new Error(`github.com/${src.repo} was not found. (A private repository can only be updated from with git: see "Updates" in README.md.)`);
    if (res.status === 403 || res.status === 429) throw new Error('GitHub has been asked too often from this network for now: it is tried again later');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(latest)) throw new Error('GitHub answered with something unexpected');
    const record = this.#record();
    this.s.latest = latest;
    this.s.available = record?.sha !== latest;
    this.s.canApply = this.s.available;
    if (!this.s.available) { this.s.note = null; return; }
    this.s.note = 'A newer version is out.';
    if (!apply || this.#held()) return;
    this.s.state = 'updating';
    const got = await fetch(`${this.codeload}/${src.repo}/zip/${latest}`, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(180000) });
    if (!got.ok) throw new Error(`the download was refused (${got.status})`);
    const next = new Map();
    for (const [name, data] of unzip(Buffer.from(await got.arrayBuffer()))) {
      const rel = name.split('/').slice(1).join('/'); // (everything is in one folder named after the commit)
      if (!rel) continue;
      // (a name that would lead out of the map tool's folder: none of it is put in)
      const full = path.resolve(this.root, rel);
      if (/\\|^\/|(^|\/)\.\.(\/|$)|^[A-Za-z]:/.test(rel) || !full.startsWith(this.root + path.sep)) throw new Error(`the download holds a file where none belongs (${name}): nothing was changed`);
      if (!yours(rel)) next.set(rel, data);
    }
    if (!next.has('package.json') || !next.has('server/server.js') || !next.has('viewer/index.html')) throw new Error('the download does not look like the map tool: nothing was changed');
    this.busy(true);
    try {
      for (const [rel, data] of next) {
        const full = path.join(this.root, rel);
        let same = false;
        try { same = fs.readFileSync(full).equals(data); } catch { /* new */ }
        if (same) continue;
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full + '.new', data);
        fs.renameSync(full + '.new', full);
      }
      // (what was part of the map tool as it was last put in, and no longer is)
      for (const rel of record?.files ?? []) if (!next.has(rel) && !yours(rel)) { try { fs.rmSync(path.join(this.root, rel)); } catch { /* gone already */ } }
      fs.writeFileSync(this.recordFile, JSON.stringify({ sha: latest, at: new Date().toISOString(), from: `github.com/${src.repo}`, files: [...next.keys()].sort() }, null, 1));
    } finally { this.busy(false); }
    this.#done(record?.sha ?? null, latest);
  }

  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}
