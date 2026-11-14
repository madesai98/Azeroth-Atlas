// BLTE container decoding (the per-file compression/encryption wrapper used by CASC).
import zlib from 'node:zlib';

export class EncryptedError extends Error {
  constructor(keyName) {
    super(`BLTE chunk encrypted with unknown key ${keyName}`);
    this.keyName = keyName;
    this.code = 'EENCRYPTED';
  }
}

/** Optional map of keyName(hex, upper) -> 16-byte Buffer for encrypted chunks. */
export const tactKeys = new Map();

function salsa20(key16, iv8, data) {
  // Salsa20 with a 16-byte key ("expand 16-byte k").
  const c = [0x61707865, 0x3120646e, 0x79622d36, 0x6b206574];
  const k = [key16.readUInt32LE(0), key16.readUInt32LE(4), key16.readUInt32LE(8), key16.readUInt32LE(12)];
  const s = new Uint32Array(16);
  s[0] = c[0]; s[1] = k[0]; s[2] = k[1]; s[3] = k[2]; s[4] = k[3]; s[5] = c[1];
  s[6] = iv8.readUInt32LE(0); s[7] = iv8.readUInt32LE(4); s[8] = 0; s[9] = 0;
  s[10] = c[2]; s[11] = k[0]; s[12] = k[1]; s[13] = k[2]; s[14] = k[3]; s[15] = c[3];
  const out = Buffer.allocUnsafe(data.length);
  const x = new Uint32Array(16);
  const block = Buffer.allocUnsafe(64);
  const rotl = (v, n) => (v << n) | (v >>> (32 - n));
  for (let pos = 0; pos < data.length; pos += 64) {
    x.set(s);
    for (let i = 0; i < 10; i++) {
      x[4] ^= rotl(x[0] + x[12], 7); x[8] ^= rotl(x[4] + x[0], 9); x[12] ^= rotl(x[8] + x[4], 13); x[0] ^= rotl(x[12] + x[8], 18);
      x[9] ^= rotl(x[5] + x[1], 7); x[13] ^= rotl(x[9] + x[5], 9); x[1] ^= rotl(x[13] + x[9], 13); x[5] ^= rotl(x[1] + x[13], 18);
      x[14] ^= rotl(x[10] + x[6], 7); x[2] ^= rotl(x[14] + x[10], 9); x[6] ^= rotl(x[2] + x[14], 13); x[10] ^= rotl(x[6] + x[2], 18);
      x[3] ^= rotl(x[15] + x[11], 7); x[7] ^= rotl(x[3] + x[15], 9); x[11] ^= rotl(x[7] + x[3], 13); x[15] ^= rotl(x[11] + x[7], 18);
      x[1] ^= rotl(x[0] + x[3], 7); x[2] ^= rotl(x[1] + x[0], 9); x[3] ^= rotl(x[2] + x[1], 13); x[0] ^= rotl(x[3] + x[2], 18);
      x[6] ^= rotl(x[5] + x[4], 7); x[7] ^= rotl(x[6] + x[5], 9); x[4] ^= rotl(x[7] + x[6], 13); x[5] ^= rotl(x[4] + x[7], 18);
      x[11] ^= rotl(x[10] + x[9], 7); x[8] ^= rotl(x[11] + x[10], 9); x[9] ^= rotl(x[8] + x[11], 13); x[10] ^= rotl(x[9] + x[8], 18);
      x[12] ^= rotl(x[15] + x[14], 7); x[13] ^= rotl(x[12] + x[15], 9); x[14] ^= rotl(x[13] + x[12], 13); x[15] ^= rotl(x[14] + x[13], 18);
    }
    for (let i = 0; i < 16; i++) block.writeUInt32LE((x[i] + s[i]) >>> 0, i * 4);
    const n = Math.min(64, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = data[pos + i] ^ block[i];
    s[8] = (s[8] + 1) >>> 0;
    if (s[8] === 0) s[9] = (s[9] + 1) >>> 0;
  }
  return out;
}

function decodeChunk(chunk, index, expectedSize) {
  const mode = chunk[0];
  switch (mode) {
    case 0x4e: // 'N' raw
      return chunk.subarray(1);
    case 0x5a: // 'Z' zlib
      return zlib.inflateSync(chunk.subarray(1));
    case 0x45: { // 'E' encrypted
      let p = 1;
      const keyNameSize = chunk[p++];
      const keyName = Buffer.from(chunk.subarray(p, p + keyNameSize)).reverse().toString('hex').toUpperCase();
      p += keyNameSize;
      const ivSize = chunk[p++];
      const iv = Buffer.alloc(8);
      chunk.copy(iv, 0, p, p + ivSize);
      p += ivSize;
      const type = chunk[p++];
      const key = tactKeys.get(keyName);
      if (!key) throw new EncryptedError(keyName);
      if (type !== 0x53) throw new Error(`Unsupported BLTE encryption type ${String.fromCharCode(type)}`);
      for (let i = 0; i < 4; i++) iv[i] ^= (index >>> (i * 8)) & 0xff;
      return decodeChunk(salsa20(key, iv, chunk.subarray(p)), index, expectedSize);
    }
    case 0x46: // 'F' nested BLTE frame
      return decodeBLTE(chunk.subarray(1));
    default:
      throw new Error(`Unknown BLTE chunk mode 0x${mode.toString(16)} ('${String.fromCharCode(mode)}')`);
  }
}

/**
 * Decode a full BLTE blob. `opts.maxBytes` stops early once that many decoded bytes
 * are available (useful for sniffing file headers). `opts.skipEncrypted` zero-fills
 * chunks whose key is unknown instead of throwing.
 */
export function decodeBLTE(buf, opts = {}) {
  if (buf.readUInt32BE(0) !== 0x424c5445) throw new Error('Not a BLTE blob');
  const headerSize = buf.readUInt32BE(4);
  if (headerSize === 0) return decodeChunk(buf.subarray(8), 0, -1);
  const chunkCount = buf.readUIntBE(9, 3);
  const parts = [];
  let total = 0;
  let dataPos = headerSize;
  for (let i = 0; i < chunkCount; i++) {
    const e = 12 + i * 24;
    const compSize = buf.readUInt32BE(e);
    const decompSize = buf.readUInt32BE(e + 4);
    const chunk = buf.subarray(dataPos, dataPos + compSize);
    dataPos += compSize;
    let out;
    try {
      out = decodeChunk(chunk, i, decompSize);
    } catch (err) {
      if (err.code === 'EENCRYPTED' && opts.skipEncrypted) out = Buffer.alloc(decompSize);
      else throw err;
    }
    parts.push(out);
    total += out.length;
    if (opts.maxBytes && total >= opts.maxBytes) break;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
}
