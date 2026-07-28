import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { generateAndStoreInvoicePdf } from '../lib/invoicePdf';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

/**
 * Stage 3 / 16.2 - admin (AuntieOS) invoice PDF download. Loads invoices/{id},
 * renders a real PDF (pdf-lib), stores it to Cloud Storage, and returns a
 * download-token URL the client opens. Admin-gated (a test-admin lacks the admin
 * claim, so cannot generate PDFs for real invoices). Fail-loud: missing invoice
 * throws not-found; render/store errors surface as internal.
 */

const Args = z.object({ invoiceId: z.string().min(1).max(200) });

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
export async function generateInvoicePdfHandler(
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
      throw new HttpsError('invalid-argument', 'generateInvoicePdf validation failed');
    }
    throw err;
  }

  const snap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice ${args.invoiceId} does not exist.`);
  }

  let pdfUrl: string;
  try {
    pdfUrl = await generateAndStoreInvoicePdf(args.invoiceId, snap.data() as Record<string, unknown>);
  } catch (err) {
    // Surface a user-fault code (not a Sentry-captured 'internal') so a render/
    // store failure is a clear, non-noisy error.
    logEvent({ severity: 'error', function: 'generateInvoicePdf', event: 'pdf.render.failed', uid, errorMessage: (err as Error)?.message, extra: { invoiceId: args.invoiceId } });
    throw new HttpsError('failed-precondition', 'invoice_pdf_render_failed');
  }

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_PDF_GENERATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'invoices',
    description: `Invoice PDF generated for ${args.invoiceId}`,
    payload: { invoiceId: args.invoiceId },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'generateInvoicePdf', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  return validateResponse('generateInvoicePdf', Result, { ok: true, invoiceId: args.invoiceId, pdfUrl });
}

export const generateInvoicePdf = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('generateInvoicePdf', generateInvoicePdfHandler),
);
