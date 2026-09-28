import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { refuseAuntie } from '../lib/staffGate';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { assertSameCaller } from '../lib/moneyIdempotency';
import { sendIdempotencyKeyRe } from '../lib/sendIdempotency';
import { ACCOUNT_BALANCE_FIELD, readAccountBalanceCents } from '../lib/accountCredit';
import {
  MAX_CREDIT_REASON_LENGTH,
  MAX_GIVEN_CREDIT_CENTS,
  creditLedgerRef,
} from '../lib/creditLedger';

/**
 * GIVE A HOUSEHOLD ACCOUNT CREDIT (operator ruling 2026-09-27, docket Q6).
 *
 * "Build Give credit on the household (amount, reason), web, Android and
 * desktop, with an audit entry." The only way to add credit with no payment
 * behind it. #988 made every other credit an amount the admin chooses on a
 * payment; this is the one she gives outright, for a reason she writes down.
 *
 * WHAT IT WRITES, IN ONE TRANSACTION
 *
 *   `families/{id}/creditLedger/{key}`  the `given` event: amount, reason, who,
 *                                       when (`lib/creditLedger.ts`).
 *   `families/{id}.accountBalanceCents` the balance, as the absolute figure
 *                                       read in the same transaction plus the
 *                                       amount. Safe inside a transaction, the
 *                                       same way `redeemCredit` does it, and it
 *                                       lets the answer carry the new balance.
 *
 * Then, after the commit, one audit row at a fixed id so a retry cannot write a
 * second. No refunds ever (operator ruling 2026-08-06): this only ever adds to
 * the balance, and nothing here moves money back out.
 *
 * WHO. The owner, or a sandbox test admin inside their own test tribe (the same
 * gate as every invoice-surface callable, `resolveInvoiceWriteActor`). An
 * Auntie never sees money: `refuseAuntie` refuses her by role first. Kinfolk
 * have no admin claim and are refused by the actor gate.
 *
 * IDEMPOTENCY. The key is REQUIRED (a new callable has no older client to keep
 * working) and is the event's doc id. A replay of the same key is answered from
 * the stored event and never adds credit twice; the same key from another admin
 * is refused (`assertSameCaller`).
 *
 * THE CAP, $5,000.00. A credit here is a goodwill amount or a correction, and
 * the largest plausible one is a month of daily visits for one household. $5,000
 * is well above that, and it stops the slip that matters: an extra zero typed on
 * a large figure ($1,000 becoming $10,000) is refused instead of handed to a
 * household as spendable money that cannot be clawed back by refund.
 */

export const GIVE_CREDIT_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('crd');

export const Args = z
  .object({
    kinfolkId: z.string().min(1).max(200),
    /** Integer cents, more than zero, at most MAX_GIVEN_CREDIT_CENTS. */
    amountCents: z.number().int().min(1).max(MAX_GIVEN_CREDIT_CENTS),
    /** Why. Required, shown to the household with billing access. */
    reason: z.string().trim().min(1).max(MAX_CREDIT_REASON_LENGTH),
    idempotencyKey: z
      .string()
      .regex(GIVE_CREDIT_IDEMPOTENCY_KEY_RE, 'idempotencyKey must look like crd_<millis>_<suffix>'),
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    /** The `given` event's id, which is the idempotency key. */
    creditId: z.string().min(1),
    amountCents: CentsSchema,
    /**
     * The household's balance right after this credit was added. SIGNED, like
     * `redeemCredit`'s: it is a running household balance, not a bounded figure.
     */
    newAccountBalanceCents: SignedCentsSchema,
    /** True when this answer is a replay of an earlier call with the same key. */
    replayed: z.boolean(),
  })
  .strict();

export type GiveAccountCreditArgs = z.infer<typeof Args>;
export type GiveAccountCreditResult = z.infer<typeof Result>;

function replayResult(id: string, stored: Record<string, unknown>): GiveAccountCreditResult {
  const amount = stored['amountCents'];
  const after = stored['balanceAfterCents'];
  return {
    ok: true,
    creditId: id,
    amountCents: typeof amount === 'number' ? Math.round(amount) : 0,
    newAccountBalanceCents: typeof after === 'number' ? Math.round(after) : 0,
    replayed: true,
  };
}

export async function giveAccountCreditHandler(
  req: CallableRequest<unknown>,
): Promise<GiveAccountCreditResult> {
  initSentry();
  // Before the actor gate, so her refusal is logged as a caretaker refusal.
  refuseAuntie(req.auth, 'giveAccountCredit');
  const actor = resolveInvoiceWriteActor(req, 'giveAccountCredit');

  let args: GiveAccountCreditArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'giveAccountCredit validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  if (!testOwnsDoc(actor.testMode, args.kinfolkId)) {
    throw new HttpsError('permission-denied', 'This household is outside your test sandbox.');
  }

  const firestore = db();
  const famRef = firestore.collection('families').doc(args.kinfolkId);
  const eventRef = creditLedgerRef(firestore, args.kinfolkId, args.idempotencyKey);

  // THE FAST PATH: a key already stored is answered from its event before
  // anything else runs, so a retry can never add the credit a second time.
  const existing = await eventRef.get();
  if (existing.exists) {
    const stored = (existing.data() ?? {}) as Record<string, unknown>;
    assertSameCaller(stored, actor.uid, 'givenBy');
    logEvent({
      severity: 'info',
      function: 'giveAccountCredit',
      event: 'admin.credit.given.replay',
      uid: actor.uid,
      extra: { kinfolkId: args.kinfolkId, creditId: eventRef.id },
    });
    return validateResponse('giveAccountCredit', Result, replayResult(eventRef.id, stored));
  }

  const atMs = Date.now();
  const committed = await firestore.runTransaction(async (tx) => {
    // ALL READS BEFORE WRITES.
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) {
      const stored = (eventSnap.data() ?? {}) as Record<string, unknown>;
      assertSameCaller(stored, actor.uid, 'givenBy');
      return { replayed: stored, before: 0, after: 0 };
    }
    const famSnap = await tx.get(famRef);
    if (!famSnap.exists) throw new HttpsError('not-found', 'Household not found.');
    const before = readAccountBalanceCents((famSnap.data() ?? {})[ACCOUNT_BALANCE_FIELD]);
    const after = before + args.amountCents;

    tx.create(eventRef, {
      kind: 'given',
      amountCents: args.amountCents,
      reason: args.reason,
      givenBy: actor.uid,
      balanceBeforeCents: before,
      balanceAfterCents: after,
      atMs,
      testMode: actor.testMode.active,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      famRef,
      {
        [ACCOUNT_BALANCE_FIELD]: after,
        accountBalanceUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { replayed: null, before, after };
  });

  if (committed.replayed !== null) {
    logEvent({
      severity: 'info',
      function: 'giveAccountCredit',
      event: 'admin.credit.given.replay',
      uid: actor.uid,
      extra: { kinfolkId: args.kinfolkId, creditId: eventRef.id, raced: true },
    });
    return validateResponse('giveAccountCredit', Result, replayResult(eventRef.id, committed.replayed));
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_ACCOUNT_CREDIT_GIVEN,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: args.kinfolkId,
    targetCollection: 'families',
    familyId: args.kinfolkId,
    description: `Account credit of ${args.amountCents} cents given to household ${args.kinfolkId}`,
    payload: {
      kinfolkId: args.kinfolkId,
      creditId: eventRef.id,
      amountCents: args.amountCents,
      reason: args.reason,
      balanceBeforeCents: committed.before,
      balanceAfterCents: committed.after,
      testMode: actor.testMode.active,
      idempotencyKey: args.idempotencyKey,
    },
    docId: `account_credit_given_${args.idempotencyKey}`,
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'giveAccountCredit',
      event: 'audit.write.failed',
      uid: actor.uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'giveAccountCredit',
    event: 'admin.credit.given',
    uid: actor.uid,
    extra: {
      kinfolkId: args.kinfolkId,
      creditId: eventRef.id,
      amountCents: args.amountCents,
      balanceAfterCents: committed.after,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('giveAccountCredit', Result, {
    ok: true,
    creditId: eventRef.id,
    amountCents: args.amountCents,
    newAccountBalanceCents: committed.after,
    replayed: false,
  });
}

export const giveAccountCredit = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as every other callable on the invoice surface.
  wrapCallable('giveAccountCredit', giveAccountCreditHandler),
);
