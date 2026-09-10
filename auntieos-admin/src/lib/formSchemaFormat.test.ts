import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { formSchemaTimeOf, formSchemaUpdatedFull } from './formSchemaFormat';

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

describe('formSchemaUpdatedFull', () => {
  it('renders a well-formed instant as LOCAL YYYY-MM-DD HH:mm, with the year', () => {
    // The exact row from the visual harness: v4 / e2e-admin / this instant.
    // 10:15 UTC is 05:15 in America/Chicago (CDT, UTC-5).
    expect(formSchemaUpdatedFull('2026-08-02T10:15:00.000Z')).toBe('2026-08-02 05:15');
    expect(formSchemaUpdatedFull('2026-08-02T10:15:00.000Z')).not.toContain('T');
    expect(formSchemaUpdatedFull('2026-08-02T10:15:00.000Z')).not.toContain('Z');
  });

  it('shows the LOCAL calendar day, not the UTC one (AO-18)', () => {
    // 01:00 UTC on the 17th is 20:00 on the 16th in Chicago. A raw ISO slice
    // would have printed the 17th.
    expect(formSchemaUpdatedFull('2026-07-17T01:00:00.000Z')).toBe('2026-07-16 20:00');
  });

  it('is null for a null updatedAt, the value the server really sends', () => {
    expect(formSchemaUpdatedFull(null)).toBeNull();
  });

  it('is null for a blank or whitespace updatedAt', () => {
    expect(formSchemaUpdatedFull('')).toBeNull();
    expect(formSchemaUpdatedFull('   ')).toBeNull();
  });

  it('echoes an unparseable value verbatim: never "Invalid Date", never "NaN"', () => {
    for (const bad of ['not-a-date', 'sometime last Tuesday', '2026-13-45T99:99:99Z', '???']) {
      const out = formSchemaUpdatedFull(bad);
      expect(out).toBe(bad);
      expect(out).not.toMatch(/Invalid Date/);
      expect(out).not.toMatch(/NaN/);
    }
  });

  it('trims an unparseable value rather than echoing its padding', () => {
    expect(formSchemaUpdatedFull('  not-a-date  ')).toBe('not-a-date');
  });
});
