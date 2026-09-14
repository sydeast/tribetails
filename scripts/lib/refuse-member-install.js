#!/usr/bin/env node
// refuse-member-install.js: shared preinstall guard for every npm workspace
// member that has no lockfile of its own (currently mytribe/web,
// auntieos-admin, packages/geo, packages/issue-recorder -- the same set
// scripts/lib/workspace-drift.js discovers from the root package.json's
// "workspaces" field, expanded the same way).
//
// WHY THIS EXISTS (#862): `npm ci` run INSIDE one of these members exits 0
// and silently installs a smaller tree than the root's -- on 2026-09-14 it
// dropped @tiptap/* and @vitejs/plugin-react from what mytribe/web could
// resolve, and pwaBuild.test.ts / Messages.test.tsx then failed with a
// missing-module error that looked like broken code, not a bad install. No
// script or doc told anyone to run npm inside a member, but nothing stopped
// it either, and "a test fails with Cannot find module" is exactly the
// moment someone (or an agent) reaches for `npm ci` in the app directory
// that owns the failing test.
//
// HOW THE GUARD WORKS. Add this to a member's package.json:
//   "preinstall": "node ../../scripts/lib/refuse-member-install.js"
// (relative depth varies: one "../" per path segment from the repo root to
// the member -- see auntieos-admin's own preinstall for the shallower form.)
//
// npm runs a workspace member's own lifecycle scripts with the process cwd
// set to that member's directory, whichever command triggered the install
// (root `npm ci`, `npm install -w <member>` from the root, CI, bootstrap.sh,
// or plain `npm ci` typed inside the member itself) -- verified against real
// npm (v11) for every case this guard needs to tell apart, see
// scripts/refuse-member-install.test.sh for the cases and their evidence.
// `INIT_CWD` is npm's own record of the
// directory npm was INVOKED FROM (documented under npm's lifecycle-script
// environment variables), which npm recomputes fresh for every npm process
// it starts, including one npm process started from inside another (a
// nested `npm ci` run by a script an outer `npm run` is executing) -- it is
// never inherited from an enclosing npm invocation's own INIT_CWD.
//
// So: this process's cwd (the member directory, set by npm) equals INIT_CWD
// only when npm was invoked while sitting inside that exact member
// directory. Any install begun elsewhere -- the repo root, a `-w` filter run
// from the root, CI's `working-directory: .` override on every workspace
// job's install step, or bootstrap.sh (which always `cd`s to the repo root
// first) -- invokes npm from a different directory, so INIT_CWD differs and
// this guard stays silent.
'use strict';
const fs = require('fs');

const memberDir = process.cwd();
const initCwd = process.env.INIT_CWD;

// No INIT_CWD at all means this ran outside a real npm lifecycle (someone
// invoked the file directly with `node`, or an npm old enough not to set it
// -- INIT_CWD has shipped since npm 5). Nothing to compare against, so this
// guard has no basis to refuse.
if (!initCwd) {
  process.exit(0);
}

let memberReal, initReal;
try {
  memberReal = fs.realpathSync(memberDir);
  initReal = fs.realpathSync(initCwd);
} catch {
  // Either path failed to resolve (a stale INIT_CWD, an already-removed
  // directory). Refusing on unverifiable input would be worse than letting
  // npm proceed -- this guard exists to catch a specific, common mistake,
  // not to second-guess every install.
  process.exit(0);
}

if (memberReal === initReal) {
  const name = (() => {
    try {
      return JSON.parse(fs.readFileSync('package.json', 'utf8')).name;
    } catch {
      return memberDir;
    }
  })();
  console.error('');
  console.error(`  refused: npm was run inside ${name} (${memberDir}).`);
  console.error('  This workspace member has no lockfile of its own -- run `npm ci` at the repo root instead.');
  console.error('');
  process.exit(1);
}

process.exit(0);
