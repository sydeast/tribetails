import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { drawAccountCredit } from '../lib/accountCredit';

/**
 * Puts a household's unapplied credit onto ONE named invoice, on demand.
 *
 * The same pass `triggers/onInvoiceAutoApply.ts` runs by itself, reachable by
 * an operator. It exists because the trigger only fires on the transition into
 * collectable, and the two most ordinary cases in the world happen after that:
 *
 *   she ticks Auto-apply on a payment for a household whose invoice is already
 *   sent, and
 *
 *   a trigger failed (a cold start timed out, a batch lost a race) and the
 *   credit is sitting on the payment while the bill still says it is owed.
 *
 * Without this, both are only fixable by editing money by hand, which is what
 * the callable-only invoice writes of ADR-0002 exist to stop.
 *
 * IT DRAWS ON THE EXISTING CREDIT LEDGER, `families/{id}.accountBalanceCents`,
 * the same balance `redeemCredit` fills and the portal already shows. There is
 * no second ledger; see `lib/accountCredit.ts` for what this tranche extended
 * and why.
 *
 * RUNNING IT TWICE DRAWS ONCE, and since #830 that holds for two passes in
 * flight TOGETHER and not only for one after the other. The whole pass — the
 * reads, the plan and the writes — is a single Firestore transaction, so a
 * second pass cannot commit a draw it planned from a balance the first had
 * already spent. It re-runs against what the first committed, finds either the
 * invoice settled or the balance gone, and reports `invoice_not_collectable` or
 * `no_credit`. This is what makes the operator pressing this button while the
 * trigger is mid-flight on the same invoice safe.
 *
 * IT IS NOT AN IDEMPOTENCY KEY and must not be read as one. Nothing here
 * remembers a particular call; what it has is a plan re-derived from the stored
 * documents under a lock. Every guard is re-read from those documents, so
 * pressing the button is a request to look, never an instruction to move money.
 *
 * GATE: `resolveInvoiceWriteActor`, the ADR-0002 invoice-surface gate, plus the
 * sandbox ownership check on the invoice itself. A scoped test admin may run it
 * inside their own tribe and nowhere else.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z
  .object({
    invoiceId: z.string().min(1).max(200),
  })
  .strict();

/**
 * The RESPONSE shape (ADR-0001 step W3-1).
 *
 * `skipped` IS NOT AN ERROR CHANNEL. Every value of it is a normal outcome the
 * operator asked about and deserves a straight answer to: there was no credit,
 * the invoice was already settled, it is a draft. Throwing on those would make
 * "nothing needed doing" indistinguishable from "something went wrong", and
 * would train an operator to ignore the red.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** Why nothing was applied, or `''` when something was. */
    skipped: z.enum([
      '',
      'invoice_missing',
      'invoice_not_collectable',
      'no_household',
      'no_credit',
    ]),
    /** Credit moved onto the invoice by this pass. */
    appliedCents: CentsSchema,
    /** The invoice's balance afterwards. */
    amountDueCents: CentsSchema,
    /** What the household still has on account afterwards. */
    accountBalanceCents: CentsSchema,
  })
  .strict();

export type RunAutoApplyArgs = z.infer<typeof Args>;
export type RunAutoApplyResult = z.infer<typeof Result>;

export async function runAutoApplyHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'runAutoApply');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'runAutoApply validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // THE SANDBOX CHECK IS BEFORE THE PASS, not inside it. `drawAccountCredit` is
  // also the trigger's entry point and a trigger has no caller to scope, so
  // ownership is this callable's job.
  const invSnap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!invSnap.exists) {
    throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  }
  const kinfolkId = (invSnap.data() ?? {})['kinfolkId'];
  if (!testOwnsDoc(actor.testMode, typeof kinfolkId === 'string' ? kinfolkId : '')) {
    throw new HttpsError('permission-denied', 'This invoice is outside your test sandbox.');
  }

  const result = await drawAccountCredit(db(), {
    invoiceId: args.invoiceId,
    actorUid: actor.uid,
  });

  logEvent({
    severity: 'info',
    function: 'runAutoApply',
    event: 'admin.payment.autoapply.run',
    uid: actor.uid,
    extra: {
      invoiceId: args.invoiceId,
      skipped: result.skipped,
      appliedCents: result.appliedCents,
      accountBalanceCents: result.accountBalanceCents,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('runAutoApply', Result, {
    ok: true,
    invoiceId: result.invoiceId,
    skipped: result.skipped ?? '',
    appliedCents: result.appliedCents,
    amountDueCents: result.amountDueCents,
    accountBalanceCents: result.accountBalanceCents,
  });
}

export const runAutoApply = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as every other callable on this surface.
  wrapCallable('runAutoApply', runAutoApplyHandler),
);
