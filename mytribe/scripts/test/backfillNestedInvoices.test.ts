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

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // This script copies a nested invoice up to the flat collection and then
    // DELETES the nested original. `--allow-prod --dry-run` must stay a dry run
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

  it('a valueless --project cannot swallow the --dry-run that follows it', () => {
    // The escape hatch out of the guarantee directly above: `--project` used to
    // take any next token as its value, so one forgotten project id turned
    // `--allow-prod --project --dry-run` back into an apply run with the safety
    // flag eaten.
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
