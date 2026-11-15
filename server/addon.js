// Installs / updates the AzerothAtlas addon in the game's AddOns folder.
// Only ever writes its own folders: <game>/<flavour>/Interface/AddOns/AzerothAtlas and the
// route mailboxes beside it, AzerothAtlas_Mail001 ... (see mail.js). One thing more, and only
// when you ask for it ("Convert guide packs"): the line of a guide pack's toc that names the
// addon it needs (see "guide packs made for Guidelime" below).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, flavourFolder } from '../extractor/config.js';
import { MAIL_COUNT, mailName, mailFiles } from './mail.js';
import { OLD, legacyInstalled, gameRunning, carryOver } from './legacy.js';

const NAME = 'AzerothAtlas';
const BUNDLED = path.join(PROJECT_ROOT, 'addon', NAME);

export { flavourFolder };

/** The game's AddOns folder for the configured flavour (e.g. .../_forever_/Interface/AddOns). */
export function addonsDir(cfg) {
  const folder = flavourFolder(cfg);
  return folder ? path.join(cfg.installRoot, folder, 'Interface', 'AddOns') : null;
}

// ---- guide packs made for Guidelime -------------------------------------------------------------
// The addon follows guides written for Guidelime itself (addon/AzerothAtlas/GuideBook.lua). A
// guide pack names Guidelime in its toc as the addon it needs, and the game loads no addon whose
// needed addon is missing or switched off. Converting a pack changes that: it then needs Forever
// Map Link, and names Guidelime only as an addon to load after if it is there. So a converted
// pack loads with Guidelime switched off or removed (this addon runs its guides), and still
// hands its guides to Guidelime wherever Guidelime is switched on. Nothing else of a pack is
// touched. A pack you install or update again is as its maker wrote it, and is offered again.
const LIME = 'Guidelime';
const MARK = 'X-AzerothAtlas-Converted';
// (the game reads "Dependencies", "RequiredDeps" and any other word that starts so the same way)
const NEEDED = /^##[ \t]*((?:Required)?Dep\w*)[ \t]*:(.*)$/i;
const AFTER = /^##[ \t]*(OptionalDep\w*)[ \t]*:(.*)$/i;
const MARKED = new RegExp(`^##[ \\t]*${MARK}[ \\t]*:`, 'im');
const listed = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
const named = (name) => (n) => n.toLowerCase() === name.toLowerCase();

/** A guide pack's toc, changed to need this addon instead of Guidelime. null: it does not name Guidelime as needed. */
export function convertToc(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter((l) => !MARKED.test(l));
  const was = [];
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = NEEDED.exec(lines[i]);
    if (!m || !listed(m[2]).some(named(LIME))) continue;
    was.push(lines[i].replace(/^##[ \t]*/, '').trim());
    lines[i] = `## ${m[1]}: ${[NAME, ...listed(m[2]).filter((n) => !named(LIME)(n) && !named(NAME)(n))].join(', ')}`;
    at = i;
  }
  if (at < 0) return null;
  const add = [`## ${MARK}: by the 3D map. Before: ${was.join(' / ')}`];
  const opt = lines.findIndex((l) => AFTER.test(l));
  if (opt < 0) add.unshift(`## OptionalDeps: ${LIME}`);
  else {
    const m = AFTER.exec(lines[opt]);
    if (!listed(m[2]).some(named(LIME))) lines[opt] = `## ${m[1]}: ${[...listed(m[2]), LIME].join(', ')}`;
  }
  lines.splice(at + 1, 0, ...add);
  return lines.join(eol);
}

/** The installed addons made for Guidelime: { name, tocs: those still to convert, converted }. */
function guidePacks(dir) {
  const packs = [];
  let folders;
  try { folders = fs.readdirSync(dir, { withFileTypes: true }); } catch { return packs; }
  for (const d of folders) {
    if (!d.isDirectory() || d.name === NAME || d.name.startsWith(NAME + '_Mail') || d.name === OLD || d.name.startsWith(OLD + '_Mail')) continue;
    let files;
    try { files = fs.readdirSync(path.join(dir, d.name)).filter((f) => /\.toc$/i.test(f)); } catch { continue; }
    const tocs = [];
    let converted = false;
    for (const f of files) {
      const file = path.join(dir, d.name, f);
      let text;
      // (read and written byte for byte: a toc's title may be in any encoding)
      try { text = fs.readFileSync(file, 'latin1'); } catch { continue; }
      const to = convertToc(text);
      if (to !== null) tocs.push({ file, to });
      else if (MARKED.test(text)) converted = true;
    }
    if (tocs.length || converted) packs.push({ name: d.name, tocs, converted: !tocs.length });
  }
  return packs;
}

/** Guides: the packs still to convert, the ones converted, and whether Guidelime itself is installed. */
function guideStatus(dir) {
  const packs = guidePacks(dir);
  let guidelime = false;
  try { guidelime = fs.readdirSync(path.join(dir, LIME)).some((f) => /\.toc$/i.test(f)); } catch { /* not installed */ }
  return { needs: packs.filter((p) => !p.converted).map((p) => p.name), converted: packs.filter((p) => p.converted).map((p) => p.name), guidelime };
}

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
  return { available: true, installed, current, mail, legacy: legacyInstalled(dir), guides: guideStatus(dir), target, version: version(BUNDLED), installedVersion: installed ? version(target) : null };
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

/** "Convert guide packs": every installed pack that names Guidelime as needed is made to need this addon instead. */
export function convertGuides(cfg) {
  const st = addonStatus(cfg);
  if (!st.available) throw new Error(st.reason);
  // (a pack that needs an addon which is not installed would not load at all)
  if (!st.installed) throw new Error('install the addon first: a converted guide pack needs it');
  const done = [];
  for (const pack of guidePacks(addonsDir(cfg))) {
    if (pack.converted) continue;
    for (const toc of pack.tocs) fs.writeFileSync(toc.file, toc.to, 'latin1');
    done.push(pack.name);
  }
  return { ...addonStatus(cfg), done };
}
