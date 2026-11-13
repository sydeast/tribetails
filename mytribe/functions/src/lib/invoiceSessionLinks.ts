import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isSessionCancelled, isSessionClaimed } from './sessionInvoicing';
import { businessCalendarDate } from './bookingTimeBlocks';
import { FALLBACK_BUSINESS_TIME_ZONE } from './businessHours';

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

/**
 * How a visit is named in a refusal the clients show verbatim: its day, never its id.
 *
 * The day is the BUSINESS day (America/Chicago). A stored `startTime` that is an
 * instant (`...Z` or an offset) is read in that zone, so an evening visit is not
 * named by the next UTC day; a zone-less wall-clock value keeps its own date.
 */
export function visitWords(data: Record<string, unknown> | undefined): string {
  const start = typeof data?.['startTime'] === 'string' ? (data['startTime'] as string).trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(start)) return 'a visit with no date';
  const ms = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(start) ? Date.parse(start) : NaN;
  const day = Number.isFinite(ms) ? businessCalendarDate(ms, FALLBACK_BUSINESS_TIME_ZONE) : start.slice(0, 10);
  return `the visit on ${day}`;
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
    // number-less invoice is "another invoice" and its number is '', never
    // its id, which does not go on screen.
    const numberOf = await otherInvoiceNumbers(tx, firestore, elsewhere.map((e) => e.invoiceId));
    const conflicts = elsewhere.map((e) => ({
      sessionId: e.sessionId,
      invoiceId: e.invoiceId,
      invoiceNumber: numberOf.get(e.invoiceId) ?? '',
    }));
    const named = elsewhere
      .map((e) => `${visitWords(e.data)} is on ${invoiceWordsFor(numberOf.get(e.invoiceId) ?? '')}`)
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

// ── #2168: archiving a draft lets go of its visits; restoring takes them back ──
/**
 * The visits an invoice would bill: its stored `sessionIds`, the visits its
 * lines are bound to, and (for an archived draft) the ones archiving let go,
 * in that order, each once.
 */
export function visitsNamedBy(data: Record<string, unknown>): string[] {
  const released = Array.isArray(data['releasedSessionIds'])
    ? (data['releasedSessionIds'] as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];
  return Array.from(new Set([...storedSessionIds(data), ...boundSessionIds(data['lineItems']), ...released]));
}

/**
 * The READ half of archiving a draft. Archiving is how an unwanted draft is
 * abandoned (there is no delete), so the visits it holds go back on the
 * un-invoiced list. Only a visit whose back-link names THIS draft is let go: a
 * visit another invoice bills is that invoice's, and a blank one has nothing
 * to clear. Pass the plan to `stageSessionLinks`.
 */
export async function readSessionsHeldBy(
  tx: Transaction,
  firestore: Firestore,
  invoiceId: string,
  candidates: readonly string[],
): Promise<SessionLinkPlan> {
  const ids = Array.from(new Set(candidates));
  const snaps = await Promise.all(ids.map((id) => tx.get(firestore.collection('kin_care_sessions').doc(id))));

  const release: string[] = [];

  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    const owner = (snap.data() as Record<string, unknown> | undefined)?.['invoiceId'];
    if (isSessionClaimed(owner) && String(owner).trim() === invoiceId) release.push(ids[i]);
  });

  return { invoiceId, claim: [], release };
}

/** A visit a restored draft could not take back, and why. */
export interface ReclaimLoss {
  sessionId: string;
  /** `on_other_invoice`: billed since by another invoice. `cancelled`: the visit was cancelled. `not_found`: no record. */
  reason: 'on_other_invoice' | 'cancelled' | 'not_found';
  /** The other invoice's number ('' when it has none, never its id), or '' for the other reasons. */
  invoiceNumber: string;
}

export interface SessionReclaim {
  plan: SessionLinkPlan;
  lost: ReclaimLoss[];
  /** What the clients show after the restore, in plain words. '' when every visit came back. */
  notice: string;
}

/**
 * The READ half of restoring an archived draft. It takes back every visit it
 * names that is still free (or still names it), and NEVER takes one another
 * invoice has billed since: that would bill the same work twice. Each visit is
 * read inside `tx`, so a New invoice save racing the restore for one visit is
 * refereed by Firestore: whichever commits second re-runs and sees the other's
 * claim. Nothing is refused: the restore goes ahead, and `notice` names each
 * visit it could not take back, by its day, never its id.
 */
export async function readSessionReclaim(
  tx: Transaction,
  firestore: Firestore,
  invoiceId: string,
  candidates: readonly string[],
  lines: unknown,
): Promise<SessionReclaim> {
  const ids = Array.from(new Set(candidates));
  const snaps = await Promise.all(ids.map((id) => tx.get(firestore.collection('kin_care_sessions').doc(id))));
  const claim: string[] = [];
  const lost: Array<ReclaimLoss & { data: Record<string, unknown> | undefined }> = [];

  snaps.forEach((snap, i) => {
    const sid = ids[i];
    if (!snap.exists) {
      lost.push({ sessionId: sid, reason: 'not_found', invoiceNumber: '', data: undefined });
      return;
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const owner = isSessionClaimed(data['invoiceId']) ? String(data['invoiceId']).trim() : '';
    if (owner !== '' && owner !== invoiceId) {
      lost.push({ sessionId: sid, reason: 'on_other_invoice', invoiceNumber: owner, data });
      return;
    }
    // A visit that still names this draft is already its own; only a free one
    // is checked for having been cancelled since.
    if (owner === '' && isSessionCancelled(data['status'])) {
      lost.push({ sessionId: sid, reason: 'cancelled', invoiceNumber: '', data });
      return;
    }
    claim.push(sid);
  });

  // No number: '' rather than the id, which never goes on screen.
  const numberOf = await otherInvoiceNumbers(
    tx,
    firestore,
    lost.filter((l) => l.reason === 'on_other_invoice').map((l) => l.invoiceNumber),
  );
  for (const l of lost) if (l.reason === 'on_other_invoice') l.invoiceNumber = numberOf.get(l.invoiceNumber) ?? '';

  let notice = '';
  if (lost.length > 0) {
    const parts = lost.map((l) =>
      l.reason === 'on_other_invoice'
        ? `${visitWords(l.data)} is now on ${invoiceWordsFor(l.invoiceNumber)}`
        : l.reason === 'cancelled'
          ? `${visitWords(l.data)} was cancelled`
          : 'one visit no longer has a record',
    );
    const bound = new Set(boundSessionIds(lines));
    const onLines = lost.filter((l) => bound.has(l.sessionId)).length;
    const one = lost.length === 1;
    notice =
      `${one ? '1 visit' : `${lost.length} visits`} could not be taken back: ${parts.join('; ')}.` +
      (onLines === 0
        ? ''
        : onLines === 1
          ? one
            ? ' Its line is still on this draft, so remove it in Edit before sending the draft.'
            : ' The line for one of them is still on this draft, so remove it in Edit before sending the draft.'
          : ' Their lines are still on this draft, so remove them in Edit before sending the draft.');
  }

  return {
    plan: { invoiceId, claim, release: [] },
    lost: lost.map(({ sessionId, reason, invoiceNumber }) => ({ sessionId, reason, invoiceNumber })),
    notice,
  };
}

/**
 * The numbers of the invoices that bill some visit now, read inside `tx`.
 * Keyed by invoice id; '' for an invoice that has no number or no record,
 * never the id, which does not go on screen.
 */
async function otherInvoiceNumbers(
  tx: Transaction,
  firestore: Firestore,
  invoiceIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(invoiceIds));
  const snaps = await Promise.all(ids.map((id) => tx.get(firestore.collection('invoices').doc(id))));
  const numberOf = new Map<string, string>();
  snaps.forEach((snap, i) => {
    const n = snap.exists ? (snap.data() as { invoiceNumber?: unknown } | undefined)?.invoiceNumber : undefined;
    numberOf.set(ids[i], typeof n === 'string' && n.trim() !== '' ? n.trim() : '');
  });
  return numberOf;
}

/** "invoice 1042", or "another invoice" when it has no number. */
function invoiceWordsFor(invoiceNumber: string): string {
  return invoiceNumber === '' ? 'another invoice' : `invoice ${invoiceNumber}`;
}

// ── #2168 review: a draft is sent only when every visit its lines bill is its own ──

/** `details.code` when a draft's lines bill a visit it cannot bill. */
export const DRAFT_VISITS_NOT_BILLABLE_CODE = 'draft_visits_not_billable';

/** A visit a draft's line bills that the draft cannot send, and why. Same reasons as a restore's. */
export type UnbillableVisit = ReclaimLoss;

/**
 * The READ half of sending a draft (`reviewAndSendDraftInvoice`). Every visit a
 * line of the draft bills must be the draft's own when it goes out:
 *
 *   - one another invoice now bills (`on_other_invoice`): a restore leaves a
 *     visit billed while the draft was archived where it is, but its line stays
 *     on the draft, and sending would bill that work twice;
 *   - one that was cancelled (`cancelled`): work that did not happen;
 *   - one with no record (`not_found`).
 *
 * Any of those refuses the send (`failed-precondition`,
 * `draft_visits_not_billable`) before anything is written, naming each visit by
 * its day and the other invoice by its number. A line's visit whose back-link
 * is blank (a draft made before #1901) is claimed for the draft, which is the
 * link its line already implies; one that names the draft needs nothing. A
 * visit linked with no line is attribution and is not judged here. Pass the
 * plan to `stageSessionLinks`.
 */
export async function readSendClaims(
  tx: Transaction,
  firestore: Firestore,
  invoiceId: string,
  lines: unknown,
): Promise<SessionLinkPlan> {
  const ids = boundSessionIds(lines);
  const snaps = await Promise.all(ids.map((id) => tx.get(firestore.collection('kin_care_sessions').doc(id))));
  const claim: string[] = [];
  const lost: Array<UnbillableVisit & { data: Record<string, unknown> | undefined }> = [];

  snaps.forEach((snap, i) => {
    const sid = ids[i];
    if (!snap.exists) {
      lost.push({ sessionId: sid, reason: 'not_found', invoiceNumber: '', data: undefined });
      return;
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const owner = isSessionClaimed(data['invoiceId']) ? String(data['invoiceId']).trim() : '';
    if (owner !== '' && owner !== invoiceId) {
      lost.push({ sessionId: sid, reason: 'on_other_invoice', invoiceNumber: owner, data });
      return;
    }
    if (isSessionCancelled(data['status'])) {
      lost.push({ sessionId: sid, reason: 'cancelled', invoiceNumber: '', data });
      return;
    }
    if (owner === '') claim.push(sid);
  });

  if (lost.length > 0) {
    const numberOf = await otherInvoiceNumbers(
      tx,
      firestore,
      lost.filter((l) => l.reason === 'on_other_invoice').map((l) => l.invoiceNumber),
    );
    for (const l of lost) if (l.reason === 'on_other_invoice') l.invoiceNumber = numberOf.get(l.invoiceNumber) ?? '';
    const parts = lost
      .filter((l) => l.reason !== 'not_found')
      .map((l) =>
        l.reason === 'on_other_invoice'
          ? `${visitWords(l.data)} is billed on ${invoiceWordsFor(l.invoiceNumber)}`
          : `${visitWords(l.data)} was cancelled`,
      );
    const gone = lost.filter((l) => l.reason === 'not_found').length;
    if (gone === 1) parts.push('one visit no longer has a record');
    if (gone > 1) parts.push(`${gone} visits no longer have a record`);
    throw new HttpsError(
      'failed-precondition',
      `This draft cannot be sent: ${parts.join('; ')}. ` +
        `Remove ${lost.length === 1 ? 'its line' : 'those lines'} in Edit, then send the draft.`,
      {
        code: DRAFT_VISITS_NOT_BILLABLE_CODE,
        visits: lost.map(({ sessionId, reason, invoiceNumber }) => ({ sessionId, reason, invoiceNumber })),
      },
    );
  }

  return { invoiceId, claim, release: [] };
}
