// Installs / updates the AzerothAtlas addon in the game's AddOns folder.
// Only ever writes its own folders: <game>/<flavour>/Interface/AddOns/AzerothAtlas and the
// route mailboxes beside it, AzerothAtlas_Mail001 ... (see mail.js). One thing more, unless you
// switch it off: one line of each guide addon the addon follows (see guidepatch.js).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, flavourFolder } from '../extractor/config.js';
import { MAIL_COUNT, mailName, mailFiles } from './mail.js';
import { legacyInstalled, gameRunning, carryOver } from './legacy.js';
import { guideAddons, teachGuides } from './guidepatch.js';

const NAME = 'AzerothAtlas';
const BUNDLED = path.join(PROJECT_ROOT, 'addon', NAME);

export { flavourFolder };

/** The game's AddOns folder for the configured flavour (e.g. .../_forever_/Interface/AddOns). */
export function addonsDir(cfg) {
  const folder = flavourFolder(cfg);
  return folder ? path.join(cfg.installRoot, folder, 'Interface', 'AddOns') : null;
}

// ---- the guide addons the addon follows -----------------------------------------------------------
// (Until version 0.4.1 the addon ran guides written for Guidelime in a window of its own, and
// this file changed the line of a guide pack's toc that names the addon it needs. It follows
// the guide addon you run now, and a pack is as its maker wrote it.)
/** Guides: whether guide addons are taught about floors (guidepatch.js), and each as it is installed. */
function guideStatus(dir, cfg) {
  return { teach: cfg.guidePatches !== false, addons: guideAddons(dir) };
}
// Files the addon had and no longer has: left behind they are never loaded, and never looked at.
const GONE = ['GuideBook.lua', 'GuideSteps.lua', 'GuideWindow.lua'];

const tocLine = (dir, key) => {
  try { return new RegExp(`^## ${key}:\\s*(.+)$`, 'm').exec(fs.readFileSync(path.join(dir, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? null; } catch { return null; }
};
const version = (dir) => tocLine(dir, 'Version');
const same = (file, text) => { try { return fs.readFileSync(file, 'utf8') === text; } catch { return false; } };

/** Are the route mailboxes there, and written for this version of the game? (the first and the last are looked at) */
function mailCurrent(dir) {
  const iface = tocLine(BUNDLED, 'Interface') ?? '0';
  return [1, MAIL_COUNT].every((i) => {
    const toc = `${mailName(i)}.toc`;
    return same(path.join(dir, mailName(i), toc), mailFiles(i, iface)[toc]) && fs.existsSync(path.join(dir, mailName(i), 'mail.lua'));
  });
}

export function addonStatus(cfg) {
  const dir = addonsDir(cfg);
  if (!dir) return { available: false, installed: false, current: false, reason: 'game AddOns folder not found' };
  const target = path.join(dir, NAME);
  const files = fs.readdirSync(BUNDLED);
  const installed = fs.existsSync(path.join(target, `${NAME}.toc`));
  const mail = installed && mailCurrent(dir);
  const current = installed && mail && files.every((f) => {
    try { return fs.readFileSync(path.join(target, f)).equals(fs.readFileSync(path.join(BUNDLED, f))); } catch { return false; }
  });
  // (legacy: a copy from before the addon's new name is installed - see legacy.js)
  return { available: true, installed, current, mail, legacy: legacyInstalled(dir), guides: guideStatus(dir, cfg), target, version: version(BUNDLED), installedVersion: installed ? version(target) : null };
}

/** @param opts  gameSeen: the map can see the game's window just now (where whether the game runs cannot be asked of Windows) */
export function installAddon(cfg, opts = {}) {
  const st = addonStatus(cfg);
  if (!st.available) throw new Error(st.reason);
  // A copy under the addon's old name: what belongs to it is carried over to the new one, and
  // it is removed. Only while the game is closed (legacy.js says why).
  let carried = null;
  if (st.legacy) {
    const flavour = path.join(cfg.installRoot, flavourFolder(cfg));
    if (gameRunning(flavour) ?? !!opts.gameSeen) throw new Error('close the game first, then press this again. The addon has a new name, Azeroth Atlas: your settings and your place in your guides are carried over to it, and that can only be done while the game is closed');
    carried = carryOver(flavour);
  }
  fs.mkdirSync(st.target, { recursive: true });
  // (a file the installed addon did not have before: the game only finds new files when it starts, not on /reload)
  const added = st.installed && fs.readdirSync(BUNDLED).some((f) => !fs.existsSync(path.join(st.target, f)));
  for (const f of fs.readdirSync(BUNDLED)) fs.copyFileSync(path.join(BUNDLED, f), path.join(st.target, f));
  for (const f of GONE) fs.rmSync(path.join(st.target, f), { force: true });
  // The route mailboxes. A mailbox's own file is left alone once it is there: the server keeps
  // writing it while you play.
  const dir = addonsDir(cfg), iface = tocLine(BUNDLED, 'Interface') ?? '0';
  // (the game only notices new addon folders when it starts)
  const fresh = !fs.existsSync(path.join(dir, mailName(MAIL_COUNT)));
  for (let i = 1; i <= MAIL_COUNT; i++) {
    const folder = path.join(dir, mailName(i));
    fs.mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(mailFiles(i, iface))) {
      const file = path.join(folder, name);
      if (name === 'mail.lua' ? !fs.existsSync(file) : !same(file, text)) fs.writeFileSync(file, text);
    }
  }
  return { ...addonStatus(cfg), restart: fresh || added, carried };
}

/**
 * The guide addons the addon follows, each taught about floors - or, where that is switched
 * off (config.json "guidePatches": false), put back as its makers wrote it. One line of each:
 * guidepatch.js. Returns the addon's status, with the names of those that were changed.
 */
export function teachGuideAddons(cfg) {
  const st = addonStatus(cfg);
  if (!st.available) throw new Error(st.reason);
  const on = cfg.guidePatches !== false;
  // (a guide addon that asks an addon which is not installed gets no answer, and decides as it did: nothing to gain yet)
  const done = on && !st.installed ? [] : teachGuides(addonsDir(cfg), on);
  return { ...addonStatus(cfg), done, taught: on };
}
