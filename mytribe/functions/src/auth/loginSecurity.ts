import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapCallable } from '../lib/wrapCallable';
import { enqueueNotification } from '../notifications';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isStaff } from '../lib/staffGate';

/**
 * Failed-login security subsystem.
 *
 * Thresholds (per kinfolk acct, rolling windows):
 *   ≥ 5 failures in 10 min → enqueue 'auth.failedLogin.attempts' (kinfolk)
 *   ≥ 10 failures in 20 min → set lockedUntil, enqueue 'auth.account.locked'
 *                              to kinfolk AND businessAdmins
 *
 * Lockout duration is manual, only an admin call to `unlockKinfolkAccount` or
 * a successful password reset (detected via Firebase Auth tokensValidAfterTime
 * rising above the lock-start timestamp) clears it.
 *
 * The reset-PW link must remain on the login screen at all times (frontend
 * responsibility) so a locked user has a recovery path.
 *
 * ⚠️ recordFailedLogin is unauthenticated, frontend reports after a failed
 * Firebase Auth signin call. Hardened with three layers to prevent
 * attacker-driven permanent lockouts of arbitrary emails (CWE-307 DoS):
 *   1. Per-IP sliding window (30/5min)
 *   2. Per-email sliding window (15/24h), caps target-specific harassment
 *   3. Finite lockout duration (30 min auto-clear), no Number.MAX_SAFE_INTEGER
 * App Check enforcement remains a TODO (requires client wiring).
 */

const WINDOW_WARN_MS = 10 * 60 * 1000;
const WINDOW_LOCK_MS = 20 * 60 * 1000;
const THRESHOLD_WARN = 5;
const THRESHOLD_LOCK = 10;
const ATTEMPT_PRUNE_MS = 30 * 60 * 1000;

// Finite lockout: a real user resets via the password-link path; an attacker
// who drove the lockout has to wait this window before next lockout fires.
// No Number.MAX_SAFE_INTEGER, that was a permanent-DoS vector.
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

// IP-level rate limit for recordFailedLogin (Phase 1b).
// Prevents attackers driving arbitrary lockouts by spamming this callable
// from a single IP without actually attempting real sign-ins.
const IP_RATE_WINDOW_MS = 5 * 60 * 1000;   // 5-minute sliding window
const IP_RATE_LIMIT = 30;                   // max calls per window per IP

// Per-email rate limit. Even with an IP-rotating attacker, the same target
// email can only be reported 15 times in 24h. Threshold sits above
// THRESHOLD_LOCK (10) so a real user still triggers a legitimate lockout, but
// far below any iteration speed needed for a credential-stuffing campaign.
const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RATE_LIMIT = 15;

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 32);
}

export async function checkEmailRateLimit(email: string): Promise<void> {
  const key = hashEmail(email);
  const ref = db().collection('failedLoginEmailRateLimits').doc(key);
  const nowMs = Date.now();
  const cutoff = nowMs - EMAIL_RATE_WINDOW_MS;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const timestamps: number[] = (snap.data()?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= cutoff);
    if (recent.length >= EMAIL_RATE_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        'Too many failed login reports for this account. Try again later.',
      );
    }
    recent.push(nowMs);
    tx.set(ref, { timestamps: recent, updatedAtMs: nowMs }, { merge: true });
  });
}

export async function checkIpRateLimit(rawIp: string): Promise<void> {
  const ipKey = hashIp(rawIp);
  const ref = db().collection('ipRateLimits').doc(ipKey);
  const nowMs = Date.now();
  const cutoff = nowMs - IP_RATE_WINDOW_MS;

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const timestamps: number[] = (snap.data()?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= cutoff);
    if (recent.length >= IP_RATE_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Too many requests. Try again later.');
    }
    recent.push(nowMs);
    tx.set(ref, { timestamps: recent, updatedAtMs: nowMs }, { merge: true });
  });
}

interface LoginAttempt {
  ts: number;
  ip?: string;
  userAgent?: string;
}

interface LoginSecurityDoc {
  attempts: LoginAttempt[];
  warnSentAtMs?: number;
  lockedUntilMs?: number;
  lockStartedAtMs?: number;
  updatedAtMs: number;
}

const RecordFailedArgs = z.object({
  email: z.string().email(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});

async function uidForEmail(email: string): Promise<string | null> {
  try {
    const user = await auth().getUserByEmail(email);
    return user.uid;
  } catch {
    return null;
  }
}

function attemptsInWindow(attempts: LoginAttempt[], windowMs: number, nowMs: number): number {
  const cutoff = nowMs - windowMs;
  return attempts.filter((a) => a.ts >= cutoff).length;
}

function pruneAttempts(attempts: LoginAttempt[], nowMs: number): LoginAttempt[] {
  const cutoff = nowMs - ATTEMPT_PRUNE_MS;
  return attempts.filter((a) => a.ts >= cutoff);
}

async function readSecurityDoc(uid: string): Promise<LoginSecurityDoc> {
  const snap = await db().collection('clients').doc(uid).collection('security').doc('loginAttempts').get();
  const data = snap.data() as Partial<LoginSecurityDoc> | undefined;
  return {
    attempts: data?.attempts ?? [],
    warnSentAtMs: data?.warnSentAtMs,
    lockedUntilMs: data?.lockedUntilMs,
    lockStartedAtMs: data?.lockStartedAtMs,
    updatedAtMs: data?.updatedAtMs ?? 0,
  };
}

async function writeSecurityDoc(uid: string, doc: Partial<LoginSecurityDoc>): Promise<void> {
  await db()
    .collection('clients')
    .doc(uid)
    .collection('security')
    .doc('loginAttempts')
    .set({ ...doc, updatedAtMs: Date.now() }, { merge: true });
}

export interface RecordFailedLoginResult {
  /** Remaining failures within 20-min window before lockout fires. */
  remainingBeforeLock: number;
  locked: boolean;
  lockedUntilMs: number | null;
}

export async function recordFailedLoginHandler(
  req: CallableRequest<unknown>,
): Promise<RecordFailedLoginResult> {
  const args = RecordFailedArgs.parse(req.data);

  // Server-side IP (not the client-supplied args.ip which can be spoofed).
  const remoteIp =
    (req.rawRequest.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.rawRequest.ip ??
    'unknown';
  await checkIpRateLimit(remoteIp);
  // Per-target rate limit. Even if the attacker rotates IPs, a single target
  // email can only be reported EMAIL_RATE_LIMIT times per window.
  await checkEmailRateLimit(args.email);

  const uid = await uidForEmail(args.email);
  if (!uid) {
    // Audit: failed login attempt against unknown email. Admin must see this
    // to detect credential-stuffing patterns even when no real account hit.
    await writeAuditEntry({
      event: AUDIT_EVENTS.AUTH_LOGIN_FAIL,
      severity: 'warn',
      actorRole: 'SYSTEM',
      description: `Failed login (no matching account) for ${args.email}`,
      payload: { email: args.email, ip: remoteIp, reason: 'no-such-user' },
      status: 'FAILURE',
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'recordFailedLogin',
        event: 'audit.write.failed',
        errorMessage: (err as Error)?.message,
      });
    });
    return { remainingBeforeLock: THRESHOLD_LOCK, locked: false, lockedUntilMs: null };
  }

  // Audit: failed login for a real account. Per-attempt entry. The lock event
  // below (if it fires) gets its own entry.
  await writeAuditEntry({
    event: AUDIT_EVENTS.AUTH_LOGIN_FAIL,
    severity: 'warn',
    actorRole: 'PRIMARY',
    actorUid: uid,
    description: `Failed login for ${args.email}`,
    payload: { email: args.email, ip: remoteIp, userAgent: args.userAgent },
    status: 'FAILURE',
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  const nowMs = Date.now();
  const current = await readSecurityDoc(uid);
  if (current.lockedUntilMs && current.lockedUntilMs > nowMs) {
    return {
      remainingBeforeLock: 0,
      locked: true,
      lockedUntilMs: current.lockedUntilMs,
    };
  }

  const nextAttempts = pruneAttempts(
    [...current.attempts, { ts: nowMs, ip: args.ip, userAgent: args.userAgent }],
    nowMs,
  );
  const countWarn = attemptsInWindow(nextAttempts, WINDOW_WARN_MS, nowMs);
  const countLock = attemptsInWindow(nextAttempts, WINDOW_LOCK_MS, nowMs);

  const update: Partial<LoginSecurityDoc> = { attempts: nextAttempts };
  let locked = false;
  let lockedUntilMs: number | null = null;

  if (countLock >= THRESHOLD_LOCK) {
    // Finite lockout (30 min), auto-clears so an attacker-driven lockout
    // doesn't become permanent. Real user can also recover via password reset
    // (beforeSignIn detects tokensValidAfterTime > lockStartedAtMs).
    update.lockedUntilMs = nowMs + LOCKOUT_DURATION_MS;
    update.lockStartedAtMs = nowMs;
    locked = true;
    lockedUntilMs = update.lockedUntilMs;

    await enqueueNotification({
      key: 'auth.account.locked',
      recipientUid: uid,
      data: { email: args.email, lockStartedAtMs: nowMs },
    });
    const operatorUids = (process.env.AUNTIE_OPERATOR_UIDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    await Promise.all(
      operatorUids.map((operatorUid) =>
        enqueueNotification({
          key: 'auth.account.locked',
          recipientUid: operatorUid,
          data: { email: args.email, lockStartedAtMs: nowMs, kinfolkUid: uid },
        }).catch((err) => {
          logEvent({
            severity: 'warn',
            function: 'recordFailedLogin',
            event: 'admin.lock.notify.failed',
            uid,
            errorMessage: (err as Error)?.message,
          });
        }),
      ),
    );
  } else if (
    countWarn >= THRESHOLD_WARN &&
    (!current.warnSentAtMs || current.warnSentAtMs < nowMs - WINDOW_WARN_MS)
  ) {
    update.warnSentAtMs = nowMs;
    await enqueueNotification({
      key: 'auth.failedLogin.attempts',
      recipientUid: uid,
      data: { email: args.email, attemptsInWindow: countWarn },
    });
  }

  await writeSecurityDoc(uid, update);

  return {
    remainingBeforeLock: Math.max(0, THRESHOLD_LOCK - countLock),
    locked,
    lockedUntilMs,
  };
}

export const recordFailedLogin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('recordFailedLogin', recordFailedLoginHandler),
);

/**
 * Firebase Auth blocking function, runs on every successful credential
 * verification before the sign-in completes. Used here to:
 *   1. Reject sign-in if the kinfolk account is locked.
 *   2. Detect a post-lock password reset (tokensValidAfterTime > lockStartedAtMs)
 *      and auto-clear the lock so the legitimate user can recover.
 *   3. Clear the rolling attempt counter on successful sign-in.
 */
export const beforeSignIn = beforeUserSignedIn(
  // minInstances: this blocking fn runs inline in EVERY sign-in; a cold start
  // here surfaced to users as the opaque first-login failure (2026-07-10).
  { region: 'us-central1', secrets: ['SENTRY_DSN'], minInstances: 1 },
  async (event) => {
    const uid = event.data?.uid;
    if (!uid) return;
    const current = await readSecurityDoc(uid);
    const nowMs = Date.now();

    if (current.lockedUntilMs && current.lockedUntilMs > nowMs) {
      let resetDetected = false;
      try {
        const userRec = await auth().getUser(uid);
        const tokensValidAfterMs = userRec.tokensValidAfterTime
          ? new Date(userRec.tokensValidAfterTime).getTime()
          : 0;
        if (
          current.lockStartedAtMs &&
          tokensValidAfterMs > current.lockStartedAtMs
        ) {
          resetDetected = true;
        }
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'beforeSignIn',
          event: 'beforeSignIn.reset.detect.failed',
          uid,
          errorMessage: (err as Error)?.message,
        });
      }

      if (!resetDetected) {
        throw new HttpsError(
          'permission-denied',
          'This account is locked. Use the reset password link or contact support.',
        );
      }
    }

    // Clear rolling attempt counter on successful sign-in. Firestore admin
    // SDK rejects raw `undefined` field values (throws "Cannot use undefined
    // as a Firestore value"); use FieldValue.delete() to actually remove
    // optional lock fields. Earlier bug here caused EVERY sign-in across the
    // project (admin + kinfolk) to 503 with Identity Toolkit Error 47.
    await db()
      .collection('clients')
      .doc(uid)
      .collection('security')
      .doc('loginAttempts')
      .set(
        {
          attempts: [],
          warnSentAtMs: FieldValue.delete(),
          lockedUntilMs: FieldValue.delete(),
          lockStartedAtMs: FieldValue.delete(),
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );

    // Audit: successful sign-in. Fires for BOTH kinfolk and admin (the
    // beforeUserSignedIn blocking function runs on every Firebase Auth sign-in
    // regardless of role). Admin login is differentiated downstream via
    // actorRole or the admin custom claim, we tag SYSTEM here and surface
    // role via payload to keep this emit self-contained.
    const isAdminClaim =
      event.data?.customClaims &&
      ((event.data.customClaims as { admin?: boolean }).admin === true ||
        (event.data.customClaims as { role?: string }).role === 'admin');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.AUTH_LOGIN_SUCCESS,
      severity: 'info',
      actorRole: isAdminClaim ? 'AUNTIE' : 'PRIMARY',
      actorUid: uid,
      description: `Sign-in success${isAdminClaim ? ' (admin)' : ''}`,
      payload: { admin: !!isAdminClaim, provider: event.data?.providerData?.[0]?.providerId },
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'beforeSignIn',
        event: 'audit.write.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    });
  },
);

/** Admin-only callable to clear lockout + attempts on a kinfolk acct. */
const UnlockArgs = z.object({ uid: z.string().min(1) });

export async function unlockKinfolkAccountHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isStaff(req.auth.uid, req.auth.token['admin'] === true || req.auth.token['role'] === 'admin', 'unlockKinfolkAccount');
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin role required.');
  const args = UnlockArgs.parse(req.data);

  await db()
    .collection('clients')
    .doc(args.uid)
    .collection('security')
    .doc('loginAttempts')
    .set(
      {
        attempts: [],
        warnSentAtMs: FieldValue.delete(),
        lockedUntilMs: FieldValue.delete(),
        lockStartedAtMs: FieldValue.delete(),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    );

  logEvent({
    severity: 'info',
    function: 'unlockKinfolkAccount',
    event: 'admin.acct.unlocked',
    uid: args.uid,
    extra: { actorUid: req.auth.uid },
  });
  return { ok: true };
}

export const unlockKinfolkAccount = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('unlockKinfolkAccount', unlockKinfolkAccountHandler),
);
