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
    });
  }
  return { indices, sections, batches: out };
}
