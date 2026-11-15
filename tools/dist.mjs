#!/usr/bin/env node
// Builds the application to hand on (npm run dist), as two files in dist/:
//   Azeroth-Atlas-Setup.exe      one file to download and run: it installs the application for
//                                the person who runs it (no administrator rights, no questions),
//                                with a Start menu and a desktop shortcut and an uninstaller
//   Azeroth-Atlas-win-x64.zip    the same application as a folder, for whoever would rather
//                                unpack it than install it
// Either way there is nothing else to install.
//
// In that folder, resources/app is this repository's files as they are, plain: the map tool
// keeps them up to date by itself from then on (server/appupdate.js). So a build is only
// needed again when the frame itself should be newer (Electron), not for each new version.
// Run by .github/workflows/release.yml when a tag v* is pushed, which also publishes the zip.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { build, Platform, Arch } from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'dist');
const NAME = 'Azeroth Atlas';
fs.rmSync(out, { recursive: true, force: true });
// (what is this computer's own, or built here, is no part of it: the same list as .gitignore)
const ignore = [/^\/config\.json$/, /^\/data($|\/)/, /^\/dist($|\/)/, /^\/server\/\.build($|\/)/, /^\/extractor\/dbd($|\/)/, /^\/\.app-version\.json$/, /^\/\.git($|\/)/, /\.lnk$/, /\.log$/];
const [built] = await packager({
  dir: root, name: NAME, platform: 'win32', arch: 'x64', out, overwrite: true, asar: false, prune: true, ignore,
  icon: path.join(root, 'app', 'icon.ico'), appVersion: pkg.version,
  win32metadata: { ProductName: NAME, FileDescription: NAME, CompanyName: NAME },
});
const folder = path.join(out, NAME);
fs.renameSync(built, folder);
const appDir = path.join(folder, 'resources', 'app');
fs.rmSync(path.join(appDir, 'node_modules'), { recursive: true, force: true }); // (nothing the application needs is in there)
// (the packager writes a shortened package.json of its own and leaves the lock file out: put in as they are in
// the repository, so that the application holds the repository's files exactly - its own updater goes by that)
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(appDir, f));
// (the frame's own words in every language: only English is kept - the window has no menus, and the map's words are its own)
for (const f of fs.readdirSync(path.join(folder, 'locales'))) if (f !== 'en-US.pak') fs.rmSync(path.join(folder, 'locales', f));
// Which version this is, for the copy's own updater: the commit it was built from and the files of it
// (only where that is known for sure: built from a clean checkout).
const git = (...a) => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const sha = git('rev-parse', 'HEAD'), dirty = git('status', '--porcelain');
if (sha && dirty === '') {
  fs.writeFileSync(path.join(appDir, '.app-version.json'), JSON.stringify({ sha, at: new Date().toISOString(), from: 'the build', files: git('ls-files').split('\n').sort() }, null, 1));
  console.log(`built from ${sha.slice(0, 7)}`);
} else console.log('built from a folder with changes of its own: the copy finds out which version it is at its first look');
// one zip, with the folder in it
const zip = path.join(out, 'Azeroth-Atlas-win-x64.zip');
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const z = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', out, NAME], { stdio: 'inherit' });
if (z.status !== 0) { console.error('The zip could not be made.'); process.exit(1); }
console.log(`${zip}  (${Math.round(fs.statSync(zip).size / 1e6)} MB)`);

// the installer: the same folder, in one file that puts it in place
// (For the person who runs it only: under %LOCALAPPDATA%\Programs, where the map tool can go
// on keeping its own files up to date. What is theirs - settings, map data - is elsewhere and
// is left alone by installing over an older copy and by uninstalling: see app/main.cjs.)
const icon = path.join(root, 'app', 'icon.ico');
await build({
  prepackaged: folder,
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'AzerothAtlas', // (the name Windows knows the application by: the same as in app/main.cjs)
    productName: NAME,
    directories: { output: out, buildResources: path.join(root, 'app') },
    publish: null,
    win: { icon, signAndEditExecutable: false }, // (the program has its icon and its name already: the packager above gave them)
    nsis: {
      oneClick: true, perMachine: false, artifactName: 'Azeroth-Atlas-Setup.${ext}', shortcutName: NAME, uninstallDisplayName: NAME,
      createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true, deleteAppDataOnUninstall: false,
      installerIcon: icon, uninstallerIcon: icon,
    },
  },
});
for (const f of fs.readdirSync(out)) if (/\.blockmap$|^builder-.*\.ya?ml$/.test(f)) fs.rmSync(path.join(out, f)); // (the builder's own notes: no part of what is handed on)
const setup = path.join(out, 'Azeroth-Atlas-Setup.exe');
console.log(`${setup}  (${Math.round(fs.statSync(setup).size / 1e6)} MB)`);
