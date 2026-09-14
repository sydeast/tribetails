import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { captureFunctionError } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { enqueueNotification } from '../notifications';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isStaff } from '../lib/staffGate';
import { FULL_CPU } from '../lib/runtimeOptions';

/**
 * Failed-login security subsystem.
 *
 * Thresholds (per kinfolk acct, rolling windows):
 *   ≥ 5 failures in 10 min → enqueue 'auth.failedLogin.attempts' (kinfolk)
 *   ≥ 10 failures in 20 min → set lockedUntil, enqueue 'auth.account.locked'
 *                              to the kinfolk, and
 *                              'security.account.locked.operator' to every
 *                              business admin on the roster (#869)
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
  /**
   * Set to `lockStartedAtMs` in the same transaction that saves the lock, and
   * deleted once both lock alerts have been accepted by the dispatcher. While it
   * equals the stored `lockStartedAtMs`, a later failed login re-sends the alerts
   * for THAT lock (#869 review). A lock saved before this field existed never
   * matches, so it is never re-alerted.
   */
  lockAlertsPendingForMs?: number;
  updatedAtMs: number;
}

export const RecordFailedLoginArgs = z.object({
  email: z.string().email(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});

/**
 * #886: the whole response, for every caller and every outcome.
 *
 * The caller is unauthenticated, so anything that varies here tells a stranger
 * something about an account. The old response did: an unknown email came back
 * `remainingBeforeLock: 10` while a real one counted down, and `lockedUntilMs`
 * said exactly when a locked account would open again. So the callable answers
 * `{ ok: true }` whether or not the email is an account, whether or not this
 * call warned or locked, and whether or not an alert failed to send. The
 * signed-in client never needed the numbers: a locked account is told so by
 * `beforeSignIn`'s refusal on its next sign-in, which only the person holding
 * the right password can reach.
 *
 * The only errors left are ones that say nothing about the account: a malformed
 * request (`invalid-argument`) and the per-IP and per-email rate limits
 * (`resource-exhausted`), which count reports for unknown emails exactly as
 * they count them for real ones.
 */
export const RecordFailedLoginResult = z.object({ ok: z.literal(true) }).strict();
export type RecordFailedLoginResponse = z.infer<typeof RecordFailedLoginResult>;
const RECORDED: RecordFailedLoginResponse = { ok: true };

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

function securityDocRef(uid: string) {
  return db().collection('clients').doc(uid).collection('security').doc('loginAttempts');
}

function parseSecurityDoc(raw: unknown): LoginSecurityDoc {
  const data = raw as Partial<LoginSecurityDoc> | undefined;
  return {
    attempts: data?.attempts ?? [],
    warnSentAtMs: data?.warnSentAtMs,
    lockedUntilMs: data?.lockedUntilMs,
    lockStartedAtMs: data?.lockStartedAtMs,
    lockAlertsPendingForMs:
      typeof data?.lockAlertsPendingForMs === 'number' ? data.lockAlertsPendingForMs : undefined,
    updatedAtMs: data?.updatedAtMs ?? 0,
  };
}

async function readSecurityDoc(uid: string): Promise<LoginSecurityDoc> {
  return parseSecurityDoc((await securityDocRef(uid).get()).data());
}

async function writeSecurityDoc(uid: string, doc: Partial<LoginSecurityDoc>): Promise<void> {
  await db()
    .collection('clients')
    .doc(uid)
    .collection('security')
    .doc('loginAttempts')
    .set({ ...doc, updatedAtMs: Date.now() }, { merge: true });
}

/**
 * The #832 dedupe identity of one lock's alerts: the household account and the
 * moment its lock started, read from the saved lock rather than the current
 * call. A retry for the same lock carries the same pair and is refused; a second
 * household locking, or the same one locking again, is a new pair and alerts.
 * Both copies (household and operator) use it; the dispatcher's ledger is keyed
 * by notification key too, so they never suppress each other.
 */
export function lockAlertDedupeKey(kinfolkUid: string, lockStartedAtMs: number): string {
  return `auth.lock:${kinfolkUid}:${lockStartedAtMs}`;
}

function nonEmpty(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * What the operator's lock alert says about the household (#869).
 *
 * `kinfolkName` is always sent, so the subject can never render as
 * "Account locked:  (email)". It is the first non-empty of: the household's
 * name (`families/{kinfolkId}`, only when the account holds exactly ONE
 * household), the account's own name, the email's local part.
 *
 * `kinfolkId` is sent only for exactly one household, which also gives the card
 * its deep link. Kinfolk with two or more tribes are a defect state (only admins
 * hold several), and naming one of them would be a guess. Never throws: a failed
 * read still sends the alert with the email and the local-part name.
 */
async function operatorLockAlertData(
  uid: string,
  email: string,
  lockStartedAtMs: number,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { kinfolkUid: uid, kinfolkEmail: email, lockStartedAtMs };
  let name = '';
  try {
    const client = (await db().collection('clients').doc(uid).get()).data() ?? {};
    const ids = Array.isArray(client['kinfolkIds'])
      ? (client['kinfolkIds'] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : [];
    if (ids.length === 1) {
      data['kinfolkId'] = ids[0];
      const family = (await db().collection('families').doc(ids[0]!).get()).data() ?? {};
      name = nonEmpty(family['displayName']) || nonEmpty(family['name']);
    }
    if (!name) name = nonEmpty(client['displayName']) || nonEmpty(client['name']);
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'admin.lock.household.lookup.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
  data['kinfolkName'] = name || email.split('@')[0] || email;
  return data;
}

/**
 * Sends both alerts for one saved lock, then clears the pending marker.
 *
 * The household copy has no catch: its failure fails the call, as it always
 * has, and the marker stays so the next failed login retries. The operator copy
 * is caught (a resolver failure must never undo a lock) but also leaves the
 * marker, so it is retried the same way. Both carry the lock's dedupe key with
 * a window as long as the lock, so a retry that follows a partial success sends
 * only the copy that is still missing.
 */
async function sendLockAlerts(uid: string, email: string, lockStartedAtMs: number): Promise<void> {
  const dedupeKey = lockAlertDedupeKey(uid, lockStartedAtMs);
  await enqueueNotification({
    key: 'auth.account.locked',
    recipientUid: uid,
    data: { email, lockStartedAtMs },
    dedupeKey,
    dedupeWindowMs: LOCKOUT_DURATION_MS,
  });

  // #869: the operator copy is its own key, resolved from the business admin
  // roster as STAFF. The roster is the source of truth; AUNTIE_OPERATOR_UIDS
  // (bound on this function below) is only its self-heal fallback while the
  // roster is empty.
  let operatorAccepted = true;
  await enqueueNotification({
    key: 'security.account.locked.operator',
    data: await operatorLockAlertData(uid, email, lockStartedAtMs),
    dedupeKey,
    dedupeWindowMs: LOCKOUT_DURATION_MS,
  }).catch((err) => {
    operatorAccepted = false;
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'admin.lock.notify.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  if (!operatorAccepted) return;

  // Cleared only while the stored marker still names THIS lock. Between the lock
  // being saved and this line, an admin unlock or a password reset followed by a
  // fresh lock can replace it with a newer lock's marker, and deleting that one
  // would silently cancel the newer lock's retry.
  const ref = securityDocRef(uid);
  await db()
    .runTransaction(async (tx) => {
      const stored = parseSecurityDoc((await tx.get(ref)).data());
      if (stored.lockAlertsPendingForMs !== lockStartedAtMs) return;
      tx.set(ref, { lockAlertsPendingForMs: FieldValue.delete() }, { merge: true });
    })
    .catch((err) => {
      // Harmless if it fails: the next retry is deduped by the ledger.
      logEvent({
        severity: 'warn',
        function: 'recordFailedLogin',
        event: 'admin.lock.pending.clear.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    });
}

type LockDecision =
  | { kind: 'alreadyLocked'; lockedUntilMs: number; pendingLockStartedAtMs: number | null }
  | { kind: 'lockedNow'; lockedUntilMs: number; lockStartedAtMs: number }
  | { kind: 'counted'; nowMs: number; countLock: number; countWarn: number; warn: boolean };

export async function recordFailedLoginHandler(
  req: CallableRequest<unknown>,
): Promise<RecordFailedLoginResponse> {
  const args = RecordFailedLoginArgs.parse(req.data);

  // Server-side IP (not the client-supplied args.ip which can be spoofed).
  const remoteIp =
    (req.rawRequest.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.rawRequest.ip ??
    'unknown';
  await checkIpRateLimit(remoteIp);
  // Per-target rate limit. Even if the attacker rotates IPs, a single target
  // email can only be reported EMAIL_RATE_LIMIT times per window.
  await checkEmailRateLimit(args.email);

  // #886: from here on nothing reaches the caller but `{ ok: true }`. A failure
  // below (a Firestore transaction, a household alert the dispatcher refused)
  // used to fail the call, and only a REAL account can get that far, so an
  // error was itself an answer to "is this an account". It is logged and sent
  // to Sentry instead. Nothing depends on the throw: an alert that did not go
  // out is retried off the saved `lockAlertsPendingForMs` marker by the next
  // failed login, not by the client retrying this call.
  try {
    const uid = await uidForEmail(args.email);
    if (uid) {
      await recordAccountFailure(uid, args, remoteIp);
    } else {
      await recordUnknownEmailFailure(args.email, remoteIp);
    }
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'recordFailedLogin',
      event: 'recordFailedLogin.failed',
      errorMessage: (err as Error)?.message,
    });
    try {
      captureFunctionError(err, { function: 'recordFailedLogin' });
    } catch {
      // Reporting is best-effort; the response is the same either way.
    }
  }
  return { ...RECORDED };
}

/**
 * #886: a failed sign-in for an email that is not an account.
 *
 * TIMING. This does the same WORK as the real-account path rather than
 * returning early, so the two are not told apart by how fast the call answers:
 * both have already paid for the IP and email rate-limit transactions and the
 * `getUserByEmail` lookup, and both now pay for one audit write and one
 * read-prune-write transaction over an `attempts` array. Here that transaction
 * runs on `unknownLoginAttempts/{emailHash}` (hashed like the rate limits, no
 * address stored), which also keeps a per-address count for spotting
 * credential stuffing against addresses that are not accounts.
 *
 * WHAT STILL DIFFERS, stated rather than hidden: on the calls that cross a
 * threshold for a REAL account (the 5th failure's warning, the 10th's lock
 * alerts, and a retry of either while their marker is pending) the real path
 * enqueues notifications and this one does not, so those few calls take longer.
 * Seeing it takes five reports against one address inside ten minutes, the
 * per-email limit allows fifteen a day, and every one of those calls warns or
 * locks the real owner, so the probe announces itself to the household.
 */
async function recordUnknownEmailFailure(email: string, remoteIp: string): Promise<void> {
  // Audit: failed login attempt against unknown email. Admin must see this
  // to detect credential-stuffing patterns even when no real account hit.
  await writeAuditEntry({
    event: AUDIT_EVENTS.AUTH_LOGIN_FAIL,
    severity: 'warn',
    actorRole: 'SYSTEM',
    description: `Failed login (no matching account) for ${email}`,
    payload: { email, ip: remoteIp, reason: 'no-such-user' },
    status: 'FAILURE',
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'audit.write.failed',
      errorMessage: (err as Error)?.message,
    });
  });

  const ref = db().collection('unknownLoginAttempts').doc(hashEmail(email));
  await db().runTransaction(async (tx) => {
    const nowMs = Date.now();
    const prior = ((await tx.get(ref)).data()?.attempts as LoginAttempt[] | undefined) ?? [];
    const attempts = pruneAttempts([...prior, { ts: nowMs }], nowMs);
    tx.set(ref, { attempts, updatedAtMs: nowMs }, { merge: true });
  });
}

/**
 * #886: the caller-supplied `ip` and `userAgent`, only when they were sent.
 *
 * Every sign-in client sends `{ email }` alone. Spreading `args.ip` straight
 * into a stored object put `undefined` in it, and real Firestore refuses the
 * whole write ("Cannot use undefined as a Firestore value"), so the attempt was
 * never counted and the account could never lock. The emulator run caught it;
 * the write-through test mock stores `undefined` without complaint.
 */
function optionalCallerFields(args: z.infer<typeof RecordFailedLoginArgs>): { ip?: string; userAgent?: string } {
  return {
    ...(args.ip !== undefined ? { ip: args.ip } : {}),
    ...(args.userAgent !== undefined ? { userAgent: args.userAgent } : {}),
  };
}

/** A failed sign-in for a real account: count it, then warn, lock and alert as the thresholds say. */
async function recordAccountFailure(
  uid: string,
  args: z.infer<typeof RecordFailedLoginArgs>,
  remoteIp: string,
): Promise<void> {
  // Audit: failed login for a real account. Per-attempt entry. The lock event
  // below (if it fires) gets its own entry.
  await writeAuditEntry({
    event: AUDIT_EVENTS.AUTH_LOGIN_FAIL,
    severity: 'warn',
    actorRole: 'PRIMARY',
    actorUid: uid,
    description: `Failed login for ${args.email}`,
    payload: { email: args.email, ip: remoteIp, ...optionalCallerFields(args) },
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

  // #869 review: the attempt is counted and any lock is SAVED in one
  // transaction, before a single alert is sent. The alerts then key off the
  // saved `lockStartedAtMs`, never this call's clock, so an alert that fails is
  // retried for the same lock instead of a fresh lock being taken (and alerted)
  // on the next call. The transaction also stops two concurrent failures from
  // both crossing the threshold with two different lock starts.
  const ref = securityDocRef(uid);
  const decision = await db().runTransaction(async (tx): Promise<LockDecision> => {
    const nowMs = Date.now();
    const current = parseSecurityDoc((await tx.get(ref)).data());
    if (current.lockedUntilMs && current.lockedUntilMs > nowMs) {
      const pending =
        current.lockStartedAtMs !== undefined &&
        current.lockAlertsPendingForMs === current.lockStartedAtMs
          ? current.lockStartedAtMs
          : null;
      return { kind: 'alreadyLocked', lockedUntilMs: current.lockedUntilMs, pendingLockStartedAtMs: pending };
    }

    const nextAttempts = pruneAttempts(
      [...current.attempts, { ts: nowMs, ...optionalCallerFields(args) }],
      nowMs,
    );
    const countWarn = attemptsInWindow(nextAttempts, WINDOW_WARN_MS, nowMs);
    const countLock = attemptsInWindow(nextAttempts, WINDOW_LOCK_MS, nowMs);

    if (countLock >= THRESHOLD_LOCK) {
      // Finite lockout (30 min), auto-clears so an attacker-driven lockout
      // doesn't become permanent. Real user can also recover via password reset
      // (beforeSignIn detects tokensValidAfterTime > lockStartedAtMs).
      const lockedUntilMs = nowMs + LOCKOUT_DURATION_MS;
      tx.set(
        ref,
        {
          attempts: nextAttempts,
          lockedUntilMs,
          lockStartedAtMs: nowMs,
          lockAlertsPendingForMs: nowMs,
          updatedAtMs: nowMs,
        },
        { merge: true },
      );
      return { kind: 'lockedNow', lockedUntilMs, lockStartedAtMs: nowMs };
    }

    tx.set(ref, { attempts: nextAttempts, updatedAtMs: nowMs }, { merge: true });
    const warn =
      countWarn >= THRESHOLD_WARN &&
      (!current.warnSentAtMs || current.warnSentAtMs < nowMs - WINDOW_WARN_MS);
    return { kind: 'counted', nowMs, countLock, countWarn, warn };
  });

  switch (decision.kind) {
    case 'alreadyLocked': {
      if (decision.pendingLockStartedAtMs !== null) {
        await sendLockAlerts(uid, args.email, decision.pendingLockStartedAtMs);
      }
      return;
    }
    case 'lockedNow': {
      await sendLockAlerts(uid, args.email, decision.lockStartedAtMs);
      return;
    }
    case 'counted': {
      if (decision.warn) {
        await enqueueNotification({
          key: 'auth.failedLogin.attempts',
          recipientUid: uid,
          data: { email: args.email, attemptsInWindow: decision.countWarn },
        });
        // Stamped only after the warning was accepted, as before, so a failed
        // warning is retried by the next failed login.
        await writeSecurityDoc(uid, { warnSentAtMs: decision.nowMs });
      }
      return;
    }
    default: {
      const exhaustive: never = decision;
      throw new Error(`recordFailedLogin: unknown lock decision ${JSON.stringify(exhaustive)}`);
    }
  }
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
  // Blocking, so it sits inline in the sign-in itself. At 0.25 vCPU Cloud Run
  // would pin concurrency to 1 and serialise concurrent logins behind one
  // request; a full vCPU keeps the 80-way concurrency this needs.
  { region: 'us-central1', secrets: ['SENTRY_DSN'], minInstances: 1, ...FULL_CPU },
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
          lockAlertsPendingForMs: FieldValue.delete(),
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
        // #869: an unlocked account has no lock whose alerts could be pending.
        lockAlertsPendingForMs: FieldValue.delete(),
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
