import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { sendMarksOf, type SendMarks } from '../lib/invoiceSendCheck';
/**
 * #1567: re-read one invoice FROM THE SERVER after a send got no answer, and
 * return the marks `lib/invoiceSendCheck.ts` compares.
 *
 * `getDocFromServer`, never the cache: the cached copy is what the screen
 * already had before the press, so reading it would always answer "not sent".
 *
 * Returns null when the read fails or the invoice is gone. The caller turns
 * that into "there is no way to tell from here", which is the truth; it never
 * becomes "not sent".
 */
export async function readInvoiceSendMarks(invoiceId: string): Promise<SendMarks | null> {
  try {
    const snap = await getDocFromServer(doc(db, 'invoices', invoiceId));
    if (!snap.exists()) return null;
    return sendMarksOf(snap.data() as Record<string, unknown>);
  } catch {
    return null;
  }
}
