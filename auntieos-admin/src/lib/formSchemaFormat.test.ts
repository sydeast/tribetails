import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NO_UPDATED_AT_LABEL,
  formSchemaTimeOf,
  formSchemaUpdatedLabel,
} from './formSchemaFormat';

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are meaningful
// on any CI runner (identical rationale to lib/tribalIntelFormat.test.ts /
// lib/kinTaleFormat.test.ts). Restored afterAll for any sibling test file
// sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('formSchemaTimeOf', () => {
  it('is null for the absent cases, never a fabricated date', () => {
    expect(formSchemaTimeOf(null)).toBeNull();
    expect(formSchemaTimeOf('')).toBeNull();
    expect(formSchemaTimeOf('   ')).toBeNull();
  });

  it('is null for an unparseable value rather than an Invalid Date', () => {
    expect(formSchemaTimeOf('not-a-date')).toBeNull();
    expect(formSchemaTimeOf('sometime last Tuesday')).toBeNull();
    expect(formSchemaTimeOf('2026-13-45T99:99:99Z')).toBeNull();
  });

  it('parses the ISO instant listFormSchemas actually sends', () => {
    const t = formSchemaTimeOf('2026-08-02T10:15:00.000Z');
    expect(t?.toDate().getTime()).toBe(new Date('2026-08-02T10:15:00.000Z').getTime());
  });
});

describe('formSchemaUpdatedLabel', () => {
  it('renders a well-formed instant as LOCAL MM-DD HH:mm, never the raw ISO string', () => {
    // The exact row from the visual harness: v4 / e2e-admin / this instant.
    // 10:15 UTC is 05:15 in America/Chicago (CDT, UTC-5).
    expect(formSchemaUpdatedLabel('2026-08-02T10:15:00.000Z')).toBe('08-02 05:15');
    expect(formSchemaUpdatedLabel('2026-08-02T10:15:00.000Z')).not.toContain('T');
    expect(formSchemaUpdatedLabel('2026-08-02T10:15:00.000Z')).not.toContain('Z');
  });

  it('shows the LOCAL calendar day, not the UTC one (AO-18)', () => {
    // 01:00 UTC on the 17th is 20:00 on the 16th in Chicago. A raw ISO slice
    // would have printed the 17th.
    expect(formSchemaUpdatedLabel('2026-07-17T01:00:00.000Z')).toBe('07-16 20:00');
  });

  it('says "date unknown" for a null updatedAt, the value the server really sends', () => {
    expect(formSchemaUpdatedLabel(null)).toBe(NO_UPDATED_AT_LABEL);
    expect(formSchemaUpdatedLabel(null)).toBe('date unknown');
  });

  it('says "date unknown" for a blank or whitespace updatedAt', () => {
    expect(formSchemaUpdatedLabel('')).toBe('date unknown');
    expect(formSchemaUpdatedLabel('   ')).toBe('date unknown');
  });

  it('echoes an unparseable value verbatim: never "Invalid Date", never "NaN"', () => {
    for (const bad of ['not-a-date', 'sometime last Tuesday', '2026-13-45T99:99:99Z', '???']) {
      const out = formSchemaUpdatedLabel(bad);
      expect(out).toBe(bad);
      expect(out).not.toMatch(/Invalid Date/);
      expect(out).not.toMatch(/NaN/);
    }
  });

  it('trims an unparseable value rather than echoing its padding', () => {
    expect(formSchemaUpdatedLabel('  not-a-date  ')).toBe('not-a-date');
  });

  it('never returns a blank string, so the meta line can never lose the part', () => {
    for (const input of [null, '', '   ', 'not-a-date', '2026-08-02T10:15:00.000Z']) {
      expect(formSchemaUpdatedLabel(input).trim()).not.toBe('');
    }
  });
});
