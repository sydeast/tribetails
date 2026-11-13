import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { refuseAuntie } from '../lib/staffGate';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { sendIdempotencyKeyRe } from '../lib/sendIdempotency';
import { drawAccountCredit, type CreditDrawRefusal } from '../lib/accountCredit';
import { formatUsdCents } from '../lib/invoiceMath';

/**
 * APPLY AN AMOUNT OF A HOUSEHOLD'S ACCOUNT CREDIT TO ONE OPEN INVOICE (#1872).
 *
 * Operator ruling 2026-11-11: account credit is never spent automatically, not
 * on send, not on quote acceptance, not by any trigger. It goes onto an invoice
 * only when the admin enters an amount. This callable is that one path. The
 * trigger that used to draw credit by itself (`triggers/onInvoiceAutoApply.ts`)
 * and the callable that drew everything with no amount (`admin/runAutoApply.ts`)
 * are still in the tree and no longer move money.
 *
 * WHAT IT CHECKS, ON THE SERVER, INSIDE THE TRANSACTION THAT WRITES
 *
 *   the amount    whole cents, above zero, not more than the household holds,
 *                 not more than the invoice still owes. A request that does not
 *                 fit is refused; it is never trimmed to what fits.
 *   the invoice   sent and still owed. A draft, a quote, a paid invoice, an
 *                 archived one and a cancelled one are each refused by name.
 *
 * WHAT IT WRITES, IN ONE TRANSACTION (`lib/accountCredit.ts#drawAccountCredit`)
 *
 *   `invoices/{id}/payments/{key}`        the payment row, method "account credit"
 *   `invoices/{id}`                       the new balance, and paid when it reaches zero
 *   `families/{id}.accountBalanceCents`   the credit that is left
 *   `families/{id}/creditLedger/draw_{key}` the credit history entry
 *   `activity_log/account_credit_applied_{key}` the Activity Log line
 *
 * WHO. The owner, or a sandbox test admin inside their own test tribe
 * (`resolveInvoiceWriteActor`). An Auntie never sees money: `refuseAuntie`
 * refuses her by role first. Kinfolk have no admin claim and are refused.
 *
 * A DOUBLE TAP. The key is required and is the payment row's id. A second call
 * with the same key is answered from that row and draws nothing; the same key
 * from another admin is refused.
 *
 * No refunds, ever: this only moves credit the household already holds onto a
 * bill they owe. Nothing here sends money back out.
 */

export const APPLY_CREDIT_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('acr');

/** The largest amount the request shape admits. The real limits are the balance and the bill. */
const MAX_APPLY_CENTS = 1_000_000_000;

export const Args = z
  .object({
    invoiceId: z.string().min(1).max(200),
    /** The amount the admin entered. Integer cents, more than zero. */
    amountCents: z.number().int().min(1).max(MAX_APPLY_CENTS),
    idempotencyKey: z
      .string()
      .regex(APPLY_CREDIT_IDEMPOTENCY_KEY_RE, 'idempotencyKey must look like acr_<millis>_<suffix>'),
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** The payment row this wrote, which is the idempotency key. */
    paymentId: z.string().min(1),
    /** Credit moved onto the invoice. */
    appliedCents: CentsSchema,
    /** The invoice's balance afterwards. */
    amountDueCents: CentsSchema,
    /** What the household still has on account afterwards. */
    accountBalanceCents: CentsSchema,
    /** True when this answer is a replay of an earlier call with the same key. */
    replayed: z.boolean(),
  })
  .strict();

export type ApplyAccountCreditArgs = z.infer<typeof Args>;
export type ApplyAccountCreditResult = z.infer<typeof Result>;

/**
 * The words for each refusal. Written to be shown beside the amount field as
 * they are; the code travels in `details.reason` for a client that words it
 * itself.
 */
export function applyCreditRefusalMessage(
  reason: CreditDrawRefusal,
  found: { accountBalanceCents: number; amountDueCents: number },
): string {
  switch (reason) {
    case 'amount_invalid':
      return 'Enter an amount above $0.00.';
    case 'over_credit':
      return found.accountBalanceCents <= 0
        ? 'This household has no account credit.'
        : `This household has ${formatUsdCents(found.accountBalanceCents)} of account credit. Enter that much or less.`;
    case 'over_balance':
      return `This invoice has ${formatUsdCents(found.amountDueCents)} left to pay. Enter that much or less.`;
    case 'invoice_draft':
      return 'This invoice is a draft. Send it before you apply credit.';
    case 'invoice_quote':
      return 'This is a quote. Credit can be applied once it becomes an invoice.';
    case 'invoice_paid':
      return 'This invoice is already paid, so it takes no credit.';
    case 'invoice_archived':
      return 'This invoice is archived, so it takes no credit.';
    case 'invoice_not_collectable':
      return 'This invoice cannot take a payment.';
    case 'no_household':
      return 'This invoice has no household on it.';
    case 'invoice_missing':
      return 'This invoice could not be found.';
  }
}

export async function applyAccountCreditHandler(
  req: CallableRequest<unknown>,
): Promise<ApplyAccountCreditResult> {
  initSentry();
  // Before the actor gate, so her refusal is logged as a caretaker refusal.
  refuseAuntie(req.auth, 'applyAccountCredit');
  const actor = resolveInvoiceWriteActor(req, 'applyAccountCredit');

  let args: ApplyAccountCreditArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      const amountIssue = err.issues.some((i) => i.path[0] === 'amountCents');
      throw new HttpsError(
        'invalid-argument',
        amountIssue
          ? applyCreditRefusalMessage('amount_invalid', { accountBalanceCents: 0, amountDueCents: 0 })
          : 'applyAccountCredit validation failed',
        {
          ...(amountIssue ? { reason: 'amount_invalid' } : {}),
          validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      );
    }
    throw err;
  }

  // THE SANDBOX CHECK IS BEFORE THE DRAW, not inside it: ownership is this
  // callable's job, the draw only knows documents.
  const invSnap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!invSnap.exists) {
    throw new HttpsError('not-found', 'This invoice could not be found.', { reason: 'invoice_missing' });
  }
  const kinfolkId = (invSnap.data() ?? {})['kinfolkId'];
  if (!testOwnsDoc(actor.testMode, typeof kinfolkId === 'string' ? kinfolkId : '')) {
    throw new HttpsError('permission-denied', 'This invoice is outside your test sandbox.');
  }

  const result = await drawAccountCredit(db(), {
    invoiceId: args.invoiceId,
    actorUid: actor.uid,
    amountCents: args.amountCents,
    paymentId: args.idempotencyKey,
    testMode: actor.testMode.active,
  });

  if (result.refused !== null) {
    logEvent({
      severity: 'info',
      function: 'applyAccountCredit',
      event: 'admin.credit.apply.refused',
      uid: actor.uid,
      extra: {
        invoiceId: args.invoiceId,
        reason: result.refused,
        amountCents: args.amountCents,
        accountBalanceCents: result.accountBalanceCents,
        amountDueCents: result.amountDueCents,
        testMode: actor.testMode.active,
      },
    });
    throw new HttpsError(
      result.refused === 'invoice_missing' ? 'not-found' : 'failed-precondition',
      applyCreditRefusalMessage(result.refused, result),
      {
        reason: result.refused,
        accountBalanceCents: result.accountBalanceCents,
        amountDueCents: result.amountDueCents,
      },
    );
  }

  logEvent({
    severity: 'info',
    function: 'applyAccountCredit',
    event: result.replayed ? 'admin.credit.apply.replay' : 'admin.credit.apply',
    uid: actor.uid,
    extra: {
      invoiceId: args.invoiceId,
      paymentId: result.paymentId,
      appliedCents: result.appliedCents,
      accountBalanceCents: result.accountBalanceCents,
      amountDueCents: result.amountDueCents,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('applyAccountCredit', Result, {
    ok: true,
    invoiceId: result.invoiceId,
    paymentId: result.paymentId,
    appliedCents: result.appliedCents,
    amountDueCents: result.amountDueCents,
    accountBalanceCents: result.accountBalanceCents,
    replayed: result.replayed,
  });
}

export const applyAccountCredit = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as every other callable on the invoice surface.
  wrapCallable('applyAccountCredit', applyAccountCreditHandler),
);
