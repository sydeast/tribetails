import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { generateAndStoreInvoicePdf } from '../lib/invoicePdf';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

/**
 * Stage 3 / 16.2 - kinfolk-portal invoice PDF download ("Download PDF" on the
 * MyTribe InvoiceDetailScreen). Portal callable (any signed-in kinfolk), scoped
 * to the caller's OWN household: resolveKinfolkAccess fixes the allowed
 * kinfolkId, and we refuse if the invoice's kinfolkId does not match (IDOR
 * guard). Renders + stores the PDF and returns a download-token URL.
 */

export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  kinfolkId: z.string().min(1).max(200).optional(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). `pdfUrl` is a Cloud Storage
 * download-token URL the client opens directly; it is a URL rather than bytes
 * on purpose, so nothing here has to carry a PDF through the callable
 * transport. `.strict()`, so an added field is reported rather than absorbed.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** Download-token URL, opened as-is. Never empty on a success. */
    pdfUrl: z.string().min(1),
  })
  .strict();
export async function getMyInvoicePdfHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getMyInvoicePdf validation failed');
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'getMyInvoicePdf');
  const snap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice ${args.invoiceId} does not exist.`);
  }
  const data = snap.data() as Record<string, unknown>;
  if (data.kinfolkId !== kinfolkId) {
    // The invoice belongs to a different household: refuse (no cross-tenant read).
    throw new HttpsError('permission-denied', 'You do not have access to this invoice.');
  }

  let pdfUrl: string;
  try {
    pdfUrl = await generateAndStoreInvoicePdf(args.invoiceId, data);
  } catch (err) {
    logEvent({ severity: 'error', function: 'getMyInvoicePdf', event: 'pdf.render.failed', uid, errorMessage: (err as Error)?.message, extra: { invoiceId: args.invoiceId } });
    throw new HttpsError('failed-precondition', 'invoice_pdf_render_failed');
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_PDF_GENERATED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    targetCollection: 'invoices',
    description: `Kinfolk downloaded invoice PDF for ${args.invoiceId}`,
    payload: { invoiceId: args.invoiceId, kinfolkId },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'getMyInvoicePdf', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  return validateResponse('getMyInvoicePdf', Result, { ok: true, invoiceId: args.invoiceId, pdfUrl });
}

export const getMyInvoicePdf = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyInvoicePdf', getMyInvoicePdfHandler),
);
