import { getAdmin, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { resolveBusinessAdminUids } from '../lib/businessAdmins';

/**
 * The "somebody is on the line" push.
 *
 * ── WHY THIS IS NOT `sendPushChannel` ─────────────────────────────────────────
 *
 * `notifications/senders/pushChannel.ts` already multicasts to a recipient's
 * devices and already prunes dead tokens, and reusing it was the obvious move.
 * It cannot be reused, for three reasons that are each independently fatal:
 *
 *  1. IT STAMPS `notificationKey` ON EVERY PAYLOAD (`pushChannel.ts:53-55`),
 *     and `AuntieFirebaseMessagingService.kt:31-51` branches on that key and
 *     RETURNS before it ever reaches the `when (data["type"])` switch at :53.
 *     A call invite sent through that path renders as an ordinary catalog
 *     notification and never opens the full-screen call UI.
 *  2. IT ALWAYS SENDS A `notification` BLOCK. This message must be DATA-ONLY,
 *     otherwise Android's system tray displays it itself and
 *     `onMessageReceived` never runs in the background, which is the only place
 *     the full-screen intent can be raised.
 *  3. IT SETS NO ANDROID PRIORITY. Without `priority: 'high'` a doze-mode
 *     device may not deliver in time to answer a ringing phone at all.
 *
 * So this is a second, deliberately different sender rather than a parameter on
 * the first. What it DOES borrow, on purpose, is `pushChannel`'s stale-token
 * pruning: `broadcastMessage.ts` omits it and merely counts failures, and a
 * registry that accumulates dead tokens degrades quietly until a real call goes
 * unanswered.
 *
 * ── WHO IT REACHES ────────────────────────────────────────────────────────────
 *
 * `resolveBusinessAdminUids()`, then every `fcm_tokens` document owned by those
 * uids. NOT filtered by `platform`: the Kinfolk portal's KMP clients register
 * values like `android-mytribe` that fail `registerFcmToken`'s zod enum
 * outright, so `platform` does not reliably partition admin devices from
 * kinfolk ones. The uid roster does, and it is the same roster every other
 * business notification already uses.
 *
 * A kinfolk device could never act on this anyway: `KinfolkFcmService`
 * discards any message with no `notificationKey`, which is exactly what this
 * one omits.
 */

/** The Android `when (data["type"])` branch this payload targets. */
const CALL_INVITE_TYPE = 'call_invite';

export interface CallInvitePush {
  callSid: string;
  callerNumber: string;
  /** What the caller said when asked who they are. May be empty. */
  transcript: string;
}

export interface CallInvitePushResult {
  /** Devices FCM accepted the message for. Zero means nobody was told. */
  delivered: number;
  /** Registered devices we attempted. Zero means the roster has no devices at all. */
  attempted: number;
  /** Dead tokens removed from the registry on this send. */
  pruned: number;
}

/**
 * Pushes a call invite to every admin device.
 *
 * FAIL-SOFT, and the distinction matters: this NEVER throws. The caller is on
 * hold on a live phone call while this runs, and an exception here would
 * surface to them as Twilio's "an application error has occurred", which is a
 * worse outcome than the voicemail fallback. The result reports what happened
 * so the voice handler can route the caller accordingly, and `delivered === 0`
 * is logged at `error` because a call nobody was told about is an outage even
 * when the caller is handled gracefully.
 */
export async function sendCallInvitePush(invite: CallInvitePush): Promise<CallInvitePushResult> {
  const empty: CallInvitePushResult = { delivered: 0, attempted: 0, pruned: 0 };

  let uids: string[];
  try {
    uids = await resolveBusinessAdminUids('sendCallInvitePush');
  } catch (err) {
    // resolveBusinessAdminUids throws rather than returning empty, by design.
    // Here that becomes a logged outage, not a dropped call.
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.push.no-roster',
      extra: { sid: invite.callSid, err: (err as Error)?.message },
    });
    return empty;
  }

  let tokens: string[] = [];
  try {
    // `where('uid','in',...)` caps at 30 values and the roster caps at 25
    // (MAX_ROSTER_SIZE), so one query always covers the whole roster.
    const snap = await db().collection('fcm_tokens').where('uid', 'in', uids).get();
    tokens = snap.docs.map((d) => d.id);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.push.token-read-failed',
      extra: { sid: invite.callSid, err: (err as Error)?.message },
    });
    return empty;
  }

  if (tokens.length === 0) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.push.no-devices',
      extra: { sid: invite.callSid, uids: uids.length },
    });
    return empty;
  }

  // Every value must be a string: FCM rejects a data payload containing any
  // other type, and a rejected payload is a call that never rings.
  const data: Record<string, string> = {
    type: CALL_INVITE_TYPE,
    callSid: invite.callSid,
    callerNumber: invite.callerNumber,
    transcript: invite.transcript,
  };

  let response;
  try {
    response = await getAdmin()
      .messaging()
      .sendEachForMulticast({
        tokens,
        // NO `notification` block. See reason 2 in the header.
        data,
        android: { priority: 'high' },
      });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.push.send-failed',
      extra: { sid: invite.callSid, tokens: tokens.length, err: (err as Error)?.message },
    });
    return { ...empty, attempted: tokens.length };
  }

  const stale: string[] = [];
  response.responses.forEach((resp, idx) => {
    if (resp.success) return;
    const code = resp.error?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      const token = tokens[idx];
      if (token) stale.push(token);
    }
  });
  if (stale.length > 0) {
    await Promise.allSettled(stale.map((t) => db().collection('fcm_tokens').doc(t).delete()));
  }

  const result: CallInvitePushResult = {
    delivered: response.successCount,
    attempted: tokens.length,
    pruned: stale.length,
  };

  logEvent({
    severity: result.delivered === 0 ? 'error' : 'info',
    function: 'twilioVoice',
    event: result.delivered === 0 ? 'twilioVoice.push.undelivered' : 'twilioVoice.push.sent',
    extra: { sid: invite.callSid, ...result },
  });

  return result;
}
