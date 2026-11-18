// Teaching a guide addon about floors.
//
// The addon follows the guide addon you run (addon/AzerothAtlas/GuideSources.lua: Guidelime,
// RestedXP). Each of those ticks a step off that is only "go to this spot" by itself, on the
// flat map: within so many yards of the spot, whatever floor you are on. One line of each can
// be made to ask the addon first - AzerothAtlas.Arrived, which says "not yet" until you are at
// the end of the route to the spot, on the level it ends on.
//
// That is a change to another addon's own file, so:
//   - it is one line, found by its exact words. A guide addon whose line reads otherwise - its
//     makers changed it - is left alone, and the page says so;
//   - the line stays one line: every line of the file keeps its number (an error the guide
//     addon reports names the line it always did);
//   - what is added asks AzerothAtlas only if that is there, and takes "nothing to say" for
//     an answer: with this addon switched off or removed, with the 3D map not running, the
//     guide addon decides exactly as it did. Nothing here relies on the line being changed:
//     not taught, the guide addon ticks such a step off on the flat map, as it always has;
//   - updating the guide addon puts its own file back. "Check for updates" teaches it again
//     (the page looks every half minute, and says when there is one to teach);
//   - it is yours to switch off: config.json "guidePatches": false (the box under the addon's
//     button on the page), which also puts every line back as its makers wrote it.
import fs from 'node:fs';
import path from 'node:path';

// (what a taught line ends with, so that whoever reads the file sees why it is as it is)
const WHY = ' -- Azeroth Atlas: not reached until you are at the end of the route to it, on its floor (asked only if that addon is running)';
const ASK = ' and not (AzerothAtlas and AzerothAtlas.Arrived and AzerothAtlas.Arrived(element) == false)';

// folder: the guide addon's folder among the game's addons; file: the one file; plain: the
// line as its makers wrote it (without the space it is indented by); taught: the line as changed.
export const GUIDE_ADDONS = [
  {
    key: 'guidelime', name: 'Guidelime', folder: 'Guidelime', file: 'CurrentGuide.lua',
    plain: 'element.completed = (D.wx - element.wx) * (D.wx - element.wx) + (D.wy - element.wy) * (D.wy - element.wy) <= radius',
    taught: `element.completed = (D.wx - element.wx) * (D.wx - element.wx) + (D.wy - element.wy) * (D.wy - element.wy) <= radius${ASK}${WHY}`,
  },
  {
    key: 'restedxp', name: 'RestedXP', folder: 'RXPGuides', file: 'map.lua',
    plain: 'if dist <= element.radius and objectiveCheck then',
    taught: `if dist <= element.radius and objectiveCheck${ASK} then${WHY}`,
  },
];

/** A file's lines, and how they end (read byte for byte: a Lua file may be in any encoding). */
function read(file) {
  const text = fs.readFileSync(file, 'latin1');
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}
const body = (line) => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
// Which lines of a file are the one looked for. A taught line is known by what it does, whatever
// is said after it: a line taught by an older version of this file, with other words, is one too.
const code = (taught) => taught.slice(0, taught.length - WHY.length);
const where = (lines, words, taught = false) => lines.reduce((at, l, i) => {
  const b = body(l);
  const is = taught ? b.startsWith(code(words)) && /^([ \t]*--.*)?$/.test(b.slice(code(words).length)) : b === words;
  return is ? [...at, i] : at;
}, []);

/** The version a guide addon's toc names (any of its tocs: they are all one version). */
function version(dir) {
  try {
    for (const f of fs.readdirSync(dir).filter((n) => /\.toc$/i.test(n))) {
      const m = /^##[ \t]*Version[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(fs.readFileSync(path.join(dir, f), 'latin1'));
      if (m) return m[1];
    }
  } catch { /* no toc to read */ }
  return null;
}

/**
 * One guide addon, as it is in the game's AddOns folder: { key, name, installed, version, state }.
 * state: 'absent' (not installed), 'plain' (as its makers wrote it: can be taught), 'taught',
 * 'changed' (its line is not there as expected - once, in either form: left alone).
 */
function look(addons, g) {
  const dir = path.join(addons, g.folder), file = path.join(dir, g.file);
  const out = { key: g.key, name: g.name, installed: false, version: null, state: 'absent' };
  if (!fs.existsSync(file)) return out;
  out.installed = true;
  out.version = version(dir);
  let f;
  try { f = read(file); } catch { out.state = 'changed'; return out; }
  const plain = where(f.lines, g.plain), taught = where(f.lines, g.taught, true);
  out.state = plain.length === 1 && !taught.length ? 'plain' : taught.length === 1 && !plain.length ? 'taught' : 'changed';
  return out;
}

/** Every guide addon the addon follows, as installed: [{ key, name, installed, version, state }]. */
export function guideAddons(addons) {
  return GUIDE_ADDONS.map((g) => look(addons, g));
}

/** Change the one line of a guide addon's file to its taught form (teach) or back. True if it was done. */
function turn(addons, g, teach) {
  const file = path.join(addons, g.folder, g.file);
  const f = read(file);
  const plain = where(f.lines, g.plain), taught = where(f.lines, g.taught, true);
  const at = teach ? plain : taught, to = teach ? g.taught : g.plain;
  if (at.length !== 1 || (teach ? taught : plain).length) return false;
  const line = f.lines[at[0]];
  // (the space the line is indented by, and whatever ends it, are the file's own)
  f.lines[at[0]] = /^[ \t]*/.exec(line)[0] + to;
  const text = f.lines.join(f.eol);
  fs.writeFileSync(file, text, 'latin1');
  if (fs.readFileSync(file, 'latin1') !== text) throw new Error(`${g.name}: ${g.file} does not read back as written`);
  return true;
}

/**
 * Teach every installed guide addon that can be taught (on: true), or put every taught one
 * back as its makers wrote it (on: false). Returns the names of those changed.
 */
export function teachGuides(addons, on) {
  const done = [];
  for (const g of GUIDE_ADDONS) {
    const state = look(addons, g).state;
    if (on && state === 'plain' && turn(addons, g, true)) done.push(g.name);
    if (!on && state === 'taught' && turn(addons, g, false)) done.push(g.name);
  }
  return done;
}
