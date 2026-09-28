import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isOwner, refuseAuntie } from '../lib/staffGate';
import { testModeOf } from '../lib/testMode';
import { resolveNonStaffKinfolkId } from '../lib/resolveNonStaffKinfolkId';
import { hasBillingAccess } from '../lib/memberGate';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';
import { ACCOUNT_BALANCE_FIELD, readAccountBalanceCents } from '../lib/accountCredit';
import {
  CREDIT_LEDGER_COLLECTION,
  MAX_CREDIT_LEDGER_EVENTS,
  creditHistoryOf,
  readCreditLedgerEvent,
  type CreditLedgerEvent,
} from '../lib/creditLedger';

/**
 * A HOUSEHOLD'S CREDIT HISTORY (operator ruling 2026-09-27, docket Q6): each
 * credit given, its date, its reason, and the date it was applied when used.
 *
 * WHO SEES IT. "Those with billing access: biz owner/admin, PK, and SK if PK
 * granted access." So:
 *
 *   owner                  any household, by id.
 *   sandbox test admin     their own test tribe only.
 *   kinfolk                their own household (the `clients/{uid}.kinfolkIds`
 *                          check every portal callable uses), AND billing access
 *                          there: the PRIMARY, or a secondary holding
 *                          `billing_full`. The same test the rules make with
 *                          `hasPerm(fid, 'billing_full')`, through
 *                          `hasBillingAccess` (#1005's one helper).
 *
 * The household check runs FIRST and is not optional. `hasKinfolkPerm` answers
 * true when the caller has no member doc there (the legacy-primary
 * anti-lockout), so on its own it would admit anyone naming a household that
 * is not theirs.
 *
 * Everyone else is refused with `permission-denied`, and the clients hide the
 * section on that code. An Auntie never sees money and is refused by role.
 *
 * READ ONLY. The events are server-written and no Firestore rule matches
 * `families/{id}/creditLedger`, so this callable is the only way to see them.
 */

export const Args = z
  .object({
    kinfolkId: z.string().min(1).max(200).optional(),
  })
  .strict();

const ApplicationSchema = z
  .object({
    appliedAtMs: z.number().int(),
    amountCents: CentsSchema,
    invoiceId: z.string(),
    invoiceNumber: z.string().nullable(),
  })
  .strict();

const GivenCreditSchema = z
  .object({
    creditId: z.string().min(1),
    amountCents: CentsSchema,
    reason: z.string(),
    givenAtMs: z.number().int(),
    /** What is still unspent of this credit. */
    remainingCents: CentsSchema,
    /** When the last of it was spent, or null while any is left. */
    fullyAppliedAtMs: z.number().int().nullable(),
    /** Every use of part of it, oldest first. */
    applications: z.array(ApplicationSchema),
  })
  .strict();

const CreditUseSchema = z
  .object({
    useId: z.string().min(1),
    usedAtMs: z.number().int(),
    amountCents: CentsSchema,
    invoiceId: z.string(),
    invoiceNumber: z.string().nullable(),
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    kinfolkId: z.string().min(1),
    /** The spendable balance, `families/{id}.accountBalanceCents`. */
    accountBalanceCents: SignedCentsSchema,
    /** Credits given by the office, newest first. */
    credits: z.array(GivenCreditSchema),
    /** Every time credit was spent on an invoice, newest first. */
    uses: z.array(CreditUseSchema),
  })
  .strict();

export type GetAccountCreditHistoryArgs = z.infer<typeof Args>;
export type GetAccountCreditHistoryResult = z.infer<typeof Result>;

/** Which household this caller may read the history of. Throws when none. */
async function resolveHousehold(
  req: CallableRequest<unknown>,
  requested: string | undefined,
): Promise<string> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  // An Auntie was already refused by role, so the `admin` claim is the owner here.
  if (isOwner(uid, req.auth?.token?.admin === true, 'getAccountCreditHistory')) {
    if (!requested) throw new HttpsError('invalid-argument', 'kinfolkId is required.');
    return requested;
  }

  const mode = testModeOf(req.auth?.token as Record<string, unknown> | undefined);
  if (mode.active) {
    const id = requested ?? mode.testTribeId;
    if (id !== mode.testTribeId) {
      throw new HttpsError('permission-denied', 'This household is outside your test sandbox.');
    }
    return id;
  }

  const kinfolkId = await resolveNonStaffKinfolkId(uid, requested);
  const billing = await hasBillingAccess(uid, kinfolkId, false, 'getAccountCreditHistory');
  if (!billing) {
    logEvent({
      severity: 'info',
      function: 'getAccountCreditHistory',
      event: 'portal.credit.history.refused',
      uid,
      familyId: kinfolkId,
      extra: { reason: 'no_billing_access' },
    });
    throw new HttpsError('permission-denied', 'Billing access is required to see account credit.');
  }
  return kinfolkId;
}

export async function getAccountCreditHistoryHandler(
  req: CallableRequest<unknown>,
): Promise<GetAccountCreditHistoryResult> {
  initSentry();
  refuseAuntie(req.auth, 'getAccountCreditHistory');

  let args: GetAccountCreditHistoryArgs;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getAccountCreditHistory validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const kinfolkId = await resolveHousehold(req, args.kinfolkId);

  const firestore = db();
  const famRef = firestore.collection('families').doc(kinfolkId);
  const [famSnap, eventsSnap] = await Promise.all([
    famRef.get(),
    famRef.collection(CREDIT_LEDGER_COLLECTION).orderBy('atMs').limit(MAX_CREDIT_LEDGER_EVENTS).get(),
  ]);
  if (!famSnap.exists) throw new HttpsError('not-found', 'Household not found.');

  const events: CreditLedgerEvent[] = [];
  for (const d of eventsSnap.docs) {
    const ev = readCreditLedgerEvent(d.id, (d.data() ?? {}) as Record<string, unknown>);
    if (ev !== null) events.push(ev);
  }
  if (eventsSnap.docs.length >= MAX_CREDIT_LEDGER_EVENTS) {
    logEvent({
      severity: 'warn',
      function: 'getAccountCreditHistory',
      event: 'portal.credit.history.truncated',
      familyId: kinfolkId,
      extra: { limit: MAX_CREDIT_LEDGER_EVENTS },
    });
  }

  const history = creditHistoryOf(events);

  return validateResponse('getAccountCreditHistory', Result, {
    ok: true,
    kinfolkId,
    accountBalanceCents: readAccountBalanceCents((famSnap.data() ?? {})[ACCOUNT_BALANCE_FIELD]),
    credits: history.credits.map((c) => ({
      creditId: c.id,
      amountCents: c.amountCents,
      reason: c.reason,
      givenAtMs: c.givenAtMs,
      remainingCents: c.remainingCents,
      fullyAppliedAtMs: c.fullyAppliedAtMs,
      applications: c.applications.map((a) => ({
        appliedAtMs: a.atMs,
        amountCents: a.amountCents,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoiceNumber,
      })),
    })),
    uses: history.uses.map((u) => ({
      useId: u.id,
      usedAtMs: u.atMs,
      amountCents: u.amountCents,
      invoiceId: u.invoiceId,
      invoiceNumber: u.invoiceNumber,
    })),
  });
}

export const getAccountCreditHistory = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getAccountCreditHistory', getAccountCreditHistoryHandler),
);
