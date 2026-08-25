#!/usr/bin/env node --test
/**
 * Tests for scripts/client-secrets.mjs. Run:
 *   node --test scripts/client-secrets.test.mjs
 *
 * NOTHING HERE TOUCHES gcloud. The resolver takes its fetcher as an argument
 * precisely so every branch (the store answered and has no such secret, the
 * store holds an EMPTY version, the store could not be asked at all) is
 * reachable from a test, on a machine with no credentials and no network. A
 * test that needed gcloud would be a test that never ran.
 *
 * The precedence case is the exception and it is deliberate: it drives VITE'S
 * OWN loadEnv against real files on disk, because "Secret Manager wins over a
 * developer's .env" is a claim about Vite's behaviour, and asserting it against
 * a reimplementation would prove only that the reimplementation agrees with
 * itself.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APP_DIRS,
  CLIENT_VARS,
  PRODUCTION_ENV_FILE,
  ROOT,
  declaredSecretNames,
  fixCommands,
  renderEnvFile,
  resolveClientVars,
} from './client-secrets.mjs';

// Obviously-fake values. Nothing real belongs in a test file: it would be a
// real key in git history, and the tests do not care what the string is.
const FAKE_DSN = 'https://examplepublickey@o0.ingest.us.sentry.io/0';
const FAKE_TOKEN = 'pk.example-not-a-real-token';
const FAKE_SITE_KEY = '6LcEXAMPLE-not-a-real-site-key';

/** A store that holds exactly what it is handed. */
function storeWith(contents) {
  return (name) => (name in contents ? contents[name] : null);
}

/** Everything a release would need, so a case can remove one thing. */
function fullStore(overrides = {}) {
  return storeWith({
    ADMIN_WEB_SENTRY_DSN: FAKE_DSN,
    PORTAL_WEB_SENTRY_DSN: FAKE_DSN,
    PORTAL_WEB_MAPBOX_PUBLIC_TOKEN: FAKE_TOKEN,
    ADMIN_WEB_APPCHECK_SITE_KEY: FAKE_SITE_KEY,
    ...overrides,
  });
}

test('a release with everything stored resolves every variable from the store', () => {
  const { rows, refusals, warnings } = resolveClientVars({
    fetchSecret: fullStore(),
    release: 'abc1234',
  });

  assert.equal(refusals.length, 0);
  assert.equal(warnings.length, 0);

  const fetched = rows.filter((r) => r.kind === 'secret-manager');
  assert.ok(fetched.length > 0);
  for (const r of fetched) {
    assert.equal(r.source, 'secret-manager', `${r.variable} came from ${r.source}`);
    assert.equal(r.status, 'ok');
  }

  // Both apps get a DSN, and they are resolved SEPARATELY. One exported
  // VITE_SENTRY_DSN could not serve both; this is the reason for the per-app
  // file, so it is asserted rather than assumed.
  const dsns = rows.filter((r) => r.variable === 'VITE_SENTRY_DSN');
  assert.equal(dsns.length, 2);
  assert.deepEqual(
    dsns.map((r) => r.secret).sort(),
    ['ADMIN_WEB_SENTRY_DSN', 'PORTAL_WEB_SENTRY_DSN'],
  );
});

test('a required client secret missing from the store refuses, BY NAME', () => {
  const store = fullStore();
  const { refusals } = resolveClientVars({
    fetchSecret: (name) => (name === 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN' ? null : store(name)),
    release: 'abc1234',
  });

  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].variable, 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(refusals[0].secret, 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN');
  assert.equal(refusals[0].status, 'missing');

  // The refusal has to carry the command that fixes it, or it is a puzzle.
  const cmds = fixCommands(refusals[0], 'auntieos-ttpc');
  assert.ok(cmds.some((c) => c.includes('gcloud secrets create PORTAL_WEB_MAPBOX_PUBLIC_TOKEN')));
  assert.ok(cmds.some((c) => c.includes('versions add PORTAL_WEB_MAPBOX_PUBLIC_TOKEN')));
});

test('a stored-but-EMPTY value refuses too, and is not reported as missing', () => {
  const store = fullStore({ PORTAL_WEB_MAPBOX_PUBLIC_TOKEN: '   \n' });
  const { refusals } = resolveClientVars({ fetchSecret: store, release: 'abc1234' });

  const token = refusals.find((r) => r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.ok(token, 'an empty stored value must refuse');
  assert.equal(token.status, 'empty');
  // An empty secret already exists, so telling the operator to CREATE it is
  // wrong advice.
  const cmds = fixCommands(token, 'auntieos-ttpc');
  assert.equal(cmds.length, 1);
  assert.ok(cmds[0].includes('versions add PORTAL_WEB_MAPBOX_PUBLIC_TOKEN'));
});

test('a local .env does NOT excuse a value the store is missing, and the refusal says so', () => {
  const store = fullStore();
  const { refusals } = resolveClientVars({
    fetchSecret: (name) => (name === 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN' ? null : store(name)),
    localEnv: { portal: { VITE_MAPBOX_PUBLIC_TOKEN: FAKE_TOKEN } },
    release: 'abc1234',
  });

  const token = refusals.find((r) => r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.ok(token);
  assert.equal(token.localAlso, true);
});

test('an optional variable warns by name instead of refusing', () => {
  // Driven through a synthetic declaration rather than a real one. Every
  // declared secret is required today, and the day one is not, this is the
  // behaviour it will get; a test that could only run while some real variable
  // happened to be optional would vanish the moment that changed.
  const vars = [
    {
      app: 'admin',
      variable: 'VITE_SOMETHING_OPTIONAL',
      secret: 'ADMIN_WEB_SOMETHING_OPTIONAL',
      kind: 'secret-manager',
      required: false,
      sensitive: false,
      why: 'a declaration whose absence is a warning',
    },
  ];
  const { refusals, warnings } = resolveClientVars({
    vars,
    fetchSecret: () => null,
    release: 'abc1234',
  });

  assert.equal(refusals.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].variable, 'VITE_SOMETHING_OPTIONAL');
});

test('neither Sentry DSN can stop a release, and the warning explains itself', () => {
  // Checked against the files on 2026-08-24, not inferred from the variables
  // existing: auntieos-admin/.env and mytribe/web/.env.local both carry an
  // EMPTY VITE_SENTRY_DSN and there is no other source. Web Sentry has never
  // been switched on for either app, and lib/sentry.ts treats a blank DSN as an
  // ordinary state. A release that refused over it would be blocking on a
  // capability the product does not use.
  for (const app of ['admin', 'portal']) {
    const decl = CLIENT_VARS.find((v) => v.app === app && v.variable === 'VITE_SENTRY_DSN');
    assert.equal(decl.required, false, `${app} VITE_SENTRY_DSN must not stop a release`);
    // The warning text is the whole user interface of an optional value. If it
    // does not say this is accepted, every release reads as half-configured.
    assert.match(decl.why, /never been (configured|set)|has never been/i);
  }

  const { refusals, warnings } = resolveClientVars({
    fetchSecret: (name) => (name.endsWith('_SENTRY_DSN') ? null : fullStore()(name)),
    release: 'abc1234',
  });
  assert.equal(refusals.length, 0, 'missing DSNs must not refuse');
  assert.deepEqual(
    warnings.map((w) => `${w.app}:${w.variable}`).sort(),
    ['admin:VITE_SENTRY_DSN', 'portal:VITE_SENTRY_DSN'],
  );
});

test('the admin App Check site key is REQUIRED, now that the key exists', () => {
  // It shipped warn-only for about an hour, while the reCAPTCHA Enterprise key
  // it names did not exist. The operator minted and registered it on
  // 2026-08-24, so the reason for the exception is gone and a release that
  // loses the key must stop rather than ship an admin whose App Check reads
  // `unconfigured`.
  const decl = CLIENT_VARS.find((v) => v.variable === 'VITE_ADMIN_APPCHECK_SITE_KEY');
  assert.equal(decl.required, true);
  assert.equal(decl.secret, 'ADMIN_WEB_APPCHECK_SITE_KEY');

  const store = fullStore();
  const { refusals } = resolveClientVars({
    fetchSecret: (name) => (name === 'ADMIN_WEB_APPCHECK_SITE_KEY' ? null : store(name)),
    release: 'abc1234',
  });
  assert.deepEqual(
    refusals.map((r) => r.variable),
    ['VITE_ADMIN_APPCHECK_SITE_KEY'],
  );
});

test('no declared secret is named after its BUILD variable', () => {
  // The operator first stored this value under `VITE_ADMIN_APPCHECK_SITE_KEY`,
  // which is the name of the build variable, not of the secret. Nothing would
  // ever have fetched it. The two namespaces are easy to blur in prose and the
  // cost is an operator creating a secret that is never read, so it is checked
  // rather than remembered.
  for (const v of CLIENT_VARS.filter((x) => x.kind === 'secret-manager')) {
    assert.ok(
      !v.secret.startsWith('VITE_'),
      `${v.secret} is a build variable name, not a Secret Manager name`,
    );
    assert.notEqual(v.secret, v.variable);
  }
});

test('with NO fetcher at all, a local .env carries the build', () => {
  const { rows, refusals } = resolveClientVars({
    fetchSecret: null,
    localEnv: {
      admin: { VITE_SENTRY_DSN: FAKE_DSN, VITE_ADMIN_APPCHECK_SITE_KEY: FAKE_SITE_KEY },
      portal: { VITE_SENTRY_DSN: FAKE_DSN, VITE_MAPBOX_PUBLIC_TOKEN: FAKE_TOKEN },
    },
    release: 'abc1234',
  });

  assert.equal(refusals.length, 0);
  for (const r of rows.filter((x) => x.kind === 'secret-manager' && x.required)) {
    assert.equal(r.source, 'local-file', `${r.variable} came from ${r.source}`);
  }
});

test('with no fetcher and no local value either, a required variable still refuses', () => {
  const { refusals } = resolveClientVars({ fetchSecret: null, localEnv: {}, release: 'abc1234' });
  const names = refusals.map((r) => `${r.app}:${r.variable}`).sort();
  assert.deepEqual(names, [
    'admin:VITE_ADMIN_APPCHECK_SITE_KEY',
    'portal:VITE_MAPBOX_PUBLIC_TOKEN',
  ]);
});

test('with no fetcher, an inherited process.env value outranks the local file', () => {
  const { rows } = resolveClientVars({
    fetchSecret: null,
    processEnv: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-ci' },
    localEnv: { portal: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-dotenv' } },
    release: 'abc1234',
  });
  const token = rows.find((r) => r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(token.source, 'process-env');
  assert.equal(token.value, 'pk.example-from-ci');
});

test('the store outranks a local .env when both have a value', () => {
  const { rows } = resolveClientVars({
    fetchSecret: fullStore({ PORTAL_WEB_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-the-store' }),
    localEnv: { portal: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-dotenv' } },
    release: 'abc1234',
  });
  const token = rows.find((r) => r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(token.source, 'secret-manager');
  assert.equal(token.value, 'pk.example-from-the-store');
});

test('the debug token is never fetched, never written, and never required', () => {
  const asked = [];
  const { rows, refusals } = resolveClientVars({
    fetchSecret: (name) => {
      asked.push(name);
      return fullStore()(name);
    },
    release: 'abc1234',
  });

  assert.ok(!asked.some((n) => n.includes('DEBUG')), `asked the store for ${asked.join(', ')}`);
  const debug = rows.find((r) => r.variable === 'VITE_APPCHECK_DEBUG_TOKEN');
  assert.equal(debug.kind, 'local-only');
  assert.equal(debug.sensitive, true);
  assert.equal(debug.status, 'skipped');
  assert.equal(refusals.length, 0);
  assert.ok(!renderEnvFile(rows.filter((r) => r.app === 'portal')).includes('DEBUG'));
});

test('the release commit is derived, never stored, and its absence refuses', () => {
  const withSha = resolveClientVars({ fetchSecret: fullStore(), release: 'abc1234' });
  const rel = withSha.rows.find((r) => r.variable === 'VITE_SENTRY_RELEASE');
  assert.equal(rel.source, 'derived');
  assert.equal(rel.value, 'abc1234');
  assert.ok(!declaredSecretNames().some((n) => n.includes('RELEASE')));

  const noSha = resolveClientVars({ fetchSecret: fullStore(), release: '' });
  assert.ok(noSha.refusals.some((r) => r.variable === 'VITE_SENTRY_RELEASE'));
});

test('the written file carries only what this script resolved, quoted', () => {
  const { rows } = resolveClientVars({
    fetchSecret: fullStore(),
    localEnv: { admin: { VITE_SOMETHING_LOCAL: 'x' } },
    release: 'abc1234',
  });
  const body = renderEnvFile(
    rows.filter((r) => r.app === 'admin'),
    { generatedFor: 'abc1234' },
  );

  assert.match(body, /^VITE_SENTRY_DSN='https:\/\/examplepublickey@o0/m);
  assert.match(body, /^VITE_SENTRY_RELEASE='abc1234'$/m);
  assert.match(body, /do not commit/);
  assert.ok(!body.includes('VITE_SOMETHING_LOCAL'));
});

test('a value that cannot be quoted refuses rather than writing a broken line', () => {
  const rows = [
    { app: 'admin', variable: 'VITE_X', secret: 'X', kind: 'secret-manager', source: 'secret-manager', status: 'ok', value: "a'b" },
  ];
  assert.throws(() => renderEnvFile(rows), /quote or a newline/);
});

// ---------------------------------------------------------------------------
// The declaration has to stay honest about what the apps actually read.
// ---------------------------------------------------------------------------

test('every VITE_ variable either app reads is declared here', () => {
  const declared = new Set(CLIENT_VARS.map((v) => v.variable));
  // Build-tooling flags, not build CONFIG: neither is a value anyone stores,
  // and both are set by the command that wants them (package.json's dev:record,
  // the e2e config), so they have no source to resolve from.
  const toolingFlags = new Set(['VITE_ISSUE_RECORDER', 'VITE_E2E_EMULATOR']);

  const missing = [];
  for (const [app, dir] of Object.entries(APP_DIRS)) {
    const src = path.join(ROOT, dir, 'src');
    for (const file of walk(src)) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\.(ts|tsx)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
        const name = m[1];
        if (toolingFlags.has(name) || declared.has(name)) continue;
        missing.push(`${app}: ${name} (${path.relative(ROOT, file)})`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these VITE_ variables are read but not declared in CLIENT_VARS:\n  ${missing.join('\n  ')}`,
  );
});

test('every fetchable variable is mirrored by a repo secret in the preview workflow', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/preview.yml'), 'utf8');
  for (const v of CLIENT_VARS.filter((x) => x.kind === 'secret-manager')) {
    assert.ok(
      wf.includes(`secrets.${v.secret}`),
      `preview.yml never reads secrets.${v.secret}, so a preview would build ${v.variable} empty`,
    );
  }
  // The one that must NEVER reach CI. Matched as an env BINDING rather than as
  // a substring: the workflow names it in a comment saying why it is absent, and
  // a test that forbade the explanation would read as forbidding the wrong thing.
  assert.equal(
    /^\s*VITE_APPCHECK_DEBUG_TOKEN\s*:/m.test(wf),
    false,
    'the App Check debug token bypasses attestation and must never be set in CI',
  );
});

test('the generated file is ignored by git in both apps', () => {
  for (const dir of Object.values(APP_DIRS)) {
    const rel = path.join(dir, PRODUCTION_ENV_FILE);
    const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
    assert.equal(r.status, 0, `${rel} is NOT gitignored; a release would offer to commit fetched values`);
  }
});

// ---------------------------------------------------------------------------
// Precedence, proved against Vite itself.
// ---------------------------------------------------------------------------

test("vite's own loader ranks .env.production.local over .env, and process.env over both", async (t) => {
  let loadEnv;
  try {
    ({ loadEnv } = await import('vite'));
  } catch {
    t.skip('vite is not installed in this tree (run npm ci)');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-secrets-'));
  fs.writeFileSync(path.join(dir, '.env'), "VITE_A='from-dot-env'\nVITE_B='from-dot-env'\n");
  fs.writeFileSync(path.join(dir, '.env.local'), "VITE_A='from-dot-env-local'\n");

  // 1. Only the developer's files: local development, with no gcloud anywhere.
  let env = loadEnv('production', dir, 'VITE_');
  assert.equal(env.VITE_A, 'from-dot-env-local');
  assert.equal(env.VITE_B, 'from-dot-env');

  // 2. What a release writes wins over both of them.
  fs.writeFileSync(
    path.join(dir, '.env.production.local'),
    "VITE_A='from-secret-manager'\nVITE_B='from-secret-manager'\n",
  );
  env = loadEnv('production', dir, 'VITE_');
  assert.equal(env.VITE_A, 'from-secret-manager');
  assert.equal(env.VITE_B, 'from-secret-manager');

  // 3. An explicit process.env value still outranks the file, which is how CI
  //    passes a repo secret into a preview build.
  process.env.VITE_B = 'from-process-env';
  try {
    env = loadEnv('production', dir, 'VITE_');
    assert.equal(env.VITE_B, 'from-process-env');
    assert.equal(env.VITE_A, 'from-secret-manager');
  } finally {
    delete process.env.VITE_B;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

