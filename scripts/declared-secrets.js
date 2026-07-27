#!/usr/bin/env node
/**
 * Print, one per line, every secret name the built mytribe functions DECLARE.
 *
 * WHY THIS READS __endpoint AND NOT THE SOURCE
 * Firebase validates declared secrets before it uploads anything, and a secret
 * that is declared but never set fails the ENTIRE codebase deploy, not just the
 * function declaring it. On 2026-07-26 that stopped a release five minutes in:
 * the Google Calendar work had landed code declaring GOOGLE_OAUTH_CLIENT_ID and
 * GOOGLE_OAUTH_CLIENT_SECRET while nobody had created them.
 *
 * Grepping `secrets: [...]` out of the TypeScript would be guesswork: the
 * arrays are built from spreads of shared constants (GOOGLE_OAUTH_SECRETS), so
 * a regex either misses them or over-matches and refuses a release wrongly.
 * The built output carries `__endpoint.secretEnvironmentVariables`, which is
 * the SAME structure the Firebase CLI itself reads. Asking the artifact rather
 * than the source means this check agrees with the validator by construction.
 *
 * Requires `npm run build:functions` to have run (release.sh does this in
 * step 1, before calling here).
 */

const path = require('path');

// v1 providers (the auth trigger) throw from their own __endpoint getter when
// GCLOUD_PROJECT is unset, which is how this script first failed. Deploys set
// it; a local analysis run has to set it too. The value only has to exist for
// the getters to build a resource name — nothing here talks to the project.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'auntieos-ttpc';
process.env.FIREBASE_CONFIG =
  process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });

const lib = path.resolve(__dirname, '../mytribe/functions/lib/index.js');

let mod;
try {
  mod = require(lib);
} catch (err) {
  console.error(`could not load ${lib}: ${err.message}`);
  console.error('Run `npm run build:functions` first.');
  process.exit(1);
}

const names = new Set();
for (const value of Object.values(mod)) {
  // Each __endpoint is a getter that can throw (v1 providers build a resource
  // name from the environment). One throwing export must not blind the check to
  // the other two hundred, so failures are skipped rather than fatal — this
  // runs to reduce the chance of a failed deploy, and refusing to report
  // anything because one export is awkward would defeat that.
  let ep;
  try {
    ep = value && value.__endpoint;
  } catch {
    continue;
  }
  if (!ep || !Array.isArray(ep.secretEnvironmentVariables)) continue;
  for (const s of ep.secretEnvironmentVariables) {
    if (s && s.key) names.add(s.key);
  }
}

for (const n of [...names].sort()) console.log(n);
