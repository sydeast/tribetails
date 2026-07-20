import { describe, it, expect } from 'vitest';
import { parseArgs, planCopy } from '../backfillNestedInvoices';

describe('backfillNestedInvoices parseArgs', () => {
  it('defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
  });

  it('--allow-prod implies an apply run', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.mode).toBe('apply');
    expect(a.allowProd).toBe(true);
  });

  it('captures --project', () => {
    const a = parseArgs(['--project', 'mytribe-test']);
    expect(a.projectId).toBe('mytribe-test');
  });

  it('throws on unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('backfillNestedInvoices planCopy', () => {
  it('copies a nested doc up, stamping kinfolkId from the path segment', () => {
    const d = planCopy('3', 'inv-1', { total: 40, status: 'open' }, null);
    expect(d.action).toBe('copy');
    if (d.action !== 'copy') throw new Error('expected copy');
    expect(d.plan.invoiceId).toBe('inv-1');
    expect(d.plan.kinfolkId).toBe('3');
    expect(d.plan.nestedPath).toBe('families/3/invoices/inv-1');
    expect(d.plan.data.kinfolkId).toBe('3');
    expect(d.plan.data.total).toBe(40);
  });

  it('prefers the nested doc own kinfolkId over the path segment', () => {
    const d = planCopy('3', 'inv-1', { kinfolkId: '7', total: 40 }, null);
    if (d.action !== 'copy') throw new Error('expected copy');
    expect(d.plan.kinfolkId).toBe('7');
    expect(d.plan.data.kinfolkId).toBe('7');
  });

  it('is safe to re-run when a matching flat doc already exists', () => {
    const d = planCopy('3', 'inv-1', { total: 40 }, { kinfolkId: '3', total: 40, status: 'paid' });
    expect(d.action).toBe('copy');
  });

  it('refuses to reassign a flat doc owned by a different kinfolk', () => {
    const d = planCopy('3', 'inv-1', { total: 40 }, { kinfolkId: '99', total: 40 });
    expect(d.action).toBe('skip');
    if (d.action !== 'skip') throw new Error('expected skip');
    expect(d.reason).toBe('flat_kinfolkId_mismatch');
  });

  it('skips a nested doc with no family path segment', () => {
    const d = planCopy('', 'inv-1', { total: 40 }, null);
    expect(d.action).toBe('skip');
    if (d.action !== 'skip') throw new Error('expected skip');
    expect(d.reason).toBe('no_family_segment');
  });
});
