import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';
import { conferenceName, endConference } from '../twilio/twilioVoice';

/**
 * Accept or reject a screened inbound call from the admin app.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────
 *
 * `auntieos-admin/twilio-service/functions/screen-action.js`, reached by
 * `CallsViewModel.sendToVoicemail` as a bare unauthenticated GET whose response
 * was discarded with `.execute().close()`. Three faults, all fixed here:
 *
 *   1. NO AUTH. Anybody could hang up on the business's callers.
 *   2. IT RETURNED `'OK'` AS PLAIN TEXT while its own caller in `screen-ui`
 *      parsed the reply with `r.json()`, so a successful reject threw and the
 *      operator saw "Network error. Check your connection." A working action
 *      that reports failure trains people to ignore the message.
 *   3. THE ANDROID CALLER IGNORED THE RESULT ENTIRELY and set
 *      "Caller sent to voicemail." unconditionally, so it also reported success
 *      against a host that was returning 403.
 *
 * ── WHY ACCEPT IS A NO-OP HERE ────────────────────────────────────────────────
 *
 * Accepting happens on the DEVICE: the Twilio Voice SDK answers the invite and
 * the operator's leg joins the conference as its moderator, which is what
 * starts it. There is nothing for the server to do, and doing something anyway
 * would be a second mechanism racing the first, which is exactly the flaw in
 * the enqueue-then-REST-inject design this replaced.
 *
 * It is still accepted as an action, and still logged, because the operator's
 * app needs one call site rather than a branch, and because "she pressed accept
 * at 14:02" is worth having in the log next to what the caller heard.
 */

const schema = z.object({
  /** The INBOUND caller's CallSid, which names the conference. Not the operator's leg. */
  callSid: z.string().trim().min(1).max(64),
  action: z.enum(['accept', 'reject']),
});

export interface ScreenCallActionResult {
  /** Echoes the action taken, so the client does not have to remember what it asked for. */
  action: 'accept' | 'reject';
  /**
   * True when a live conference was actually ended by a reject.
   *
   * False is NOT a failure and the client must not present it as one: the
   * caller may have hung up first, or the operator's phone may have rung out
   * and released them already. The call is off either way, which is what the
   * operator asked for.
   */
  conferenceEnded: boolean;
}

export async function screenCallActionHandler(
  req: CallableRequest<unknown>,
): Promise<ScreenCallActionResult> {
  const parsed = schema.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'callSid and action are required.', {
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
  }
  const { callSid, action } = parsed.data;
  const uid = req.auth!.uid;

  if (action === 'accept') {
    logEvent({
      severity: 'info',
      function: 'screenCallAction',
      event: 'screenCallAction.accepted',
      uid,
      extra: { sid: callSid },
    });
    return { action, conferenceEnded: false };
  }

  const conferenceEnded = await endConference(conferenceName(callSid), `rejected-by:${uid}`);
  logEvent({
    severity: 'info',
    function: 'screenCallAction',
    event: 'screenCallAction.rejected',
    uid,
    extra: { sid: callSid, conferenceEnded },
  });
  return { action, conferenceEnded };
}

export const screenCallAction = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
  },
  wrapAdminCallable('screenCallAction', screenCallActionHandler),
);
