import { describe, it, expect } from 'vitest';
import { computeFamilyDiff } from '../src/migration/migrationDiff';

describe('computeFamilyDiff', () => {
  it('returns empty diff when already migrated', () => {
    const diff = computeFamilyDiff('f1', {
      flags: { foundationV1MigratedAt: 'x' },
    } as any, []);
    expect(diff.skipped).toBe(true);
  });

  it('flags ADMIN→PRIMARY conversion', () => {
    const diff = computeFamilyDiff('f1', {} as any, [
      { id: 'u1', data: { role: 'ADMIN' } } as any,
    ]);
    expect(diff.skipped).toBe(false);
    expect((diff.familyUpdates as any).flags.unverified).toBe(false);
    expect(diff.memberUpdates).toEqual([
      expect.objectContaining({ uid: 'u1', role: 'PRIMARY', status: 'ACTIVE' }),
    ]);
  });
});
