import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  enqueueNotification: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueueNotification }));

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  // A household WITH a portal account by default: the confirmation path's happy
  // case. The no-account case overrides this per test.
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueueNotification.mockReset().mockResolvedValue(undefined);
  (writeAuditEntry as any).mockClear();
});

function req(
  data: unknown,
  uid: string | null = 'admin1',
  token: Record<string, unknown> = { admin: true },
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(opts: { invoice?: Record<string, unknown> | null; subPayments?: any[] } = {}) {
  return buildDbMock({
    docs: {
      'invoices/inv1':
        opts.invoice === undefined
          ? { kinfolkId: 'fam1', status: 'open', total: 127.5, invoiceNumber: '1029' }
          : opts.invoice,
    },
    queryDocs: { 'invoices/inv1/payments': opts.subPayments ?? [] },
  });
}

function paymentWriteOf(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find((w) => w.path.startsWith('payments/'));
}

const fullArgs = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Riveras',
  client: 'Ana Rivera',
  address: '12 Elm St',
  date: '2026-07-28',
  paymentMethod: 'venmo',
  referenceNumber: 'VN-42',
  email: 'ana@example.com',
  amount: 40,
  tip: 5,
  notes: 'July visits',
  invoiceId: 'inv1',
  invoiceNumber: 'INV-9',
};

describe('recordPayment happy path', () => {
  it('creates the root payments row with every field plus recordedBy/createdAt', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(fullArgs));
    expect(res.ok).toBe(true);
    expect(res.paymentId).toBeTruthy();
    expect(res.kinfolkId).toBe('fam1');
    const w = paymentWriteOf(ctx);
    expect(w?.data).toMatchObject({ ...fullArgs, recordedBy: 'admin1', createdAt: '__TS__' });
    // No `id` field inside the doc: android's @DocumentId never serialized one.
    expect(w?.data).not.toHaveProperty('id');
  });

  it('defaults every omitted legacy field, so a minimal standalone payment validates', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ amount: 25 }));
    expect(res.ok).toBe(true);
    const w = paymentWriteOf(ctx);
    expect(w?.data).toMatchObject({
      kinfolkId: '', kinfolkName: '', client: '', address: '', date: '',
      paymentMethod: '', referenceNumber: '', email: '', amount: 25, tip: 0,
      notes: '', invoiceId: '', invoiceNumber: '',
    });
  });

  it('writes the BILLING_PAYMENT_RECORDED audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req(fullArgs));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_PAYMENT_RECORDED',
        targetCollection: 'payments',
        familyId: 'fam1',
        payload: expect.objectContaining({
          invoiceId: 'inv1',
          amount: 40,
          tip: 5,
          method: 'venmo',
          reference: 'VN-42',
          testMode: false,
        }),
      }),
    );
  });
});

describe('recordPayment TestMode scoping (server-side, replacing the client-side copy)', () => {
  const testToken = { testTribeId: 'test-kinfolk-001' };

  it("stamps the sandbox kinfolkId no matter what the caller sent", async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req({ ...fullArgs, kinfolkId: 'fam1' }, 'testuser1', testToken),
    );
    expect(res.kinfolkId).toBe('test-kinfolk-001');
    expect(paymentWriteOf(ctx)?.data.kinfolkId).toBe('test-kinfolk-001');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'test-kinfolk-001',
        payload: expect.objectContaining({ testMode: true }),
      }),
    );
  });

  it('staff keep the kinfolkId they sent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(fullArgs));
    expect(res.kinfolkId).toBe('fam1');
  });

  it('staff carrying a stray test claim stay UNSCOPED (rules precedence: isAuntie() wins)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req(fullArgs, 'admin1', { admin: true, testTribeId: 'test-kinfolk-001' }),
    );
    expect(res.kinfolkId).toBe('fam1');
  });
});

describe('recordPayment gate + validation', () => {
  it('refuses an unauthenticated call', async () => {
    await expect(recordPaymentHandler(req({ amount: 1 }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a caller with neither the admin claim nor a test claim', async () => {
    await expect(recordPaymentHandler(req({ amount: 1 }, 'someone', {}))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('a blank testTribeId claim does NOT half-enable the sandbox path', async () => {
    await expect(
      recordPaymentHandler(req({ amount: 1 }, 'someone', { testTribeId: '   ' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a malformed request', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const bad of [
      {},
      { amount: -1 },
      { amount: 'forty' },
      { amount: 40, tip: -1 },
      { amount: 40, kinfolkId: 'x'.repeat(121) },
    ]) {
      await expect(recordPaymentHandler(req(bad))).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(ctx.writes).toEqual([]);
  });
});
/**
 * ── THE 2026-08-04 FEE / APPLY / AUTO-APPLY TRANCHE ────────────────────────
 *
 * Everything below is new surface on the same callable. The cases above are
 * unchanged and still pass, which is the point: every new request field is
 * optional with a default, so the payload the React admin and Android already
 * send behaves exactly as it did.
 */
/** Invoice #1029 as she keys it: $137.50 in, $10 gross tip, $2.71 processor fee. */
const feeArgs = {
  kinfolkId: 'fam1',
  amount: 137.5,
  tip: 10,
  fee: 2.71,
  paymentMethod: 'venmo',
  referenceNumber: 'VN-1029',
  invoiceId: 'inv1',
  invoiceNumber: '1029',
};
describe('recordPayment: the fee, and the gross tip beside it', () => {
  it('stores the fee in BOTH denominations, like every other money field here', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req(feeArgs));
    // The cents are the truth; the dollar float is the projection the legacy
    // PDF and the Android join read. Written from one figure in one pass.
    expect(paymentWriteOf(ctx)?.data).toMatchObject({ fee: 2.71, feeCents: 271 });
  });
  it('STAMPS tipBasis gross, which is what makes the stored tip readable at all', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(feeArgs));
    expect(paymentWriteOf(ctx)?.data.tipBasis).toBe('gross');
    expect(res.tipBasis).toBe('gross');
  });
  it('returns the row invoice #1029 could not produce: gross tip, fee, net, proceeds', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ ...feeArgs, apply: { invoiceId: 'inv1', amount: 127.5 } }));
    expect(res.amountCents).toBe(13750);
    expect(res.tipCents).toBe(1000);
    expect(res.feeCents).toBe(271);
    // The $7.29 the legacy system stored, now DERIVED rather than stored.
    expect(res.tipNetCents).toBe(729);
    // What she actually banks.
    expect(res.proceedsCents).toBe(13479);
    // amount = applied + tipGross, and it closes.
    expect(res.appliedCents + res.tipCents + res.unappliedCents).toBe(res.amountCents);
    expect(res.unappliedCents).toBe(0);
  });
  it('defaults the fee to zero, so an untouched form is not a $NaN row', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ amount: 25 }));
    expect(res.feeCents).toBe(0);
    expect(paymentWriteOf(ctx)?.data).toMatchObject({ fee: 0, feeCents: 0 });
  });
  it('REFUSES a tip larger than the payment, rather than storing a negative balance', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(recordPaymentHandler(req({ amount: 10, tip: 15 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses a negative fee at validation rather than storing one', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(recordPaymentHandler(req({ amount: 40, fee: -1 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
describe('recordPayment: the Apply box', () => {
  it('settles the invoice and writes the row the BALANCE is derived from', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req({ ...feeArgs, apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 127.5 } }),
    );
    expect(res.application).toMatchObject({
      invoiceId: 'inv1',
      appliedCents: 12750,
      state: 'settled',
      amountDueCents: 0,
    });
    // THE MONEY AUTHORITY, not the display row.
    const sub = ctx.writes.find((w) => w.path.startsWith('invoices/inv1/payments/'));
    expect(sub?.data).toMatchObject({ amountCents: 12750, amount: 127.5, method: 'venmo' });
    // And the link back, so one Venmo transfer does not read as two payments.
    expect(sub?.data.sourcePaymentId).toBe(res.paymentId);
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(inv?.data).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });
  it('records which invoice the money went on, for the Applied-to column', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(
      req({ ...feeArgs, apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 127.5 } }),
    );
    // `appliedInvoiceNumber` is denormalized from the INVOICE DOC, not echoed
    // from the request: the doc is the authority on what an invoice is called,
    // and a caller that sent the wrong number must not get it stored back.
    expect(paymentWriteOf(ctx)?.data).toMatchObject({
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1029',
      appliedCents: 12750,
    });
  });
  it('TOUCHES NO BALANCE when apply is omitted, which is every existing caller', async () => {
    // The React admin sets `invoiceId` on a row it writes AFTER markInvoicePaid
    // has already settled the invoice. If that field applied money, that flow
    // would collect twice.
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(feeArgs));
    expect(res.application).toBeNull();
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/'))).toHaveLength(0);
    expect(res.appliedCents).toBe(0);
  });
  it('REFUSES an apply larger than the payment has left, and writes NOTHING', async () => {
    // The whole form comes back for her to correct, not a stored payment whose
    // apply silently did not happen.
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      recordPaymentHandler(req({ ...feeArgs, apply: { invoiceId: 'inv1', amount: 137.5 } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses an apply against a draft, and writes nothing', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'draft', total: 127.5 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      recordPaymentHandler(req({ ...feeArgs, apply: { invoiceId: 'inv1', amount: 100 } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });
  it("refuses an apply against another household's invoice", async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam2', status: 'open', total: 127.5 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      recordPaymentHandler(req({ ...feeArgs, apply: { invoiceId: 'inv1', amount: 100 } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses an apply against an invoice that does not exist', async () => {
    const ctx = seed({ invoice: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      recordPaymentHandler(req({ ...feeArgs, apply: { invoiceId: 'inv1', amount: 100 } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
describe('recordPayment: Auto-apply routes the leftover into the EXISTING credit ledger', () => {
  /** $300 in, $180 applied, no tip: $120 left over. */
  const leftoverArgs = {
    kinfolkId: 'fam1',
    amount: 300,
    invoiceId: 'inv1',
    apply: { invoiceId: 'inv1', amount: 180 },
  };
  it('credits families/{id}.accountBalanceCents, not a second ledger of its own', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 180 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ ...leftoverArgs, autoApply: true }));
    expect(res.unappliedCents).toBe(12000);
    expect(res.creditedToAccountCents).toBe(12000);
    const fam = ctx.writes.find((w) => w.path === 'families/fam1');
    // An INCREMENT, so two payments in the same second cannot lose a credit.
    expect(fam?.data.accountBalanceCents).toEqual({ __increment: 12000 });
  });
  it('leaves the balance alone when auto-apply is OFF, and says so', async () => {
    // The leftover is still reported. What differs is what was DONE with it.
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 180 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(leftoverArgs));
    expect(res.unappliedCents).toBe(12000);
    expect(res.creditedToAccountCents).toBe(0);
    expect(ctx.writes.find((w) => w.path === 'families/fam1')).toBeUndefined();
  });
  it('credits nothing when there is no leftover, however the box is set', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req({ ...feeArgs, autoApply: true, apply: { invoiceId: 'inv1', amount: 127.5 } }),
    );
    expect(res.unappliedCents).toBe(0);
    expect(res.creditedToAccountCents).toBe(0);
    expect(ctx.writes.find((w) => w.path === 'families/fam1')).toBeUndefined();
  });
  it('credits nothing on a standalone payment, which belongs to no household', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ amount: 300, autoApply: true }));
    expect(res.creditedToAccountCents).toBe(0);
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toHaveLength(0);
  });
  it('records the decision on the payment, so a reader can see why the credit exists', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 180 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req({ ...leftoverArgs, autoApply: true }));
    expect(paymentWriteOf(ctx)?.data).toMatchObject({ autoApply: true, unappliedCents: 12000 });
  });
});
describe('recordPayment: the Send Confirmation Email toggle', () => {
  it('enqueues the EXISTING invoice.payment.applied notification when asked', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ ...feeArgs, sendConfirmationEmail: true }));
    expect(res.confirmationEmailSent).toBe(true);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'invoice.payment.applied',
        recipientUid: 'kin-uid-1',
        data: expect.objectContaining({ kinfolkId: 'fam1', invoiceId: 'inv1' }),
      }),
    );
  });
  it('sends the HOUSEHOLD nothing by default: a message to a real person needs a deliberate tick', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(feeArgs));
    expect(res.confirmationEmailSent).toBe(false);
    // #866 operator ruling: the office keeps its "Invoice Paid" copy on every
    // path, so the notice is still enqueued, with no household recipient.
    expect(mocks.resolveKinfolkUid).not.toHaveBeenCalled();
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.payment.applied', recipientUid: '' }),
    );
  });
  it('sends no office copy for a standalone payment that names no invoice', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req({ ...feeArgs, invoiceId: '', invoiceNumber: '' }));
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });
  it('reports FALSE for a household with no portal account, without failing the payment', async () => {
    mocks.resolveKinfolkUid.mockResolvedValue(null);
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ ...feeArgs, sendConfirmationEmail: true }));
    expect(res.confirmationEmailSent).toBe(false);
    // The payment is still recorded. That is the fact; the mail is not.
    expect(paymentWriteOf(ctx)).toBeTruthy();
  });
  it('survives a dispatcher failure: the money has landed, so it must not throw', async () => {
    // Throwing here would offer a retry that collects a second time.
    mocks.enqueueNotification.mockRejectedValue(new Error('dispatcher down'));
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ ...feeArgs, sendConfirmationEmail: true }));
    expect(res.confirmationEmailSent).toBe(false);
    expect(res.paymentId).toBeTruthy();
  });
  it('names the APPLIED invoice in the confirmation, not merely the display link', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(
      req({
        ...feeArgs,
        invoiceId: 'inv-display-only',
        apply: { invoiceId: 'inv1', amount: 127.5 },
        sendConfirmationEmail: true,
      }),
    );
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invoiceId: 'inv1' }) }),
    );
  });
});
describe('recordPayment: staff notes stay staff-only', () => {
  it('stores the operator notes on the payment row', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req({ ...feeArgs, notes: 'took the fee out of the tip' }));
    expect(paymentWriteOf(ctx)?.data.notes).toBe('took the fee out of the tip');
  });
  it('keeps them OUT of the household confirmation payload', async () => {
    // The confirmation is the one thing here that reaches a kinfolk. Her notes
    // about a household must never ride along on it.
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(
      req({ ...feeArgs, notes: 'chases payment every month', sendConfirmationEmail: true }),
    );
    const call = mocks.enqueueNotification.mock.calls[0]![0];
    expect(JSON.stringify(call)).not.toContain('chases payment every month');
  });
});
