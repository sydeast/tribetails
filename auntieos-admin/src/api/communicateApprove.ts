import { doc } from 'firebase/firestore';
import { updateDoc } from '../lib/firestoreWrite';
import { db, auth } from '../lib/firebase';
import { call } from '../lib/fns';

/**
 * Approving an Auntie-voice draft: promote it, record it, then send it.
 *
 * ── THE ORDER IS THE CONTRACT ───────────────────────────────────────────────
 * 1. Firestore write on `generated_drafts/{draftId}`. This is a GATE. If it
 *    fails, nothing else runs: no audit entry, no send.
 * 2. Audit entry through the `logActivity` callable. Non-fatal. A failure here
 *    comes back as `auditWarning` rather than throwing, because the draft IS
 *    approved and pretending otherwise would be a lie in the other direction.
 * 3. `deliver()`, the downstream send, only for message types that deliver.
 *
 * Why this order and not any other: the draft doc is the record of what was
 * approved. Send first and a failed write leaves a message in somebody's inbox
 * with no approved draft behind it, so the audit trail says it never happened.
 * Audit first and a failed write leaves an audit entry asserting an approval
 * that does not exist. Write first is the only order where every surviving
 * artifact is true.
 *
 * The archive (`CommunicateScreen.kt#approveDraft`) got the first two right and
 * had no third: its `pingProfileUpdate` bridge existed but was never called
 * from anywhere, so the "downstream ping" its comments described was dead code.
 * Here the third step is the real delivery, which is what makes the ordering
 * rule matter rather than merely being stated.
 *
 * `updateDoc`, not `setDoc`: `generated_drafts` docs are written by
 * `web/functions/generate.js` with snake_case fields (`generated_copy`,
 * `kinfolk_id`, ...) and this patch adds camelCase ones. That mismatch is
 * inherited, not introduced; a merge-less overwrite here would destroy the
 * generate-time record of what the model originally produced, which is exactly
 * the thing an approval is an edit OF.
 */

export class ApproveDraftError extends Error {}
export class ApproveDeliveryError extends Error {}

const DRAFTS_COLLECTION = 'generated_drafts';

export interface ApproveDraftArgs {
  /** The `generated_drafts` doc id the generate returned. Null/blank means there is nothing to approve. */
  draftId: string;
  /** The operator's final text, edits included. */
  editedCopy: string;
  kinfolkId: string | null;
  /** Persisted alongside the copy for the types that carry one. */
  subject: string | null;
  /**
   * The downstream send. Runs ONLY after the Firestore write has succeeded.
   * Returns a provider message id, or null when the provider gave none.
   * Omitted for message types that do not deliver from this screen.
   */
  deliver?: () => Promise<string | null>;
}

export interface ApproveDraftResult {
  ok: true;
  /** The audit failure's own message when the entry could not be written, else null. */
  auditWarning: string | null;
  providerId: string | null;
  delivered: boolean;
}

export async function approveGeneratedDraft(args: ApproveDraftArgs): Promise<ApproveDraftResult> {
  const draftId = args.draftId.trim();
  if (draftId === '') {
    throw new ApproveDraftError('This draft was not saved, so there is nothing to approve. Regenerate and try again.');
  }

  // ── 1. the gate ──────────────────────────────────────────────────────────
  try {
    await updateDoc(doc(db, DRAFTS_COLLECTION, draftId), {
      status: 'approved',
      generatedCopy: args.editedCopy,
      approvedAt: new Date().toISOString(),
      approvedBy: auth.currentUser?.uid ?? '',
      ...(args.subject !== null && args.subject !== '' ? { subject: args.subject } : {}),
    });
  } catch (err) {
    throw new ApproveDraftError(
      `Approve failed, the draft was not promoted: ${err instanceof Error ? err.message : 'Firestore rejected the write'}`,
    );
  }

  // ── 2. the record ────────────────────────────────────────────────────────
  // Through the callable, never a direct `activity_log` write: writeAuditEntry
  // signs each entry into a SHA-256 hash chain, and a client-side write would
  // land outside it as an unchained row.
  let auditWarning: string | null = null;
  try {
    await call('logActivity', {
      actionType: 'DRAFT_APPROVED',
      description: `Approved ${DRAFTS_COLLECTION}/${draftId} (${args.kinfolkId ?? 'no kinfolk'})`,
      status: 'SUCCESS',
      targetId: draftId,
      targetCollection: DRAFTS_COLLECTION,
    });
  } catch (err) {
    auditWarning = err instanceof Error ? err.message : 'The audit entry could not be written.';
  }

  // ── 3. the send ──────────────────────────────────────────────────────────
  if (!args.deliver) {
    return { ok: true, auditWarning, providerId: null, delivered: false };
  }
  let providerId: string | null;
  try {
    providerId = await args.deliver();
  } catch (err) {
    throw new ApproveDeliveryError(
      `The draft is approved, but the send failed: ${err instanceof Error ? err.message : 'the provider refused it'}`,
    );
  }
  return { ok: true, auditWarning, providerId, delivered: true };
}
