// Tiny sectioned binary container shared by every extracted artifact.
//
//   u32 magic, u32 version, u32 sectionCount, then sectionCount x { u32 id, u32 offset, u32 size }
//   followed by the section payloads, each aligned to 4 bytes (so the viewer can wrap them
//   directly in typed arrays).
import fs from 'node:fs';
import path from 'node:path';

export const fourcc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

export function packContainer(magic, version, sections) {
  const headerSize = 12 + sections.length * 12;
  let offset = headerSize;
  const table = sections.map(({ id, data }) => {
    const size = data.byteLength;
    const entry = { id, offset, size, data };
    offset += (size + 3) & ~3;
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32LE(fourcc(magic) >>> 0, 0);
  out.writeUInt32LE(version, 4);
  out.writeUInt32LE(sections.length, 8);
  table.forEach((e, i) => {
    out.writeUInt32LE(e.id, 12 + i * 12);
    out.writeUInt32LE(e.offset, 16 + i * 12);
    out.writeUInt32LE(e.size, 20 + i * 12);
    Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength).copy(out, e.offset);
  });
  return out;
}

export function unpackContainer(buf, magic) {
  if (buf.readUInt32LE(0) !== fourcc(magic) >>> 0) throw new Error(`Bad container magic (expected ${magic})`);
  const version = buf.readUInt32LE(4);
  const n = buf.readUInt32LE(8);
  const sections = new Map();
  for (let i = 0; i < n; i++) {
    const id = buf.readUInt32LE(12 + i * 12), offset = buf.readUInt32LE(16 + i * 12), size = buf.readUInt32LE(20 + i * 12);
    sections.set(id, buf.subarray(offset, offset + size));
  }
  return { version, sections };
}

/** Float32 view over (part of) a Buffer; copies only if the bytes are not 4-byte aligned. */
export function f32View(buf, count = buf.length >> 2, byteOffset = 0) {
  const off = buf.byteOffset + byteOffset;
  if (off % 4 === 0) return new Float32Array(buf.buffer, off, count);
  return new Float32Array(Uint8Array.from(buf.subarray(byteOffset, byteOffset + count * 4)).buffer);
}

/** Write via a temp file + rename so readers never observe a half-written artifact. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Growable little-endian binary writer. */
export class BinWriter {
  constructor(size = 1024) { this.buf = Buffer.alloc(size); this.pos = 0; }
  #need(n) {
    if (this.pos + n <= this.buf.length) return;
    const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(nb, 0, 0, this.pos);
    this.buf = nb;
  }
  u8(v) { this.#need(1); this.buf[this.pos++] = v; return this; }
  u16(v) { this.#need(2); this.buf.writeUInt16LE(v, this.pos); this.pos += 2; return this; }
  u32(v) { this.#need(4); this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; return this; }
  i32(v) { this.#need(4); this.buf.writeInt32LE(v, this.pos); this.pos += 4; return this; }
  f32(v) { this.#need(4); this.buf.writeFloatLE(v, this.pos); this.pos += 4; return this; }
  bytes(b) { this.#need(b.byteLength); Buffer.from(b.buffer, b.byteOffset, b.byteLength).copy(this.buf, this.pos); this.pos += b.byteLength; return this; }
  align(n = 4) { while (this.pos % n) this.u8(0); return this; }
  done() { return this.buf.subarray(0, this.pos); }
}
