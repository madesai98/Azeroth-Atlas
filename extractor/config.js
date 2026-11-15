// Project configuration (config.json in the project root).
//
// config.json is each computer's own: it is not part of what the map tool is updated with, and
// need not exist at all. Without one (or without a game folder in it) the game is looked for in
// the places it is usually installed; where it cannot be found, the map page asks (see
// server/setup.js) and what you answer is written to config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where what is yours is kept: config.json, and the map data unless config.json names another
 * place. The map tool's own folder - except in the installed application, which keeps them
 * outside itself (app/main.cjs says where), so that a new copy of the application can take the
 * place of an old one and nothing is lost.
 */
export const HOME = process.env.AZEROTH_ATLAS_HOME ? path.resolve(process.env.AZEROTH_ATLAS_HOME) : PROJECT_ROOT;
export const CONFIG_FILE = path.join(HOME, 'config.json');

const DEFAULTS = {
  // Folder that contains ".build.info" (the Battle.net game folder, not the _forever_ subfolder).
  // Empty: looked for (see findInstalls).
  installRoot: '',
  // Battle.net product code of the installed game flavour.
  product: 'wowf',
  // Where extracted map data is written. Never inside the game folder.
  dataDir: path.join(HOME, 'data'),
  port: 5173,
  // Worker threads used by the extractor (0 = automatic).
  workers: 0,
};

/** Name of the game's flavour folder for the configured product (e.g. "_forever_"), or null. */
export function flavourFolder(cfg) {
  try {
    for (const entry of fs.readdirSync(cfg.installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const info = path.join(cfg.installRoot, entry.name, '.flavor.info');
      if (!fs.existsSync(info)) continue;
      if (fs.readFileSync(info, 'utf8').split(/\r?\n/).some((l) => l.trim() === cfg.product)) return entry.name;
    }
  } catch { /* install folder unreadable */ }
  return null;
}

/**
 * What a folder is, as a place the game might be:
 * 'ok' (the game, with the flavour asked for), 'other' (the game, but not that flavour), 'none'.
 */
export function checkInstall(root, product = DEFAULTS.product) {
  try { if (!root || !fs.existsSync(path.join(root, '.build.info'))) return 'none'; } catch { return 'none'; }
  return flavourFolder({ installRoot: root, product }) ? 'ok' : 'other';
}

/**
 * Where the game is installed on this computer, as far as can be told without being told:
 * the folders that hold the flavour asked for, likeliest first. (Windows; nothing elsewhere.)
 * Looked for: where the registry says the game is, where Battle.net's own list of what is
 * installed says, and a "World of Warcraft" folder in the usual places on every drive.
 */
export function findInstalls(product = DEFAULTS.product) {
  if (process.platform !== 'win32' || process.env.WFMAP_NO_DETECT) return [];
  const tried = new Set(), found = [];
  const NAME = 'World of Warcraft';
  const look = (p) => {
    if (!p) return;
    // (the folder itself, and the two above it: the registry and Battle.net name the flavour's own folder as often as the game's)
    for (let at = path.resolve(p), i = 0; i < 3; i++, at = path.dirname(at)) {
      const key = at.toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      if (checkInstall(at, product) === 'ok') found.push(at);
    }
  };
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft', 'HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft']) {
    try {
      const r = spawnSync('reg', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(r.stdout ?? '');
      if (m) look(m[1].trim());
    } catch { /* no such key */ }
  }
  try {
    // (a binary list: the folders are in it as plain text; whatever follows a folder's name is cut off at the name)
    const db = fs.readFileSync(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Battle.net', 'Agent', 'product.db')).toString('latin1');
    for (const m of db.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"<>|?*]{2,200}/g)) {
      const at = m[0].indexOf(NAME);
      look(at >= 0 ? m[0].slice(0, at + NAME.length) : m[0]);
    }
  } catch { /* Battle.net keeps no list here */ }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    try { if (!fs.existsSync(drive)) continue; } catch { continue; }
    look(path.join(drive, NAME));
    for (const dir of ['Program Files (x86)', 'Program Files', 'Games', 'Blizzard', 'Battle.net']) look(path.join(drive, dir, NAME));
    try {
      for (const e of fs.readdirSync(drive, { withFileTypes: true })) if (e.isDirectory() && !/^(\$|Windows$|System Volume)/i.test(e.name)) look(path.join(drive, e.name, NAME));
    } catch { /* a drive that cannot be read */ }
  }
  return found;
}

/** What config.json holds (nothing, where there is none). */
export function readConfigFile(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${file} cannot be read (${err.message})`); }
}

/**
 * The settings in use. Throws an error with code 'NO_GAME' where the game cannot be found:
 * { configured (what config.json names, if anything), product }.
 */
export function loadConfig(file = CONFIG_FILE) {
  const user = readConfigFile(file);
  const cfg = { ...DEFAULTS, ...user };
  if (checkInstall(cfg.installRoot, cfg.product) === 'none') {
    // (not set, or no longer there: wherever it is found)
    const named = cfg.installRoot;
    const found = findInstalls(cfg.product);
    if (!found.length) {
      throw Object.assign(new Error(named ? `No game installation found at ${named} (missing .build.info), nor anywhere it is usually installed` : 'The game was not found in any of the places it is usually installed'),
        { code: 'NO_GAME', configured: named || null, product: cfg.product, port: cfg.port });
    }
    cfg.installRoot = found[0];
    cfg.foundGame = true; // (found, not named in config.json)
  }
  cfg.dataDir = path.resolve(HOME, cfg.dataDir);
  const gameData = path.resolve(cfg.installRoot);
  if (cfg.dataDir.toLowerCase().startsWith(gameData.toLowerCase() + path.sep)) {
    throw new Error('dataDir must not be inside the game folder');
  }
  if (!cfg.workers) cfg.workers = Math.max(2, Math.min(12, os.availableParallelism() - 2));
  return cfg;
}
