import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  invoiceId: z.string().min(1),
  kinfolkId: z.string().optional(),
  target: z.enum(['accountBalance', 'originalPaymentMethod']),
});

interface RedeemCreditResult {
  ok: true;
  redeemedAmountCents: number;
  target: 'accountBalance' | 'originalPaymentMethod';
  newAccountBalanceCents: number | null;
  refundId: string | null;
}

/**
 * Redeems a credit invoice (negative amountDue or invoiceStatus='credit') into one of:
 *   - accountBalance: bumps `families/{kinfolkId}.accountBalanceCents` by |amount|
 *   - originalPaymentMethod: Stripe refund against `invoice.originalPaymentIntentId`
 *
 * Concurrency / money safety (CRITICAL-3):
 *   The guard + apply + stamp run claim-first inside a single Firestore
 *   transaction. The transaction re-reads `creditRedeemedAt`, bails if it is
 *   already set, then stamps it in the SAME transaction — so two concurrent
 *   redeems can never both pass the guard (the second re-reads the committed
 *   stamp and fails). For accountBalance, the balance increment is applied
 *   INSIDE the transaction (atomic with the stamp): we read the old balance and
 *   write old+amount, so a lost-update double-increment is impossible. The
 *   Stripe refund leg necessarily happens AFTER the claim (external side
 *   effect) and carries `idempotencyKey: credit-<invoiceId>` so even a retry
 *   that re-reaches Stripe cannot double-refund. If the refund fails after the
 *   claim, the claim is released (creditRedeemedAt -> null) so the user can
 *   retry.
 */
export async function redeemCreditHandler(req: CallableRequest<unknown>): Promise<RedeemCreditResult> {
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

    const status =
      typeof txInv['invoiceStatus'] === 'string' ? (txInv['invoiceStatus'] as string).toLowerCase() : null;
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
    let pi: string | null = null;
    let newAccountBalanceCents: number | null = null;
    if (args.target === 'originalPaymentMethod') {
      pi = typeof txInv['originalPaymentIntentId'] === 'string' ? (txInv['originalPaymentIntentId'] as string) : null;
      if (!pi) {
        throw new HttpsError(
          'failed-precondition',
          "No original payment recorded, can't refund to the original card. Pick Save to Account Balance.",
        );
      }
    } else {
      const famSnap = await tx.get(familyRef);
      const oldBal = numericFrom(famSnap.data()?.['accountBalanceCents']);
      newAccountBalanceCents = oldBal + amountCents;
    }

    // WRITES: stamp the claim (creditRefundId filled after the Stripe leg).
    tx.set(
      invoiceRef,
      {
        creditTarget: args.target,
        creditAmountCents: amountCents,
        creditRedeemedAt: FieldValue.serverTimestamp(),
        creditRedeemedByUid: uid,
        creditRefundId: null,
        invoiceStatus: 'credit',
      },
      { merge: true },
    );
    if (args.target === 'accountBalance') {
      tx.set(familyRef, { accountBalanceCents: newAccountBalanceCents }, { merge: true });
    }

    return { amountCents, newAccountBalanceCents, pi };
  });

  let refundId: string | null = null;
  if (args.target === 'originalPaymentMethod') {
    try {
      const refund = await getStripe().refunds.create(
        { payment_intent: claim.pi as string, amount: claim.amountCents },
        { idempotencyKey: `credit-${args.invoiceId}` },
      );
      refundId = refund.id;
      await invoiceRef.set({ creditRefundId: refundId }, { merge: true });
    } catch (e) {
      // Refund failed AFTER the claim. Release the claim (creditRedeemedAt ->
      // null) so the user can retry; the idempotencyKey ensures a retry can't
      // double-refund even if the first call actually reached Stripe.
      await invoiceRef.set(
        {
          creditRedeemedAt: null,
          creditTarget: null,
          creditAmountCents: null,
          creditRedeemedByUid: null,
        },
        { merge: true },
      );
      throw new HttpsError('unavailable', `Refund failed: ${(e as Error).message}`);
    }
  }

  logEvent({
    severity: 'info',
    function: 'redeemCredit',
    event: 'portal.credit.redeemed',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId: invKinfolkId, amountCents: claim.amountCents, target: args.target, refundId },
  });

  return {
    ok: true,
    redeemedAmountCents: claim.amountCents,
    target: args.target,
    newAccountBalanceCents: claim.newAccountBalanceCents,
    refundId,
  };
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
