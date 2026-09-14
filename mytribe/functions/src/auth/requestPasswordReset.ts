import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications';
import { activeLockStartedAtMs, checkIpRateLimit } from './loginSecurity';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapCallable } from '../lib/wrapCallable';

const CONTINUE_URL = 'https://kinfolk.tribetails.com/account/secure-reset';

// Per-email rate limit: 3 reset requests per 24h per email. Caps a target-
// specific spam relay. Below the per-IP limit so an attacker rotating IPs
// still can't iterate a target.
const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RATE_LIMIT = 3;

// Constant-work floor (ms). Both hit + miss paths sleep up to this elapsed
// total before returning, closing the existence-oracle timing channel that
// `auth/user-not-found` fast-throw exposed previously. Tunable via env for
// tests. Default chosen to cover worst-case getUserByEmail +
// generatePasswordResetLink + enqueueNotification round trip.
const CONSTANT_WORK_MS_DEFAULT = 600;
function getConstantWorkMs(): number {
  const raw = process.env.PASSWORD_RESET_CONSTANT_WORK_MS;
  if (raw === undefined) return CONSTANT_WORK_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CONSTANT_WORK_MS_DEFAULT;
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 32);
}

// #891: a locked account's own cap, per lock. Above the daily 3 so the owner
// can still reset after an attacker has spent some, low enough that the reset
// path cannot be used to flood the owner's inbox during a 30-minute lock.
const LOCKED_RESET_LIMIT = 10;

/**
 * Reserves one reset for `email`, or answers false when its cap is spent.
 *
 * Unlocked: 3 per email per rolling 24 hours (`timestamps`).
 *
 * Locked (#891): exempt from the daily cap, with its own cap of 10 counted
 * against THAT lock (`lockWindowStartedAtMs` / `lockWindowCount`). Resets sent
 * during a lock are not added to `timestamps`, or an attacker who locked the
 * account could spend its daily budget and leave the owner without a reset for
 * 24 hours after the lock clears. A different lock start resets the count.
 *
 * Never throws for being over a cap. Before #891 the 4th request was a 429,
 * and with the lock exemption the same 4th request would have been a 429 for an
 * unlocked email and `{ ok: true }` for a locked one, which tells a stranger the
 * account is real and locked. Over a cap the handler answers `{ ok: true }` and
 * sends nothing, for every email alike.
 */
async function reservePasswordReset(email: string, lockStartedAtMs: number | null): Promise<boolean> {
  const ref = db().collection('passwordResetEmailRateLimits').doc(hashEmail(email));
  const nowMs = Date.now();
  return db().runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() ?? {};
    if (lockStartedAtMs !== null) {
      const sameLock = data['lockWindowStartedAtMs'] === lockStartedAtMs;
      const count = sameLock && typeof data['lockWindowCount'] === 'number' ? (data['lockWindowCount'] as number) : 0;
      if (count >= LOCKED_RESET_LIMIT) return false;
      tx.set(
        ref,
        { lockWindowStartedAtMs: lockStartedAtMs, lockWindowCount: count + 1, updatedAtMs: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    }
    const timestamps: number[] = Array.isArray(data['timestamps']) ? (data['timestamps'] as number[]) : [];
    const recent = timestamps.filter((t) => t >= nowMs - EMAIL_RATE_WINDOW_MS);
    if (recent.length >= EMAIL_RATE_LIMIT) return false;
    recent.push(nowMs);
    tx.set(ref, { timestamps: recent, updatedAtMs: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

const RequestPasswordResetArgs = z.object({
  email: z.string().email(),
});

export async function requestPasswordResetHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  // #891: keyed on the entry Google appended to X-Forwarded-For, not the
  // caller's first entry; see `clientIpOf` in loginSecurity.ts.
  const remoteIp = await checkIpRateLimit(req.rawRequest);

  const parsed = RequestPasswordResetArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'email (valid email address) is required');
  }
  const { email } = parsed.data;

  // Constant-work pattern. Both branches always invoke getUserByEmail +
  // generatePasswordResetLink (catching all errors to hide which threw).
  // Trailing constant-work sleep below floors total latency so hit + miss
  // paths are timing-indistinguishable, closes the auth/user-not-found
  // fast-throw oracle (~5ms miss vs ~500ms hit prior to this). #891: the lock
  // read and the per-email cap now sit inside the padded time too.
  const startMs = Date.now();
  let user: import('firebase-admin/auth').UserRecord | null;
  let link: string | null;
  try {
    user = await auth().getUserByEmail(email);
  } catch {
    user = null;
  }

  // #891: a locked account is exempt from the daily cap (see
  // reservePasswordReset). Over any cap the call still does the same work and
  // answers the same `{ ok: true }`; it just sends nothing, because `user` is
  // cleared and the send below needs it.
  const lockStartedAtMs = user ? await activeLockStartedAtMs(user.uid) : null;
  if (!(await reservePasswordReset(email, lockStartedAtMs))) {
    logEvent({
      severity: 'info',
      function: 'requestPasswordReset',
      event: 'password.reset.capped',
      extra: { emailHash: hashEmail(email), locked: lockStartedAtMs !== null },
    });
    user = null;
  }

  try {
    link = await auth().generatePasswordResetLink(email, {
      url: `${CONTINUE_URL}?email=${encodeURIComponent(email)}`,
      handleCodeInApp: false,
    });
  } catch {
    link = null;
  }

  if (user && link) {
    const displayName = user.displayName ?? email;
    try {
      await enqueueNotification({
        key: 'auth.password.reset',
        recipientUid: user.uid,
        data: { link, email, displayName },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'requestPasswordReset',
        event: 'notification.dispatch.failed',
        uid: user.uid,
        errorMessage: (err as Error)?.message ?? 'unknown',
      });
    }
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: user.uid,
      description: `Password reset requested for ${email}`,
      payload: { emailHash: hashEmail(email), ip: remoteIp },
    }).catch((auditErr) => {
      logEvent({
        severity: 'warn',
        function: 'requestPasswordReset',
        event: 'audit.write.failed',
        errorMessage: (auditErr as Error)?.message ?? 'unknown',
      });
    });
    logEvent({
      severity: 'info',
      function: 'requestPasswordReset',
      event: 'password.reset.enqueued',
      uid: user.uid,
      extra: { emailHash: hashEmail(email) },
    });
  } else {
    // No-such-user path. Log only the email hash to avoid leaking PII into
    // Cloud Logging. Same response shape + similar latency to the hit path.
    logEvent({
      severity: 'info',
      function: 'requestPasswordReset',
      event: 'password.reset.noop',
      extra: { emailHash: hashEmail(email) },
    });
  }

  // Constant-work floor: pad to CONSTANT_WORK_MS so hit + miss paths are
  // timing-indistinguishable from the caller's perspective.
  const targetMs = getConstantWorkMs();
  const elapsedMs = Date.now() - startMs;
  if (elapsedMs < targetMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, targetMs - elapsedMs));
  }

  return { ok: true };
}

export const requestPasswordReset = onCall(
  {
    region: 'us-central1',
    cors: [
      'https://auntie.tribetails.com',
      'https://kinfolk.tribetails.com',
      /^http:\/\/localhost(:\d+)?$/,
    ],
    secrets: ['SENTRY_DSN'],
  },
  wrapCallable('requestPasswordReset', requestPasswordResetHandler),
);
