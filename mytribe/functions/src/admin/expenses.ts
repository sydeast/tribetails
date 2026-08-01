import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * AO-40 Expense Quick-Log (dashboard widget). Admin-only `expenses` collection.
 * logExpense mints one expense; listExpenses returns the recent window plus
 * week + month running totals the widget renders. Fail loud: no fabricated
 * numbers, an honest empty list when nothing is logged.
 */

export const EXPENSES_COLLECTION = 'expenses';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const ExpenseKind = z.enum(['gas', 'parking', 'supplies', 'other']);

const isoString = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO instant' });

export const LogExpenseArgs = z.object({
  kind: ExpenseKind,
  amountCents: z.number().int().min(1).max(100_000_00),
  note: z.string().max(500).default(''),
  occurredAt: isoString.optional(),
});

export const ListExpensesArgs = z.object({
  sinceIso: isoString.optional(),
});

export interface ExpenseRow {
  _id: string;
  kind: z.infer<typeof ExpenseKind>;
  amountCents: number;
  note: string;
  occurredAt: string;
}

/**
 * Pure summary: sums amountCents over the trailing 7-day and 30-day windows
 * from `nowMs`. Split out so it is unit-tested without Firestore.
 */
export function summarizeExpenses(
  rows: ExpenseRow[],
  nowMs: number,
): { weekTotalCents: number; monthTotalCents: number } {
  const weekFloor = nowMs - WEEK_MS;
  const monthFloor = nowMs - MONTH_MS;
  let weekTotalCents = 0;
  let monthTotalCents = 0;
  for (const r of rows) {
    const t = Date.parse(r.occurredAt);
    if (Number.isNaN(t)) continue;
    if (t >= monthFloor) monthTotalCents += r.amountCents;
    if (t >= weekFloor) weekTotalCents += r.amountCents;
  }
  return { weekTotalCents, monthTotalCents };
}

export async function logExpenseHandler(
  req: CallableRequest<unknown>,
): Promise<{ id: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof LogExpenseArgs>;
  try {
    args = LogExpenseArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'logExpense validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const occurredAt = args.occurredAt ?? new Date().toISOString();
  const ref = db().collection(EXPENSES_COLLECTION).doc();
  await ref.set({
    kind: args.kind,
    amountCents: args.amountCents,
    note: args.note,
    occurredAt,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.EXPENSE_LOGGED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: EXPENSES_COLLECTION,
    payload: { id: ref.id, kind: args.kind, amountCents: args.amountCents },
  });

  logEvent({
    severity: 'info',
    function: 'logExpense',
    event: 'admin.expense.logged',
    uid,
    extra: { id: ref.id, kind: args.kind, amountCents: args.amountCents },
  });

  return { id: ref.id };
}

export async function listExpensesHandler(
  req: CallableRequest<unknown>,
): Promise<{ expenses: ExpenseRow[]; weekTotalCents: number; monthTotalCents: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof ListExpensesArgs>;
  try {
    args = ListExpensesArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listExpenses validation failed');
    }
    throw err;
  }

  const nowMs = Date.now();
  const sinceIso = args.sinceIso ?? new Date(nowMs - MONTH_MS).toISOString();
  // Totals always cover the trailing 30 days, so read from whichever floor is
  // earlier: the caller's `sinceIso` or the month floor. The returned list is
  // then filtered to `>= sinceIso`; totals are computed over the full read set.
  const monthFloorIso = new Date(nowMs - MONTH_MS).toISOString();
  const readFloorIso = sinceIso < monthFloorIso ? sinceIso : monthFloorIso;

  const snap = await db()
    .collection(EXPENSES_COLLECTION)
    .where('occurredAt', '>=', readFloorIso)
    .orderBy('occurredAt', 'desc')
    .get();

  const all: ExpenseRow[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const kindRaw = typeof data.kind === 'string' ? data.kind : 'other';
    const kind = (['gas', 'parking', 'supplies', 'other'].includes(kindRaw)
      ? kindRaw
      : 'other') as z.infer<typeof ExpenseKind>;
    return {
      _id: d.id,
      kind,
      amountCents: typeof data.amountCents === 'number' ? data.amountCents : 0,
      note: typeof data.note === 'string' ? data.note : '',
      occurredAt: typeof data.occurredAt === 'string' ? data.occurredAt : '',
    };
  });

  const { weekTotalCents, monthTotalCents } = summarizeExpenses(all, nowMs);
  const expenses = all.filter((r) => r.occurredAt >= sinceIso);

  return { expenses, weekTotalCents, monthTotalCents };
}

export const logExpense = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('logExpense', logExpenseHandler),
);

export const listExpenses = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listExpenses', listExpensesHandler),
);
