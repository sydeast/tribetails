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
  DEFAULT_GCLOUD_TIMEOUT_MS,
  PRODUCTION_ENV_FILE,
  ROOT,
  SECRET_UNREADABLE,
  classifyAccessFailure,
  classifyListResult,
  isUnreadableValue,
  declaredSecretNames,
  fixCommands,
  isGcloudTimeout,
  listSecretsWithGcloud,
  makeGcloudFetcher,
  refuseUnconfirmedLocalValues,
  renderEnvFile,
  resolveClientVars,
  splitRefusals,
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
    ADMIN_WEB_MAPBOX_PUBLIC_TOKEN: FAKE_TOKEN,
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
  // Same shape for the Mapbox public token since #760, and here the VALUES may
  // legitimately be one token. The names still have to be two: a token gets
  // rotated or re-restricted per site, and one shared name would mean rotating
  // the admin's map by editing the portal's secret.
  const tokens = rows.filter((r) => r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(tokens.length, 2);
  assert.deepEqual(
    tokens.map((r) => r.secret).sort(),
    ['ADMIN_WEB_MAPBOX_PUBLIC_TOKEN', 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN'],
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

  const token = refusals.find((r) => r.app === 'portal' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
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

  const token = refusals.find((r) => r.app === 'portal' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
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
      admin: {
        VITE_SENTRY_DSN: FAKE_DSN,
        VITE_ADMIN_APPCHECK_SITE_KEY: FAKE_SITE_KEY,
        VITE_MAPBOX_PUBLIC_TOKEN: FAKE_TOKEN,
      },
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
    'admin:VITE_MAPBOX_PUBLIC_TOKEN',
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
  const token = rows.find((r) => r.app === 'portal' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(token.source, 'process-env');
  assert.equal(token.value, 'pk.example-from-ci');
  // One process.env name, two apps reading it: an exported override reaches
  // BOTH, which is what a CI job passing one repo secret to one build already
  // relies on and is why each app still gets its own .env.production.local.
  const adminToken = rows.find((r) => r.app === 'admin' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(adminToken.source, 'process-env');
});

test('the store outranks a local .env when both have a value', () => {
  const { rows } = resolveClientVars({
    fetchSecret: fullStore({ PORTAL_WEB_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-the-store' }),
    localEnv: { portal: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.example-from-dotenv' } },
    release: 'abc1234',
  });
  // BY APP, not by variable name: both apps declare VITE_MAPBOX_PUBLIC_TOKEN
  // since #760 and only the portal's secret was overridden here, so a bare
  // find() would have asserted against whichever row happened to be declared
  // first.
  const token = rows.find((r) => r.app === 'portal' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
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
// #839: every gcloud spawn carries a timeout, a timeout is never mistaken for
// an ordinary failure, and a timed-out ACCESS refuses without ever advising
// `gcloud secrets create` on a secret that may already exist. A FAKE `spawn`
// stands in for spawnSync throughout, so none of this waits out a real 30s.
// ---------------------------------------------------------------------------

/** What a spawnSync result looks like when Node's own `timeout` option fired
 * and killed the child with `killSignal`. */
function timeoutResult() {
  return {
    status: null,
    signal: 'SIGKILL',
    error: Object.assign(new Error('spawnSync gcloud ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    stdout: '',
    stderr: '',
  };
}

test('isGcloudTimeout recognizes both shapes a timed-out spawnSync can take, and no ordinary failure', () => {
  assert.equal(isGcloudTimeout(timeoutResult()), true);
  // A fake spawn in a test may set the signal without the ETIMEDOUT error
  // object; that has to count too, or a test double becomes unable to assert
  // the timeout path.
  assert.equal(isGcloudTimeout({ status: null, signal: 'SIGTERM' }), true);
  assert.equal(isGcloudTimeout({ status: 1, signal: null, error: undefined }), false);
  assert.equal(isGcloudTimeout({ status: 0 }), false);
  // An OOM kill (or anything else that kills the child and populates `error`
  // with a code other than ETIMEDOUT) must not be reported as a timeout just
  // because a signal happens to be present too.
  assert.equal(
    isGcloudTimeout({
      status: null,
      signal: 'SIGKILL',
      error: Object.assign(new Error('spawnSync gcloud ENOMEM'), { code: 'ENOMEM' }),
    }),
    false,
    'an error present with a non-ETIMEDOUT code must never be reported as a timeout',
  );
});

test('listSecretsWithGcloud passes the timeout and kill signal to spawnSync, and a LIST timeout returns SECRET_UNREADABLE, not null', () => {
  const calls = [];
  const logs = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return timeoutResult();
  };

  const result = listSecretsWithGcloud('auntieos-ttpc', { spawn, timeoutMs: 5, log: (l) => logs.push(l) });

  // A timed-out LIST is NOT the same claim as "no gcloud, no credentials":
  // collapsing both into `null` is what made a LIST timeout fall back to a
  // local .env and get reported as plain 'missing' (#852 review).
  assert.equal(result, SECRET_UNREADABLE);
  assert.notEqual(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gcloud');
  assert.equal(calls[0].opts.timeout, 5);
  assert.equal(calls[0].opts.killSignal, 'SIGKILL');
  assert.ok(logs.some((l) => l.includes('listing secrets')), 'no progress line before the call');
  assert.ok(logs.some((l) => l.includes('timed out after 5ms')));
  assert.ok(logs.some((l) => l.includes('curl -4')));
  assert.ok(logs.some((l) => l.includes('curl -6')));
});

test('the gcloud timeout defaults to DEFAULT_GCLOUD_TIMEOUT_MS and CLIENT_SECRETS_GCLOUD_TIMEOUT_MS overrides it with a valid value', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push(opts);
    return { status: 0, stdout: 'SOME_SECRET\n' };
  };

  listSecretsWithGcloud('auntieos-ttpc', { spawn, log: () => {} });
  assert.equal(calls[0].timeout, DEFAULT_GCLOUD_TIMEOUT_MS);

  process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS = '5000';
  try {
    listSecretsWithGcloud('auntieos-ttpc', { spawn, log: () => {} });
    assert.equal(calls[1].timeout, 5000, 'the env override never reached spawnSync');
  } finally {
    delete process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS;
  }
});

test('the env override rejects a non-integer, zero or a negative value, and falls back to the default', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push(opts.timeout);
    return { status: 0, stdout: 'X\n' };
  };

  for (const bad of ['1500.5', '0', '-100', 'garbage']) {
    process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS = bad;
    try {
      listSecretsWithGcloud('auntieos-ttpc', { spawn, log: () => {} });
    } finally {
      delete process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS;
    }
  }

  assert.ok(
    calls.every((t) => t === DEFAULT_GCLOUD_TIMEOUT_MS),
    `a fractional, zero, negative or garbage override reached spawnSync: ${calls.join(', ')}`,
  );
});

test('makeGcloudFetcher prints one progress line per secret as it is fetched, on stderr, before the call resolves', () => {
  const logs = [];
  const spawn = () => ({ status: 0, stdout: 'a-value\n' });
  const fetcher = makeGcloudFetcher('auntieos-ttpc', ['SECRET_A'], {
    spawn,
    timeoutMs: 5,
    log: (l) => logs.push(l),
  });

  assert.equal(fetcher('SECRET_A'), 'a-value\n');
  assert.ok(
    logs.some((l) => l.includes('fetching SECRET_A')),
    'the step stayed silent while fetching a secret, which is the defect #839 is about',
  );
});

test('after the first ACCESS timeout, later secrets are marked unreadable without spawning gcloud again', () => {
  const calls = [];
  const spawn = () => {
    calls.push(1);
    return timeoutResult();
  };
  const logs = [];
  const fetcher = makeGcloudFetcher('auntieos-ttpc', ['SECRET_A', 'SECRET_B', 'SECRET_C'], {
    spawn,
    timeoutMs: 5,
    log: (l) => logs.push(l),
  });

  assert.equal(fetcher('SECRET_A'), SECRET_UNREADABLE);
  assert.equal(calls.length, 1, 'the first fetch should spawn gcloud exactly once');

  assert.equal(fetcher('SECRET_B'), SECRET_UNREADABLE);
  assert.equal(fetcher('SECRET_C'), SECRET_UNREADABLE);
  assert.equal(
    calls.length,
    1,
    'later secrets must not spawn gcloud again after a timeout: the worst case must be one timeout, not one per secret',
  );
  assert.ok(logs.some((l) => l.includes('skipping SECRET_B')));
  assert.ok(logs.some((l) => l.includes('skipping SECRET_C')));
});

test('makeGcloudFetcher passes the timeout and kill signal to spawnSync, and a timed-out ACCESS is unreadable, not missing', () => {
  const calls = [];
  const logs = [];
  const spawn = (cmd, args, opts) => {
    calls.push(opts);
    return timeoutResult();
  };
  const fetcher = makeGcloudFetcher('auntieos-ttpc', ['PORTAL_WEB_MAPBOX_PUBLIC_TOKEN'], {
    spawn,
    timeoutMs: 7,
    log: (l) => logs.push(l),
  });

  const result = fetcher('PORTAL_WEB_MAPBOX_PUBLIC_TOKEN');

  assert.equal(result, SECRET_UNREADABLE, 'a timed-out ACCESS must not resolve to null (= "does not exist")');
  assert.equal(calls[0].timeout, 7);
  assert.equal(calls[0].killSignal, 'SIGKILL');
  assert.ok(logs.some((l) => l.includes('fetching PORTAL_WEB_MAPBOX_PUBLIC_TOKEN')));
  assert.ok(logs.some((l) => l.includes('timed out after 7ms')));
  assert.ok(
    logs.some((l) => l.includes('does not mean PORTAL_WEB_MAPBOX_PUBLIC_TOKEN is missing')),
    'the secret name has to be in the message, or an operator cannot tell which one stalled',
  );
  assert.ok(logs.some((l) => l.includes('curl -4')));
  assert.ok(logs.some((l) => l.includes('curl -6')));
});

test('an ACCESS failure for a LISTED secret is unreadable with a reason, never null; a name the LIST lacks is still null', () => {
  // This used to assert null for the listed secret, which printed `gcloud
  // secrets create` for a secret the store had just named (#850).
  const spawn = () => ({ status: 1, error: undefined, signal: null, stdout: '', stderr: 'ERROR: something odd' });

  const fetcher = makeGcloudFetcher('auntieos-ttpc', ['SECRET_A'], { spawn, timeoutMs: 5, log: () => {} });
  const v = fetcher('SECRET_A');
  assert.notEqual(v, null);
  assert.ok(isUnreadableValue(v));
  assert.equal(v.reason, 'access-failed');
  // Not on the list: the store answered that it does not exist, and create
  // advice is right for that one.
  assert.equal(fetcher('NOT_LISTED'), null);

  const listResult = listSecretsWithGcloud('auntieos-ttpc', { spawn, timeoutMs: 5, log: () => {} });
  assert.equal(listResult, null);
});

// Real gcloud stderr, captured 2026-09-14, with the account email replaced.
// DISABLED_STDERR is NOT captured: producing it needs a store change.
const PERMISSION_DENIED_STDERR =
  "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied on resource (or it may not exist). Remediate access with this Troubleshooter URL or share it with your administrator - https://console.cloud.google.com/iam-admin/troubleshooter/summary;errorId=X . This command is authenticated as someone@example.com which is the active account specified by the [core/account] property.\n- '@type': type.googleapis.com/google.rpc.ErrorInfo\n  reason: IAM_PERMISSION_DENIED\n";
const NOT_FOUND_STDERR =
  'ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/153396971788/secrets/X] not found or has no versions. This command is authenticated as someone@example.com which is the active account specified by the [core/account] property.\n';
const DISABLED_STDERR =
  'ERROR: (gcloud.secrets.versions.access) FAILED_PRECONDITION: Secret Version [projects/153396971788/secrets/X/versions/3] is in DISABLED state.\n';

test('classifyAccessFailure reads permission denied, no enabled version and not found from gcloud stderr, without the account email', () => {
  const perm = classifyAccessFailure({ status: 1, stderr: PERMISSION_DENIED_STDERR });
  assert.equal(perm.reason, 'permission-denied');
  assert.match(perm.detail, /PERMISSION_DENIED/);
  assert.ok(!perm.detail.includes('someone@example.com'), perm.detail);
  assert.ok(!perm.detail.includes('troubleshooter'), perm.detail);

  const gone = classifyAccessFailure({ status: 1, stderr: NOT_FOUND_STDERR });
  assert.equal(gone.reason, 'not-found');
  assert.ok(!gone.detail.includes('someone@example.com'), gone.detail);

  assert.equal(classifyAccessFailure({ status: 1, stderr: DISABLED_STDERR }).reason, 'no-enabled-version');
  assert.equal(
    classifyAccessFailure({ status: 1, stderr: 'ERROR: FAILED_PRECONDITION: Secret Version [x] is in DESTROYED state.' }).reason,
    'no-enabled-version',
  );
  assert.equal(classifyAccessFailure({ status: 1, stderr: 'ERROR: something new' }).reason, 'access-failed');
});

test('each ACCESS failure shape: a REQUIRED value refuses and an OPTIONAL one warns, with advice that fits and never create', () => {
  const shapes = {
    'permission-denied': PERMISSION_DENIED_STDERR,
    'no-enabled-version': DISABLED_STDERR,
    'not-found': NOT_FOUND_STDERR,
  };
  for (const [reason, stderr] of Object.entries(shapes)) {
    const listed = declaredSecretNames();
    const fetcher = makeGcloudFetcher('auntieos-ttpc', listed, {
      spawn: () => ({ status: 1, stdout: '', stderr }),
      timeoutMs: 5,
      log: () => {},
    });
    const { rows, refusals, warnings } = resolveClientVars({ fetchSecret: fetcher, release: 'abc1234' });
    const sm = rows.filter((r) => r.kind === 'secret-manager');
    assert.ok(sm.every((r) => r.status === 'unreadable' && r.reason === reason), `${reason}: not every row unreadable`);
    assert.deepEqual(
      refusals.map((r) => r.variable).sort(),
      sm.filter((r) => r.required).map((r) => r.variable).sort(),
    );
    assert.deepEqual(
      warnings.map((r) => r.variable).sort(),
      sm.filter((r) => !r.required).map((r) => r.variable).sort(),
    );

    for (const r of [...refusals, ...warnings]) {
      const cmds = fixCommands(r, 'auntieos-ttpc').join('\n');
      assert.ok(!cmds.includes('gcloud secrets create'), `${reason}: create advice for listed ${r.secret}`);
      if (reason === 'permission-denied') {
        assert.ok(cmds.includes(`gcloud secrets get-iam-policy ${r.secret} --project auntieos-ttpc`), cmds);
        assert.ok(cmds.includes('roles/secretmanager.secretAccessor'), cmds);
      } else if (reason === 'no-enabled-version') {
        assert.ok(cmds.includes(`gcloud secrets versions list ${r.secret} --project auntieos-ttpc`), cmds);
        assert.ok(cmds.includes(`secrets versions add ${r.secret}`), cmds);
      } else {
        assert.ok(cmds.includes(`gcloud secrets versions list ${r.secret} --project auntieos-ttpc`), cmds);
      }
    }
  }
});

test('CLI: listed secrets whose ACCESS fails refuse with exit 4, per-secret advice, no create, no account email', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-secrets-access-'));
  for (const [name, text] of [
    ['perm', PERMISSION_DENIED_STDERR],
    ['gone', NOT_FOUND_STDERR],
    ['disabled', DISABLED_STDERR],
  ]) {
    fs.writeFileSync(path.join(dir, `${name}.txt`), text);
  }
  const fakeGcloud = path.join(dir, 'gcloud');
  fs.writeFileSync(
    fakeGcloud,
    [
      '#!/bin/sh',
      `D='${dir}'`,
      'case "$1 $2 $3" in',
      '  "secrets list --project")',
      "    printf '%s\\n' ADMIN_WEB_APPCHECK_SITE_KEY ADMIN_WEB_MAPBOX_PUBLIC_TOKEN PORTAL_WEB_MAPBOX_PUBLIC_TOKEN ADMIN_WEB_SENTRY_DSN PORTAL_WEB_SENTRY_DSN",
      '    exit 0',
      '    ;;',
      '  "secrets versions access")',
      '    name=""',
      '    for a in "$@"; do case "$a" in --secret=*) name="${a#--secret=}" ;; esac; done',
      '    case "$name" in',
      '      ADMIN_WEB_APPCHECK_SITE_KEY|ADMIN_WEB_SENTRY_DSN) cat "$D/perm.txt" >&2; exit 1 ;;',
      '      ADMIN_WEB_MAPBOX_PUBLIC_TOKEN) cat "$D/disabled.txt" >&2; exit 1 ;;',
      '      PORTAL_WEB_MAPBOX_PUBLIC_TOKEN) cat "$D/gone.txt" >&2; exit 1 ;;',
      "      PORTAL_WEB_SENTRY_DSN) printf 'https://example@o0.ingest.us.sentry.io/1\\n'; exit 0 ;;",
      '    esac',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeGcloud, 0o755);

  let r;
  try {
    r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'client-secrets.mjs'), '--check', '--project', 'auntieos-ttpc', '--release', 'abc1234'],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;

  assert.equal(r.status, 4, `expected exit 4, got ${r.status}:\n${out}`);
  assert.ok(!/gcloud secrets create/.test(out), `create advice for a listed secret:\n${out}`);
  assert.ok(!/is missing/.test(out), `"is missing" for a listed secret:\n${out}`);
  assert.ok(!/has no value/.test(out), `the missing-value refusal appeared:\n${out}`);
  assert.ok(!out.includes('someone@example.com'), `the account email reached the output:\n${out}`);
  assert.match(out, /ADMIN_WEB_APPCHECK_SITE_KEY could not be read/);
  assert.match(out, /ADMIN_WEB_MAPBOX_PUBLIC_TOKEN could not be read/);
  assert.match(out, /PORTAL_WEB_MAPBOX_PUBLIC_TOKEN could not be read/);
  assert.match(out, /roles\/secretmanager\.secretAccessor/);
  assert.match(out, /gcloud secrets get-iam-policy ADMIN_WEB_APPCHECK_SITE_KEY --project auntieos-ttpc/);
  assert.match(out, /gcloud secrets versions list ADMIN_WEB_MAPBOX_PUBLIC_TOKEN --project auntieos-ttpc/);
  assert.match(out, /secrets versions add ADMIN_WEB_MAPBOX_PUBLIC_TOKEN/);
  assert.match(out, /gcloud secrets versions list PORTAL_WEB_MAPBOX_PUBLIC_TOKEN --project auntieos-ttpc/);
  // The optional admin DSN is refused its value too: it warns, it does not refuse.
  assert.match(out, /WARNING: VITE_SENTRY_DSN \(admin\) could not be read/);
  assert.match(out, /gcloud secrets get-iam-policy ADMIN_WEB_SENTRY_DSN/);
});

test('a timed-out ACCESS refuses the release, and the fix commands never suggest `gcloud secrets create`', () => {
  const store = fullStore();
  const { rows, refusals } = resolveClientVars({
    fetchSecret: (name) => (name === 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN' ? SECRET_UNREADABLE : store(name)),
    release: 'abc1234',
  });

  const row = rows.find((r) => r.app === 'portal' && r.variable === 'VITE_MAPBOX_PUBLIC_TOKEN');
  assert.equal(row.status, 'unreadable');
  assert.ok(refusals.includes(row), 'a secret Secret Manager never answered about must still refuse the release');

  const cmds = fixCommands(row, 'auntieos-ttpc');
  assert.ok(
    !cmds.some((c) => c.includes('gcloud secrets create') || c.includes('secrets versions add')),
    `advised creating or setting a secret that may already exist: ${cmds.join(' | ')}`,
  );
  assert.ok(cmds.some((c) => c.includes('curl -4')));
  assert.ok(cmds.some((c) => c.includes('curl -6')));
});

test('a timed-out ACCESS on an OPTIONAL variable WARNS, the same as the declaration already does for a confirmed-absent value', () => {
  // The declaration's "REQUIRED IS NOT THE DEFAULT" paragraph, and both
  // Sentry DSN rows above, argue that a value nothing depends on must not
  // stop a release. That reasoning
  // does not change just because gcloud stalled instead of answering "not
  // found": 'unreadable' follows the SAME required/optional split as
  // 'missing' and 'empty' (#852 review).
  const { rows, refusals, warnings } = resolveClientVars({
    fetchSecret: (name) => (name.endsWith('_SENTRY_DSN') ? SECRET_UNREADABLE : fullStore()(name)),
    release: 'abc1234',
  });

  const dsnRows = rows.filter((r) => r.variable === 'VITE_SENTRY_DSN');
  assert.equal(dsnRows.length, 2);
  assert.ok(dsnRows.every((r) => r.status === 'unreadable'));
  assert.equal(
    refusals.filter((r) => r.variable === 'VITE_SENTRY_DSN').length,
    0,
    'an OPTIONAL value nobody could check must not refuse the release',
  );
  assert.equal(warnings.filter((w) => w.variable === 'VITE_SENTRY_DSN').length, 2);

  // The warning's fix commands must be the network check, never a create/set
  // pair the operator has no way to know is correct advice.
  const dsnWarning = warnings.find((w) => w.variable === 'VITE_SENTRY_DSN');
  const cmds = fixCommands(dsnWarning, 'auntieos-ttpc');
  assert.ok(!cmds.some((c) => c.includes('gcloud secrets create')));
  assert.ok(cmds.some((c) => c.includes('curl -4')));
  assert.ok(cmds.some((c) => c.includes('curl -6')));
});

test('a REQUIRED value that is unreadable refuses; an OPTIONAL one warns, even when EVERY secret is unreadable (the shape a LIST timeout produces)', () => {
  const { rows, refusals, warnings } = resolveClientVars({
    fetchSecret: () => SECRET_UNREADABLE,
    release: 'abc1234',
  });

  const secretManagerRows = rows.filter((r) => r.kind === 'secret-manager');
  assert.ok(secretManagerRows.length > 0);
  assert.ok(
    secretManagerRows.every((r) => r.status === 'unreadable'),
    'every Secret Manager-backed row must be unreadable, never missing, when the store never answered',
  );

  const requiredNames = secretManagerRows.filter((r) => r.required).map((r) => r.variable).sort();
  const optionalNames = secretManagerRows.filter((r) => !r.required).map((r) => r.variable).sort();
  assert.deepEqual(refusals.map((r) => r.variable).sort(), requiredNames);
  assert.deepEqual(warnings.map((w) => w.variable).sort(), optionalNames);

  for (const r of refusals) {
    const cmds = fixCommands(r, 'auntieos-ttpc');
    assert.ok(
      !cmds.some((c) => c.includes('gcloud secrets create')),
      `${r.variable}: advised creating a secret that may already exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// End-to-end: the actual CLI, a real gcloud that sleeps on PATH, and a real
// (short) timeout. This is the exact reproduction that found the #852 review
// blocker: a LIST timeout used to return the same `null` as "no gcloud", fall
// back to a local .env, and refuse every value as 'missing' with `gcloud
// secrets create` advice for a store that may hold every one of them.
// ---------------------------------------------------------------------------

test('CLI: a LIST timeout refuses (exit 4), marks Secret Manager rows unreadable, and never advises `gcloud secrets create`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-secrets-cli-'));
  const fakeGcloud = path.join(dir, 'gcloud');
  fs.writeFileSync(fakeGcloud, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(fakeGcloud, 0o755);

  let r;
  try {
    r = spawnSync(
      process.execPath,
      // --release given, so the unrelated 'derived' VITE_SENTRY_RELEASE rows
      // resolve too: the only refusal left standing is the one this test is
      // about, and "has no value" cannot appear for a reason unrelated to
      // gcloud.
      [path.join(ROOT, 'scripts', 'client-secrets.mjs'), '--check', '--project', 'auntieos-ttpc', '--release', 'abc1234'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CLIENT_SECRETS_GCLOUD_TIMEOUT_MS: '200',
        },
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 4, `expected exit 4 (refused because unreadable), got ${r.status}:\n${out}`);
  assert.ok(
    !/gcloud secrets create/.test(out),
    `a LIST timeout must never advise creating a secret that may already exist:\n${out}`,
  );
  assert.ok(!/secrets versions add/.test(out), `a LIST timeout must never advise setting a secret:\n${out}`);
  assert.match(out, /unreadable/);
  assert.match(out, /curl -4/);
  assert.match(out, /curl -6/);
  // Not "has no value": that wording claims the store answered, and it did
  // not. The unreadable paragraph has its own wording.
  assert.match(out, /did not answer/);
  assert.ok(!/has no value/.test(out), `the missing-value refusal must not appear for an unreadable store:\n${out}`);
});

test('CLI: a genuinely MISSING secret and an UNREADABLE one print separate REFUSED blocks, get different advice, and exit 4', () => {
  // LIST answers and leaves ADMIN_WEB_MAPBOX_PUBLIC_TOKEN off the list (the
  // store answered: that one plainly does not exist). PORTAL_WEB_MAPBOX_
  // PUBLIC_TOKEN IS on the list, but its ACCESS call sleeps and times out.
  // One secret missing and one unreadable in the SAME run must not collapse
  // into one message or one kind of advice (#852 review, item 2).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-secrets-cli-mixed-'));
  const fakeGcloud = path.join(dir, 'gcloud');
  fs.writeFileSync(
    fakeGcloud,
    [
      '#!/bin/sh',
      'case "$1 $2 $3" in',
      '  "secrets list --project")',
      '    printf \'%s\\n\' ADMIN_WEB_APPCHECK_SITE_KEY PORTAL_WEB_MAPBOX_PUBLIC_TOKEN ADMIN_WEB_SENTRY_DSN PORTAL_WEB_SENTRY_DSN',
      '    exit 0',
      '    ;;',
      '  "secrets versions access")',
      '    name=""',
      '    for a in "$@"; do case "$a" in --secret=*) name="${a#--secret=}" ;; esac; done',
      '    case "$name" in',
      '      PORTAL_WEB_MAPBOX_PUBLIC_TOKEN) sleep 5 ;;',
      '      ADMIN_WEB_APPCHECK_SITE_KEY) printf \'fake-site-key\\n\'; exit 0 ;;',
      '      ADMIN_WEB_SENTRY_DSN) printf \'https://example@o0.ingest.us.sentry.io/0\\n\'; exit 0 ;;',
      '      PORTAL_WEB_SENTRY_DSN) printf \'https://example@o0.ingest.us.sentry.io/1\\n\'; exit 0 ;;',
      '      *) exit 1 ;;',
      '    esac',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeGcloud, 0o755);

  let r;
  try {
    r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'client-secrets.mjs'), '--check', '--project', 'auntieos-ttpc', '--release', 'abc1234'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          // A larger budget than the LIST-only test above: this run also
          // makes three FAST, real ACCESS spawns before the one that sleeps,
          // and a freshly spawned child process's first few spawns can be
          // slower than a warm process's, so 200ms cut it too close and this
          // test flaked on the fast calls, not the slow one.
          CLIENT_SECRETS_GCLOUD_TIMEOUT_MS: '1500',
        },
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 4, `expected exit 4 (at least one refusal is unreadable), got ${r.status}:\n${out}`);

  // Both REFUSED blocks have to print. One says "has no value" (the store
  // answered and does not have it); the other says the store never answered.
  assert.match(out, /REFUSED: the web apps declare client build config that has no value/);
  assert.match(out, /REFUSED: Secret Manager did not answer for these REQUIRED secrets in time/);
  assert.match(out, /VITE_MAPBOX_PUBLIC_TOKEN \(admin\).*ADMIN_WEB_MAPBOX_PUBLIC_TOKEN is missing/);
  assert.match(out, /VITE_MAPBOX_PUBLIC_TOKEN \(portal\).*PORTAL_WEB_MAPBOX_PUBLIC_TOKEN could not be read/);

  // The MISSING one gets create/set advice, by name.
  assert.match(out, /gcloud secrets create ADMIN_WEB_MAPBOX_PUBLIC_TOKEN/);
  assert.match(out, /secrets versions add ADMIN_WEB_MAPBOX_PUBLIC_TOKEN/);

  // The UNREADABLE one gets ONLY the curl checks, never create/set advice for
  // its own name: it may already exist and hold a good value.
  assert.ok(
    !out.includes('gcloud secrets create PORTAL_WEB_MAPBOX_PUBLIC_TOKEN'),
    `advised creating a secret Secret Manager never answered about:\n${out}`,
  );
  assert.ok(
    !out.includes('secrets versions add PORTAL_WEB_MAPBOX_PUBLIC_TOKEN'),
    `advised setting a secret Secret Manager never answered about:\n${out}`,
  );
  assert.match(out, /curl -4/);
  assert.match(out, /curl -6/);
});

// ---------------------------------------------------------------------------
// #850: no gcloud, no credentials, or an empty answer. The nightly preflight
// ran on a hosted runner with no Google credentials three nights running, and
// every required value printed `is missing` plus `gcloud secrets create` for
// secrets that all existed. Each shape below must refuse with exit 4, name the
// secret as unreadable, print the auth check, and never advise create or set.
// ---------------------------------------------------------------------------

test('classifyListResult tells no gcloud, no credentials, an empty answer and another failure apart', () => {
  assert.deepEqual(
    classifyListResult({ error: Object.assign(new Error('spawnSync gcloud ENOENT'), { code: 'ENOENT' }) }),
    { reason: 'no-gcloud', detail: '' },
  );
  const noAuth = classifyListResult({
    status: 1,
    stdout: '',
    stderr:
      'ERROR: (gcloud.secrets.list) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n',
  });
  assert.equal(noAuth.reason, 'not-authenticated');
  assert.match(noAuth.detail, /active account selected/);
  assert.equal(classifyListResult({ status: 0, stdout: '\n', stderr: '' }).reason, 'no-answer');
  const denied = classifyListResult({
    status: 1,
    stdout: '',
    stderr: 'ERROR: (gcloud.secrets.list) PERMISSION_DENIED: Permission denied on resource project x.\n',
  });
  assert.equal(denied.reason, 'gcloud-failed');
  assert.match(denied.detail, /PERMISSION_DENIED/);
  assert.deepEqual(classifyListResult({ status: 0, stdout: 'A\nB\n' }).names, ['A', 'B']);
  assert.equal(classifyListResult(timeoutResult()).reason, 'timeout');
});

test('listSecretsWithGcloud still returns null for a store it could not ask, and reports why', () => {
  const seen = [];
  const r = listSecretsWithGcloud('auntieos-ttpc', {
    spawn: () => ({ status: 1, stdout: '', stderr: 'ERROR: You do not currently have an active account selected.' }),
    log: () => {},
    onUnavailable: (s) => seen.push(s),
  });
  assert.equal(r, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'not-authenticated');
});

test('with no fetcher and nothing local, a Secret Manager value is UNREADABLE with the reason, and its advice is the auth check', () => {
  const { rows, refusals } = resolveClientVars({
    fetchSecret: null,
    localEnv: {},
    release: 'abc1234',
    storeReason: 'not-authenticated',
  });
  const smRows = rows.filter((r) => r.kind === 'secret-manager');
  assert.ok(smRows.every((r) => r.status === 'unreadable' && r.reason === 'not-authenticated'));
  assert.ok(refusals.length > 0);
  for (const r of refusals) {
    const cmds = fixCommands(r, 'auntieos-ttpc');
    assert.deepEqual(cmds, ['gcloud auth list', 'gcloud secrets list --project auntieos-ttpc --limit 1']);
  }
});

/**
 * Run the real CLI from a throwaway copy of the repo with NO .env files, so the
 * result does not depend on whether this machine has a developer's .env (the
 * operator's checkout does). node_modules is symlinked so `import('vite')`
 * resolves and the run is not the "blind" exit-3 path. `bin` is the ONLY
 * directory on PATH, so a gcloud installed on the machine running the test
 * cannot answer: GitHub's ubuntu image ships one at /usr/bin/gcloud. Nothing
 * else needs PATH. node is spawned by absolute path, the stubs are #!/bin/sh
 * (resolved by absolute path), and echo and exit are shell builtins.
 */
function runCliWithoutStore(gcloudScript, { mode = '--check', envFiles = {}, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-secrets-850-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'bin'));
    for (const d of Object.values(APP_DIRS)) fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const [rel, body] of Object.entries(envFiles)) fs.writeFileSync(path.join(dir, rel), body);
    fs.copyFileSync(path.join(ROOT, 'scripts', 'client-secrets.mjs'), path.join(dir, 'scripts', 'client-secrets.mjs'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    if (gcloudScript !== null) {
      fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), gcloudScript);
      fs.chmodSync(path.join(dir, 'bin', 'gcloud'), 0o755);
    }
    const env = { HOME: process.env.HOME || dir, PATH: path.join(dir, 'bin'), ...extraEnv };
    const r = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', 'client-secrets.mjs'), mode, '--project', 'auntieos-ttpc', '--release', 'abc1234'],
      { encoding: 'utf8', timeout: 60_000, env, cwd: dir },
    );
    const written = Object.fromEntries(
      Object.entries(APP_DIRS).map(([app, d]) => [app, fs.existsSync(path.join(dir, d, PRODUCTION_ENV_FILE))]),
    );
    return { status: r.status, stderr: r.stderr || '', out: `${r.stdout || ''}\n${r.stderr || ''}`, written };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertUnreadableNotMissing({ status, out }, why) {
  assert.equal(status, 4, `expected exit 4 (refused because unreadable), got ${status}:\n${out}`);
  assert.match(out, /REFUSED: Secret Manager could not be read for these REQUIRED secrets/);
  for (const secret of ['ADMIN_WEB_APPCHECK_SITE_KEY', 'ADMIN_WEB_MAPBOX_PUBLIC_TOKEN', 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN']) {
    assert.match(out, new RegExp(`${secret} could not be read`), `${secret} was not named as unreadable:\n${out}`);
    assert.ok(!out.includes(`gcloud secrets create ${secret}`), `advised creating ${secret}:\n${out}`);
    assert.ok(!out.includes(`secrets versions add ${secret}`), `advised setting ${secret}:\n${out}`);
  }
  assert.ok(!/is missing/.test(out), `an unasked store must never print "is missing":\n${out}`);
  assert.ok(!/has no value/.test(out), `the missing-value refusal must not appear:\n${out}`);
  assert.ok(!/gcloud secrets create/.test(out), `no create advice at all:\n${out}`);
  assert.match(out, /gcloud auth list/);
  assert.match(out, /gcloud secrets list --project auntieos-ttpc --limit 1/);
  assert.match(out, why);
}

test('CLI: NO gcloud on PATH refuses as unreadable (exit 4), says gcloud is not installed, and never advises create', () => {
  assertUnreadableNotMissing(runCliWithoutStore(null), /gcloud is not installed/);
});

test('CLI: gcloud with NO credentials refuses as unreadable (exit 4), quotes gcloud, and never advises create', () => {
  const script = [
    '#!/bin/sh',
    'echo "ERROR: (gcloud.secrets.list) You do not currently have an active account selected." >&2',
    'echo "Please run:" >&2',
    'echo "  \\$ gcloud auth login" >&2',
    'exit 1',
    '',
  ].join('\n');
  const res = runCliWithoutStore(script);
  assertUnreadableNotMissing(res, /no usable credentials/);
  assert.match(res.out, /active account selected/);
});

test('CLI: gcloud that exits 0 and lists NOTHING refuses as unreadable (exit 4), and never advises create', () => {
  assertUnreadableNotMissing(runCliWithoutStore('#!/bin/sh\nexit 0\n'), /listed no secrets at all/);
});

// ---------------------------------------------------------------------------
// #850 review: account emails, gRPC code matching, a mixed run, and --write.
// ---------------------------------------------------------------------------

// Two gcloud shapes that name the account outside the "authenticated as"
// phrase. example.com only.
const EXPIRED_CREDS_STDERR =
  'ERROR: (gcloud.secrets.list) Your current active account [person@example.com] does not have any valid credentials\nPlease run:\n\n  $ gcloud auth login\n';
const REFRESH_FAILED_STDERR =
  'ERROR: (gcloud.secrets.list) There was a problem refreshing auth tokens for account person@example.com: Reauthentication failed.\nPlease run:\n  $ gcloud auth login\n';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

test('the account email is redacted from gcloud detail in every shape, not only after "authenticated as"', () => {
  for (const stderr of [EXPIRED_CREDS_STDERR, REFRESH_FAILED_STDERR, PERMISSION_DENIED_STDERR, NOT_FOUND_STDERR]) {
    const list = classifyListResult({ status: 1, stdout: '', stderr });
    const access = classifyAccessFailure({ status: 1, stderr });
    assert.ok(!EMAIL_RE.test(list.detail), `LIST detail leaked an address: ${list.detail}`);
    assert.ok(!EMAIL_RE.test(access.detail), `ACCESS detail leaked an address: ${access.detail}`);
  }
  assert.equal(classifyListResult({ status: 1, stdout: '', stderr: EXPIRED_CREDS_STDERR }).reason, 'not-authenticated');
  assert.equal(classifyListResult({ status: 1, stdout: '', stderr: REFRESH_FAILED_STDERR }).reason, 'not-authenticated');
  assert.match(classifyListResult({ status: 1, stdout: '', stderr: EXPIRED_CREDS_STDERR }).detail, /<account>/);
});

/** A gcloud stub that prints `text` on stderr and fails, using only builtins. */
function failingGcloud(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  return ['#!/bin/sh', ...lines.map((l) => `printf '%s\\n' '${l}' >&2`), 'exit 1', ''].join('\n');
}

test('CLI: no email address reaches any Why: or WARNING line, for either account-naming gcloud shape', () => {
  for (const stderr of [EXPIRED_CREDS_STDERR, REFRESH_FAILED_STDERR]) {
    const { status, out } = runCliWithoutStore(failingGcloud(stderr));
    assert.equal(status, 4, out);
    const lines = out.split('\n').filter((l) => /Why:|WARNING|gcloud said|could not read Secret Manager/.test(l));
    assert.ok(lines.some((l) => /Why:/.test(l)), `no Why: line to check:\n${out}`);
    assert.ok(lines.some((l) => /WARNING/.test(l)), `no WARNING line to check:\n${out}`);
    for (const l of lines) assert.ok(!EMAIL_RE.test(l), `an address reached the output: ${l}`);
    assert.ok(!out.includes('person@example.com'), `the account email reached the output:\n${out}`);
  }
});

test('gRPC codes match only as uppercase whole words, so a code in a URL or prose is not a reason', () => {
  const reason = (stderr) => classifyAccessFailure({ status: 1, stderr }).reason;
  assert.equal(reason('ERROR: see https://cloud.google.com/secret-manager/docs/permission_denied for help'), 'access-failed');
  assert.equal(reason('ERROR: https://cloud.google.com/docs/not_found and failed_precondition notes'), 'access-failed');
  assert.equal(reason('ERROR: https://cloud.google.com/help/PERMISSION_DENIED_HELP'), 'access-failed');
  assert.equal(reason('ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: denied'), 'permission-denied');
  assert.equal(reason('ERROR: (gcloud.secrets.versions.access) NOT_FOUND: gone'), 'not-found');
});

// Folded in from the PR #885 review (r885/mixed.test.mjs): one secret MISSING
// from the LIST, one DENIED, one that HANGS. Three REFUSED blocks, each with
// its own advice, and each secret in exactly one of them.
test('CLI mixed: missing + permission denied + timeout exit 4 with three blocks and the right advice in each', () => {
  const perm =
    "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied on resource (or it may not exist). This command is authenticated as reviewer@example.com which is the active account specified by the [core/account] property.";
  const stub = [
    '#!/bin/sh',
    'case "$1 $2 $3" in',
    '  "secrets list --project")',
    "    printf '%s\\n' ADMIN_WEB_MAPBOX_PUBLIC_TOKEN PORTAL_WEB_MAPBOX_PUBLIC_TOKEN ADMIN_WEB_SENTRY_DSN PORTAL_WEB_SENTRY_DSN; exit 0 ;;",
    '  "secrets versions access")',
    '    name=""',
    '    for a in "$@"; do case "$a" in --secret=*) name="${a#--secret=}" ;; esac; done',
    '    case "$name" in',
    `      ADMIN_WEB_MAPBOX_PUBLIC_TOKEN) printf "%s\\n" "${perm}" >&2; exit 1 ;;`,
    '      PORTAL_WEB_MAPBOX_PUBLIC_TOKEN) exec /bin/sleep 20 ;;',
    "      *) printf 'https://k@o0.ingest.us.sentry.io/1\\n'; exit 0 ;;",
    '    esac ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n');
  const { status, stderr, out } = runCliWithoutStore(stub, { extraEnv: { CLIENT_SECRETS_GCLOUD_TIMEOUT_MS: '1500' } });
  assert.equal(status, 4, out);

  // A: missing, create advice for A only.
  assert.match(out, /REFUSED: the web apps declare client build config that has no value:/);
  assert.match(out, /ADMIN_WEB_APPCHECK_SITE_KEY is missing/);
  assert.match(out, /gcloud secrets create ADMIN_WEB_APPCHECK_SITE_KEY --project auntieos-ttpc/);
  assert.ok(!/gcloud secrets create ADMIN_WEB_MAPBOX_PUBLIC_TOKEN/.test(out), 'create advice for the denied secret');
  assert.ok(!/gcloud secrets create PORTAL_WEB_MAPBOX_PUBLIC_TOKEN/.test(out), 'create advice for the hung secret');

  // B: the per-secret permission block.
  assert.match(
    out,
    /REFUSED: Secret Manager could not be read for these REQUIRED secrets:\n\s+VITE_MAPBOX_PUBLIC_TOKEN \(admin\) <- ADMIN_WEB_MAPBOX_PUBLIC_TOKEN could not be read/,
  );
  assert.match(out, /gcloud secrets get-iam-policy ADMIN_WEB_MAPBOX_PUBLIC_TOKEN --project auntieos-ttpc/);
  assert.ok(!out.includes('reviewer@example.com'), 'email leaked');

  // C: the timeout block with the curl checks.
  assert.match(
    out,
    /REFUSED: Secret Manager did not answer for these REQUIRED secrets in time:\n\s+VITE_MAPBOX_PUBLIC_TOKEN \(portal\) <- PORTAL_WEB_MAPBOX_PUBLIC_TOKEN could not be read/,
  );
  assert.match(out, /curl -4 -sS/);
  assert.match(out, /curl -6 -sS/);

  const blocks = stderr.split(/\nREFUSED: /).slice(1);
  assert.equal(blocks.length, 3, `expected 3 REFUSED blocks, got ${blocks.length}:\n${out}`);
});

const NO_ACCOUNT_GCLOUD = failingGcloud(
  'ERROR: (gcloud.secrets.list) You do not currently have an active account selected.\nPlease run:\n  $ gcloud auth login\n',
);
const LAPTOP_ENV = {
  [path.join(APP_DIRS.admin, '.env')]:
    'VITE_ADMIN_APPCHECK_SITE_KEY=laptop-appcheck\nVITE_MAPBOX_PUBLIC_TOKEN=pk.laptop-admin\nVITE_SENTRY_DSN=https://laptop@o0.ingest.us.sentry.io/0\n',
  [path.join(APP_DIRS.portal, '.env')]: 'VITE_MAPBOX_PUBLIC_TOKEN=pk.laptop-portal\n',
};

test('CLI --write: a signed-out store with the values in a local .env refuses (exit 4), writes nothing, and names the skip', () => {
  const { status, out, written } = runCliWithoutStore(NO_ACCOUNT_GCLOUD, { mode: '--write', envFiles: LAPTOP_ENV });
  assert.equal(status, 4, `--write must not ship values the store never confirmed:\n${out}`);
  assert.match(out, /REFUSED: Secret Manager could not confirm these REQUIRED values/);
  for (const secret of ['ADMIN_WEB_APPCHECK_SITE_KEY', 'ADMIN_WEB_MAPBOX_PUBLIC_TOKEN', 'PORTAL_WEB_MAPBOX_PUBLIC_TOKEN']) {
    assert.match(out, new RegExp(`${secret} could not be read \\(a local \\.env has a value\\)`), out);
  }
  assert.match(out, /RELEASE_SKIP_CLIENT_SECRETS=1/);
  assert.match(out, /gcloud auth list/);
  assert.ok(!/gcloud secrets create/.test(out), out);
  assert.ok(!/is missing/.test(out), out);
  assert.ok(!/wrote /.test(out), `a file was written:\n${out}`);
  assert.deepEqual(written, { admin: false, portal: false });
  // The optional DSN held locally warns, and says a local value exists.
  assert.match(out, /WARNING: VITE_SENTRY_DSN \(admin\) could not be read from Secret Manager\. A local \.env has a value for it/);
  assert.ok(!out.includes('pk.laptop'), `a local value was printed:\n${out}`);
});

test('CLI --check: the same signed-out store with the values in a local .env still falls back to .env and exits 0', () => {
  const { status, out, written } = runCliWithoutStore(NO_ACCOUNT_GCLOUD, { mode: '--check', envFiles: LAPTOP_ENV });
  assert.equal(status, 0, `--check keeps the local .env fallback:\n${out}`);
  assert.match(out, /VITE_ADMIN_APPCHECK_SITE_KEY\s+local-file\s+ok/);
  assert.ok(!/REFUSED/.test(out), out);
  assert.deepEqual(written, { admin: false, portal: false });
});

test('refuseUnconfirmedLocalValues marks only local-file Secret Manager rows, and leaves process.env and derived rows alone', () => {
  const { rows } = resolveClientVars({
    fetchSecret: null,
    processEnv: { VITE_ADMIN_APPCHECK_SITE_KEY: 'from-ci' },
    localEnv: { admin: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.local' }, portal: { VITE_MAPBOX_PUBLIC_TOKEN: 'pk.local' } },
    release: 'abc1234',
    storeReason: 'not-authenticated',
  });
  refuseUnconfirmedLocalValues(rows, 'not-authenticated');
  const find = (app, v) => rows.find((r) => r.app === app && r.variable === v);
  assert.equal(find('admin', 'VITE_ADMIN_APPCHECK_SITE_KEY').status, 'ok');
  assert.equal(find('admin', 'VITE_ADMIN_APPCHECK_SITE_KEY').source, 'process-env');
  assert.equal(find('admin', 'VITE_MAPBOX_PUBLIC_TOKEN').status, 'unreadable');
  assert.equal(find('admin', 'VITE_MAPBOX_PUBLIC_TOKEN').localUnconfirmed, true);
  assert.equal(find('admin', 'VITE_MAPBOX_PUBLIC_TOKEN').value, '');
  assert.equal(find('admin', 'VITE_SENTRY_RELEASE').status, 'ok');
  const { refusals } = splitRefusals(rows);
  assert.deepEqual(refusals.map((r) => `${r.app}:${r.variable}`).sort(), ['admin:VITE_MAPBOX_PUBLIC_TOKEN', 'portal:VITE_MAPBOX_PUBLIC_TOKEN']);
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

