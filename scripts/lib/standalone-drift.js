#!/usr/bin/env node
// Compares a STANDALONE package root (its own package.json + package-lock.json
// + node_modules -- mytribe/functions, auntieos-admin/web/functions) against
// what its lockfile pins. Invoked only by scripts/lib/dep-drift.sh; nothing
// else should call this directly.
//
// Usage: node standalone-drift.js <dir>
// stdout: comma-separated drifted packages (first 4, "+N more"), or nothing.
// stderr: populated only alongside exit 2.
// Exit codes:
//   0 - read fine (stdout says whether anything drifted)
//   2 - UNREADABLE: package.json, package-lock.json, or
//       node_modules/.package-lock.json exists but could not be read or
//       parsed. Distinct from "clean", because a caught-and-swallowed parse
//       error used to print nothing and look identical to no drift at all.
//
// A lockfile entry MISSING from the install is not automatically drift: see
// optional-pkg.js. npm never installs an optional package meant for another
// platform (esbuild/rollup/@napi-rs binaries and the like), so a real,
// freshly `npm ci`'d tree still shows dozens of such entries as "absent" on
// any one platform. Only a NON-optional package that is missing, or any
// package installed at the wrong version, is drift.
'use strict';
const fs = require('fs');
const path = require('path');
const { isSkippableMissing } = require('./optional-pkg');

const dir = process.argv[2];

function readJson(rel) {
  const p = path.join(dir, rel);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${rel}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${e.message}`);
  }
}

let pj, lock;
try {
  pj = readJson('package.json');
  lock = readJson('package-lock.json');
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
const declaredLocked = lock.packages || {};
const bad = [];

// Every direct dependency must at least resolve IN THE LOCKFILE. A name in
// package.json with no lockfile entry at all used to be silently skipped (the
// loop below only ever walked `want`, and an absent entry made it `continue`),
// which reported "clean" for a package.json/package-lock.json pair that
// disagree with each other.
for (const name of Object.keys(want)) {
  if (!declaredLocked['node_modules/' + name]) {
    bad.push(name + ' (declared, but not in package-lock.json)');
  }
}

// node_modules/.package-lock.json is npm's own record of exactly what it
// installed: every package, direct AND transitive. Diffing it against the
// lockfile catches a transitive-only bump (a Dependabot group upgrade that
// never touches package.json) that walking only direct dependencies cannot
// see. Fall back to the direct-dependency walk only when it is missing.
const markerPath = path.join(dir, 'node_modules', '.package-lock.json');
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
    if (key === '') continue; // the root package entry itself, not a dependency
    const name = key.replace(/^node_modules\//, '');
    const wantEntry = declaredLocked[key];
    const gotEntry = installedPkgs[key];
    if (wantEntry && wantEntry.version && !gotEntry) {
      // npm itself never installs an optional package meant for a different
      // platform (a Linux/Windows/other-arch binary in a lockfile built on
      // this machine's own platform); that is not drift, it is npm doing
      // exactly what it always does. See optional-pkg.js.
      if (!isSkippableMissing(wantEntry)) bad.push(name + ' (not installed)');
    } else if (!wantEntry && gotEntry) {
      bad.push(name + ' (installed, but lockfile no longer declares it)');
    } else if (wantEntry && gotEntry && wantEntry.version && gotEntry.version && wantEntry.version !== gotEntry.version) {
      bad.push(name + ' (' + gotEntry.version + ', lockfile says ' + wantEntry.version + ')');
    }
  }
} else {
  for (const name of Object.keys(want)) {
    const entry = declaredLocked['node_modules/' + name];
    if (!entry) continue; // already reported above
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (!fs.existsSync(p)) {
      if (!isSkippableMissing(entry)) bad.push(name + ' (absent)');
      continue;
    }
    if (!entry.version) continue;
    let got;
    try {
      got = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch {
      continue;
    }
    if (got !== entry.version) bad.push(name + ' (' + got + ', lockfile says ' + entry.version + ')');
  }
}

if (bad.length) {
  console.log(bad.slice(0, 4).join(', ') + (bad.length > 4 ? ', +' + (bad.length - 4) + ' more' : ''));
}
