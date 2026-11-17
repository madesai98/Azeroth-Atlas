#!/usr/bin/env node
// The scheduled functions (functions/) - the one that reads the auction houses, and the one
// that takes each new version of QuestieDB into the database - put in the cloud and looked
// after. For whoever keeps the Atlas database: it needs a sign-in that owns the database's
// Firebase project (https://console.firebase.google.com), which must be on the pay-as-you-go
// plan (Firebase runs no functions without it).
//
// This is no part of what a copy of the map does: a copy only reads what the functions put into
// the database.
//
//   node tools/cloud.mjs login      sign in to Firebase (once; a browser window opens)
//   node tools/cloud.mjs key --id-file=<file> --secret-file=<file>
//                                   hand the function a Blizzard API client (made for free at
//                                   https://develop.battle.net): its two values, each from a file
//                                   holding nothing else, go into the project's Secret Manager.
//                                   Nothing of it is kept on this computer; delete the two files after
//   node tools/cloud.mjs deploy     put the functions in the cloud, or the newer version of them
//   node tools/cloud.mjs logs       what their last runs said (--only=auctions or --only=questie: one of them)
//   node tools/cloud.mjs rules      publish atlasdb/rules.json as the database's rules
//                                   (the same as pasting it into the console)
//
//   --account=you@example.com       which of your Firebase sign-ins to use (else the one in use)
//
// Firebase's own tool does the work (firebase-tools: fetched by npx the first time, not part of
// the map tool). The project is the one .firebaserc names.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const command = args.find((a) => !a.startsWith('--')) ?? 'help';
const account = value('account');

/** Firebase's tool, run in this folder. `input`: what it is to read in place of the keyboard. */
function firebase(words, { input } = {}) {
  const all = ['--yes', 'firebase-tools@15', ...words, ...(account ? ['--account', account] : [])];
  // (npx is a .cmd on Windows: it is run through the shell there, and nothing a person typed is in the line)
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', all, { cwd: ROOT, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input, shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (command === 'login') {
  process.exitCode = firebase(['login']);
} else if (command === 'key') {
  const idFile = value('id-file'), secretFile = value('secret-file');
  if (!idFile || !secretFile) { console.error('key --id-file=<file> --secret-file=<file>   (each file holding nothing but the value)'); process.exitCode = 2; }
  else {
    // (each value goes to Firebase's tool as what it reads, never as part of a command line, and is never shown)
    for (const [name, file] of [['BLIZZARD_CLIENT_ID', idFile], ['BLIZZARD_CLIENT_SECRET', secretFile]]) {
      const secret = fs.readFileSync(file, 'utf8').trim();
      if (!secret) { console.error(`${file} is empty`); process.exitCode = 2; break; }
      const code = firebase(['functions:secrets:set', name, '--data-file', '-', '--non-interactive', '--force'], { input: secret });
      if (code) { process.exitCode = code; break; }
    }
    if (!process.exitCode) console.log('The function has the API client. A function already in the cloud takes it up at its next deploy. Delete the two files now.');
  }
} else if (command === 'deploy') {
  if (!fs.existsSync(path.join(ROOT, 'functions', 'node_modules'))) {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, 'functions'), stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status) process.exit(r.status);
  }
  process.exitCode = firebase(['deploy', '--only', 'functions', '--force']);
} else if (command === 'logs') {
  const only = ['auctions', 'questie'].includes(value('only')) ? value('only') : 'auctions,questie';
  process.exitCode = firebase(['functions:log', '--only', only, '--lines', value('lines') ?? '40']);
} else if (command === 'rules') {
  process.exitCode = firebase(['deploy', '--only', 'database']);
} else {
  console.log('node tools/cloud.mjs login | key | deploy | logs | rules   (see the top of tools/cloud.mjs)');
  process.exitCode = command === 'help' ? 0 : 2;
}
