import { describe, expect, it } from 'vitest';
import { invoiceDayOf } from '../src/lib/invoiceDay';
/**
 * #1570: the stored-day reader every chaser and every admin client share. The
 * same fixtures are pinned in the admin web (invoiceFormat.test.ts), Android
 * (InvoiceDayTest.kt) and the desktop console (InvoiceDayTest.kt).
 */
describe('invoiceDayOf (#1570)', () => {
  it('reads a stored day and an ISO instant by their day prefix', () => {
    expect(invoiceDayOf('2026-07-14')).toBe('2026-07-14');
    expect(invoiceDayOf(' 2026-07-14T23:59:00.000Z ')).toBe('2026-07-14');
  });
  it('reads the imported month-name form, full or short, comma or not', () => {
    expect(invoiceDayOf('July 14, 2026')).toBe('2026-07-14');
    expect(invoiceDayOf('Jul 14 2026')).toBe('2026-07-14');
    expect(invoiceDayOf('jul 4, 2026')).toBe('2026-07-04');
    // The backfill script refuses the dotted short form, so the readers do too.
    expect(invoiceDayOf('Jul. 4, 2026')).toBeNull();
    expect(invoiceDayOf('September 1, 2025')).toBe('2025-09-01');
    expect(invoiceDayOf('Sep 1, 2025')).toBe('2025-09-01');
  });
  it('refuses a day that does not exist rather than rolling it', () => {
    expect(invoiceDayOf('February 30, 2026')).toBeNull();
    expect(invoiceDayOf('Jun 31, 2026')).toBeNull();
  });
  it('refuses every ambiguous or non-date text', () => {
    expect(invoiceDayOf('07/14/2026')).toBeNull();
    expect(invoiceDayOf('14/07/2026')).toBeNull();
    expect(invoiceDayOf('Net 14')).toBeNull();
    expect(invoiceDayOf('Ju 14, 2026')).toBeNull();
    expect(invoiceDayOf('')).toBeNull();
    expect(invoiceDayOf(null)).toBeNull();
    expect(invoiceDayOf(20260714)).toBeNull();
  });
});
