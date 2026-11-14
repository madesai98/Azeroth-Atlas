// Client database tables (DB2: WDC3/WDC4/WDC5) + WoWDBDefs (.dbd) column definitions.

function readBits(buf, base, bitOff, bitSize) {
  const byte = base + (bitOff >>> 3);
  const shift = bitOff & 7;
  let lo;
  if (byte + 4 <= buf.length) lo = buf.readUInt32LE(byte);
  else {
    lo = 0;
    for (let i = 0; byte + i < buf.length && i < 4; i++) lo |= buf[byte + i] << (8 * i);
    lo >>>= 0;
  }
  let v = lo >>> shift;
  if (shift && shift + bitSize > 32) v |= (buf[byte + 4] ?? 0) << (32 - shift);
  v >>>= 0;
  return bitSize >= 32 ? v : (v & ((1 << bitSize) - 1)) >>> 0;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsToFloat = (v) => ((u32[0] = v), f32[0]);

export class DB2 {
  /** @param {Buffer} buf decoded DB2 file (encrypted sections may be zero-filled) */
  constructor(buf) {
    this.buf = buf;
    const magic = buf.latin1Slice(0, 4);
    let p;
    if (magic === 'WDC5') p = 136;
    else if (magic === 'WDC4' || magic === 'WDC3') p = 4;
    else throw new Error(`Unsupported DB2 format ${JSON.stringify(magic)}`);
    const h = (this.header = {
      magic,
      recordCount: buf.readUInt32LE(p), fieldCount: buf.readUInt32LE(p + 4), recordSize: buf.readUInt32LE(p + 8),
      stringTableSize: buf.readUInt32LE(p + 12), tableHash: buf.readUInt32LE(p + 16), layoutHash: buf.readUInt32LE(p + 20),
      minId: buf.readUInt32LE(p + 24), maxId: buf.readUInt32LE(p + 28), locale: buf.readUInt32LE(p + 32),
      flags: buf.readUInt16LE(p + 36), idIndex: buf.readUInt16LE(p + 38), totalFieldCount: buf.readUInt32LE(p + 40),
      bitpackedDataOffset: buf.readUInt32LE(p + 44), lookupColumnCount: buf.readUInt32LE(p + 48),
      fieldStorageInfoSize: buf.readUInt32LE(p + 52), commonDataSize: buf.readUInt32LE(p + 56),
      palletDataSize: buf.readUInt32LE(p + 60), sectionCount: buf.readUInt32LE(p + 64),
    });
    this.layoutHash = h.layoutHash.toString(16).toUpperCase().padStart(8, '0');
    p += 68;
    const sections = [];
    for (let i = 0; i < h.sectionCount; i++, p += 40) {
      sections.push({
        tactKeyLo: buf.readUInt32LE(p), tactKeyHi: buf.readUInt32LE(p + 4),
        fileOffset: buf.readUInt32LE(p + 8), recordCount: buf.readUInt32LE(p + 12), stringTableSize: buf.readUInt32LE(p + 16),
        offsetRecordsEnd: buf.readUInt32LE(p + 20), idListSize: buf.readUInt32LE(p + 24), relationshipDataSize: buf.readUInt32LE(p + 28),
        offsetMapIdCount: buf.readUInt32LE(p + 32), copyTableCount: buf.readUInt32LE(p + 36),
      });
    }
    this.fields = [];
    for (let i = 0; i < h.totalFieldCount; i++, p += 4) this.fields.push({ size: buf.readInt16LE(p), position: buf.readUInt16LE(p + 2) });
    this.storage = [];
    const nStorage = h.fieldStorageInfoSize / 24;
    for (let i = 0; i < nStorage; i++, p += 24) {
      this.storage.push({
        offsetBits: buf.readUInt16LE(p), sizeBits: buf.readUInt16LE(p + 2), additionalDataSize: buf.readUInt32LE(p + 4),
        type: buf.readUInt32LE(p + 8), v1: buf.readUInt32LE(p + 12), v2: buf.readUInt32LE(p + 16), v3: buf.readUInt32LE(p + 20),
      });
    }
    // Pallet + common blocks are laid out in field order.
    let palletPos = p;
    p += h.palletDataSize;
    let commonPos = p;
    p += h.commonDataSize;
    for (const st of this.storage) {
      if (st.type === 3 || st.type === 4) { st.palletPos = palletPos; palletPos += st.additionalDataSize; }
      else if (st.type === 2) {
        st.common = new Map();
        for (let q = commonPos; q < commonPos + st.additionalDataSize; q += 8) st.common.set(buf.readUInt32LE(q), buf.readUInt32LE(q + 4));
        commonPos += st.additionalDataSize;
      }
    }

    if (h.flags & 1) throw new Error('Sparse (offset-map) DB2 tables are not supported');
    const hasIdList = (h.flags & 4) !== 0;
    this.rows = [];
    this.skippedEncryptedSections = 0;
    const stringParts = [];
    let globalIndex = 0;
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s];
      let pos = sec.fileOffset;
      const recordsPos = pos;
      pos += sec.recordCount * h.recordSize;
      stringParts.push(buf.subarray(pos, pos + sec.stringTableSize));
      pos += sec.stringTableSize;
      const idListPos = pos;
      pos += sec.idListSize;
      const copyPos = pos;
      pos += sec.copyTableCount * 8;
      pos += sec.offsetMapIdCount * 6;
      const relPos = pos;
      pos += sec.relationshipDataSize;
      pos += sec.offsetMapIdCount * 4;

      let encryptedAndMissing = false;
      if (sec.tactKeyLo || sec.tactKeyHi) {
        encryptedAndMissing = true;
        const end = Math.min(pos, buf.length);
        for (let q = sec.fileOffset; q < end; q++) if (buf[q] !== 0) { encryptedAndMissing = false; break; }
      }
      if (encryptedAndMissing) {
        this.skippedEncryptedSections++;
        globalIndex += sec.recordCount;
        continue;
      }
      const refIds = new Map();
      if (sec.relationshipDataSize > 0) {
        const n = buf.readUInt32LE(relPos);
        for (let i = 0; i < n; i++) refIds.set(buf.readUInt32LE(relPos + 12 + i * 8 + 4), buf.readUInt32LE(relPos + 12 + i * 8));
      }
      const byId = new Map();
      for (let i = 0; i < sec.recordCount; i++) {
        const base = recordsPos + i * h.recordSize;
        const row = {
          id: 0, refId: refIds.get(i) ?? 0, base,
          strBase: (globalIndex + i) * h.recordSize - h.recordCount * h.recordSize,
        };
        row.id = hasIdList ? buf.readUInt32LE(idListPos + i * 4) : this.raw(row, h.idIndex)[0];
        this.rows.push(row);
        byId.set(row.id, row);
      }
      for (let i = 0; i < sec.copyTableCount; i++) {
        const newId = buf.readUInt32LE(copyPos + i * 8), srcId = buf.readUInt32LE(copyPos + i * 8 + 4);
        const src = byId.get(srcId);
        if (src) this.rows.push({ ...src, id: newId });
      }
      globalIndex += sec.recordCount;
    }
    this.strings = Buffer.concat(stringParts);
  }

  /** Raw unsigned values of a field (always an array). */
  raw(row, fi) {
    const st = this.storage[fi];
    const buf = this.buf;
    switch (st.type) {
      case 0: {
        const elemBits = 32 - this.fields[fi].size;
        const count = Math.max(1, Math.floor(st.sizeBits / elemBits));
        const out = new Array(count);
        for (let j = 0; j < count; j++) {
          if (elemBits > 32) {
            const lo = readBits(buf, row.base, st.offsetBits + j * elemBits, 32);
            const hi = readBits(buf, row.base, st.offsetBits + j * elemBits + 32, 32);
            out[j] = hi * 4294967296 + lo;
          } else out[j] = readBits(buf, row.base, st.offsetBits + j * elemBits, elemBits);
        }
        return out;
      }
      case 1:
      case 5: {
        let v = readBits(buf, row.base, st.offsetBits, st.sizeBits);
        if ((st.type === 5 || st.v3 & 1) && st.sizeBits < 32 && v & (1 << (st.sizeBits - 1))) v = (v | (~0 << st.sizeBits)) >>> 0;
        return [v];
      }
      case 2:
        return [st.common.get(row.id) ?? st.v1];
      case 3:
        return [buf.readUInt32LE(st.palletPos + readBits(buf, row.base, st.offsetBits, st.sizeBits) * 4)];
      case 4: {
        const idx = readBits(buf, row.base, st.offsetBits, st.sizeBits);
        const out = new Array(st.v3);
        for (let j = 0; j < st.v3; j++) out[j] = buf.readUInt32LE(st.palletPos + (idx * st.v3 + j) * 4);
        return out;
      }
      default:
        throw new Error(`Unknown DB2 field storage type ${st.type}`);
    }
  }

  string(row, fi, value, j = 0) {
    const pos = row.strBase + (this.storage[fi].offsetBits >>> 3) + j * 4 + value;
    if (value === 0 || pos < 0 || pos >= this.strings.length) return '';
    let end = this.strings.indexOf(0, pos);
    if (end < 0) end = this.strings.length;
    return this.strings.toString('utf8', pos, end);
  }
}

/** Parse a WoWDBDefs .dbd file into { columns, layouts }. */
export function parseDBD(text) {
  const lines = text.split(/\r?\n/);
  const columns = new Map();
  let i = 0;
  if (lines[i].trim() === 'COLUMNS') i++;
  for (; i < lines.length && lines[i].trim() !== ''; i++) {
    const m = /^(\w+)(?:<[^>]*>)?\s+(\w+)\??/.exec(lines[i]);
    if (m) columns.set(m[2], m[1]);
  }
  const layouts = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') { cur = null; continue; }
    if (!cur) { cur = { hashes: [], builds: [], fields: [] }; layouts.push(cur); }
    if (line.startsWith('LAYOUT ')) cur.hashes.push(...line.slice(7).split(',').map((s) => s.trim().toUpperCase()));
    else if (line.startsWith('BUILD ')) cur.builds.push(...line.slice(6).split(',').map((s) => s.trim()));
    else if (line.startsWith('COMMENT')) continue;
    else {
      const m = /^(?:\$([^$]*)\$)?(\w+)(?:<(u?)(\d+)>)?(?:\[(\d+)\])?/.exec(line);
      if (!m) continue;
      const ann = m[1] ? m[1].split(',') : [];
      cur.fields.push({
        name: m[2], isId: ann.includes('id'), isRelation: ann.includes('relation'), nonInline: ann.includes('noninline'),
        unsigned: m[3] === 'u', bits: m[4] ? +m[4] : 32, arrayLen: m[5] ? +m[5] : 0, type: columns.get(m[2]) ?? 'int',
      });
    }
  }
  return { columns, layouts };
}

/**
 * Decode a DB2 into plain row objects using a .dbd definition.
 * Throws an error with code 'ELAYOUT' when the table layout is not described by the definition.
 */
export function readTable(buf, dbdText, { build } = {}) {
  const db = new DB2(buf);
  const dbd = parseDBD(dbdText);
  let layout = dbd.layouts.find((l) => l.hashes.includes(db.layoutHash));
  if (!layout && build) layout = dbd.layouts.find((l) => l.builds.includes(build));
  if (!layout) {
    const err = new Error(`No definition for table layout ${db.layoutHash}`);
    err.code = 'ELAYOUT';
    throw err;
  }
  const inline = layout.fields.filter((f) => !f.nonInline);
  if (inline.length !== db.header.fieldCount) {
    const err = new Error(`Definition has ${inline.length} fields but table has ${db.header.fieldCount} (layout ${db.layoutHash})`);
    err.code = 'ELAYOUT';
    throw err;
  }
  const rows = [];
  for (const row of db.rows) {
    const out = {};
    let fi = 0;
    for (const f of layout.fields) {
      if (f.nonInline) {
        out[f.name] = f.isId ? row.id : f.isRelation ? row.refId : 0;
        continue;
      }
      const raw = db.raw(row, fi);
      const st = db.storage[fi];
      let vals;
      if (f.type === 'string' || f.type === 'locstring') vals = raw.map((v, j) => db.string(row, fi, v, j));
      else if (f.type === 'float') vals = raw.map(bitsToFloat);
      else if (f.bits > 32) vals = raw;
      else {
        // Packed/pallet values can carry junk above the declared width: mask, then sign-extend.
        const width = st.type === 0 ? Math.min(f.bits, 32 - db.fields[fi].size) : f.bits;
        vals = raw.map((v) => {
          if (width >= 32) return f.unsigned ? v >>> 0 : v | 0;
          v = (v & ((1 << width) - 1)) >>> 0;
          return !f.unsigned && v & (1 << (width - 1)) ? v - 2 ** width : v;
        });
      }
      out[f.name] = f.arrayLen ? vals : vals[0];
      fi++;
    }
    if (out.ID === undefined) out.ID = row.id;
    rows.push(out);
  }
  return { rows, layoutHash: db.layoutHash, skippedEncryptedSections: db.skippedEncryptedSections };
}
