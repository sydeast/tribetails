// optional-pkg.js: is a package-lock.json entry allowed to be ABSENT from
// this machine's install without that being drift?
//
// npm's own lockfile carries every package a dependency graph could ever
// need, including optional platform-specific binaries (esbuild, rollup,
// @napi-rs/*, ...) for platforms other than the one `npm ci` ran on. npm
// itself skips installing those; it is not a partial or stale install, it is
// npm doing exactly what it always does. On a real checkout (macOS arm64)
// the root workspace lockfile carries dozens of such entries for linux,
// windows, and other CPU architectures, none of which are ever installed
// here. Counting every one of them as "not installed" drift would refuse a
// perfectly clean tree on every platform except whichever one the
// lockfile's author happened to run `npm install` on.
//
// Exported for both standalone-drift.js and workspace-drift.js so the two
// scripts cannot disagree about what "optional for this platform" means.
'use strict';

// platformListOk(list, value): npm's own semantics for an os/cpu/libc array
// on a lockfile entry (mirrored from the package's own package.json). A
// leading "!" negates ("not this one"); entries may mix positive and
// negative forms, though real package.json files use one style consistently.
//   - undefined/empty list: no restriction, anything matches.
//   - any positive entries present: `value` must be one of them.
//   - any negative entries present: `value` must not be one of them.
function platformListOk(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const positives = [];
  const negatives = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (item[0] === '!') negatives.push(item.slice(1));
    else positives.push(item);
  }
  if (positives.length && !positives.includes(value)) return false;
  if (negatives.length && negatives.includes(value)) return false;
  return true;
}

// isSkippableMissing(entry): true when a package-lock.json entry that is
// ABSENT from the installed tree is expected to be absent, so its absence is
// not drift. Only meaningful for "missing entirely"; an entry that IS
// installed but at the wrong version is drift regardless of any of this,
// optional or not.
function isSkippableMissing(entry) {
  if (!entry) return false;
  if (entry.optional === true) return true;
  // devOptional alone (no `optional`) means "optional within the dev
  // subtree", which does not by itself excuse a missing production install;
  // only the combination npm actually uses for cross-platform binaries
  // (both flags together) is treated the same as plain `optional`.
  if (entry.devOptional === true && entry.optional === true) return true;
  if (!platformListOk(entry.os, process.platform)) return true;
  if (!platformListOk(entry.cpu, process.arch)) return true;
  // libc (glibc vs musl) only ever qualifies a Linux entry, and always
  // alongside an os restriction that already resolves this off Linux. There
  // is no reliable libc detection here without a native check, so on Linux
  // itself this is left unresolved rather than guessed: guessing wrong in
  // either direction is worse than not checking it, and every real-world
  // libc-restricted entry this repo's lockfiles carry also carries an os
  // restriction that the check above already applies.
  return false;
}

module.exports = { platformListOk, isSkippableMissing };
