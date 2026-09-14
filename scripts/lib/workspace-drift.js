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
// unchecked forever. Only a single trailing "*" SEGMENT is expanded -- this
// repo's own entries ("packages/*", "auntieos-admin", "mytribe/web") never
// need more -- and any pattern this cannot expand (a mid-path "*", "**", a
// partial-segment glob like "pkg-*", a "!" negation) is refused (exit 2)
// rather than silently mismatched: a wrong expansion that finds NOTHING
// looks identical to "no members declared", and would report a repo with a
// dozen dependency-drifted packages as perfectly clean.
//
// A lockfile entry MISSING from the install is likewise not automatically
// drift: see optional-pkg.js. npm never installs an optional package meant
// for another platform, so a real, freshly `npm ci`'d workspace still shows
// dozens of such entries as "absent" on any one platform.
'use strict';
const fs = require('fs');
const path = require('path');
const { isSkippableMissing } = require('./optional-pkg');

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
    if (typeof pat !== 'string' || pat.length === 0) {
      throw new Error(`workspaces entry is not a usable pattern: ${JSON.stringify(pat)}`);
    }
    if (pat.includes('!')) {
      throw new Error(`workspaces pattern "${pat}" uses "!" negation, which this check does not expand`);
    }
    const starCount = (pat.match(/\*/g) || []).length;
    if (starCount === 0) {
      dirs.push(pat);
      continue;
    }
    // The ONLY glob shape expanded: exactly one "*", and it is the WHOLE
    // final path segment ("packages/*", or bare "*"). Anything else --
    // "packages/*/nested", "pkg-*", "**" -- is refused rather than resolved
    // to the wrong (usually empty) set of directories.
    const segments = pat.split('/');
    const last = segments[segments.length - 1];
    if (starCount !== 1 || last !== '*') {
      throw new Error(`workspaces pattern "${pat}" is not a single trailing "*" segment, the only glob shape this check expands`);
    }
    const base = segments.slice(0, -1).join('/');
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(base ? path.join(base, e.name) : e.name);
    }
  }
  return dirs;
}

const patterns = Array.isArray(rootPj.workspaces)
  ? rootPj.workspaces
  : (rootPj.workspaces && rootPj.workspaces.packages) || [];
let memberDirs;
try {
  memberDirs = expandMembers(patterns);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// Each member's own package.json, read ONCE and reused below. A member is
// skipped ONLY when its package.json does not exist at all: a partial or
// synthetic tree (a test fixture) may declare a workspace pattern with
// nothing under it yet, and that is not drift. A package.json that DOES
// exist but cannot be parsed is a different problem entirely (a real member
// this check cannot trust) and must refuse the whole comparison (exit 2)
// rather than silently drop that member and everything it declares.
const members = [];
const memberNames = new Set();
for (const dir of memberDirs) {
  const pjPath = path.join(root, dir, 'package.json');
  if (!fs.existsSync(pjPath)) continue;
  let pj;
  try {
    pj = readJson(pjPath);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
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
      // npm never installs an optional package meant for a different
      // platform; a real, freshly `npm ci`'d workspace still carries dozens
      // of these entries in its lockfile. See optional-pkg.js.
      if (!isSkippableMissing(wantEntry)) bad.push(key + ' (not installed)');
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
        if (!isSkippableMissing(entry)) bad.push(dir + '/' + name + ' (absent)');
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
