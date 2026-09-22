import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue([]),
  resolveUid: vi.fn().mockResolvedValue('recipient-uid'),
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));

beforeEach(() => {
  mocks.enqueue.mockClear();
  mocks.resolveUid.mockClear();
});

// Builds the firestore-trigger event envelope onDocumentWritten receives.
function makeEvent(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  invoiceId = 'inv-1',
) {
  return {
    params: { invoiceId },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  };
}

/**
 * #884: one doc per classifier state. `zero` is the $0 comped invoice, `quote`
 * the amount-less quote, `credit` the unlabeled negative-balance credit: the
 * three shapes the old `amountDue <= 0` rule announced as paid.
 */
const STATE_FIXTURES: Record<string, Record<string, unknown>> = {
  quote: { kinfolkId: '3', status: 'quote' },
  draft: { kinfolkId: '3', status: 'draft', amountDue: 40, total: 40 },
  cancelled: { kinfolkId: '3', status: 'cancelled', amountDue: 0, total: 40 },
  credit: { kinfolkId: '3', amountDue: -25, total: -25 },
  redeemed: { kinfolkId: '3', status: 'redeemed', amountDue: -25, total: -25, creditRedeemedAt: 'ts' },
  paid: { kinfolkId: '3', status: 'paid', amountDue: 0, total: 40 },
  zero: { kinfolkId: '3', status: 'open', amountDue: 0, total: 0 },
  open: { kinfolkId: '3', status: 'open', amountDue: 40, total: 40 },
};

function paidKeyCalls() {
  return mocks.enqueue.mock.calls.filter((c) => c[0].key === 'invoice.payment.applied').length;
}

describe('#884 invoice.payment.applied fires only on a transition from open into paid', () => {
  it('has one fixture per classifier state, and each fixture classifies as its own state', async () => {
    const { INVOICE_STATES, invoiceStateOf } = await import('../src/lib/invoiceEditPolicy');
    expect(Object.keys(STATE_FIXTURES).sort()).toEqual([...INVOICE_STATES].sort());
    for (const [state, doc] of Object.entries(STATE_FIXTURES)) expect(invoiceStateOf(doc)).toBe(state);
  });

  it('names open as the only state a paid notice may come from', async () => {
    const { PAYMENT_APPLIED_FROM_STATES } = await import('../src/triggers/onInvoicesWrite');
    expect([...PAYMENT_APPLIED_FROM_STATES]).toEqual(['open']);
  });

  for (const state of Object.keys(STATE_FIXTURES)) {
    it(`never fires when a doc is CREATED ${state}`, async () => {
      const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
      await onInvoicesWriteHandler(makeEvent(undefined, STATE_FIXTURES[state]) as any);
      expect(paidKeyCalls()).toBe(0);
    });
  }

  for (const from of Object.keys(STATE_FIXTURES)) {
    for (const to of Object.keys(STATE_FIXTURES)) {
      const fires = from === 'open' && to === 'paid';
      it(`${from} -> ${to} ${fires ? 'fires once' : 'does not fire'}`, async () => {
        const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
        await onInvoicesWriteHandler(makeEvent(STATE_FIXTURES[from], STATE_FIXTURES[to]) as any);
        expect(paidKeyCalls()).toBe(fires ? 1 : 0);
      });
    }
  }

  it('the issue cases: a $0 comped invoice, an amount-less quote and an unlabeled credit, created', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(makeEvent(undefined, { kinfolkId: '3', status: 'open', amountDue: 0, total: 0 }) as any);
    await onInvoicesWriteHandler(makeEvent(undefined, { kinfolkId: '3', status: 'quote' }) as any);
    await onInvoicesWriteHandler(makeEvent(undefined, { kinfolkId: '3', amountDue: -30, total: -30 }) as any);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('an open invoice edited down to $0 with nothing paid is zero, not paid, and sends nothing', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(STATE_FIXTURES.open, { kinfolkId: '3', status: 'zero', amountDue: 0, total: 0 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  for (const label of ['past_due', 'past due', 'Overdue']) {
    it(`a '${label}'-labelled invoice with a balance is open, so an unstamped write paying it off fires`, async () => {
      const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
      await onInvoicesWriteHandler(
        makeEvent({ kinfolkId: '3', status: label, amountDue: 40, total: 40 }, STATE_FIXTURES.paid) as any,
      );
      expect(paidKeyCalls()).toBe(1);
    });
  }

  it('an overdue-labelled invoice with a balance is open, so paying it off fires', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'overdue', amountDue: 40, total: 40 }, STATE_FIXTURES.paid) as any,
    );
    expect(paidKeyCalls()).toBe(1);
  });

  it('updateInvoice settling the balance by lowering the total stamps an owner, so nothing is sent', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(
        { ...STATE_FIXTURES.open, total: 100, amountDue: 40 },
        { ...STATE_FIXTURES.paid, total: 25, paymentAppliedNoticeOwner: 'updateInvoice:u1' },
      ) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('legacy: a total with no amountDue already reads paid, so paying it off is paid to paid and sends nothing', async () => {
    // The classifier's reading (ADR-0002): a missing balance is no evidence of
    // one. The old amountDue rule sent here; #884 does not add a second rule.
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', total: 40 }, { kinfolkId: '3', status: 'paid', total: 40, amountDue: 0 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('legacy: amountDue 0 with no total reads zero, so a later paid write from it sends nothing', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', amountDue: 0 }, { kinfolkId: '3', status: 'paid', amountDue: 0 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('#871: an overdue label with no amountDue sends nothing, and is never read as a payment', async () => {
    // invoiceStateOf reads `{ total: 40 }` with no amountDue as paid. #884's
    // precedence is kept: a write that labels the invoice past due is not a
    // payment. And since #871 the trigger does not send the overdue notice.
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(STATE_FIXTURES.open, { kinfolkId: '3', status: 'overdue', total: 40 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('#871: creating a doc labelled overdue sends nothing', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(makeEvent(undefined, { kinfolkId: '3', status: 'overdue', amountDue: 40 }) as any);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('resolveLifecycle (the overdue branch only since #884)', () => {
  it('treats explicit status=paid as paid', async () => {
    const { resolveLifecycle } = await import('../src/triggers/onInvoicesWrite');
    expect(resolveLifecycle({ status: 'paid', amountDue: 0 })).toBe('paid');
  });

  it('treats amountDue<=0 as paid even without a paid status', async () => {
    const { resolveLifecycle } = await import('../src/triggers/onInvoicesWrite');
    expect(resolveLifecycle({ status: 'open', amountDue: 0 })).toBe('paid');
  });

  it('does not treat a zero-balance draft or cancelled invoice as paid', async () => {
    const { resolveLifecycle } = await import('../src/triggers/onInvoicesWrite');
    expect(resolveLifecycle({ status: 'draft', amountDue: 0 })).toBe('other');
    expect(resolveLifecycle({ status: 'cancelled', amountDue: 0 })).toBe('other');
  });

  it('maps overdue / past due variants to past_due', async () => {
    const { resolveLifecycle } = await import('../src/triggers/onInvoicesWrite');
    expect(resolveLifecycle({ status: 'past_due', amountDue: 30 })).toBe('past_due');
    expect(resolveLifecycle({ status: 'Past Due', amountDue: 30 })).toBe('past_due');
    expect(resolveLifecycle({ status: 'overdue', amountDue: 30 })).toBe('past_due');
  });

  it('treats an open balance as other', async () => {
    const { resolveLifecycle } = await import('../src/triggers/onInvoicesWrite');
    expect(resolveLifecycle({ status: 'open', amountDue: 50 })).toBe('other');
    expect(resolveLifecycle(undefined)).toBe('other');
  });
});

describe('onInvoicesWrite dispatch', () => {
  it('fires invoice.payment.applied when an invoice becomes paid', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', amountDue: 40 }, { kinfolkId: '3', status: 'paid', amountDue: 0 }) as any,
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].key).toBe('invoice.payment.applied');
    expect(mocks.enqueue.mock.calls[0][0].data.kinfolkId).toBe('3');
  });

  it('#871: never sends invoice.overdue when an invoice is labelled past due (the cron is the one sender)', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', amountDue: 40 }, { kinfolkId: '3', status: 'past_due', amountDue: 40 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the lifecycle is unchanged', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', amountDue: 40 }, { kinfolkId: '3', status: 'open', amountDue: 35 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  // #866: a writer that owns its own confirmation stamps the invoice in the
  // write that pays it, and the trigger stands down for that write only.
  it('stays silent when the write that pays the invoice stamps a new notice owner', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(
        { kinfolkId: '3', status: 'open', amountDue: 40 },
        { kinfolkId: '3', status: 'paid', amountDue: 0, paymentAppliedNoticeOwner: 'stripe:evt_1' },
      ) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('still sends when the owner stamp is only left over from an earlier payment', async () => {
    // Paid by card (stamped), reopened by an edit, then paid off by account
    // credit, which stamps nothing. The trigger owns that notice.
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(
        { kinfolkId: '3', status: 'open', amountDue: 10, paymentAppliedNoticeOwner: 'stripe:evt_1' },
        { kinfolkId: '3', status: 'paid', amountDue: 0, paymentAppliedNoticeOwner: 'stripe:evt_1' },
      ) as any,
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].key).toBe('invoice.payment.applied');
  });

  it('#871: a past-due label with a notice owner stamp sends nothing at all', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(
        { kinfolkId: '3', status: 'open', amountDue: 40 },
        { kinfolkId: '3', status: 'past_due', amountDue: 40, paymentAppliedNoticeOwner: 'recordPayment:p1' },
      ) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('skips dispatch when kinfolkId is missing on the doc', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ status: 'open', amountDue: 40 }, { status: 'paid', amountDue: 0 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
