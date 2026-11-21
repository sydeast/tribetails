import { describe, it, expect } from 'vitest';
import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';
import {
  PaymentSubmissionKey,
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
    const first = keys.keyFor(figures('20'));
    expect(keys.keyFor(figures('20'))).toBe(first);
    expect(keys.keyFor(figures(' 20 '))).toBe(first);
  });
  it('mints a new key when a money figure changes', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor(figures('20'));
    expect(keys.keyFor(figures('25'))).not.toBe(first);
    const second = keys.current!;
    const third = keys.keyFor(figures('25', { tip: '5' }));
    expect(third).not.toBe(second);
    expect(keys.keyFor(figures('25', { tip: '5', credit: '3' }))).not.toBe(third);
  });
  it('holds a pinned key whatever the figures', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor(figures('20'));
    keys.pin();
    expect(keys.keyFor(figures('25'))).toBe(first);
    expect(keys.keyFor(figures('25', { fee: '1' }))).toBe(first);
  });
  it('lets the key go on release, so the same figures are a new payment', () => {
    const keys = new PaymentSubmissionKey(minter());
    const first = keys.keyFor(figures('20'));
    keys.pin();
    keys.release();
    expect(keys.current).toBeNull();
    expect(keys.keyFor(figures('20'))).not.toBe(first);
  });
  it('does nothing on pin with no key held', () => {
    const keys = new PaymentSubmissionKey(minter());
    keys.pin();
    expect(keys.current).toBeNull();
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
