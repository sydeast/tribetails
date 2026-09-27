import { describe, it, expect } from 'vitest';

import {
  creditHistoryOf,
  readCreditLedgerEvent,
  type CreditLedgerEvent,
} from '../src/lib/creditLedger';

/**
 * Q6: "date applied" for a given credit is derived from the event log, by the
 * rule in `lib/creditLedger.ts`: untracked balance first, then given credits
 * oldest first. Every boundary of that rule is here.
 */

const given = (id: string, atMs: number, amountCents: number, reason = 'why'): CreditLedgerEvent => ({
  kind: 'given',
  id,
  atMs,
  amountCents,
  reason,
});
const draw = (
  id: string,
  atMs: number,
  amountCents: number,
  heldBeforeCents: number | null,
  invoiceNumber: string | null = 'INV-1',
): CreditLedgerEvent => ({
  kind: 'draw',
  id,
  atMs,
  amountCents,
  invoiceId: `inv_${id}`,
  invoiceNumber,
  heldBeforeCents,
});

describe('creditHistoryOf', () => {
  it('a credit nobody has used yet has no applied date and all of it left', () => {
    const h = creditHistoryOf([given('c1', 100, 2500)]);
    expect(h.credits).toEqual([
      {
        id: 'c1',
        amountCents: 2500,
        reason: 'why',
        givenAtMs: 100,
        remainingCents: 2500,
        applications: [],
        fullyAppliedAtMs: null,
      },
    ]);
    expect(h.uses).toEqual([]);
  });

  it('a draw that spends the whole credit stamps the date it was applied', () => {
    const h = creditHistoryOf([given('c1', 100, 2500), draw('d1', 200, 2500, 2500)]);
    expect(h.credits[0].remainingCents).toBe(0);
    expect(h.credits[0].fullyAppliedAtMs).toBe(200);
    expect(h.credits[0].applications).toEqual([
      { atMs: 200, amountCents: 2500, invoiceId: 'inv_d1', invoiceNumber: 'INV-1' },
    ]);
    expect(h.uses).toHaveLength(1);
  });

  it('a partial use records the use but leaves the applied date empty until the last cent goes', () => {
    const h = creditHistoryOf([
      given('c1', 100, 2500),
      draw('d1', 200, 1000, 2500),
      draw('d2', 300, 1500, 1500),
    ]);
    const c = h.credits[0];
    expect(c.applications.map((a) => [a.atMs, a.amountCents])).toEqual([
      [200, 1000],
      [300, 1500],
    ]);
    expect(c.fullyAppliedAtMs).toBe(300);

    const partial = creditHistoryOf([given('c1', 100, 2500), draw('d1', 200, 1000, 2500)]).credits[0];
    expect(partial.remainingCents).toBe(1500);
    expect(partial.fullyAppliedAtMs).toBeNull();
  });

  it('balance no given credit accounts for is spent first', () => {
    // $10 was already on account (an overpayment, or anything before Q6), then
    // $25 was given. A $15 draw spends the $10 first and $5 of the given credit.
    const h = creditHistoryOf([given('c1', 100, 2500), draw('d1', 200, 1500, 3500)]);
    expect(h.credits[0].applications).toEqual([
      { atMs: 200, amountCents: 500, invoiceId: 'inv_d1', invoiceNumber: 'INV-1' },
    ]);
    expect(h.credits[0].remainingCents).toBe(2000);
  });

  it('a draw covered entirely by untracked balance touches no given credit', () => {
    const h = creditHistoryOf([given('c1', 100, 2500), draw('d1', 200, 1000, 3500)]);
    expect(h.credits[0].applications).toEqual([]);
    expect(h.credits[0].remainingCents).toBe(2500);
    expect(h.uses).toHaveLength(1);
  });

  it('given credits are spent oldest first, and a draw can span two', () => {
    const h = creditHistoryOf([
      given('c1', 100, 1000, 'first'),
      given('c2', 150, 2000, 'second'),
      draw('d1', 200, 1500, 3000),
    ]);
    // Newest first in the answer.
    expect(h.credits.map((c) => c.id)).toEqual(['c2', 'c1']);
    const [second, first] = h.credits;
    expect(first.fullyAppliedAtMs).toBe(200);
    expect(first.applications[0].amountCents).toBe(1000);
    expect(second.remainingCents).toBe(1500);
    expect(second.applications[0].amountCents).toBe(500);
    expect(second.fullyAppliedAtMs).toBeNull();
  });

  it('a draw with no recorded balance before it treats untracked balance as empty', () => {
    const h = creditHistoryOf([given('c1', 100, 2500), draw('d1', 200, 1000, null)]);
    expect(h.credits[0].remainingCents).toBe(1500);
  });

  it('a draw larger than every open credit never takes a credit below zero', () => {
    const h = creditHistoryOf([given('c1', 100, 1000), draw('d1', 200, 5000, 1000)]);
    expect(h.credits[0].remainingCents).toBe(0);
    expect(h.credits[0].applications[0].amountCents).toBe(1000);
  });

  it('a credit given after a draw is not spent by that draw', () => {
    const h = creditHistoryOf([draw('d1', 100, 1000, 1000), given('c1', 200, 2500)]);
    expect(h.credits[0].applications).toEqual([]);
    expect(h.credits[0].remainingCents).toBe(2500);
  });

  it('orders by time whatever order the events arrive in', () => {
    const h = creditHistoryOf([draw('d1', 200, 2500, 2500), given('c1', 100, 2500)]);
    expect(h.credits[0].fullyAppliedAtMs).toBe(200);
  });

  it('lists every use newest first', () => {
    const h = creditHistoryOf([draw('d1', 100, 100, 500), draw('d2', 300, 100, 400)]);
    expect(h.uses.map((u) => u.id)).toEqual(['d2', 'd1']);
  });
});

describe('readCreditLedgerEvent', () => {
  it('reads a given event', () => {
    expect(readCreditLedgerEvent('c1', { kind: 'given', amountCents: 500, reason: 'r', atMs: 5 })).toEqual({
      kind: 'given',
      id: 'c1',
      amountCents: 500,
      reason: 'r',
      atMs: 5,
    });
  });

  it('reads a draw event', () => {
    expect(
      readCreditLedgerEvent('d1', {
        kind: 'draw',
        amountCents: 500,
        atMs: 5,
        invoiceId: 'inv1',
        invoiceNumber: null,
        heldBeforeCents: 900,
      }),
    ).toEqual({ kind: 'draw', id: 'd1', amountCents: 500, atMs: 5, invoiceId: 'inv1', invoiceNumber: null, heldBeforeCents: 900 });
  });

  it('skips anything it cannot read rather than guessing', () => {
    expect(readCreditLedgerEvent('x', { kind: 'given', amountCents: 0, atMs: 5 })).toBeNull();
    expect(readCreditLedgerEvent('x', { kind: 'given', amountCents: 500 })).toBeNull();
    expect(readCreditLedgerEvent('x', { kind: 'refund', amountCents: 500, atMs: 5 })).toBeNull();
    expect(readCreditLedgerEvent('x', { kind: 'draw', amountCents: '5', atMs: 5 })).toBeNull();
  });
});
