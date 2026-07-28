import { describe, it, expect } from 'vitest';
import { parseArgs, planStamp } from '../backfillInvoiceStateStamp';

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

  it('THE NOTIFICATION GUARD: refuses the one shape whose stamp would text the household', () => {
    // No numeric amountDue + a positive total classifies 'paid', and the
    // status label is what onInvoicesWrite's lifecycle would newly read as
    // paid, firing invoice.payment.applied for money that moved months ago.
    // The guard reports it for the operator instead.
    const d = planStamp({ status: 'sent', total: 40 }, []);
    expect(d).toEqual({ action: 'skip', reason: 'would_notify_household' });
  });

  it('does NOT trip the guard when the doc already reads paid to the trigger', () => {
    // amountDue 0 (numeric) already resolves the lifecycle 'paid' before the
    // stamp, so writing the label changes nothing the trigger acts on.
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
