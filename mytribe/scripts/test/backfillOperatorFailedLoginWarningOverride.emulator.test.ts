import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import {
  applyCopy,
  buildPlan,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  SOURCE_KEY,
  TARGET_KEY,
} from '../backfillOperatorFailedLoginWarningOverride';

/**
 * The #877 override backfill against a real Firestore:
 *
 *  1. The write merges ONE key into `byKey` and leaves every other key's
 *     override, including the old key's, exactly as it was.
 *  2. It never overwrites an override the new key already has, even one saved
 *     after the dry run.
 *  3. A second run plans nothing.
 *
 * Runs only with an emulator:  npm run test:scripts:emulator
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const EMULATOR_TIMEOUT_MS = 30_000;
const WRITE_AT = Date.UTC(2026, 8, 14, 18, 0, 0);

describe.runIf(EMULATOR)('the #877 override backfill copies once and never overwrites', () => {
  let db: Firestore;
  const doc = () => db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC);
  const read = async () => ((await doc().get()).data() ?? {}) as Record<string, unknown>;

  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'operator-warning-877-test' });
    db = getFirestore();
  });

  beforeEach(async () => {
    await doc().delete();
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it("copies the business view to the new key and leaves every other key's override alone", async () => {
    const source = {
      enabled: true,
      channels: { sms: true, push: false },
      locked: { email: true },
      streams: { business: { channels: { sms: false } }, kinfolk: { enabled: false } },
    };
    const other = { enabled: false, channels: { email: false } };
    await doc().set({ byKey: { [SOURCE_KEY]: source, 'invoice.new': other }, updatedAtMs: 1 });

    expect((await buildPlan(db)).action).toBe('copy');
    // A dry run only reads.
    expect((await read())['updatedAtMs']).toBe(1);

    const applied = await applyCopy(db, WRITE_AT);
    expect(applied).toMatchObject({ action: 'copy', value: { enabled: true, channels: { sms: false, push: false } } });

    expect(await read()).toEqual({
      byKey: {
        [SOURCE_KEY]: source,
        'invoice.new': other,
        [TARGET_KEY]: { enabled: true, channels: { sms: false, push: false } },
      },
      updatedAtMs: WRITE_AT,
    });

    // The done check: a second run finds the new key set and plans nothing.
    expect((await buildPlan(db)).action).toBe('target-exists');
    expect((await applyCopy(db, WRITE_AT + 1)).action).toBe('target-exists');
    expect((await read())['updatedAtMs']).toBe(WRITE_AT);
  }, EMULATOR_TIMEOUT_MS);

  it('never overwrites an override the operator saved after the dry run', async () => {
    await doc().set({ byKey: { [SOURCE_KEY]: { enabled: false, channels: {} } }, updatedAtMs: 1 });
    expect((await buildPlan(db)).action).toBe('copy');

    // The operator saves the new row on the Business tab before the write runs.
    const saved = { enabled: true, channels: { sms: true } };
    await doc().set({ byKey: { [TARGET_KEY]: saved }, updatedAtMs: 2 }, { merge: true });

    expect((await applyCopy(db, WRITE_AT)).action).toBe('target-exists');
    const after = await read();
    expect((after['byKey'] as Record<string, unknown>)[TARGET_KEY]).toEqual(saved);
    expect(after['updatedAtMs']).toBe(2);
  }, EMULATOR_TIMEOUT_MS);

  it('writes nothing when the old key was never set, or the doc does not exist', async () => {
    expect((await applyCopy(db, WRITE_AT)).action).toBe('no-doc');
    expect((await doc().get()).exists).toBe(false);

    await doc().set({ byKey: { 'invoice.new': { enabled: false } }, updatedAtMs: 1 });
    expect((await applyCopy(db, WRITE_AT)).action).toBe('no-source');
    expect(await read()).toEqual({ byKey: { 'invoice.new': { enabled: false } }, updatedAtMs: 1 });
  }, EMULATOR_TIMEOUT_MS);

  it('writes nothing when the old key only holds the catalog default', async () => {
    await doc().set({ byKey: { [SOURCE_KEY]: { enabled: true, channels: {} } }, updatedAtMs: 1 });
    expect((await applyCopy(db, WRITE_AT)).action).toBe('default-only');
    expect(await read()).toEqual({ byKey: { [SOURCE_KEY]: { enabled: true, channels: {} } }, updatedAtMs: 1 });
  }, EMULATOR_TIMEOUT_MS);
});
