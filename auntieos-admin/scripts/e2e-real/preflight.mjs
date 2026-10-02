/**
 * Preflight for the real-services Cypress run (#1089, `npm run e2e:real`).
 *
 * WHAT IT DOES. Writes `mytribe/functions/.secret.local` from environment
 * variables before the functions emulator boots, and refuses to write it, so the
 * run never starts, when a value could reach something real that it must not.
 *
 * WHY THE FILE HAS TO EXIST AND BE COMPLETE. The functions emulator resolves a
 * function's secrets from `.secret.local` first. Any key missing from that file,
 * or present but EMPTY, it fetches from Secret Manager under the emulator's
 * project id (firebase-tools 15.18.0, `resolveSecretEnvs` in
 * `lib/emulator/functionsEmulator.js`). On a machine with Application Default
 * Credentials and the production project id, that is a production secret handed
 * to a test. Two locks, either one sufficient:
 *   1. The run uses a `demo-` project id (see `run.sh`), which names no real
 *      project, so a lookup has nothing to find.
 *   2. This file writes EVERY secret any deployed function declares, with a
 *      non-empty value, so the emulator never asks Secret Manager at all.
 * The list is read from the BUILT functions (`lib/index.js`), from the same
 * `__endpoint.secretEnvironmentVariables` the emulator itself reads, rather
 * than by grepping source, so a secret added in a multi-line `secrets: [...]`
 * array or through a spread constant cannot be missed.
 *
 * THE REFUSALS (operator rulings D3-a, D3-b, D3-d, 2026-10-01):
 *   - a Stripe value that is not a test-mode key (`sk_test_`, `rk_test_`,
 *     `pk_test_`, and `whsec_` for the webhook secret);
 *   - a phone number in any Twilio value whose area code is the business line's
 *     or the operator's private line's. Compared by AREA CODE PATTERN, so no real
 *     number is written down here;
 *   - a real-suite spec that names the Google Calendar Disconnect callable or
 *     button. Disconnect revokes the grant at Google, and the test calendar
 *     shares the account and the OAuth client with production, so one press
 *     would cut the production connection.
 *
 * A SECRET NOT PROVIDED IS NOT A FAILURE. It gets a placeholder that cannot
 * authenticate anywhere, and the vendor's specs skip with a named reason
 * (`vendorsAvailable()` below feeds that). Absent is a skip, never a pass and
 * never a red run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** First line of every file this script writes. Its absence means a human wrote the file. */
export const MARKER = '# written by auntieos-admin/scripts/e2e-real/preflight.mjs (#1089). Deleted at the end of the run.';

/**
 * Where each functions secret's value comes from, by vendor.
 *
 * `env` is the variable the run reads (the name it has in the GitHub
 * environment `e2e-real`). `placeholder` is what goes in the file when the
 * variable is unset: shaped like the real thing where a guard below checks the
 * shape, and unable to authenticate anywhere.
 */
export const VENDOR_SECRETS = {
  stripe: [
    { secret: 'STRIPE_SECRET_KEY', env: 'STRIPE_TEST_SECRET_KEY', placeholder: 'sk_test_e2e_not_configured' },
    { secret: 'STRIPE_PUBLISHABLE_KEY', env: 'STRIPE_TEST_PUBLISHABLE_KEY', placeholder: 'pk_test_e2e_not_configured' },
    // Comes from `stripe listen` per run (D3-b), so it is not one of the stored
    // keys and does not decide whether the Stripe specs run.
    { secret: 'STRIPE_WEBHOOK_SECRET', env: 'STRIPE_TEST_WEBHOOK_SECRET', placeholder: 'whsec_e2e_not_configured', required: false },
  ],
  twilio: [
    { secret: 'TWILIO_ACCOUNT_SID', env: 'TWILIO_TEST_ACCOUNT_SID', placeholder: 'AC_e2e_not_configured' },
    { secret: 'TWILIO_AUTH_TOKEN', env: 'TWILIO_TEST_AUTH_TOKEN', placeholder: 'e2e-not-configured' },
    // Twilio's documented test-credential sender ("magic" number): it only
    // works with test credentials and belongs to no one.
    { secret: 'TWILIO_FROM_NUMBER', env: 'TWILIO_TEST_FROM_NUMBER', placeholder: '+15005550006' },
  ],
  email: [
    { secret: 'SMTP2GO_API_KEY', env: 'E2E_SMTP2GO_API_KEY', placeholder: 'e2e-not-configured' },
    { secret: 'EMAIL_FROM', env: 'E2E_EMAIL_FROM', placeholder: 'e2e-not-configured' },
  ],
  cloudinary: [
    { secret: 'CLOUDINARY_CLOUD_NAME', env: 'E2E_CLOUDINARY_CLOUD_NAME', placeholder: 'e2e-not-configured' },
    { secret: 'CLOUDINARY_API_KEY', env: 'E2E_CLOUDINARY_API_KEY', placeholder: 'e2e-not-configured' },
    { secret: 'CLOUDINARY_API_SECRET', env: 'E2E_CLOUDINARY_API_SECRET', placeholder: 'e2e-not-configured' },
  ],
  googleCalendar: [
    { secret: 'GOOGLE_OAUTH_CLIENT_ID', env: 'E2E_GOOGLE_OAUTH_CLIENT_ID', placeholder: 'e2e-not-configured' },
    { secret: 'GOOGLE_OAUTH_CLIENT_SECRET', env: 'E2E_GOOGLE_OAUTH_CLIENT_SECRET', placeholder: 'e2e-not-configured' },
  ],
};

/**
 * Variables a vendor needs that are NOT functions secrets, so they never go in
 * `.secret.local` but still decide whether that vendor's specs run.
 */
export const VENDOR_EXTRA_ENV = {
  googleCalendar: ['E2E_GOOGLE_CALENDAR_REFRESH_TOKEN', 'E2E_GOOGLE_CALENDAR_ID'],
};

/**
 * Fixed values for secrets no vendor spec exercises. Each is chosen so it cannot
 * leave the machine or authenticate anywhere.
 */
export const FIXED_SECRETS = {
  // A well-formed DSN pointing at a closed loopback port: Sentry initialises
  // and any event it sends is refused locally.
  SENTRY_DSN: 'http://e2e@127.0.0.1:9/0',
  // `admin: true` is what admits the fixture admin (lib/staffGate.ts); this
  // allowlist is a transition fallback and must name nobody real.
  AUNTIE_OPERATOR_UIDS: 'e2e-no-operator-uid',
};

/** Placeholder for any other declared secret. */
export const DEFAULT_PLACEHOLDER = 'e2e-not-configured';

const STRIPE_PREFIXES = /^(sk_test_|rk_test_|pk_test_|whsec_)/;

/**
 * True when [value] carries a North American number in one of the two area
 * codes the suite must never use: the business line's and the operator's
 * private line's (memory: personal-number-989). Matched on the AREA CODE of
 * any 10- or 11-digit run, with or without punctuation, so neither number is
 * spelled out in this repo.
 */
export function isForbiddenNumber(value) {
  const runs = String(value).match(/\+?[\d\s().-]{10,}/g) ?? [];
  return runs.some((run) => {
    const digits = run.replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    return national.length === 10 && /^(805|989)/.test(national);
  });
}

/** Every `.ts` file under [dir], recursively. */
function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Real-suite spec files that could press Google Calendar Disconnect. Returns
 * `file: reason` lines; empty means clean. Scans the specs only: the support
 * file names the callable in order to BLOCK it.
 */
export function disconnectRisks(specDir) {
  const out = [];
  for (const file of tsFiles(specDir)) {
    const src = readFileSync(file, 'utf8');
    if (/disconnectGoogleCalendar/.test(src)) out.push(`${file}: names the disconnectGoogleCalendar callable`);
    if (/\bDisconnect\b/.test(src)) out.push(`${file}: names the Disconnect control`);
  }
  return out;
}

/**
 * The secret names every function in the built codebase declares, read from
 * the same endpoint metadata the emulator reads. Runs in a child process so the
 * functions' module-scope code cannot touch this one.
 */
export function declaredSecrets(functionsDir) {
  const entry = resolve(functionsDir, 'lib', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist. Build the functions first (npm --prefix mytribe/functions run build).`);
  }
  const script = `
    const m = require(${JSON.stringify(entry)});
    const names = new Set();
    for (const v of Object.values(m)) {
      const e = v && v.__endpoint;
      for (const s of (e && e.secretEnvironmentVariables) || []) names.add(s.key);
    }
    process.stdout.write(JSON.stringify([...names].sort()));
  `;
  const raw = execFileSync(process.execPath, ['-e', script], {
    cwd: functionsDir,
    encoding: 'utf8',
    // GCLOUD_PROJECT keeps firebase-admin's module-scope init from looking for
    // a real project; FUNCTIONS_CONTROL_API is what the emulator sets for the
    // same discovery load.
    env: { ...process.env, GCLOUD_PROJECT: 'demo-auntieos-e2e', FUNCTIONS_CONTROL_API: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const names = JSON.parse(raw.trim().split('\n').pop() ?? '[]');
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`no secret declarations found in ${entry}; refusing to guess the list`);
  }
  return names;
}

/**
 * Builds the file's key/value map and the refusals. Pure apart from reading
 * [env], so the guards are testable without a build.
 *
 * Returns `{ values, refusals, available }`: `available` says per vendor
 * whether every variable it needs was set.
 */
export function plan(secretNames, env) {
  const values = {};
  const refusals = [];
  const available = {};
  const bySecret = new Map();
  for (const [vendor, rows] of Object.entries(VENDOR_SECRETS)) {
    const extras = VENDOR_EXTRA_ENV[vendor] ?? [];
    available[vendor] =
      rows.filter((r) => r.required !== false).every((r) => (env[r.env] ?? '') !== '') &&
      extras.every((k) => (env[k] ?? '') !== '');
    for (const row of rows) bySecret.set(row.secret, row);
  }
  // Every declared secret, plus every vendor secret even if no function
  // declares it today, so a newly bound one is never left to Secret Manager.
  const names = new Set([...secretNames, ...bySecret.keys()]);
  for (const name of [...names].sort()) {
    const row = bySecret.get(name);
    const provided = row ? env[row.env] ?? '' : '';
    let value;
    if (provided !== '') value = provided;
    else if (row) value = row.placeholder;
    else if (name in FIXED_SECRETS) value = FIXED_SECRETS[name];
    else value = DEFAULT_PLACEHOLDER;
    if (/[\r\n]/.test(value)) refusals.push(`${name}: value contains a line break`);
    if (name.startsWith('STRIPE_') && !STRIPE_PREFIXES.test(value)) {
      refusals.push(`${name}: not a Stripe test-mode value (expected sk_test_, rk_test_, pk_test_ or whsec_)`);
    }
    if (name.startsWith('TWILIO_') && isForbiddenNumber(value)) {
      refusals.push(`${name}: names a phone number in a forbidden area code (business or private line)`);
    }
    values[name] = value;
  }
  // A Stripe or Twilio variable set in the environment but not bound to any
  // secret is still checked: it is about to be read by something.
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^STRIPE_/.test(key) && !STRIPE_PREFIXES.test(value)) {
      refusals.push(`${key} (environment): not a Stripe test-mode value`);
    }
    if (/^TWILIO_/.test(key) && isForbiddenNumber(value)) {
      refusals.push(`${key} (environment): names a phone number in a forbidden area code`);
    }
  }
  return { values, refusals: [...new Set(refusals)], available };
}

/** The file body: marker, then KEY=value lines, quoted so `#` and spaces survive. */
export function render(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `${MARKER}\n${lines.join('\n')}\n`;
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
    console.error(`REFUSED: ${target} exists and this script did not write it. Move it aside; it is not overwritten.`);
    process.exit(1);
  }
  const refusals = disconnectRisks(specDir);
  const { values, refusals: valueRefusals, available } = plan(declaredSecrets(functionsDir), process.env);
  refusals.push(...valueRefusals);
  if (refusals.length > 0) {
    console.error('REFUSED to start the real-services run:');
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
