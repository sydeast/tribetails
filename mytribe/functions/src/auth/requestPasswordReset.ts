import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications';
import { checkIpRateLimit } from './loginSecurity';
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

async function checkPasswordResetEmailRateLimit(email: string): Promise<void> {
  const key = hashEmail(email);
  const ref = db().collection('passwordResetEmailRateLimits').doc(key);
  const nowMs = Date.now();
  const cutoff = nowMs - EMAIL_RATE_WINDOW_MS;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const timestamps: number[] = (snap.data()?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= cutoff);
    if (recent.length >= EMAIL_RATE_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        'Too many password reset requests for this account. Try again later.',
      );
    }
    recent.push(nowMs);
    tx.set(ref, { timestamps: recent, updatedAtMs: FieldValue.serverTimestamp() }, { merge: true });
  });
}

const RequestPasswordResetArgs = z.object({
  email: z.string().email(),
});

export async function requestPasswordResetHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  const remoteIp =
    (req.rawRequest?.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.rawRequest?.ip ??
    'unknown';
  await checkIpRateLimit(remoteIp);

  const parsed = RequestPasswordResetArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'email (valid email address) is required');
  }
  const { email } = parsed.data;

  // Per-email rate-limit BEFORE any auth lookup so an attacker can't iterate
  // emails to enumerate accounts via the rate-limit response code either.
  await checkPasswordResetEmailRateLimit(email);

  // Constant-work pattern. Both branches always invoke getUserByEmail +
  // generatePasswordResetLink (catching all errors to hide which threw).
  // Trailing constant-work sleep below floors total latency so hit + miss
  // paths are timing-indistinguishable, closes the auth/user-not-found
  // fast-throw oracle (~5ms miss vs ~500ms hit prior to this).
  const startMs = Date.now();
  let user: import('firebase-admin/auth').UserRecord | null;
  let link: string | null;
  try {
    user = await auth().getUserByEmail(email);
  } catch {
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
