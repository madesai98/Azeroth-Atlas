#!/usr/bin/env node
// Runs Azeroth Atlas as an application straight from this folder (npm run app): the same
// window the installed application has, with everything where it is when run from the source.
//
//   node tools/app.mjs [--config=path/to/config.json]
//
// The first time, the program the window is made with (Electron) is fetched: about 110 MB,
// into node_modules. "npm install" comes first if that has never been run here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron');
if (!fs.existsSync(path.join(electron, 'package.json'))) { console.error('Run "npm install" in this folder first.'); process.exit(1); }
const exe = path.join(electron, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(exe)) {
  console.log('Fetching the program the window is made with (once)...');
  const r = spawnSync(process.execPath, [path.join(electron, 'install.js')], { cwd: electron, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(exe)) { console.error('That did not work (see above).'); process.exit(1); }
}
// (on its own from here: this command returns, the window stays)
spawn(exe, [root, ...process.argv.slice(2)], { cwd: root, detached: true, stdio: 'ignore' }).unref();
