import { KINFOLK } from './accounts';

/**
 * An open invoice for the seeded household, written by a real-services spec
 * through the `upsertDoc` task (#1194) and read back by the real
 * `getMyInvoices`. Spec-owned rather than seeded, so the PR-time seed is
 * unchanged and each spec's invoice has an id no other spec reads.
 *
 * The shape is the stamped one the admin's real-services spec writes
 * (`auntieos-admin/cypress/e2e-real/invoice-paid-stripe.cy.ts`): `status` and
 * `editScope` set, so `getMyInvoices` classifies it as stamped, and a balance
 * stated in `amountDue` (dollars) that `payInvoice` charges.
 */
export function openInvoiceDoc(stamp: string, totalDollars: number): Record<string, unknown> {
  const today = localDay(new Date());
  return {
    kinfolkId: KINFOLK.kinfolkId,
    kinfolkName: KINFOLK.displayName,
    client: KINFOLK.displayName,
    invoiceNumber: `MT-E2E-${stamp}`,
    date: today,
    dueDate: today,
    total: totalDollars,
    amountDue: totalDollars,
    status: 'open',
    editScope: 'all',
    sessionIds: [],
    lineItems: [{ description: 'Drop-in visit', qty: 1, unitCents: totalDollars * 100 }],
    createdAt: new Date().toISOString(),
  };
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
