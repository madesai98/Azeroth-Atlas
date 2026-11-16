// What the game was sent after its files were made: the hotfix cache.
//
// The game's files do not hold every record of every table. Blizzard sends the rest, and every
// correction, when you log in, and the game keeps them in <flavour>/Cache/ADB/<language>/DBCache.bin.
// In this game four items in ten are known to the client from there alone (their record in the
// ItemSparse table: the name, the quality, the levels...), so a list of items made from the
// files only would be missing them.
//
// The file is a row of entries, each saying which table it belongs to (by a number made from the
// table's name), which record, and the record itself with its fields one after the other. An
// entry sent later stands in for one sent before.
import fs from 'node:fs';
import path from 'node:path';
import { flavourFolder } from './config.js';

/** The number a table goes by in the cache (the same one its own file carries in its header). */
export const TABLE_HASH = { Item: 0x50238ec2, ItemSparse: 0x919be54e };

export function cacheFile(cfg, language = 'enUS') {
  const folder = flavourFolder(cfg);
  return folder ? path.join(cfg.installRoot, folder, 'Cache', 'ADB', language, 'DBCache.bin') : null;
}

/** The cache as it is on disk now: its size and when it was written ('' when there is none). */
export function cacheStamp(cfg) {
  try { const st = fs.statSync(cacheFile(cfg)); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; }
}

/**
 * Every record the cache holds for the tables asked for (none named: for every table), in the
 * order they were sent.
 * @returns Map<table hash, [{ id, data: Buffer | null }]> (data null: the record was taken away); null when there is no cache
 */
export function readCache(cfg, hashes = null) {
  let buf;
  try { buf = fs.readFileSync(cacheFile(cfg)); } catch { return null; }
  if (buf.length < 44 || buf.latin1Slice(0, 4) !== 'XFTH') return null;
  const version = buf.readUInt32LE(4);
  if (version < 8 || version > 9) return null; // (a layout not known here: better nothing than a guess)
  const want = hashes ? new Set(hashes) : null;
  const out = new Map((hashes ?? []).map((h) => [h, []]));
  const list = (table) => { let l = out.get(table); if (!l) out.set(table, l = []); return l; };
  const head = version >= 9 ? 32 : 28; // (9 added the region before the push number)
  let p = 44;
  while (p + head <= buf.length) {
    if (buf.latin1Slice(p, p + 4) !== 'XFTH') break;
    const q = p + (version >= 9 ? 8 : 4);
    const table = buf.readUInt32LE(q + 8), id = buf.readUInt32LE(q + 12), size = buf.readUInt32LE(q + 16), status = buf[q + 20];
    const data = p + head;
    if (data + size > buf.length) break;
    if (!want || want.has(table)) {
      if (status === 1 && size > 0) list(table).push({ id, data: buf.subarray(data, data + size) });
      else if (status === 2) list(table).push({ id, data: null });
    }
    p = data + size;
  }
  return out;
}
