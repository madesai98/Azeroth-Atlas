// Read-only access to a locally installed Blizzard CASC storage (the game's own archives).
// Nothing here ever writes to the game directory.
//
// All large lookup tables live in SharedArrayBuffers so worker threads can attach to the
// same storage (Casc.fromShared) without re-reading or duplicating ~300 MB of index data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeBLTE } from './blte.js';
import { Root } from './root.js';

function parseConfig(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(' = ');
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 3);
  }
  return out;
}

/** Parse the pipe-delimited .build.info table at the install root. */
export function readBuildInfo(installRoot) {
  const text = fs.readFileSync(path.join(installRoot, '.build.info'), 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split('|').map((c) => c.split('!')[0]);
  return lines.slice(1).map((l) => {
    const v = l.split('|');
    const row = {};
    cols.forEach((c, i) => (row[c] = v[i]));
    return row;
  });
}

/** Cheap check of which build is installed (no archive access). */
export function installedBuild(installRoot, product) {
  const rows = readBuildInfo(installRoot);
  const row = rows.find((r) => r.Product === product) ?? rows.find((r) => r.Active === '1');
  if (!row) throw new Error(`Product ${product} not found in ${path.join(installRoot, '.build.info')}`);
  return { product: row.Product, version: row.Version, buildKey: row['Build Key'], cdnKey: row['CDN Key'] };
}

function toShared(buf) {
  const sab = new SharedArrayBuffer(buf.length);
  const out = Buffer.from(sab);
  buf.copy(out);
  return out;
}

export class Casc {
  /**
   * Open the storage and load all lookup tables (main thread).
   * @param {string} installRoot  e.g. "C:/Program Files (x86)/World of Warcraft"
   * @param {string} product      e.g. "wowf"
   */
  constructor(installRoot, product, shared = null) {
    this.fds = new Map();
    if (shared) {
      Object.assign(this, shared.plain);
      this.idx = shared.idx;
      this.enc = { ...shared.enc, buf: Buffer.from(shared.encBuf) };
      this._root = Root.fromShared(shared.root);
      return;
    }
    this.installRoot = installRoot;
    this.dataDir = path.join(installRoot, 'Data');
    this.build = installedBuild(installRoot, product);
    const key = this.build.buildKey;
    this.buildConfig = parseConfig(fs.readFileSync(path.join(this.dataDir, 'config', key.slice(0, 2), key.slice(2, 4), key), 'utf8'));
    this.#loadIndices();
    this.#loadEncoding();
  }

  static fromShared(shared) {
    return new Casc(null, null, shared);
  }

  /** Structured-cloneable handle for worker threads. */
  share() {
    return {
      plain: { installRoot: this.installRoot, dataDir: this.dataDir, build: this.build, buildConfig: this.buildConfig },
      idx: this.idx,
      enc: { pageSize: this.enc.pageSize, pageCount: this.enc.pageCount, indexStart: this.enc.indexStart, pagesStart: this.enc.pagesStart },
      encBuf: this.enc.buf.buffer,
      root: this.root.share(),
    };
  }

  #loadIndices() {
    const dir = path.join(this.dataDir, 'data');
    // Keep only the newest version of each of the 16 buckets.
    const newest = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.idx')) continue;
      const bucket = name.slice(0, 2);
      const ver = parseInt(name.slice(2, 10), 16);
      const cur = newest.get(bucket);
      if (!cur || ver > cur.ver) newest.set(bucket, { ver, name });
    }
    const files = [...newest.values()].map(({ name }) => fs.readFileSync(path.join(dir, name)));
    let total = 0;
    const spans = files.map((buf) => {
      const headerHashSize = buf.readUInt32LE(0);
      if (buf[12] !== 4 || buf[13] !== 5 || buf[14] !== 9) throw new Error('Unexpected .idx entry layout');
      const pos = (8 + headerHashSize + 0x0f) & ~0x0f;
      const n = Math.floor(buf.readUInt32LE(pos) / 18);
      total += n;
      return { buf, start: pos + 8, n };
    });
    // 9-byte key split into a 32-bit prefix and 40-bit suffix for fast numeric compares.
    const hi = new Uint32Array(total), lo = new Float64Array(total), loc = new Float64Array(total), size = new Uint32Array(total);
    let k = 0;
    for (const { buf, start, n } of spans) {
      for (let i = 0, p = start; i < n; i++, p += 18) {
        hi[k] = buf.readUInt32BE(p);
        lo[k] = buf.readUIntBE(p + 4, 5);
        const top = buf[p + 9], rest = buf.readUInt32BE(p + 10);
        loc[k] = ((top << 2) | (rest >>> 30)) * 0x40000000 + (rest & 0x3fffffff);
        size[k] = buf.readUInt32LE(p + 14);
        k++;
      }
    }
    const order = new Uint32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    order.sort((a, b) => hi[a] - hi[b] || lo[a] - lo[b]);
    const mk = (Type, n) => new Type(new SharedArrayBuffer(Type.BYTES_PER_ELEMENT * n));
    const sHi = mk(Uint32Array, total), sLo = mk(Float64Array, total), sLoc = mk(Float64Array, total), sSize = mk(Uint32Array, total);
    for (let i = 0; i < total; i++) {
      const j = order[i];
      sHi[i] = hi[j]; sLo[i] = lo[j]; sLoc[i] = loc[j]; sSize[i] = size[j];
    }
    this.idx = { hi: sHi, lo: sLo, loc: sLoc, size: sSize, count: total };
  }

  #findEKey(ekey) {
    const { hi, lo, count } = this.idx;
    const h = ekey.readUInt32BE(0), l = ekey.readUIntBE(4, 5);
    // Lower bound: the index can hold several (stale) entries per key; the first one is current.
    let a = 0, b = count;
    while (a < b) {
      const m = (a + b) >> 1;
      if ((hi[m] - h || lo[m] - l) < 0) a = m + 1; else b = m;
    }
    return a < count && hi[a] === h && lo[a] === l ? a : -1;
  }

  #fd(archive) {
    let fd = this.fds.get(archive);
    if (fd === undefined) {
      fd = fs.openSync(path.join(this.dataDir, 'data', `data.${String(archive).padStart(3, '0')}`), 'r');
      this.fds.set(archive, fd);
    }
    return fd;
  }

  close() {
    for (const fd of this.fds.values()) fs.closeSync(fd);
    this.fds.clear();
  }

  /** True if the encoded file is present in local storage. */
  hasEKey(ekey) {
    return this.#findEKey(ekey) >= 0;
  }

  /** Read the raw BLTE blob for an encoding key. */
  readRawByEKey(ekey) {
    const first = this.#findEKey(ekey);
    if (first < 0) return null;
    const { hi, lo, loc, size, count } = this.idx;
    // The index may list a blob twice (once at its 30-byte record header, once directly at the
    // BLTE data) and may keep stale entries. An encoding key is by definition the MD5 of the
    // BLTE header (or of the whole blob when it has no chunk table), so verify each candidate
    // and never return data that does not hash to the requested key.
    for (let i = first; i < count && hi[i] === hi[first] && lo[i] === lo[first]; i++) {
      const archive = Math.floor(loc[i] / 0x40000000), offset = loc[i] % 0x40000000;
      const n = size[i];
      if (n < 8) continue;
      const buf = Buffer.allocUnsafe(n);
      let got;
      try { got = fs.readSync(this.#fd(archive), buf, 0, n, offset); } catch { continue; }
      if (got !== n) continue;
      for (const start of [30, 0]) {
        if (start + 8 > n || buf.readUInt32BE(start) !== 0x424c5445) continue;
        const blob = buf.subarray(start);
        const headerSize = blob.readUInt32BE(4);
        const hashed = headerSize > 0 ? blob.subarray(0, Math.min(headerSize, blob.length)) : blob;
        if (crypto.createHash('md5').update(hashed).digest().compare(ekey, 0, 9, 0, 9) === 0) return blob;
      }
    }
    return null;
  }

  readByEKey(ekey, opts) {
    const raw = this.readRawByEKey(ekey);
    return raw ? decodeBLTE(raw, opts) : null;
  }

  #loadEncoding() {
    const [, ekeyHex] = this.buildConfig.encoding.split(' ');
    const decoded = this.readByEKey(Buffer.from(ekeyHex, 'hex'));
    if (!decoded) throw new Error('Encoding file missing from local storage');
    const buf = toShared(decoded);
    if (buf.readUInt16BE(0) !== 0x454e) throw new Error('Bad encoding file magic');
    if (buf[3] !== 16 || buf[4] !== 16) throw new Error('Unexpected encoding key sizes');
    const pageSize = buf.readUInt16BE(5) * 1024;
    const pageCount = buf.readUInt32BE(9);
    const indexStart = 22 + buf.readUInt32BE(18);
    this.enc = { buf, pageSize, pageCount, indexStart, pagesStart: indexStart + pageCount * 32 };
  }

  /** Content key (16-byte Buffer) -> encoding key (16-byte Buffer) or null. */
  ekeyForCKey(ckey) {
    const { buf, pageSize, pageCount, indexStart, pagesStart } = this.enc;
    // Binary search the page index for the last page whose first key <= ckey.
    let lo = 0, hi = pageCount - 1, page = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (buf.compare(ckey, 0, 16, indexStart + mid * 32, indexStart + mid * 32 + 16) <= 0) { page = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (page < 0) return null;
    let p = pagesStart + page * pageSize;
    const end = p + pageSize;
    while (p < end) {
      const keyCount = buf[p];
      if (keyCount === 0) break;
      if (buf.compare(ckey, 0, 16, p + 6, p + 22) === 0) return buf.subarray(p + 22, p + 38);
      p += 22 + keyCount * 16;
    }
    return null;
  }

  readByCKey(ckey, opts) {
    const ekey = this.ekeyForCKey(ckey);
    return ekey ? this.readByEKey(ekey, opts) : null;
  }

  /** The FileDataID manifest (loaded lazily). */
  get root() {
    if (!this._root) {
      const buf = this.readByCKey(Buffer.from(this.buildConfig.root, 'hex'));
      if (!buf) throw new Error('Root manifest missing from local storage');
      this._root = new Root(toShared(buf));
    }
    return this._root;
  }

  /**
   * Pick the variant of a file that is actually installed. The manifest can list several
   * (e.g. texture quality tiers); only one of them is normally present on disk.
   * @returns {{ckey:Buffer, local:boolean}|null}
   */
  #resolve(fdid) {
    const variants = this.root.variants(fdid);
    for (const ck of variants) {
      const ek = this.ekeyForCKey(ck);
      if (ek && this.hasEKey(ek)) return { ckey: ck, local: true };
    }
    return variants.length ? { ckey: variants[0], local: false } : null;
  }

  /** Hex content hash of the installed variant of a file, or null if the build does not contain it. */
  contentHash(fdid) {
    return this.#resolve(fdid)?.ckey.toString('hex') ?? null;
  }

  /** True if the file is in the manifest AND its data is actually downloaded locally. */
  exists(fdid) {
    return this.#resolve(fdid)?.local ?? false;
  }

  /** Read a game file by FileDataID. Returns null if absent / not downloaded. */
  readFile(fdid, opts) {
    const r = this.#resolve(fdid);
    return r && r.local ? this.readByCKey(r.ckey, opts) : null;
  }
}
