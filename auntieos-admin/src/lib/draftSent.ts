import { str } from './coerce';
import { tsToDate } from './time';
import type { GeneratedDraftRow } from '../api/drafts';
import type { HouseholdPushReason, HouseholdPushResult } from '../api/householdPush';

/**
 * #2428: a Communicate draft that already went out, read off the stored doc.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Communicate opened every stored draft as "needs approval", with Approve and
 * send and Delete draft, unless it was a sent KinTale or a held Push. A Push
 * the household had already been sent, and an Email or Text that had already
 * gone, opened the same way as a draft nobody had touched. Approving the Email
 * or Text again sent it again.
 *
 * ── WHAT COUNTS AS GONE ─────────────────────────────────────────────────────
 * Each rule is a match on something the draft carries, never "approved and not
 * one of the others". The server keeps the same rules in
 * `mytribe/functions/src/lib/generatedDraftType.ts#draftWentOut`, and refuses a
 * second send and a delete by them.
 *
 *   Push            approved, and the server's own answer is `sent` or `listed`
 *                   (`pushOutcome`, stamped by `sendHouseholdPush`). A held
 *                   Push reached nobody and is not this.
 *   Email or Text   stamped `sentAt` by `sendGeneratedDraft`, or approved.
 *                   Approving one is what sends it, on every client there has
 *                   ever been, so an approved one with no stamp went out the
 *                   old way, before the stamp existed.
 *
 * A KinTale sent as a report is `isPublishedDraft` in `lib/kinTaleList.ts`, and
 * the screen already handled it.
 */

/** A type either spelling carries (`communication_type` from the generator, `communicationType` on migrated docs). */
function carriesType(draft: GeneratedDraftRow, wanted: readonly string[]): boolean {
  return [draft.communication_type, draft.communicationType].some((v) => wanted.includes(str(v).trim().toLowerCase()));
}

function isApproved(draft: GeneratedDraftRow): boolean {
  return str(draft.status).trim().toLowerCase() === 'approved';
}

/** The channel a sent Email or Text draft went out on, or null when the draft is not one, or has not gone. */
export function sentMessageChannel(draft: GeneratedDraftRow): 'email' | 'sms' | null {
  if (!carriesType(draft, ['email', 'sms'])) return null;
  if (str(draft.sentAt).trim() === '' && !isApproved(draft)) return null;
  return carriesType(draft, ['email']) ? 'email' : 'sms';
}

/** A Push the household was sent: on their notifications list, and on their phone when the answer is `sent`. */
export function isSentPushDraft(draft: GeneratedDraftRow): boolean {
  const outcome = str(draft.pushOutcome).trim();
  return carriesType(draft, ['push']) && isApproved(draft) && (outcome === 'sent' || outcome === 'listed');
}

/** True when the draft already went to its household by push, email or text. */
export function draftWentOut(draft: GeneratedDraftRow): boolean {
  return isSentPushDraft(draft) || sentMessageChannel(draft) !== null;
}

/** "Nov 20, 2026", or blank when the stamp is missing or unreadable. */
function dayOf(iso: string): string {
  const d = tsToDate(iso);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

export interface SentDraftNotice {
  title: string;
  body: string;
}

/** What Communicate shows in place of Approve when it opens a draft that already went out. */
export interface SentDraftOnOpen {
  /** A sent Push: the server's stored answer, worded by `householdPushResultText`. */
  push: HouseholdPushResult | null;
  /** A sent Email or Text. Null for a Push, which has its own sentence. */
  notice: SentDraftNotice | null;
}

/**
 * The opened draft's sent state, or null for a draft that has not gone out.
 * `household` is the name the screen already shows for the draft.
 */
export function sentDraftOnOpen(draft: GeneratedDraftRow, household: string): SentDraftOnOpen | null {
  if (isSentPushDraft(draft)) {
    const outcome = str(draft.pushOutcome).trim() === 'sent' ? 'sent' : 'listed';
    const reason = (str(draft.pushReason).trim() || null) as HouseholdPushReason | null;
    return { push: { outcome, reason }, notice: null };
  }
  const channel = sentMessageChannel(draft);
  if (channel === null) return null;
  const who = household.trim() !== '' ? household.trim() : 'the household';
  const how = channel === 'email' ? 'email' : 'text';
  const sentOn = dayOf(str(draft.sentAt));
  if (str(draft.sentAt).trim() !== '') {
    return {
      push: null,
      notice: {
        title: 'Already sent',
        body: `Sent to ${who} by ${how}${sentOn !== '' ? ` on ${sentOn}` : ''}. It is not sent again.`,
      },
    };
  }
  // Approved with no stamp: an older version of the app approved and sent it.
  const approvedOn = dayOf(str(draft.approvedAt));
  return {
    push: null,
    notice: {
      title: 'Already approved',
      body: `This ${how} for ${who} was approved${approvedOn !== '' ? ` on ${approvedOn}` : ''}. Approving sends it, so it is not sent again.`,
    },
  };
}

/** What the screen says when the server answers that a draft had already gone. */
export function alreadySentText(household: string): SentDraftNotice {
  const who = household.trim() !== '' ? household.trim() : 'the household';
  return { title: 'Already sent', body: `This message already went to ${who}. Nothing new was sent.` };
}
