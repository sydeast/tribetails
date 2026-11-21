import { describe, it, expect } from 'vitest';
import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';
import {
  PaymentSubmissionKey,
  answerIsThisEntry,
  paymentFigures,
  paymentLandedCheck,
  paymentMayHaveLanded,
} from './paymentSubmissionKey';

function minter() {
  let n = 0;
  return () => `pay_${1_700_000_000_000 + n++}_abcdef`;
}
const figures = (amount: string, extra: Partial<Record<'tip' | 'fee' | 'total' | 'credit', string>> = {}) =>
  paymentFigures({ amount, tip: '', fee: '', total: '', credit: '', ...extra });

describe('PaymentSubmissionKey (#2297)', () => {
  it('keeps one key for a re-press of the same figures', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    expect(keys.keyFor('inv1', figures('20'))).toBe(first);
    expect(keys.keyFor('inv1', figures(' 20 '))).toBe(first);
  });

  it('keeps the key when a money figure changes before any answer, so an earlier press still committing cannot land beside a second one', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    expect(keys.keyFor('inv1', figures('25'))).toBe(first);
    expect(keys.keyFor('inv1', figures('25', { tip: '5', credit: '3', fee: '1' }))).toBe(first);
  });

  it('keeps an unanswered key across a new opening of the form', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    keys.open();
    expect(keys.keyFor('inv1', figures('20'))).toBe(first);
  });

  it('never carries a key to another invoice', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    expect(keys.keyFor('inv2', figures('20'))).not.toBe(first);
  });

  it('lets the key go on an answer, so the same figures next time are a new payment', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    expect(keys.settle(false, true)).toBe('recorded');
    expect(keys.current).toBeNull();
    expect(keys.keyFor('inv1', figures('20'))).not.toBe(first);
  });

  it('lets the key go on release', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor('inv1', figures('20'));
    keys.release();
    expect(keys.current).toBeNull();
    expect(keys.keyFor('inv1', figures('20'))).not.toBe(first);
  });

  it('reads a replay of the same figures in the same opening as this entry, the retry after a lost reply', () => {
    const keys = new PaymentSubmissionKey(minter());
    keys.open();
    keys.keyFor('inv1', figures('20'));
    keys.keyFor('inv1', figures('20'));
    expect(keys.settle(true, true)).toBe('recorded');
  });

  it('reads a replay as an earlier entry when the figures changed under the key and the row has other money', () => {
    const keys = new PaymentSubmissionKey(minter());
    keys.open();
    keys.keyFor('inv1', figures('20'));
    keys.keyFor('inv1', figures('25'));
    expect(keys.settle(true, false)).toBe('earlier');
    expect(keys.current).toBeNull();
  });
  it('reads a replay carrying this press\'s money as this entry, after the figures changed under the key', () => {
    // The $20.00 press was refused or never arrived; the $25.00 press wrote
    // the row and its answer was lost.
    const keys = new PaymentSubmissionKey(minter());
    keys.open();
    keys.keyFor('inv1', figures('20'));
    keys.keyFor('inv1', figures('25'));
    expect(keys.settle(true, true)).toBe('recorded');
  });

  it('reads a replay as an earlier entry when the key came from an earlier opening, same figures or not', () => {
    const keys = new PaymentSubmissionKey(minter());
    keys.open();
    keys.keyFor('inv1', figures('20'));
    keys.open();
    keys.keyFor('inv1', figures('20'));
    expect(keys.settle(true, true)).toBe('earlier');
  });

  it('reads a first-time answer under a changed figure as this entry: nothing was on record under the key', () => {
    const keys = new PaymentSubmissionKey(minter());
    keys.keyFor('inv1', figures('20'));
    keys.open();
    keys.keyFor('inv1', figures('25'));
    expect(keys.settle(false, false)).toBe('recorded');
  });
});

describe('answerIsThisEntry (#2297)', () => {
  const answer = { amountCents: 2500, tipCents: 500, feeCents: 100, appliedCents: 2000, creditedToAccountCents: 0 };
  const sent = { amountCents: 2500, tipCents: 500, feeCents: 100, appliedCents: 2000, creditCents: 0 };
  it('matches when every figure sent is the figure on the row', () => {
    expect(answerIsThisEntry(answer, sent)).toBe(true);
  });
  it('differs when any one figure differs', () => {
    expect(answerIsThisEntry(answer, { ...sent, amountCents: 2000 })).toBe(false);
    expect(answerIsThisEntry(answer, { ...sent, tipCents: 0 })).toBe(false);
    expect(answerIsThisEntry(answer, { ...sent, feeCents: 0 })).toBe(false);
    expect(answerIsThisEntry(answer, { ...sent, appliedCents: 2500 })).toBe(false);
    expect(answerIsThisEntry(answer, { ...sent, creditCents: 300 })).toBe(false);
  });
  it('leaves out a figure the server works out (a blank Amount)', () => {
    expect(answerIsThisEntry(answer, { ...sent, amountCents: null, tipCents: null, appliedCents: null })).toBe(true);
    expect(answerIsThisEntry(answer, { ...sent, amountCents: null, appliedCents: null, feeCents: 0 })).toBe(false);
  });
});
describe('paymentMayHaveLanded (#2297)', () => {
  it('is false for the server refusing the request', () => {
    for (const code of ['functions/invalid-argument', 'functions/failed-precondition', 'permission-denied']) {
      expect(paymentMayHaveLanded(Object.assign(new Error('no'), { code }))).toBe(false);
    }
  });
  it('is true for a failure that cannot say whether the write committed', () => {
    for (const code of ['functions/internal', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/unknown']) {
      expect(paymentMayHaveLanded(Object.assign(new Error('?'), { code }))).toBe(true);
    }
    expect(paymentMayHaveLanded(new Error('no code at all'))).toBe(true);
    expect(paymentMayHaveLanded(null)).toBe(true);
  });
});

describe('paymentLandedCheck (#2297)', () => {
  const ledger = (ids: string[]) =>
    ({ ledgerPayments: ids.map((paymentId) => ({ paymentId })) }) as unknown as GetInvoiceLedgerResult;
  it('says yes when the key is a row of the invoice ledger', async () => {
    const r = await paymentLandedCheck(() => Promise.resolve(ledger(['other', 'pay_1_a'])), 'pay_1_a');
    expect(r.landed).toBe('yes');
    expect(r.ledger).not.toBeNull();
  });
  it('says no when it is not', async () => {
    const r = await paymentLandedCheck(() => Promise.resolve(ledger(['other'])), 'pay_1_a');
    expect(r.landed).toBe('no');
  });
  it('says unknown when the read fails', async () => {
    const r = await paymentLandedCheck(() => Promise.reject(new Error('offline')), 'pay_1_a');
    expect(r).toEqual({ landed: 'unknown', ledger: null });
  });
});
