// What the Atlas database knows beyond QuestieDB, handed on to the game - so that whatever reads
// QuestieDB there (Questie itself, a guide pack, a map addon, the stand-in for Questie) is told
// what the 3D map shows.
//
// The map is built from QuestieDB with the Atlas database laid over it (extractor/atlas.js: what
// is believed over what). This works out the same for the QuestieDB that is in the game: it is
// read as the map reads it, the database is laid over it by the very same code, and whatever
// reads otherwise afterwards - in a field QuestieDB itself has - is a row for the game:
//
//   a creature, object or quest QuestieDB does not have        its whole row (an object only if it
//                                                              stands somewhere or a quest uses it)
//   a field QuestieDB says nothing of (a level it has as 0,    that field
//   somebody it does not place, a quest with no giver)
//   a name the game's own server gives otherwise               that name - laid over only where
//                                                              the game speaks the map's language
//   somebody QuestieDB puts in one place, whom players have    where they were met, as on the map
//   only ever met elsewhere (jobs/npcs.js: metElsewhere)       (needs the map built: world.json)
//
// and which objects are mailboxes, for whoever asks the stand-in for Questie where they are.
// Heights, health, what a vendor sells: QuestieDB has no field for those, and they stay the map's.
//
// The rows hold for that one QuestieDB (a field it "says nothing of" may be said in the next),
// so the file names it, and the addon in the game lays nothing over another one
// (addon/standins/Layer.lua). They are made again whenever the QuestieDB in the game, the
// database or the map's zones are another.
//
// As with the boats' times and the drop rates, the game can only be handed what it loads itself:
// the rows are written as a small addon of the map's own, AzerothAtlas_Facts - facts.lua (the
// rows) and layer.lua (which hands them to QuestieDB, as a "correction" under the map's own
// name: QuestieDB's files are not touched). Taken up when the game next loads its addons. Only
// written where QuestieDB is in the game and the box "QuestieDB" or "Questie" on the page is
// ticked (standins.js: layerWanted); with neither ticked, what was written is taken out again.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PROJECT_ROOT } from '../extractor/config.js';
import { writeFileAtomic } from '../extractor/container.js';
import { readQuestie, questieStamp } from '../extractor/questie.js';
import { ATLAS_VERSION, atlasStamp, readAtlas, layOver } from '../extractor/atlas.js';
import { addonsDir } from './addon.js';
import { FACTS, lookQuestieDb, layerWanted, interfaceVersion } from './standins.js';

const FORMAT = 1;       // of what is written: raise when the addon is to read it differently
const SEEN_SAME = 40;   // yards: met this close to the one place the databases have, they are there (jobs/npcs.js)
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return ''; } };

// ---- as Lua writes it ---------------------------------------------------------------------------
const luaText = (s) => '"' + String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const whole = (v) => Number.isInteger(v) && v > 0 && v < 16777216;
const idList = (list) => (Array.isArray(list) ? list.filter(whole) : []);
const luaIds = (list) => `{${list.join(',')}}`;
const point = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 100 && Math.abs(p[1]) <= 100;
/** Spots by zone ({ [zone] = { { x, y }, ... } }), or null where there are none. */
function luaSpawns(spawns) {
  const zones = [];
  for (const [zone, points] of spawns instanceof Map ? spawns : []) {
    const good = Number.isInteger(zone) && zone >= 0 && Array.isArray(points) ? points.filter(point) : [];
    if (good.length) zones.push(`[${zone}]={${good.map((p) => `{${num(p[0])},${num(p[1])}}`).join(',')}}`);
  }
  return zones.length ? `{${zones.join(',')}}` : null;
}
/** Groups by their place ({ [1] = {...}, [3] = {...} }): an empty one is left out, the others keep their number. */
const luaGroups = (groups) => { const out = groups.map((g, i) => (g ? `[${i + 1}]=${g}` : null)).filter(Boolean); return out.length ? `{${out.join(',')}}` : null; };
const givers = (...lists) => luaGroups(lists.map((l) => (idList(l).length ? luaIds(idList(l)) : null)));

// ---- one thing's fields, each as [what the map calls it, what QuestieDB calls it, how it is written] ----
const number = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? num(v) : null);
const text = (v) => (typeof v === 'string' && v.trim() ? luaText(v.trim()) : null);
const list = (v) => (idList(v).length ? luaIds(idList(v)) : null);
const side = (v) => (typeof v === 'string' && /^(A|H|AH)$/.test(v) ? luaText(v) : null);
const NPC = [['name', 'name', text], ['subName', 'subName', text], ['minLevel', 'minLevel', number], ['maxLevel', 'maxLevel', number], ['rank', 'rank', number], ['spawns', 'spawns', luaSpawns],
  ['zone', 'zoneID', number], ['questStarts', 'questStarts', list], ['questEnds', 'questEnds', list], ['faction', 'factionID', number], ['friendly', 'friendlyToFaction', side], ['flags', 'npcFlags', number]];
const OBJECT = [['name', 'name', text], ['questStarts', 'questStarts', list], ['questEnds', 'questEnds', list], ['spawns', 'spawns', luaSpawns], ['zone', 'zoneID', number], ['faction', 'factionID', number]];
const QUEST = [['name', 'name', text], ['starts', 'startedBy', (s) => givers(s?.npcs, s?.objects, s?.items)], ['ends', 'finishedBy', (e) => givers(e?.npcs, e?.objects)],
  ['minLevel', 'requiredLevel', number], ['level', 'questLevel', number], ['maxLevel', 'requiredMaxLevel', number], ['races', 'requiredRaces', number], ['classes', 'requiredClasses', number],
  ['text', 'objectivesText', (t) => (Array.isArray(t) && t.some((l) => typeof l === 'string' && l) ? `{${t.filter((l) => typeof l === 'string' && l).map(luaText).join(',')}}` : null)],
  // (what a quest asks for, as QuestieDB keeps it: { id, the words shown for it (none), its icon (0: the usual one) })
  ['objectives', 'objectives', (o) => luaGroups([o?.creatures, o?.objects, o?.items].map((l) => (idList(l).length ? `{${idList(l).map((id) => `{${id},nil,0}`).join(',')}}` : null)))],
  ['sourceItem', 'sourceItemId', number], ['preAll', 'preQuestGroup', list], ['pre', 'preQuestSingle', list], ['exclusive', 'exclusiveTo', list], ['zoneOrSort', 'zoneOrSort', number],
  ['next', 'nextQuestInChain', number], ['flags', 'questFlags', number], ['special', 'specialFlags', number], ['parent', 'parentQuest', number]];
/** The fields of an existing quest the database may fill in (atlas.js lays nothing else over one). */
const QUEST_FILLED = new Set(['starts', 'ends', 'minLevel', 'level']);
const NAMES = new Set(['name', 'subName']);

const placed = (thing) => thing.spawns instanceof Map && [...thing.spawns.values()].some((points) => Array.isArray(points) && points.some((p) => point(p) && p[0] >= 0 && p[1] >= 0));

/**
 * Where a place in the world is on a zone's own map: [area, across, down] in per cent of it, or
 * null (inside a dungeon, off every zone's map). Of the zones whose map shows the place, the one
 * the thing is said to be in, or else the one whose middle is nearest.
 */
function onZone(zones, at, wanted) {
  let best = null;
  for (const z of zones) {
    if (z.type !== 3 || z.map !== at.map || !whole(z.area) || !Array.isArray(z.region)) continue;
    const [x0, y0, x1, y1] = z.region;
    const down = ((x1 - at.x) / (x1 - x0)) * 100, across = ((y1 - at.y) / (y1 - y0)) * 100;
    if (!(down >= 0 && down <= 100 && across >= 0 && across <= 100)) continue;
    const far = z.area === wanted ? -1 : Math.hypot(at.x - (x0 + x1) / 2, at.y - (y0 + y1) / 2);
    if (!best || far < best.far) best = { far, spot: [z.area, Math.round(across * 100) / 100, Math.round(down * 100) / 100] };
  }
  return best?.spot ?? null;
}

/**
 * Somebody the databases put in one place only, whom players have only ever met elsewhere: where
 * they were met ([area, across, down]); and somebody no database places, who was met. Or null.
 * (The rule is the map's own - jobs/npcs.js, metElsewhere - so the game shows them where the map does.)
 */
function metAt(thing, zones) {
  if (!thing.seen?.length || thing.flat?.length) return null;
  const byArea = new Map(zones.filter((z) => z.type === 3 && whole(z.area) && Array.isArray(z.region)).map((z) => [z.area, z]));
  let one = null, any = false;
  for (const [zoneId, points] of thing.spawns ?? []) {
    for (const p of Array.isArray(points) ? points : []) {
      if (!point(p) || !(p[0] >= 0) || !(p[1] >= 0)) continue;
      any = true;
      const z = byArea.get(zoneId);
      if (!z) continue;
      if (one) return null; // (several places: a guard, a wanderer - whichever was met, the others are as likely)
      one = { map: z.map, x: z.region[2] - (p[1] / 100) * (z.region[2] - z.region[0]), y: z.region[3] - (p[0] / 100) * (z.region[3] - z.region[1]), area: zoneId };
    }
  }
  if (any && !one) return null; // (placed, but on no zone's map the map knows: left as it is)
  if (one && thing.seen.some((s) => s.map === one.map && Math.hypot(s.x - one.x, s.y - one.y) < SEEN_SAME)) return null;
  const met = (one && thing.seen.find((s) => s.map === one.map)) ?? thing.seen[0];
  return onZone(zones, met, one?.area ?? thing.zone);
}

/**
 * The rows for one QuestieDB: { lua (facts.lua), said: { rev, version, npc, object, quest, named, moved, mailboxes } } -
 * or null where no Atlas database has been fetched.
 * @param toc      the data file of the QuestieDB in the game
 * @param dataDir  where the map keeps the database (and world.json, once the map is built)
 */
export function buildFacts({ toc, dataDir, key = '' }) {
  const atlas = readAtlas(dataDir);
  if (!atlas) return null;
  const db = readQuestie(toc);
  const zones = readJson(path.join(dataDir, 'world.json'))?.zones;
  const top = fs.readFileSync(toc).toString('latin1', 0, 16384);
  const says = (k) => new RegExp(`^## ${k}:\\s*(.*)$`, 'm').exec(top)?.[1].trim() ?? null;

  // what each said before the database was laid over it
  const was = (things, fields) => new Map(things.map((x) => [x.id, Object.fromEntries(fields.map(([field, , write]) => [field, write(x[field])]))]));
  const before = { npc: was(db.npcs, NPC), object: was(db.objects, OBJECT), quest: was(db.quests, QUEST) };
  layOver(db, atlas, Array.isArray(zones) ? zones : null);

  // an object QuestieDB does not have is worth a row only if it stands somewhere or a quest has to do with it
  const used = new Set();
  for (const q of db.quests) for (const id of [...(q.starts?.objects ?? []), ...(q.ends?.objects ?? []), ...(q.objectives?.objects ?? [])]) used.add(id);

  const said = { rev: atlas.rev, version: db.version, npc: 0, object: 0, quest: 0, named: 0, moved: 0, mailboxes: 0 };
  const rows = { npc: [], object: [], quest: [] }, named = { npc: [], object: [] };
  const each = (kind, things, fields, keep = () => true) => {
    for (const x of [...things].sort((a, b) => a.id - b.id)) {
      if (!whole(x.id)) continue;
      const had = before[kind].get(x.id);
      if (!had && !keep(x)) continue;
      const row = [], names = [];
      for (const [field, key2, write] of fields) {
        if (had && kind === 'quest' && !QUEST_FILLED.has(field)) continue;
        const now = write(x[field]);
        if (now === null || (had && had[field] === now)) continue;
        // (a name QuestieDB has, and the game's server gives another: only for a game in the map's language)
        if (had && had[field] !== null && NAMES.has(field)) names.push(`${key2}=${now}`); else row.push(`${key2}=${now}`);
      }
      // where they were met, in place of the one place the databases have
      if (kind !== 'quest' && Array.isArray(zones)) {
        const met = metAt(x, zones);
        if (met) {
          const at = `spawns={[${met[0]}]={{${num(met[1])},${num(met[2])}}}}`, i = row.findIndex((f) => f.startsWith('spawns='));
          if (i >= 0) row[i] = at; else row.push(at);
          said.moved++;
        }
      }
      if (row.length) { rows[kind].push(`[${x.id}]={${row.join(',')}},`); said[kind]++; }
      if (names.length) { named[kind].push(`[${x.id}]={${names.join(',')}},`); said.named++; }
    }
  };
  each('npc', db.npcs, NPC);
  each('object', db.objects, OBJECT, (o) => placed(o) || o.questStarts?.length > 0 || o.questEnds?.length > 0 || used.has(o.id));
  each('quest', db.quests, QUEST);

  const mailboxes = db.objects.filter((o) => o.name === 'Mailbox' && whole(o.id) && placed(o)).map((o) => o.id).sort((a, b) => a - b);
  said.mailboxes = mailboxes.length;

  const table = (lines) => ['(function() return {', ...lines, '} end)()'].join('\n');
  const contract = Number(says('X-Contract-Version')) || 0, commit = says('X-BUILD-COMMIT');
  const lua = [
    `-- key: ${key}`,
    '-- Azeroth Atlas: what the Atlas database knows beyond QuestieDB, as rows for QuestieDB to lay over',
    '-- what it reads (layer.lua hands them to it). Written by the 3D map (server/facts.js): do not edit by',
    '-- hand. Worked out against the QuestieDB named here, and laid over that one alone. A row: the fields',
    '-- by QuestieDB\'s own names. named: names the game\'s server gives otherwise (for a game in English).',
    `AzerothAtlasFacts = { v = ${FORMAT}, rev = ${Number(atlas.rev) || 0}, hash = ${luaText(atlas.hash)}, contract = ${contract}, base = { version = ${luaText(db.version ?? '')}${commit ? `, commit = ${luaText(commit)}` : ''} }, mailboxes = ${luaIds(mailboxes)} }`,
    `AzerothAtlasFacts.npc = ${table(rows.npc)}`,
    `AzerothAtlasFacts.object = ${table(rows.object)}`,
    `AzerothAtlasFacts.quest = ${table(rows.quest)}`,
    `AzerothAtlasFacts.named = { npc = ${table(named.npc)}, object = ${table(named.object)} }`,
    '',
  ].join('\n');
  return { lua, said };
}

/** What the rows are made from, as it stands on the disk: another text for another QuestieDB, database or map - or null. */
export function factsKey(cfg, toc) {
  const stamp = atlasStamp(cfg.dataDir);
  return stamp && toc ? `${FORMAT}:${ATLAS_VERSION}:${stamp.hash}:${questieStamp(toc)}:${stampOf(path.join(cfg.dataDir, 'world.json'))}` : null;
}

/** The small addon's files other than the rows: { name: text }. */
export function factsAddonFiles(interfaceVersion) {
  return {
    [`${FACTS}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(the Atlas database, for QuestieDB)|r',
      '## Notes: What the Atlas database knows beyond QuestieDB - creatures and quests it does not have, where somebody stands that it does not place - laid over QuestieDB in the game, for Questie and every other addon that reads it. QuestieDB\'s own files are not touched. Written by the 3D map; with this switched off, QuestieDB is as its makers published it.',
      '## Group: AzerothAtlas',
      '## Dependencies: QuestieDB',
      '',
      'facts.lua',
      'layer.lua',
      '',
    ].join('\r\n'),
    'layer.lua': fs.readFileSync(path.join(PROJECT_ROOT, 'addon', 'standins', 'Layer.lua'), 'utf8'),
  };
}

const inThread = (data) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./facts-worker.js', import.meta.url), { workerData: data });
  worker.once('message', (m) => (m?.ok ? resolve(m.built) : reject(new Error(m?.error ?? 'the rows could not be worked out'))));
  worker.once('error', reject);
  worker.once('exit', (code) => { if (code) reject(new Error(`the rows could not be worked out (ended with code ${code})`)); });
});

let running = null;
/**
 * Write the rows for the game, where they are not there as they stand. The working out (half a
 * second) is done in a thread of its own, so the map goes on answering meanwhile.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), ...said } - or null
 *          where there is nobody to write them for (no QuestieDB in the game, or neither box
 *          ticked: what was written before is taken out), or nothing to write (no database
 *          fetched yet)
 */
export function writeFactsAddon(cfg, { thread = true } = {}) {
  if (running) return running;
  running = (async () => {
    const dir = addonsDir(cfg);
    if (!dir) return null;
    const folder = path.join(dir, FACTS);
    if (!layerWanted(cfg)) {
      // (nobody to lay them over for any more: the files this wrote, and the folder if nothing else is in it)
      if (fs.existsSync(folder)) {
        for (const name of [...Object.keys(factsAddonFiles('0')), 'facts.lua']) { try { fs.rmSync(path.join(folder, name)); } catch { /* not there */ } }
        try { fs.rmdirSync(folder); } catch { /* something of yours is in it: left */ }
      }
      return null;
    }
    const db = lookQuestieDb(cfg);
    const key = factsKey(cfg, db.toc);
    if (!key) return null;
    const fresh = !fs.existsSync(folder);
    const files = factsAddonFiles(interfaceVersion());
    // (the rows as they are written say what they were made from: the same, and they are not worked out again)
    let had = '';
    try { const fd = fs.openSync(path.join(folder, 'facts.lua'), 'r'); try { const buf = Buffer.alloc(400); had = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 400, 0)); } finally { fs.closeSync(fd); } } catch { /* none yet */ }
    let said = null;
    if (!had.startsWith(`-- key: ${key}\n`)) {
      const built = thread ? await inThread({ toc: db.toc, dataDir: cfg.dataDir, key }) : buildFacts({ toc: db.toc, dataDir: cfg.dataDir, key });
      if (!built) return null;
      files['facts.lua'] = built.lua;
      said = built.said;
    }
    let written = false;
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(folder, name);
      let same = false;
      try { same = fs.readFileSync(file, 'utf8') === text; } catch { /* not there yet */ }
      if (same) continue;
      writeFileAtomic(file, text);
      written = true;
    }
    return { ...(said ?? {}), written, fresh: fresh && written };
  })().finally(() => { running = null; });
  return running;
}
