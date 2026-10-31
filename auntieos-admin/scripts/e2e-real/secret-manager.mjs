/**
 * Reads the real-services run's production vendor values from Secret Manager
 * (#1264, operator ruling 2026-10-31).
 *
 * WHAT IT READS. Exactly the secrets on `SECRET_MANAGER_ALLOWLIST`, by name,
 * from the project `auntieos-ttpc`: the Cloudinary, smtp2go and Google OAuth
 * values, which D3 already runs against the production accounts. Each is handed
 * to the run under the `E2E_*` variable the preflight reads. Stripe and Twilio
 * are never read here: they stay test-only, from the GitHub environment
 * `e2e-real`, with the preflight's `sk_test_` / `pk_test_` and 805/989
 * refusals unchanged. `accessSecret` refuses any other name before gcloud is
 * started.
 *
 * THIS IS THE ONLY SECRET MANAGER READ. The emulator still never resolves a
 * secret itself: the preflight writes every declared secret into each
 * codebase's `.secret.local` before it boots, under a `demo-` project id
 * (#1089). This script only fills environment variables the preflight then
 * copies into that file.
 *
 * AN E2E_* VARIABLE ALREADY SET WINS. A value in the environment (exported in
 * the shell, or stored in the `e2e-real` GitHub environment) is used as it is
 * and its secret is not read, so the operator can point one vendor somewhere
 * else without touching Secret Manager.
 *
 * FAILS CLOSED. No gcloud on PATH, no login, a secret it may not read, or an
 * empty answer: the variable stays unset, the reason is printed (the name,
 * never a value), and that vendor's specs skip as they did before #1264. The
 * exit code is 0 for all of those. `E2E_SECRET_MANAGER=off` skips the read
 * entirely; the workflow sets `done` after its own read so run.sh does not
 * repeat it.
 *
 * TWO OUTPUTS, one per caller:
 *   --github   (the workflow) prints `::add-mask::<value>` for every value
 *              BEFORE anything else about it is written, then appends
 *              `NAME=value` to the file named by $GITHUB_ENV;
 *   --shell    (run.sh, local) prints `export NAME='value'` lines on stdout for
 *              run.sh to `eval`. Nothing is written to disk.
 * Everything else goes to stderr.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { SECRET_MANAGER_VENDORS, VENDOR_SECRETS } from './preflight.mjs';

/** The project the production functions read their secrets from. */
export const SECRET_MANAGER_PROJECT = 'auntieos-ttpc';

/** Vendors whose values must never come from Secret Manager. */
const TEST_ONLY_PREFIXES = /^(STRIPE_|TWILIO_)/;

/**
 * `{ secret, env }` pairs: the Secret Manager name and the variable the run
 * reads it under. Derived from the preflight's own table so the two cannot
 * drift, and checked here so a Stripe or Twilio row can never be added to it.
 */
export const SECRET_MANAGER_ALLOWLIST = Object.freeze(
  SECRET_MANAGER_VENDORS.flatMap((vendor) => {
    const rows = VENDOR_SECRETS[vendor];
    if (!rows) throw new Error(`SECRET_MANAGER_VENDORS names ${vendor}, which VENDOR_SECRETS does not have`);
    return rows.map(({ secret, env }) => {
      if (TEST_ONLY_PREFIXES.test(secret) || TEST_ONLY_PREFIXES.test(env)) {
        throw new Error(`${secret} is test-only and may never be read from Secret Manager`);
      }
      return Object.freeze({ secret, env });
    });
  }),
);

const ALLOWED = new Set(SECRET_MANAGER_ALLOWLIST.map((r) => r.secret));

/** gcloud, run without a shell. Throws on a non-zero exit or a missing binary. */
function gcloud(args) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A stuck connection (IPv6 over a VPN has done this to release.sh) must
    // not hang the run. A timeout is a failed read, so the vendor skips.
    timeout: 30_000,
  });
}

/**
 * The latest version of one allowlisted secret. Refuses any other name before
 * gcloud runs. [exec] is injectable for the tests.
 */
export function accessSecret(name, exec = gcloud) {
  if (!ALLOWED.has(name)) {
    throw new Error(`refused: ${name} is not on the e2e-real Secret Manager allowlist`);
  }
  const raw = exec(['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${SECRET_MANAGER_PROJECT}`, '--quiet']);
  // A value stored with `echo ... | gcloud secrets create` carries a trailing
  // newline no key or address has.
  return String(raw ?? '').replace(/[\r\n]+$/, '');
}

/** True when gcloud can be started at all. */
function gcloudAvailable(exec) {
  try {
    exec(['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides and performs the reads. Returns `{ values, notes }`: `values` maps
 * each E2E_* variable to the value to export (overrides included, so the
 * workflow can mask and pass them on), `notes` are the lines to print.
 */
export function resolveSecrets({ env = process.env, exec = gcloud } = {}) {
  const values = {};
  const notes = [];
  const mode = (env.E2E_SECRET_MANAGER ?? '').toLowerCase();
  const wanted = [];
  for (const row of SECRET_MANAGER_ALLOWLIST) {
    const set = env[row.env] ?? '';
    if (set !== '') {
      values[row.env] = set;
      notes.push(`${row.env}: set in the environment, ${row.secret} not read`);
    } else {
      wanted.push(row);
    }
  }
  if (wanted.length === 0) return { values, notes };
  if (mode === 'off' || mode === 'done') {
    notes.push(`E2E_SECRET_MANAGER=${mode}: not reading Secret Manager; unset: ${wanted.map((r) => r.env).join(', ')}`);
    return { values, notes };
  }
  if (!gcloudAvailable(exec)) {
    notes.push(
      `gcloud is not available, so nothing was read from Secret Manager. Unset, their specs skip: ${wanted
        .map((r) => r.env)
        .join(', ')}`,
    );
    return { values, notes };
  }
  for (const row of wanted) {
    let value;
    try {
      value = accessSecret(row.secret, exec);
    } catch (err) {
      // gcloud's stderr names the secret and the reason (not found, denied, no
      // login); it never carries a value.
      const why = String(err?.stderr || err?.message || err).trim().split('\n').pop();
      notes.push(`${row.env}: could not read ${row.secret} from ${SECRET_MANAGER_PROJECT} (${why}); its specs skip`);
      continue;
    }
    if (value === '') {
      notes.push(`${row.env}: ${row.secret} came back empty; its specs skip`);
      continue;
    }
    if (/[\r\n]/.test(value)) {
      notes.push(`${row.env}: ${row.secret} holds a line break, not used; its specs skip`);
      continue;
    }
    values[row.env] = value;
    notes.push(`${row.env}: read from ${row.secret}`);
  }
  return { values, notes };
}

/** One shell word, single-quoted. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The workflow's output. Every value is masked before any line about it is
 * written anywhere, then the variables are appended to $GITHUB_ENV. [out] and
 * [append] are injectable so the tests can read the order back.
 */
export function emitGithub(values, { out, append, githubEnv }) {
  for (const value of Object.values(values)) out(`::add-mask::${value}\n`);
  const names = Object.keys(values);
  const body = names.map((name) => `${name}=${values[name]}\n`).join('');
  // Tells run.sh not to read again: by the time it runs, the job has dropped
  // its Google credentials.
  append(githubEnv, `${body}E2E_SECRET_MANAGER=done\n`);
}

/** run.sh's output: `export` lines for `eval`. */
export function emitShell(values, { out }) {
  for (const [name, value] of Object.entries(values)) out(`export ${name}=${shellQuote(value)}\n`);
}

function main() {
  const mode = process.argv[2];
  if (mode !== '--github' && mode !== '--shell') {
    console.error('usage: secret-manager.mjs --github | --shell');
    process.exit(2);
  }
  const { values, notes } = resolveSecrets();
  const out = (s) => process.stdout.write(s);
  if (mode === '--github') {
    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) {
      console.error('--github needs $GITHUB_ENV');
      process.exit(2);
    }
    emitGithub(values, { out, append: appendFileSync, githubEnv });
  } else {
    emitShell(values, { out });
  }
  for (const n of notes) console.error(`secret-manager: ${n}`);
  if (mode === '--github' && notes.some((n) => n.startsWith('gcloud is not available') || n.includes('could not read'))) {
    console.log('::warning::e2e-real could not read every allowlisted secret from Secret Manager; see the step log');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
