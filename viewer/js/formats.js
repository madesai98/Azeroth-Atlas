// Decoders for the extracted data files (sectioned containers + BLP textures).

/** Split a container (see extractor/container.js) into { version, sections: Map<id, {offset,size}> }. */
export function unpackContainer(buffer, magic) {
  const dv = new DataView(buffer);
  const want = magic.charCodeAt(0) | (magic.charCodeAt(1) << 8) | (magic.charCodeAt(2) << 16) | (magic.charCodeAt(3) << 24);
  if (dv.getInt32(0, true) !== want) throw new Error(`Unexpected file type (wanted ${magic})`);
  const version = dv.getUint32(4, true), n = dv.getUint32(8, true);
  const sections = new Map();
  for (let i = 0; i < n; i++) sections.set(dv.getUint32(12 + i * 12, true), { offset: dv.getUint32(16 + i * 12, true), size: dv.getUint32(20 + i * 12, true) });
  return { version, sections, buffer };
}

export function sectionView(c, id, Type) {
  const s = c.sections.get(id);
  if (!s) return null;
  return new Type(c.buffer, s.offset, s.size / Type.BYTES_PER_ELEMENT);
}

// ---- BLP -----------------------------------------------------------------------------------
export function parseBLP(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x32504c42) throw new Error('Not a BLP2 texture');
  const colorEncoding = u8[8], alphaSize = u8[9], alphaEncoding = u8[10], hasMips = u8[11];
  const width = dv.getUint32(12, true), height = dv.getUint32(16, true);
  const mips = [];
  for (let i = 0; i < 16; i++) {
    const offset = dv.getUint32(20 + i * 4, true), size = dv.getUint32(84 + i * 4, true);
    if (!offset || !size) break;
    if (offset + size > buffer.byteLength) break; // truncated file
    mips.push({ offset, size, width: Math.max(1, width >> i), height: Math.max(1, height >> i) });
    if (!hasMips) break;
  }
  let format = 'unknown';
  if (colorEncoding === 1) format = 'pal';
  else if (colorEncoding === 2) format = alphaEncoding === 0 ? 'bc1' : alphaEncoding === 1 ? 'bc2' : alphaEncoding === 7 ? 'bc3' : 'unknown';
  else if (colorEncoding === 3) format = 'bgra';
  return { width, height, format, alphaSize, mips, u8, dv };
}

function rgb565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

/** Decode one mip level to RGBA8 (fallback path when BC textures are unavailable, and for palettized art). */
export function decodeBLPMip(blp, level) {
  const { u8, dv, format, alphaSize } = blp;
  const mip = blp.mips[level];
  const w = mip.width, h = mip.height;
  const out = new Uint8Array(w * h * 4);
  if (format === 'bgra') {
    for (let i = 0, p = mip.offset; i < w * h; i++, p += 4) { out[i * 4] = u8[p + 2]; out[i * 4 + 1] = u8[p + 1]; out[i * 4 + 2] = u8[p]; out[i * 4 + 3] = u8[p + 3]; }
    return out;
  }
  if (format === 'pal') {
    const ap = mip.offset + w * h;
    for (let i = 0; i < w * h; i++) {
      const pi = 148 + u8[mip.offset + i] * 4;
      out[i * 4] = u8[pi + 2]; out[i * 4 + 1] = u8[pi + 1]; out[i * 4 + 2] = u8[pi];
      let a = 255;
      if (alphaSize === 8) a = u8[ap + i];
      else if (alphaSize === 1) a = (u8[ap + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      else if (alphaSize === 4) a = ((u8[ap + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      out[i * 4 + 3] = a;
    }
    return out;
  }
  const pal = new Uint8Array(16), alpha = new Uint8Array(16).fill(255);
  let p = mip.offset;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    if (format === 'bc2') {
      for (let i = 0; i < 16; i++) alpha[i] = ((u8[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      p += 8;
    } else if (format === 'bc3') {
      const a0 = u8[p], a1 = u8[p + 1];
      const a = [a0, a1, 0, 0, 0, 0, 0, 0];
      if (a0 > a1) for (let i = 1; i < 7; i++) a[i + 1] = ((7 - i) * a0 + i * a1) / 7;
      else { for (let i = 1; i < 5; i++) a[i + 1] = ((5 - i) * a0 + i * a1) / 5; a[6] = 0; a[7] = 255; }
      const lo = u8[p + 2] | (u8[p + 3] << 8) | (u8[p + 4] << 16), hi = u8[p + 5] | (u8[p + 6] << 8) | (u8[p + 7] << 16);
      for (let i = 0; i < 8; i++) { alpha[i] = a[(lo >> (i * 3)) & 7]; alpha[8 + i] = a[(hi >> (i * 3)) & 7]; }
      p += 8;
    }
    const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true), bits = dv.getUint32(p + 4, true);
    p += 8;
    rgb565(c0, pal, 0); rgb565(c1, pal, 4);
    pal[3] = pal[7] = pal[11] = pal[15] = 255;
    if (c0 > c1 || format !== 'bc1') {
      for (let i = 0; i < 3; i++) { pal[8 + i] = (2 * pal[i] + pal[4 + i] + 1) / 3; pal[12 + i] = (pal[i] + 2 * pal[4 + i] + 1) / 3; }
    } else {
      for (let i = 0; i < 3; i++) { pal[8 + i] = (pal[i] + pal[4 + i]) >> 1; pal[12 + i] = 0; }
      pal[15] = 0;
    }
    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2);
      if (x >= w || y >= h) continue;
      const ci = ((bits >>> (i * 2)) & 3) * 4, o = (y * w + x) * 4;
      out[o] = pal[ci]; out[o + 1] = pal[ci + 1]; out[o + 2] = pal[ci + 2];
      out[o + 3] = format === 'bc1' ? pal[ci + 3] : alpha[i];
    }
  }
  return out;
}

const BC_FORMAT = { bc1: 'bc1-rgba-unorm', bc2: 'bc2-rgba-unorm', bc3: 'bc3-rgba-unorm' };

/** Upload a BLP as a GPU texture (compressed blocks go straight to the GPU when supported). */
export function textureFromBLP(gpu, buffer, { srgb = true, label = 'blp', maxSize = Infinity } = {}) {
  const { device } = gpu;
  const blp = parseBLP(buffer);
  // Optionally drop the largest mips to save video memory (the map shares the GPU with the game).
  const capped = (list) => { const f = list.filter((m) => m.width <= maxSize && m.height <= maxSize); return f.length ? f : list.slice(-1); };
  const compressed = gpu.bc && BC_FORMAT[blp.format] && blp.width % 4 === 0 && blp.height % 4 === 0;
  if (compressed) {
    const levels = capped(blp.mips.filter((m) => m.width >= 4 && m.height >= 4 && m.width % 4 === 0 && m.height % 4 === 0));
    const blockBytes = blp.format === 'bc1' ? 8 : 16;
    const tex = device.createTexture({
      label, size: [levels[0].width, levels[0].height], mipLevelCount: levels.length,
      format: BC_FORMAT[blp.format] + (srgb ? '-srgb' : ''), usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let bytes = 0;
    levels.forEach((m, i) => {
      device.queue.writeTexture({ texture: tex, mipLevel: i }, blp.u8, { offset: m.offset, bytesPerRow: (m.width / 4) * blockBytes, rowsPerImage: m.height / 4 }, [m.width, m.height]);
      bytes += (m.width / 4) * (m.height / 4) * blockBytes;
    });
    return { texture: tex, width: levels[0].width, height: levels[0].height, bytes, hasAlpha: blp.format !== 'bc1' || blp.alphaSize > 0 };
  }
  if (blp.format === 'unknown' || !blp.mips.length) throw new Error('Unsupported texture encoding');
  const levels = capped(blp.mips.map((m, i) => ({ ...m, index: i })));
  const tex = device.createTexture({
    label, size: [levels[0].width, levels[0].height], mipLevelCount: levels.length,
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let bytes = 0;
  levels.forEach((m, i) => {
    device.queue.writeTexture({ texture: tex, mipLevel: i }, decodeBLPMip(blp, m.index), { bytesPerRow: m.width * 4 }, [m.width, m.height]);
    bytes += m.width * m.height * 4;
  });
  return { texture: tex, width: levels[0].width, height: levels[0].height, bytes, hasAlpha: blp.alphaSize > 0 };
}
