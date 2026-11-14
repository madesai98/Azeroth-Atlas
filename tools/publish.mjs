#!/usr/bin/env node
// Publishes the map tool to its GitHub repository for the first time.
//
//   node tools/publish.mjs https://github.com/<you>/<repository>
//
// The repository must exist already and be empty (github.com/new: no README, no licence, no
// .gitignore). This writes its address into package.json - a copy unpacked from a ZIP looks
// there for where to update from (server/appupdate.js) - commits that, names the repository
// as "origin" and pushes the main branch. git asks you to sign in to GitHub in the browser if
// it has not been before. Afterwards a new version is published with a plain commit and push.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.argv[2] ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(url);
if (!m) { console.error('Give the address of the repository:  node tools/publish.mjs https://github.com/<you>/<repository>'); process.exit(1); }
const git = (args, quiet = false) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) { console.error('git is not installed (https://git-scm.com).'); process.exit(1); }
  return r;
};
if (git(['rev-parse', '--git-dir'], true).status !== 0) { console.error('This folder is not a git repository yet: run  git init -b main  and commit first.'); process.exit(1); }
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const want = `github:${m[1]}/${m[2]}`;
if (pkg.repository !== want) {
  pkg.repository = want;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  if (git(['add', 'package.json']).status !== 0 || git(['commit', '-m', `Published at ${url}`]).status !== 0) process.exit(1);
}
const had = git(['remote', 'get-url', 'origin'], true);
if (had.status !== 0) git(['remote', 'add', 'origin', `${url}.git`]);
else if (had.stdout.trim().replace(/\.git$/, '') !== url) git(['remote', 'set-url', 'origin', `${url}.git`]);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], true).stdout.trim();
if (branch !== 'main') console.log(`(you are on the branch "${branch}": copies of the map tool follow "main")`);
const pushed = git(['push', '-u', 'origin', `${branch}:main`]);
if (pushed.status !== 0) { console.error('\nThe push did not go through (see above). Once that is sorted out, run this again.'); process.exit(1); }
console.log(`\nPublished. Send your friends this:  ${url}\n(Code > Download ZIP, unpack, double-click Start Map.bat. See "Get it and run it" in README.md.)`);
