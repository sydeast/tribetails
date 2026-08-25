#!/usr/bin/env node
/**
 * The client build config both web apps need, declared in one place, and the
 * step that fills it from Google Secret Manager before a release builds.
 *
 *   node scripts/client-secrets.mjs --list     what each app declares
 *   node scripts/client-secrets.mjs --check    resolve it; refuse if a required
 *                                              value is missing or empty
 *   node scripts/client-secrets.mjs --write    --check, then write each app's
 *                                              .env.production.local
 *   node scripts/client-secrets.mjs --clean    remove those files
 *
 * EXIT CODES, because "resolved", "refused" and "could not look" are three
 * outcomes and two of them are not the third:
 *   0  every declared value resolved
 *   1  a required value is missing or empty. The names are on stderr.
 *   3  neither source could be READ, so nothing was checked. Not a pass.
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
 */
export const CLIENT_VARS = [
  {
    app: 'admin',
    variable: 'VITE_SENTRY_DSN',
    secret: 'ADMIN_WEB_SENTRY_DSN',
    kind: 'secret-manager',
    required: true,
    sensitive: false,
    why:
      'Crash reporting for the React admin, Sentry project `auntieos-admin`. ' +
      'Required because an UNSET DSN is not a quiet degradation: the admin ' +
      'shipped without one and a two-hour CRITICAL error loop in ' +
      'notificationBatchSweep raised no alert at all.',
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
    required: false,
    sensitive: false,
    why:
      'reCAPTCHA Enterprise SITE key for admin App Check (#576). NOT required ' +
      'yet, and the exception is deliberate: the consuming code is in PR #587, ' +
      'unmerged, and the key itself does not exist. Checked 2026-08-24, the ' +
      'only App Check reCAPTCHA key on auntieos-ttpc is `mytribe-appcheck-web`, ' +
      'whose allowed domains are the portal\'s. Until the operator mints ' +
      '`auntieos-appcheck-web` and stores it, this warns by name every release. ' +
      'Flip required to true once it exists: from then on a release that lost ' +
      'it must stop, because App Check silently unconfigured is the failure ' +
      'this whole file is about.',
  },
  {
    app: 'portal',
    variable: 'VITE_SENTRY_DSN',
    secret: 'PORTAL_WEB_SENTRY_DSN',
    kind: 'secret-manager',
    required: true,
    sensitive: false,
    why:
      'Crash reporting for the kinfolk portal, Sentry project `mytribe-web`. ' +
      'A DIFFERENT project from the admin, so a different DSN. That is why ' +
      'the two apps cannot share one exported VITE_SENTRY_DSN.',
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

/**
 * Resolve every declared variable.
 *
 * @param {object}   o
 * @param {Array}    [o.vars]        declarations (defaults to CLIENT_VARS)
 * @param {string[]} [o.apps]        limit to these apps
 * @param {?Function} [o.fetchSecret] (name) => string | null. null means the
 *                                    store answered and has no such secret.
 *                                    Pass null for "the store is unreachable",
 *                                    which is a different thing and prints
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
  return {
    rows,
    refusals: bad.filter((r) => r.required),
    warnings: bad.filter((r) => !r.required),
  };
}

/**
 * The lines an operator has to run to fix a refusal. Printed rather than
 * guessed at, the same way release.sh step 1b prints
 * `firebase functions:secrets:set`.
 */
export function fixCommands(row, project) {
  if (row.kind !== 'secret-manager') return [];
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
 * Every secret name the project holds, or null when the store could not be
 * asked at all. Same shape and the same reasoning as release.sh step 1b:
 * "no secrets found" and "could not look" must never print the same.
 */
export function listSecretsWithGcloud(project) {
  const r = spawnSync('gcloud', ['secrets', 'list', '--project', project, '--format=value(name)'], {
    encoding: 'utf8',
  });
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

export function makeGcloudFetcher(project, existing) {
  return (name) => {
    if (!existing.includes(name)) return null;
    const r = spawnSync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, '--project', project],
      { encoding: 'utf8' },
    );
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
  const fetchSecret = existing === null ? null : makeGcloudFetcher(project, existing);

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

  for (const w of warnings) {
    console.error(`WARNING: ${w.variable} (${w.app}) is ${w.status}. ${w.why}`);
    for (const c of fixCommands(w, project)) console.error(`    ${c}`);
  }

  if (refusals.length > 0) {
    console.error('');
    console.error('REFUSED: the web apps declare client build config that has no value:');
    for (const r of refusals) {
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
    for (const r of refusals) {
      for (const c of fixCommands(r, project)) console.error(`    ${c}`);
    }
    return 1;
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
