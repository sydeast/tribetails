import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  apiKeyProbeUrl,
  checkShape,
  describeProjectChoice,
  main,
  parseProject,
  HelpRequested,
  UsageError,
  USAGE,
  VOICE_SECRETS,
  type SecretSpec,
} from '../checkVoiceSecrets';

// `main` must never reach gcloud or Twilio for a usage problem. Mocking
// child_process here, rather than stubbing fetch alone, is what makes that
// provable: if parseProject's guard ever regressed to the old "unrecognized
// argument falls through and runs the live check" behavior, this mock would
// catch it instead of a real `gcloud secrets versions access` call firing.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const AP: SecretSpec = {
  name: 'TWIML_APP_SID',
  prefix: 'AP',
  required: true,
  purpose: 'test',
};
const SECRET_HALF: SecretSpec = {
  name: 'TWILIO_API_KEY_SECRET',
  prefix: null,
  required: true,
  purpose: 'test',
};

const GOOD = 'AP00000000000000000000000000000003';

describe('checkShape', () => {
  it('accepts a well-formed SID', () => {
    expect(checkShape(AP, GOOD)).toMatchObject({ verdict: 'ok' });
  });

  it('THE NEAR MISS: a SID one character short is malformed, and says so', () => {
    // The production value on 2026-08-11. Non-blank, so every check in place at
    // the time passed it.
    const finding = checkShape(AP, GOOD.slice(0, -1));
    expect(finding.verdict).toBe('malformed');
    expect(finding.detail).toContain('33 chars');
    expect(finding.detail).toContain('truncated paste');
  });

  it('does not call a LONG value a truncated paste', () => {
    const finding = checkShape(AP, GOOD + 'ff');
    expect(finding.verdict).toBe('malformed');
    expect(finding.detail).not.toContain('truncated');
  });

  it('catches a trailing newline, which is invisible everywhere else', () => {
    const finding = checkShape(AP, `${GOOD}\n`);
    expect(finding.verdict).toBe('malformed');
    expect(finding.detail).toContain('whitespace');
  });

  it('reports a missing secret separately from an empty one', () => {
    expect(checkShape(AP, null)).toMatchObject({ verdict: 'missing', detail: 'not found in Secret Manager' });
    expect(checkShape(AP, '   ')).toMatchObject({ verdict: 'missing', detail: 'set, but empty' });
  });

  it('catches a SID pasted into the wrong prompt', () => {
    expect(checkShape(AP, 'SK00000000000000000000000000000002')).toMatchObject({ verdict: 'malformed' });
  });

  it('rejects non-hex characters', () => {
    expect(checkShape(AP, 'APzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toMatchObject({ verdict: 'malformed' });
  });

  it('applies no shape rule to the key secret, which is not a SID', () => {
    expect(checkShape(SECRET_HALF, 'abcdef0123456789abcdef0123456789')).toMatchObject({ verdict: 'ok' });
    expect(checkShape(SECRET_HALF, 'anything-non-blank')).toMatchObject({ verdict: 'ok' });
  });

  it('NEVER puts the value in the detail string, which gets pasted into chats', () => {
    const value = 'AP0000000000000000000000000secret1';
    for (const candidate of [value, value.slice(0, -1), `${value}\n`, '']) {
      const finding = checkShape(AP, candidate);
      expect(finding.detail).not.toContain('secret1');
      expect(finding.detail).not.toContain(candidate.trim() || 'IMPOSSIBLE');
    }
  });
});

describe('VOICE_SECRETS', () => {
  it('marks exactly the two optional secrets optional, matching the callable', () => {
    // mintVoiceAccessToken degrades without the TwiML app (no outbound calling)
    // and without the push credential (no wake from background), and refuses
    // without the other three. The two lists must not drift: a secret this
    // script calls blocking that the callable does not would send an operator
    // chasing a resource nothing needs, which is the errand this change removes.
    const optional = VOICE_SECRETS.filter((s) => !s.required).map((s) => s.name);
    expect(optional.sort()).toEqual(['PUSH_CREDENTIAL_SID', 'TWIML_APP_SID']);
  });

  it('declares a prefix for every SID and none for the key secret', () => {
    const noPrefix = VOICE_SECRETS.filter((s) => s.prefix === null).map((s) => s.name);
    expect(noPrefix).toEqual(['TWILIO_API_KEY_SECRET']);
  });
});

describe('parseProject', () => {
  // `firebase emulators:exec --project X` exports GCLOUD_PROJECT=X into every
  // command it runs, this test suite included. Reading the value at import
  // time captures whatever the real shell set (or did not), so restoring it
  // after each case never clobbers the harness's own environment.
  const ORIGINAL_GCLOUD_PROJECT = process.env.GCLOUD_PROJECT;

  afterEach(() => {
    if (ORIGINAL_GCLOUD_PROJECT === undefined) {
      delete process.env.GCLOUD_PROJECT;
    } else {
      process.env.GCLOUD_PROJECT = ORIGINAL_GCLOUD_PROJECT;
    }
  });

  it('defaults to the production project when GCLOUD_PROJECT is unset', () => {
    delete process.env.GCLOUD_PROJECT;
    expect(parseProject([])).toEqual({ project: 'auntieos-ttpc', source: 'default' });
  });

  it('an unset --project lets the environment win', () => {
    process.env.GCLOUD_PROJECT = 'from-the-shell';
    expect(parseProject([])).toEqual({ project: 'from-the-shell', source: 'environment' });
  });

  it('an explicit --project wins even when GCLOUD_PROJECT is also set', () => {
    process.env.GCLOUD_PROJECT = 'from-the-shell';
    expect(parseProject(['--project', 'other'])).toEqual({ project: 'other', source: 'flag' });
  });

  it('refuses a flag as the value, as a UsageError', () => {
    delete process.env.GCLOUD_PROJECT;
    expect(() => parseProject(['--project', '--verbose'])).toThrow(UsageError);
    expect(() => parseProject(['--project', '--verbose'])).toThrow('--project requires a value');
    expect(() => parseProject(['--project'])).toThrow(UsageError);
    expect(() => parseProject(['--project'])).toThrow('--project requires a value');
  });
});

describe('parseProject: help and unrecognized arguments', () => {
  // THE BUG an accidental live run exposed: parseProject only ever looked for
  // the literal string '--project'. Any other argument, including a typo like
  // --halp, was silently ignored, so the script fell through to running the
  // full check against the default project. It is not enough for --project to
  // be validated; everything else has to be refused too.
  it('throws HelpRequested for --help', () => {
    expect(() => parseProject(['--help'])).toThrow(HelpRequested);
  });

  it('throws HelpRequested for -h', () => {
    expect(() => parseProject(['-h'])).toThrow(HelpRequested);
  });

  it('rejects an unrecognized argument by name, as a UsageError', () => {
    expect(() => parseProject(['--halp'])).toThrow(UsageError);
    expect(() => parseProject(['--halp'])).toThrow('unrecognized argument: --halp');
  });
});

describe('describeProjectChoice', () => {
  // Printed before checkVoiceSecrets reads a single secret, so an operator
  // sees which project is about to be checked and why, rather than trusting
  // whatever their shell happened to export.
  it('names the project and says where the choice came from', () => {
    expect(describeProjectChoice({ project: 'auntieos-ttpc', source: 'default' })).toBe(
      'Checking Twilio voice secrets in auntieos-ttpc (from default)',
    );
    expect(describeProjectChoice({ project: 'from-the-shell', source: 'environment' })).toBe(
      'Checking Twilio voice secrets in from-the-shell (from environment)',
    );
    expect(describeProjectChoice({ project: 'other', source: 'flag' })).toBe(
      'Checking Twilio voice secrets in other (from flag)',
    );
  });
});

describe('main: a usage problem never reaches gcloud or Twilio', () => {
  // The accidental production run this guards against: `npm run
  // check:voice-secrets -- --help` actually called gcloud and Twilio for real,
  // because the script had no --help handling and no unrecognized-argument
  // check, so it fell through to the live default-project check. These tests
  // stub execFileSync (gcloud) and fetch (Twilio) and assert zero calls for
  // every argument shape that must stop before either.
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it('--help prints usage, exits 0, and never calls gcloud or Twilio', async () => {
    await main(['--help']);
    expect(process.exitCode).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(USAGE);
  });

  it('-h prints usage, exits 0, and never calls gcloud or Twilio', async () => {
    await main(['-h']);
    expect(process.exitCode).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a typo like --halp is refused, exits 2, and never calls gcloud or Twilio', async () => {
    await main(['--halp']);
    expect(process.exitCode).toBe(2);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('unrecognized argument: --halp');
  });

  it('--project with a missing value is refused, exits 2, and never calls gcloud or Twilio', async () => {
    await main(['--project']);
    expect(process.exitCode).toBe(2);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('--project requires a value');
  });

  // The positive control. Every "never calls gcloud or Twilio" assertion above
  // is vacuous if vi.mock failed to intercept the copy checkVoiceSecrets.ts
  // imports: this proves the mock is actually wired, by exercising the one
  // path that IS supposed to call it, so a broken mock would show up here as
  // zero calls or a real gcloud invocation, not as an accidental pass above.
  it('a run that passes the usage gate DOES call gcloud once per secret, and never Twilio once every shape fails', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('gcloud: not found (simulated for the test)');
    });
    await main(['--project', 'no-such-project']);
    expect(execFileSync).toHaveBeenCalledTimes(VOICE_SECRETS.length + 1); // +1 for TWILIO_AUTH_TOKEN
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('apiKeyProbeUrl', () => {
  const ACCOUNT = 'AC00000000000000000000000000000001';
  it('NEVER probes the Accounts endpoint, which Standard keys cannot read', () => {
    // The bug this pins, in full. Twilio's key-type table says a Standard key
    // has "access to all Twilio API resources, EXCEPT for Accounts (/Accounts)
    // or Keys resources". This script originally probed exactly that endpoint,
    // so it reported HTTP 401 for a perfectly good key and printed advice to
    // create a new one. The operator did, twice, and the replacement failed the
    // same way, because the key was never the problem.
    const url = apiKeyProbeUrl(ACCOUNT);
    expect(url).not.toMatch(new RegExp(`/Accounts/${ACCOUNT}\\.json`));
    expect(url).not.toContain('/Keys');
  });
  it('probes Calls, which a Standard key reaches and this feature actually uses', () => {
    // Screening places an outbound call to the operator, so Calls is not an
    // arbitrary reachable endpoint, it is the permission that has to work.
    expect(apiKeyProbeUrl(ACCOUNT)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls.json?PageSize=1`,
    );
  });
  it('asks for one row rather than a page of call history', () => {
    expect(apiKeyProbeUrl(ACCOUNT)).toContain('PageSize=1');
  });
});
