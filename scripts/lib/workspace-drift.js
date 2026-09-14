#!/usr/bin/env node
// Compares an npm-workspaces install against the root lockfile. One shared
// root package.json/package-lock.json/node_modules covers every member (this
// repo's members are currently mytribe/web, auntieos-admin, packages/geo, and
// packages/issue-recorder). Invoked only by scripts/lib/dep-drift.sh; nothing
// else should call this directly.
//
// Usage: node workspace-drift.js <root>
// stdout / stderr / exit codes: same contract as standalone-drift.js.
//
// MEMBERS ARE READ FROM THE ROOT package.json's "workspaces" FIELD, expanded,
// never hardcoded. A hardcoded list is exactly how a new member added later
// (packages/issue-recorder, added after this check first shipped) goes
// unchecked forever. Only a single trailing "*" is expanded -- this repo's
// own entries ("packages/*", "auntieos-admin", "mytribe/web") never need more.
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.argv[2];

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${p} is not valid JSON: ${e.message}`);
  }
}

let rootPj, lock;
try {
  rootPj = readJson(path.join(root, 'package.json'));
  lock = readJson(path.join(root, 'package-lock.json'));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

function expandMembers(patterns) {
  const dirs = [];
  for (const pat of patterns || []) {
    const star = pat.indexOf('*');
    if (star === -1) {
      dirs.push(pat);
      continue;
    }
    const base = pat.slice(0, star).replace(/\/$/, '');
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(path.join(base, e.name));
    }
  }
  return dirs;
}

const patterns = Array.isArray(rootPj.workspaces)
  ? rootPj.workspaces
  : (rootPj.workspaces && rootPj.workspaces.packages) || [];
const memberDirs = expandMembers(patterns);

// Each member's own package.json, read ONCE and reused below. A member whose
// package.json cannot be read is skipped rather than failing the whole
// check: a partial or synthetic tree (a test fixture) may declare a
// workspace pattern with nothing under it yet, and that is not drift.
const members = [];
const memberNames = new Set();
for (const dir of memberDirs) {
  let pj;
  try {
    pj = readJson(path.join(root, dir, 'package.json'));
  } catch {
    continue;
  }
  members.push({ dir, pj });
  if (pj.name) memberNames.add(pj.name);
}

const declaredLocked = lock.packages || {};
const bad = [];

// Every member's OWN declared dependency must at least resolve in the root
// lockfile. A workspace member depending on ANOTHER member (e.g.
// "@tribetails/geo") is a workspace symlink, not a versioned install, so it
// has no lockfile "version" to check.
for (const { dir, pj } of members) {
  const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
  for (const name of Object.keys(want)) {
    if (memberNames.has(name)) continue;
    const entry = declaredLocked[dir + '/node_modules/' + name] || declaredLocked['node_modules/' + name];
    if (!entry) bad.push(dir + '/' + name + ' (declared, but not in package-lock.json)');
  }
}

// node_modules/.package-lock.json is npm's own record of exactly what got
// installed across the WHOLE workspace, direct and transitive. Diffing it
// against the root lockfile catches a transitive-only bump (a Dependabot
// group upgrade that never touches any member's package.json) that walking
// only direct dependencies cannot see. Fall back to the direct-dependency
// walk only when it is missing.
const markerPath = path.join(root, 'node_modules', '.package-lock.json');
if (fs.existsSync(markerPath)) {
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    console.error(`node_modules/.package-lock.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const installedPkgs = installed.packages || {};
  const keys = new Set([...Object.keys(declaredLocked), ...Object.keys(installedPkgs)]);
  for (const key of keys) {
    if (key === '') continue;
    const name = key.replace(/^.*node_modules\//, '');
    if (memberNames.has(name)) continue;
    const wantEntry = declaredLocked[key];
    const gotEntry = installedPkgs[key];
    if (wantEntry && wantEntry.version && !gotEntry) {
      bad.push(key + ' (not installed)');
    } else if (!wantEntry && gotEntry) {
      bad.push(key + ' (installed, but lockfile no longer declares it)');
    } else if (wantEntry && gotEntry && wantEntry.version && gotEntry.version && wantEntry.version !== gotEntry.version) {
      bad.push(key + ' (' + gotEntry.version + ', lockfile says ' + wantEntry.version + ')');
    }
  }
} else {
  for (const { dir, pj } of members) {
    const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    for (const name of Object.keys(want)) {
      if (memberNames.has(name)) continue;
      const entry = declaredLocked[dir + '/node_modules/' + name] || declaredLocked['node_modules/' + name];
      if (!entry) continue; // already reported above
      let found = path.join(root, dir, 'node_modules', name, 'package.json');
      if (!fs.existsSync(found)) found = path.join(root, 'node_modules', name, 'package.json');
      if (!fs.existsSync(found)) {
        bad.push(dir + '/' + name + ' (absent)');
        continue;
      }
      if (!entry.version) continue;
      let got;
      try {
        got = JSON.parse(fs.readFileSync(found, 'utf8')).version;
      } catch {
        continue;
      }
      if (got !== entry.version) bad.push(dir + '/' + name + ' (' + got + ', lockfile says ' + entry.version + ')');
    }
  }
}

if (bad.length) {
  console.log(bad.slice(0, 4).join(', ') + (bad.length > 4 ? ', +' + (bad.length - 4) + ' more' : ''));
}
