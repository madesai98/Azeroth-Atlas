// QuestieDB, taken into the Atlas database whenever a new version of it is out.
//
// QuestieDB (github.com/Questie/QuestieDB) is the community's database of this game's creatures,
// objects and quests, published as an addon. The map is built from it: who stands where, the
// spawn zones, the quests. It used to be read from the addon in each player's own game folder,
// so everyone had to have it installed, and kept up to date, for the map's sake. Now the
// scheduled function (index.js) looks once an hour whether a new version is out, and if so puts
// the files the map reads into the database, as they are; a copy of the map fetches them from
// there (atlasdb/questiedb.js) and reads them as before (extractor/questie.js). This is the only
// place QuestieDB is fetched from where it is published.
//
// It keeps nothing of its own: what is in the database says which version that is.
//
//   /questie/meta           what is there: { v, tag, version, contract, mode, flavor, commit, asset,
//                           sha256 (of the zip it came in), from, at, bytes, counts: { npc, quest,
//                           object, item }, files: { f<n>: { path, size, sha1, parts } } }
//   /questie/data/<sha1>    one file, by the fingerprint of what is in it: gzipped, written as
//                           base64, in pieces p0, p1, ... of at most PART characters (the
//                           database takes no piece of text over 10 MB, and compresses nothing)
//   /questie/check          the last look: { at, tag, same | imported | error }
//   /questie/pending        the files of an import that is under way (a run that broke off in
//                           the middle is tidied up after by the next)
//
// The files are QuestieDB's own, unchanged, with its licence beside them (LICENSE.md,
// gpl-3.0.md): the Questie team lets its work be copied under the GPL version 3.
//
// It needs only a database it can read and write ({ get(path), set(path, value), remove(path) }:
// index.js makes one) and the web.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const REPOSITORY = 'https://github.com/Questie/QuestieDB';
const NOTE = `${REPOSITORY}/releases/latest/download/release.json`; // what the latest release is made of (it leads on to that release's own copy of the file)
const API = 'https://api.github.com/repos/Questie/QuestieDB/releases/latest'; // the same asked of GitHub's API, should that file ever be gone
const AGENT = 'azeroth-atlas';
const FLAVOUR = 'Forever';
const TOC = `QuestieDB_${FLAVOUR}.toc`;
const V = 1;                // how this is laid out in the database
export const PART = 4 << 20; // characters to one piece of a file
const LARGEST = 200 << 20;  // a zip bigger than this is not what is expected
const FEWER = 0.5;          // a version with less than this much of what the last had is taken for broken

/** The files of the addon that are taken: the data file of this game, what it keeps beside it, the names the support files use, and the licence. */
const WANTED = [
  new RegExp(`^${TOC.replace('.', '\\.')}$`),
  new RegExp(`^support/${FLAVOUR}/[\\w./-]+$`),
  /^src\/corrections\/enum\/[\w.-]+\.lua$/,
  /^(LICENSE|CHANGELOG|PROVENANCE)\.md$/,
  /^gpl-3\.0\.md$/,
];
/** A path as it may be written to a disk: plain names with / between them, none beginning with a dot. */
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/**
 * The files in a zip: [{ name, size, read() → Buffer }]. Only what a release of an addon needs:
 * stored or deflated files, no encryption, under 4 GB.
 */
export function unzip(buf) {
  // the record at the end: the last 22 bytes, or further back where the zip carries a comment
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10), dirAt = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirAt === 0xffffffff) throw new Error('a zip of a kind that is not read here (zip64)');
  const out = [];
  let p = dirAt;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip\'s list of files is damaged');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), packed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.push({
      name, size,
      read() {
        if (flags & 1) throw new Error(`${name}: encrypted`);
        if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`${name}: not where the zip says it is`);
        const from = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
        if (from + packed > buf.length) throw new Error(`${name}: cut short`);
        const body = buf.subarray(from, from + packed);
        const data = method === 0 ? Buffer.from(body) : method === 8 ? zlib.inflateRawSync(body) : null;
        if (!data) throw new Error(`${name}: packed in a way that is not read here (method ${method})`);
        if (data.length !== size) throw new Error(`${name}: ${data.length} bytes where the zip says ${size}`);
        if (typeof zlib.crc32 === 'function' && zlib.crc32(data) !== crc) throw new Error(`${name}: damaged (its checksum does not fit)`);
        return data;
      },
    });
  }
  return out;
}

async function ask(fetch, url, { ms = 30000, redirect = 'follow', accept } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': AGENT, ...(accept ? { Accept: accept } : {}) }, redirect, signal: ctl.signal });
    // (asked only where it leads: what it would say itself is not waited for)
    if (redirect === 'manual') { try { await res.body?.cancel(); } catch { /* nothing to let go of */ } return { status: res.status, headers: res.headers, body: null }; }
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    throw new Error(`${url.split('?')[0]}: ${ctl.signal.aborted ? `no answer within ${ms / 1000} s` : err.cause?.message || err.message}`);
  } finally { clearTimeout(timer); }
}

const name = (s) => (typeof s === 'string' && /^[\w.+-]{1,120}$/.test(s) ? s : null);

/**
 * The latest release, and where its files for this game are.
 * @returns {{ tag, version, contract, commit, asset, sha256, bytes, url }} (contract, commit, sha256, bytes: null where the release does not say)
 */
export async function latest(fetch) {
  let why = '';
  try {
    // The address of "the latest release's release.json" leads on to that release's own: which release that is, is in where it leads.
    const hop = await ask(fetch, NOTE, { redirect: 'manual' });
    const to = hop.headers.get('location') ?? '';
    const tag = name(/\/releases\/download\/([^/]+)\/release\.json$/.exec(to)?.[1]);
    if (hop.status < 300 || hop.status >= 400 || !tag) throw new Error(`release.json: HTTP ${hop.status}, leading ${to ? `to ${to.slice(0, 120)}` : 'nowhere'}`);
    const res = await ask(fetch, to);
    if (res.status !== 200) throw new Error(`release.json of ${tag}: HTTP ${res.status}`);
    const q = JSON.parse(res.body.toString('utf8')).questiedb ?? {};
    const a = (Array.isArray(q.artifacts) ? q.artifacts : []).find((x) => x?.flavor === FLAVOUR);
    const asset = name(a?.file);
    if (!asset || !/\.zip$/i.test(asset)) throw new Error(`release.json of ${tag} names no files for ${FLAVOUR}`);
    return {
      tag, version: name(q.version) ?? tag.replace(/^v/, ''), contract: Number.isInteger(q.contractVersion) ? q.contractVersion : null, commit: name(q.producerCommit),
      asset, sha256: /^[0-9a-f]{64}$/.test(a.sha256 ?? '') ? a.sha256 : null, bytes: Number.isInteger(a.bytes) ? a.bytes : null,
      url: `${REPOSITORY}/releases/download/${tag}/${asset}`,
    };
  } catch (err) { why = err.message; }
  // (GitHub's API says the same, in its own words; it answers a computer in the cloud less reliably, which is why it is asked second)
  const res = await ask(fetch, API, { accept: 'application/vnd.github+json' });
  if (res.status !== 200) throw new Error(`the latest release could not be found (${why}; GitHub's API: HTTP ${res.status})`);
  const r = JSON.parse(res.body.toString('utf8'));
  const tag = name(r.tag_name);
  const a = (Array.isArray(r.assets) ? r.assets : []).find((x) => new RegExp(`-${FLAVOUR}\\.zip$`).test(x?.name ?? ''));
  const asset = name(a?.name);
  if (!tag || !asset) throw new Error(`the latest release has no files for ${FLAVOUR} (${why})`);
  return {
    tag, version: tag.replace(/^v/, ''), contract: null, commit: name(r.target_commitish),
    asset, sha256: /^sha256:[0-9a-f]{64}$/.test(a.digest ?? '') ? a.digest.slice(7) : null, bytes: Number.isInteger(a.size) ? a.size : null,
    url: `${REPOSITORY}/releases/download/${tag}/${asset}`,
  };
}

/** What the data file says of itself, and how much is in it. */
export function describe(toc) {
  const head = toc.toString('utf8', 0, Math.min(toc.length, 16384));
  const said = (key) => new RegExp(`^## ${key}:\\s*(.*)$`, 'm').exec(head)?.[1].trim() ?? null;
  const text = toc.toString('latin1');
  const counts = {};
  for (const [kind, word] of [['npc', 'Npc'], ['quest', 'Quest'], ['object', 'Object'], ['item', 'Item']]) {
    let n = 0;
    for (const _ of text.matchAll(new RegExp(`^## X-${word}-\\d+-S: `, 'gm'))) n++;
    counts[kind] = n;
  }
  return { version: said('Version'), contract: said('X-Contract-Version'), mode: said('X-Mode'), flavor: said('X-Flavor'), commit: said('X-BUILD-COMMIT'), counts };
}

/** One file as it goes into the database: its fingerprint, and its pieces. */
export function pack(data) {
  const text = zlib.gzipSync(data, { level: 9 }).toString('base64');
  const pieces = {};
  for (let i = 0; i * PART < text.length; i++) pieces[`p${i}`] = text.slice(i * PART, (i + 1) * PART);
  return { sha1: crypto.createHash('sha1').update(data).digest('hex'), size: data.length, parts: Object.keys(pieces).length, pieces };
}

/**
 * Look whether a newer QuestieDB is out, and if so put it into the database.
 * @param force  put in what is out even if the database has it already
 * @returns {{ tag, version, same: true } | { tag, version, imported: number of files written, kept, bytes, written }}
 */
export async function lookAndImport(db, { log = () => {}, fetch = globalThis.fetch, now = () => Date.now(), force = false } = {}) {
  const meta = (await db.get('questie/meta')) ?? null;
  const have = new Map(); // fingerprint → pieces, of what the database is known to hold
  for (const f of Object.values(meta?.files ?? {})) if (f?.sha1) have.set(f.sha1, f.parts ?? 1);
  const takeApart = async (sha1, parts) => { for (let i = 0; i < parts; i++) await db.remove(`questie/data/${sha1}/p${i}`); };
  // what a run that broke off left behind
  const pending = await db.get('questie/pending');
  if (pending && typeof pending === 'object') {
    for (const [sha1, parts] of Object.entries(pending)) if (/^[0-9a-f]{40}$/.test(sha1) && !have.has(sha1)) await takeApart(sha1, Number(parts) || 1);
    await db.remove('questie/pending');
  }
  try {
    const rel = await latest(fetch);
    if (!force && meta?.v === V && meta.tag === rel.tag && (!rel.sha256 || meta.sha256 === rel.sha256)) {
      await db.set('questie/check', { at: now(), tag: rel.tag, same: true });
      return { tag: rel.tag, version: meta.version, same: true };
    }
    log(`QuestieDB ${rel.version} is out (the database has ${meta?.version ?? 'none'}): fetching ${rel.asset}`);
    const got = await ask(fetch, rel.url, { ms: 240000 });
    if (got.status !== 200) throw new Error(`${rel.asset}: HTTP ${got.status}`);
    const zip = got.body;
    if (zip.length > LARGEST) throw new Error(`${rel.asset}: ${(zip.length / 1e6).toFixed(0)} MB, far more than expected`);
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    if (rel.sha256 && sha256 !== rel.sha256) throw new Error(`${rel.asset}: not the file the release says it is (damaged on the way?)`);
    // the files wanted, each under the name it has inside the addon's folder
    const files = [];
    for (const e of unzip(zip)) {
      const rel2 = e.name.replace(/^QuestieDB\//, '');
      if (e.name.endsWith('/') || rel2 === e.name || !PLAIN.test(rel2) || !WANTED.some((re) => re.test(rel2))) continue;
      files.push({ path: rel2, entry: e });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const main = files.find((f) => f.path === TOC);
    if (!main) throw new Error(`${rel.asset} holds no ${TOC}`);
    const toc = main.entry.read();
    const d = describe(toc);
    if (d.flavor !== FLAVOUR) throw new Error(`${TOC} is for "${d.flavor}", not ${FLAVOUR}`);
    if (!d.counts.npc || !d.counts.quest) throw new Error(`${TOC} holds no creatures or no quests (written in mode "${d.mode}", contract ${d.contract})`);
    for (const kind of ['npc', 'quest', 'object']) {
      const before = meta?.counts?.[kind] ?? 0;
      if (!force && d.counts[kind] < before * FEWER) throw new Error(`QuestieDB ${rel.version} has ${d.counts[kind].toLocaleString('en')} ${kind} records where ${meta.version} had ${before.toLocaleString('en')}: taken for broken and left out`);
    }
    // into the database: the files it does not hold yet first, then the note that says what is there, then out with what is no longer part of it
    const listed = {}, fresh = [];
    let bytes = 0, written = 0, kept = 0;
    files.forEach((f, i) => {
      const p = pack(f === main ? toc : f.entry.read());
      listed[`f${i}`] = { path: f.path, size: p.size, sha1: p.sha1, parts: p.parts };
      bytes += p.size;
      if (have.has(p.sha1) && !force) kept++;
      else if (!fresh.some((x) => x.sha1 === p.sha1)) fresh.push(p);
    });
    if (fresh.length) await db.set('questie/pending', Object.fromEntries(fresh.map((p) => [p.sha1, p.parts])));
    for (const p of fresh) {
      for (const [key, text] of Object.entries(p.pieces)) { await db.set(`questie/data/${p.sha1}/${key}`, text); written += text.length; }
    }
    const next = {
      v: V, tag: rel.tag, version: d.version ?? rel.version, contract: Number(d.contract) || rel.contract || null, mode: d.mode, flavor: d.flavor,
      commit: d.commit ?? rel.commit ?? null, asset: rel.asset, sha256, from: REPOSITORY, at: now(), bytes, counts: d.counts, files: listed,
    };
    await db.set('questie/meta', next);
    const still = new Set(Object.values(listed).map((f) => f.sha1));
    for (const [sha1, parts] of have) if (!still.has(sha1)) await takeApart(sha1, parts);
    await db.remove('questie/pending');
    await db.set('questie/check', { at: now(), tag: rel.tag, imported: fresh.length });
    log(`QuestieDB ${next.version}: ${d.counts.npc.toLocaleString('en')} creatures, ${d.counts.object.toLocaleString('en')} objects, ${d.counts.quest.toLocaleString('en')} quests, ${d.counts.item.toLocaleString('en')} items; ${files.length} files (${(bytes / 1e6).toFixed(1)} MB), ${fresh.length} of them new (${(written / 1e6).toFixed(1)} MB written)`);
    return { tag: rel.tag, version: next.version, imported: fresh.length, kept, bytes, written };
  } catch (err) {
    // (said in the database too, where whoever looks after it can see it without the cloud's logs)
    try { await db.set('questie/check', { at: now(), tag: meta?.tag ?? null, error: String(err.message).slice(0, 400) }); } catch { /* the database itself is the trouble */ }
    throw err;
  }
}
