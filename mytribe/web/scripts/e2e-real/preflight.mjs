/**
 * Preflight for the portal's real-services Cypress run (#1194, `npm run e2e:real`).
 *
 * THE RULES ARE THE ADMIN'S, IMPORTED, NOT COPIED. Both runs write the same
 * file (`mytribe/functions/.secret.local`) for the same functions build, so
 * there is one list of secrets and one set of refusals
 * (`auntieos-admin/scripts/e2e-real/preflight.mjs`, #1089): a Stripe value that
 * is not a test-mode key, a Twilio value naming a number in the business line's
 * or the private line's area code, and a spec that names Google Calendar
 * Disconnect. A second copy here would drift from the first, and the drift
 * would be in exactly the checks that keep a run off production.
 *
 * WHAT THIS FILE ADDS is the one thing the portal needs and the admin does not:
 * whether a Stripe webhook forwarder is running. Paying an invoice is settled
 * by `stripeWebhook`, not by `payInvoice`, so the pay spec can only pass when
 * `stripe listen` is forwarding to the emulator and its signing secret is in
 * the secrets file. `run.sh` starts the forwarder and exports
 * `STRIPE_TEST_WEBHOOK_SECRET` before this runs. The admin preflight treats
 * that variable as optional (`required: false`), so `stripe` alone can read
 * configured while no webhook will ever arrive; `stripeWebhook` is the flag
 * that says one will.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  declaredSecrets,
  disconnectRisks,
  MARKER,
  plan,
  render,
} from '../../../../auntieos-admin/scripts/e2e-real/preflight.mjs';

const WEBHOOK_SECRET = /^whsec_/;

/**
 * The admin plan, plus the portal's `stripeWebhook` availability flag.
 *
 * `stripeWebhook` is true only when Stripe itself is configured AND a real
 * `whsec_` signing secret was provided, because a forwarder without keys has
 * nothing to forward and a key without a forwarder delivers nothing.
 */
export function portalPlan(secretNames, env) {
  const base = plan(secretNames, env);
  const secret = env.STRIPE_TEST_WEBHOOK_SECRET ?? '';
  const available = {
    ...base.available,
    stripeWebhook: base.available.stripe === true && WEBHOOK_SECRET.test(secret),
  };
  return { ...base, available };
}

/** CLI: `node preflight.mjs <functionsDir> <realSpecDir> <availabilityJsonOut>` */
async function main() {
  const [functionsDir, specDir, availabilityOut] = process.argv.slice(2);
  if (!functionsDir || !specDir || !availabilityOut) {
    console.error('usage: preflight.mjs <functionsDir> <realSpecDir> <availabilityJsonOut>');
    process.exit(2);
  }
  const target = join(functionsDir, '.secret.local');
  if (existsSync(target) && !readFileSync(target, 'utf8').startsWith(MARKER)) {
    console.error(`REFUSED: ${target} exists and the e2e-real preflight did not write it. Move it aside; it is not overwritten.`);
    process.exit(1);
  }
  const refusals = disconnectRisks(specDir);
  const { values, refusals: valueRefusals, available } = portalPlan(declaredSecrets(functionsDir), process.env);
  refusals.push(...valueRefusals);
  if (refusals.length > 0) {
    console.error('REFUSED to start the portal real-services run:');
    for (const r of refusals) console.error(`  - ${r}`);
    process.exit(1);
  }
  writeFileSync(target, render(values), { mode: 0o600 });
  writeFileSync(availabilityOut, JSON.stringify(available));
  const named = Object.entries(available)
    .map(([vendor, ok]) => `${vendor}=${ok ? 'configured' : 'not configured, its specs skip'}`)
    .join(', ');
  console.log(`preflight: wrote ${Object.keys(values).length} secrets to ${target}; ${named}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
