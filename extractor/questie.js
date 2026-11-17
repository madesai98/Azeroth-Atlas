// Reads QuestieDB: every creature (name, level, what it does, where it stands, its patrol
// paths), every quest (who gives and takes it, what it asks for), the objects quests use, and
// the items they ask for. QuestieDB is community-maintained public data, published as an addon
// for the game; it is only read, never modified.
//
// Where it is read from (findQuestieDb): the copy the map fetched from the Atlas database
// (atlasdb/questiedb.js: a scheduled function puts every new version of QuestieDB there, so
// nobody needs the addon for the map's sake), or the addon in the game's own AddOns folder where
// that is installed and is the newer of the two. Both are the same files, laid out the same way.
//
// Layout (see QuestieDB/src/read/baked.lua and src/meta/*.lua): one line per stored value,
//
//   ## X-<Entity>-<id>-S: base64(CBOR map)   the scalar fields, keyed by field number
//   ## X-<Entity>-<id>-<n>: base64(CBOR)     table field number n (spawns, quest lists, ...)
//   a value of "~N~" means the payload continues in "<key>-1" .. "<key>-N"
//
// where Entity is Npc, Quest, Object or Item, and the field numbers are those of the meta files.
// A value that is zero or empty is simply not stored.
//
// (What the addon keeps beside this file, in its support folder: see questie-extras.js.)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeCBOR } from './formats/cbor.js';
import { flavourFolder } from './config.js';

/** The layouts of the data file this version of the map can read (its "X-Contract-Version"), written in "baked" mode. */
export const SUPPORTED_CONTRACTS = new Set(['4']);
export const FLAVOUR = 'Forever';
/** The data file's name for this game, as the addon has it. */
export const TOC_NAME = `QuestieDB_${FLAVOUR}.toc`;
// (fields 2 and 3 of a creature, its health, are placeholders: no creature has them)
const NPC = { name: 1, minLevel: 4, maxLevel: 5, rank: 6, spawns: 7, paths: 8, zone: 9, questStarts: 10, questEnds: 11, faction: 12, friendly: 13, subName: 14, flags: 15 };
const QUEST = { name: 1, startedBy: 2, finishedBy: 3, requiredLevel: 4, questLevel: 5, requiredRaces: 6, requiredClasses: 7, objectivesText: 8, triggerEnd: 9, objectives: 10, sourceItem: 11, preGroup: 12, preSingle: 13, exclusiveTo: 16, zoneOrSort: 17, next: 22, questFlags: 23, specialFlags: 24, parent: 25, maxLevel: 32 };
// the rest of a quest's fields: each is on a quest only when the data has it
const QUEST_MORE = { childQuests: 14, inGroupWith: 15, requiredSkill: 18, requiredMinRep: 19, requiredMaxRep: 20, requiredSourceItems: 21, reputationReward: 26, breadcrumbFor: 27, breadcrumbs: 28, extraObjectives: 29, requiredSpell: 30, requiredSpecialization: 31, availableUntilCompleted: 33, availableStartingWith: 34, requiredRanks: 35, disabledByQuest: 36 };
// (field 7 of an object, the path of one that rides a ship, is in no object of this data)
const OBJECT = { name: 1, questStarts: 2, questEnds: 3, spawns: 4, zone: 5, faction: 6 };
// (fields 8 and 16 of an item, its food type and the spell it teaches, are in no item of this data)
const ITEM = { name: 1, npcDrops: 2, objectDrops: 3, itemDrops: 4, startQuest: 5, questRewards: 6, flags: 7, itemLevel: 9, requiredLevel: 10, ammoType: 11, class: 12, subClass: 13, vendors: 14, relatedQuests: 15 };

/** Where the copy fetched from the Atlas database is kept (atlasdb/questiedb.js writes it). */
export const fetchedQuestieDir = (dataDir) => path.join(dataDir, 'sources', 'questiedb');

/**
 * Path of the data file in the copy fetched from the Atlas database, or null where there is
 * none. source.json there names the folder that is in use (a newer one is written beside it and
 * only then named, so a copy half fetched is never read).
 */
export function fetchedQuestieDb(cfg) {
  try {
    const dir = fetchedQuestieDir(cfg.dataDir);
    const note = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
    if (typeof note?.folder !== 'string' || !/^[A-Za-z0-9_][\w.-]*$/.test(note.folder)) return null;
    const file = path.join(dir, note.folder, 'QuestieDB', TOC_NAME);
    return fs.existsSync(file) ? file : null;
  } catch { return null; }
}

// What a data file says its version is (the first lines of it), remembered for as long as the file stays as it is.
const versions = new Map();
function versionOf(file) {
  try {
    const st = fs.statSync(file);
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    const had = versions.get(file);
    if (had?.key === key) return had.version;
    const fd = fs.openSync(file, 'r');
    let head;
    try { const buf = Buffer.alloc(8192); head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); }
    const version = /^## Version:\s*(\S+)/m.exec(head)?.[1] ?? null;
    versions.set(file, { key, version });
    return version;
  } catch { return null; }
}
/** Is version a later than b? By their numbers ("1.10.0" is later than "1.9.3"); what cannot be told is not later. */
export function laterVersion(a, b) {
  const nums = (v) => (/^v?(\d+(?:\.\d+)*)/.exec(String(v ?? ''))?.[1] ?? '').split('.').filter(Boolean).map(Number);
  const x = nums(a), y = nums(b);
  if (!x.length || !y.length) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0; }
  return false;
}

/**
 * Path of the QuestieDB data file the map is to be built from, or null if there is none: the
 * copy fetched from the Atlas database, or the addon in the game's folder where that is the
 * newer version (a database that has fallen behind does not hold back someone who keeps the
 * addon up to date), or the only one there is.
 */
export function findQuestieDb(cfg) {
  const fetched = fetchedQuestieDb(cfg), own = installedQuestieDb(cfg);
  if (!fetched || !own) return fetched ?? own;
  return laterVersion(versionOf(own), versionOf(fetched)) ? own : fetched;
}

/** Where a data file is from, in words: 'the Atlas database' or 'the addon in the game'. */
export function questieFrom(cfg, file) {
  return file && path.resolve(file).toLowerCase().startsWith(path.resolve(fetchedQuestieDir(cfg.dataDir)).toLowerCase() + path.sep) ? 'the Atlas database' : 'the addon in the game';
}

/** Path of the data file of the QuestieDB addon in the game's own AddOns folder, or null if the addon is not installed. */
export function installedQuestieDb(cfg) {
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

// A fingerprint of what is in a data file: the same for the same file wherever it lies. Worked
// out once, and again only when the file has changed (it is 18 MB: a fiftieth of a second).
const hashes = new Map();
export function questieHash(file) {
  const stamp = questieStamp(file);
  if (!stamp) return null;
  const had = hashes.get(file);
  if (had?.stamp === stamp) return had.hash;
  let hash = null;
  try { hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
  hashes.set(file, { stamp, hash });
  return hash;
}

/**
 * Was the map made from the data file that is in use now? `built` is what the map's manifest
 * noted of the file it was built from: { stamp, hash } (hash: since the data can come from the
 * Atlas database; a map built before that has the stamp alone).
 *
 * The same data in another place counts as the same: the copy fetched from the database where
 * the map was built from the addon in the game, or the other way round. Otherwise everyone who
 * has the addon would be told to update a map that has nothing to gain, the day the fetched
 * copy takes the addon's place.
 */
export function builtFromQuestie(cfg, file, built) {
  if (!file || !built) return false;
  if (built.stamp === questieStamp(file)) return true; // the very file, as it was
  const hash = questieHash(file);
  if (built.hash) return built.hash === hash;
  // (built before the fingerprint was noted: from the addon in the game, if that still is as it was then)
  const own = installedQuestieDb(cfg);
  return !!own && own !== file && built.stamp === questieStamp(own) && questieHash(own) === hash;
}

const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : null);
const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
/** A positional list that may be stored as a plain list or, when sparse, as a map keyed by position (from 1). */
const slot = (v, i) => (Array.isArray(v) ? v[i - 1] : v instanceof Map ? v.get(i) : undefined);
/** The same, whole: a positional list as a plain list (an empty place is null). */
const listOf = (v) => {
  if (Array.isArray(v)) return v;
  const out = [];
  if (v instanceof Map) for (const [k, x] of v) if (Number.isInteger(k) && k > 0) out[k - 1] = x;
  return Array.from(out, (x) => x ?? null);
};
/** A stored value with its byte strings as text, all the way down. */
const plain = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : Array.isArray(v) ? v.map(plain) : v instanceof Map ? new Map([...v].map(([k, x]) => [plain(k), plain(x)])) : v ?? null);
/** [id, value] (a skill and how much of it, a faction and the standing with it), or null when there is none. */
const pair = (v) => {
  const [a, b] = listOf(v);
  return Number.isInteger(a) && a > 0 && typeof b === 'number' ? [a, b] : null;
};
const pairs = (v) => listOf(v).map(pair).filter(Boolean);
/** Spots by zone: a map keyed by zone id, which is stored as a plain list when the ids run from 1 (zone 1 is Dun Morogh). */
const byZone = (v) => {
  if (Array.isArray(v)) v = new Map(v.map((x, i) => [i + 1, x]).filter(([, x]) => x !== null && x !== undefined));
  return v instanceof Map && v.size ? v : null;
};
/** Sets a field only when there is something to say: not null, not 0, not an empty list. */
const put = (o, key, v) => { if (v !== null && v !== undefined && v !== 0 && !(Array.isArray(v) && !v.length)) o[key] = v; };

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
 *   objects: Array<{ id, name, zone, questStarts, questEnds, spawns, faction }>,
 *   quests: Array<{ id, name, level, minLevel, maxLevel, races, classes, starts: { npcs, objects, items }, ends: { npcs, objects },
 *                   text: string[], pre: number[], preAll: number[], exclusive: number[], next, parent, zoneOrSort, flags, special, sourceItem,
 *                   objectives: { creatures, objects, items, killCredit }, trigger: { text, spawns: Map }|null,
 *                   ...and, each only where the data has it:
 *                   requiredSkill: [skillId, value], requiredMinRep / requiredMaxRep: [factionId, value],
 *                   requiredRanks: [[skillId, value], ...] (any one of them will do),
 *                   requiredSpell (below zero: the spell must NOT be known), requiredSpecialization,
 *                   requiredSourceItems: number[] (items needed along the way that are not objectives),
 *                   reputationReward: [[factionId, value], ...],
 *                   breadcrumbFor (the quest this one only leads to), breadcrumbs: number[] (the quests that lead to this one),
 *                   childQuests: number[], inGroupWith: number[],
 *                   availableUntilCompleted, availableStartingWith, disabledByQuest (quest ids),
 *                   extraObjectives: Array<[spawns: Map<zoneAreaId, number[][]>|null, icon, text|null, objective number, [[kind, id], ...]?]>
 *                     (kind is 'monster', 'object' or 'item'),
 *                   objectivesDetail: { creatures / objects / items: [[id, text|null, icon], ...] (text: the words shown instead of the name),
 *                     reputation: [factionId, value], killCredit: [[npcIds, the npc it counts as, text|null, icon], ...],
 *                     spell: [[spellId, text|null, the item that casts it], ...] } (each group only where it holds something) }>,
 *   item(id): { id, name, npcDrops, objectDrops, vendors, itemDrops (the containers it comes out of), questRewards, relatedQuests,
 *               startQuest, flags, itemLevel, requiredLevel, ammoType, class, subClass } | null   (0 where the data says nothing: class 0 is a consumable),
 *   itemIds(): number[]   every item there is something about, lowest id first }}
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
    if (byZone(s)) npc.spawns = byZone(s);
    const w = N.field(id, NPC.paths);
    if (byZone(w)) npc.paths = byZone(w);
    npcs.push(npc);
  }
  if (!npcs.length) throw new Error('no creature entries found in QuestieDB');

  const O = entity(src, 'Object');
  const objects = [];
  for (const id of O.ids()) {
    const row = O.row(id);
    if (!row) continue;
    const s = O.field(id, OBJECT.spawns);
    objects.push({ id, name: text(row.get(OBJECT.name)) ?? `Object ${id}`, zone: row.get(OBJECT.zone) ?? 0, questStarts: ids(O.field(id, OBJECT.questStarts)), questEnds: ids(O.field(id, OBJECT.questEnds)), spawns: byZone(s), faction: row.get(OBJECT.faction) ?? 0 });
  }

  const Q = entity(src, 'Quest');
  const quests = [];
  // an objective group is a list of rows whose first value is the id of what is wanted
  const wanted = (group) => (Array.isArray(group) ? group.map((r) => (Array.isArray(r) ? r[0] : r)).filter((n) => Number.isInteger(n) && n > 0) : []);
  // the same rows whole: [id, the words shown for it (if not its plain name), a number: the icon, or for a spell the item that casts it]
  const wantedRows = (group) => listOf(group).map((r) => (Number.isInteger(r) ? [r] : listOf(r))).filter((r) => Number.isInteger(r[0]) && r[0] > 0).map((r) => [r[0], text(r[1]), r[2] ?? 0]);
  // a kill that counts whichever of several creatures it was: [their ids, the one it counts as, words, icon]
  const creditRows = (group) => listOf(group).map(listOf).map((r) => [ids(listOf(r[0])), r[1] ?? 0, text(r[2]), r[3] ?? 0]).filter((r) => r[0].length);
  // a step the game does not list: [where (by zone) or null, icon, words, which objective it belongs to, what to look for: [[kind, id], ...]]
  const extraRows = (list) => listOf(list).map(listOf).filter((r) => r.length).map((r) => r.map((v, i) => (i === 0 ? byZone(v) : plain(v))));
  for (const id of Q.ids()) {
    const row = Q.row(id);
    if (!row) continue;
    const name = text(row.get(QUEST.name));
    if (!name) continue;
    const started = Q.field(id, QUEST.startedBy), finished = Q.field(id, QUEST.finishedBy), obj = Q.field(id, QUEST.objectives), trig = Q.field(id, QUEST.triggerEnd);
    const quest = {
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
      trigger: Array.isArray(trig) && byZone(trig[1]) ? { text: text(trig[0]) ?? '', spawns: byZone(trig[1]) } : null,
    };
    // what it takes to be offered the quest
    put(quest, 'requiredSkill', pair(Q.field(id, QUEST_MORE.requiredSkill)));
    put(quest, 'requiredMinRep', pair(Q.field(id, QUEST_MORE.requiredMinRep)));
    put(quest, 'requiredMaxRep', pair(Q.field(id, QUEST_MORE.requiredMaxRep)));
    put(quest, 'requiredRanks', pairs(Q.field(id, QUEST_MORE.requiredRanks)));
    put(quest, 'requiredSpell', row.get(QUEST_MORE.requiredSpell));
    put(quest, 'requiredSpecialization', row.get(QUEST_MORE.requiredSpecialization));
    put(quest, 'requiredSourceItems', ids(Q.field(id, QUEST_MORE.requiredSourceItems)));
    put(quest, 'reputationReward', pairs(Q.field(id, QUEST_MORE.reputationReward)));
    // how it hangs together with other quests
    put(quest, 'breadcrumbFor', row.get(QUEST_MORE.breadcrumbFor));
    put(quest, 'breadcrumbs', ids(Q.field(id, QUEST_MORE.breadcrumbs)));
    put(quest, 'childQuests', ids(Q.field(id, QUEST_MORE.childQuests)));
    put(quest, 'inGroupWith', ids(Q.field(id, QUEST_MORE.inGroupWith)));
    put(quest, 'availableUntilCompleted', row.get(QUEST_MORE.availableUntilCompleted));
    put(quest, 'availableStartingWith', row.get(QUEST_MORE.availableStartingWith));
    put(quest, 'disabledByQuest', row.get(QUEST_MORE.disabledByQuest));
    // what it asks for, in full
    put(quest, 'extraObjectives', extraRows(Q.field(id, QUEST_MORE.extraObjectives)));
    const detail = {};
    put(detail, 'creatures', wantedRows(slot(obj, 1)));
    put(detail, 'objects', wantedRows(slot(obj, 2)));
    put(detail, 'items', wantedRows(slot(obj, 3)));
    put(detail, 'reputation', pair(slot(obj, 4)));
    put(detail, 'killCredit', creditRows(slot(obj, 5)));
    put(detail, 'spell', wantedRows(slot(obj, 6)));
    if (Object.keys(detail).length) quest.objectivesDetail = detail;
    quests.push(quest);
  }

  const I = entity(src, 'Item');
  const item = (id) => {
    const row = I.row(id);
    if (!row) return null;
    return {
      id, name: text(row.get(ITEM.name)) ?? `Item ${id}`, npcDrops: ids(I.field(id, ITEM.npcDrops)), objectDrops: ids(I.field(id, ITEM.objectDrops)), vendors: ids(I.field(id, ITEM.vendors)),
      itemDrops: ids(I.field(id, ITEM.itemDrops)), questRewards: ids(I.field(id, ITEM.questRewards)), relatedQuests: ids(I.field(id, ITEM.relatedQuests)),
      startQuest: row.get(ITEM.startQuest) ?? 0, flags: row.get(ITEM.flags) ?? 0, itemLevel: row.get(ITEM.itemLevel) ?? 0, requiredLevel: row.get(ITEM.requiredLevel) ?? 0,
      ammoType: row.get(ITEM.ammoType) ?? 0, class: row.get(ITEM.class) ?? 0, subClass: row.get(ITEM.subClass) ?? 0,
    };
  };
  /** Every item there is something about (item(id) gives it), lowest id first. */
  const itemIds = () => I.ids().sort((a, b) => a - b);
  return { file, hash, version: meta('Version'), flavor: meta('X-Flavor'), npcs, objects, quests, item, itemIds };
}

/** The creatures alone (kept for callers that only want those). */
export function readQuestieNpcs(file) {
  const db = readQuestie(file);
  return { file: db.file, hash: db.hash, version: db.version, flavor: db.flavor, npcs: db.npcs };
}
