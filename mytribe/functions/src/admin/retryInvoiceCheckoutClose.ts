import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { invoiceIsPaid } from '../lib/invoicePaidGate';
import { sessionsToClose, type SweepDoc } from '../lib/checkoutSessionSweep';
import {
  liveSessionsApi,
  recordCheckoutSweep,
  runCheckoutSweep,
  unreachableRun,
  type CheckoutSessionsApi,
} from '../lib/checkoutSweepRun';
/**
 * "Try again" for an invoice whose open Stripe payment links could not be
 * closed when it was paid (#1113). Runs the same pass the
 * `onInvoicePaidExpireCheckouts` trigger runs, on the ids not yet on the
 * invoice's closed list, and records the outcome the invoice detail reads.
 *
 * It only ever expires Checkout Sessions on an invoice that is already paid.
 * It moves no money, credits nothing and refunds nothing. Owner-only: it is
 * not on `lib/auntieAccess.ts`, so an Auntie is refused by the staff gate.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
});
/** The RESPONSE shape (ADR-0001 step W3-1). `.strict()`, so an added field is reported. */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** Links this call expired. */
    closedCount: z.number().int().min(0),
    /** Links still open after this call. */
    failedCount: z.number().int().min(0),
  })
  .strict();
export async function retryInvoiceCheckoutCloseHandler(
  req: CallableRequest<unknown>,
  deps: { sessions?: () => Promise<CheckoutSessionsApi> } = {},
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'retryInvoiceCheckoutClose validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  const snap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  const data = snap.data() as SweepDoc & { kinfolkId?: string; invoiceNumber?: string };
  if (!invoiceIsPaid(data)) {
    throw new HttpsError(
      'failed-precondition',
      'This invoice is not paid, so its payment links are still how the household pays.',
      { code: 'invoice_not_paid' },
    );
  }
  const ids = sessionsToClose(data, data);
  if (ids.length === 0) {
    return validateResponse('retryInvoiceCheckoutClose', Result, {
      ok: true,
      invoiceId: args.invoiceId,
      closedCount: 0,
      failedCount: 0,
    });
  }
  let run;
  try {
    run = await runCheckoutSweep(await (deps.sessions ?? liveSessionsApi)(), ids);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'retryInvoiceCheckoutClose',
      event: 'stripe.checkout.retry.unavailable',
      uid,
      extra: { invoiceId: args.invoiceId, err: (err as Error)?.message },
    });
    run = unreachableRun(ids);
  }
  await recordCheckoutSweep(args.invoiceId, run);
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_CHECKOUT_CLOSE_RETRIED,
    severity: run.failed.length > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: `Retried closing open payment links on invoice ${data.invoiceNumber ?? args.invoiceId}`,
    payload: { invoiceId: args.invoiceId, closed: run.expired.length, failed: run.failed.length },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'retryInvoiceCheckoutClose',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  logEvent({
    severity: run.failed.length > 0 ? 'error' : 'info',
    function: 'retryInvoiceCheckoutClose',
    event: 'admin.invoice.checkout.retried',
    uid,
    extra: { invoiceId: args.invoiceId, outcomes: run.outcomes },
  });
  return validateResponse('retryInvoiceCheckoutClose', Result, {
    ok: true,
    invoiceId: args.invoiceId,
    closedCount: run.expired.length,
    failedCount: run.failed.length,
  });
}
export const retryInvoiceCheckoutClose = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY'] },
  wrapAdminCallable('retryInvoiceCheckoutClose', (req: CallableRequest<unknown>) =>
    retryInvoiceCheckoutCloseHandler(req),
  ),
);
