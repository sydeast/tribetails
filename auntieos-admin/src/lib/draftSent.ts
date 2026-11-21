import { str } from './coerce';
import { tsToDate } from './time';
import { resolveBusinessTimeZone } from './businessOperations';
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
 *
 * ── SENT, OR ONLY CLAIMED (#2452) ───────────────────────────────────────────
 * "Approved" covered one more case that is not a send. `sendGeneratedDraft`
 * approves the draft as it claims it, and when the provider never answers it
 * keeps the claim (`sendClaimedAt`) and marks the draft `sendUnconfirmedAt`.
 * That draft opened as "Already approved ... it is not sent again", which reads
 * as sent. `messageDraftStanding` reads the stamps the way the server does
 * (`draftSendStanding` in `generatedDraftType.ts`), and every reader below asks
 * it before it says anything about a send.
 *
 * ── THE DATE (#2440) ────────────────────────────────────────────────────────
 * The day in a notice is the business's day (`business_settings.timeZone`,
 * America/Chicago by default), never the browser's. The desktop console
 * already read it that way, so one draft showed two dates.
 */

/** A type either spelling carries (`communication_type` from the generator, `communicationType` on migrated docs). */
function carriesType(draft: GeneratedDraftRow, wanted: readonly string[]): boolean {
  return [draft.communication_type, draft.communicationType].some((v) => wanted.includes(str(v).trim().toLowerCase()));
}

function isApproved(draft: GeneratedDraftRow): boolean {
  return str(draft.status).trim().toLowerCase() === 'approved';
}

/** How long the server's claim reads as "being sent right now" (`DRAFT_SEND_LEASE_MS` on the server). */
export const DRAFT_SEND_LEASE_MS = 120_000;

/**
 * Where an Email or Text draft stands, or null for any other type and for one
 * nobody has approved.
 *
 *   sent         stamped `sentAt`: the provider took it.
 *   sending      claimed under two minutes ago: the send is running.
 *   unconfirmed  the send got no answer (`sendUnconfirmedAt`), or its claim
 *                was left by a call that died. It may have reached the
 *                household. It is not sent again from this draft.
 *   approved     approved with no stamp and no claim: an older version of the
 *                app approved it and sent it.
 */
export type MessageDraftStanding = 'sent' | 'sending' | 'unconfirmed' | 'approved';

export function messageDraftStanding(draft: GeneratedDraftRow, nowMs: number): MessageDraftStanding | null {
  if (!carriesType(draft, ['email', 'sms'])) return null;
  if (str(draft.sentAt).trim() !== '') return 'sent';
  if (!isApproved(draft)) return null;
  const claimed = str(draft.sendClaimedAt).trim();
  if (claimed === '') return 'approved';
  if (str(draft.sendUnconfirmedAt).trim() !== '') return 'unconfirmed';
  const claimedMs = Date.parse(claimed);
  return !Number.isNaN(claimedMs) && nowMs - claimedMs < DRAFT_SEND_LEASE_MS ? 'sending' : 'unconfirmed';
}

/**
 * The channel of an Email or Text draft that is past approving (sent, being
 * sent, unconfirmed, or sent the old way), or null. None of these is sent
 * again or deleted. Whether it is known to have gone is `messageDraftStanding`.
 */
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

/** True when the draft is kept as the record of a push, email or text the household was sent, or may have been. */
export function draftWentOut(draft: GeneratedDraftRow): boolean {
  return isSentPushDraft(draft) || sentMessageChannel(draft) !== null;
}

/**
 * #2440: where the KinTales list files a Communicate draft that is past
 * approving, or null for every other draft (the list's own rules place those).
 *
 *   sent         a Push the household was sent, an Email or Text stamped sent,
 *                and one an older version of the app approved and sent
 *   unconfirmed  an Email or Text whose send got no answer
 *   sending      an Email or Text being sent right now
 */
export type DraftListPlace = 'sent' | 'unconfirmed' | 'sending';

export function draftListPlace(draft: GeneratedDraftRow, nowMs: number): DraftListPlace | null {
  if (isSentPushDraft(draft)) return 'sent';
  const standing = messageDraftStanding(draft, nowMs);
  if (standing === null) return null;
  return standing === 'approved' ? 'sent' : standing;
}

/** "Nov 20, 2026" on the business's calendar, or blank when the stamp is missing or unreadable. */
export function sentDayOf(iso: string, businessZone: string): string {
  const d = tsToDate(iso);
  return d
    ? d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: resolveBusinessTimeZone(businessZone),
      })
    : '';
}

export interface SentDraftNotice {
  title: string;
  body: string;
  /** `warning` when the notice does not vouch for a send. */
  tone: 'success' | 'warning';
}

/** What Communicate shows in place of Approve when it opens a draft that already went out. */
export interface SentDraftOnOpen {
  /** A sent Push: the server's stored answer, worded by `householdPushResultText`. */
  push: HouseholdPushResult | null;
  /** A sent Email or Text. Null for a Push, which has its own sentence. */
  notice: SentDraftNotice | null;
}

function whoOf(household: string): string {
  return household.trim() !== '' ? household.trim() : 'the household';
}

/**
 * #2452: the notice for an Email or Text whose send got no answer. The same
 * words whether the draft was opened that way or the server just said so.
 * `day` is blank when there is no stamp to read.
 */
export function unconfirmedSendText(household: string, channel: 'email' | 'sms' | null, day = ''): SentDraftNotice {
  const how = channel === 'email' ? 'email' : channel === 'sms' ? 'text' : 'message';
  return {
    title: 'Send not confirmed',
    body:
      `The send of this ${how} to ${whoOf(household)}${day !== '' ? ` on ${day}` : ''} did not get an answer, ` +
      'so it is not known whether it reached them. It is not sent again from this draft. ' +
      'Write a new one if it has to go again.',
    tone: 'warning',
  };
}

/**
 * The opened draft's sent state, or null for a draft that has not gone out.
 * `household` is the name the screen already shows for the draft, and
 * `businessZone` the clock its date is read on.
 */
export function sentDraftOnOpen(
  draft: GeneratedDraftRow,
  household: string,
  businessZone: string,
  nowMs: number = Date.now(),
): SentDraftOnOpen | null {
  if (isSentPushDraft(draft)) {
    const outcome = str(draft.pushOutcome).trim() === 'sent' ? 'sent' : 'listed';
    const reason = (str(draft.pushReason).trim() || null) as HouseholdPushReason | null;
    return { push: { outcome, reason }, notice: null };
  }
  const channel = sentMessageChannel(draft);
  const standing = messageDraftStanding(draft, nowMs);
  if (channel === null || standing === null) return null;
  const who = whoOf(household);
  const how = channel === 'email' ? 'email' : 'text';
  if (standing === 'sent') {
    const sentOn = sentDayOf(str(draft.sentAt), businessZone);
    return {
      push: null,
      notice: {
        title: 'Already sent',
        body: `Sent to ${who} by ${how}${sentOn !== '' ? ` on ${sentOn}` : ''}. It is not sent again.`,
        tone: 'success',
      },
    };
  }
  if (standing === 'unconfirmed') {
    const stamp = str(draft.sendUnconfirmedAt).trim() !== '' ? str(draft.sendUnconfirmedAt) : str(draft.sendClaimedAt);
    return { push: null, notice: unconfirmedSendText(household, channel, sentDayOf(stamp, businessZone)) };
  }
  if (standing === 'sending') {
    return {
      push: null,
      notice: {
        title: 'Being sent',
        body: `This ${how} for ${who} is being sent right now. Open it again in a few minutes to see what happened.`,
        tone: 'warning',
      },
    };
  }
  // Approved with no stamp and no claim: an older version of the app approved and sent it.
  const approvedOn = sentDayOf(str(draft.approvedAt), businessZone);
  return {
    push: null,
    notice: {
      title: 'Already approved',
      body: `This ${how} for ${who} was approved${approvedOn !== '' ? ` on ${approvedOn}` : ''}. Approving sends it, so it is not sent again.`,
      tone: 'success',
    },
  };
}

/** What the screen says when the server answers that a draft had already gone. */
export function alreadySentText(household: string): SentDraftNotice {
  return {
    title: 'Already sent',
    body: `This message already went to ${whoOf(household)}. Nothing new was sent.`,
    tone: 'success',
  };
}

/** #2452: true when `sendGeneratedDraft` refused because the send got no answer (`details.code`). */
export function sendRefusedUnconfirmed(err: unknown): boolean {
  const details = (err as { details?: unknown } | null)?.details;
  return (details as { code?: unknown } | null | undefined)?.code === 'draft_send_unconfirmed';
}
