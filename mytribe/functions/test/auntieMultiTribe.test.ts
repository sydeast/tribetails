import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';

/**
 * Issue #984. Operator ruling 2026-09-27: an Auntie may be assigned several
 * tribes, the same as the owner; a kinfolk account with two or more stays a
 * data defect.
 *
 * Every portal callable that resolves a household is run here for five callers:
 * the owner, an Auntie assigned one tribe, an Auntie assigned two, a kinfolk
 * with one tribe and a kinfolk with two. An Auntie's assignment is modelled the
 * way the issue names it, as `clients/{uid}.kinfolkIds`.
 *
 * What each outcome means:
 *   staff      resolveKinfolkAccess took its staff branch (isOperator: true)
 *   own        resolveKinfolkAccess took the kinfolk branch (isOperator: false)
 *   multi      the one-tribe rule refused: failed-precondition, "Multiple tribes"
 *   caretaker  refused by role before any household was resolved
 *
 * For `staff` and `own` the handler is allowed to fail AFTER the gate (an empty
 * fixture makes a visit or a tale not-found), because what is under test is the
 * gate. It is not allowed to fail with the refusal codes themselves.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolved: [] as Array<{ kinfolkId: string; isOperator: boolean }>,
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/aiCopy', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/aiCopy')>()),
  generateCopy: vi.fn().mockResolvedValue({ text: 'ok' }),
}));
// Pass-through spy: the real resolver runs, and what it returned is recorded.
vi.mock('../src/lib/resolveKinfolkAccess', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/resolveKinfolkAccess')>();
  return {
    ...actual,
    resolveKinfolkAccess: async (...args: Parameters<typeof actual.resolveKinfolkAccess>) => {
      const r = await actual.resolveKinfolkAccess(...args);
      mocks.resolved.push(r);
      return r;
    },
  };
});

const CARETAKER_MESSAGE = 'This is not available to caretaker accounts.';

type Caller = 'owner' | 'auntie1' | 'auntie2' | 'kin1' | 'kin2';
const CALLERS: Caller[] = ['owner', 'auntie1', 'auntie2', 'kin1', 'kin2'];

const AUTH: Record<Caller, { uid: string; token: Record<string, unknown> }> = {
  owner: { uid: 'owner-1', token: { admin: true } },
  auntie1: { uid: 'auntie-one', token: { staffRole: 'auntie' } },
  auntie2: { uid: 'auntie-two', token: { staffRole: 'auntie' } },
  kin1: { uid: 'kin-one', token: { role: 'kinfolk', kinfolkId: 'k1' } },
  kin2: { uid: 'kin-two', token: { role: 'kinfolk' } },
};

function fixture() {
  return buildDbMock({
    docs: {
      'clients/owner-1': {},
      'clients/auntie-one': { kinfolkIds: ['k1'] },
      'clients/auntie-two': { kinfolkIds: ['k1', 'k2'] },
      'clients/kin-one': { kinfolkIds: ['k1'] },
      'clients/kin-two': { kinfolkIds: ['k1', 'k2'] },
      'kinfolk/k1': { firstName: 'Ada', lastName: 'Park' },
      'kinfolk/k2': { firstName: 'Bo', lastName: 'Lee' },
      'families/k1': { displayName: 'Park tribe' },
    },
  }).db;
}

type Outcome = 'staff' | 'own' | 'multi' | 'caretaker';
type Handler = (req: never) => Promise<unknown>;

interface Case {
  name: string;
  load: () => Promise<Handler>;
  data: Record<string, unknown>;
  expect: Record<Caller, Outcome>;
}

/**
 * Allowlisted household callables: an Auntie is staff whatever her tribe count.
 * Docket Q1 (operator ruling 2026-09-27, an Auntie never uses the portal) left
 * only the three the ADMIN clients call on this row: getMyKinTaleMedia,
 * listHouseholdContacts, saveHouseholdContact. The ten portal-only callables
 * #984 had allowlisted moved to NOT_HERS.
 */
const HOUSEHOLD: Record<Caller, Outcome> = {
  owner: 'staff', auntie1: 'staff', auntie2: 'staff', kin1: 'own', kin2: 'multi',
};
/** Household callables the allowlist does not admit her to: refused by role. */
const NOT_HERS: Record<Caller, Outcome> = {
  owner: 'staff', auntie1: 'caretaker', auntie2: 'caretaker', kin1: 'own', kin2: 'multi',
};
/** Money: refused by role; the owner keeps the raw-claim staff branch. */
const MONEY: Record<Caller, Outcome> = NOT_HERS;

const p = (m: string) => import(`../src/portal/${m}`);
const FUTURE = Date.now() + 30 * 24 * 3600 * 1000;

const CASES: Case[] = [
  { name: 'getMyKin', load: async () => (await p('getMyKin')).getMyKinHandler, data: {}, expect: NOT_HERS },
  { name: 'getMyKinTales', load: async () => (await p('getMyKinTales')).getMyKinTalesHandler, data: {}, expect: NOT_HERS },
  { name: 'getMyKinTaleMedia', load: async () => (await p('getMyKinTaleMedia')).getMyKinTaleMediaHandler, data: { taleId: 't1' }, expect: HOUSEHOLD },
  { name: 'getMyKinPhotos', load: async () => (await p('getMyKinPhotos')).getMyKinPhotosHandler, data: {}, expect: NOT_HERS },
  { name: 'getMyVisits', load: async () => (await p('getMyVisits')).getMyVisitsHandler, data: {}, expect: NOT_HERS },
  { name: 'getMyBookings', load: async () => (await p('getMyBookings')).getMyBookingsHandler, data: {}, expect: NOT_HERS },
  { name: 'getMyTribeProfile', load: async () => (await p('getMyTribeProfile')).getMyTribeProfileHandler, data: {}, expect: NOT_HERS },
  { name: 'saveTribeProfile', load: async () => (await p('saveTribeProfile')).saveTribeProfileHandler, data: { displayName: 'Park tribe' }, expect: NOT_HERS },
  { name: 'saveHomeAccess', load: async () => (await p('saveHomeAccess')).saveHomeAccessHandler, data: { gateCode: '1234' }, expect: NOT_HERS },
  { name: 'addKin', load: async () => (await p('kinWrites')).addKinHandler, data: { kin: { name: 'Biscuit' } }, expect: NOT_HERS },
  { name: 'updateKin', load: async () => (await p('kinWrites')).updateKinHandler, data: { kinId: 'kin1', kin: { name: 'Biscuit' } }, expect: NOT_HERS },
  { name: 'listHouseholdContacts', load: async () => (await p('householdContacts')).listHouseholdContactsHandler, data: {}, expect: HOUSEHOLD },
  { name: 'saveHouseholdContact', load: async () => (await p('householdContacts')).saveHouseholdContactHandler, data: { name: 'Neighbour Jo' }, expect: HOUSEHOLD },

  { name: 'archiveKin', load: async () => (await p('kinWrites')).archiveKinHandler, data: { kinId: 'kin1', reason: 'noLongerWithUs' }, expect: NOT_HERS },
  { name: 'removeHouseholdContact', load: async () => (await p('householdContacts')).removeHouseholdContactHandler, data: { contactId: 'c1' }, expect: NOT_HERS },
  { name: 'addSecondaryContact', load: async () => (await p('addSecondaryContact')).addSecondaryContactHandler, data: { invitedEmail: 'jo@example.com' }, expect: NOT_HERS },
  { name: 'sendKinfolkMessage', load: async () => (await p('sendKinfolkMessage')).sendKinfolkMessageHandler, data: { body: 'hello' }, expect: NOT_HERS },
  { name: 'getMyConversation', load: async () => (await p('sendKinfolkMessage')).getMyConversationHandler, data: {}, expect: NOT_HERS },
  { name: 'markThreadRead', load: async () => (await p('sendKinfolkMessage')).markThreadReadHandler, data: {}, expect: NOT_HERS },
  { name: 'generate', load: async () => (await p('generate')).generateHandler, data: { mode: 'polish', body: 'hello' }, expect: NOT_HERS },
  { name: 'requestBookingCancellation', load: async () => (await p('requestBookingCancellation')).requestBookingCancellationHandler, data: { batchId: 'b1', visitId: 'v1' }, expect: NOT_HERS },
  { name: 'requestBookingReschedule', load: async () => (await p('requestBookingReschedule')).requestBookingRescheduleHandler, data: { batchId: 'b1', visitId: 'v1', proposedStartTimeMs: FUTURE }, expect: NOT_HERS },

  { name: 'getMyInvoices', load: async () => (await p('getMyInvoices')).getMyInvoicesHandler, data: {}, expect: MONEY },
  { name: 'getMyInvoicePdf', load: async () => (await p('getMyInvoicePdf')).getMyInvoicePdfHandler, data: { invoiceId: 'inv1' }, expect: MONEY },
  { name: 'getMyHome', load: async () => (await p('getMyHome')).getMyHomeHandler, data: {}, expect: MONEY },
];

async function run(c: Case, who: Caller): Promise<{ err: { code?: string; message?: string } | null }> {
  const handler = await c.load();
  // The owner holds no tribes of her own, so she names one; everyone else
  // omits it, which is the call the one-tribe rule used to refuse.
  const data = who === 'owner' ? { ...c.data, kinfolkId: 'k1' } : c.data;
  try {
    await handler({ auth: AUTH[who], data } as never);
    return { err: null };
  } catch (e) {
    return { err: e as { code?: string; message?: string } };
  }
}

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.resolved.length = 0;
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(fixture());
});

describe('#984 the allowlist matches the table below', () => {
  it('lists exactly the household callables an Auntie is admitted to', () => {
    for (const c of CASES) {
      const admitted = c.expect.auntie2 === 'staff';
      expect({ name: c.name, listed: AUNTIE_ALLOWED_CALLABLES.has(c.name) }).toEqual({ name: c.name, listed: admitted });
    }
  });
});

describe.each(CASES)('#984 $name', (c) => {
  it.each(CALLERS)('%s', async (who) => {
    const want = c.expect[who];
    const { err } = await run(c, who);

    if (want === 'caretaker') {
      expect(err).toMatchObject({ code: 'permission-denied', message: CARETAKER_MESSAGE });
      // Refused before a household was ever resolved, so no tribe count
      // could have been what decided it.
      expect(mocks.resolved).toEqual([]);
      return;
    }
    if (want === 'multi') {
      expect(err).toMatchObject({ code: 'failed-precondition' });
      expect(err?.message).toMatch(/Multiple tribes/);
      expect(mocks.resolved).toEqual([]);
      return;
    }
    // Through the gate, on the expected branch, for tribe k1.
    expect(mocks.resolved[0]).toEqual({ kinfolkId: 'k1', isOperator: want === 'staff' });
    if (err) {
      expect(err.message).not.toBe(CARETAKER_MESSAGE);
      expect(err.message ?? '').not.toMatch(/Multiple tribes|No tribes linked|do not have access to this tribe/);
      expect(err.code).not.toBe('permission-denied');
    }
  });
});

/**
 * The money callables that do not go through resolveKinfolkAccess. Each reads
 * `clients/{uid}.kinfolkIds` itself and checks the invoice or household is in
 * it, so before #984 an Auntie assigned the household got straight through.
 */
describe('#984 money callables with their own household check refuse an Auntie by role', () => {
  const OWN_GATE: Array<{ name: string; load: () => Promise<Handler>; data: Record<string, unknown> }> = [
    { name: 'payInvoice', load: async () => (await p('payInvoice')).payInvoiceHandler, data: { invoiceId: 'inv1' } },
    { name: 'redeemCredit', load: async () => (await p('redeemCredit')).redeemCreditHandler, data: { invoiceId: 'inv1' } },
    { name: 'acceptQuote', load: async () => (await p('quoteDecision')).acceptQuoteHandler, data: { invoiceId: 'inv1' } },
    { name: 'denyQuote', load: async () => (await p('quoteDecision')).denyQuoteHandler, data: { invoiceId: 'inv1' } },
    { name: 'getMyPaymentMethod', load: async () => (await p('billing')).getMyPaymentMethodHandler, data: {} },
    { name: 'createBillingSetupSession', load: async () => (await p('billing')).createBillingSetupSessionHandler, data: {} },
    { name: 'syncMyPaymentMethod', load: async () => (await p('billing')).syncMyPaymentMethodHandler, data: {} },
    { name: 'removeMyPaymentMethod', load: async () => (await p('billing')).removeMyPaymentMethodHandler, data: {} },
    { name: 'requestBooking', load: async () => (await p('requestBooking')).requestBookingHandler, data: {} },
  ];

  describe.each(OWN_GATE)('$name', (c) => {
    it.each(['auntie1', 'auntie2'] as const)('%s is refused before any read', async (who) => {
      const handler = await c.load();
      await expect(handler({ auth: AUTH[who], data: c.data } as never)).rejects.toMatchObject({
        code: 'permission-denied',
        message: CARETAKER_MESSAGE,
      });
      expect(mocks.dbFn).not.toHaveBeenCalled();
    });

    it.each(['owner', 'kin1', 'kin2'] as const)('%s is not stopped by the caretaker refusal', async (who) => {
      const handler = await c.load();
      let message = '';
      try {
        await handler({ auth: AUTH[who], data: c.data } as never);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe(CARETAKER_MESSAGE);
    });
  });
});

/** A token carrying both claims gets the Auntie boundary, as in wrapAdminCallable. */
describe('#984 a double-claimed token', () => {
  const both = { uid: 'auntie-two', token: { admin: true, staffRole: 'auntie' } };
  it('is refused a money callable', async () => {
    const { getMyInvoicesHandler } = await p('getMyInvoices');
    await expect(getMyInvoicesHandler({ auth: both, data: {} } as never)).rejects.toMatchObject({
      message: CARETAKER_MESSAGE,
    });
  });
  it('is admitted as staff to an allowlisted household callable', async () => {
    const { listHouseholdContactsHandler } = await p('householdContacts');
    await listHouseholdContactsHandler({ auth: both, data: {} } as never);
    expect(mocks.resolved[0]).toEqual({ kinfolkId: 'k1', isOperator: true });
  });
});

/**
 * Docket Q1, operator ruling 2026-09-27: "Auntie never uses the portal. Refuse
 * her at portal sign-in with a clear message." Outside of kinfolk, only the
 * owner uses the portal.
 *
 * getMyAccess is the first callable both portal clients make after sign-in.
 * It refuses an Auntie with a tagged reason the clients turn into a sign-out
 * and a notice on the sign-in screen. The owner and kinfolk see no change.
 */
describe('Q1 getMyAccess refuses an Auntie at portal sign-in', () => {
  const load = async () => (await p('getMyAccess')).getMyAccessHandler as Handler;
  it.each(['auntie1', 'auntie2'] as const)('%s is refused with the portal reason, before any read', async (who) => {
    const handler = await load();
    const err = await handler({ auth: AUTH[who], data: {} } as never).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string; details?: { reason?: string } },
    );
    expect(err).toMatchObject({ code: 'permission-denied', details: { reason: 'caretaker-not-portal' } });
    // The Android client matches on message text, so the token rides there too.
    expect(err?.message).toContain('caretaker-not-portal');
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });
  it('a double-claimed token is refused too', async () => {
    const handler = await load();
    await expect(
      handler({ auth: { uid: 'auntie-two', token: { admin: true, staffRole: 'auntie' } }, data: {} } as never),
    ).rejects.toMatchObject({ code: 'permission-denied', details: { reason: 'caretaker-not-portal' } });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });
  it('the owner keeps the operator directory', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'clients/owner-1': {} },
        queryDocs: { kinfolk: [{ id: 'k1', data: {} }, { id: 'k2', data: {} }] },
      }).db,
    );
    const handler = await load();
    const res = (await handler({ auth: AUTH.owner, data: {} } as never)) as { kinfolkIds: string[]; isOperator: boolean };
    expect(res.isOperator).toBe(true);
    expect([...res.kinfolkIds].sort()).toEqual(['k1', 'k2']);
  });
  it('a kinfolk with one tribe gets it', async () => {
    const handler = await load();
    await expect(handler({ auth: AUTH.kin1, data: {} } as never)).resolves.toEqual({ kinfolkIds: ['k1'], isOperator: false });
  });
  it('a kinfolk with two tribes still gets both (the client owns the one-tribe error)', async () => {
    const handler = await load();
    await expect(handler({ auth: AUTH.kin2, data: {} } as never)).resolves.toEqual({
      kinfolkIds: ['k1', 'k2'],
      isOperator: false,
    });
  });
});
/**
 * Docket Q1: the portal-only callables that never went through
 * resolveKinfolkAccess. Each refuses an Auntie by role before it reads
 * anything. #984 had left several of these acting as the household for an
 * Auntie holding one tribe (setActiveTribe, getMyAccount, submitRating, the
 * kin photo upload pair), and acceptInvite would have linked her to a
 * household as a member.
 *
 * Not here on purpose, because an admin client calls them: registerFcmToken,
 * getFeatureFlags, getBreeds, getFormSchema, mapboxSearch/Retrieve,
 * markNotificationRead and the other notification callables, and the
 * KinTale engagement trio (below). signOutAllDevices is never refused.
 */
describe('Q1 portal-only callables refuse an Auntie by role', () => {
  const m = (path: string) => import(`../src/${path}`);
  const PORTAL_ONLY: Array<{ name: string; load: () => Promise<Handler>; data: Record<string, unknown> }> = [
    { name: 'setActiveTribe', load: async () => (await p('setActiveTribe')).setActiveTribeHandler, data: { kinfolkId: 'k1' } },
    { name: 'getMyAccount', load: async () => (await p('account')).getMyAccountHandler, data: {} },
    { name: 'saveMyAccount', load: async () => (await p('account')).saveMyAccountHandler, data: {} },
    { name: 'submitRating', load: async () => (await p('submitRating')).submitRatingHandler, data: { visitId: 'v1', stars: 5 } },
    { name: 'signKinPhotoUpload', load: async () => (await p('signKinPhotoUpload')).signKinPhotoUploadHandler, data: { kinId: 'kin1' } },
    { name: 'confirmKinPhotoUpload', load: async () => (await p('signKinPhotoUpload')).confirmKinPhotoUploadHandler, data: { kinId: 'kin1' } },
    { name: 'signKinfolkAvatar', load: async () => (await p('signKinfolkAvatar')).signKinfolkAvatarHandler, data: {} },
    { name: 'dismissBanner', load: async () => (await p('dismissBanner')).dismissBannerHandler, data: { bannerId: 'b1' } },
    { name: 'getMyNotificationPrefs', load: async () => (await p('notificationPrefs')).getMyNotificationPrefsHandler, data: {} },
    { name: 'saveMyNotificationPrefs', load: async () => (await p('notificationPrefs')).saveMyNotificationPrefsHandler, data: {} },
    { name: 'getBookingPolicy', load: async () => (await p('getBookingPolicy')).getBookingPolicyHandler, data: {} },
    { name: 'getServiceCatalog', load: async () => (await p('getServiceCatalog')).getServiceCatalogHandler, data: {} },
    { name: 'getBusinessClosures', load: async () => (await p('getBusinessClosures')).getBusinessClosuresHandler, data: {} },
    { name: 'getBusinessContact', load: async () => (await p('getBusinessContact')).getBusinessContactHandler, data: {} },
    { name: 'getVetClinics', load: async () => (await p('getVetClinics')).getVetClinicsHandler, data: {} },
    { name: 'getInvitePreview', load: async () => (await p('getInvitePreview')).getInvitePreviewHandler, data: { inviteId: 'i1' } },
    { name: 'getNotificationCatalog', load: async () => (await m('notifications/getNotificationCatalog')).getNotificationCatalogHandler, data: {} },
    { name: 'revokeShareLink', load: async () => (await m('share/revokeShareLink')).revokeShareLinkHandler, data: { shareId: 's1' } },
    { name: 'acceptInvite', load: async () => (await m('membership/acceptInvite')).acceptInviteHandler, data: { inviteId: 'i1' } },
    { name: 'updateSecondaryPermissions', load: async () => (await m('membership/updateSecondaryPermissions')).updateSecondaryPermissionsHandler, data: {} },
  ];
  it('none of them is on the allowlist', () => {
    for (const c of PORTAL_ONLY) expect({ name: c.name, listed: AUNTIE_ALLOWED_CALLABLES.has(c.name) }).toEqual({ name: c.name, listed: false });
  });
  describe.each(PORTAL_ONLY)('$name', (c) => {
    it.each(['auntie1', 'auntie2'] as const)('%s is refused before any read', async (who) => {
      const handler = await c.load();
      await expect(handler({ auth: AUTH[who], data: c.data } as never)).rejects.toMatchObject({
        code: 'permission-denied',
        message: CARETAKER_MESSAGE,
      });
      expect(mocks.dbFn).not.toHaveBeenCalled();
    });
    it.each(['owner', 'kin1'] as const)('%s is not stopped by the caretaker refusal', async (who) => {
      const handler = await c.load();
      let message = '';
      try {
        await handler({ auth: AUTH[who], data: c.data } as never);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe(CARETAKER_MESSAGE);
    });
  });
});
/**
 * Docket Q1: the KinTale engagement callables live in portal/ but the admin
 * web KinTale detail calls all three, so they gate on householdStaffFlag
 * instead of the raw `admin` claim. The raw claim sent an Auntie into the
 * kinfolk branch, where one assigned tribe let her comment and react as that
 * household. Now: addKinTaleComment (allowlisted) resolves her as staff; the
 * reaction pair (not allowlisted) refuses her.
 */
describe('Q1 KinTale engagement never lets an Auntie act as the household', () => {
  const eng = async () => import('../src/portal/kinTaleEngagement');
  const withTale = () =>
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'kin_care_reports/t1': { kinfolkId: 'k1' },
          'clients/auntie-one': { kinfolkIds: ['k1'] },
          'clients/kin-one': { kinfolkIds: ['k1'] },
        },
      }).db,
    );
  it.each(['getKinTaleReactionHandler', 'toggleKinTaleLoveHandler'] as const)('%s refuses an Auntie holding the tale\'s tribe', async (fn) => {
    withTale();
    const handler = (await eng())[fn] as Handler;
    await expect(handler({ auth: AUTH.auntie1, data: { taleId: 't1' } } as never)).rejects.toMatchObject({
      code: 'permission-denied',
      message: CARETAKER_MESSAGE,
    });
  });
  it.each(['getKinTaleReactionHandler', 'toggleKinTaleLoveHandler'] as const)('%s still serves the kinfolk', async (fn) => {
    withTale();
    const handler = (await eng())[fn] as Handler;
    await expect(handler({ auth: AUTH.kin1, data: { taleId: 't1' } } as never)).resolves.toHaveProperty('loved');
  });
  it('addKinTaleComment files an Auntie\'s comment as staff, not as the household', async () => {
    withTale();
    const { addKinTaleCommentHandler } = await eng();
    const db = mocks.dbFn();
    const add = vi.fn().mockResolvedValue({ id: 'c1' });
    const realCollection = db.collection.bind(db);
    db.collection = (path: string) => (path === 'kin_care_reports/t1/comments' ? { add } : realCollection(path));
    mocks.dbFn.mockReturnValue(db);
    await addKinTaleCommentHandler({ auth: AUTH.auntie1, data: { taleId: 't1', body: 'Walked well today.' } } as never).catch(() => undefined);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ authorUid: 'auntie-one', authorRole: 'admin' }));
  });
});
/**
 * Docket Q1: Storage rules had no caretaker exclusion on `isKinfolk()`, so an
 * Auntie holding exactly one tribe (and so a minted `role: 'kinfolk'` claim)
 * could read and write that household's kin photos, profile image and KinTale
 * media as the household. There is no Storage emulator suite in this repo, so
 * the rule text is pinned here; `firestore.rules:isKinfolk()` already carries
 * the same exclusion and `test/rules/auntieAccess.test.ts` covers that one.
 */
describe('Q1 storage.rules: a caretaker is never kinfolk', () => {
  it('isKinfolk() excludes staffRole auntie', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const rules = readFileSync(resolve(__dirname, '../../storage.rules'), 'utf8');
    const fn = rules.slice(rules.indexOf('function isKinfolk()'), rules.indexOf('function ownsKinfolk('));
    expect(fn).toContain("request.auth.token.role == 'kinfolk'");
    expect(fn).toMatch(/!\(\s*'staffRole' in request\.auth\.token && request\.auth\.token\.staffRole == 'auntie'\s*\)/);
  });
});
