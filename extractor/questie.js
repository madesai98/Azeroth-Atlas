// Reads the QuestieDB addon installed in the game's AddOns folder: every creature (name, level,
// what it does, where it stands, its patrol paths), every quest (who gives and takes it, what it
// asks for), the objects quests use, and the items they ask for. QuestieDB is
// community-maintained public data; it is only read, never modified.
//
// Layout (see QuestieDB/src/read/baked.lua and src/meta/*.lua): one line per stored value,
//
//   ## X-<Entity>-<id>-S: base64(CBOR map)   the scalar fields, keyed by field number
//   ## X-<Entity>-<id>-<n>: base64(CBOR)     table field number n (spawns, quest lists, ...)
//   a value of "~N~" means the payload continues in "<key>-1" .. "<key>-N"
//
// where Entity is Npc, Quest, Object or Item, and the field numbers are those of the meta files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeCBOR } from './formats/cbor.js';
import { flavourFolder } from './config.js';

const SUPPORTED_CONTRACTS = new Set(['4']);
const NPC = { name: 1, minLevel: 4, maxLevel: 5, rank: 6, spawns: 7, paths: 8, zone: 9, questStarts: 10, questEnds: 11, faction: 12, friendly: 13, subName: 14, flags: 15 };
const QUEST = { name: 1, startedBy: 2, finishedBy: 3, requiredLevel: 4, questLevel: 5, requiredRaces: 6, requiredClasses: 7, objectivesText: 8, triggerEnd: 9, objectives: 10, sourceItem: 11, preGroup: 12, preSingle: 13, exclusiveTo: 16, zoneOrSort: 17, next: 22, questFlags: 23, specialFlags: 24, parent: 25, maxLevel: 32 };
const OBJECT = { name: 1, questStarts: 2, questEnds: 3, spawns: 4, zone: 5 };
const ITEM = { name: 1, npcDrops: 2, objectDrops: 3, vendors: 14 };

/** Path of the QuestieDB data file for this game flavour, or null if the addon is not installed. */
export function findQuestieDb(cfg) {
  const folder = flavourFolder(cfg);
  if (!folder) return null;
  const dir = path.join(cfg.installRoot, folder, 'Interface', 'AddOns', 'QuestieDB');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^QuestieDB.*\.toc$/i.test(f)); } catch { return null; }
  if (!files.length) return null;
  // Several flavour-named copies may sit side by side; prefer the one named after this flavour.
  const want = folder.replace(/_/g, '').toLowerCase();
  files.sort((a, b) => (b.toLowerCase().includes(want) ? 1 : 0) - (a.toLowerCase().includes(want) ? 1 : 0) || a.localeCompare(b));
  return path.join(dir, files[0]);
}

/**
 * Cheap fingerprint of the data file (size + modified time). The map remembers the one it was
 * built from, so the server can tell when the addon has been updated since.
 */
export function questieStamp(file) {
  if (!file) return null;
  try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return null; }
}

const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : null);
const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
/** A positional list that may be stored as a plain list or, when sparse, as a map keyed by position (from 1). */
const slot = (v, i) => (Array.isArray(v) ? v[i - 1] : v instanceof Map ? v.get(i) : undefined);

/** One entity's stored values: ids() lists the entries, row(id) their scalar fields, field(id, n) a table field. */
function entity(src, name) {
  const store = new Map();
  for (const m of src.matchAll(new RegExp(`^## X-${name}-(\\d+(?:-[0-9A-Za-z]+)+): (.*)$`, 'gm'))) store.set(m[1], m[2].trim());
  const get = (key) => {
    let v = store.get(key);
    if (v === undefined) return null;
    const chunks = /^~(\d+)~$/.exec(v);
    if (chunks) {
      v = '';
      for (let i = 1; i <= +chunks[1]; i++) v += store.get(`${key}-${i}`) ?? '';
    }
    try { return decodeCBOR(Buffer.from(v, 'base64')); } catch { return null; }
  };
  return {
    ids() { const out = []; for (const key of store.keys()) { const m = /^(\d+)-S$/.exec(key); if (m) out.push(+m[1]); } return out; },
    /** The scalar fields as a Map keyed by field number (a row whose fields run from 1 is stored as a plain list). */
    row(id) {
      let row = get(`${id}-S`);
      if (Array.isArray(row)) row = new Map(row.map((v, i) => [i + 1, v]).filter(([, v]) => v !== null && v !== undefined));
      return row instanceof Map ? row : null;
    },
    field(id, n) { return get(`${id}-${n}`); },
  };
}

/**
 * @returns {{ file, hash, version, flavor,
 *   npcs: Array<{ id, name, minLevel, maxLevel, rank, zone, faction, friendly, subName, flags, questStarts: number[], questEnds: number[], questGiver,
 *                 spawns: Map<zoneAreaId, number[][]>|null, paths: Map<zoneAreaId, number[][][]>|null }>,
 *   objects: Array<{ id, name, zone, questStarts, questEnds, spawns }>,
 *   quests: Array<{ id, name, level, minLevel, maxLevel, races, classes, starts: { npcs, objects, items }, ends: { npcs, objects },
 *                   text: string[], pre: number[], preAll: number[], exclusive: number[], next, parent, zoneOrSort, flags, special, sourceItem,
 *                   objectives: { creatures, objects, items, killCredit }, trigger: { text, spawns: Map }|null }>,
 *   item(id): { id, name, npcDrops, objectDrops, vendors } | null }}
 */
export function readQuestie(file) {
  const raw = fs.readFileSync(file);
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const src = raw.toString('utf8');
  const meta = (key) => new RegExp(`^## ${key}:\\s*(.*)$`, 'm').exec(src)?.[1].trim() ?? null;
  const contract = meta('X-Contract-Version');
  if (meta('X-Mode') !== 'baked' || !SUPPORTED_CONTRACTS.has(contract)) {
    throw new Error(`unsupported QuestieDB layout (mode ${meta('X-Mode')}, contract ${contract})`);
  }

  const N = entity(src, 'Npc');
  const npcs = [];
  for (const id of N.ids()) {
    const row = N.row(id);
    if (!row) continue;
    const questStarts = ids(N.field(id, NPC.questStarts)), questEnds = ids(N.field(id, NPC.questEnds));
    const npc = {
      id, name: text(row.get(NPC.name)) ?? `Creature ${id}`,
      minLevel: row.get(NPC.minLevel) ?? 0, maxLevel: row.get(NPC.maxLevel) ?? row.get(NPC.minLevel) ?? 0,
      rank: row.get(NPC.rank) ?? 0, zone: row.get(NPC.zone) ?? 0, faction: row.get(NPC.faction) ?? 0,
      friendly: text(row.get(NPC.friendly)), subName: text(row.get(NPC.subName)), flags: row.get(NPC.flags) ?? 0, spawns: null, paths: null,
      questStarts, questEnds,
      // gives or takes quests (so it is someone you talk to, not something that attacks you)
      questGiver: questStarts.length > 0 || questEnds.length > 0,
    };
    const s = N.field(id, NPC.spawns);
    if (s instanceof Map && s.size) npc.spawns = s;
    const w = N.field(id, NPC.paths);
    if (w instanceof Map && w.size) npc.paths = w;
    npcs.push(npc);
  }
  if (!npcs.length) throw new Error('no creature entries found in QuestieDB');

  const O = entity(src, 'Object');
  const objects = [];
  for (const id of O.ids()) {
    const row = O.row(id);
    if (!row) continue;
    const s = O.field(id, OBJECT.spawns);
    objects.push({ id, name: text(row.get(OBJECT.name)) ?? `Object ${id}`, zone: row.get(OBJECT.zone) ?? 0, questStarts: ids(O.field(id, OBJECT.questStarts)), questEnds: ids(O.field(id, OBJECT.questEnds)), spawns: s instanceof Map && s.size ? s : null });
  }

  const Q = entity(src, 'Quest');
  const quests = [];
  // an objective group is a list of rows whose first value is the id of what is wanted
  const wanted = (group) => (Array.isArray(group) ? group.map((r) => (Array.isArray(r) ? r[0] : r)).filter((n) => Number.isInteger(n) && n > 0) : []);
  for (const id of Q.ids()) {
    const row = Q.row(id);
    if (!row) continue;
    const name = text(row.get(QUEST.name));
    if (!name) continue;
    const started = Q.field(id, QUEST.startedBy), finished = Q.field(id, QUEST.finishedBy), obj = Q.field(id, QUEST.objectives), trig = Q.field(id, QUEST.triggerEnd);
    quests.push({
      id, name,
      level: row.get(QUEST.questLevel) ?? 0, minLevel: row.get(QUEST.requiredLevel) ?? 0, maxLevel: row.get(QUEST.maxLevel) ?? 0,
      races: row.get(QUEST.requiredRaces) ?? 0, classes: row.get(QUEST.requiredClasses) ?? 0,
      starts: { npcs: ids(slot(started, 1)), objects: ids(slot(started, 2)), items: ids(slot(started, 3)) },
      ends: { npcs: ids(slot(finished, 1)), objects: ids(slot(finished, 2)) },
      text: (Q.field(id, QUEST.objectivesText) ?? []).map(text).filter(Boolean),
      pre: ids(Q.field(id, QUEST.preSingle)), preAll: ids(Q.field(id, QUEST.preGroup)), exclusive: ids(Q.field(id, QUEST.exclusiveTo)),
      next: row.get(QUEST.next) ?? 0, parent: row.get(QUEST.parent) ?? 0, zoneOrSort: row.get(QUEST.zoneOrSort) ?? 0,
      flags: row.get(QUEST.questFlags) ?? 0, special: row.get(QUEST.specialFlags) ?? 0, sourceItem: row.get(QUEST.sourceItem) ?? 0,
      objectives: { creatures: wanted(slot(obj, 1)), objects: wanted(slot(obj, 2)), items: wanted(slot(obj, 3)), killCredit: wanted(slot(obj, 5)) },
      trigger: Array.isArray(trig) && trig[1] instanceof Map ? { text: text(trig[0]) ?? '', spawns: trig[1] } : null,
    });
  }

  const I = entity(src, 'Item');
  const item = (id) => {
    const row = I.row(id);
    if (!row) return null;
    return { id, name: text(row.get(ITEM.name)) ?? `Item ${id}`, npcDrops: ids(I.field(id, ITEM.npcDrops)), objectDrops: ids(I.field(id, ITEM.objectDrops)), vendors: ids(I.field(id, ITEM.vendors)) };
  };
  return { file, hash, version: meta('Version'), flavor: meta('X-Flavor'), npcs, objects, quests, item };
}

/** The creatures alone (kept for callers that only want those). */
export function readQuestieNpcs(file) {
  const db = readQuestie(file);
  return { file: db.file, hash: db.hash, version: db.version, flavor: db.flavor, npcs: db.npcs };
}
