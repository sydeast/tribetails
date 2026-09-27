import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeTarget,
  eraOf,
  findingOf,
  matchesFilter,
  parseArgs,
  resolveTarget,
} from '../reportAutoApplyDoubleCredit';

/**
 * #977's read-only report. It says which database it reads before it reads
 * one, cannot be pointed at production or the emulator by accident, has no
 * write mode, and prints no names.
 */
describe('reportAutoApplyDoubleCredit target resolution', () => {
  it('REFUSES --allow-prod under the emulator, naming the host', () => {
    expect(() =>
      resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8385/);
  });

  it('reads the emulator without --allow-prod, and refuses production without it', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8385',
      projectId: 'demo-report-977',
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

describe('reportAutoApplyDoubleCredit is read-only, and prints nothing private', () => {
  const src = readFileSync(join(__dirname, '..', 'reportAutoApplyDoubleCredit.ts'), 'utf8');

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
});

describe('reportAutoApplyDoubleCredit filter', () => {
  const preFix = {
    autoApply: true,
    appliedInvoiceId: '',
    invoiceId: 'inv1',
    kinfolkId: 'fam1',
    amountCents: 13750,
    tipCents: 1000,
    appliedCents: 0,
    unappliedCents: 12750,
    creditedToAccountCents: 12750,
  };

  it('matches the #977 shape: auto-applied, linked, applied nothing itself, credited', () => {
    expect(matchesFilter(preFix)).toBe(true);
    // appliedInvoiceId absent on older rows reads as blank.
    const { appliedInvoiceId: _a, ...noField } = preFix;
    expect(matchesFilter(noField)).toBe(true);
  });

  it('skips every row outside it', () => {
    expect(matchesFilter({ ...preFix, autoApply: false })).toBe(false);
    expect(matchesFilter({ ...preFix, appliedInvoiceId: 'inv1' })).toBe(false);
    expect(matchesFilter({ ...preFix, invoiceId: '  ' })).toBe(false);
    expect(matchesFilter({ ...preFix, invoiceId: undefined })).toBe(false);
    expect(matchesFilter({ ...preFix, creditedToAccountCents: 0 })).toBe(false);
    expect(matchesFilter({ ...preFix, creditedToAccountCents: undefined })).toBe(false);
  });

  it('labels a row with a stored settlement id post-fix, and one without pre-fix', () => {
    expect(eraOf(preFix)).toBe('pre-fix');
    expect(eraOf({ ...preFix, settledByInvoicePaymentId: 'ipay_1' })).toBe('post-fix');
  });

  it('reduces a row to ids, cents and a time', () => {
    const f = findingOf('pay_1', { ...preFix, createdAt: { toMillis: () => 1759000000000 }, kinfolkName: 'x' });
    expect(f).toEqual({
      paymentId: 'pay_1',
      era: 'pre-fix',
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      createdAtMs: 1759000000000,
      amountCents: 13750,
      tipCents: 1000,
      appliedCents: 0,
      unappliedCents: 12750,
      creditedToAccountCents: 12750,
      settledByInvoicePaymentId: '',
    });
  });
});
