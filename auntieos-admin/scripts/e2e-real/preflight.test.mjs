import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  declaredSecrets,
  disconnectRisks,
  functionsEntry,
  isForbiddenNumber,
  MARKER,
  plan,
  render,
  secretsFileFor,
} from './preflight.mjs';

/**
 * The refusals are the safety property of the real-services run (#1089): if
 * one of these stops refusing, a run can hand a live Stripe key, a real phone
 * line or the production Google grant to a test. Every phone number below is
 * from the 555-0100..0199 block, which is reserved for fiction; only the AREA
 * CODE is what the guard reads.
 */

const DECLARED = ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'TWILIO_FROM_NUMBER', 'TRIBE_PIN_PEPPER'];

describe('isForbiddenNumber', () => {
  it('refuses the two area codes in every common spelling', () => {
    for (const n of ['+18055550100', '18055550100', '8055550100', '(805) 555-0100', '+1 989 555 0199', '989.555.0199']) {
      expect(isForbiddenNumber(n), n).toBe(true);
    }
  });

  it('lets the Twilio test sender and other area codes through', () => {
    for (const n of ['+15005550006', '+15125550100', '', 'AC_e2e_not_configured']) {
      expect(isForbiddenNumber(n), n).toBe(false);
    }
  });
});

describe('plan', () => {
  it('writes every declared secret with a non-empty value when nothing is provided', () => {
    const { values, refusals, available } = plan(DECLARED, {});
    expect(refusals).toEqual([]);
    for (const name of DECLARED) expect(values[name], name).toMatch(/.+/);
    // A placeholder Stripe key is still test-shaped, so the guard holds for the file as a whole.
    expect(values.STRIPE_SECRET_KEY).toMatch(/^sk_test_/);
    expect(available.stripe).toBe(false);
  });

  it('uses provided test keys and reports the vendor as configured', () => {
    const { values, refusals, available } = plan(DECLARED, {
      STRIPE_TEST_SECRET_KEY: 'sk_test_abc',
      STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_abc',
    });
    expect(refusals).toEqual([]);
    expect(values.STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(available.stripe).toBe(true);
  });

  it('refuses a live Stripe key, whichever variable it arrives in', () => {
    expect(plan(DECLARED, { STRIPE_TEST_SECRET_KEY: 'sk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_SECRET_KEY: not a Stripe test-mode value/,
    );
    expect(plan(DECLARED, { STRIPE_TEST_PUBLISHABLE_KEY: 'pk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_PUBLISHABLE_KEY/,
    );
    // Set in the shell but bound to nothing: still about to be inherited by the emulator.
    expect(plan(DECLARED, { STRIPE_SECRET_KEY: 'sk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_SECRET_KEY \(environment\)/,
    );
  });

  it('refuses a Twilio sender in a forbidden area code', () => {
    const { refusals } = plan(DECLARED, { TWILIO_TEST_FROM_NUMBER: '+18055550100' });
    expect(refusals.join('\n')).toMatch(/TWILIO_FROM_NUMBER: names a phone number in a forbidden area code/);
  });

  it('refuses a value with a line break, which would smuggle a second key into the file', () => {
    const { refusals } = plan(DECLARED, { STRIPE_TEST_SECRET_KEY: 'sk_test_a\nSENTRY_DSN=x' });
    expect(refusals.join('\n')).toMatch(/line break/);
  });
});

describe('render', () => {
  it('starts with the marker run.sh and the overwrite guard look for', () => {
    expect(render({ A: 'x' }).split('\n')[0]).toBe(MARKER);
  });
});

describe('disconnectRisks', () => {
  function specDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-specs-'));
    mkdirSync(join(dir, 'nested'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it('flags a spec that names the callable or the control', () => {
    const dir = specDir({
      'a.cy.ts': "cy.intercept('**/disconnectGoogleCalendar')",
      'nested/b.cy.ts': "cy.contains('button', 'Disconnect').click()",
    });
    const risks = disconnectRisks(dir).join('\n');
    expect(risks).toMatch(/a\.cy\.ts: names the disconnectGoogleCalendar callable/);
    expect(risks).toMatch(/b\.cy\.ts: names the Disconnect control/);
  });

  it('passes a clean spec directory', () => {
    expect(disconnectRisks(specDir({ 'c.cy.ts': "cy.contains('button', 'Connect')" }))).toEqual([]);
  });
});

/**
 * #1201: the run serves two codebases, and the emulator reads each one's
 * secrets from ITS OWN `.secret.local`. A codebase without a complete file
 * falls through to Secret Manager, so every codebase gets one, or none does.
 */
describe('one secrets file per codebase', () => {
  const PREFLIGHT = join(dirname(fileURLToPath(import.meta.url)), 'preflight.mjs');
  /** A codebase shaped like the real ones: a package.json main, node_modules, endpoint metadata. */
  function codebase({ main, entry = main ?? 'index.js', secrets, installed = true }) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-fns-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify(main === undefined ? {} : { main }));
    if (installed) mkdirSync(join(dir, 'node_modules'));
    mkdirSync(dirname(join(dir, entry)), { recursive: true });
    const endpoints = Object.fromEntries(
      secrets.map((key, i) => [`fn${i}`, { __endpoint: { secretEnvironmentVariables: [{ key }] } }]),
    );
    writeFileSync(join(dir, entry), `module.exports = ${JSON.stringify(endpoints)};`);
    return dir;
  }
  function emptySpecDir() {
    return mkdtempSync(join(tmpdir(), 'e2e-real-specs-'));
  }
  function runPreflight(args, env = {}) {
    try {
      const stdout = execFileSync(process.execPath, [PREFLIGHT, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, ...env },
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
    }
  }
  it("resolves each codebase's entry from package.json main, as the emulator does", () => {
    const built = codebase({ main: 'lib/index.js', secrets: ['A'] });
    const plain = codebase({ secrets: ['B'] });
    expect(functionsEntry(built)).toBe(join(built, 'lib', 'index.js'));
    expect(functionsEntry(plain)).toBe(join(plain, 'index.js'));
    expect(secretsFileFor(plain)).toBe(join(plain, '.secret.local'));
  });
  it('reads declared secrets from a plain-JS codebase with no lib/', () => {
    expect(declaredSecrets(codebase({ secrets: ['CLOUDINARY_API_SECRET', 'ANTHROPIC_API_KEY'] }))).toEqual([
      'ANTHROPIC_API_KEY',
      'CLOUDINARY_API_SECRET',
    ]);
  });
  it('refuses, by name, a codebase that is not installed', () => {
    expect(() => declaredSecrets(codebase({ secrets: ['A'], installed: false }))).toThrow(/node_modules does not exist/);
  });
  it('writes a complete, marked file into every codebase it is given', () => {
    const mytribe = codebase({ main: 'lib/index.js', secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY'] });
    const admin = codebase({ secrets: ['CLOUDINARY_CLOUD_NAME', 'MAPBOX_ACCESS_TOKEN'] });
    const out = join(mkdtempSync(join(tmpdir(), 'e2e-real-out-')), 'vendors.json');
    const run = runPreflight([emptySpecDir(), out, mytribe, admin], { E2E_CLOUDINARY_CLOUD_NAME: 'e2e-cloud' });
    expect(run.status, run.stderr).toBe(0);
    for (const [dir, declared] of [
      [mytribe, ['SENTRY_DSN', 'STRIPE_SECRET_KEY']],
      [admin, ['CLOUDINARY_CLOUD_NAME', 'MAPBOX_ACCESS_TOKEN']],
    ]) {
      const body = readFileSync(secretsFileFor(dir), 'utf8');
      expect(body.split('\n')[0]).toBe(MARKER);
      for (const name of declared) expect(body, `${name} in ${dir}`).toMatch(new RegExp(`^${name}=".+"$`, 'm'));
    }
    expect(readFileSync(secretsFileFor(admin), 'utf8')).toMatch(/^CLOUDINARY_CLOUD_NAME="e2e-cloud"$/m);
    expect(JSON.parse(readFileSync(out, 'utf8')).cloudinary).toBe(false);
  });
  it('writes no file anywhere when any value is refused', () => {
    const mytribe = codebase({ main: 'lib/index.js', secrets: ['SENTRY_DSN'] });
    const admin = codebase({ secrets: ['CLOUDINARY_CLOUD_NAME'] });
    const out = join(mkdtempSync(join(tmpdir(), 'e2e-real-out-')), 'vendors.json');
    const run = runPreflight([emptySpecDir(), out, mytribe, admin], { STRIPE_TEST_SECRET_KEY: 'sk_live_abc' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/REFUSED to start the real-services run/);
    expect(existsSync(secretsFileFor(mytribe))).toBe(false);
    expect(existsSync(secretsFileFor(admin))).toBe(false);
  });
  it("refuses to replace a secrets file it did not write, in either codebase", () => {
    const mytribe = codebase({ main: 'lib/index.js', secrets: ['SENTRY_DSN'] });
    const admin = codebase({ secrets: ['CLOUDINARY_CLOUD_NAME'] });
    writeFileSync(secretsFileFor(admin), 'CLOUDINARY_CLOUD_NAME="a human wrote this"\n');
    const out = join(mkdtempSync(join(tmpdir(), 'e2e-real-out-')), 'vendors.json');
    const run = runPreflight([emptySpecDir(), out, mytribe, admin]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/exists and this script did not write it/);
    expect(readFileSync(secretsFileFor(admin), 'utf8')).toMatch(/a human wrote this/);
    expect(existsSync(secretsFileFor(mytribe))).toBe(false);
  });
});
