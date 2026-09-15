import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * #873 second review: saveTribeProfile against the REAL Firestore.
 *
 * The unit tests model a transaction (test/_helpers/optimisticTransaction.ts);
 * this file proves the handler on the real SDK and the emulator's real
 * transactions: an old client's Emergency Contact edit lands on both documents,
 * and two saves racing on one household keep each other's rows.
 *
 * Only `db()` is pointed at the emulator. The audit writer is mocked so the
 * assertions are about the two documents the save owns; the rate limiter runs
 * for real (a fresh `emulators:exec` starts every bucket at zero).
 *
 * Same harness as notificationPrefsRoundTrip.test.ts: `npm run test:rules` wraps
 * vitest in `firebase emulators:exec --only firestore`, which sets
 * FIRESTORE_EMULATOR_HOST. Without it the describe skips.
 */

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-id') }));

const ALLERGY = { key: 'allergy', label: 'Allergies', value: 'Chicken' };

describe.skipIf(!EMULATOR)('saveTribeProfile round trip (Firestore emulator)', () => {
  let app: App;
  let firestore: Firestore;

  beforeEach(() => {
    app ??= initializeApp({ projectId: 'mytribe-rules-test' }, 'profile-round-trip');
    firestore ??= getFirestore(app);
    mocks.dbFn.mockReset().mockReturnValue(firestore);
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function save(uid: string, data: Record<string, unknown>) {
    const { saveTribeProfileHandler } = await import('../../src/portal/saveTribeProfile');
    return saveTribeProfileHandler({ data, auth: { uid } } as never);
  }

  it("an old client's contact edit lands on kinfolk and leaves the rows as sent, in one save", async () => {
    const fam = 'rt-873-ec';
    await firestore.doc(`clients/rt-873-u1`).set({ kinfolkIds: [fam] });
    await firestore.doc(`families/${fam}`).set({ displayName: 'The Foster', customFields: [ALLERGY] });
    await firestore.doc(`kinfolk/${fam}`).set({ firstName: 'Dana', lastName: 'Foster', phoneNumber: '(805) 555-0100', emergencyContacts: [] });

    await expect(
      save('rt-873-u1', {
        kinfolkId: fam,
        displayName: 'The Foster Tribe',
        customFields: [
          { ...ALLERGY, value: 'Beef' },
          { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Sam Ortiz' },
          { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '(805) 555-0111' },
        ],
      }),
    ).resolves.toEqual({ ok: true });

    const kin = (await firestore.doc(`kinfolk/${fam}`).get()).data() ?? {};
    expect(kin['emergencyContacts']).toHaveLength(1);
    expect((kin['emergencyContacts'] as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111' });
    const families = (await firestore.doc(`families/${fam}`).get()).data() ?? {};
    expect(families['displayName']).toBe('The Foster Tribe');
    expect(families['customFields']).toEqual([{ ...ALLERGY, value: 'Beef' }]);
  });

  it('without Home access, an old client contact edit is ignored: kinfolk unchanged, the other rows saved', async () => {
    const fam = 'rt-873-nohome';
    const uid = 'rt-873-sec';
    const rae = { name: 'Rae Mercer', phone: '+18055550199', relationship: null };
    await firestore.doc(`clients/${uid}`).set({ kinfolkIds: [fam] });
    await firestore.doc(`families/${fam}/members/${uid}`).set({
      role: 'SECONDARY',
      status: 'ACTIVE',
      permissions: { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true, home_access: false },
    });
    await firestore.doc(`families/${fam}`).set({ displayName: 'The Foster', customFields: [ALLERGY] });
    await firestore.doc(`kinfolk/${fam}`).set({ firstName: 'Dana', lastName: 'Foster', phoneNumber: '(805) 555-0100', emergencyContacts: [rae] });
    const kinBefore = (await firestore.doc(`kinfolk/${fam}`).get()).data();

    await expect(
      save(uid, {
        kinfolkId: fam,
        displayName: 'The Foster',
        customFields: [
          { ...ALLERGY, value: 'Beef' },
          { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Sam Ortiz' },
          { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '(805) 555-0111' },
        ],
      }),
    ).resolves.toEqual({ ok: true, emergencyContactIgnored: true });

    expect((await firestore.doc(`kinfolk/${fam}`).get()).data()).toEqual(kinBefore);
    const families = (await firestore.doc(`families/${fam}`).get()).data() ?? {};
    expect(families['customFields']).toEqual([{ ...ALLERGY, value: 'Beef' }]);
    expect(families['updatedAt']).toBeTruthy();
  });

  it('two saves racing on one household, each adding its own row, keep both rows', async () => {
    const fam = 'rt-873-race';
    await firestore.doc(`clients/rt-873-u2`).set({ kinfolkIds: [fam] });
    await firestore.doc(`families/${fam}`).set({ displayName: 'The Race', customFields: [ALLERGY] });
    const pool = { key: 'pool', label: 'Pool', value: 'Heated' };
    const shed = { key: 'shed', label: 'Shed', value: 'Left of the gate' };

    await Promise.all([
      save('rt-873-u2', { kinfolkId: fam, customFields: [ALLERGY, pool], removeCustomFieldKeys: [] }),
      save('rt-873-u2', { kinfolkId: fam, customFields: [ALLERGY, shed], removeCustomFieldKeys: [] }),
    ]);

    const rows = ((await firestore.doc(`families/${fam}`).get()).data() ?? {})['customFields'] as unknown[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(ALLERGY);
    expect(rows).toEqual(expect.arrayContaining([ALLERGY, pool, shed]));
  });
});
