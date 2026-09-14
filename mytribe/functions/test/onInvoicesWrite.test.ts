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

describe('resolveLifecycle', () => {
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

  it('fires invoice.overdue when an invoice becomes past due', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ kinfolkId: '3', status: 'open', amountDue: 40 }, { kinfolkId: '3', status: 'past_due', amountDue: 40 }) as any,
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].key).toBe('invoice.overdue');
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

  it('never lets a notice owner silence invoice.overdue', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent(
        { kinfolkId: '3', status: 'open', amountDue: 40 },
        { kinfolkId: '3', status: 'past_due', amountDue: 40, paymentAppliedNoticeOwner: 'recordPayment:p1' },
      ) as any,
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].key).toBe('invoice.overdue');
  });

  it('skips dispatch when kinfolkId is missing on the doc', async () => {
    const { onInvoicesWriteHandler } = await import('../src/triggers/onInvoicesWrite');
    await onInvoicesWriteHandler(
      makeEvent({ status: 'open', amountDue: 40 }, { status: 'paid', amountDue: 0 }) as any,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
