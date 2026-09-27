import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeTarget,
  ledgerRowOf,
  overApplied,
  parseArgs,
  resolveTarget,
  settlementRowOf,
  wholeTransactionSettlement,
} from '../reportOverAppliedInvoices';

/**
 * #982's read-only report. It says which database it reads before it reads
 * one, cannot be pointed at production or the emulator by accident, has no
 * write mode, and prints no names.
 */
describe('reportOverAppliedInvoices target resolution', () => {
  it('REFUSES --allow-prod under the emulator, naming the host', () => {
    expect(() =>
      resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8385/);
  });

  it('reads the emulator without --allow-prod, and refuses production without it', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8385',
      projectId: 'demo-report-982',
    });
    expect(() => resolveTarget(parseArgs([]), {})).toThrow(/would read PRODUCTION/);
  });

  it('reading production needs a project id it will not guess', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow(/needs --project/);
    expect(resolveTarget(parseArgs(['--allow-prod', '--project', 'p1']), {})).toEqual({
      kind: 'production',
      projectId: 'p1',
    });
  });

  it('describes the target in one line', () => {
    expect(describeTarget({ kind: 'production', projectId: 'p1' })).toBe('Target: PRODUCTION, project p1');
  });

  it('has no apply flag: anything but --project and --allow-prod is refused', () => {
    for (const flag of ['--apply', '--write', '--fix', '--repair']) {
      expect(() => parseArgs([flag]), flag).toThrow(/unknown arg/);
    }
  });
});

describe('reportOverAppliedInvoices is read-only, and prints nothing private', () => {
  const src = readFileSync(join(__dirname, '..', 'reportOverAppliedInvoices.ts'), 'utf8');

  it('the source contains no write call at all', () => {
    for (const call of ['.set(', '.update(', '.delete(', '.add(', '.batch(', 'runTransaction(', '.create(']) {
      expect(src.includes(call), call).toBe(false);
    }
  });

  it('prints no name, email, address, note or reference', () => {
    const printed = src.split('\n').filter((l) => l.includes('console.log') || l.trim().startsWith('`'));
    for (const line of printed) {
      expect(line, line).not.toMatch(/kinfolkName|client\b|email|address|notes|reference/);
    }
  });
});

describe('reportOverAppliedInvoices classification', () => {
  const invoice = { kinfolkId: 'fam1', total: 127.5, totalCents: 12750, state: 'overpaid' };

  it('an Android settlement of amount plus tip is over the total, by the tip', () => {
    const settlements = [settlementRowOf('ipay_1', { amount: 137.5, amountCents: 13750 })];
    const f = overApplied('inv1', invoice, settlements);
    expect(f).toMatchObject({ invoiceId: 'inv1', kinfolkId: 'fam1', totalCents: 12750, paidCents: 13750, overCents: 1000 });
  });

  it('an exact settlement is not listed', () => {
    expect(overApplied('inv1', invoice, [settlementRowOf('ipay_1', { amountCents: 12750 })])).toBeNull();
  });

  it('sums settlement rows with the server rule: cents first, dollars for old rows', () => {
    const settlements = [settlementRowOf('a', { amount: 100 }), settlementRowOf('b', { amount: 1, amountCents: 3000 })];
    expect(overApplied('inv1', invoice, settlements)?.paidCents).toBe(13000);
  });

  it('marks the ledger row whose tip went onto the invoice with it', () => {
    const settlements = [settlementRowOf('ipay_1', { amountCents: 13750 })];
    const ledger = ledgerRowOf('pay_1', { amountCents: 13750, tipCents: 1000, feeCents: 271 });
    expect(wholeTransactionSettlement(ledger, settlements)).toBe('ipay_1');
  });

  it('does not mark a row with no tip, or one whose stored settlement differs', () => {
    const settlements = [settlementRowOf('ipay_1', { amountCents: 13750 })];
    expect(wholeTransactionSettlement(ledgerRowOf('pay_1', { amountCents: 13750, tipCents: 0 }), settlements)).toBeNull();
    expect(
      wholeTransactionSettlement(
        ledgerRowOf('pay_1', { amountCents: 13750, tipCents: 1000, settledByInvoicePaymentId: 'ipay_2' }),
        settlements,
      ),
    ).toBeNull();
  });

  it('reads a legacy ledger row in dollars', () => {
    expect(ledgerRowOf('pay_1', { amount: 137.5, tip: 10 })).toMatchObject({ amountCents: 13750, tipCents: 1000 });
  });
});
