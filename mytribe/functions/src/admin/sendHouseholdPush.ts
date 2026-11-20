import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db, getAdmin } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { loadBusinessName } from '../lib/businessName';
import { sanitizePlainText } from '../lib/richText';
import { isPushDraft } from '../lib/generatedDraftType';
import { getNotificationDef } from '../notifications/catalog';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  HOUSEHOLD_SHORT_LINE_MAX,
  householdPushShelfLine,
} from '../notifications/templateParsers';
import { loadHouseholdSendGate } from '../notifications/householdSendGate';
import { loadBusinessOverride, loadUserPrefs, notificationDisabledFor, resolveChannels } from '../notifications/prefs';

/**
 * #2061: the one push an approved Communicate > Personalize "Push" draft sends
 * to its household.
 *
 * Before this the Push type had no send behind it. Approving one stamped the
 * draft approved and said "Nothing was sent, this message type delivers
 * elsewhere", and nothing anywhere delivered it.
 *
 * ── WHAT HOLDS IT BACK, IN THIS ORDER ────────────────────────────────────────
 * The same checks and the same order as `previewVisitNotification`:
 *
 *   1. Nobody in the household has signed in to the portal: there is no
 *      account to push to (`resolveKinfolkUid`, the membership-checked login).
 *   2. The household send gate (`householdNotificationsLive`) is shut. Nothing
 *      is written and nothing is sent, exactly as the dispatcher holds a
 *      household copy. Fails closed on a read error, as the gate does.
 *   3. The operator turned household message notices off (Settings,
 *      Notifications). Nothing is written.
 *
 * Past those, the notice is written to the household's notifications list, and
 * the push goes to their devices only when their own settings allow push for
 * messages from the business and a device is registered. A push the household
 * turned off still leaves the notice on their list, which is what the
 * dispatcher does for a household with every channel off (#1505).
 *
 * ── WHICH SETTINGS ROW ───────────────────────────────────────────────────────
 * `message.reply` ("New message from {business}", "When {business} writes to
 * you in Messages"). A one-to-one note from the business is that row's subject;
 * `broadcast.message` is the row for one message to many households. No new
 * catalog row, so no new template and no import.
 *
 * ── ONCE PER DRAFT ───────────────────────────────────────────────────────────
 * The notice's id is derived from the draft, and it is CREATED, so a retry
 * never puts a second notice on their list. The notice records whether the
 * push went out (`pushOutcome`): a retry after a push that went out sends
 * nothing and says so; a retry after one that did not (push off, no device, a
 * refused send) tries the push again. A held send writes nothing for the
 * household, so trying again after the operator switches household notices on
 * goes through.
 *
 * ── THE DRAFT IS CHECKED FIRST (#2295) ───────────────────────────────────────
 * Before anything else the `generated_drafts` doc is read and the send is
 * refused unless it is an approved Push draft written for this same household.
 * Every client approves (status `approved`) before it calls this.
 *
 * ── THE DRAFT REMEMBERS THE ANSWER (#2293) ───────────────────────────────────
 * Every attempt that answers stamps `pushOutcome`, `pushReason` and
 * `pushAttemptedAt` on the draft, held sends included. An approved Push draft
 * with no `pushOutcome` is one whose send never answered (#2381); the clients
 * keep it under Drafts with its Try again. That is how a held push is listed again under
 * Drafts and opens with its Try again after the screen was closed.
 *
 * ── ONE PUSH, THE APPROVED WORDS, NO RESURRECTION (#2389) ────────────────────
 * The draft check and a claim on the draft (`pushClaimedAt`) are one
 * transaction, so two taps at once push once: the second finds the claim and
 * is refused. The words pushed are the draft's stored copy (what approve
 * wrote), and a body that differs is refused, so an edit after approval is
 * never what goes out. Every write to the draft after the send is an update
 * of a draft that is still there, so a draft deleted mid-send stays deleted.
 *
 * Owner-only (not on the Auntie list): Communicate sends are the owner's.
 *
 * ── WHERE IT IS DEPLOYED FROM ────────────────────────────────────────────────
 * The `sendHouseholdPush` function is exported by `admin/conversations.ts`,
 * the module for the office writing to one household, and loads this file
 * with `await import()` inside the call. A FUNCTIONS entry of its own would add
 * a module every cold start pays for (`coldStartImportGraph.test.ts`).
 */

export const HOUSEHOLD_PUSH_NOTIFICATION_KEY = 'message.reply';

/** The longest push line the composer may send. A notification shelf shows far less. */
export const HOUSEHOLD_PUSH_BODY_MAX = 1000;
export const HOUSEHOLD_PUSH_TITLE_MAX = 120;
/**
 * The longest line the push itself carries, where a tap on it lands in MyTribe,
 * and the cut. A push stays short and opens MyTribe, where the notifications
 * list holds the whole message (operator ruling 2026-11-14). Since #2280 every
 * household push follows the same rule, so the three live with the channel
 * senders (`notifications/templateParsers.ts`) and are named here as before.
 */
export const HOUSEHOLD_PUSH_SHELF_MAX = HOUSEHOLD_SHORT_LINE_MAX;
export const HOUSEHOLD_PUSH_ROUTE = HOUSEHOLD_NOTICE_ROUTE;
export { householdPushShelfLine };
// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200),
  /** The approved `generated_drafts` doc. Names the notice, so one draft pushes once. */
  draftId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  body: z.string().min(1).max(HOUSEHOLD_PUSH_BODY_MAX),
  /** Optional. Blank uses the business name, the way a broadcast push does. */
  title: z.string().max(HOUSEHOLD_PUSH_TITLE_MAX).optional(),
});

/**
 * Why nothing, or less than a push, reached the household. Each is an ordinary
 * state the clients turn into a sentence; none is an error.
 *
 *   household_has_no_portal_account  no signed-in member to send to (nothing written)
 *   household_notices_off            the send gate is shut (nothing written)
 *   notice_turned_off                the operator turned this notice off (nothing written)
 *   household_push_off               on their list; their settings keep push off
 *   no_device                        on their list; no phone or browser is signed in for push
 *   push_failed                      on their list; every device refused the push
 */
export const HOUSEHOLD_PUSH_REASONS = [
  'household_has_no_portal_account',
  'household_notices_off',
  'notice_turned_off',
  'household_push_off',
  'no_device',
  'push_failed',
] as const;
export type HouseholdPushReason = (typeof HOUSEHOLD_PUSH_REASONS)[number];

export interface SendHouseholdPushResult {
  ok: true;
  /**
   * sent: on their list and pushed to at least one device.
   * listed: on their list, no push (see `reason`).
   * held: nothing written, nothing sent (see `reason`).
   * already_sent: this draft's push went out before; nothing new happened.
   */
  outcome: 'sent' | 'listed' | 'held' | 'already_sent';
  reason: HouseholdPushReason | null;
}

/** The notice id for a draft: stable, so a second attempt finds the first. */
export function householdPushNoticeId(draftId: string): string {
  return `personal-push-${draftId}`;
}

function held(reason: HouseholdPushReason): SendHouseholdPushResult {
  return { ok: true, outcome: 'held', reason };
}

export async function sendHouseholdPushHandler(req: CallableRequest<unknown>): Promise<SendHouseholdPushResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'sendHouseholdPush validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  // Plain text on a lock screen: no markup survives into the notification.
  const body = sanitizePlainText(args.body);
  if (body === '') throw new HttpsError('invalid-argument', 'The push has no words in it.');

  // #2295: the draft is checked before anything is read or written for the
  // household, so a draft written for one household never sends to another.
  // #2389: the same transaction takes the draft's claim, so two taps (or two
  // screens) at once push once, and the words pushed are the ones stored at
  // approval, never a later edit.
  const claim = await claimPushDraft(args.kinfolkId, args.draftId, body, Date.now());
  if (claim.kind === 'already_sent') {
    logEvent({ severity: 'info', function: 'sendHouseholdPush', event: 'household.push.duplicate', uid, extra: { draftId: args.draftId } });
    return { ok: true, outcome: 'already_sent', reason: null };
  }
  let result: SendHouseholdPushResult;
  try {
    result = await deliverHouseholdPush(uid, args, claim.copy);
  } catch (err) {
    // Let go of the claim, so a retry is not refused by an attempt that is over.
    await writeDraftIfPresent(claim.ref, { pushClaimedAt: '' }, uid, 'household.push.claim_release.failed');
    throw err;
  }
  await stampDraft(claim.ref, result, uid);
  return result;
}
/**
 * #2389: how long a send's claim on its draft holds off a second send. Longer
 * than the callable's own limit (60 seconds, the default), so a claim outlives
 * the attempt that took it, and a crashed attempt frees its draft after this.
 */
export const PUSH_CLAIM_LEASE_MS = 120_000;
/**
 * The two #2389 refusals, named in `details.code` so every client can tell
 * them from any other refusal: the words are not the approved ones (the screen
 * goes back to unapproved), and another attempt holds the claim (wait).
 */
export const PUSH_WORDS_CHANGED_CODE = 'push_words_changed';
export const PUSH_IN_FLIGHT_CODE = 'push_in_flight';
/** The `generatedCopy` approve writes, else the `generated_copy` the generator wrote. */
function approvedCopyOf(d: Record<string, unknown>): string {
  const camel = typeof d['generatedCopy'] === 'string' ? d['generatedCopy'] : '';
  const snake = typeof d['generated_copy'] === 'string' ? d['generated_copy'] : '';
  return sanitizePlainText(camel.trim() !== '' ? camel : snake);
}
export type PushDraftClaim =
  | { kind: 'claimed'; ref: FirebaseFirestore.DocumentReference; copy: string }
  | { kind: 'already_sent' };
/**
 * #2389: the draft check (#2295) and the claim, in one transaction.
 *
 *   - A draft already stamped `sent` answers `already_sent` and claims nothing.
 *   - The words pushed are the draft's stored copy. A body that differs from
 *     it was edited after approval and is refused: approve again to send it.
 *   - A claim younger than [PUSH_CLAIM_LEASE_MS] means another attempt is
 *     sending this draft now; this one is refused and pushes nothing.
 */
export async function claimPushDraft(
  kinfolkId: string,
  draftId: string,
  typedBody: string,
  nowMs: number,
): Promise<PushDraftClaim> {
  const ref = db().collection('generated_drafts').doc(draftId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = checkApprovedPushDraft(snap, kinfolkId);
    if (d['pushOutcome'] === 'sent') return { kind: 'already_sent' } as const;
    const copy = approvedCopyOf(d);
    if (copy === '') {
      throw new HttpsError('failed-precondition', 'This draft has no words in it. Write the message, then approve it again.');
    }
    if (copy !== typedBody) {
      throw new HttpsError('failed-precondition', 'The words changed after this draft was approved. Approve it again to send them.', {
        code: PUSH_WORDS_CHANGED_CODE,
      });
    }
    const claimedAt = Date.parse(typeof d['pushClaimedAt'] === 'string' ? d['pushClaimedAt'] : '');
    if (Number.isFinite(claimedAt) && nowMs - claimedAt < PUSH_CLAIM_LEASE_MS) {
      throw new HttpsError('aborted', 'This push is being sent right now. Wait a moment, then try again.', {
        code: PUSH_IN_FLIGHT_CODE,
      });
    }
    tx.update(ref, { pushClaimedAt: new Date(nowMs).toISOString() });
    return { kind: 'claimed', ref, copy } as const;
  });
}

/** Both spellings of a draft field, trimmed (`generate.js` writes snake_case, older writers camelCase). */
function draftField(d: Record<string, unknown>, snake: string, camel: string): { snake: string; camel: string } {
  const s = typeof d[snake] === 'string' ? (d[snake] as string).trim() : '';
  const c = typeof d[camel] === 'string' ? (d[camel] as string).trim() : '';
  return { snake: s, camel: c };
}

/**
 * #2295: the `generated_drafts` doc behind this send, refused unless it is an
 * approved Push draft written for this same household. Fails closed: a missing
 * draft, a draft with no household, or one whose two household spellings
 * disagree is refused like a draft for another household. Returns its fields.
 */
function checkApprovedPushDraft(snap: FirebaseFirestore.DocumentSnapshot, kinfolkId: string): Record<string, unknown> {
  if (!snap.exists) throw new HttpsError('not-found', 'This draft is no longer here. It may have been deleted.');
  const d = (snap.data() ?? {}) as Record<string, unknown>;

  const household = draftField(d, 'kinfolk_id', 'kinfolkId');
  const owners = new Set([household.snake, household.camel].filter((v) => v !== ''));
  if (owners.size !== 1 || !owners.has(kinfolkId)) {
    throw new HttpsError('permission-denied', 'This draft was written for a different household.');
  }
  // The type and the status are read exactly as stored (`lib/generatedDraftType.ts`).
  if (!isPushDraft(d)) {
    throw new HttpsError('failed-precondition', 'This draft is not a push.');
  }
  if (d['status'] !== 'approved') {
    throw new HttpsError('failed-precondition', 'Approve this draft before sending it.');
  }
  return d;
}

/**
 * #2293: what the last attempt answered, on the draft itself, and the claim
 * let go. Never a null field: the console and phone models decode these as
 * strings.
 */
async function stampDraft(
  ref: FirebaseFirestore.DocumentReference,
  result: SendHouseholdPushResult,
  uid: string,
): Promise<void> {
  await writeDraftIfPresent(
    ref,
    {
      pushOutcome: result.outcome === 'already_sent' ? 'sent' : result.outcome,
      pushReason: result.reason ?? '',
      pushAttemptedAt: new Date().toISOString(),
      pushClaimedAt: '',
    },
    uid,
    'household.push.draft_stamp.failed',
  );
}
/**
 * #2389: a write to the draft after its send, only while the draft is still
 * there. A merge `set` here brought back a draft deleted while its push was in
 * flight, as a near-empty doc. Never throws: the stamp only steers the lists,
 * and the answer is already true.
 */
async function writeDraftIfPresent(
  ref: FirebaseFirestore.DocumentReference,
  fields: Record<string, unknown>,
  uid: string,
  failedEvent: string,
): Promise<void> {
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      tx.update(ref, fields);
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'sendHouseholdPush',
      event: failedEvent,
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
}

async function deliverHouseholdPush(
  uid: string,
  args: z.infer<typeof Args>,
  body: string,
): Promise<SendHouseholdPushResult> {
  const log = (event: string, extra: Record<string, unknown>) =>
    logEvent({ severity: 'info', function: 'sendHouseholdPush', event, uid, extra: { kinfolkId: args.kinfolkId, ...extra } });

  const recipientUid = await resolveKinfolkUid(args.kinfolkId);
  if (!recipientUid) {
    log('household.push.held', { reason: 'household_has_no_portal_account' });
    return held('household_has_no_portal_account');
  }

  const gate = await loadHouseholdSendGate(db());
  if (!gate.live) {
    log('household.push.held', { reason: 'household_notices_off', gateState: gate.state });
    return held('household_notices_off');
  }

  const def = getNotificationDef(HOUSEHOLD_PUSH_NOTIFICATION_KEY);
  const [userPrefs, businessOverride] = await Promise.all([
    loadUserPrefs(recipientUid, 'clients'),
    loadBusinessOverride(def.key),
  ]);
  if (notificationDisabledFor(def, userPrefs, businessOverride, 'kinfolk') !== null) {
    log('household.push.held', { reason: 'notice_turned_off' });
    return held('notice_turned_off');
  }
  const channels = resolveChannels(def, userPrefs, businessOverride, 'kinfolk');

  const businessName = await loadBusinessName('sendHouseholdPush');
  const title = (args.title ?? '').trim() || businessName;

  // The notice on their list, created once per draft. Its `pushOutcome` stamp
  // says whether the push itself went out, so a second attempt at the same
  // draft answers truthfully: a push that went out is not sent again, and one
  // that did not (their settings kept push off, no device, a refused send) is
  // tried again without a second notice.
  const noticeRef = db().collection('notifications').doc(householdPushNoticeId(args.draftId));
  try {
    await noticeRef.create({
      key: def.key,
      category: def.category,
      recipientUid,
      actorUid: uid,
      data: { kinfolkId: args.kinfolkId, draftId: args.draftId },
      title: title || 'A note for you',
      description: body,
      body,
      // The line the household's notifications list draws under the title
      // (`listMyNotifications` reads `householdLine` for a household key and
      // nothing else). Without it the row read "New message from {business}"
      // with no words under it, and the message was nowhere in MyTribe.
      householdLine: body,
      targetType: 'kinfolk',
      targetId: args.kinfolkId,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // ALREADY_EXISTS: this draft reached their list before.
    if ((err as { code?: unknown })?.code !== 6 && !/already exists/i.test((err as Error)?.message ?? '')) throw err;
    const prior = (await noticeRef.get()).data() as { pushOutcome?: unknown } | undefined;
    if (prior?.pushOutcome === 'sent') {
      log('household.push.duplicate', { draftId: args.draftId });
      return { ok: true, outcome: 'already_sent', reason: null };
    }
    log('household.push.retry', { draftId: args.draftId });
  }

  const result = await attemptPush();
  try {
    await noticeRef.set({ pushOutcome: result.outcome, pushReason: result.reason }, { merge: true });
  } catch (err) {
    // The stamp only steers a later retry; the answer below is already true.
    logEvent({
      severity: 'warn',
      function: 'sendHouseholdPush',
      event: 'household.push.stamp.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
  return result;

  async function attemptPush(): Promise<SendHouseholdPushResult> {
    if (!channels.push) {
      log('household.push.listed', { reason: 'household_push_off' });
      return { ok: true, outcome: 'listed', reason: 'household_push_off' };
    }

    const tokensSnap = await db().collection('fcm_tokens').where('uid', '==', recipientUid).get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (tokens.length === 0) {
      log('household.push.listed', { reason: 'no_device' });
      return { ok: true, outcome: 'listed', reason: 'no_device' };
    }

    try {
      const resp = await getAdmin()
        .messaging()
        .sendEachForMulticast({
          tokens,
          notification: { title: title || undefined, body: householdPushShelfLine(body) },
          data: { notificationKey: def.key, route: HOUSEHOLD_PUSH_ROUTE },
        });
      const stale: Promise<unknown>[] = [];
      resp.responses.forEach((r, i) => {
        const code = r.error?.code;
        if (
          !r.success &&
          (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')
        ) {
          stale.push(db().collection('fcm_tokens').doc(tokens[i]!).delete());
        }
      });
      if (stale.length > 0) await Promise.allSettled(stale);
      if (resp.successCount === 0) {
        logEvent({
          severity: 'warn',
          function: 'sendHouseholdPush',
          event: 'household.push.failed',
          uid,
          extra: { kinfolkId: args.kinfolkId, devices: tokens.length, firstError: resp.responses.find((r) => !r.success)?.error?.code },
        });
        return { ok: true, outcome: 'listed', reason: 'push_failed' };
      }
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'sendHouseholdPush',
        event: 'household.push.failed',
        uid,
        errorMessage: (err as Error)?.message,
        extra: { kinfolkId: args.kinfolkId },
      });
      return { ok: true, outcome: 'listed', reason: 'push_failed' };
    }

    log('household.push.sent', { devices: tokens.length });
    return { ok: true, outcome: 'sent', reason: null };
  }
}
