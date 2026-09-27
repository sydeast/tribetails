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

/** Allowlisted household callables: an Auntie is staff whatever her tribe count. */
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
  { name: 'getMyKin', load: async () => (await p('getMyKin')).getMyKinHandler, data: {}, expect: HOUSEHOLD },
  { name: 'getMyKinTales', load: async () => (await p('getMyKinTales')).getMyKinTalesHandler, data: {}, expect: HOUSEHOLD },
  { name: 'getMyKinTaleMedia', load: async () => (await p('getMyKinTaleMedia')).getMyKinTaleMediaHandler, data: { taleId: 't1' }, expect: HOUSEHOLD },
  { name: 'getMyKinPhotos', load: async () => (await p('getMyKinPhotos')).getMyKinPhotosHandler, data: {}, expect: HOUSEHOLD },
  { name: 'getMyVisits', load: async () => (await p('getMyVisits')).getMyVisitsHandler, data: {}, expect: HOUSEHOLD },
  { name: 'getMyBookings', load: async () => (await p('getMyBookings')).getMyBookingsHandler, data: {}, expect: HOUSEHOLD },
  { name: 'getMyTribeProfile', load: async () => (await p('getMyTribeProfile')).getMyTribeProfileHandler, data: {}, expect: HOUSEHOLD },
  { name: 'saveTribeProfile', load: async () => (await p('saveTribeProfile')).saveTribeProfileHandler, data: { displayName: 'Park tribe' }, expect: HOUSEHOLD },
  { name: 'saveHomeAccess', load: async () => (await p('saveHomeAccess')).saveHomeAccessHandler, data: { gateCode: '1234' }, expect: HOUSEHOLD },
  { name: 'addKin', load: async () => (await p('kinWrites')).addKinHandler, data: { kin: { name: 'Biscuit' } }, expect: HOUSEHOLD },
  { name: 'updateKin', load: async () => (await p('kinWrites')).updateKinHandler, data: { kinId: 'kin1', kin: { name: 'Biscuit' } }, expect: HOUSEHOLD },
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
    const { getMyKinHandler } = await p('getMyKin');
    await getMyKinHandler({ auth: both, data: {} } as never);
    expect(mocks.resolved[0]).toEqual({ kinfolkId: 'k1', isOperator: true });
  });
});
