/**
 * CLOSING AN INVOICE'S OPEN STRIPE CHECKOUT SESSIONS, AND SAYING HOW IT WENT
 * (#1113). Shared by `triggers/onInvoicePaidExpireCheckouts` (the automatic
 * pass when an invoice becomes paid) and the `retryInvoiceCheckoutClose`
 * callable (the operator's "Try again").
 *
 * WHAT THE INVOICE CARRIES AFTERWARDS, for the invoice detail screens:
 *
 *   checkoutSweep: {
 *     expiredIds: string[]     sessions this code actually expired (open ones)
 *     failed: [{ sessionId, reason }]   still open at Stripe; `reason` is
 *                              Stripe's own plain message
 *     ranAt: Timestamp         when the last pass ran
 *   }
 *
 * `failed` is REPLACED on every pass: a pass always tries every id not yet in
 * `closedCheckoutSessionIds`, so its failures are the complete current list.
 * `expiredIds` only grows. An invoice with no open links never gets the field,
 * so the screens show nothing for it.
 *
 * `closedCheckoutSessionIds` keeps its job (the idempotency list the plan
 * subtracts) and is written exactly as before. This only adds the readable
 * outcome beside it. Payment behaviour is unchanged.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { getStripe } from './stripe';
import { CLOSED_CHECKOUT_SESSIONS_FIELD } from './checkoutSessionSweep';
export const CHECKOUT_SWEEP_FIELD = 'checkoutSweep';
/** The two Stripe calls this needs, typed on what is read so a test can stub them. */
export interface CheckoutSessionsApi {
  retrieve: (id: string) => Promise<unknown>;
  expire: (id: string) => Promise<unknown>;
}
export type SessionOutcome = 'expired' | 'already-closed' | 'not-found' | 'failed';
export interface SweepFailure {
  sessionId: string;
  reason: string;
}
export interface SweepRun {
  /** Ids to add to `closedCheckoutSessionIds`: everything that is no longer payable. */
  closed: string[];
  /** The subset this pass actually expired. */
  expired: string[];
  failed: SweepFailure[];
  outcomes: Record<string, SessionOutcome>;
}
/** What the screen shows when Stripe could not be reached at all (no key, no network). */
export const STRIPE_UNREACHABLE_REASON = 'Stripe could not be reached from the server.';
const MAX_REASON = 300;
function statusOf(raw: unknown): string {
  const s = (raw ?? {}) as { status?: unknown };
  return typeof s.status === 'string' ? s.status : '';
}
function isNotFound(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; raw?: { code?: unknown } };
  return e.code === 'resource_missing' || e.raw?.code === 'resource_missing' || e.statusCode === 404;
}
/** Stripe's own sentence, trimmed. Never the stack, never a key (Stripe masks keys itself). */
export function plainReason(err: unknown): string {
  const msg = (err as { message?: unknown } | null)?.message;
  const text = typeof msg === 'string' ? msg.replace(/\s+/g, ' ').trim() : '';
  return (text || 'Stripe refused the request.').slice(0, MAX_REASON);
}
export async function closeCheckoutSessionDetailed(
  api: CheckoutSessionsApi,
  id: string,
): Promise<{ outcome: SessionOutcome; reason?: string }> {
  let session: unknown;
  try {
    session = await api.retrieve(id);
  } catch (err) {
    return isNotFound(err) ? { outcome: 'not-found' } : { outcome: 'failed', reason: plainReason(err) };
  }
  if (statusOf(session) !== 'open') return { outcome: 'already-closed' };
  try {
    await api.expire(id);
    return { outcome: 'expired' };
  } catch (expireErr) {
    // Completed or expired between the two calls, or a real failure. Ask again.
    try {
      return statusOf(await api.retrieve(id)) === 'open'
        ? { outcome: 'failed', reason: plainReason(expireErr) }
        : { outcome: 'already-closed' };
    } catch (err) {
      return isNotFound(err) ? { outcome: 'not-found' } : { outcome: 'failed', reason: plainReason(err) };
    }
  }
}
export async function closeCheckoutSession(api: CheckoutSessionsApi, id: string): Promise<SessionOutcome> {
  return (await closeCheckoutSessionDetailed(api, id)).outcome;
}
export async function liveSessionsApi(): Promise<CheckoutSessionsApi> {
  const s = await getStripe();
  return {
    retrieve: (id: string) => s.checkout.sessions.retrieve(id),
    expire: (id: string) => s.checkout.sessions.expire(id),
  };
}
export async function runCheckoutSweep(api: CheckoutSessionsApi, ids: string[]): Promise<SweepRun> {
  const run: SweepRun = { closed: [], expired: [], failed: [], outcomes: {} };
  for (const id of ids) {
    const { outcome, reason } = await closeCheckoutSessionDetailed(api, id);
    run.outcomes[id] = outcome;
    if (outcome === 'failed') run.failed.push({ sessionId: id, reason: reason ?? 'Stripe refused the request.' });
    else run.closed.push(id);
    if (outcome === 'expired') run.expired.push(id);
  }
  return run;
}
/** A run where Stripe was never reached: every id is still open, with one reason. */
export function unreachableRun(ids: string[]): SweepRun {
  return {
    closed: [],
    expired: [],
    failed: ids.map((sessionId) => ({ sessionId, reason: STRIPE_UNREACHABLE_REASON })),
    outcomes: Object.fromEntries(ids.map((id) => [id, 'failed' as SessionOutcome])),
  };
}
/** The write that records a run on the invoice. Pure, so a test can read it. */
export function sweepRecord(run: SweepRun): Record<string, unknown> {
  const sweep: Record<string, unknown> = {
    failed: run.failed,
    ranAt: FieldValue.serverTimestamp(),
  };
  if (run.expired.length > 0) sweep.expiredIds = FieldValue.arrayUnion(...run.expired);
  const out: Record<string, unknown> = { [CHECKOUT_SWEEP_FIELD]: sweep };
  if (run.closed.length > 0) {
    out[CLOSED_CHECKOUT_SESSIONS_FIELD] = FieldValue.arrayUnion(...run.closed);
    out.checkoutSessionsClosedAt = FieldValue.serverTimestamp();
  }
  return out;
}
export async function recordCheckoutSweep(invoiceId: string, run: SweepRun): Promise<void> {
  await db().collection('invoices').doc(invoiceId).set(sweepRecord(run), { merge: true });
}
/**
 * Whether a write is this module's own record. `ranAt` moves only when a pass
 * is recorded, so a trigger that sees it move knows the write is the sweep
 * talking, not the invoice changing, and must not sweep again (a failed pass
 * would otherwise record itself in a loop).
 */
export function sweepRanAtKey(doc: unknown): string {
  const ran = ((doc ?? {}) as Record<string, { ranAt?: unknown } | undefined>)[CHECKOUT_SWEEP_FIELD]?.ranAt as
    | { toMillis?: () => number }
    | undefined;
  if (!ran) return '';
  return typeof ran.toMillis === 'function' ? String(ran.toMillis()) : JSON.stringify(ran);
}
