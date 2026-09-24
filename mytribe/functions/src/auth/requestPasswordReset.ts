import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { UserRecord } from 'firebase-admin/auth';
import { createHash } from 'crypto';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { activeLockStartedAtMs, checkIpRateLimit, ipRateLimitKey, rateLimitExpiresAt } from './loginSecurity';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapCallable } from '../lib/wrapCallable';
import { wrapTrigger } from '../lib/wrapTrigger';
import { loadEmailTemplate, type EmailTemplateDoc } from '../lib/sendFromTemplate';
import { sendTemplatedEmail } from '../lib/email';
import { SEED_CORPUS } from '../notifications/seedCorpus.generated';
import { parseEmailTxt } from '../notifications/templateParsers';
import { isAuntieClaim, isOwner, isOwnerClaim } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * #905: password reset emails are sent by us, not by Firebase.
 *
 * Firebase's own reset email uses a console template this project cannot edit
 * ("Email template updates are currently unavailable for this project"). So
 * the server builds the reset link with the Admin SDK and sends it through
 * smtp2go using the operator's `auth.password.reset` template, which the
 * operator authors like any other template.
 *
 * TWO HALVES, SO THE ANSWER NEVER DEPENDS ON THE ACCOUNT.
 * `requestPasswordReset` (the callable) checks the per-IP limit, writes one
 * `passwordResetRequests/{id}` doc, and returns `{ ok: true }`. It does the same
 * work for a real address, an unknown one, a locked one and a capped one, so its
 * timing says nothing about which it was. Every account lookup happens after the
 * caller has its answer, in `onPasswordResetRequestCreate`.
 *
 * NOT THROUGH THE NOTIFICATIONS PIPELINE, ON PURPOSE.
 *   - `householdNotificationsLive` gates every household-side notification and
 *     is off until go-live. A reset has to work before then.
 *   - `enqueueNotification` stores its `data` on `notifications/{id}` and
 *     `notificationDispatch/{id}`, both readable by the owner. A live reset
 *     link must not sit in either.
 *   - A business override can switch a notification's email off. It must never
 *     be able to switch off a security email.
 */

const PORTAL_SIGN_IN_URL = 'https://kinfolk.tribetails.com/signin';
const ADMIN_SIGN_IN_URL = 'https://auntie.tribetails.com/signin';

export const PASSWORD_RESET_REQUESTS = 'passwordResetRequests';
const TEMPLATE_KEY = 'auth.password.reset';

// Per (email, network) limit: 3 resets per 24h. #911 moved every client off
// this callable because the old limit was keyed by email alone, so anyone who
// knew an address could spend its 3 and block that household's resets for a
// day. Keyed by email AND the caller's network (IPv4 address or IPv6 /64, the
// same bucketing as the per-IP limit), a stranger spends only their own budget.
const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RATE_LIMIT = 3;

// #891: a locked account's own cap, per lock. Above the daily 3 so the owner
// can still reset after an attacker has spent some, low enough that the reset
// path cannot flood the owner's inbox during a 30-minute lock.
const LOCKED_RESET_LIMIT = 10;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function hashEmail(email: string): string {
  return sha(normalizeEmail(email));
}

/** The rate-limit doc id: one budget per email per network. */
export function resetBudgetKey(email: string, networkKey: string): string {
  return sha(`${normalizeEmail(email)}|${networkKey}`);
}

/**
 * Reserves one reset for this email from this network, or answers false when
 * that budget is spent.
 *
 * Unlocked: 3 per rolling 24 hours (`timestamps`).
 *
 * Locked (#891): exempt from the daily cap, with its own cap of 10 counted
 * against THAT lock (`lockWindowStartedAtMs` / `lockWindowCount`). Resets sent
 * during a lock are not added to `timestamps`, so a lock cannot leave the owner
 * without a reset for 24 hours after it clears. A different lock start resets
 * the count.
 */
async function reservePasswordReset(
  email: string,
  networkKey: string,
  lockStartedAtMs: number | null,
): Promise<boolean> {
  const ref = db().collection('passwordResetEmailRateLimits').doc(resetBudgetKey(email, networkKey));
  const nowMs = Date.now();
  return db().runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() ?? {};
    if (lockStartedAtMs !== null) {
      const sameLock = data['lockWindowStartedAtMs'] === lockStartedAtMs;
      const count = sameLock && typeof data['lockWindowCount'] === 'number' ? (data['lockWindowCount'] as number) : 0;
      if (count >= LOCKED_RESET_LIMIT) return false;
      tx.set(
        ref,
        {
          lockWindowStartedAtMs: lockStartedAtMs,
          lockWindowCount: count + 1,
          updatedAtMs: FieldValue.serverTimestamp(),
          expiresAt: rateLimitExpiresAt(nowMs, EMAIL_RATE_WINDOW_MS),
        },
        { merge: true },
      );
      return true;
    }
    const timestamps: number[] = Array.isArray(data['timestamps']) ? (data['timestamps'] as number[]) : [];
    const recent = timestamps.filter((t) => t >= nowMs - EMAIL_RATE_WINDOW_MS);
    if (recent.length >= EMAIL_RATE_LIMIT) return false;
    recent.push(nowMs);
    tx.set(
      ref,
      {
        timestamps: recent,
        updatedAtMs: FieldValue.serverTimestamp(),
        expiresAt: rateLimitExpiresAt(nowMs, EMAIL_RATE_WINDOW_MS),
      },
      { merge: true },
    );
    return true;
  });
}

const RequestPasswordResetArgs = z.object({
  email: z.string().trim().email(),
});

/**
 * The callable. Same work and same answer for every address: the per-IP limit,
 * one request doc, `{ ok: true }`.
 */
export async function requestPasswordResetHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  const remoteIp = await checkIpRateLimit(req.rawRequest);

  const parsed = RequestPasswordResetArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'email (valid email address) is required');
  }

  const nowMs = Date.now();
  await db()
    .collection(PASSWORD_RESET_REQUESTS)
    .add({
      email: normalizeEmail(parsed.data.email),
      networkKey: ipRateLimitKey(remoteIp),
      ip: remoteIp,
      requestedAtMs: nowMs,
      // Deleted by the trigger the moment it runs; the TTL is the backstop.
      expiresAt: rateLimitExpiresAt(nowMs, 0),
    });

  return { ok: true };
}

/** Staff sign in on the admin app; everyone else on the portal. */
function continueUrlFor(user: UserRecord): string {
  const claims = (user.customClaims ?? {}) as Record<string, unknown>;
  const staff = isOwner(user.uid, isOwnerClaim(claims), 'requestPasswordReset') || isAuntieClaim(claims);
  return staff ? ADMIN_SIGN_IN_URL : PORTAL_SIGN_IN_URL;
}

/**
 * The operator's `auth.password.reset` template, or the repo's copy of it when
 * the operator has not imported one yet. Never the generic notification
 * fallback: that wording carries no link, and a reset email without its link is
 * worse than none.
 */
export async function loadResetTemplate(): Promise<{ template: EmailTemplateDoc; source: 'stored' | 'seed' }> {
  const stored = await loadEmailTemplate(TEMPLATE_KEY);
  if (stored) return { template: stored, source: 'stored' };
  const seed = SEED_CORPUS.find((e) => e.key === TEMPLATE_KEY);
  if (!seed) throw new Error(`no ${TEMPLATE_KEY} template stored and none in the seed corpus`);
  const { subject, body } = parseEmailTxt(seed.emailTxt);
  return { template: { subject, body, html: seed.emailHtml }, source: 'seed' };
}

export interface PasswordResetRequest {
  email: string;
  networkKey: string;
  ip?: string;
}

/**
 * Sends the reset for one request, or quietly does nothing: unknown address,
 * spent budget, no link. Runs after the caller already has its answer.
 */
export async function processPasswordResetRequest(request: PasswordResetRequest): Promise<void> {
  const { email, networkKey, ip } = request;
  const emailHash = hashEmail(email);

  let user: UserRecord;
  try {
    user = await auth().getUserByEmail(email);
  } catch {
    logEvent({ severity: 'info', function: 'requestPasswordReset', event: 'password.reset.noop', extra: { emailHash } });
    return;
  }
  if (!user.email) {
    logEvent({ severity: 'warn', function: 'requestPasswordReset', event: 'password.reset.noEmail', uid: user.uid });
    return;
  }

  const lockStartedAtMs = await activeLockStartedAtMs(user.uid);
  if (!(await reservePasswordReset(email, networkKey, lockStartedAtMs))) {
    logEvent({
      severity: 'info',
      function: 'requestPasswordReset',
      event: 'password.reset.capped',
      uid: user.uid,
      extra: { emailHash, locked: lockStartedAtMs !== null },
    });
    return;
  }

  let source: 'stored' | 'seed';
  try {
    const link = await auth().generatePasswordResetLink(user.email, {
      url: continueUrlFor(user),
      handleCodeInApp: false,
    });

    const loaded = await loadResetTemplate();
    source = loaded.source;
    if (source === 'seed') {
      // Sent anyway; the operator should import the template so it is theirs to edit.
      logEvent({
        severity: 'warn',
        function: 'requestPasswordReset',
        event: 'password.reset.seedTemplate',
        uid: user.uid,
      });
    }

    await sendTemplatedEmail({
      to: user.email,
      subjectTemplate: loaded.template.subject,
      bodyTemplate: loaded.template.body,
      htmlTemplate: loaded.template.html ?? undefined,
      data: { link, email: user.email, displayName: user.displayName || user.email },
    });
  } catch (err) {
    // The request doc is already gone and the caller was told `ok`, so this
    // log is the only record that a reset was asked for and not sent.
    logEvent({
      severity: 'error',
      function: 'requestPasswordReset',
      event: 'password.reset.failed',
      uid: user.uid,
      errorMessage: (err as Error)?.message ?? 'unknown',
    });
    throw err;
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: user.uid,
    description: `Password reset sent to ${user.email}`,
    payload: { emailHash, ip: ip ?? null, template: source },
  }).catch((auditErr) => {
    logEvent({
      severity: 'warn',
      function: 'requestPasswordReset',
      event: 'audit.write.failed',
      errorMessage: (auditErr as Error)?.message ?? 'unknown',
    });
  });
  logEvent({ severity: 'info', function: 'requestPasswordReset', event: 'password.reset.sent', uid: user.uid, extra: { emailHash } });
}

export const requestPasswordReset = onCall(
  {
    region: 'us-central1',
    // The shared list, like recordFailedLogin, so every host that serves a
    // sign-in screen can ask for a reset.
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapCallable('requestPasswordReset', requestPasswordResetHandler),
);

export const onPasswordResetRequestCreate = onDocumentCreated(
  {
    document: `${PASSWORD_RESET_REQUESTS}/{requestId}`,
    region: 'us-central1',
    // AUNTIE_OPERATOR_UIDS: `isOwner`'s transition fallback picks the admin
    // sign-in page for an operator whose claim is not minted yet.
    secrets: ['SENTRY_DSN', 'SMTP2GO_API_KEY', 'EMAIL_FROM', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapTrigger('onPasswordResetRequestCreate', (event) => handlePasswordResetRequestDoc(event.data)),
);

/** The trigger body, exported for tests. */
export async function handlePasswordResetRequestDoc(
  snap: { data(): unknown; ref: { delete(): Promise<unknown> } } | undefined,
): Promise<void> {
  if (!snap) return;
  const data = (snap.data() ?? {}) as Partial<PasswordResetRequest>;
  // Deleted first, so the address it holds is gone whatever happens next.
  await snap.ref.delete();
  if (typeof data.email !== 'string' || typeof data.networkKey !== 'string') return;
  await processPasswordResetRequest({ email: data.email, networkKey: data.networkKey, ip: data.ip });
}
