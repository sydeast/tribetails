import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';
/**
 * #2281 third review: WHAT A LATE SECOND CALL SENDS AFTER THE SWEEP, WITH THE
 * DISPATCHER RUN FOR REAL.
 *
 * `paymentRace.test.ts` stubs the dispatcher, so it pins what `recordPayment`
 * asks for. Here `enqueueNotificationDetailed` and `deliverListedCopy` are the
 * real ones over the same mock database: the dedupe ledger, the records and
 * the work orders are what the functions actually wrote. A work order
 * (`notificationDispatch/{id}`) is what sends an email, so "nothing was sent"
 * is asserted as "no work order was written".
 *
 * The flow each case starts from: an older two-call admin build pays a $40
 * invoice off (`markInvoicePaid`) and stops. The sweep writes the ledger row,
 * lists the payoff for the household's billing member (no email) and tells the
 * office. Then the second call arrives with Send Confirmation ticked.
 */
const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  billingUid: { current: 'kinUid' as string | null },
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => hooks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  ...(await vi.importActual<object>('../src/lib/writeAuditEntry')),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({
  resolveBillingRecipientUid: async () => hooks.billingUid.current,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => undefined,
    },
  };
});
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { recordPaymentHandler } from '../src/admin/recordPayment';
import { sweepAbandonedSettlements, settlementLedgerRowId } from '../src/lib/settlementLedgerSweep';
import { SETTLEMENT_LEDGER_SWEEP_GRACE_MS } from '../src/lib/paymentAppliedOwner';
type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;
let ctx: ReturnType<typeof buildDbMock>;
const KEY = 'invoice.payment.applied';
const IPAY = 'ipay_1763000000001_abc121';
const PAY = 'pay_1763000000001_def451';
const SETTLE_ROW = settlementLedgerRowId(IPAY);
beforeEach(() => {
  hooks.billingUid.current = 'kinUid';
  docs = {
    'invoices/inv1': {
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      status: 'open',
      invoiceNumber: '1029',
      total: 40,
      totalCents: 4000,
      amountDue: 40,
      amountDueCents: 4000,
    },
    'families/fam1': { accountBalanceCents: 0 },
    'businessSettings/admins': { uids: ['office1'] },
  };
  ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
});
function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}
const live = (prefix: string) =>
  Object.entries(docs).filter(([p, d]) => d != null && new RegExp(`^${prefix}/[^/]+$`).test(p)) as [
    string,
    Record<string, any>,
  ][];
/** Notifications list entries for this payment's notice, by recipient. */
const recordsFor = (uid: string) => live('notifications').filter(([, d]) => d.key === KEY && d.recipientUid === uid);
/** Work orders: each one is a send on a channel. */
const ordersFor = (uid: string) => live('notificationDispatch').filter(([, d]) => d.key === KEY && d.recipientUid === uid);
const ledgerRows = () => live('payments').map(([p]) => p);
const step1 = () =>
  markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'venmo', reference: 'VN-9', idempotencyKey: IPAY }));
const step2 = (over: Record<string, unknown> = {}) =>
  recordPaymentHandler(
    req({
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      date: '2026-11-13',
      paymentMethod: 'venmo',
      referenceNumber: 'VN-9',
      amount: 45,
      tip: 5,
      fee: 1.5,
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      settledByInvoicePaymentId: IPAY,
      sendConfirmationEmail: true,
      idempotencyKey: PAY,
      ...over,
    }),
  );
const sweep = () => sweepAbandonedSettlements(ctx.db as never, Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000);
/** The old build pays the invoice off and stops; the sweep finishes it. */
async function sweptPayoff() {
  await step1();
  expect(await sweep()).toBe(1);
  // What the sweep told: the household's list only, and the office by email.
  expect(recordsFor('kinUid')).toHaveLength(1);
  expect(ordersFor('kinUid')).toEqual([]);
  expect(recordsFor('office1')).toHaveLength(1);
  expect(ordersFor('office1')).toHaveLength(1);
  expect(docs[`payments/${SETTLE_ROW}`]).toMatchObject({ confirmationAppOnly: true, officeNoticeSentAt: '__TS__' });
}
/** Nobody has been told anything more than the sweep told them. */
function expectNothingNewSent() {
  expect(recordsFor('kinUid')).toHaveLength(1);
  expect(ordersFor('kinUid')).toEqual([]);
  expect(recordsFor('office1')).toHaveLength(1);
  expect(ordersFor('office1')).toHaveLength(1);
}
describe('#2281 third review: a ticked late second call after the sweep, real dispatcher', () => {
  it('emails the listed payoff once: one work order on the sweep\'s own list entry, nothing new for the office', async () => {
    await sweptPayoff();
    const listed = recordsFor('kinUid')[0]![0].split('/')[1];
    const first = await step2();
    expect(first).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false, officeNoticePending: false });
    expect(ordersFor('kinUid').map(([p]) => p)).toEqual([`notificationDispatch/${listed}`]);
    expect(ordersFor('kinUid')[0]![1]).toMatchObject({ notificationId: listed, channels: ['email'], status: 'pending' });
    expect(recordsFor('kinUid')).toHaveLength(1);
    expect(recordsFor('office1')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
    expect(ledgerRows()).toEqual([`payments/${PAY}`]);
    expect(docs[`payments/${PAY}`]).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
  });
  it('a second call with the same key sends nothing', async () => {
    await sweptPayoff();
    const first = await step2();
    const snapshot = JSON.stringify([live('notifications'), live('notificationDispatch')]);
    expect(await step2()).toEqual(first);
    expect(await step2()).toEqual(first);
    expect(JSON.stringify([live('notifications'), live('notificationDispatch')])).toBe(snapshot);
    expect(ordersFor('kinUid')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
    // Nor does a later sweep run.
    expect(await sweep()).toBe(0);
    expect(JSON.stringify([live('notifications'), live('notificationDispatch')])).toBe(snapshot);
  });
  it('an unticked late call sends nothing at all', async () => {
    await sweptPayoff();
    const first = await step2({ sendConfirmationEmail: false });
    expectNothingNewSent();
    expect(first).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
  });
  it('the operator switched this notification off: nothing is sent, and the answer does not blame the household', async () => {
    await sweptPayoff();
    docs['businessSettings/notifications'] = { byKey: { [KEY]: { enabled: false } } };
    const first = await step2();
    expectNothingNewSent();
    expect(first).toMatchObject({ confirmationEmailSent: false });
    // The clients print `confirmationAppOnly` as "email and text are off for
    // this household". That is not why, so it is left out and they say the
    // confirmation email did not go out.
    expect(first).not.toHaveProperty('confirmationAppOnly');
    expect(ledgerRows()).toEqual([`payments/${PAY}`]);
    // Switched back on, the same submission pressed again sends it, once.
    delete docs['businessSettings/notifications'];
    expect(await step2()).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    expect(ordersFor('kinUid')).toHaveLength(1);
    await step2();
    expect(ordersFor('kinUid')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
  });
  it('the household send gate is shut: nothing is sent, and the answer says the email did not go', async () => {
    await sweptPayoff();
    docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { householdNotificationsLive: false };
    const first = await step2();
    expectNothingNewSent();
    expect(first).toMatchObject({ confirmationEmailSent: false });
    expect(first).not.toHaveProperty('confirmationAppOnly');
    expect(docs[`payments/${PAY}`]).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
  });
  it('the household turned every channel off: nothing is sent, and the answer says app only', async () => {
    await sweptPayoff();
    docs['clients/kinUid'] = { notificationPrefs: { byKey: { [KEY]: { email: false, sms: false, push: false } } } };
    const first = await step2();
    expectNothingNewSent();
    expect(first).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
  });
  it('the billing member changed since the sweep: nothing is sent to either member, and the answer says the email did not go', async () => {
    await sweptPayoff();
    hooks.billingUid.current = 'kinUid2';
    const first = await step2();
    // The member the sweep listed it for gets no email, and the new member gets
    // neither a list entry nor an email for a copy that is not theirs.
    expectNothingNewSent();
    expect(recordsFor('kinUid2')).toEqual([]);
    expect(ordersFor('kinUid2')).toEqual([]);
    expect(first).toMatchObject({ confirmationEmailSent: false, householdNoPortalAccount: false });
    expect(first).not.toHaveProperty('confirmationAppOnly');
    // A retry changes nothing.
    expect(await step2()).toEqual(first);
    expectNothingNewSent();
    expect(recordsFor('kinUid2')).toEqual([]);
    expect(ledgerRows()).toEqual([`payments/${PAY}`]);
  });
  it('the household has no portal account by the time of the late call: nothing is sent', async () => {
    await sweptPayoff();
    hooks.billingUid.current = null;
    const first = await step2();
    expectNothingNewSent();
    expect(first).toMatchObject({ confirmationEmailSent: false });
    expect(first).not.toHaveProperty('confirmationAppOnly');
  });
  it('a copy the sweep sent and could not stamp is not sent again, to the household or the office', async () => {
    await sweptPayoff();
    // The sweep's stamps on its row were lost; the dispatcher's ledger still has both copies.
    delete docs[`payments/${SETTLE_ROW}`]!.confirmationAppOnly;
    delete docs[`payments/${SETTLE_ROW}`]!.officeNoticeSentAt;
    const first = await step2();
    // No second list entry and no second office copy. The ticked email goes
    // out once, on the sweep's list entry.
    expect(recordsFor('kinUid')).toHaveLength(1);
    expect(recordsFor('office1')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
    expect(ordersFor('kinUid')).toHaveLength(1);
    expect(first).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    await step2();
    expect(ordersFor('kinUid')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
  });
  it('that lost stamp and a changed billing member together: the new member is sent the confirmation the admin ticked, the office is not told twice', async () => {
    // A double fault, pinned so the behaviour is a decision and not an accident.
    // With the sweep's stamps gone the call cannot know a household copy was
    // ever written, so it sends the ticked confirmation to the billing member
    // as of now. The ledger is per recipient, so that member's copy is new.
    await sweptPayoff();
    delete docs[`payments/${SETTLE_ROW}`]!.confirmationAppOnly;
    delete docs[`payments/${SETTLE_ROW}`]!.officeNoticeSentAt;
    hooks.billingUid.current = 'kinUid2';
    const first = await step2();
    expect(recordsFor('kinUid2')).toHaveLength(1);
    expect(ordersFor('kinUid2')).toHaveLength(1);
    expect(first).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    // The first member keeps the list entry and is not emailed; the office has one copy.
    expect(recordsFor('kinUid')).toHaveLength(1);
    expect(ordersFor('kinUid')).toEqual([]);
    expect(recordsFor('office1')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
    await step2();
    expect(recordsFor('kinUid2')).toHaveLength(1);
    expect(ordersFor('kinUid2')).toHaveLength(1);
    expect(ordersFor('office1')).toHaveLength(1);
  });
});
