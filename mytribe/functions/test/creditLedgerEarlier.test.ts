import { describe, it, expect } from 'vitest';

import {
  creditHistoryOf,
  creditInReason,
  earlierCreditOf,
  paymentCreditEventId,
  readCreditLedgerEvent,
  redeemedCreditEventId,
  stageCreditInEvent,
  type CreditLedgerEvent,
} from '../src/lib/creditLedger';

/**
 * #1939, #1969: the credit history must add up to the balance beside it.
 * Listed credits plus the earlier credit, less every use, is the balance.
 */

const given = (id: string, atMs: number, amountCents: number): CreditLedgerEvent => ({
  kind: 'given',
  id,
  atMs,
  amountCents,
  reason: 'why',
});
const draw = (id: string, atMs: number, amountCents: number, heldBeforeCents: number | null): CreditLedgerEvent => ({
  kind: 'draw',
  id,
  atMs,
  amountCents,
  invoiceId: `inv_${id}`,
  invoiceNumber: id,
  heldBeforeCents,
});

function addsUp(events: CreditLedgerEvent[], balanceCents: number): void {
  const h = creditHistoryOf(events);
  const e = earlierCreditOf(h, balanceCents);
  const listed = h.credits.reduce((s, c) => s + c.amountCents, 0);
  const used = h.uses.reduce((s, u) => s + u.amountCents, 0);
  const earlier = e.kind === 'pool' ? e.amountCents : 0;
  expect(listed + earlier - used).toBe(balanceCents);
}

describe('earlierCreditOf', () => {
  it('the walk household: $957.00 held, three uses and no listed credit is $2,015.00 earlier credit, $957.00 of it left', () => {
    const events = [
      draw('1020', 100, 105_000, 201_500),
      draw('1021', 200, 500, 96_500),
      draw('1023', 300, 300, 96_000),
    ];
    const h = creditHistoryOf(events);
    expect(earlierCreditOf(h, 95_700)).toEqual({ kind: 'pool', amountCents: 201_500, remainingCents: 95_700 });
    addsUp(events, 95_700);
  });

  it('the next invoice took the whole balance: all $2,015.00 is used and none is left', () => {
    const events = [
      draw('1020', 100, 105_000, 201_500),
      draw('1021', 200, 500, 96_500),
      draw('1023', 300, 300, 96_000),
      draw('1024', 400, 95_700, 95_700),
    ];
    const h = creditHistoryOf(events);
    expect(earlierCreditOf(h, 0)).toEqual({ kind: 'pool', amountCents: 201_500, remainingCents: 0 });
    addsUp(events, 0);
  });

  it('nothing to itemise when every credit is listed', () => {
    const events = [given('c1', 100, 2500), draw('d1', 200, 1000, 2500)];
    expect(earlierCreditOf(creditHistoryOf(events), 1500)).toEqual({ kind: 'none' });
    addsUp(events, 1500);
  });

  it('a household with no events and no balance has nothing to itemise', () => {
    expect(earlierCreditOf(creditHistoryOf([]), 0)).toEqual({ kind: 'none' });
  });

  it('a balance brought over with no events is all earlier credit, none of it used', () => {
    expect(earlierCreditOf(creditHistoryOf([]), 5000)).toEqual({ kind: 'pool', amountCents: 5000, remainingCents: 5000 });
  });

  it('earlier credit beside listed credit: FIFO spent the earlier pool first', () => {
    // $15.00 held before the log, then $20.00 given, then $25.00 drawn.
    const events = [given('c1', 100, 2000), draw('d1', 200, 2500, 3500)];
    const h = creditHistoryOf(events);
    // FIFO: $15.00 from the earlier pool, $10.00 from the given credit.
    expect(h.credits[0].remainingCents).toBe(1000);
    expect(earlierCreditOf(h, 1000)).toEqual({ kind: 'pool', amountCents: 1500, remainingCents: 0 });
    addsUp(events, 1000);
  });

  it('a balance below what listed credits still hold is a mismatch, never a row', () => {
    expect(earlierCreditOf(creditHistoryOf([given('c1', 100, 2500)]), 1000)).toEqual({
      kind: 'mismatch',
      amountCents: -1500,
      remainingCents: -1500,
    });
  });

  it('a negative balance with nothing listed is a mismatch', () => {
    expect(earlierCreditOf(creditHistoryOf([]), -300).kind).toBe('mismatch');
  });
});

describe('stageCreditInEvent', () => {
  function harness() {
    const calls: Array<{ path: string; data: any }> = [];
    const refOf = (path: string): any => ({
      path,
      collection: (c: string) => ({ doc: (d: string) => refOf(`${path}/${c}/${d}`) }),
    });
    const firestore: any = { collection: (c: string) => ({ doc: (d: string) => refOf(`${c}/${d}`) }) };
    const tx: any = { set: (ref: any, data: any) => calls.push({ path: ref.path, data }) };
    return { calls, firestore, tx };
  }

  it('a payment kept as credit is a given credit the history reads, keyed by the payment row', () => {
    const { calls, firestore, tx } = harness();
    stageCreditInEvent(firestore, tx, {
      kinfolkId: 'fam1',
      source: 'payment',
      sourceId: 'pay1',
      invoiceId: 'inv1',
      invoiceNumber: '1020',
      amountCents: 1500,
      actorUid: 'owner1',
      atMs: 77,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`families/fam1/creditLedger/${paymentCreditEventId('pay1')}`);
    expect(calls[0].data).toMatchObject({ kind: 'given', source: 'payment', amountCents: 1500, sourcePaymentId: 'pay1' });
    // No balance figures: the payment's own write increments the balance.
    expect(calls[0].data.balanceAfterCents).toBeUndefined();
    expect(readCreditLedgerEvent('payment_pay1', calls[0].data)).toEqual({
      kind: 'given',
      id: 'payment_pay1',
      amountCents: 1500,
      reason: 'From a payment on invoice 1020',
      atMs: 77,
    });
  });

  it('a redeemed credit invoice is keyed by the invoice, so it can be listed once', () => {
    const { calls, firestore, tx } = harness();
    stageCreditInEvent(firestore, tx, {
      kinfolkId: 'fam1',
      source: 'creditInvoice',
      sourceId: 'invC',
      invoiceId: 'invC',
      invoiceNumber: '1019',
      amountCents: 200_000,
      actorUid: 'kin1',
      atMs: 5,
    });
    expect(calls[0].path).toBe(`families/fam1/creditLedger/${redeemedCreditEventId('invC')}`);
    expect(calls[0].data).toMatchObject({ source: 'creditInvoice', reason: 'From the credit on invoice 1019' });
    expect(calls[0].data.sourcePaymentId).toBeUndefined();
  });

  it('writes nothing for no amount, no household or no source', () => {
    const { calls, firestore, tx } = harness();
    const base = {
      kinfolkId: 'fam1',
      source: 'payment' as const,
      sourceId: 'p',
      invoiceId: '',
      invoiceNumber: '',
      amountCents: 100,
      actorUid: 'o',
      atMs: 1,
    };
    stageCreditInEvent(firestore, tx, { ...base, amountCents: 0 });
    stageCreditInEvent(firestore, tx, { ...base, kinfolkId: '' });
    stageCreditInEvent(firestore, tx, { ...base, sourceId: '' });
    expect(calls).toHaveLength(0);
  });

  it('reasons with no invoice number stay plain', () => {
    expect(creditInReason('payment', '')).toBe('From a payment');
    expect(creditInReason('creditInvoice', '  ')).toBe('From a credit');
  });
});
