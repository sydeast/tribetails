import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db, getAdmin } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { loadBusinessName } from '../lib/businessName';
import { sanitizePlainText } from '../lib/richText';
import { getNotificationDef } from '../notifications/catalog';
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
 * The notice's id is derived from the draft, and it is CREATED, so a retry of a
 * reply that was lost cannot push twice. A held send writes nothing, so trying
 * again after the operator switches household notices on goes through.
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

  // The notice on their list, created once per draft. A second attempt at the
  // same draft finds it and sends nothing new.
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
      targetType: 'kinfolk',
      targetId: args.kinfolkId,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // ALREADY_EXISTS: this draft was pushed before.
    if ((err as { code?: unknown })?.code === 6 || /already exists/i.test((err as Error)?.message ?? '')) {
      log('household.push.duplicate', { draftId: args.draftId });
      return { ok: true, outcome: 'already_sent', reason: null };
    }
    throw err;
  }

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
        notification: { title: title || undefined, body },
        data: { notificationKey: def.key },
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
