/**
 * #1368: the seeds' invoice docs must parse with the SAME schema the readers use.
 *
 * Both seeds once wrote lines as `{label, amount}`, which
 * `getMyInvoices#storedLineItemsFrom` silently drops, and the sandbox wrote
 * cents into the dollar fields. This feeds every seeded invoice through the
 * reader's own line parser and line DTO schema, so a future change to either
 * side that makes the seed unreadable fails here.
 */
import { describe, it, expect } from 'vitest';
import { buildSandboxPayload } from '../seed_test_sandbox';
import { buildSeedPayload, DEMO_FAMILY_IDS } from '../seedDemoKinfolk';
import {
  storedLineItemsFrom,
  mapStoredLineItem,
  InvoiceLineItemDtoSchema,
} from '../../functions/src/portal/getMyInvoices';
interface SeededInvoice {
  _id: string;
  lineItems: unknown[];
  subtotalCents: number;
  total: number;
  amountDue: number;
}
function check(invoices: SeededInvoice[]): void {
  expect(invoices.length).toBeGreaterThan(0);
  for (const inv of invoices) {
    const stored = storedLineItemsFrom(inv.lineItems);
    // The reader drops malformed rows without saying so; none may be dropped.
    expect(stored, `${inv._id}: a line was dropped by the reader`).toHaveLength(inv.lineItems.length);
    const dtos = stored.map((li, i) => mapStoredLineItem(li, i));
    for (const dto of dtos) InvoiceLineItemDtoSchema.parse(dto);
    if (dtos.length > 0) {
      expect(dtos.reduce((n, d) => n + (d.amountCents ?? 0), 0), inv._id).toBe(inv.subtotalCents);
    }
    // Dollars, not cents: no seeded visit is worth thousands of dollars.
    expect(Math.abs(inv.total), `${inv._id} total looks like cents`).toBeLessThan(1000);
    expect(Math.abs(inv.amountDue), `${inv._id} amountDue looks like cents`).toBeLessThan(1000);
  }
}
describe('seed invoices parse with the reader schema (#1368)', () => {
  it('sandbox seed', () => {
    check(buildSandboxPayload(new Date('2026-07-09T12:00:00Z')).invoices);
  });
  it('demo seed, every demo household', () => {
    for (const fam of DEMO_FAMILY_IDS) check(buildSeedPayload(fam).invoices);
  });
  it('the old {label, amount} shape is dropped by the reader (guards the guard)', () => {
    expect(storedLineItemsFrom([{ label: '60-Minute Drop-In', amount: 4500 }])).toEqual([]);
  });
});
