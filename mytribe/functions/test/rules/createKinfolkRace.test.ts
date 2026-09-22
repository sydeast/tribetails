import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * #890: two presses of Add racing each other.
 *
 * The unit suite (test/createKinfolk.test.ts) runs on buildDbMock, which runs a
 * transaction's callback once and never makes two of them contend. The claim
 * that matters here is concurrency: two `createKinfolk` calls for the same
 * operator and the same phone, fired together, must create exactly ONE household,
 * and the other call must answer `duplicateOf` that household. Only a real
 * Firestore can referee that, so this runs the real handler against the
 * emulator. Nothing is mocked except `db()` (pointed at the emulator), the
 * logger and Sentry.
 *
 * Lives under test/rules/ because `npm run test:rules` is the suite that starts
 * a Firestore emulator; without FIRESTORE_EMULATOR_HOST the describe skips.
 */

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { createKinfolkHandler } from '../../src/admin/createKinfolk';

function call(data: unknown, uid: string) {
  return { data, auth: { uid, token: { admin: true } } } as never;
}

describe.skipIf(!EMULATOR)('createKinfolk under concurrency (Firestore emulator)', () => {
  let app: App;
  let firestore: Firestore;

  beforeEach(() => {
    app ??= initializeApp({ projectId: 'mytribe-rules-test' }, 'create-kinfolk-race');
    firestore ??= getFirestore(app);
    mocks.dbFn.mockReset().mockReturnValue(firestore);
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function householdsBy(uid: string): Promise<string[]> {
    const snap = await firestore.collection('kinfolk').where('createdByUid', '==', uid).get();
    return snap.docs.map((d) => d.id);
  }

  async function race(uid: string, a: Record<string, unknown>, b: Record<string, unknown>) {
    const results = await Promise.all([
      createKinfolkHandler(call({ kinfolk: a }, uid)),
      createKinfolkHandler(call({ kinfolk: b }, uid)),
    ]);
    const ids = await householdsBy(uid);
    return { results, ids };
  }

  it('two calls with the same operator and phone create one household, and the other answers duplicateOf', async () => {
    const uid = `race-phone-${Date.now()}`;
    const { results, ids } = await race(
      uid,
      { firstName: 'Jamie', lastName: 'Halbrook', phoneNumber: '(805) 555-0134', email: '' },
      { firstName: 'Jamie', lastName: 'Halbrook', phoneNumber: '805-555-0134', email: '' },
    );

    expect(ids).toHaveLength(1);
    const created = results.filter((r) => r.duplicateOf === null);
    const duplicates = results.filter((r) => r.duplicateOf !== null);
    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(created[0].kinfolkId).toBe(ids[0]);
    expect(duplicates[0]).toEqual({ kinfolkId: ids[0], duplicateOf: ids[0] });
  });

  it('two calls with the same operator and email create one household', async () => {
    const uid = `race-email-${Date.now()}`;
    const { results, ids } = await race(
      uid,
      { firstName: 'Pat', lastName: 'Lee', phoneNumber: '', email: 'pat@example.com' },
      { firstName: 'Pat', lastName: 'Lee', phoneNumber: '', email: ' PAT@example.com' },
    );
    expect(ids).toHaveLength(1);
    expect(results.filter((r) => r.duplicateOf === ids[0])).toHaveLength(1);
  });

  it('two calls with different phones and emails create two households', async () => {
    const uid = `race-distinct-${Date.now()}`;
    const { results, ids } = await race(
      uid,
      { firstName: 'Sam', lastName: 'Ortiz', phoneNumber: '805-555-0141', email: 'sam@example.com' },
      { firstName: 'Lee', lastName: 'Park', phoneNumber: '805-555-0142', email: 'lee@example.com' },
    );
    expect(ids).toHaveLength(2);
    expect(results.every((r) => r.duplicateOf === null)).toBe(true);
  });
});
