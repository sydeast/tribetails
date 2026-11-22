export interface InvoiceBillingFields {
  kinfolkName?: string | undefined;
  client?: string | undefined;
  address?: string | undefined;
  discount?: string | undefined;
}

/**
 * #1899: the saved name, address and discount note, so an edit to them can be
 * seen on the invoice. A blank one is left out, and so is a name that only
 * repeats the household already at the top of the sheet. Pure.
 */
export function invoiceBillingFacts(invoice: InvoiceBillingFields): { label: string; value: string }[] {
  const client = (invoice.client ?? '').trim();
  const repeatsHousehold = client.toLowerCase() === (invoice.kinfolkName ?? '').trim().toLowerCase();
  return [
    { label: 'Kinfolk', value: repeatsHousehold ? '' : client },
    { label: 'Address', value: (invoice.address ?? '').trim() },
    { label: 'Discount note', value: (invoice.discount ?? '').trim() },
  ].filter((row) => row.value !== '');
}

/** Rows for the invoice sheet's facts list. Display only: no figure is read or changed. */
export function InvoiceBillingFacts({ invoice }: { invoice: InvoiceBillingFields }) {
  return (
    <>
      {invoiceBillingFacts(invoice).map((row) => (
        <div className="invoice-detail__fact" key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </>
  );
}
