import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';

export const Args = z.object({
  invoiceId: z.string().min(1),
  kinfolkId: z.string().optional(),
  // Account balance is the ONLY redemption target. Kept as a single-value enum
  // rather than dropped so an old client still sending {target:'accountBalance'}
  // keeps working, while one sending 'originalPaymentMethod' now fails loudly at
  // validation instead of silently doing something else.
  target: z.literal('accountBalance').optional().default('accountBalance'),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported, unlike the interface it
 * replaced, because the contract guard freezes it and decision 2 generates the
 * portal's type from it.
 *
 * `target` is a single-value literal, matching the request's. Credits are NOT
 * refundable (operator ruling, 2026-07-20): account balance is the only
 * destination, and a schema that said `string` would invite a client to render
 * a refund that cannot happen.
 *
 * `newAccountBalanceCents` is `.nullable()` because the transaction returns the
 * balance it wrote, and a caller must be able to tell "the balance is now X"
 * from "the balance was not readable". It is SIGNED cents: the field is a
 * running household balance, not a bounded invoice figure.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** The credit's absolute value, integer cents, as applied. */
    redeemedAmountCents: CentsSchema,
    /** The only redemption target there is. */
    target: z.literal('accountBalance'),
    /** The balance after this redemption, or null when it could not be read back. */
    newAccountBalanceCents: SignedCentsSchema.nullable(),
  })
  .strict();

/**
 * Redeems a credit invoice (negative amountDue or status='credit') by bumping
 * `families/{kinfolkId}.accountBalanceCents` by |amount|.
 *
 * CREDITS ARE NOT REFUNDABLE (operator ruling, 2026-07-20). A kinfolk cannot
 * request money back to their card; a credit only ever becomes account balance
 * to spend on future care. The former `originalPaymentMethod` target, which
 * issued a real Stripe refund against `invoice.originalPaymentIntentId`, has
 * been removed along with the Stripe leg, its compensating rollback, and the
 * `refundId` in the result. No invoice in the database ever used it.
 *
 * Concurrency / money safety (CRITICAL-3):
 *   The guard + apply + stamp run claim-first inside a single Firestore
 *   transaction. The transaction re-reads `creditRedeemedAt`, bails if it is
 *   already set, then stamps it in the SAME transaction — so two concurrent
 *   redeems can never both pass the guard (the second re-reads the committed
 *   stamp and fails). The balance increment is applied INSIDE the transaction
 *   (atomic with the stamp): we read the old balance and write old+amount, so a
 *   lost-update double-increment is impossible. With the Stripe leg gone there
 *   is no longer any external side effect after the claim, so the claim can no
 *   longer need releasing.
 */
export async function redeemCreditHandler(req: CallableRequest<unknown>): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');

  const invoiceRef = firestore.collection('invoices').doc(args.invoiceId);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Invoice not found.');
  const inv = invoiceSnap.data() as Record<string, unknown>;

  const invKinfolkId = typeof inv['kinfolkId'] === 'string' ? (inv['kinfolkId'] as string) : null;
  if (!invKinfolkId) throw new HttpsError('failed-precondition', 'Invoice not linked to a tribe.');
  if (!allowed.includes(invKinfolkId)) throw new HttpsError('permission-denied', 'No access.');
  await requireKinfolkPrimary(uid, invKinfolkId, req.auth?.token?.admin === true, 'redeemCredit');

  const familyRef = firestore.collection('families').doc(invKinfolkId);

  // Atomic claim + apply. Everything from the credit guard through the stamp
  // (and the accountBalance increment) runs inside ONE transaction so a
  // concurrent second redeem re-reads the stamped `creditRedeemedAt` and fails.
  const claim = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found.');
    const txInv = snap.data() as Record<string, unknown>;

    // `status` is canonical; `invoiceStatus` is the legacy spelling still written
    // by the sandbox seed, so it is read as a fallback.
    const rawStatus = txInv['status'] ?? txInv['invoiceStatus'];
    const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : null;
    const amountDue = numericFrom(txInv['amountDue']);
    const total = numericFrom(txInv['total']);
    const isCredit = status === 'credit' || amountDue < 0 || total < 0;
    if (!isCredit) throw new HttpsError('failed-precondition', 'Not a credit invoice.');
    // ATOMIC guard: re-checked inside the tx, stamped inside the tx -> a concurrent
    // second redeem re-reads the stamped value and fails here.
    if (txInv['creditRedeemedAt'] != null) throw new HttpsError('failed-precondition', 'Credit already redeemed.');

    const sourceAmount = amountDue !== 0 ? amountDue : total;
    const amountCents = Math.round(Math.abs(sourceAmount) * 100);
    if (amountCents <= 0) throw new HttpsError('failed-precondition', 'Credit amount is zero.');

    // ALL READS BEFORE WRITES.
    const famSnap = await tx.get(familyRef);
    const oldBal = numericFrom(famSnap.data()?.['accountBalanceCents']);
    const newAccountBalanceCents = oldBal + amountCents;

    // WRITES: stamp the claim and apply the balance, atomically together.
    const update = {
      creditTarget: 'accountBalance',
      creditAmountCents: amountCents,
      creditRedeemedAt: FieldValue.serverTimestamp(),
      creditRedeemedByUid: uid,
      status: 'credit',
    };
    // The state stamp (ADR-0002), inside the SAME transaction as the claim:
    // with `creditRedeemedAt` set, the classifier reads the merged doc as
    // `redeemed`, so that is what `status` stores (the classifier reads
    // 'redeemed' as a credit-family label, so the doc keeps classifying as
    // itself everywhere). paidCents is passed as 0 WITHOUT reading the
    // payments subcollection, deliberately: the whole credit family maps to
    // editScope 'none' regardless of standing (`invoiceEditScope`), so the
    // read could not change the stamp and would only widen the transaction.
    tx.set(invoiceRef, { ...update, ...invoiceStateStampOf({ ...txInv, ...update }, 0) }, { merge: true });
    tx.set(familyRef, { accountBalanceCents: newAccountBalanceCents }, { merge: true });

    return { amountCents, newAccountBalanceCents };
  });

  logEvent({
    severity: 'info',
    function: 'redeemCredit',
    event: 'portal.credit.redeemed',
    uid,
    extra: {
      invoiceId: args.invoiceId,
      kinfolkId: invKinfolkId,
      amountCents: claim.amountCents,
      target: 'accountBalance',
    },
  });

  return validateResponse('redeemCredit', Result, {
    ok: true,
    redeemedAmountCents: claim.amountCents,
    target: 'accountBalance',
    newAccountBalanceCents: claim.newAccountBalanceCents,
  });
}

function numericFrom(v: unknown): number {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export const redeemCredit = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('redeemCredit', redeemCreditHandler),
);
