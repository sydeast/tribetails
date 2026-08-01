#!/usr/bin/env node
/**
 * Print, one per line, every secret name the built mytribe functions DECLARE.
 *
 *   node scripts/declared-secrets.js                  every declared name
 *   node scripts/declared-secrets.js --by-function    FUNCTION<tab>SECRET pairs
 *   node scripts/declared-secrets.js --by-function GOOGLE_OAUTH   filtered
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
 * WHY --by-function EXISTS. The flat list answers "will the deploy validate",
 * which is what release.sh needs. It cannot answer the question an operator
 * arrives with, which is "I set the secret and the feature still fails, so
 * WHICH function was supposed to get it". A secret is mounted per function, so
 * the binding is a pair, and a name present in the flat list can still be
 * missing from the one function that reads it. That is not hypothetical: it is
 * exactly the failure the retired GOOGLE_CALENDAR_SETUP.md shipped, a secret
 * the operator set that no function ever declared or read.
 *
 * WHAT THIS CANNOT TELL YOU, and nothing static can: whether the secret has a
 * VALUE, and whether the DEPLOYED function carries this declaration. Both live
 * in the project, not in the artifact. These functions are gcfv2, which pins
 * the secret VERSION resolved at deploy time, so a `functions:secrets:set` after
 * the last deploy changes nothing until the next one. Compare against reality
 * with `gcloud secrets list` (release.sh step 1b does) and
 * `gcloud functions describe <name> --gen2 --region us-central1`.
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
// THE WALK ITSELF LIVES IN THE FUNCTIONS SOURCE, not here. `getIntegrationsHealth`
// answers the same question for the operator at runtime, and two copies of this
// loop would be two answers to one question — with the operator-facing copy the
// one nobody would notice had drifted. See src/lib/declaredSecrets.ts.
const walk = path.resolve(__dirname, '../mytribe/functions/lib/lib/declaredSecrets.js');

let mod;
let collectDeclaredSecrets;
let collectDeclaredSecretPairs;
try {
  mod = require(lib);
  ({ collectDeclaredSecrets, collectDeclaredSecretPairs } = require(walk));
} catch (err) {
  console.error(`could not load ${lib}: ${err.message}`);
  console.error('Run `npm run build:functions` first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const byFunction = args.includes('--by-function');
const filter = args.find((a) => !a.startsWith('--')) || '';

if (byFunction) {
  const rows = collectDeclaredSecretPairs(mod).filter(
    ([fn, key]) => filter === '' || key.includes(filter) || fn.includes(filter),
  );
  // Silence is a real answer here and a misleading one, so say it on stderr
  // rather than exiting 0 with an empty stdout that reads as "all clear".
  if (rows.length === 0) console.error(`no declared secrets match ${filter || '(anything)'}`);
  for (const [fn, key] of rows) console.log(`${fn}\t${key}`);
} else {
  for (const n of collectDeclaredSecrets(mod)) console.log(n);
}
