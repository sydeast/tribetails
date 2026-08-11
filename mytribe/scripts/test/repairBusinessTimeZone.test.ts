import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planRepair,
  isValidTimeZone,
  SETTINGS_DOC,
  SETTINGS_DOC_LEGACY,
  TARGET_TIME_ZONE,
} from '../repairBusinessTimeZone';

/** Minimal Firestore double: only `.doc(path).get()` is exercised by planRepair. */
function fakeFirestore(docs: Record<string, Record<string, unknown>>): any {
  return {
    doc: (path: string) => ({
      get: () =>
        Promise.resolve({
          exists: path in docs,
          data: () => docs[path],
        }),
    }),
  };
}

describe('isValidTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('refuses a typo, which is the whole reason this check exists', () => {
    // A stored zone Intl cannot resolve makes every call take the fail-open
    // branch, which answers "we are open" at three in the morning.
    expect(isValidTimeZone('America/Chigago')).toBe(false);
    expect(isValidTimeZone('Central')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', zone: TARGET_TIME_ZONE });
  });

  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });

  it('an explicit --dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('takes an override zone and a project', () => {
    expect(parseArgs(['--zone', 'UTC', '--project', 'p1'])).toMatchObject({
      zone: 'UTC',
      projectId: 'p1',
    });
  });

  it('refuses a flag as a value rather than swallowing the next token', () => {
    expect(() => parseArgs(['--zone', '--dry-run'])).toThrow('--zone requires a value');
    expect(() => parseArgs(['--project'])).toThrow('--project requires a value');
  });
});

describe('planRepair', () => {
  it('plans the correction that prompted this script', async () => {
    const fs = fakeFirestore({ [SETTINGS_DOC]: { timeZone: 'America/New_York' } });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toEqual({
      path: SETTINGS_DOC,
      before: 'America/New_York',
      after: 'America/Chicago',
      changes: true,
    });
  });

  it('plans nothing when the value already matches, so a second run is a no-op', async () => {
    const fs = fakeFirestore({ [SETTINGS_DOC]: { timeZone: 'America/Chicago' } });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toMatchObject({ changes: false });
  });

  it('reports an unset zone as unset rather than as empty string', async () => {
    const fs = fakeFirestore({ [SETTINGS_DOC]: { businessName: 'Tribe Tails' } });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toMatchObject({ before: null, changes: true });
  });

  it('reports a non-string stored value as unset rather than throwing', async () => {
    const fs = fakeFirestore({ [SETTINGS_DOC]: { timeZone: 42 } });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toMatchObject({ before: null, changes: true });
  });

  it('falls back to the legacy singleton document', async () => {
    const fs = fakeFirestore({ [SETTINGS_DOC_LEGACY]: { timeZone: 'America/New_York' } });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toMatchObject({
      path: SETTINGS_DOC_LEGACY,
      changes: true,
    });
  });

  it('prefers the modern document when both exist', async () => {
    const fs = fakeFirestore({
      [SETTINGS_DOC]: { timeZone: 'America/New_York' },
      [SETTINGS_DOC_LEGACY]: { timeZone: 'UTC' },
    });
    expect(await planRepair(fs, TARGET_TIME_ZONE)).toMatchObject({ path: SETTINGS_DOC });
  });

  it('reports no document rather than inventing one', async () => {
    expect(await planRepair(fakeFirestore({}), TARGET_TIME_ZONE)).toMatchObject({
      path: null,
      changes: false,
    });
  });
});
