import { describe, it, expect } from 'vitest';
import { checkShape, parseProject, VOICE_SECRETS, type SecretSpec } from '../checkVoiceSecrets';

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
  it('marks only the push credential optional, matching the callable', () => {
    // mintVoiceAccessToken degrades without the push credential and refuses
    // without the other four. The two lists must not drift.
    const optional = VOICE_SECRETS.filter((s) => !s.required).map((s) => s.name);
    expect(optional).toEqual(['PUSH_CREDENTIAL_SID']);
  });

  it('declares a prefix for every SID and none for the key secret', () => {
    const noPrefix = VOICE_SECRETS.filter((s) => s.prefix === null).map((s) => s.name);
    expect(noPrefix).toEqual(['TWILIO_API_KEY_SECRET']);
  });
});

describe('parseProject', () => {
  it('defaults to the production project', () => {
    expect(parseProject([])).toBe('auntieos-ttpc');
  });

  it('takes an explicit --project', () => {
    expect(parseProject(['--project', 'other'])).toBe('other');
  });

  it('refuses a flag as the value', () => {
    expect(() => parseProject(['--project', '--verbose'])).toThrow('--project requires a value');
    expect(() => parseProject(['--project'])).toThrow('--project requires a value');
  });
});
