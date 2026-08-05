import { useSearch } from '@tanstack/react-router';
import { Invoices } from '../screens/Invoices';

/** Adapts `/invoices?invoiceId=&composeQuoteForKinfolkId=` to Invoices' props. */
export function InvoicesView() {
  const { invoiceId, composeQuoteForKinfolkId } = useSearch({ from: '/admin/invoices' });
  return (
    <Invoices
      {...(invoiceId ? { initialInvoiceId: invoiceId } : {})}
      {...(composeQuoteForKinfolkId ? { composeQuoteForKinfolkId } : {})}
    />
  );
}
