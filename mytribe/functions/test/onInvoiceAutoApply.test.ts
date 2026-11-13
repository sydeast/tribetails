import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), drawAccountCredit: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/accountCredit', () => ({ drawAccountCredit: mocks.drawAccountCredit }));
import {
  AUTO_APPLY_ACTOR_UID,
  collectableForAutoApply,
  onInvoiceAutoApplyHandler,
} from '../src/triggers/onInvoiceAutoApply';
beforeEach(() => {
  mocks.dbFn.mockReset().mockReturnValue({});
  mocks.logEvent.mockReset();
  mocks.drawAccountCredit.mockReset();
});
/**
 * #1872, operator ruling 2026-11-11: ACCOUNT CREDIT IS NEVER SPENT
 * AUTOMATICALLY. This trigger used to draw a household's credit the moment an
 * invoice became collectable. It still deploys and still recognises that
 * moment, and it moves no money on any of them.
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

  /**
   * READER 3 of #902's shared rule. This predicate and `invoiceStateOf` used to
   * answer "what does a document with a `total` and no `amountDue` owe"
   * differently — collectable here, settled there — and a household's account
   * credit was spent on a bill their portal called paid. Both ask
   * `lib/amountDueRule.ts` now.
   */
  it('counts a migrated total-only bill: the rule says its total is owed', () => {
    expect(collectableForAutoApply({ kinfolkId: 'fam1', status: 'open', total: 40 })).toBe(true);
    expect(collectableForAutoApply({ kinfolkId: 'fam1', status: 'sent', totalCents: 4000 })).toBe(true);
  });
  it('CHANGED BY #902: an invoice stating no money at all is not collectable', () => {
    // It used to be, because "no `amountDue` field" was read as "go and look".
    // An invoice that names neither a balance nor a total is not a bill to spend
    // a household's credit against, and the pass refuses it on arrival anyway.
    expect(collectableForAutoApply({ kinfolkId: 'fam1', status: 'open' })).toBe(false);
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

const QUOTE = { kinfolkId: 'fam1', status: 'quote', amountDue: 100 };

describe('onInvoiceAutoApply: it never draws credit (#1872)', () => {
  it('does not draw when an invoice is created open', async () => {
    await onInvoiceAutoApplyHandler(event(undefined, OPEN));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });
  it('does not draw when a draft is reviewed and sent', async () => {
    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });
  it('does not draw when a household accepts a quote', async () => {
    await onInvoiceAutoApplyHandler(event(QUOTE, OPEN));
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });
  it('says so in the log on each of those, so the old firing points stay visible', async () => {
    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.autoapply.disabled', extra: { invoiceId: 'inv1' } }),
    );
  });
  it('stays silent on a write that is not a move into collectable', async () => {
    await onInvoiceAutoApplyHandler(event(OPEN, { ...OPEN, amountDue: 50 }));
    await onInvoiceAutoApplyHandler(event(OPEN, { ...OPEN, status: 'paid', amountDue: 0 }));
    await onInvoiceAutoApplyHandler(event(OPEN, undefined));
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.drawAccountCredit).not.toHaveBeenCalled();
  });
  it('keeps the system actor constant that older payment rows carry', () => {
    expect(AUTO_APPLY_ACTOR_UID).toBe('system:auto-apply');
  });
});
