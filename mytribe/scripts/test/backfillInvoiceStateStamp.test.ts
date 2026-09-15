import { describe, it, expect } from 'vitest';
import { parseArgs, planStamp, wouldNotifyHousehold } from '../backfillInvoiceStateStamp';

describe('backfillInvoiceStateStamp parseArgs', () => {
  it('defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
    expect(a.pageSize).toBe(300);
  });

  it('--allow-prod implies an apply run', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.mode).toBe('apply');
    expect(a.allowProd).toBe(true);
  });

  it('captures --project and --page-size', () => {
    const a = parseArgs(['--project', 'mytribe-test', '--page-size', '50']);
    expect(a.projectId).toBe('mytribe-test');
    expect(a.pageSize).toBe(50);
  });

  it('refuses a nonsense page size', () => {
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
    expect(() => parseArgs(['--page-size', 'lots'])).toThrow();
  });

  it('throws on unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // The one flag whose entire purpose is proving a run is safe before it
    // rewrites live invoice state. `--allow-prod --dry-run` must stay a dry run
    // just as surely as `--dry-run --allow-prod` does.
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.mode).toBe('dry-run');
    // allowProd still reports the flag was seen, even though it lost.
    expect(allowThenDry.allowProd).toBe(true);

    const dryThenAllow = parseArgs(['--dry-run', '--allow-prod']);
    expect(dryThenAllow.mode).toBe('dry-run');
    expect(dryThenAllow.allowProd).toBe(true);
  });

  it('one --dry-run beats any number of repeated --allow-prod', () => {
    expect(parseArgs(['--allow-prod', '--dry-run', '--allow-prod']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--dry-run']).mode).toBe('dry-run');
    // Repetition does not weaken the one intended write path either.
    expect(parseArgs(['--allow-prod', '--allow-prod']).mode).toBe('apply');
  });

  it('--dry-run alone is a no-op on the already-default mode', () => {
    const a = parseArgs(['--dry-run']);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
  });

  it('a valueless --project cannot swallow the --dry-run that follows it', () => {
    // The escape hatch out of the guarantee directly above: `--project` used to
    // take any next token as its value, so one forgotten project id turned
    // `--allow-prod --project --dry-run` back into an apply run with the safety
    // flag eaten. Refuse a flag as a value instead.
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(
      /--project requires a value/,
    );
    expect(() => parseArgs(['--project'])).toThrow(/--project requires a value/);
    // A real project id still passes through untouched, --dry-run intact.
    const ok = parseArgs(['--allow-prod', '--project', 'mytribe-test', '--dry-run']);
    expect(ok.projectId).toBe('mytribe-test');
    expect(ok.mode).toBe('dry-run');
  });
});

describe('backfillInvoiceStateStamp planStamp', () => {
  it("canonicalizes a legacy quote: 'QUOTE' -> 'quote', editScope 'all'", () => {
    const d = planStamp({ status: 'QUOTE', amountDue: 40, total: 40, invoiceStatus: 'quote' }, []);
    expect(d).toEqual({
      action: 'stamp',
      update: { status: 'quote', editScope: 'all' },
      before: { status: 'QUOTE', editScope: undefined },
    });
  });

  it("classifies an unlabeled sent invoice 'open' from its money", () => {
    const d = planStamp({ status: 'sent', amountDue: 40, total: 40 }, []);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update).toEqual({ status: 'open', editScope: 'all' });
  });

  it('reads the payment standing from the SUBCOLLECTION, not the amountDue scalar', () => {
    // The corrupt pre-2026-07-25 shape: labelled paid, amountDue zeroed, but
    // the subcollection holds only half the money. paid+partial stays 'all',
    // which is what keeps the doc repairable.
    const corrupt = { status: 'paid', amountDue: 0, total: 40, totalCents: 4000 };
    const d = planStamp(corrupt, [{ amount: 20, amountCents: 2000 }]);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update).toEqual({ status: 'paid', editScope: 'all' });
  });

  it('stamps a settled invoice paid/none', () => {
    const d = planStamp({ status: 'Paid', amountDue: 0, total: 40, totalCents: 4000 }, [
      { amount: 40, amountCents: 4000 },
    ]);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update).toEqual({ status: 'paid', editScope: 'none' });
  });

  it('stamps a redeemed credit redeemed/none', () => {
    const d = planStamp(
      { status: 'credit', amountDue: -25, total: -25, creditRedeemedAt: 'ts' },
      [],
    );
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update).toEqual({ status: 'redeemed', editScope: 'none' });
  });

  it('IS IDEMPOTENT: a stamped doc plans stamp_current, and nothing else', () => {
    const doc: Record<string, unknown> = { status: 'sent', amountDue: 40, total: 40 };
    const first = planStamp(doc, []);
    expect(first.action).toBe('stamp');
    if (first.action !== 'stamp') throw new Error('expected stamp');
    // Apply the planned merge exactly as the script would, then re-plan.
    const second = planStamp({ ...doc, ...first.update }, []);
    expect(second).toEqual({ action: 'skip', reason: 'stamp_current' });
  });

  it('skips a doc some callable already stamped', () => {
    expect(planStamp({ status: 'open', editScope: 'all', amountDue: 40, total: 40 }, [])).toEqual({
      action: 'skip',
      reason: 'stamp_current',
    });
  });

  it('re-stamps when only editScope is stale (a payment settled it after the last stamp)', () => {
    const d = planStamp({ status: 'open', editScope: 'all', amountDue: 40, total: 40, totalCents: 4000 }, [
      { amountCents: 4000 },
    ]);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update).toEqual({ status: 'open', editScope: 'metadataOnly' });
  });

  it('REFUSES the legacy shape: a total, no amountDue and no payments would be stamped paid (would_assert_payment)', () => {
    // Restored from before #884, where the old guard refused it. invoiceStateOf
    // reads the missing amountDue as 0, so this owed bill classifies paid, and
    // a paid/none stamp would then block every payment path and every edit.
    // Refused until #902 rules on a missing amountDue.
    const d = planStamp({ status: 'sent', total: 40 }, []);
    expect(d).toEqual({ action: 'skip', reason: 'would_assert_payment' });
  });

  it('stamps that shape paid once a subcollection payment row backs the paid reading', () => {
    const d = planStamp({ status: 'sent', total: 40 }, [{ amountCents: 4000 }]);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update.status).toBe('paid');
  });

  it('stamps that shape paid when a ROOT payments row names the invoice (the Stripe webhook writes there)', () => {
    const d = planStamp({ status: 'sent', total: 40 }, [], { rootPayments: [{ amountCents: 4000 }] });
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update.status).toBe('paid');
  });

  it('a root row whose amount is unresolved still counts as a record that money came in', () => {
    const d = planStamp({ status: 'sent', total: 40 }, [], { rootPayments: [{}] });
    expect(d.action).toBe('stamp');
  });

  it('allows a doc its writer already labelled paid: the stamp only canonicalizes the label', () => {
    for (const status of ['paid', ' Paid ']) {
      const d = planStamp({ status, total: 40 }, []);
      expect(d.action, status).toBe('stamp');
      if (d.action !== 'stamp') throw new Error('expected stamp');
      expect(d.update.status).toBe('paid');
    }
  });

  it('treats a non-finite amountDue as missing, so the shape is still refused', () => {
    for (const amountDue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const d = planStamp({ status: 'sent', total: 40, amountDue }, []);
      expect(d, String(amountDue)).toEqual({ action: 'skip', reason: 'would_assert_payment' });
    }
  });

  it('THE NOTIFICATION GUARD refuses a stamp write the trigger would send a notice for', () => {
    // The classifier's own stamp never changes what the trigger reads, so the
    // guard is proven with a stamp that does: it moves an open bill to paid.
    const d = planStamp({ status: 'open', amountDue: 40, total: 40 }, [], {
      stampOf: () => ({ status: 'paid', editScope: 'none' }),
    });
    expect(d).toEqual({ action: 'skip', reason: 'would_notify_household' });
  });

  it('wouldNotifyHousehold asks the trigger about both of its notices', () => {
    const doc = { status: 'open', amountDue: 40, total: 40 };
    expect(wouldNotifyHousehold(doc, { status: 'paid', editScope: 'none' })).toBe(true);
    expect(wouldNotifyHousehold(doc, { status: 'open', editScope: 'all' })).toBe(false);
    expect(wouldNotifyHousehold(doc, { status: 'overdue', editScope: 'all' } as never)).toBe(true);
  });

  it('does NOT trip the guard when the doc already reads paid to the trigger', () => {
    // amountDue 0 (numeric) already reads paid before the stamp, so writing
    // the label changes nothing the trigger acts on.
    const d = planStamp({ status: 'sent', amountDue: 0, total: 40 }, []);
    expect(d.action).toBe('stamp');
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(d.update.status).toBe('paid');
  });

  it('the guard never fires for non-paid stamps, canonicalizing away is safe', () => {
    for (const doc of [
      { status: 'Draft', amountDue: 40, total: 40 },
      { status: 'CANCELLED', amountDue: 40, total: 40 },
      { status: '', amountDue: -10, total: 40 }, // credit
      { status: 'overdue', amountDue: 40, total: 40 }, // -> open
    ]) {
      const d = planStamp(doc, []);
      expect(d.action, JSON.stringify(doc)).toBe('stamp');
    }
  });

  it('writes EXACTLY the two stamp fields and nothing else', () => {
    const d = planStamp({ status: 'sent', amountDue: 40, total: 40 }, []);
    if (d.action !== 'stamp') throw new Error('expected stamp');
    expect(Object.keys(d.update).sort()).toEqual(['editScope', 'status']);
  });
});
