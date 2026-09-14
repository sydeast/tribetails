#!/usr/bin/env node
/**
 * The client build config both web apps need, declared in one place, and the
 * step that fills it from Google Secret Manager before a release builds.
 *
 *   node scripts/client-secrets.mjs --list     what each app declares
 *   node scripts/client-secrets.mjs --check    resolve it; refuse (1) if a
 *                                              required value is missing or
 *                                              empty, or (4) if Secret Manager
 *                                              never answered for one
 *   node scripts/client-secrets.mjs --write    --check, then write each app's
 *                                              .env.production.local
 *   node scripts/client-secrets.mjs --clean    remove those files
 *
 * EXIT CODES, because "resolved", "refused for a bad value", "refused because
 * unreadable" and "could not look" are four outcomes and no two of them print
 * the same:
 *   0  every declared value resolved
 *   1  a required value is missing or empty. The names are on stderr.
 *   3  neither source could be READ, so nothing was checked. Not a pass.
 *   4  Secret Manager never answered for a REQUIRED secret, a gcloud timeout
 *      most likely (see #839 below). NOT the same as 1: the secret may exist
 *      and hold a good value. The names and the IPv4/IPv6 check are on
 *      stderr.
 *
 * WHY THIS EXISTS
 * `vite build` inlines import.meta.env.VITE_* into the bundle at BUILD time, so
 * every one of these values has to be present on the machine running the build.
 * Until now the only place they came from was a hand-maintained, gitignored
 * .env on one laptop. Nothing in the repo said which variables existed: on
 * 2026-08-24 VITE_ADMIN_APPCHECK_SITE_KEY appeared in neither .env.example, so
 * a fresh clone could not have known to set it. A value that lives on one
 * machine is not a build input, it is a memory, and the release had no way to
 * tell "the operator left this blank on purpose" from "this got lost".
 *
 * Operator ruling, 2026-08-24: "SECRETS MANAGER, ALL OUR SHIT IS IN THERE."
 * So the store is the single source of truth for these too, and a release that
 * cannot read one of them stops instead of quietly shipping a bundle with an
 * empty string compiled in.
 *
 * PRECEDENCE, and it is Vite's own, not something invented here.
 * `loadEnv()` reads .env, .env.local, .env.<mode>, .env.<mode>.local in that
 * order (later file wins), then overwrites the lot from process.env. So:
 *
 *   1. process.env             an explicit inline override, and how CI passes
 *                              a repo secret in (.github/workflows/preview.yml)
 *   2. <app>/.env.production.local     THIS SCRIPT, from Secret Manager.
 *                              Loaded only by a production build, so it is
 *                              invisible to `vite` dev and to vitest (mode
 *                              'test'), and it beats .env / .env.local.
 *   3. <app>/.env.local, <app>/.env    the developer's own values
 *
 * Line 2 is what makes Secret Manager win a release build while line 3 keeps
 * local development working with no gcloud, no credentials and no network.
 *
 * WHY A FILE PER APP AND NOT ONE EXPORTED ENVIRONMENT
 * Both apps declare a variable called VITE_SENTRY_DSN and the two values are
 * different: `auntieos-admin` and `mytribe-web` are separate Sentry projects in
 * the `tribetails` org, so they have separate DSNs. One exported process
 * environment cannot hold both, and `npm run check` builds both apps in one
 * invocation. Vite's per-app .env.production.local can, without release.sh
 * having to take the builds apart.
 *
 * WHAT IS AND IS NOT SENSITIVE HERE. Say it plainly, because treating public
 * identifiers as secrets is how people stop believing the word.
 *   - A reCAPTCHA Enterprise SITE key, a Sentry DSN and a `pk.*` Mapbox token
 *     are PUBLIC BY DESIGN. Every one of them ships inside the JavaScript
 *     bundle any browser can read. Centralizing them buys single-source-of-
 *     truth and a reproducible build, NOT secrecy. What bounds their abuse is
 *     domain/referrer restriction, per-key scopes and rotation.
 *   - VITE_APPCHECK_DEBUG_TOKEN is the one genuinely sensitive name here: it
 *     BYPASSES attestation for whoever holds it. It is per-developer, it is
 *     never fetched by this script, and it must never reach Secret Manager or
 *     git. That is why it carries kind 'local-only' below.
 *
 * WHAT THIS CANNOT TELL YOU. Whether the value in the store is the RIGHT one.
 * A stale Mapbox token and a rotated one look identical from here; the release
 * only proves that a non-empty value existed and reached the build.
 *
 * The resolver takes its fetcher as an argument so the tests can drive every
 * branch without gcloud. scripts/client-secrets.test.mjs does exactly that.
 *
 * EVERY gcloud CALL CARRIES A TIMEOUT (#839). On 2026-09-13 release step 0c sat
 * silent for 16 minutes: makeGcloudFetcher and listSecretsWithGcloud both called
 * spawnSync('gcloud', ...) with no timeout, and the stuck child had one socket
 * in SYN_SENT to Google over IPv6 (a VPN was installed; IPv4 answered
 * instantly). Nothing printed, so the hang read as an auth prompt rather than a
 * network fault. DEFAULT_GCLOUD_TIMEOUT_MS below is the default, thirty
 * seconds; CLIENT_SECRETS_GCLOUD_TIMEOUT_MS overrides it (a positive integer,
 * milliseconds) on a network known to be slower.
 *
 * A timed-out LIST is NOT the same as no gcloud and no credentials, even
 * though both used to collapse into the same `null`. No gcloud at all falls
 * back to each app's own .env files, the way local development already
 * works. A LIST that specifically TIMED OUT tells you nothing about whether
 * the store holds the values; gcloud just never answered, so falling back to
 * a laptop's .env would ship a value the store never confirmed. Every
 * Secret Manager-backed row is marked 'unreadable' instead, with no .env
 * fallback for those rows.
 *
 * A timed-out ACCESS for one secret gets the same status. Once one ACCESS
 * call times out, the rest are marked unreadable WITHOUT being spawned:
 * gcloud stuck on the same dead route once is going to be stuck on it for
 * every remaining secret in the run, so waiting out the full timeout again
 * for each one turns a 30-second problem into a multi-minute one for no
 * better an answer.
 *
 * 'unreadable' is NOT 'missing': reporting it as missing would tell the
 * operator to `gcloud secrets create` a secret that may already exist and
 * hold a perfectly good value. A REQUIRED value that is unreadable REFUSES,
 * with its own exit code (4, see above) so release.sh can print the
 * IPv4/IPv6 check instead of "has no value". An OPTIONAL value that is
 * unreadable WARNS instead, the same as an optional value confirmed absent:
 * the two Sentry DSNs are optional because nothing depends on them (see the
 * declaration below), and that reasoning does not change just because
 * gcloud stalled instead of answering "not found".
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory of each app, relative to the repo root. */
export const APP_DIRS = {
  admin: 'auntieos-admin',
  portal: 'mytribe/web',
};

/** The file Vite loads last (before process.env) on a production build. */
export const PRODUCTION_ENV_FILE = '.env.production.local';

/**
 * THE DECLARATION. Every VITE_* variable either web app reads, and where its
 * value comes from. Adding a `import.meta.env.VITE_SOMETHING` without a row
 * here is the defect this file exists to prevent, and
 * scripts/client-secrets.test.mjs fails on any VITE_ name in either app's src/
 * that is missing below.
 *
 * kind:
 *   'secret-manager'  fetched from Secret Manager for a release build
 *   'derived'         computed by the release itself; never stored
 *   'local-only'      per-developer; never fetched, never stored, never in CI
 *
 * required: true means a release REFUSES rather than shipping without it, the
 * same rule release.sh step 1b applies to Cloud Function secrets.
 *
 * REQUIRED IS NOT THE DEFAULT AND MUST NOT BECOME ONE. A gate that demands a
 * value nothing needs is the same defect as a missing gate, pointed the other
 * way: it stops releases to protect a capability the product does not use, and
 * the first thing anyone does with it is learn the flag that turns it off. Both
 * Sentry DSNs are optional because web Sentry has never been configured in
 * either app, checked against the actual files rather than assumed from the
 * variable names existing.
 */
export const CLIENT_VARS = [
  {
    app: 'admin',
    variable: 'VITE_SENTRY_DSN',
    secret: 'ADMIN_WEB_SENTRY_DSN',
    kind: 'secret-manager',
    required: false,
    sensitive: false,
    why:
      'Crash reporting for the React admin at auntie.tribetails.com, Sentry ' +
      'project `auntieos-admin`. OPTIONAL, and the reason is that it has ' +
      'never been configured: on 2026-08-24 both the admin .env and the ' +
      "portal .env.local carried an EMPTY VITE_SENTRY_DSN, and there is no " +
      'other source. Web Sentry has never been switched on for either app. ' +
      'lib/sentry.ts treats a blank DSN as an ordinary state: it logs ' +
      '"Sentry disabled: no VITE_SENTRY_DSN" and returns without throwing. ' +
      'Requiring it would refuse every release over a capability the product ' +
      'has never used, which is a gate demanding something nothing needs.',
  },
  {
    app: 'admin',
    variable: 'VITE_SENTRY_RELEASE',
    kind: 'derived',
    required: true,
    sensitive: false,
    why:
      'The commit the bundle was built from, so Sentry can group a regression ' +
      'against the deploy that introduced it. Derived, never stored: a value ' +
      'kept by hand in a .env is a value that says "the last release someone ' +
      'remembered to edit this".',
  },
  {
    app: 'admin',
    variable: 'VITE_ADMIN_APPCHECK_SITE_KEY',
    secret: 'ADMIN_WEB_APPCHECK_SITE_KEY',
    kind: 'secret-manager',
    required: true,
    sensitive: false,
    why:
      'reCAPTCHA Enterprise SITE key for admin App Check (#576). The key was ' +
      'minted and registered with App Check on 2026-08-24, for ' +
      'auntie.tribetails.com, auntieos-ttpc.web.app and ' +
      'auntieos-ttpc.firebaseapp.com. A site key is a public identifier: it ' +
      'ships in the bundle and says which reCAPTCHA key the page scores ' +
      'against, and the secret half never leaves Google. What binds it is that ' +
      'domain list. Required from the moment it exists, because App Check ' +
      'silently unconfigured is the failure this whole file is about, and an ' +
      'empty site key produces exactly that while looking healthy. ' +
      'REQUIRED BEFORE ITS CONSUMER MERGES, on purpose: the release resolves ' +
      'from this declaration, not from grepping usage, so it fetches and ' +
      'writes the value whether or not #587 has landed. Vite inlines only the ' +
      'names the source actually reads, so on main today it reaches no bundle ' +
      'and breaks nothing; the day #587 merges the value is already there.',
  },
  {
    app: 'admin',
    variable: 'VITE_MAPBOX_PUBLIC_TOKEN',
    secret: 'ADMIN_WEB_MAPBOX_PUBLIC_TOKEN',
    kind: 'secret-manager',
    required: true,
    sensitive: false,
    why:
      'The URL-restricted `web-maps-public` token (styles:tiles, styles:read, ' +
      'fonts:read) that draws the Kin Care visit route over a satellite ' +
      'basemap on the Auntie Time detail (#760, operator ruling 2026-09-11). ' +
      'ITS OWN SECRET NAME, not the portal\'s, even though the VALUE may be ' +
      'the same token: one name per app is what lets the operator rotate or ' +
      're-restrict one site without reading the other app\'s build to find ' +
      'out what broke, and it is the same reason the two Sentry DSNs are two ' +
      'names. Required for the reason the portal row gives: RouteMap degrades ' +
      'to its SVG polyline without a token, so a release that lost it would ' +
      'look entirely healthy while quietly handing the office the plainer ' +
      'map. The token must also carry auntie.tribetails.com and the main ' +
      'channel host in its URL restrictions, or the tiles 403 and the admin ' +
      'lands on that same fallback with a valid token in the bundle. NOT the ' +
      'server-side tokens-API secret revoked on 2026-09-03, and NOT the ' +
      'search-scoped token `api/mapbox.ts` proxies through a callable.',
  },
  {
    app: 'portal',
    variable: 'VITE_SENTRY_DSN',
    secret: 'PORTAL_WEB_SENTRY_DSN',
    kind: 'secret-manager',
    required: false,
    sensitive: false,
    why:
      'Crash reporting for the kinfolk portal at kinfolk.tribetails.com, ' +
      'Sentry project `mytribe-web`. A DIFFERENT project from the admin, so ' +
      'a different DSN, which is why the two apps cannot share one exported ' +
      'VITE_SENTRY_DSN. OPTIONAL for the same reason as the admin: the value ' +
      'has never been set, and a blank DSN disables reporting rather than ' +
      'breaking anything.',
  },
  {
    app: 'portal',
    variable: 'VITE_SENTRY_RELEASE',
    kind: 'derived',
    required: true,
    sensitive: false,
    why: 'Same as the admin: the release commit, computed at release time.',
  },
  {
    app: 'portal',
    variable: 'VITE_MAPBOX_PUBLIC_TOKEN',
    secret: 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN',
    kind: 'secret-manager',
    required: true,
    sensitive: false,
    why:
      'The URL-restricted `web-maps-public` token (styles:tiles, styles:read, ' +
      'fonts:read) that draws the KinCare visit route over real streets (#520). ' +
      'RouteMap degrades to its SVG polyline without one, which is exactly why ' +
      'it is required here: a release that lost the token would look fine and ' +
      'quietly hand every kinfolk the plainer map. NOT the unrestricted mobile ' +
      'token the Android apps use.',
  },
  {
    app: 'portal',
    variable: 'VITE_APPCHECK_DEBUG_TOKEN',
    kind: 'local-only',
    required: false,
    sensitive: true,
    why:
      'Per-developer App Check debug token. The one genuinely sensitive name ' +
      'in this file: it bypasses attestation. Registered per developer in the ' +
      'Firebase console, read only from that developer\'s .env.local, and ' +
      'tree-shaken out of any production build by `import.meta.env.DEV`. It ' +
      'must never be stored centrally. One shared bypass token is a bypass ' +
      'token for everyone.',
  },
];

/** The Secret Manager names a release has to be able to read. */
export function declaredSecretNames(vars = CLIENT_VARS) {
  return [...new Set(vars.filter((v) => v.kind === 'secret-manager').map((v) => v.secret))].sort();
}

/** Default timeout for a single gcloud spawn, in milliseconds. See #839. */
export const DEFAULT_GCLOUD_TIMEOUT_MS = 30_000;

function resolveTimeoutMs() {
  const raw = process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  // Integers only. A fractional value (1500.5), zero, a negative number or
  // garbage is not a request for that many milliseconds, it is a bad value,
  // and DEFAULT_GCLOUD_TIMEOUT_MS is the safer read than trying to honor it.
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GCLOUD_TIMEOUT_MS;
}

/**
 * True when a spawnSync result is a timeout rather than an ordinary gcloud
 * failure. Node's own `timeout` option sets `error.code` to 'ETIMEDOUT' when
 * it fires (verified against a real spawnSync: `timeout` plus
 * `killSignal: 'SIGKILL'` against `sleep` produces exactly
 * {code: 'ETIMEDOUT', signal: 'SIGKILL', status: null}). When an `error` IS
 * present, its code has to be 'ETIMEDOUT': a failure that happens to also
 * carry a signal, an OOM kill say, must not be reported as a timeout just
 * because something else killed the child. Only when there is NO error
 * object at all does a bare `signal` count on its own, which is what lets a
 * minimal test double (no `error` field, just `signal`) still exercise the
 * timeout path.
 */
export function isGcloudTimeout(r) {
  if (r?.error) return r.error.code === 'ETIMEDOUT';
  return Boolean(r?.signal);
}

const IPV4_CHECK = "curl -4 -sS -o /dev/null -w '%{http_code}\\n' https://secretmanager.googleapis.com";
const IPV6_CHECK = "curl -6 -sS -o /dev/null -w '%{http_code}\\n' https://secretmanager.googleapis.com";

/**
 * The sentinel returned when Secret Manager never answered: from a
 * fetchSecret function when one ACCESS call timed out, or from
 * listSecretsWithGcloud when the LIST call itself timed out. resolveClientVars
 * needs to tell this apart from `null`, which means "the store answered and
 * has no such secret" (or, from listSecretsWithGcloud, "the store could not be
 * asked at all"). A Symbol rather than a string: nothing here should be able
 * to stringify it by accident and have the result look like a real, if odd,
 * secret value.
 */
export const SECRET_UNREADABLE = Symbol('client-secrets:unreadable');

/**
 * Resolve every declared variable.
 *
 * @param {object}   o
 * @param {Array}    [o.vars]        declarations (defaults to CLIENT_VARS)
 * @param {string[]} [o.apps]        limit to these apps
 * @param {?Function} [o.fetchSecret] (name) => string | null | typeof SECRET_UNREADABLE.
 *                                    null means the store answered and has no
 *                                    such secret. SECRET_UNREADABLE means the
 *                                    store never answered for this one secret,
 *                                    a gcloud timeout most likely. That is not
 *                                    the same claim as null, and it is reported
 *                                    under its own status so a refusal never
 *                                    reads as "this secret does not exist" when
 *                                    it might. Pass null for the whole function
 *                                    for "the store is unreachable", which is a
 *                                    different thing again and prints
 *                                    differently.
 * @param {object}   [o.processEnv]  already-set environment (CI passes here)
 * @param {object}   [o.localEnv]    per-app maps of what the app's .env files
 *                                   hold, keyed by app: { admin: {...} }
 * @param {string}   [o.release]     value for the 'derived' rows
 * @returns {{rows: Array, refusals: Array, warnings: Array}}
 */
export function resolveClientVars({
  vars = CLIENT_VARS,
  apps = Object.keys(APP_DIRS),
  fetchSecret = null,
  processEnv = {},
  localEnv = {},
  release = '',
} = {}) {
  const rows = [];

  for (const decl of vars) {
    if (!apps.includes(decl.app)) continue;

    const row = { ...decl, source: 'none', value: '', status: 'missing' };
    const local = (localEnv[decl.app] || {})[decl.variable];
    const inherited = processEnv[decl.variable];

    if (decl.kind === 'local-only') {
      // Never fetched and never required. It is reported so the table is the
      // whole picture rather than the fetchable part of it.
      row.source = 'local-only';
      row.status = 'skipped';
      rows.push(row);
      continue;
    }

    if (decl.kind === 'derived') {
      row.source = 'derived';
      row.value = (release || '').trim();
      row.status = row.value === '' ? 'missing' : 'ok';
      rows.push(row);
      continue;
    }

    // kind === 'secret-manager'
    if (fetchSecret) {
      const fetched = fetchSecret(decl.secret);
      if (fetched === SECRET_UNREADABLE) {
        // Secret Manager never answered for this one. This is not the same as
        // "the store answered and has no such secret": reporting it as missing
        // would tell the operator to create a secret that may already exist
        // and hold a good value. It gets its own status, and the release still
        // refuses on it below regardless of whether the variable is required,
        // because a value nobody could verify is not a value that shipped.
        row.source = 'secret-manager';
        row.status = 'unreadable';
        rows.push(row);
        continue;
      }
      if (fetched === null || fetched === undefined) {
        // The store answered and does not have it. Do NOT fall through to a
        // local file: the point of the ruling is that the store is the source
        // of truth, and a release that silently substituted one laptop's copy
        // would reintroduce exactly the drift being removed.
        row.source = 'secret-manager';
        row.status = 'missing';
        row.localAlso = typeof local === 'string' && local.trim() !== '';
        rows.push(row);
        continue;
      }
      if (fetched.trim() === '') {
        row.source = 'secret-manager';
        row.status = 'empty';
        row.localAlso = typeof local === 'string' && local.trim() !== '';
        rows.push(row);
        continue;
      }
      row.source = 'secret-manager';
      row.value = fetched.trim();
      row.status = 'ok';
      rows.push(row);
      continue;
    }

    // No fetcher: the store could not be asked at all (no gcloud, no
    // credentials, a developer's machine). Fall back the way local development
    // already works, and judge on what the build would ACTUALLY get.
    if (typeof inherited === 'string' && inherited.trim() !== '') {
      row.source = 'process-env';
      row.value = inherited.trim();
      row.status = 'ok';
    } else if (typeof local === 'string' && local.trim() !== '') {
      row.source = 'local-file';
      row.value = local.trim();
      row.status = 'ok';
    } else {
      row.source = 'none';
      row.status = 'missing';
    }
    rows.push(row);
  }

  const bad = rows.filter((r) => r.status === 'missing' || r.status === 'empty');
  const unreadable = rows.filter((r) => r.status === 'unreadable');
  return {
    rows,
    // 'unreadable' follows the SAME required/optional split as 'missing' and
    // 'empty': a REQUIRED value nobody could verify refuses, an OPTIONAL one
    // warns. The declaration's own "REQUIRED IS NOT THE DEFAULT" paragraph
    // above, and the two Sentry DSNs, already argue that a value nothing
    // depends on should not stop a release, and that holds whether the store
    // said "not found" or simply never answered. The one thing 'unreadable'
    // never does is get treated as 'missing'.
    refusals: [...bad.filter((r) => r.required), ...unreadable.filter((r) => r.required)],
    warnings: [...bad.filter((r) => !r.required), ...unreadable.filter((r) => !r.required)],
  };
}

/**
 * The lines an operator has to run to fix a refusal. Printed rather than
 * guessed at, the same way release.sh step 1b prints
 * `firebase functions:secrets:set`.
 */
export function fixCommands(row, project) {
  if (row.kind !== 'secret-manager') return [];
  if (row.status === 'unreadable') {
    // Diagnostic, not remediation. Nobody here knows whether the secret
    // exists, so `gcloud secrets create` is exactly the wrong advice; the
    // right one is finding out why gcloud never answered.
    return [IPV4_CHECK, IPV6_CHECK];
  }
  const create = `gcloud secrets create ${row.secret} --project ${project} --replication-policy=automatic`;
  const set = `printf %s "<value>" | gcloud secrets versions add ${row.secret} --project ${project} --data-file=-`;
  return row.status === 'empty' ? [set] : [create, set];
}

/**
 * Render one app's .env.production.local.
 *
 * Only values this script RESOLVED are written. A value that already reaches
 * Vite on its own (process.env, or the developer's .env) is left where it is:
 * copying it here would make this file look like the source of a value it did
 * not fetch.
 */
export function renderEnvFile(appRows, { generatedFor = '' } = {}) {
  const lines = [
    '# GENERATED by scripts/client-secrets.mjs. Do not edit, do not commit.',
    '# Rewritten by every release from Google Secret Manager, and removed when',
    '# the release finishes. Vite loads this last of the .env files, so it beats',
    '# .env and .env.local; only an explicit process.env value outranks it.',
    ...(generatedFor ? [`# Release: ${generatedFor}`] : []),
    '',
  ];

  for (const row of appRows) {
    if (row.status !== 'ok') continue;
    if (row.source !== 'secret-manager' && row.source !== 'derived') continue;
    // Single-quoted, and any value that could break out of the quoting is a
    // refusal rather than a mangled line. None of these formats contain a
    // quote or a newline; a value that does is a wrong value, not a new case
    // to support.
    if (/['\r\n]/.test(row.value)) {
      throw new Error(
        `${row.variable} holds a quote or a newline, which no DSN, site key or ` +
          `Mapbox token does. Refusing to write a value this script cannot ` +
          `quote correctly; check what is stored in ${row.secret || 'the store'}.`,
      );
    }
    lines.push(`${row.variable}='${row.value}'`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The real outside world. Everything above is pure and takes its inputs.
// ---------------------------------------------------------------------------

/**
 * Every secret name the project holds; `null` when the store could not be
 * asked at all (no gcloud, no credentials, or gcloud answered nothing); or
 * SECRET_UNREADABLE when the LIST call specifically TIMED OUT. The timeout
 * case is not the same claim as `null`: the store might hold every declared
 * secret, gcloud simply never answered, so a caller must not fall back to a
 * local .env for it the way it does for "no gcloud at all" (#839). Same
 * reasoning as release.sh step 1b: "no secrets found" and "could not look"
 * must never print the same, and now neither must "could not look because
 * there is no gcloud" and "could not look because gcloud never answered".
 *
 * `spawn` is injectable so scripts/client-secrets.test.mjs can simulate a
 * gcloud that never answers without actually waiting out a timeout. `log`
 * defaults to stderr and prints one line before the call and, on a timeout,
 * a diagnostic pointing at the IPv4/IPv6 check: the real defect here was not
 * the hang, it was that step 0c gave no sign anything was happening.
 */
export function listSecretsWithGcloud(
  project,
  { spawn = spawnSync, timeoutMs = resolveTimeoutMs(), log = (line) => console.error(line) } = {},
) {
  log(`client config: listing secrets in Secret Manager (project ${project})...`);
  const r = spawn('gcloud', ['secrets', 'list', '--project', project, '--format=value(name)'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (isGcloudTimeout(r)) {
    log(`client config: listing secrets timed out after ${timeoutMs}ms.`);
    log('  This is the same failure shape release step 0c hit on 2026-09-13: gcloud');
    log('  stuck on a dead route to Google, most often IPv6 with a VPN installed, while');
    log('  IPv4 answers instantly. Every Secret Manager-backed value will be treated as');
    log('  unreadable rather than falling back to a local .env: the store might hold');
    log('  every one of them, gcloud just never answered. Check:');
    log(`    ${IPV4_CHECK}`);
    log(`    ${IPV6_CHECK}`);
    return SECRET_UNREADABLE;
  }
  if (r.error || r.status !== 0) return null;
  const names = (r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // An empty listing from a project that certainly has function secrets is the
  // signature of a gcloud that exited 0 without answering, which is how it
  // behaves in some non-interactive environments. Treat it as "could not ask".
  return names.length === 0 ? null : names;
}

export function makeGcloudFetcher(
  project,
  existing,
  { spawn = spawnSync, timeoutMs = resolveTimeoutMs(), log = (line) => console.error(line) } = {},
) {
  // Set once any ACCESS call times out. gcloud stuck on a dead route once is
  // going to be stuck on it for every remaining secret in this run, so after
  // the first timeout the rest are marked unreadable without being spawned:
  // waiting out the full timeout again for each one turns a 30-second problem
  // into a multi-minute one for no better an answer (#839).
  let networkUnreachable = false;

  return (name) => {
    if (!existing.includes(name)) return null;

    if (networkUnreachable) {
      log(
        `client config: skipping ${name} (an earlier fetch already timed out; not waiting ` +
          `out ${timeoutMs}ms again for the same dead route)`,
      );
      return SECRET_UNREADABLE;
    }

    log(`client config: fetching ${name}...`);
    const r = spawn(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, '--project', project],
      { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' },
    );
    if (isGcloudTimeout(r)) {
      networkUnreachable = true;
      log(`client config: fetching ${name} timed out after ${timeoutMs}ms.`);
      log(`  This does not mean ${name} is missing. It means gcloud never answered, most`);
      log('  likely the same IPv6-to-Google stall release step 0c hit on 2026-09-13 (a VPN');
      log('  can force gcloud onto a dead IPv6 route while IPv4 answers instantly). Check:');
      log(`    ${IPV4_CHECK}`);
      log(`    ${IPV6_CHECK}`);
      return SECRET_UNREADABLE;
    }
    if (r.error || r.status !== 0) return null;
    return r.stdout ?? '';
  };
}

/**
 * What each app's own .env files hold, read through VITE'S OWN loader so this
 * agrees with the build by construction rather than by a second parser that
 * would drift. If vite cannot be imported (no install yet) we say so instead
 * of reporting an empty result, for the same reason listSecretsWithGcloud
 * returns null.
 */
export async function loadLocalEnv(apps = Object.keys(APP_DIRS)) {
  let loadEnv;
  try {
    ({ loadEnv } = await import('vite'));
  } catch {
    return null;
  }
  const out = {};
  for (const app of apps) {
    out[app] = loadEnv('production', path.join(ROOT, APP_DIRS[app]), 'VITE_');
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(argv, name, fallback = '') {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

async function main(argv) {
  const project = arg(argv, '--project', process.env.GCLOUD_PROJECT || 'auntieos-ttpc');
  const release = arg(argv, '--release', '');
  const mode = argv.includes('--list')
    ? 'list'
    : argv.includes('--write')
      ? 'write'
      : argv.includes('--clean')
        ? 'clean'
        : 'check';

  if (mode === 'list') {
    for (const v of CLIENT_VARS) {
      console.log(
        [pad(v.app, 7), pad(v.variable, 30), pad(v.kind, 15), v.required ? 'required' : 'optional', v.secret || '-'].join(
          '\t',
        ),
      );
    }
    return 0;
  }

  if (mode === 'clean') {
    for (const [app, dir] of Object.entries(APP_DIRS)) {
      const f = path.join(ROOT, dir, PRODUCTION_ENV_FILE);
      if (fs.existsSync(f)) {
        fs.rmSync(f);
        console.log(`removed ${dir}/${PRODUCTION_ENV_FILE}`);
      } else {
        console.log(`nothing to remove for ${app}`);
      }
    }
    return 0;
  }

  const existing = listSecretsWithGcloud(project);
  const loaded = await loadLocalEnv();
  const localEnv = loaded || {};

  // Three states, not two, and they resolve differently (#839). `existing` an
  // array: gcloud answered, fetch each secret normally. `null`: no gcloud, no
  // credentials, or it answered nothing; fall back to each app's own .env
  // files, the way local development already works. SECRET_UNREADABLE: the
  // LIST call specifically TIMED OUT, which tells us nothing about whether
  // the store holds these values, so every Secret Manager-backed row is
  // marked unreadable instead. Falling back to a local .env for THAT case
  // would ship a value the store never confirmed, which is exactly the class
  // of bug the ruling behind this whole file exists to prevent.
  let fetchSecret;
  if (existing === SECRET_UNREADABLE) {
    fetchSecret = () => SECRET_UNREADABLE;
  } else if (existing === null) {
    fetchSecret = null;
  } else {
    fetchSecret = makeGcloudFetcher(project, existing);
  }

  if (existing === null) {
    console.error(
      'client config: could not read Secret Manager (no gcloud, no credentials,\n' +
        '  or it answered nothing). Falling back to each app\'s own .env files, which\n' +
        '  is how local development is meant to work. A REQUIRED value that is not\n' +
        '  there either still stops this.',
    );
  }

  const { rows, refusals: found, warnings } = resolveClientVars({
    fetchSecret,
    processEnv: process.env,
    localEnv,
    release,
  });

  // "COULD NOT LOOK" IS NOT "NOT THERE", and the whole point of the sibling
  // check in release.sh step 1b is that the two must never print the same. When
  // neither source could be READ, meaning no gcloud AND no vite to load the
  // through (an install that has not happened yet), this run knows nothing
  // about these values, and refusing on an unknown would be a guess dressed as a
  // gate. It is still said out loud, because a silent skip reads as a pass.
  const blind = existing === null && loaded === null;
  const refusals = blind ? [] : found;

  console.log(`${pad('APP', 7)}\t${pad('VARIABLE', 30)}\t${pad('SOURCE', 15)}\tSTATUS`);
  for (const r of rows) {
    console.log(`${pad(r.app, 7)}\t${pad(r.variable, 30)}\t${pad(r.source, 15)}\t${r.status}`);
  }

  if (blind) {
    console.error('');
    console.error('client config: NOT CHECKED. Secret Manager could not be read, and'); 
    console.error("  neither could the apps' own .env files (vite is not installed - has");
    console.error('  `npm ci` run?). Whatever the build finds is what ships; nothing here');
    console.error('  judged it.');
    for (const r of found) console.error(`    unverified: ${r.variable} (${r.app})`);
    // 3, not 0. A caller that cannot tell "checked and fine" from "could not
    // check" will print the first when it means the second, which is how a
    // gate becomes decoration.
    return 3;
  }

  // Missing/empty and unreadable warnings read differently: the first says the
  // store answered and the value is absent, which is the declaration's own
  // `why` (nothing depends on it); the second says the store never answered
  // at all, which needs the network check, not the declaration's reasoning.
  const notFoundWarnings = warnings.filter((r) => r.status !== 'unreadable');
  const unreadableWarnings = warnings.filter((r) => r.status === 'unreadable');

  for (const w of notFoundWarnings) {
    console.error(`WARNING: ${w.variable} (${w.app}) is ${w.status}. ${w.why}`);
    for (const c of fixCommands(w, project)) console.error(`    ${c}`);
  }
  for (const w of unreadableWarnings) {
    console.error(
      `WARNING: ${w.variable} (${w.app}) could not be read from Secret Manager. It is ` +
        'OPTIONAL, so this warns rather than refuses (the same call the declaration ' +
        'already makes for a confirmed-absent value); gcloud simply never answered in ' +
        'time. Check:',
    );
    for (const c of fixCommands(w, project)) console.error(`    ${c}`);
  }

  if (refusals.length > 0) {
    // Missing/empty and unreadable are different claims and get different
    // paragraphs: the first says the store answered and the value is bad, the
    // second says the store never answered at all, and the fix commands for
    // the second must never look like the fix commands for the first (#839).
    const notFound = refusals.filter((r) => r.status !== 'unreadable');
    const unreadable = refusals.filter((r) => r.status === 'unreadable');

    if (notFound.length > 0) {
      console.error('');
      console.error('REFUSED: the web apps declare client build config that has no value:');
      for (const r of notFound) {
        console.error(`    ${r.variable} (${r.app})${r.secret ? ` <- ${r.secret}` : ''} is ${r.status}`);
        if (r.localAlso) {
          console.error(
            '      A local .env DOES have a value for it. That is not enough for a',
          );
          console.error(
            '      release: the store is the source of truth, so store it there.',
          );
        }
      }
      console.error('');
      console.error('  Vite compiles these INTO the bundle at build time, so a release that');
      console.error('  went ahead would ship an empty string and look fine doing it.');
      console.error('');
      for (const r of notFound) {
        for (const c of fixCommands(r, project)) console.error(`    ${c}`);
      }
    }

    if (unreadable.length > 0) {
      console.error('');
      console.error('REFUSED: Secret Manager did not answer for these REQUIRED secrets in time:');
      for (const r of unreadable) {
        console.error(`    ${r.variable} (${r.app})${r.secret ? ` <- ${r.secret}` : ''} could not be read`);
      }
      console.error('');
      console.error('  This is not the same as missing. The secret may exist and hold a good');
      console.error('  value; gcloud simply never answered in time, so do not create these');
      console.error('  secrets on the strength of this message. Check:');
      for (const c of fixCommands(unreadable[0], project)) console.error(`    ${c}`);
    }

    // Exit 4, not 1, whenever at least one refusal could not even be checked:
    // the fix is a network check, not `gcloud secrets create`, and release.sh
    // reads this code to print the right one instead of "has no value" (#839).
    return unreadable.length > 0 ? 4 : 1;
  }

  if (mode === 'write') {
    for (const app of Object.keys(APP_DIRS)) {
      const appRows = rows.filter((r) => r.app === app);
      const body = renderEnvFile(appRows, { generatedFor: release });
      const file = path.join(ROOT, APP_DIRS[app], PRODUCTION_ENV_FILE);
      fs.writeFileSync(file, body, { mode: 0o600 });
      console.log(`wrote ${APP_DIRS[app]}/${PRODUCTION_ENV_FILE}`);
    }
  }

  return 0;
}

// realpathSync, not resolve. On macOS every path under /tmp or /var goes
// through a symlink to /private, and Node reports import.meta.url as the REAL
// path while process.argv[1] keeps whatever the caller typed. Comparing the two
// unresolved makes this file import cleanly and then do NOTHING, exiting 0 with
// no output. A release step that silently succeeds without running is worse
// than one that fails.
const invokedAs = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invokedAs === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
