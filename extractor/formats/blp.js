// BLP2 texture parsing. Compressed (DXT/BC) payloads are kept as-is for direct GPU upload;
// decodeMip() is only used by tooling that needs RGBA pixels.

export function parseBLP(buf) {
  if (buf.latin1Slice(0, 4) !== 'BLP2') throw new Error('Not a BLP2 texture');
  const colorEncoding = buf[8], alphaSize = buf[9], alphaEncoding = buf[10], hasMips = buf[11];
  const width = buf.readUInt32LE(12), height = buf.readUInt32LE(16);
  const mips = [];
  for (let i = 0; i < 16; i++) {
    const offset = buf.readUInt32LE(20 + i * 4), size = buf.readUInt32LE(84 + i * 4);
    if (!offset || !size) break;
    mips.push({ offset, size, width: Math.max(1, width >> i), height: Math.max(1, height >> i) });
    if (!hasMips) break;
  }
  let format;
  if (colorEncoding === 1) format = 'pal';
  else if (colorEncoding === 2) format = alphaEncoding === 0 ? 'bc1' : alphaEncoding === 1 ? 'bc2' : alphaEncoding === 7 ? 'bc3' : `dxt?${alphaEncoding}`;
  else if (colorEncoding === 3) format = 'bgra';
  else format = `unknown${colorEncoding}`;
  return { width, height, format, alphaSize, mips, buf };
}

function rgb565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

function decodeColorBlock(src, p, pal, forceFour) {
  const c0 = src.readUInt16LE(p), c1 = src.readUInt16LE(p + 2);
  rgb565(c0, pal, 0); rgb565(c1, pal, 4);
  pal[3] = 255; pal[7] = 255; pal[11] = 255; pal[15] = 255;
  if (c0 > c1 || forceFour) {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = (2 * pal[i] + pal[4 + i] + 1) / 3;
      pal[12 + i] = (pal[i] + 2 * pal[4 + i] + 1) / 3;
    }
  } else {
    for (let i = 0; i < 3; i++) { pal[8 + i] = (pal[i] + pal[4 + i]) >> 1; pal[12 + i] = 0; }
    pal[15] = 0;
  }
  return src.readUInt32LE(p + 4);
}

/** Decode one mip level to RGBA8 (Uint8Array). */
export function decodeMip(blp, level = 0) {
  const { buf, format, alphaSize } = blp;
  const mip = blp.mips[level];
  const { width: w, height: h } = mip;
  const out = new Uint8Array(w * h * 4);
  if (format === 'bgra') {
    for (let i = 0; i < w * h; i++) {
      const p = mip.offset + i * 4;
      out[i * 4] = buf[p + 2]; out[i * 4 + 1] = buf[p + 1]; out[i * 4 + 2] = buf[p]; out[i * 4 + 3] = buf[p + 3];
    }
    return out;
  }
  if (format === 'pal') {
    const alphaPos = mip.offset + w * h;
    for (let i = 0; i < w * h; i++) {
      const pi = 148 + buf[mip.offset + i] * 4;
      out[i * 4] = buf[pi + 2]; out[i * 4 + 1] = buf[pi + 1]; out[i * 4 + 2] = buf[pi];
      let a = 255;
      if (alphaSize === 8) a = buf[alphaPos + i];
      else if (alphaSize === 1) a = (buf[alphaPos + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      else if (alphaSize === 4) a = ((buf[alphaPos + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      out[i * 4 + 3] = a;
    }
    return out;
  }
  const pal = new Uint8Array(16);
  const alpha = new Uint8Array(16);
  let p = mip.offset;
  for (let by = 0; by < h; by += 4) {
    for (let bx = 0; bx < w; bx += 4) {
      if (format === 'bc2') {
        for (let i = 0; i < 16; i++) alpha[i] = ((buf[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
        p += 8;
      } else if (format === 'bc3') {
        const a0 = buf[p], a1 = buf[p + 1];
        const a = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i < 7; i++) a[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        else { for (let i = 1; i < 5; i++) a[i + 1] = ((5 - i) * a0 + i * a1) / 5; a[6] = 0; a[7] = 255; }
        const lo = buf.readUIntLE(p + 2, 3), hi = buf.readUIntLE(p + 5, 3);
        for (let i = 0; i < 8; i++) { alpha[i] = a[(lo >> (i * 3)) & 7]; alpha[8 + i] = a[(hi >> (i * 3)) & 7]; }
        p += 8;
      }
      const bits = decodeColorBlock(buf, p, pal, format !== 'bc1');
      p += 8;
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3), y = by + (i >> 2);
        if (x >= w || y >= h) continue;
        const ci = ((bits >>> (i * 2)) & 3) * 4;
        const o = (y * w + x) * 4;
        out[o] = pal[ci]; out[o + 1] = pal[ci + 1]; out[o + 2] = pal[ci + 2];
        out[o + 3] = format === 'bc1' ? pal[ci + 3] : alpha[i];
      }
    }
  }
  return out;
}
