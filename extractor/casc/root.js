// WoW root manifest ("TSFM"): maps FileDataID -> content key.

const LOCALE_ENUS = 0x2;
const CF_LOW_VIOLENCE = 0x80; // alternate low-violence asset variant
const CF_NO_NAME_HASH = 0x10000000;

const shared = (Type, n) => new Type(new SharedArrayBuffer(Type.BYTES_PER_ELEMENT * n));

export class Root {
  /** @param {Buffer} buf decoded root file (ideally backed by a SharedArrayBuffer) */
  constructor(buf, { locale = LOCALE_ENUS } = {}) {
    if (!buf) return;
    if (buf.readUInt32LE(0) !== 0x4d465354) throw new Error('Unsupported root manifest (expected TSFM)');
    let pos;
    let version = 0;
    let totalFiles;
    const second = buf.readUInt32LE(4);
    if (second < 1000) {
      // header: magic, headerSize, version, totalFileCount, namedFileCount, pad
      version = buf.readUInt32LE(8);
      pos = second;
      totalFiles = buf.readUInt32LE(12);
    } else {
      totalFiles = second;
      pos = 12;
    }
    this.version = version;
    this.totalFiles = totalFiles;

    const fdids = new Uint32Array(totalFiles);
    const ckeyOff = new Uint32Array(totalFiles); // byte offset of the 16-byte ckey inside `buf`
    const prio = new Uint8Array(totalFiles);
    let n = 0;
    while (pos < buf.length) {
      const num = buf.readUInt32LE(pos);
      let localeFlags, contentFlags;
      if (version >= 2) {
        localeFlags = buf.readUInt32LE(pos + 4);
        const cf1 = buf.readUInt32LE(pos + 8), cf2 = buf.readUInt32LE(pos + 12), cf3 = buf[pos + 16];
        contentFlags = (cf1 | cf2 | (cf3 << 17)) >>> 0;
        pos += 17;
      } else {
        contentFlags = buf.readUInt32LE(pos + 4);
        localeFlags = buf.readUInt32LE(pos + 8);
        pos += 12;
      }
      const deltasPos = pos;
      const ckeysPos = pos + num * 4;
      const hasNames = !(contentFlags & CF_NO_NAME_HASH);
      pos = ckeysPos + num * 16 + (hasNames ? num * 8 : 0);
      const localeOk = localeFlags === 0xffffffff || (localeFlags & locale) !== 0;
      if (!localeOk) continue;
      // Prefer the regular (non-low-violence) variant when a file appears in several blocks.
      const p = contentFlags & CF_LOW_VIOLENCE ? 1 : 2;
      let id = -1;
      for (let i = 0; i < num; i++) {
        id += buf.readInt32LE(deltasPos + i * 4) + 1;
        fdids[n] = id;
        ckeyOff[n] = ckeysPos + i * 16;
        prio[n] = p;
        n++;
      }
    }
    // A file id can appear several times (platform / quality variants with different content).
    // Keep every variant, best-first; the storage layer picks the one that is actually installed.
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => fdids[a] - fdids[b] || prio[b] - prio[a] || a - b);
    const ids = shared(Uint32Array, n), offs = shared(Uint32Array, n);
    let unique = 0;
    for (let i = 0; i < n; i++) {
      const j = order[i];
      ids[i] = fdids[j];
      offs[i] = ckeyOff[j];
      if (i === 0 || ids[i] !== ids[i - 1]) unique++;
    }
    this.buf = buf;
    this.ids = ids;
    this.offs = offs;
    this.count = unique;
    this.entries = n;
  }

  share() {
    return { buf: this.buf.buffer, ids: this.ids, offs: this.offs, count: this.count, entries: this.entries, version: this.version, totalFiles: this.totalFiles };
  }

  static fromShared(s) {
    const r = new Root(null);
    r.buf = Buffer.from(s.buf);
    r.ids = s.ids; r.offs = s.offs; r.count = s.count; r.entries = s.entries; r.version = s.version; r.totalFiles = s.totalFiles;
    return r;
  }

  /** Index of the first (preferred) variant of a file id, or -1. */
  #find(fdid) {
    const ids = this.ids;
    let lo = 0, hi = this.entries;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] < fdid) lo = mid + 1; else hi = mid;
    }
    return lo < this.entries && ids[lo] === fdid ? lo : -1;
  }

  has(fdid) {
    return this.#find(fdid) >= 0;
  }

  /** @returns {Buffer|null} content key of the preferred variant (a view into the manifest) */
  ckey(fdid) {
    const i = this.#find(fdid);
    return i < 0 ? null : this.buf.subarray(this.offs[i], this.offs[i] + 16);
  }

  /** Content keys of every variant of a file id, preferred first. */
  variants(fdid) {
    const out = [];
    for (let i = this.#find(fdid); i >= 0 && i < this.entries && this.ids[i] === fdid; i++) out.push(this.buf.subarray(this.offs[i], this.offs[i] + 16));
    return out;
  }
}
