import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeTarget,
  findingOf,
  matchesFilter,
  OLD_BRANCH_MARKER,
  parseArgs,
  resolveTarget,
  totalCreditedCents,
} from '../reportDuplicateCheckoutCredits';

/**
 * Docket Q5's read-only report. It says which database it reads before it reads
 * one, cannot be pointed at production or the emulator by accident, has no
 * write mode, and prints no names.
 */
describe('reportDuplicateCheckoutCredits target resolution', () => {
  it('REFUSES --allow-prod under the emulator, naming the host', () => {
    expect(() =>
      resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8385/);
  });

  it('reads the emulator without --allow-prod, and refuses production without it', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8385',
      projectId: 'demo-report-q5',
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

describe('reportDuplicateCheckoutCredits is read-only, and prints nothing private', () => {
  const src = readFileSync(join(__dirname, '..', 'reportDuplicateCheckoutCredits.ts'), 'utf8');

  it('the source contains no write call at all', () => {
    for (const call of ['.set(', '.update(', '.delete(', '.add(', '.batch(', 'runTransaction(', '.create(']) {
      expect(src.includes(call), call).toBe(false);
    }
  });

  it('prints no name, email, address, note or reference', () => {
    const printed = src.split('\n').filter((l) => l.includes('console.log') || l.trim().startsWith('`'));
    for (const line of printed) {
      expect(line, line).not.toMatch(/kinfolkName|client\b|email|address|notes|referenceNumber/);
    }
  });

  it('selects on the marker the old webhook branch wrote, which the new branch does not', () => {
    expect(OLD_BRANCH_MARKER).toBe('accountCredit');
    const webhook = readFileSync(
      join(__dirname, '..', '..', 'functions', 'src', 'billing', 'stripeWebhook.ts'),
      'utf8',
    );
    expect(webhook).not.toMatch(/appliedTo: 'accountCredit'/);
    expect(webhook).toMatch(/appliedTo: 'unapplied'/);
  });
});

describe('reportDuplicateCheckoutCredits filter', () => {
  const credited = {
    kinfolkId: 'fam1',
    invoiceId: 'inv1',
    amount: 127.5,
    amountCents: 12750,
    amountResolved: true,
    appliedToInvoice: false,
    appliedTo: 'accountCredit',
    duplicateCheckoutReason: 'invoice-not-owed',
    duplicateOfPaymentIntentId: 'pi_first',
    stripeEventId: 'evt_2',
    referenceNumber: 'pi_second',
    date: '2026-09-01T10:00:00.000Z',
  };

  it('matches a row the old branch wrote', () => {
    expect(matchesFilter(credited)).toBe(true);
  });

  it('does not match the new unapplied row or an ordinary Stripe payment', () => {
    expect(matchesFilter({ ...credited, appliedTo: 'unapplied' })).toBe(false);
    expect(matchesFilter({ kinfolkId: 'fam1', invoiceId: 'inv1', amountCents: 100, paymentMethod: 'stripe' })).toBe(false);
  });

  it('reduces a row to ids, cents, reason and time', () => {
    expect(findingOf('evt_2', credited)).toEqual({
      paymentId: 'evt_2',
      stripeEventId: 'evt_2',
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      atMs: Date.parse('2026-09-01T10:00:00.000Z'),
      creditedCents: 12750,
      duplicateCheckoutReason: 'invoice-not-owed',
      duplicateOfPaymentIntentId: 'pi_first',
    });
  });

  it('a row with no Stripe amount credited nothing, and the total says so', () => {
    const none = findingOf('evt_3', { ...credited, amount: null, amountCents: null, amountResolved: false });
    expect(none.creditedCents).toBeNull();
    expect(totalCreditedCents([findingOf('evt_2', credited), none])).toBe(12750);
  });
});
