import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A purpose-built Firestore fake rather than `_helpers/mockDb`, for two
 * reasons: the write has to be judged on what the STORED document ends up
 * holding, and the retry case needs the doc to change between the create event
 * and the transaction's read. Both want a fake whose state is inspectable.
 */
const store = new Map<string, Record<string, unknown>>();
const writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];

function makeDocRef(path: string) {
  return {
    path,
    get: async () => ({
      exists: store.has(path),
      data: () => store.get(path),
    }),
    set: (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      const merge = options?.merge === true;
      writes.push({ path, data, merge });
      store.set(path, merge ? { ...(store.get(path) ?? {}), ...data } : { ...data });
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
    fn({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, options?: { merge?: boolean }) => ref.set(data, options),
    }),
};

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => fakeDb }));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__serverTimestamp__' },
}));

import { seedReconcileStatus } from '../src/lib/reconcileStatus';

beforeEach(() => {
  store.clear();
  writes.length = 0;
});

describe('seedReconcileStatus', () => {
  it('enrols a freshly created report, which the pipeline query can then see', async () => {
    store.set('kin_care_reports/r1', { kinfolkId: 'fam1', status: 'DRAFT' });

    expect(await seedReconcileStatus('r1')).toBe('seeded');
    expect(store.get('kin_care_reports/r1')).toMatchObject({ reconcileStatus: 'pending' });
    // Merged, so the report's own fields survive the enrolment write.
    expect(store.get('kin_care_reports/r1')).toMatchObject({ kinfolkId: 'fam1', status: 'DRAFT' });
    expect(writes[0]?.merge).toBe(true);
  });

  it('stamps a marker that tells a seeded doc apart from a backfilled one', async () => {
    store.set('kin_care_reports/r1', { status: 'DRAFT' });

    await seedReconcileStatus('r1');

    expect(store.get('kin_care_reports/r1')).toHaveProperty('_reconcileStatusSeededAt');
    expect(store.get('kin_care_reports/r1')).not.toHaveProperty('_reconcileStatusBackfillAt');
  });

  it('NEVER re-stamps pending over a claim the pipeline already took', async () => {
    // The retry case: the trigger replays the original create, but by now the
    // pipeline has claimed the doc. Writing 'pending' back over 'in_progress'
    // would hand one report to a second pass.
    store.set('kin_care_reports/r1', {
      status: 'DRAFT',
      reconcileStatus: 'in_progress',
      reconcileClaimedAt: '2026-07-30T00:00:00Z',
    });

    expect(await seedReconcileStatus('r1')).toBe('already-present');
    expect(writes).toHaveLength(0);
    expect(store.get('kin_care_reports/r1')).toMatchObject({ reconcileStatus: 'in_progress' });
  });

  it.each(['pending', 'applied', 'skipped', 'error'])(
    'leaves an existing %s status alone',
    async (status) => {
      store.set('kin_care_reports/r1', { status: 'SENT', reconcileStatus: status });

      expect(await seedReconcileStatus('r1')).toBe('already-present');
      expect(writes).toHaveLength(0);
    },
  );

  it('leaves demo fixtures out of the pipeline, matching the backfill', async () => {
    store.set('kin_care_reports/demo1', { status: 'SENT', _demo: true });

    expect(await seedReconcileStatus('demo1')).toBe('demo-skipped');
    expect(writes).toHaveLength(0);
  });

  it('writes nothing when the document is already gone', async () => {
    expect(await seedReconcileStatus('vanished')).toBe('missing');
    expect(writes).toHaveLength(0);
  });
});
