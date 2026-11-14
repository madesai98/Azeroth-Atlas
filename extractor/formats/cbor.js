// Minimal CBOR decoder (RFC 8949): enough for plain data trees of numbers, strings, arrays and maps.

export function decodeCBOR(buf) {
  let p = 0;
  const read = () => {
    if (p >= buf.length) throw new Error('CBOR: unexpected end of data');
    const first = buf[p++];
    const major = first >> 5, info = first & 31;
    let n = info;
    if (info === 24) n = buf[p++];
    else if (info === 25) { n = buf.readUInt16BE(p); p += 2; }
    else if (info === 26) { n = buf.readUInt32BE(p); p += 4; }
    else if (info === 27) {
      if (major === 7) { const v = buf.readDoubleBE(p); p += 8; return v; }
      n = Number(buf.readBigUInt64BE(p)); p += 8;
    } else if (info > 27) throw new Error('CBOR: indefinite lengths are not supported');
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = buf.subarray(p, p + n); p += n; return v; }
      case 3: { const v = buf.toString('utf8', p, p + n); p += n; return v; }
      case 4: { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = read(); return out; }
      case 5: { const out = new Map(); for (let i = 0; i < n; i++) { const k = read(); out.set(k, read()); } return out; }
      case 6: return read(); // tag: keep the tagged value
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { // half float
          const h = n, e = (h >> 10) & 31, f = h & 1023;
          const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (f + 1024) * 2 ** (e - 25);
          return h & 0x8000 ? -v : v;
        }
        if (info === 26) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b.readFloatBE(0); }
        return n; // simple value
    }
  };
  return read();
}
