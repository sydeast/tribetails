import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import {
  DRAFT_SEND_LEASE_MS,
  draftMessageChannel,
  draftSendStanding,
  type DraftMessageChannel,
} from '../lib/generatedDraftType';
import { SMTP2GO_NO_VERDICT_MESSAGE } from '../lib/providerFailure';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { loadBusinessName } from '../lib/businessName';
import { getNotificationDef } from '../notifications/catalog';
import { householdNoticeEntryRoute, householdPushShelfLine, householdSmsText } from '../notifications/templateParsers';
import { HOUSEHOLD_TEXT_MESSAGE_FIELD } from '../notifications/senders/pushChannel';
import { PORTAL_URL } from '../notifications/visitDates';
import {
  Args as ExternalArgs,
  recordExternalSend,
  sendThroughProvider,
  type ParsedArgs as ExternalParsedArgs,
} from './sendExternalMessage';

/**
 * #2428: the one send of a Communicate > Personalize Email or Text draft to its
 * household.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * Until this existed every admin client approved one of these drafts with its
 * own write (`status: 'approved'` on `generated_drafts/{id}`) and then called
 * `sendExternalMessage`, which takes an address and some words and has never
 * heard of the draft. So nothing on the draft ever said it went out. Opened
 * again from KinTales it read as "needs approval", with Approve and send and
 * Delete draft, and approving it again emailed or texted the household a second
 * time. The server could not refuse, because it was never told there was a
 * draft.
 *
 * ── WHAT THIS DOES ───────────────────────────────────────────────────────────
 * Approving and sending are one call, and the draft is where the answer lives.
 *
 *   1. One transaction reads the draft and CLAIMS it: `status: 'approved'`, the
 *      approved words, who approved them and `sendClaimedAt`. The household and
 *      the type are checked in the same read, the way `sendHouseholdPush`
 *      checks a Push draft (#2295), and the address is the one on the
 *      household's own record, never one the caller hands in.
 *   2. The message goes to the provider (`sendThroughProvider`, the consent
 *      gate and the send `sendExternalMessage` uses).
 *   3. The draft is stamped `sentAt`, with the channel, the masked recipient
 *      and the provider's message id, and the claim is let go.
 *
 * ── ONCE PER DRAFT ───────────────────────────────────────────────────────────
 * Only a draft nobody has approved is sent (`draftSendStanding` in
 * `lib/generatedDraftType.ts`). A second call for a draft that went out answers
 * `already_sent` and sends nothing, the way `publishGeneratedDraft` answers
 * `alreadyPublished`. A second call while the first is still sending is refused
 * with `aborted` (`details.code: 'draft_send_in_flight'`).
 *
 * THE CLAIM IS LET GO ONLY WHEN IT IS KNOWN NOTHING WENT OUT (`nothingWentOut`):
 * a refusal before the provider was called (a hard bounce, an address that
 * cannot be normalized), the provider answering no, or a connection that was
 * never made. Then the draft goes back to the status it had and can be sent
 * again.
 *
 * A send that got no answer is different. A timeout or a dropped connection
 * after the request left says nothing about whether smtp2go or Twilio took the
 * message, and unlike a push, which the household's notice doc dedupes, nothing
 * downstream would catch a second email or text. So the claim is KEPT, the
 * draft is marked `sendUnconfirmedAt`, and this call and every later one for
 * that draft are refused with `failed-precondition`
 * (`details.code: 'draft_send_unconfirmed'`). A claim left behind by a call
 * that died is read the same way once its lease has passed. The operator
 * writes a new draft if the message has to go again.
 *
 * ── AN APPROVED DRAFT WITH NO STAMP ──────────────────────────────────────────
 * That is a draft an older client approved and sent itself. It answers
 * `already_sent` too. `firestore.rules` refuses a client's own approve write on
 * an Email or Text draft that is already approved, which is the write every
 * older client makes before it sends, so an installed client cannot send one
 * twice either.
 *
 * ── THE HOUSEHOLD SEND GATE ──────────────────────────────────────────────────
 * Unchanged. An operator-composed email or text to one household has never
 * passed `householdNotificationsLive` (`sendExternalMessage.ts` is listed as a
 * bypass in `householdSendGateGuard.test.ts`, and this sends through the same
 * function). A Push draft still goes through `sendHouseholdPush`, which reads
 * the gate.
 *
 * ── A TEXT IS SHORT AND LINKS TO THE WHOLE MESSAGE (#2408) ───────────────────
 * Operator ruling 2026-11-14: a household's text message stays short, with a
 * link to the full message in MyTribe. Email carries the whole message. So a
 * Text draft is texted as the household short line (`householdSmsText`, the cut
 * a notice and a blast use) followed by a link to this message's own entry on
 * the household's notifications list, and the entry holds the words whole.
 *
 *   - The entry is written AFTER the claim and BEFORE the text, by the call
 *     that holds the claim and by no other, so the link never opens nothing and
 *     a refused second tap writes nothing. Its id comes from the draft.
 *   - It goes to the household's own sign-in (`resolveKinfolkUid`, the
 *     membership-checked login a Push draft uses), never a login that only
 *     happens to be stored on the household.
 *   - Known that nothing went out: the entry is removed, then the claim is let
 *     go. A send that got no answer keeps it, because the text may have
 *     arrived and its link has to open.
 *   - A household with no MyTribe sign-in has no list to write to. It is sent
 *     the short text with a link to the notifications list, which opens the
 *     sign-in page: what a blast does for that household today. Whether such
 *     a household should be texted the whole message is an open operator
 *     question and is not decided here.
 *   - An entry that could not be written is logged and the text still goes,
 *     linking to the list, as a blast does.
 *
 * Only this file changed for that. `sendExternalMessage` (an inbox reply, and
 * "Send outside the tribe") still texts the words as typed: those go to
 * numbers that may belong to no household, with no list to link to.
 *
 * Owner-only (not on the Auntie list): Communicate sends are the owner's.
 *
 * ── WHERE IT IS DEPLOYED FROM ────────────────────────────────────────────────
 * `admin/sendExternalMessage.ts` exports the `sendGeneratedDraft` function and
 * loads this file with `await import()` inside the call, so no cold start pays
 * for it (`coldStartImportGraph.test.ts`).
 */

/** How long a claim reads as "being sent right now". Kept in `lib/generatedDraftType.ts` with the rule that reads it. */
export { DRAFT_SEND_LEASE_MS };

// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z.object({
  /** The `generated_drafts` doc. Bare id. */
  draftId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  /** The household the operator confirmed. Refused unless the draft was written for it. */
  kinfolkId: z.string().min(1).max(200),
  /** The operator's final words, edits included. They become the draft's approved copy. */
  body: z.string().min(1).max(5000),
  /** The Email's subject. Not read for a Text. */
  subject: z.string().max(500).optional(),
});

export interface SendGeneratedDraftResult {
  ok: true;
  /**
   * sent: this call sent it.
   * already_sent: it went out before (stamped, or approved by an older client).
   * Nothing new was sent.
   */
  outcome: 'sent' | 'already_sent';
  channel: DraftMessageChannel;
  /** Masked address the message went to. Blank when an older client sent it. */
  recipientRedacted: string;
  /** When the provider took it. Blank when an older client sent it. */
  sentAt: string;
}

/** `details.code` on the refusals a client tells apart from any other. */
export const DRAFT_SEND_IN_FLIGHT = 'draft_send_in_flight';
export const DRAFT_SEND_UNCONFIRMED = 'draft_send_unconfirmed';

/** What the operator reads when a send got no answer. It claims neither a send nor a failure. */
export const DRAFT_SEND_UNCONFIRMED_MESSAGE =
  'The send did not get an answer, so it is not known whether this message reached the household. ' +
  'It is not sent again from this draft. Write a new one if it has to go again.';

/**
 * #2408: the settings row a Text draft's entry is filed under. The row a Push
 * draft uses (`sendHouseholdPush`): one message from the business to one
 * household.
 */
export const HOUSEHOLD_TEXT_NOTIFICATION_KEY = 'message.reply';
/** The entry id for a Text draft: stable, so one draft has one entry. */
export function householdTextNoticeId(draftId: string): string {
  return `personal-text-${draftId}`;
}
function unconfirmed(): HttpsError {
  return new HttpsError('failed-precondition', DRAFT_SEND_UNCONFIRMED_MESSAGE, { code: DRAFT_SEND_UNCONFIRMED });
}

/**
 * Transport codes that mean the connection to the provider was never made, so
 * no request reached it: DNS did not resolve, the connect was refused or timed
 * out. Every other transport code (a reset, a headers or body timeout, the
 * Twilio client's own timeout) can follow a request the provider accepted.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True when a throw from `sendThroughProvider` proves nothing went out.
 *
 *   not `unavailable`      refused before the provider was called (hard bounce,
 *                          opt-out, an address that cannot be normalized)
 *   an HTTP status         the provider answered, and the answer was no
 *   no transport code      the provider answered no in its body (smtp2go's
 *                          list of failures, its HTTP errors), or the call
 *                          was never dialled (a missing secret)
 *   never connected        see `NEVER_CONNECTED`
 *
 * What is left is not known, so not this:
 *
 *   a transport failure    after the request may have gone. `sendThroughProvider`
 *                          puts the provider's status and code on `details`
 *                          (`lib/providerFailure.ts`).
 *   a 2xx with no verdict  smtp2go took the request and answered 2xx, and the
 *                          answer could not be read or said neither yes nor
 *                          no. `lib/email.ts` throws that with no status and no
 *                          code, so it is told by its one fixed line
 *                          (`SMTP2GO_NO_VERDICT_MESSAGE`). A 2xx is what a send
 *                          that was taken looks like.
 */
export function nothingWentOut(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    message?: unknown;
    details?: { providerStatus?: unknown; providerCode?: unknown };
  } | null;
  if (e?.code !== 'unavailable') return true;
  if (e.message === SMTP2GO_NO_VERDICT_MESSAGE) return false;
  if (typeof e.details?.providerStatus === 'number') return true;
  const code = e.details?.providerCode;
  if (typeof code !== 'string') return true;
  return NEVER_CONNECTED.has(code);
}

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function householdName(kinfolk: Record<string, unknown>): string {
  return [trimmed(kinfolk['firstName']), trimmed(kinfolk['lastName'])].filter(Boolean).join(' ') || 'This household';
}

type Claim =
  | { already: true; channel: DraftMessageChannel; recipientRedacted: string; sentAt: string }
  | {
      already: false;
      channel: DraftMessageChannel;
      send: ExternalParsedArgs;
      claimedAt: string;
      /** The status to put back if the provider refuses. Undefined when the draft had none. */
      priorStatus: string | undefined;
    };

export async function sendGeneratedDraftHandler(req: CallableRequest<unknown>): Promise<SendGeneratedDraftResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'sendGeneratedDraft validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  const body = args.body.trim();
  if (body === '') throw new HttpsError('invalid-argument', 'The message is empty. Write something before approving.');
  const subject = (args.subject ?? '').trim();

  const draftRef = db().collection('generated_drafts').doc(args.draftId);
  const claim = await claimDraft(draftRef, uid, args.kinfolkId, body, subject);
  if (claim.already) {
    logEvent({
      severity: 'info',
      function: 'sendGeneratedDraft',
      event: 'draft.send.replayed',
      uid,
      extra: { draftId: args.draftId, channel: claim.channel },
    });
    return {
      ok: true,
      outcome: 'already_sent',
      channel: claim.channel,
      recipientRedacted: claim.recipientRedacted,
      sentAt: claim.sentAt,
    };
  }

  // #2408: a Text is the short line and a link to its entry on the household's
  // notifications list, which holds the words whole. An Email goes as written.
  let send = claim.send;
  let entry: HouseholdEntry = { ref: null, written: false };
  if (claim.channel === 'sms') {
    entry = await keepOnHouseholdList(uid, args.kinfolkId, args.draftId, claim.send.body);
    const route = householdNoticeEntryRoute(entry.written && entry.ref ? entry.ref.id : '');
    send = { ...claim.send, body: householdSmsText(claim.send.body, PORTAL_URL, route) };
  }
  let sent: Awaited<ReturnType<typeof sendThroughProvider>>;
  try {
    sent = await sendThroughProvider(send);
  } catch (err) {
    if (nothingWentOut(err)) {
      // No text arrived, so nothing links to the entry: it comes off their list.
      await removeFromHouseholdList(entry, uid);
      // The draft is unsent again and can be sent again.
      await releaseClaim(draftRef, claim.claimedAt, claim.priorStatus, uid);
      throw err;
    }
    // No answer. The provider may have the message, so the claim stays and
    // the draft says so. The provider's own words go to the log, not to an
    // operator who would read "failed" as "try again".
    await markUnconfirmed(draftRef, claim.claimedAt, uid);
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.send.unconfirmed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId: args.draftId, channel: claim.channel },
    });
    throw unconfirmed();
  }

  // The message is with the provider. Nothing below may fail the call: an error
  // here would tell the operator to try again a message that already went.
  const sentAt = new Date().toISOString();
  await stampSent(draftRef, uid, {
    sentAt,
    sentChannel: claim.channel,
    sentTo: sent.recipientRedacted,
    sentProviderMessageId: sent.providerMessageId,
  });
  try {
    await recordExternalSend(
      uid,
      send,
      sent,
      { mirrored: false, mirrorSkippedReason: 'not_requested' },
      {
        draftId: args.draftId,
        kinfolkId: args.kinfolkId,
        ...(entry.written && entry.ref ? { noticeId: entry.ref.id } : {}),
      },
    );
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'sendGeneratedDraft',
      event: 'draft.send.record.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId: args.draftId },
    });
  }
  logEvent({
    severity: 'info',
    function: 'sendGeneratedDraft',
    event: 'draft.sent',
    uid,
    extra: { draftId: args.draftId, channel: claim.channel, recipientRedacted: sent.recipientRedacted },
  });
  return { ok: true, outcome: 'sent', channel: claim.channel, recipientRedacted: sent.recipientRedacted, sentAt };
}

/** A Text draft's entry on the household's notifications list. */
interface HouseholdEntry {
  /** Where the entry is, once a write was tried. Null when there is no list to write to. */
  ref: FirebaseFirestore.DocumentReference | null;
  /** The write was acknowledged, so the text links to this entry. */
  written: boolean;
}
/**
 * #2408: puts a Text draft's whole message on the household's notifications
 * list, before the text is sent. Never throws: with no entry the text still
 * goes and links to the list, which is what a blast does.
 *
 * The row draws `householdLine` (the short line, as a notice's does) and, for a
 * message longer than that, the whole text under it with its line breaks
 * (`householdTextMessage`, which `listMyNotifications` returns as
 * `fullMessage`, #2371).
 *
 * A `set`, so an entry left by an earlier attempt whose removal failed is
 * written over with the words about to be texted. Only the call that holds the
 * draft's claim gets here.
 */
async function keepOnHouseholdList(
  uid: string,
  kinfolkId: string,
  draftId: string,
  body: string,
): Promise<HouseholdEntry> {
  let ref: FirebaseFirestore.DocumentReference | null = null;
  try {
    const recipientUid = await resolveKinfolkUid(kinfolkId);
    if (!recipientUid) {
      logEvent({
        severity: 'info',
        function: 'sendGeneratedDraft',
        event: 'draft.text.no_portal_account',
        uid,
        extra: { draftId, kinfolkId },
      });
      return { ref: null, written: false };
    }
    const def = getNotificationDef(HOUSEHOLD_TEXT_NOTIFICATION_KEY);
    const businessName = await loadBusinessName('sendGeneratedDraft');
    ref = db().collection('notifications').doc(householdTextNoticeId(draftId));
    await ref.set({
      key: def.key,
      category: def.category,
      recipientUid,
      actorUid: uid,
      data: { kinfolkId, draftId },
      title: businessName || 'A note for you',
      description: body,
      body,
      householdLine: householdPushShelfLine(body),
      [HOUSEHOLD_TEXT_MESSAGE_FIELD]: body,
      targetType: 'kinfolk',
      targetId: kinfolkId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ref, written: true };
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.text.entry.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId, kinfolkId },
    });
    // `ref` is kept when the write itself failed: a write that timed out may
    // have landed, and `removeFromHouseholdList` clears it if no text goes.
    return { ref, written: false };
  }
}
/**
 * No text went out, so the entry written for it is removed: left there, a
 * household that was sent nothing would hold the message, and the next send of
 * the same draft would be its second copy. Never throws.
 */
async function removeFromHouseholdList(entry: HouseholdEntry, uid: string): Promise<void> {
  if (entry.ref === null) return;
  try {
    await entry.ref.delete();
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.text.entry.remove.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { entryId: entry.ref.id },
    });
  }
}
/**
 * The check and the claim, in one transaction, so two calls for one draft
 * cannot both pass the check. Fails closed: a missing draft, a draft with no
 * household, one whose two household spellings disagree, and one that is not an
 * Email or a Text are all refused before anything is written.
 */
async function claimDraft(
  draftRef: FirebaseFirestore.DocumentReference,
  uid: string,
  kinfolkId: string,
  body: string,
  subject: string,
): Promise<Claim> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(draftRef);
    if (!snap.exists) throw new HttpsError('not-found', 'This draft is no longer here. It may have been deleted.');
    const draft = (snap.data() ?? {}) as Record<string, unknown>;

    const owners = new Set([trimmed(draft['kinfolk_id']), trimmed(draft['kinfolkId'])].filter((v) => v !== ''));
    if (owners.size !== 1 || !owners.has(kinfolkId)) {
      throw new HttpsError('permission-denied', 'This draft was written for a different household.');
    }
    const channel = draftMessageChannel(draft);
    if (channel === null) {
      throw new HttpsError('failed-precondition', 'This draft is not an Email or a Text.');
    }

    const state = draftSendStanding(draft, Date.now());
    if (state === 'in_flight') {
      throw new HttpsError('aborted', 'This message is being sent right now.', { code: DRAFT_SEND_IN_FLIGHT });
    }
    // A send that got no answer, or a claim left by a call that died.
    if (state === 'unconfirmed') throw unconfirmed();
    if (state !== 'unsent') {
      return {
        already: true as const,
        channel,
        recipientRedacted: trimmed(draft['sentTo']),
        sentAt: trimmed(draft['sentAt']),
      };
    }

    const kinfolkSnap = await tx.get(db().collection('kinfolk').doc(kinfolkId));
    if (!kinfolkSnap.exists) {
      throw new HttpsError('failed-precondition', 'The household this draft is addressed to no longer exists.');
    }
    const kinfolk = (kinfolkSnap.data() ?? {}) as Record<string, unknown>;
    const name = householdName(kinfolk);
    const to = channel === 'email' ? trimmed(kinfolk['email']) : trimmed(kinfolk['phoneNumber']);
    if (to === '') {
      throw new HttpsError(
        'failed-precondition',
        channel === 'email'
          ? `${name} has no email address on file. Add one in Directory before sending.`
          : `${name} has no phone number on file. Add one in Directory before sending.`,
      );
    }
    if (channel === 'email' && subject === '') {
      throw new HttpsError('invalid-argument', 'Email needs a subject.');
    }
    // The same shape check `sendExternalMessage` makes, before the claim, so a
    // bad address is refused with the draft untouched.
    const parsed = ExternalArgs.safeParse({
      channel,
      to,
      ...(channel === 'email' ? { subject } : {}),
      body,
      // One named household, written to by the operator: the marketing opt-out
      // does not apply, and an email carries no unsubscribe footer. A hard
      // bounce is still refused. Exactly what each client passed before #2428.
      transactional: true,
    });
    if (!parsed.success) {
      throw new HttpsError(
        'failed-precondition',
        channel === 'email'
          ? `The email address on file for ${name} is not one a message can be sent to. Correct it in Directory, then send.`
          : `The phone number on file for ${name} is not one a text can be sent to. Correct it in Directory, then send.`,
      );
    }

    const claimedAt = new Date().toISOString();
    tx.update(draftRef, {
      status: 'approved',
      generatedCopy: body,
      ...(channel === 'email' ? { subject } : {}),
      approvedAt: claimedAt,
      approvedBy: uid,
      sendClaimedAt: claimedAt,
    });
    return {
      already: false as const,
      channel,
      send: parsed.data,
      claimedAt,
      priorStatus: typeof draft['status'] === 'string' ? draft['status'] : undefined,
    };
  });
}

/**
 * The provider refused, so nothing went out: the draft goes back to the status
 * it had. Only this call's own claim is let go, and only on a draft that is
 * still there. If this fails the draft stays approved, which errs towards not
 * sending twice.
 */
async function releaseClaim(
  draftRef: FirebaseFirestore.DocumentReference,
  claimedAt: string,
  priorStatus: string | undefined,
  uid: string,
): Promise<void> {
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(draftRef);
      if (!snap.exists) return;
      const draft = (snap.data() ?? {}) as Record<string, unknown>;
      if (trimmed(draft['sendClaimedAt']) !== claimedAt || trimmed(draft['sentAt']) !== '') return;
      tx.update(draftRef, {
        status: priorStatus ?? FieldValue.delete(),
        approvedAt: FieldValue.delete(),
        approvedBy: FieldValue.delete(),
        sendClaimedAt: FieldValue.delete(),
        sendFailedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.send.release.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId: draftRef.id },
    });
  }
}

/**
 * The send got no answer. The claim stays, and `sendUnconfirmedAt` says why, so
 * a later call is told the same thing at once and not "being sent right now".
 * Only this call's own claim is marked. If this fails the claim is still
 * there, which is refused too once its lease has passed.
 */
async function markUnconfirmed(
  draftRef: FirebaseFirestore.DocumentReference,
  claimedAt: string,
  uid: string,
): Promise<void> {
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(draftRef);
      if (!snap.exists) return;
      const draft = (snap.data() ?? {}) as Record<string, unknown>;
      if (trimmed(draft['sendClaimedAt']) !== claimedAt || trimmed(draft['sentAt']) !== '') return;
      tx.update(draftRef, { sendUnconfirmedAt: new Date().toISOString() });
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.send.unconfirmed.mark.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId: draftRef.id },
    });
  }
}

/**
 * What says the draft went out. An `update` inside a transaction that first
 * checks the draft is still there, never a merge `set`, which would bring back
 * a draft deleted while its send was in flight. Never throws: the message is
 * already with the provider, and without the stamp the draft still reads as
 * approved, which is not sent again either.
 */
async function stampSent(
  draftRef: FirebaseFirestore.DocumentReference,
  uid: string,
  stamp: { sentAt: string; sentChannel: DraftMessageChannel; sentTo: string; sentProviderMessageId: string },
): Promise<void> {
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(draftRef);
      if (!snap.exists) return;
      tx.update(draftRef, { ...stamp, sendClaimedAt: FieldValue.delete(), sendFailedAt: FieldValue.delete() });
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'sendGeneratedDraft',
      event: 'draft.send.stamp.failed',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { draftId: draftRef.id },
    });
  }
}
