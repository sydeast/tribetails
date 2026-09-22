import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, planAmountDue } from '../backfillInvoiceAmountDue';

/**
 * #902's backfill: the pure decision for one invoice, and the flag precedence
 * that keeps a dry run a dry run.
 */
describe('backfillInvoiceAmountDue parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', allowProd: false });
  });

  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod'])).toMatchObject({ mode: 'apply', allowProd: true });
  });

  it('an explicit --dry-run beats --allow-prod in EITHER order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('refuses a flag as the value of --project, and an out-of-range page size', () => {
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project requires a value/);
    expect(() => parseArgs(['--page-size', '0'])).toThrow(/1\.\.1000/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('backfillInvoiceAmountDue planAmountDue', () => {
  it('writes the derived balance and the state stamp on a migrated bill', () => {
    const d = planAmountDue({ kinfolkId: 'fam1', status: 'sent', total: 40 }, []);
    expect(d).toEqual({
      action: 'write',
      update: { amountDue: 40, amountDueCents: 4000, status: 'open', editScope: 'all' },
      overpaidCents: 0,
    });
  });

  /**
   * THE WHOLE WRITE SET, asserted as an exact key list rather than a subset.
   *
   * These are MIGRATED records: they carry the dates of the system this one
   * replaced, and those dates are real information. A `updatedAt` or a
   * `serverTimestamp()` here would overwrite that history to note a housekeeping
   * write, so the set is pinned, and a new key has to be added here on purpose.
   */
  it('KEEPS THE ORIGINAL TIMESTAMPS: the write set is exactly four fields, none of them a date', () => {
    const d = planAmountDue({ kinfolkId: 'fam1', status: 'sent', total: 40, createdAt: 'orig', date: '2024-03-02' }, []);
    if (d.action !== 'write') throw new Error('expected write');
    expect(Object.keys(d.update).sort()).toEqual(['amountDue', 'amountDueCents', 'editScope', 'status']);
  });

  it('the source file contains no timestamp sentinel on the invoice write path', () => {
    // A belt-and-braces read of the script itself: `FieldValue.serverTimestamp()`
    // appears once, on the activity_log entry, and never on an invoice.
    const src = readFileSync(join(__dirname, '..', 'backfillInvoiceAmountDue.ts'), 'utf8');
    expect(src.match(/serverTimestamp\(\)/g) ?? []).toHaveLength(1);
    // A write key, not the word: the header and the --help text both say the
    // field is deliberately absent, and saying so must not fail this check.
    expect(src).not.toMatch(/updatedAt\s*:/);
    // The one `createdAt:` in the file is the activity_log entry's own, on the
    // same line as the only sentinel. No invoice write carries either.
    const createdAtLines = src.split('\n').filter((l) => /createdAt\s*:/.test(l));
    expect(createdAtLines).toHaveLength(1);
    expect(createdAtLines[0]).toMatch(/FieldValue\.serverTimestamp\(\)/);
  });

  it('subtracts the payment rows, and reports a part-collected bill honestly', () => {
    const d = planAmountDue({ status: 'sent', total: 40 }, [{ amountCents: 1500 }]);
    if (d.action !== 'write') throw new Error('expected write');
    expect(d.update).toEqual({ amountDue: 25, amountDueCents: 2500, status: 'open', editScope: 'all' });
  });

  it('SKIPS a document that already states a balance, zero included', () => {
    expect(planAmountDue({ status: 'open', total: 40, amountDue: 40 }, [])).toEqual({
      action: 'skip',
      reason: 'states_balance',
    });
    // `amountDue: 0` on a part-collected bill is the pre-2026-07-25 corruption.
    // `repairInvoicePayments` owns it; this script must not re-open it.
    expect(planAmountDue({ status: 'paid', total: 40, amountDue: 0 }, [{ amountCents: 2000 }])).toEqual({
      action: 'skip',
      reason: 'states_balance',
    });
  });

  it('SKIPS a document that states no money at all', () => {
    expect(planAmountDue({ status: 'sent' }, [])).toEqual({ action: 'skip', reason: 'no_total' });
    expect(planAmountDue({ status: 'sent', total: 0 }, [])).toEqual({ action: 'skip', reason: 'no_total' });
  });

  it('SKIPS a bill its rows already covered: writing zero would text the household about an old payment', () => {
    expect(planAmountDue({ kinfolkId: 'fam1', status: 'sent', total: 40 }, [{ amountCents: 4000 }])).toEqual({
      action: 'skip',
      reason: 'would_notify_household',
    });
  });

  it('NO REFUNDS AND NO MINTED CREDITS: an overdrawn bill is refused, and never derives a negative balance', () => {
    // It is refused by the notification guard (the rows settle it), so the
    // operator sees it; and even the figure it would have written is zero, not a
    // credit the household could redeem.
    expect(planAmountDue({ kinfolkId: 'fam1', status: 'sent', total: 40 }, [{ amountCents: 6000 }])).toEqual({
      action: 'skip',
      reason: 'would_notify_household',
    });
  });

  it('stamps a migrated draft or quote without turning it into a bill', () => {
    const draft = planAmountDue({ status: 'draft', total: 40 }, []);
    if (draft.action !== 'write') throw new Error('expected write');
    expect(draft.update).toEqual({ amountDue: 40, amountDueCents: 4000, status: 'draft', editScope: 'all' });
    const quote = planAmountDue({ status: 'quote', total: 40 }, []);
    if (quote.action !== 'write') throw new Error('expected write');
    expect(quote.update.status).toBe('quote');
  });

  it('IS IDEMPOTENT BY CONSTRUCTION: its own output is out of scope on the next run', () => {
    const before = { kinfolkId: 'fam1', status: 'sent', total: 40 };
    const first = planAmountDue(before, []);
    if (first.action !== 'write') throw new Error('expected write');
    const after = { ...before, ...first.update };
    expect(planAmountDue(after, [])).toEqual({ action: 'skip', reason: 'states_balance' });
  });

  it('a cancelled legacy bill derives nothing owed and keeps its own state', () => {
    const d = planAmountDue({ status: 'cancelled', total: 40 }, []);
    if (d.action !== 'write') throw new Error('expected write');
    expect(d.update).toEqual({ amountDue: 0, amountDueCents: 0, status: 'cancelled', editScope: 'none' });
  });
});
