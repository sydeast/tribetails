import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isSessionCancelled, isSessionClaimed } from './sessionInvoicing';

/**
 * #1901 / #1970 / #2091: ONE place that sets and clears a visit's billed link.
 *
 * A visit is "billed" by an invoice in two places that have to agree: the
 * invoice's `sessionIds` names it, and the visit's own `invoiceId` names the
 * invoice back. `listUninvoicedSessions` reads only the visit's side, the
 * ledger reads both and warns when they differ. Three callables change which
 * visits an invoice bills:
 *
 *   - `createInvoice` (New invoice) claims the visits its lines were drawn from.
 *     Until #1901 it stored `sessionIds` and never touched the visits, so the
 *     visit stayed un-invoiced and was offered for the next invoice too.
 *   - `updateInvoice` (Edit) replaces the lines wholesale. Until #1970 removing
 *     a visit's line left the visit linked on both sides.
 *   - `linkInvoiceSessions` (Link visits) sets the set directly.
 *
 * Each now goes through this module, inside its own transaction, so both sides
 * move together or not at all. The split into a READ step and a STAGE step is
 * Firestore's rule, not a style: every read in a transaction comes before any
 * write, and `createInvoice` has its own reads and writes (the number counter)
 * to slot around these.
 */

/** The distinct, non-blank visit ids the lines are bound to, in line order. */
export function boundSessionIds(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const line of lines) {
    const sid = (line as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sid !== 'string') continue;
    const id = sid.trim();
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The stored `sessionIds`, tolerant of legacy docs where the field is absent or junk. */
export function storedSessionIds(data: Record<string, unknown>): string[] {
  const raw = data['sessionIds'];
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
}

/**
 * The linked visits this invoice carries no line for. Every one of them is off
 * the un-invoiced list without its price being on this invoice, which is the
 * thing #2091 says nobody was told. An un-itemized invoice (a typed total, no
 * lines) reports every linked visit here: its total was typed, not drawn from
 * the visits.
 */
export function linkedWithoutLine(sessionIds: readonly string[], lines: unknown): string[] {
  const bound = new Set(boundSessionIds(lines));
  return sessionIds.filter((id) => !bound.has(id));
}

/** How a visit is named in a refusal the clients show verbatim: its day, never its id. */
function visitWords(data: Record<string, unknown> | undefined): string {
  const start = typeof data?.['startTime'] === 'string' ? (data['startTime'] as string).trim() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(start) ? `the visit on ${start.slice(0, 10)}` : 'a visit with no date';
}

export interface SessionLinkRequest {
  /** The invoice that is taking or giving up the visits. */
  invoiceId: string;
  /** Visits to mark as billed by this invoice. */
  claim: readonly string[];
  /** Visits this invoice no longer bills. */
  release: readonly string[];
  /**
   * Called once per touched visit that exists, BEFORE any refusal is decided,
   * so a caller with a scope rule (the test sandbox) can throw its own error
   * first. Optional.
   */
  checkScope?: (sessionId: string, data: Record<string, unknown>) => void;
}

/** What the read step decided. Pass it, unchanged, to `stageSessionLinks`. */
export interface SessionLinkPlan {
  invoiceId: string;
  /** Visits whose back-link is set to this invoice. */
  claim: string[];
  /**
   * Visits whose back-link is cleared. A visit whose back-link names ANOTHER
   * invoice is left alone (#1259): that invoice still bills it, and clearing it
   * would offer the visit to the composer again.
   */
  release: string[];
}

/**
 * The READ half. Reads every touched visit inside `tx` and refuses, before
 * anything is written, a claim on a visit that:
 *
 *   - does not exist (`session_not_found`): an invoice must not bill work with
 *     no record behind it;
 *   - was cancelled (`session_cancelled`, #1609): work that did not happen;
 *   - is already billed by another invoice (`session_on_other_invoice`,
 *     #1254): taking it would bill the same work twice. Two New invoice saves
 *     for one visit reaching the server together are refereed here: Firestore
 *     re-runs the second transaction against what the first committed, and the
 *     re-run sees the claim.
 *
 * A back-link that already names THIS invoice is a half-link being completed,
 * not a conflict.
 */
export async function readSessionLinks(
  tx: Transaction,
  firestore: Firestore,
  req: SessionLinkRequest,
): Promise<SessionLinkPlan> {
  const claim = Array.from(new Set(req.claim));
  const claimSet = new Set(claim);
  const release = Array.from(new Set(req.release)).filter((id) => !claimSet.has(id));
  const touched = [...claim, ...release];
  const snaps = await Promise.all(
    touched.map((id) => tx.get(firestore.collection('kin_care_sessions').doc(id))),
  );

  const missing: string[] = [];
  const cancelled: Array<{ sessionId: string; data: Record<string, unknown> }> = [];
  const elsewhere: Array<{ sessionId: string; invoiceId: string; data: Record<string, unknown> | undefined }> = [];
  const releasable: string[] = [];

  snaps.forEach((snap, i) => {
    const sid = touched[i];
    const isClaim = claimSet.has(sid);
    if (!snap.exists) {
      // A release of a visit that is gone has nothing to clear; only a claim
      // on one is a caller bug.
      if (isClaim) missing.push(sid);
      return;
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    req.checkScope?.(sid, data);
    const owner = isSessionClaimed(data['invoiceId']) ? String(data['invoiceId']).trim() : '';
    if (isClaim) {
      if (isSessionCancelled(data['status'])) cancelled.push({ sessionId: sid, data });
      if (owner !== '' && owner !== req.invoiceId) elsewhere.push({ sessionId: sid, invoiceId: owner, data });
      return;
    }
    if (owner === '' || owner === req.invoiceId) releasable.push(sid);
  });

  if (missing.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      missing.length === 1
        ? 'One of the visits picked has no record, so it cannot be billed. Reload and pick again.'
        : `${missing.length} of the visits picked have no record, so they cannot be billed. Reload and pick again.`,
      { code: 'session_not_found', missing },
    );
  }
  if (cancelled.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `A cancelled visit cannot be billed: ${cancelled.map((c) => visitWords(c.data)).join(', ')}. Untick it, or restore the visit first.`,
      { code: 'session_cancelled', sessionIds: cancelled.map((c) => c.sessionId) },
    );
  }
  if (elsewhere.length > 0) {
    // Still before any write. The other invoice is read only to name it by its
    // number in the message the clients show verbatim; a missing or
    // number-less invoice falls back to its id.
    const otherIds = Array.from(new Set(elsewhere.map((e) => e.invoiceId)));
    const otherSnaps = await Promise.all(otherIds.map((id) => tx.get(firestore.collection('invoices').doc(id))));
    const numberOf = new Map<string, string>();
    otherSnaps.forEach((snap, i) => {
      const n = snap.exists ? (snap.data() as { invoiceNumber?: unknown } | undefined)?.invoiceNumber : undefined;
      numberOf.set(otherIds[i], typeof n === 'string' && n.trim() !== '' ? n.trim() : otherIds[i]);
    });
    const conflicts = elsewhere.map((e) => ({
      sessionId: e.sessionId,
      invoiceId: e.invoiceId,
      invoiceNumber: numberOf.get(e.invoiceId) ?? e.invoiceId,
    }));
    const named = elsewhere
      .map((e) => `${visitWords(e.data)} is on invoice ${numberOf.get(e.invoiceId) ?? e.invoiceId}`)
      .join('; ');
    throw new HttpsError(
      'failed-precondition',
      `Already billed on another invoice: ${named}. Unlink it there first.`,
      { code: 'session_on_other_invoice', conflicts },
    );
  }

  return { invoiceId: req.invoiceId, claim, release: releasable };
}

/**
 * The WRITE half: stages the back-link on every claimed visit and clears it on
 * every released one, in the caller's transaction. The stamps are the ones
 * `linkInvoiceSessions` has always written (Android decodes `_attributionAt`
 * as a String, so it stays ISO text, never a Timestamp), and a release writes
 * `''`, not a delete, because the un-invoiced list treats absent and empty as
 * one state.
 */
export function stageSessionLinks(
  tx: Transaction,
  firestore: Firestore,
  plan: SessionLinkPlan,
  nowIso: string,
): void {
  for (const sid of plan.claim) {
    tx.set(
      firestore.collection('kin_care_sessions').doc(sid),
      { invoiceId: plan.invoiceId, _attribution: 'manual', _attributionAt: nowIso, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  for (const sid of plan.release) {
    tx.set(
      firestore.collection('kin_care_sessions').doc(sid),
      { invoiceId: '', _attribution: 'manual_unlink', _attributionAt: nowIso, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
}
