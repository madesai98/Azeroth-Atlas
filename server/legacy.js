// From before the addon was called Azeroth Atlas.
//
// It used to be "Forever Map Link", in a folder named ForeverMapLink. To the game an addon is
// its folder: under another name it is another addon, with no settings, and both would run at
// once if the old one were left where it is. So when the addon is installed and a copy under
// the old name is found, what belongs to that copy is carried over, once:
//
//   - what it has saved (your settings, your place in your guides, the boat and tram times it
//     has learned): the game keeps that in WTF/Account/.../SavedVariables/ForeverMapLink.lua,
//     for the account and for each character. Each is copied to AzerothAtlas.lua beside it,
//     with the names in it changed. The old files are left as they are.
//   - guide packs converted to need the addon: they name it, and are made to name the new one.
//   - the old addon's folder and its route mailboxes are removed: only the files the old addon
//     itself put there, and its folder only if nothing else is left in it.
//
// Only while the game is closed. The game writes what an addon has saved when it exits, and
// reads an addon's files when it starts: carried over while it runs, the newest of what was
// saved would be left behind. Until then the old copy goes on working with the map as it did.
//
// This file can go once nobody has a copy from before 14 November 2026.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OLD = 'ForeverMapLink';
const NEW = 'AzerothAtlas';
const OLD_TITLE = /^## Title: Forever Map Link\s*$/m;
const OLD_FILES = ['Bindings.xml', 'ForeverMapLink.lua', 'ForeverMapLink.toc', 'Guide.lua', 'GuideBook.lua', 'GuideSteps.lua', 'GuideWindow.lua', 'Route.lua', 'Transit.lua', 'TransitData.lua'];
const OLD_MAIL = /^ForeverMapLink_Mail\d{3}$/;
const OLD_MARK = /^##[ \t]*X-ForeverMapLink-Converted[ \t]*:/im;
const NEEDED = /^(##[ \t]*(?:Required)?Dep\w*[ \t]*:)(.*)$/i;

/** Is a copy from before the new name installed? */
export function legacyInstalled(addonsDir) {
  if (!addonsDir) return false;
  try { return OLD_TITLE.test(fs.readFileSync(path.join(addonsDir, OLD, `${OLD}.toc`), 'utf8')); } catch { return false; }
}

/** Is the game running? true, false, or null where that cannot be told. */
export function gameRunning(flavourDir) {
  if (process.platform !== 'win32') return null;
  try {
    // (any program started out of the game's own folder)
    const folder = path.resolve(flavourDir).replace(/'/g, "''") + path.sep;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${folder}', [System.StringComparison]::OrdinalIgnoreCase) }).Count`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = parseInt((r.stdout ?? '').trim(), 10);
    return r.status === 0 && Number.isFinite(n) ? n > 0 : null;
  } catch { return null; }
}

/** A guide pack's toc that names the old addon as the one it needs (it was converted before): made to name the new one. null: not one of those. */
export function legacyToc(text) {
  if (!OLD_MARK.test(text)) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r?\n/).map((line) => {
    if (OLD_MARK.test(line)) return line.replace(/X-ForeverMapLink-Converted/i, `X-${NEW}-Converted`);
    const m = NEEDED.exec(line);
    return m ? m[1] + m[2].split(',').map((n) => (n.trim().toLowerCase() === OLD.toLowerCase() ? n.replace(n.trim(), NEW) : n)).join(',') : line;
  }).join(eol);
}

/**
 * Carry over what belongs to the old copy, and remove it (see the top of this file).
 * @param flavourDir  the game's own folder (.../_forever_)
 * @returns { saved (files of saved settings carried over), packs (guide packs made to name the new addon), removed (folders removed) }
 */
export function carryOver(flavourDir) {
  const addons = path.join(flavourDir, 'Interface', 'AddOns');
  const out = { saved: 0, packs: [], removed: 0 };
  // what it has saved: for the account, and for each character
  const copy = (dir) => {
    const from = path.join(dir, `${OLD}.lua`), to = path.join(dir, `${NEW}.lua`);
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    const text = fs.readFileSync(from, 'latin1').replace(/^(\s*)ForeverMapLink((?:Char)?DB\s*=)/gm, `$1${NEW}$2`);
    fs.writeFileSync(to, text, 'latin1');
    out.saved++;
  };
  const folders = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; } };
  for (const account of folders(path.join(flavourDir, 'WTF', 'Account'))) {
    copy(path.join(account, 'SavedVariables'));
    for (const realm of folders(account)) for (const character of folders(realm)) copy(path.join(character, 'SavedVariables'));
  }
  // guide packs that name the old addon
  for (const pack of folders(addons)) {
    const name = path.basename(pack);
    if (name === OLD || name === NEW || OLD_MAIL.test(name)) continue;
    let tocs = [];
    try { tocs = fs.readdirSync(pack).filter((f) => /\.toc$/i.test(f)); } catch { continue; }
    for (const f of tocs) {
      const file = path.join(pack, f);
      let text;
      try { text = fs.readFileSync(file, 'latin1'); } catch { continue; }
      const to = legacyToc(text);
      if (to !== null && to !== text) { fs.writeFileSync(file, to, 'latin1'); if (!out.packs.includes(name)) out.packs.push(name); }
    }
  }
  // the old addon and its mailboxes: the files it put there, and each folder if nothing else is left in it
  const clear = (dir, files) => {
    for (const f of files) { try { fs.rmSync(path.join(dir, f)); } catch { /* not there */ } }
    try { fs.rmdirSync(dir); out.removed++; } catch { /* something of yours is in it: left */ }
  };
  for (const dir of folders(addons)) {
    const name = path.basename(dir);
    if (OLD_MAIL.test(name)) clear(dir, [`${name}.toc`, 'mail.lua', 'mail.lua.new']);
  }
  if (legacyInstalled(addons)) clear(path.join(addons, OLD), OLD_FILES);
  return out;
}
