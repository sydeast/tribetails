import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { isVisibleInTestScope } from '../lib/testScope';
import type { InvoiceEntry } from './invoices';

/**
 * #1871: one invoice read FROM THE SERVER, right after an edit was saved.
 *
 * The open sheet follows a live listener (#1113), and on the walk that listener
 * delivered the edited invoice 15 to 25 seconds after `updateInvoice` had
 * answered, so "Invoice updated." sat above the old quantity and total. This
 * read returns once the committed write is readable, so the sheet can hold the
 * new figures before it says the save is done.
 *
 * `getDocFromServer`, never the cache: the cached copy is the one from before
 * the press. Null when the read fails, the invoice is gone, or it is outside a
 * test admin's sandbox (the same belt `useDocById` applies); the caller then
 * falls back to the listener and says the figures have not loaded. Gives up
 * after {@link READ_BACK_WAIT_MS}: the save is already done, so a stalled read
 * must not hold the sheet on "Saving".
 */
export const READ_BACK_WAIT_MS = 8000;

export async function readInvoiceFromServer(invoiceId: string): Promise<InvoiceEntry | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snap = await Promise.race([
      getDocFromServer(doc(db, 'invoices', invoiceId)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_BACK_WAIT_MS);
      }),
    ]);
    if (snap === null) return null;
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    if (!isVisibleInTestScope('invoices', snap.id, data)) return null;
    return { ...data, _id: snap.id } as unknown as InvoiceEntry;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
