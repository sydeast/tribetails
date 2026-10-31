import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECRET_MANAGER_VENDORS, VENDOR_SECRETS } from './preflight.mjs';
import {
  accessSecret,
  emitGithub,
  emitShell,
  resolveSecrets,
  SECRET_MANAGER_ALLOWLIST,
  SECRET_MANAGER_PROJECT,
  shellQuote,
} from './secret-manager.mjs';

/**
 * The real-services run reads three vendors' production values from Secret
 * Manager (#1264, operator ruling 2026-10-31). What must hold: only the
 * allowlisted names are ever read, Stripe and Twilio never are, a value set in
 * the environment wins, every value is masked before anything else is written
 * in CI, and a failed read leaves the variable unset so the vendor skips.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(HERE, '..', '..');
const ROOT = join(ADMIN, '..');

const EXPECTED = {
  SMTP2GO_API_KEY: 'E2E_SMTP2GO_API_KEY',
  EMAIL_FROM: 'E2E_EMAIL_FROM',
  CLOUDINARY_CLOUD_NAME: 'E2E_CLOUDINARY_CLOUD_NAME',
  CLOUDINARY_API_KEY: 'E2E_CLOUDINARY_API_KEY',
  CLOUDINARY_API_SECRET: 'E2E_CLOUDINARY_API_SECRET',
  GOOGLE_OAUTH_CLIENT_ID: 'E2E_GOOGLE_OAUTH_CLIENT_ID',
  GOOGLE_OAUTH_CLIENT_SECRET: 'E2E_GOOGLE_OAUTH_CLIENT_SECRET',
};

/** A fake gcloud: answers `--version`, and each secret from [store]; records every call. */
function fakeGcloud(store, { missing = false } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (missing) {
      const err = new Error('spawnSync gcloud ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    if (args[0] === '--version') return 'Google Cloud SDK 500.0.0\n';
    const name = args.find((a) => a.startsWith('--secret='))?.slice('--secret='.length);
    if (!(name in store)) {
      const err = new Error('Command failed');
      err.stderr = `ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [${name}] not found or has no versions.\n`;
      throw err;
    }
    return store[name];
  };
  return { exec, calls, secretsRead: () => calls.filter((a) => a[0] === 'secrets').map((a) => a.find((x) => x.startsWith('--secret=')).slice(9)) };
}

/** Every secret in Secret Manager the run could ever be pointed at, Stripe and Twilio included. */
const PROD = {
  SMTP2GO_API_KEY: 'api-smtp',
  EMAIL_FROM: 'from-value',
  CLOUDINARY_CLOUD_NAME: 'cloud-name-value',
  CLOUDINARY_API_KEY: '1234',
  CLOUDINARY_API_SECRET: 'cl-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret',
  STRIPE_SECRET_KEY: 'sk_live_never',
  STRIPE_PUBLISHABLE_KEY: 'pk_live_never',
  TWILIO_ACCOUNT_SID: 'AC_live_never',
  TWILIO_AUTH_TOKEN: 'live-token-never',
  TWILIO_FROM_NUMBER: '+18055550100',
};

describe('the allowlist', () => {
  it('maps exactly the Cloudinary, smtp2go and Google OAuth secrets onto their E2E_* names', () => {
    const map = Object.fromEntries(SECRET_MANAGER_ALLOWLIST.map((r) => [r.secret, r.env]));
    expect(map).toEqual(EXPECTED);
    expect(SECRET_MANAGER_PROJECT).toBe('auntieos-ttpc');
  });

  it('is the preflight table for those vendors, so the two cannot drift', () => {
    expect([...SECRET_MANAGER_VENDORS].sort()).toEqual(['cloudinary', 'email', 'googleCalendar']);
    const fromTable = SECRET_MANAGER_VENDORS.flatMap((v) => VENDOR_SECRETS[v].map(({ secret, env }) => ({ secret, env })));
    expect(SECRET_MANAGER_ALLOWLIST.map((r) => ({ ...r }))).toEqual(fromTable);
  });

  it('names no Stripe or Twilio secret, and leaves the calendar id and refresh token to the environment', () => {
    for (const { secret, env } of SECRET_MANAGER_ALLOWLIST) {
      expect(secret).not.toMatch(/^(STRIPE_|TWILIO_)/);
      expect(env).not.toMatch(/(STRIPE|TWILIO)/);
      expect(env).not.toMatch(/CALENDAR_(ID|REFRESH_TOKEN)$/);
    }
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(SECRET_MANAGER_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(SECRET_MANAGER_VENDORS)).toBe(true);
  });
});

describe('accessSecret', () => {
  it('refuses every name off the allowlist before gcloud runs', () => {
    const g = fakeGcloud(PROD);
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM_NUMBER', 'TRIBE_PIN_PEPPER', 'SENTRY_DSN', '']) {
      expect(() => accessSecret(name, g.exec), name).toThrow(/not on the e2e-real Secret Manager allowlist/);
    }
    expect(g.calls).toEqual([]);
  });

  it('reads the latest version from auntieos-ttpc by explicit name and drops a trailing newline', () => {
    const g = fakeGcloud({ ...PROD, SMTP2GO_API_KEY: 'api-smtp\n' });
    expect(accessSecret('SMTP2GO_API_KEY', g.exec)).toBe('api-smtp');
    expect(g.calls).toEqual([
      ['secrets', 'versions', 'access', 'latest', '--secret=SMTP2GO_API_KEY', '--project=auntieos-ttpc', '--quiet'],
    ]);
  });
});

describe('resolveSecrets', () => {
  it('reads every allowlisted secret, and only those, when nothing is set', () => {
    const g = fakeGcloud(PROD);
    const { values } = resolveSecrets({ env: {}, exec: g.exec });
    expect(values).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([s, e]) => [e, PROD[s]])));
    expect(g.secretsRead().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('never reads a Stripe or Twilio secret, even with every Stripe and Twilio variable empty', () => {
    const g = fakeGcloud(PROD);
    const env = {
      STRIPE_TEST_SECRET_KEY: '',
      STRIPE_TEST_PUBLISHABLE_KEY: '',
      TWILIO_TEST_ACCOUNT_SID: '',
      TWILIO_TEST_AUTH_TOKEN: '',
      TWILIO_TEST_FROM_NUMBER: '',
    };
    const { values } = resolveSecrets({ env, exec: g.exec });
    for (const name of g.secretsRead()) expect(name).not.toMatch(/^(STRIPE_|TWILIO_)/);
    for (const key of Object.keys(values)) expect(key).not.toMatch(/(STRIPE|TWILIO)/);
    expect(Object.values(values)).not.toContain('sk_live_never');
  });

  it('lets a variable already set win, and does not read its secret', () => {
    const g = fakeGcloud(PROD);
    const env = { E2E_CLOUDINARY_API_KEY: 'override-key', E2E_EMAIL_FROM: 'override-from' };
    const { values, notes } = resolveSecrets({ env, exec: g.exec });
    expect(values.E2E_CLOUDINARY_API_KEY).toBe('override-key');
    expect(values.E2E_EMAIL_FROM).toBe('override-from');
    expect(g.secretsRead()).not.toContain('CLOUDINARY_API_KEY');
    expect(g.secretsRead()).not.toContain('EMAIL_FROM');
    expect(g.secretsRead()).toHaveLength(Object.keys(EXPECTED).length - 2);
    expect(notes).toContain('E2E_CLOUDINARY_API_KEY: set in the environment, CLOUDINARY_API_KEY not read');
  });

  it('starts no gcloud at all when every variable is already set', () => {
    const g = fakeGcloud(PROD);
    const env = Object.fromEntries(Object.values(EXPECTED).map((e) => [e, `set-${e}`]));
    expect(resolveSecrets({ env, exec: g.exec }).values).toEqual(env);
    expect(g.calls).toEqual([]);
  });

  it('treats an empty variable as unset, so it is read', () => {
    const g = fakeGcloud(PROD);
    const { values } = resolveSecrets({ env: { E2E_SMTP2GO_API_KEY: '' }, exec: g.exec });
    expect(values.E2E_SMTP2GO_API_KEY).toBe('api-smtp');
  });

  it('fails closed without gcloud: nothing set, the unset variables named, no throw', () => {
    const g = fakeGcloud(PROD, { missing: true });
    const { values, notes } = resolveSecrets({ env: {}, exec: g.exec });
    expect(values).toEqual({});
    expect(notes.join('\n')).toMatch(/gcloud is not available.*E2E_CLOUDINARY_API_SECRET/s);
    expect(g.calls.filter((a) => a[0] === 'secrets')).toEqual([]);
  });

  it('leaves a secret it cannot read, or that comes back empty or multi-line, unset; the rest still arrive', () => {
    const store = { ...PROD, CLOUDINARY_API_SECRET: '', GOOGLE_OAUTH_CLIENT_SECRET: 'a\nb' };
    delete store.SMTP2GO_API_KEY;
    const g = fakeGcloud(store);
    const { values, notes } = resolveSecrets({ env: {}, exec: g.exec });
    expect(values).not.toHaveProperty('E2E_SMTP2GO_API_KEY');
    expect(values).not.toHaveProperty('E2E_CLOUDINARY_API_SECRET');
    expect(values).not.toHaveProperty('E2E_GOOGLE_OAUTH_CLIENT_SECRET');
    expect(values.E2E_EMAIL_FROM).toBe('from-value');
    const text = notes.join('\n');
    expect(text).toMatch(/E2E_SMTP2GO_API_KEY: could not read SMTP2GO_API_KEY .*NOT_FOUND/);
    expect(text).toMatch(/E2E_CLOUDINARY_API_SECRET: CLOUDINARY_API_SECRET came back empty/);
    expect(text).toMatch(/E2E_GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE_OAUTH_CLIENT_SECRET holds a line break/);
    // A note names the secret, never its value.
    for (const v of Object.values(PROD)) if (v.length > 4) expect(text).not.toContain(v);
  });

  it('reads nothing under E2E_SECRET_MANAGER=off or done', () => {
    for (const mode of ['off', 'done', 'DONE']) {
      const g = fakeGcloud(PROD);
      const { values } = resolveSecrets({ env: { E2E_SECRET_MANAGER: mode, E2E_EMAIL_FROM: 'kept' }, exec: g.exec });
      expect(values).toEqual({ E2E_EMAIL_FROM: 'kept' });
      expect(g.calls).toEqual([]);
    }
  });
});

describe('emitGithub', () => {
  it('masks every value before it writes GITHUB_ENV or anything else', () => {
    const events = [];
    const values = { E2E_SMTP2GO_API_KEY: 'api-smtp', E2E_CLOUDINARY_API_SECRET: 'cl-secret' };
    emitGithub(values, {
      out: (s) => events.push(['out', s]),
      append: (file, s) => events.push(['append', file, s]),
      githubEnv: '/gh/env',
    });
    const masks = events.filter((e) => e[0] === 'out' && e[1].startsWith('::add-mask::'));
    expect(masks.map((e) => e[1])).toEqual(['::add-mask::api-smtp\n', '::add-mask::cl-secret\n']);
    const firstAppend = events.findIndex((e) => e[0] === 'append');
    const lastMask = events.lastIndexOf(masks[masks.length - 1]);
    expect(lastMask).toBeLessThan(firstAppend);
    // Nothing printed carries a value except its own mask command.
    for (const e of events.filter((x) => x[0] === 'out' && !x[1].startsWith('::add-mask::'))) {
      expect(e[1]).not.toMatch(/api-smtp|cl-secret/);
    }
    expect(events.filter((e) => e[0] === 'append')).toEqual([
      ['append', '/gh/env', 'E2E_SMTP2GO_API_KEY=api-smtp\nE2E_CLOUDINARY_API_SECRET=cl-secret\nE2E_SECRET_MANAGER=done\n'],
    ]);
  });

  it('still tells run.sh not to read again when nothing was read', () => {
    const appended = [];
    emitGithub({}, { out: () => {}, append: (_f, s) => appended.push(s), githubEnv: '/gh/env' });
    expect(appended).toEqual(['E2E_SECRET_MANAGER=done\n']);
  });
});

describe('emitShell', () => {
  it('prints export lines a shell evaluates back to the exact values', () => {
    const values = { E2E_EMAIL_FROM: `it's "quoted" $HOME \`x\``, E2E_CLOUDINARY_CLOUD_NAME: 'cloud' };
    let script = '';
    emitShell(values, { out: (s) => (script += s) });
    const r = spawnSync('bash', ['-c', `${script}\nprintf '%s\\n%s' "$E2E_EMAIL_FROM" "$E2E_CLOUDINARY_CLOUD_NAME"`], { encoding: 'utf8', env: {} });
    expect(r.stdout).toBe(`${values.E2E_EMAIL_FROM}\ncloud`);
  });

  it('quotes single quotes safely', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('the CLI', () => {
  /** A PATH holding only node and a fake gcloud, which logs each call. */
  function fakePath(answers) {
    const dir = mkdtempSync(join(tmpdir(), 'sm-cli-'));
    const log = join(dir, 'calls.log');
    const cases = Object.entries(answers)
      .map(([name, value]) => `    *--secret=${name}*) printf '%s' '${value}' ;;`)
      .join('\n');
    writeFileSync(
      join(dir, 'gcloud'),
      `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in\n  --version) echo sdk ;;\n${cases}\n    *) echo "NOT_FOUND" >&2; exit 1 ;;\nesac\n`,
    );
    chmodSync(join(dir, 'gcloud'), 0o755);
    return { dir, log };
  }
  const SCRIPT = join(HERE, 'secret-manager.mjs');

  it('--github masks, writes GITHUB_ENV and prints no value outside a mask', () => {
    const { dir, log } = fakePath({ EMAIL_FROM: 'from-value', CLOUDINARY_API_SECRET: 'cl-secret' });
    const ghEnv = join(dir, 'github_env');
    writeFileSync(ghEnv, '');
    const r = spawnSync(process.execPath, [SCRIPT, '--github'], {
      encoding: 'utf8',
      // The fake gcloud's directory and the system shell only: no real gcloud.
      env: { PATH: `${dir}:/usr/bin:/bin`, GITHUB_ENV: ghEnv },
    });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.slice(0, 2).sort()).toEqual(['::add-mask::cl-secret', '::add-mask::from-value']);
    expect(r.stdout.replace(/::add-mask::.*\n/g, '')).not.toMatch(/cl-secret|from-value/);
    expect(r.stderr).not.toMatch(/cl-secret|from-value/);
    const written = readFileSync(ghEnv, 'utf8');
    expect(written).toContain('E2E_EMAIL_FROM=from-value\n');
    expect(written).toContain('E2E_CLOUDINARY_API_SECRET=cl-secret\n');
    expect(written).toContain('E2E_SECRET_MANAGER=done\n');
    const read = readFileSync(log, 'utf8');
    expect(read).not.toMatch(/STRIPE|TWILIO/);
    expect(read).toMatch(/--project=auntieos-ttpc/);
  });

  it('--shell with no gcloud on PATH exits 0, prints nothing to evaluate, and says why', () => {
    // A PATH holding nothing at all, so no real gcloud can be found wherever
    // node is installed; node itself is started by absolute path.
    const empty = mkdtempSync(join(tmpdir(), 'sm-nopath-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--shell'], {
      encoding: 'utf8',
      env: { PATH: empty },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/gcloud is not available/);
  });
});

describe('the wiring', () => {
  it('both run.sh files read Secret Manager before the preflight, and evaluate rather than write the values', () => {
    for (const file of [join(ADMIN, 'scripts/e2e-real/run.sh'), join(ROOT, 'mytribe/web/scripts/e2e-real/run.sh')]) {
      const src = readFileSync(file, 'utf8');
      const read = src.indexOf('secret-manager.mjs" --shell');
      const pre = src.indexOf('scripts/e2e-real/preflight.mjs "');
      expect(read, file).toBeGreaterThan(0);
      expect(read, file).toBeLessThan(pre);
      expect(src).toMatch(/eval "\$sm_exports"/);
    }
  });

  it('the workflow reads, then drops the credentials, before each Cypress step, and stores no Secret Manager value as a job secret', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/e2e-real.yml'), 'utf8');
    const jobs = wf.split(/\n  (?=admin-real:|portal-real:)/).slice(1);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);
      const auth = job.indexOf('google-github-actions/auth@v3');
      const read = job.indexOf('secret-manager.mjs --github');
      const drop = job.indexOf('name: Drop Google credentials');
      const cypress = job.indexOf('name: Cypress, real services');
      expect(auth).toBeGreaterThan(0);
      expect(auth).toBeLessThan(read);
      expect(read).toBeLessThan(drop);
      expect(drop).toBeLessThan(cypress);
      // The job-level env holds only what stays in the e2e-real environment.
      const jobEnv = job.slice(job.indexOf('\n    env:\n'), job.indexOf('\n    steps:\n'));
      for (const { env } of SECRET_MANAGER_ALLOWLIST) expect(jobEnv).not.toContain(env);
      for (const kept of ['STRIPE_TEST_SECRET_KEY', 'TWILIO_TEST_ACCOUNT_SID', 'E2E_GOOGLE_CALENDAR_ID', 'E2E_GOOGLE_CALENDAR_REFRESH_TOKEN']) {
        expect(jobEnv).toContain(kept);
      }
    }
  });
});
