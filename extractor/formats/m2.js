// M2 models (doodads: trees, rocks, props). Only the static bind pose is used.

function findChunks(buf) {
  const out = new Map();
  if (buf.latin1Slice(0, 4) === 'MD20') { out.set('MD21', { pos: 0, size: buf.length }); return out; }
  let p = 0;
  while (p + 8 <= buf.length) {
    const magic = buf.latin1Slice(p, p + 4), size = buf.readUInt32LE(p + 4);
    out.set(magic, { pos: p + 8, size });
    p += 8 + size;
  }
  return out;
}

export function parseM2(buf) {
  const chunks = findChunks(buf);
  const md = chunks.get('MD21');
  if (!md || buf.latin1Slice(md.pos, md.pos + 4) !== 'MD20') throw new Error('Not an M2 model');
  const b = md.pos;
  const u32 = (o) => buf.readUInt32LE(b + o);
  const arr = (o) => ({ count: u32(o), offset: b + u32(o + 4) });
  const end = md.pos + md.size;
  const ok = (a, stride) => a.count === 0 || (a.offset >= b && a.offset + a.count * stride <= end);

  const vertices = arr(0x3c), textures = arr(0x50), materials = arr(0x70), texCombos = arr(0x80);
  const colIdx = arr(0xd8), colPos = arr(0xe0);
  if (!ok(vertices, 48) || !ok(textures, 16) || !ok(materials, 4) || !ok(texCombos, 2)) throw new Error('M2 header out of range');

  // The name the model carries inside itself ("ElwynnTreeMid01"); a good many have none.
  const nameAt = arr(0x08);
  const name = nameAt.count > 0 && nameAt.count < 200 && ok(nameAt, 1) ? buf.latin1Slice(nameAt.offset, nameAt.offset + nameAt.count).replace(/\0.*$/, '') : '';
  const m = {
    name,
    version: u32(4), flags: u32(0x10), nVertices: vertices.count,
    bbox: [0, 1, 2, 3, 4, 5].map((i) => buf.readFloatLE(b + 0xa0 + i * 4)),
    radius: buf.readFloatLE(b + 0xb8),
    positions: new Float32Array(vertices.count * 3), normals: new Float32Array(vertices.count * 3), uvs: new Float32Array(vertices.count * 2),
    textures: [], materials: [], texCombos: [], skinFiles: [], collision: null,
    colorUnseen: null, weightUnseen: null, weightLookup: null, // (see "what of it is never seen" below)
  };
  for (let i = 0; i < vertices.count; i++) {
    const p = vertices.offset + i * 48;
    for (let k = 0; k < 3; k++) { m.positions[i * 3 + k] = buf.readFloatLE(p + k * 4); m.normals[i * 3 + k] = buf.readFloatLE(p + 20 + k * 4); }
    m.uvs[i * 2] = buf.readFloatLE(p + 32); m.uvs[i * 2 + 1] = buf.readFloatLE(p + 36);
  }
  const txid = chunks.get('TXID');
  for (let i = 0; i < textures.count; i++) {
    const p = textures.offset + i * 16;
    const type = buf.readUInt32LE(p);
    // type 0 = fixed texture (file id in TXID); other types are runtime-substituted skins
    const fdid = type === 0 && txid && i * 4 < txid.size ? buf.readUInt32LE(txid.pos + i * 4) : 0;
    m.textures.push({ type, flags: buf.readUInt32LE(p + 4), fdid });
  }
  for (let i = 0; i < materials.count; i++) m.materials.push({ flags: buf.readUInt16LE(materials.offset + i * 4), blend: buf.readUInt16LE(materials.offset + i * 4 + 2) });
  for (let i = 0; i < texCombos.count; i++) m.texCombos.push(buf.readUInt16LE(texCombos.offset + i * 2));

  // ---- what of it is never seen ---------------------------------------------------------------
  // Each part is drawn through a transparency and a colour that the object's animations can
  // change. That is how one model holds a door whole and the same door broken, an invisible
  // wall, the carrier of a beam of light: the part that is not to be seen is drawn fully
  // transparent, which the game takes as "do not draw". An object put down in the world plays
  // one animation, standing; a part that is fully transparent at every key of that one (or of
  // a clock of its own that the track runs on) is never seen there.
  const seqs = arr(0x1c), colors = arr(0x48), weights = arr(0x58), weightLookup = arr(0x90);
  let stand = -1;
  if (ok(seqs, 64)) {
    for (let i = 0; i < seqs.count && stand < 0; i++) if (buf.readUInt16LE(seqs.offset + i * 64) === 0) stand = i;
    // (its keys are in this file: not in a file of their own, not borrowed from another animation)
    if (stand >= 0 && (buf.readUInt32LE(seqs.offset + stand * 64 + 12) & 0x60) !== 0x20) stand = -1;
  }
  const zeroThroughout = (at) => {
    if (at < b || at + 20 > end) return 0;
    const which = buf.readInt16LE(at + 2) >= 0 ? 0 : stand; // (on a clock of its own: one row of keys)
    const count = buf.readUInt32LE(at + 12), rows = b + buf.readUInt32LE(at + 16);
    if (which < 0 || which >= count || rows < b || rows + count * 8 > end) return 0;
    const n = buf.readUInt32LE(rows + which * 8), keys = b + buf.readUInt32LE(rows + which * 8 + 4);
    if (!n || keys < b || keys + n * 2 > end) return 0; // no keys: the game takes "all there"
    for (let k = 0; k < n; k++) if (buf.readInt16LE(keys + k * 2) !== 0) return 0;
    return 1;
  };
  m.colorUnseen = new Uint8Array(ok(colors, 40) ? colors.count : 0);
  for (let i = 0; i < m.colorUnseen.length; i++) m.colorUnseen[i] = zeroThroughout(colors.offset + i * 40 + 20); // (its alpha: after the colour itself)
  m.weightUnseen = new Uint8Array(ok(weights, 20) ? weights.count : 0);
  for (let i = 0; i < m.weightUnseen.length; i++) m.weightUnseen[i] = zeroThroughout(weights.offset + i * 20);
  m.weightLookup = new Uint16Array(ok(weightLookup, 2) ? weightLookup.count : 0);
  for (let i = 0; i < m.weightLookup.length; i++) m.weightLookup[i] = buf.readUInt16LE(weightLookup.offset + i * 2);

  const sfid = chunks.get('SFID');
  const nSkins = u32(0x44);
  if (sfid) for (let i = 0; i < nSkins && i * 4 < sfid.size; i++) m.skinFiles.push(buf.readUInt32LE(sfid.pos + i * 4));
  if (colIdx.count >= 3 && colPos.count > 0 && ok(colIdx, 2) && ok(colPos, 12)) {
    const indices = new Uint32Array(colIdx.count);
    for (let i = 0; i < colIdx.count; i++) indices[i] = buf.readUInt16LE(colIdx.offset + i * 2);
    const positions = new Float32Array(colPos.count * 3);
    for (let i = 0; i < colPos.count * 3; i++) positions[i] = buf.readFloatLE(colPos.offset + i * 4);
    m.collision = { indices, positions };
  }
  return m;
}

/** Skin profile: triangle list + draw batches for one level of detail. */
export function parseSkin(buf) {
  if (buf.latin1Slice(0, 4) !== 'SKIN') throw new Error('Not an M2 skin');
  const arr = (o) => ({ count: buf.readUInt32LE(o), offset: buf.readUInt32LE(o + 4) });
  const verts = arr(4), idx = arr(12), subs = arr(28), batches = arr(36);
  const lookup = new Uint16Array(verts.count);
  for (let i = 0; i < verts.count; i++) lookup[i] = buf.readUInt16LE(verts.offset + i * 2);
  const indices = new Uint32Array(idx.count);
  for (let i = 0; i < idx.count; i++) indices[i] = lookup[buf.readUInt16LE(idx.offset + i * 2)] ?? 0;
  const sections = [];
  for (let i = 0; i < subs.count; i++) {
    const p = subs.offset + i * 48;
    sections.push({ id: buf.readUInt16LE(p), indexStart: buf.readUInt16LE(p + 8) + (buf.readUInt16LE(p + 2) << 16), indexCount: buf.readUInt16LE(p + 10) });
  }
  const out = [];
  for (let i = 0; i < batches.count; i++) {
    const p = batches.offset + i * 24;
    out.push({
      flags: buf[p], section: buf.readUInt16LE(p + 4), material: buf.readUInt16LE(p + 10), layer: buf.readUInt16LE(p + 12),
      textureCount: buf.readUInt16LE(p + 14), textureCombo: buf.readUInt16LE(p + 16),
      color: buf.readInt16LE(p + 8), weightCombo: buf.readUInt16LE(p + 20), // (which colour and transparency it is drawn through; -1: no colour)
    });
  }
  return { indices, sections, batches: out };
}

/** A draw batch of a skin that is never seen where the object stands (see parseM2: "what of it is never seen"). */
export function unseen(m, batch) {
  if (batch.color >= 0 && m.colorUnseen?.[batch.color]) return true;
  const w = m.weightLookup?.[batch.weightCombo];
  return w !== undefined && !!m.weightUnseen?.[w];
}
