import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * The round trip the rest of the suite cannot prove.
 *
 * Every other prefs test — here, on web, and on Compose — stops at a boundary:
 * buildDbMock records the arguments to `.set()` without modelling merge
 * semantics at all, web mocks the api module, Compose asserts the JsonObject
 * PortalApi built. The bug this file exists for lived exactly in the gap: the
 * write options were wrong, so a cleared override never reached Firestore while
 * every suite stayed green and the screen said "Preferences saved".
 *
 * So this one runs the REAL handler against the REAL Firestore, seeds a
 * document, saves a prefs object with one byKey entry removed, and re-reads.
 * Nothing here is mocked except `db()`, which is pointed at the emulator.
 *
 * It lives under test/rules/ because that is the suite that already has an
 * emulator: `npm run test:rules` wraps vitest in `firebase emulators:exec
 * --only firestore`, which exports FIRESTORE_EMULATOR_HOST into the child.
 * Without that variable there is no Firestore to talk to, so the describe
 * skips rather than hanging on a connection to production.
 */

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logEvent: vi.fn() }));

describe.skipIf(!EMULATOR)('prefs save round trip (Firestore emulator)', () => {
  let app: App;
  let firestore: Firestore;

  beforeEach(() => {
    app ??= initializeApp({ projectId: 'mytribe-rules-test' }, 'prefs-round-trip');
    firestore ??= getFirestore(app);
    mocks.dbFn.mockReset().mockReturnValue(firestore);
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  it('a byKey entry the client omits is GONE from the stored document', async () => {
    const ref = firestore.collection('clients').doc('rt-portal');
    await ref.set({
      email: 'rt@example.com',
      notificationPrefs: {
        byCategory: { visit: { email: true, sms: false, push: true } },
        byKey: { 'visit.started': { sms: true }, 'visit.completed': { push: false } },
        marketingOptIn: { newsletter: true },
      },
    });

    const { saveMyNotificationPrefsHandler } = await import('../../src/portal/notificationPrefs');
    // The kinfolk reverted visit.started's sms override; visit.completed stays.
    await saveMyNotificationPrefsHandler({
      data: {
        prefs: {
          byCategory: { visit: { email: true, sms: false, push: true } },
          byKey: { 'visit.completed': { push: false } },
          marketingOptIn: { newsletter: true },
        },
      },
      auth: { uid: 'rt-portal' },
    } as never);

    const after = (await ref.get()).data() ?? {};
    const prefs = after['notificationPrefs'] as Record<string, unknown>;
    expect(prefs['byKey']).toEqual({ 'visit.completed': { push: false } });
    // The rest of the subtree survived, and so did the sibling field the
    // handler never mentioned.
    expect(prefs['byCategory']).toEqual({ visit: { email: true, sms: false, push: true } });
    expect(prefs['marketingOptIn']).toEqual({ newsletter: true });
    expect(after['email']).toBe('rt@example.com');
    expect(after['notificationPrefsUpdatedAt']).toBeTruthy();
  });

  it('clearing the LAST override empties byKey rather than leaving it behind', async () => {
    const ref = firestore.collection('clients').doc('rt-last');
    await ref.set({
      notificationPrefs: { byKey: { 'visit.started': { sms: true } } },
    });

    const { saveMyNotificationPrefsHandler } = await import('../../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: { prefs: { byCategory: {}, byKey: {}, marketingOptIn: {} } },
      auth: { uid: 'rt-last' },
    } as never);

    const prefs = ((await ref.get()).data() ?? {})['notificationPrefs'] as Record<string, unknown>;
    expect(prefs['byKey']).toEqual({});
  });

  it('creates the document when there is none (set, not update)', async () => {
    const ref = firestore.collection('clients').doc('rt-absent');
    await ref.delete();

    const { saveMyNotificationPrefsHandler } = await import('../../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: { prefs: { byKey: { 'visit.started': { sms: true } } } },
      auth: { uid: 'rt-absent' },
    } as never);

    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.['notificationPrefs']).toEqual({ byKey: { 'visit.started': { sms: true } } });
  });

  it('the admin handler behaves identically on staff/{uid}', async () => {
    const ref = firestore.collection('staff').doc('rt-admin');
    await ref.set({
      notificationPrefs: {
        byKey: { 'invoice.new': { sms: true }, 'invoice.paid': { email: false } },
      },
    });

    const { saveMyAdminNotificationPrefsHandler } = await import(
      '../../src/admin/myAdminNotificationPrefs'
    );
    await saveMyAdminNotificationPrefsHandler({
      data: { prefs: { byKey: { 'invoice.paid': { email: false } } } },
      auth: { uid: 'rt-admin' },
    } as never);

    const prefs = ((await ref.get()).data() ?? {})['notificationPrefs'] as Record<string, unknown>;
    expect(prefs['byKey']).toEqual({ 'invoice.paid': { email: false } });
  });
});
