import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * #873 second review: saveHomeAccess against the REAL Firestore, the sibling of
 * saveTribeProfileRoundTrip.test.ts. A save merges rows by key on the real SDK,
 * and two saves racing on one household keep each other's rows.
 *
 * Only `db()` is pointed at the emulator; the rate limiter runs for real. Runs
 * under `npm run test:rules`, and skips without FIRESTORE_EMULATOR_HOST.
 */

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logEvent: vi.fn() }));

const ALARM = { key: 'alarm', label: 'Alarm Code', value: '5678' };

describe.skipIf(!EMULATOR)('saveHomeAccess round trip (Firestore emulator)', () => {
  let app: App;
  let firestore: Firestore;

  beforeEach(() => {
    app ??= initializeApp({ projectId: 'mytribe-rules-test' }, 'home-round-trip');
    firestore ??= getFirestore(app);
    mocks.dbFn.mockReset().mockReturnValue(firestore);
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function save(uid: string, data: Record<string, unknown>) {
    const { saveHomeAccessHandler } = await import('../../src/portal/saveHomeAccess');
    return saveHomeAccessHandler({ data, auth: { uid } } as never);
  }

  it('a save edits its row, keeps the unsent one, and drops a stored Emergency Contact row', async () => {
    const fam = 'rt-873-home';
    const shed = { key: 'shed', label: 'Set by Auntie', value: 'Left of the gate' };
    await firestore.doc(`clients/rt-873-h1`).set({ kinfolkIds: [fam] });
    await firestore.doc(`families/${fam}/homeAccess/current`).set({
      gateCode: '1234',
      customFields: [shed, ALARM, { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Mercer' }],
    });

    await expect(save('rt-873-h1', { kinfolkId: fam, gateCode: '4321', customFields: [{ ...ALARM, value: '9999' }], removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });

    const doc = (await firestore.doc(`families/${fam}/homeAccess/current`).get()).data() ?? {};
    expect(doc['gateCode']).toBe('4321');
    expect(doc['updatedByUid']).toBe('rt-873-h1');
    expect(doc['customFields']).toEqual([shed, { ...ALARM, value: '9999' }]);
  });

  it('two saves racing on one household, each adding its own row, keep both rows', async () => {
    const fam = 'rt-873-home-race';
    await firestore.doc(`clients/rt-873-h2`).set({ kinfolkIds: [fam] });
    await firestore.doc(`families/${fam}/homeAccess/current`).set({ customFields: [ALARM] });
    const pool = { key: 'pool', label: 'Pool gate', value: '2468' };
    const garage = { key: 'garage', label: 'Garage', value: '1357' };

    await Promise.all([
      save('rt-873-h2', { kinfolkId: fam, customFields: [ALARM, pool], removeCustomFieldKeys: [] }),
      save('rt-873-h2', { kinfolkId: fam, customFields: [ALARM, garage], removeCustomFieldKeys: [] }),
    ]);

    const rows = ((await firestore.doc(`families/${fam}/homeAccess/current`).get()).data() ?? {})['customFields'] as unknown[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(ALARM);
    expect(rows).toEqual(expect.arrayContaining([ALARM, pool, garage]));
  });
});
