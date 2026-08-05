import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), drawAccountCredit: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/accountCredit', () => ({ drawAccountCredit: mocks.drawAccountCredit }));

import {
  AUTO_APPLY_ACTOR_UID,
  collectableForAutoApply,
  onInvoiceAutoApplyHandler,
} from '../src/triggers/onInvoiceAutoApply';

beforeEach(() => {
  mocks.dbFn.mockReset().mockReturnValue({});
  mocks.drawAccountCredit.mockReset().mockResolvedValue({
    invoiceId: 'inv1',
    skipped: null,
    appliedCents: 5000,
    accountBalanceCents: 0,
    amountDueCents: 0,
  });
});

/**
 * The automatic half of auto-apply, and the transition check that stops it
 * reacting to its own write.
 */

function event(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
) {
  return {
    params: { invoiceId: 'inv1' },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  } as any;
}

const OPEN = { kinfolkId: 'fam1', status: 'open', amountDue: 100 };
const DRAFT = { kinfolkId: 'fam1', status: 'draft', amountDue: 100 };

describe('collectableForAutoApply: what counts as a bill worth looking at', () => {
  it('counts an open invoice with a balance', () => {
    expect(collectableForAutoApply(OPEN)).toBe(true);
  });

  it('counts an invoice with NO stated balance, because that is not "nothing owed"', () => {
    // An un-itemized invoice can carry a `total` and no `amountDue` yet. The
    // pass resolves the real figure; this only decides whether to go and look.
    expect(collectableForAutoApply({ kinfolkId: 'fam1', status: 'open' })).toBe(true);
  });

  it('does not count a draft, a quote, a cancelled invoice, a credit or a paid one', () => {
    for (const status of ['draft', 'quote', 'cancelled', 'credit', 'paid', 'redeemed']) {
      expect(collectableForAutoApply({ ...OPEN, status }), status).toBe(false);
    }
  });

  it('does not count an invoice with nothing owed', () => {
    expect(collectableForAutoApply({ ...OPEN, amountDue: 0 })).toBe(false);
  });

  it('does not count a missing document', () => {
    expect(collectableForAutoApply(undefined)).toBe(false);
  });

  it('is case-insensitive about the stored status, which is unenforced free text', () => {
    expect(collectableForAutoApply({ ...OPEN, status: 'DRAFT' })).toBe(false);
    expect(collectableForAutoApply({ ...OPEN, status: ' Paid ' })).toBe(false);
  });
});

describe('onInvoiceAutoApply: it fires on the TRANSITION and nothing else', () => {
  it('runs when an invoice is created collectable', async () => {
    await onInvoiceAutoApplyHandler(event(undefined, OPEN));
    expect(mocks.drawAccountCredit).toHaveBeenCalledWith(expect.any(Object), {
      invoiceId: 'inv1',
      actorUid: AUTO_APPLY_ACTOR_UID,
    });
  });

  it('runs when a draft is reviewed and sent, which is the other way an invoice arrives', async () => {
    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));
    expect(mocks.drawAccountCredit).toHaveBeenCalledTimes(1);
  });

  it('DOES NOT run when the invoice was already collectable: the loop guard', async () => {
    // This is what stops the trigger reacting to its own write. Its write leaves
    // an invoice that was already collectable, so the next invocation lands here.
    await onInvoiceAutoApplyHandler(event(OPEN, { ...OPEN, amountDue: 50 }));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
  });

  it('does not run on the paid transition its own write causes', async () => {
    await onInvoiceAutoApplyHandler(event(OPEN, { ...OPEN, status: 'paid', amountDue: 0 }));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
  });

  it('does not run on a deleted document', async () => {
    await onInvoiceAutoApplyHandler(event(OPEN, undefined));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
  });

  it('does not run when a paid invoice is edited', async () => {
    const paid = { ...OPEN, status: 'paid', amountDue: 0 };
    await onInvoiceAutoApplyHandler(event(paid, { ...paid, invoiceNumber: '1030' }));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
  });

  it('stamps the write as the SYSTEM, never as whichever admin touched the invoice', async () => {
    await onInvoiceAutoApplyHandler(event(undefined, OPEN));
    expect(AUTO_APPLY_ACTOR_UID).toBe('system:auto-apply');
  });
});

describe('onInvoiceAutoApply: failure is logged, never rethrown', () => {
  it('swallows a pass that threw, because a retry could collect twice', async () => {
    // Firestore retries a trigger that throws. Retrying a money write whose
    // first attempt may have committed is worse than credit sitting unspent
    // until the operator runs the callable.
    mocks.drawAccountCredit.mockRejectedValue(new Error('firestore unavailable'));
    await expect(onInvoiceAutoApplyHandler(event(undefined, OPEN))).resolves.toBeUndefined();
  });

  it('accepts a skipped pass quietly, because doing nothing is a normal outcome', async () => {
    mocks.drawAccountCredit.mockResolvedValue({
      invoiceId: 'inv1',
      skipped: 'no_credit',
      appliedCents: 0,
      accountBalanceCents: 0,
      amountDueCents: 10000,
    });
    await expect(onInvoiceAutoApplyHandler(event(undefined, OPEN))).resolves.toBeUndefined();
  });
});
