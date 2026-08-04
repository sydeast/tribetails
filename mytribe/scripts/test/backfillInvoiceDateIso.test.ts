import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  legacyDateToIsoDay,
  planField,
  planInvoice,
} from '../backfillInvoiceDateIso';

describe('backfillInvoiceDateIso parseArgs', () => {
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

describe('legacyDateToIsoDay: the one grammar it will read', () => {
  it('reads the month-name form this collection actually holds', () => {
    // The exact fixtures this repo carries for the field.
    expect(legacyDateToIsoDay('Feb 12, 2026')).toBe('2026-02-12');
    expect(legacyDateToIsoDay('Sep 1, 2025')).toBe('2025-09-01');
    expect(legacyDateToIsoDay('August 11, 2025')).toBe('2025-08-11');
    expect(legacyDateToIsoDay('September 17, 2025')).toBe('2025-09-17');
    expect(legacyDateToIsoDay('Jul 1, 2026')).toBe('2026-07-01');
  });

  it('does not insist on the comma, which is punctuation and not information', () => {
    expect(legacyDateToIsoDay('February 12 2026')).toBe('2026-02-12');
  });

  it('reads an ISO instant as its day, since that prefix is already unambiguous', () => {
    expect(legacyDateToIsoDay('2026-06-07T12:00:00Z')).toBe('2026-06-07');
    expect(legacyDateToIsoDay('2026-06-07T12:00:00.000Z')).toBe('2026-06-07');
  });

  it('REFUSES every numeric-separator form, because it is genuinely two dates', () => {
    // 01/02/2026 is 1 February to most of the world and 2 January to the rest.
    // No amount of staring at the corpus turns that into knowledge, so the row
    // is left alone and named in the report for a person.
    for (const raw of ['01/02/2026', '2026/07/05', '12-02-2026', '5.7.2026']) {
      expect(legacyDateToIsoDay(raw)).toBeNull();
    }
  });

  it('refuses text that is not a date at all', () => {
    for (const raw of ['Net 14', 'on receipt', '', '   ', 'Smarch 4, 2026']) {
      expect(legacyDateToIsoDay(raw)).toBeNull();
    }
  });

  it('refuses a day that does not exist rather than rolling it into the next month', () => {
    // Date.UTC would resolve this to 2 March. Writing that back would be
    // inventing a date on a bill.
    expect(legacyDateToIsoDay('February 30, 2026')).toBeNull();
    expect(legacyDateToIsoDay('Jun 31, 2026')).toBeNull();
  });

  it('gets the leap day right in both directions', () => {
    expect(legacyDateToIsoDay('Feb 29, 2024')).toBe('2024-02-29');
    expect(legacyDateToIsoDay('Feb 29, 2026')).toBeNull();
  });

  it('zero-pads, which is the entire point of the exercise', () => {
    // An unpadded day would sort "2025-9-1" above "2025-10-01", reintroducing a
    // smaller copy of the bug this script exists to remove.
    expect(legacyDateToIsoDay('Sep 1, 2025')).toBe('2025-09-01');
    expect(legacyDateToIsoDay('Oct 1, 2025') ?? '').toBe('2025-10-01');
    expect((legacyDateToIsoDay('Sep 1, 2025') as string) < '2025-10-01').toBe(true);
  });
});

describe('planField', () => {
  it('leaves an exact day alone, and that branch IS the idempotency guarantee', () => {
    expect(planField('2026-07-05')).toEqual({
      shape: 'already_iso',
      before: '2026-07-05',
      after: null,
    });
  });

  it('leaves a blank blank, and invents nothing for it', () => {
    expect(planField('').shape).toBe('blank');
    expect(planField(undefined).shape).toBe('blank');
    expect(planField(null).after).toBeNull();
    // A non-string on the doc reads as no value, never as text to parse.
    expect(planField(1754265600000).shape).toBe('blank');
  });

  it('rewrites the legacy form', () => {
    expect(planField('Feb 12, 2026')).toEqual({
      shape: 'legacy',
      before: 'Feb 12, 2026',
      after: '2026-02-12',
    });
  });

  it('refuses, rather than rewrites, an unreadable value', () => {
    const d = planField('01/02/2026');
    expect(d.shape).toBe('unreadable');
    expect(d.after).toBeNull();
  });

  it('names a day-shaped value that is not a real day, and still writes nothing', () => {
    const d = planField('2026-02-30');
    expect(d.shape).toBe('impossible_day');
    expect(d.after).toBeNull();
  });
});

describe('planInvoice', () => {
  it('plans both date fields in one merge', () => {
    const plan = planInvoice({
      date: 'Sep 1, 2025',
      dueDate: 'Sep 15, 2025',
      total: 120,
      status: 'open',
    });
    expect(plan.update).toEqual({ date: '2025-09-01', dueDate: '2025-09-15' });
  });

  it('touches nothing but the fields it is rewriting', () => {
    const plan = planInvoice({ date: 'Sep 1, 2025', dueDate: '', total: 120 });
    expect(Object.keys(plan.update)).toEqual(['date']);
    // No updatedAt: this materializes a format, it is not an edit of the bill.
    expect(plan.update).not.toHaveProperty('updatedAt');
    expect(plan.update).not.toHaveProperty('total');
  });

  it('plans NOTHING for an invoice that is already correct', () => {
    const plan = planInvoice({ date: '2026-07-05', dueDate: '2026-08-04' });
    expect(plan.update).toEqual({});
  });

  it('is idempotent: re-planning its own output writes nothing', () => {
    const before = { date: 'Feb 12, 2026', dueDate: 'Mar 14, 2026' };
    const first = planInvoice(before);
    const second = planInvoice({ ...before, ...first.update });
    expect(first.update).toEqual({ date: '2026-02-12', dueDate: '2026-03-14' });
    expect(second.update).toEqual({});
  });

  it('rewrites the readable field and refuses the unreadable one on the same doc', () => {
    const plan = planInvoice({ date: 'Feb 12, 2026', dueDate: 'Net 14' });
    expect(plan.update).toEqual({ date: '2026-02-12' });
    expect(plan.fields.dueDate.shape).toBe('unreadable');
  });

  it('produces days that a last-30-days window can actually compare', () => {
    // The whole reason this script exists: after the rewrite, the byte order of
    // the stored string IS the calendar order, so `date >= '2026-07-05'` means
    // what it says. Before it, the same document cleared every cutoff ever.
    const before = 'Feb 12, 2026';
    const after = planInvoice({ date: before }).update['date'] as string;
    expect(before >= '2026-07-05').toBe(true); // the bug
    expect(after >= '2026-07-05').toBe(false); // the fix
  });
});
