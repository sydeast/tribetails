import { describe, it, expect } from 'vitest';

import {
  creditApplicationLines,
  creditGivenNotice,
  creditStatusLine,
  creditUseLine,
  formatCreditDate,
  giveCreditConfirmLine,
  parseGiveCreditForm,
} from './accountCreditFormat';

const SEP_27 = new Date(2026, 8, 27, 12).getTime();
const OCT_3 = new Date(2026, 9, 3, 12).getTime();

function credit(over: Partial<Parameters<typeof creditStatusLine>[0]> = {}) {
  return {
    creditId: 'crd_1',
    amountCents: 2500,
    reason: 'Missed visit',
    givenAtMs: SEP_27,
    remainingCents: 2500,
    fullyAppliedAtMs: null,
    applications: [],
    ...over,
  };
}

describe('parseGiveCreditForm', () => {
  it('reads dollars into cents and trims the reason', () => {
    expect(parseGiveCreditForm('$25.00', '  Missed visit ')).toEqual({ ok: true, amountCents: 2500, reason: 'Missed visit' });
    expect(parseGiveCreditForm('1,250.5', 'r')).toEqual({ ok: true, amountCents: 125050, reason: 'r' });
  });

  it.each([
    ['blank', ''],
    ['words', 'twenty'],
    ['three decimals', '12.345'],
    ['negative', '-5'],
  ])('refuses an amount that is %s', (_l, amount) => {
    expect(parseGiveCreditForm(amount, 'reason')).toMatchObject({ ok: false });
  });

  it('refuses zero', () => {
    expect(parseGiveCreditForm('0.00', 'reason')).toEqual({ ok: false, error: 'Enter an amount above $0.00.' });
  });

  it('refuses a cent over $5,000.00 and accepts exactly $5,000.00', () => {
    expect(parseGiveCreditForm('5000.01', 'reason')).toEqual({
      ok: false,
      error: 'The most one credit can be is $5,000.00.',
    });
    expect(parseGiveCreditForm('5000', 'reason')).toMatchObject({ ok: true, amountCents: 500000 });
  });

  it('refuses a blank or overlong reason', () => {
    expect(parseGiveCreditForm('10', '   ')).toMatchObject({ ok: false });
    expect(parseGiveCreditForm('10', 'x'.repeat(1001))).toMatchObject({ ok: false });
  });
});

describe('history lines', () => {
  it('formats a date as the rest of the admin does', () => {
    expect(formatCreditDate(SEP_27)).toBe('Sep 27, 2026');
  });

  it('a credit not used yet', () => {
    expect(creditStatusLine(credit())).toBe('Not used yet');
    expect(creditApplicationLines(credit())).toEqual([]);
  });

  it('a credit spent in one go shows the date applied, and no extra lines', () => {
    const c = credit({
      remainingCents: 0,
      fullyAppliedAtMs: OCT_3,
      applications: [{ appliedAtMs: OCT_3, amountCents: 2500, invoiceId: 'i', invoiceNumber: 'INV-1009' }],
    });
    expect(creditStatusLine(c)).toBe('Applied Oct 3, 2026');
    expect(creditApplicationLines(c)).toEqual([]);
  });

  it('a credit partly spent shows how much and each use', () => {
    const c = credit({
      remainingCents: 1500,
      applications: [{ appliedAtMs: OCT_3, amountCents: 1000, invoiceId: 'i', invoiceNumber: null }],
    });
    expect(creditStatusLine(c)).toBe('$10.00 of $25.00 applied');
    expect(creditApplicationLines(c)).toEqual(['$10.00 on an invoice, Oct 3, 2026']);
  });

  it('a use line names the invoice', () => {
    expect(
      creditUseLine({ useId: 'd', usedAtMs: OCT_3, amountCents: 2500, invoiceId: 'i', invoiceNumber: 'INV-1009' }),
    ).toBe('$25.00 on INV-1009, Oct 3, 2026');
  });

  it('the confirmation shows the balance before and after', () => {
    expect(giveCreditConfirmLine(2500, 1200)).toBe('Give $25.00 credit? Balance goes from $12.00 to $37.00.');
  });

  it('the notice repeats the server figure', () => {
    expect(creditGivenNotice(3700)).toBe('Credit given. Balance is now $37.00.');
  });
});
