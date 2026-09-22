/**
 * confirmSecureReset, public HTTPS endpoint.
 *
 * Called from the portal's email action page (/account/secure-reset) when the
 * account holder chooses "I did not ask for this reset". The user is signed out;
 * no auth token.
 *
 * Flow:
 *   1. Validate input ({ oobCode, newPassword }; any client-sent email is ignored).
 *   2. Per-IP limit, keyed on the IP Google appended (#892 review), before any
 *      Identity Toolkit call.
 *   3. Verify the oobCode via Identity Toolkit REST, derive the account email
 *      from it, and require a PASSWORD_RESET code.
 *   4. Hold a slot in the account's 3-per-24h limit.
 *   5. Consume the oobCode (sets the new password), then record the slot as used
 *      only if that succeeded. If the consume call throws, find out whether the
 *      change landed anyway (#892 review 2) before deciding.
 *   6. Write securityIncidents/{auto}.
 *   7. Alert business admins under the key for the account's role:
 *      security.breach_attempt.staff for an admin-claim account, else
 *      security.breach_attempt.kinfolk.
 *   8. Return { ok: true, incidentId }.
 *
 * Fail-loud: auth/Firestore errors propagate as 4xx/5xx.
 * Notification errors are logged loudly but MUST NOT block the reset response
 * (password was already changed by the time we dispatch).
 *
 * Env: WEB_API_KEY secret, Firebase Web API key for Identity Toolkit calls.
 * Wire: `firebase functions:secrets:set WEB_API_KEY --project auntieos-ttpc`
 */

import { onRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { enqueueNotification } from '../notifications/dispatcher.js';
import { logEvent } from '../lib/logger.js';
import { TRIBETAILS_CORS } from '../lib/cors';
// Lazy Admin SDK access (#903 review). This function deploys as its own Cloud Run
// service and nothing else initializes the default app in its process, so a bare
// getFirestore() or getAuth() here throws "The default Firebase app does not exist".
import { auth, db } from '../lib/firestoreAdmin';
// #891 (PR #908): the trusted client IP and the per-IP limit key. The copy this
// file used before #908 merged is gone (#910).
import { clientIpOf, ipRateLimitKey } from '../auth/loginSecurity';

// ── Limits ────────────────────────────────────────────────────────────────────
// Account limit: at most 3 applied secure resets per account per 24h, so one
// account cannot be used to flood breach-incident writes. Keyed on sha256 of the
// DERIVED email so no plaintext email is stored in the rate-limit doc.
export const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RATE_LIMIT = 3;
/**
 * How long a held slot counts before it is ignored. Long enough to cover the
 * Identity Toolkit apply call, short enough that a crashed call cannot hold a
 * slot for the rest of the day.
 */
const PENDING_LEASE_MS = 5 * 60 * 1000;

// IP limit (#892 review): verify is an unauthenticated Identity Toolkit call, so
// it is throttled per client IP before it runs.
export const IP_RATE_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_LIMIT = 10;

/**
 * #892 review 2: how long after its last write a limit doc may be deleted by
 * Firestore TTL (`securityRateLimits.expiresAt`, declared in
 * firestore.indexes.json), beyond the window it is read over. The same margin as
 * #908's ledgers. Nothing reads `expiresAt`: the windows filter on their own
 * timestamps, so a doc the TTL has not reached yet can never refuse a call.
 */
export const RATE_LIMIT_TTL_MARGIN_MS = 60 * 60 * 1000;

function expiresAtFor(nowMs: number, windowMs: number): Timestamp {
  return Timestamp.fromMillis(nowMs + windowMs + RATE_LIMIT_TTL_MARGIN_MS);
}

/**
 * Canonicalize an email for rate-limit bucket derivation. Lowercases AND
 * strips `+tag` aliases from the local part so `victim@x` and `victim+a@x`
 * map to the same bucket, defeats the alias-rotation rate-limit bypass.
 */
function canonicalizeEmail(email: string): string {
  const trimmed = email.toLowerCase().trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const plus = local.indexOf('+');
  return (plus >= 0 ? local.slice(0, plus) : local) + domain;
}

function hashEmail(email: string): string {
  return createHash('sha256').update(canonicalizeEmail(email)).digest('hex').slice(0, 32);
}

/**
 * Keyed through #908's `ipRateLimitKey`, the same as loginSecurity's own limit:
 * IPv4 is the address, IPv6 is its /64 (one subscriber usually holds a whole
 * /64), and the `untrusted` sentinel from `clientIpOf` is one shared bucket.
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(ipRateLimitKey(ip)).digest('hex').slice(0, 32);
}

/** Strict Zod email validator. Rejects garbage like `@`, `a@`, `@b`. */
const emailSchema = z.string().email();

/**
 * Count and record one call from this IP. Every call spends budget, including
 * one whose code turns out to be bad, because probing codes is what this limits.
 *
 * The verdict is the value the transaction RESOLVES to, never a variable the
 * callback sets (#892 review 2): Firestore re-runs the callback on contention,
 * and a flag set by a discarded attempt would outlive it.
 */
async function ipIsRateLimited(ip: string): Promise<boolean> {
  const firestore = db();
  const ref = firestore.collection('securityRateLimits').doc(`secureResetIp_${hashIp(ip)}`);
  return firestore.runTransaction(async (tx) => {
    const nowMs = Date.now();
    const snap = await tx.get(ref);
    const timestamps: number[] = (snap.data()?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= nowMs - IP_RATE_WINDOW_MS);
    if (recent.length >= IP_RATE_LIMIT) {
      return true; // do not record, don't let the array grow unboundedly on abuse
    }
    recent.push(nowMs);
    tx.set(
      ref,
      { timestamps: recent, updatedAtMs: nowMs, expiresAt: expiresAtFor(nowMs, IP_RATE_WINDOW_MS) },
      { merge: true },
    );
    return false;
  });
}

interface PendingAttempt {
  id: string;
  atMs: number;
}

function livePending(raw: unknown, nowMs: number): PendingAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is PendingAttempt =>
      !!p && typeof p.id === 'string' && typeof p.atMs === 'number' && p.atMs >= nowMs - PENDING_LEASE_MS,
  );
}

function emailLimitRef(email: string) {
  return db().collection('securityRateLimits').doc(`secureReset_${hashEmail(email)}`);
}

/**
 * Hold a slot in the account's limit before the password is changed.
 *
 * #892 review: the attempt used to be RECORDED here, so a weak-password
 * rejection or a code already used in another tab spent one of the three. Now a
 * slot is only held: applied resets plus live held slots must be under the limit,
 * checked and held in one transaction so concurrent calls cannot exceed it.
 * `settleEmailAttempt` turns the hold into a used slot only if the apply worked.
 *
 * #892 review 2: the hold id is what the transaction RESOLVES to. A retried
 * callback that finds the account full returns null, and that null is the
 * answer, whatever an earlier discarded attempt had decided.
 *
 * @returns the hold id, or null when the account is at its limit.
 */
async function holdEmailAttempt(email: string): Promise<string | null> {
  const firestore = db();
  const ref = emailLimitRef(email);
  return firestore.runTransaction(async (tx) => {
    const nowMs = Date.now();
    const data = (await tx.get(ref)).data();
    const timestamps: number[] = (data?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= nowMs - EMAIL_RATE_WINDOW_MS);
    const pending = livePending(data?.pending, nowMs);
    if (recent.length + pending.length >= EMAIL_RATE_LIMIT) return null;
    const id = randomUUID();
    pending.push({ id, atMs: nowMs });
    tx.set(
      ref,
      { timestamps: recent, pending, updatedAtMs: nowMs, expiresAt: expiresAtFor(nowMs, EMAIL_RATE_WINDOW_MS) },
      { merge: true },
    );
    return id;
  });
}

/** Release a held slot, recording it as a used attempt only when the reset was applied. */
async function settleEmailAttempt(email: string, id: string, applied: boolean): Promise<void> {
  const firestore = db();
  const ref = emailLimitRef(email);
  try {
    await firestore.runTransaction(async (tx) => {
      const nowMs = Date.now();
      const data = (await tx.get(ref)).data();
      const timestamps: number[] = (data?.timestamps as number[] | undefined) ?? [];
      const recent = timestamps.filter((t) => t >= nowMs - EMAIL_RATE_WINDOW_MS);
      if (applied) recent.push(nowMs);
      const pending = livePending(data?.pending, nowMs).filter((p) => p.id !== id);
      tx.set(
        ref,
        { timestamps: recent, pending, updatedAtMs: nowMs, expiresAt: expiresAtFor(nowMs, EMAIL_RATE_WINDOW_MS) },
        { merge: true },
      );
    });
  } catch (e) {
    // The reset itself already succeeded or failed; a lost settle only means the
    // hold lapses after PENDING_LEASE_MS. Loud, not blocking.
    logEvent({
      severity: 'error',
      function: 'confirmSecureReset',
      event: 'security.secureResetSettleFailed',
      extra: { emailHash: hashEmail(email), applied, error: String(e) },
    });
  }
}

// ── Request shape ─────────────────────────────────────────────────────────────
interface ResetBody {
  /** Firebase oobCode from the password-reset link. */
  oobCode: string;
  /** New password chosen by the account holder. */
  newPassword: string;
  /**
   * IGNORED for identity (#892). Older clients (the KMP SecureResetFetcher)
   * still send it. The account is always derived from the oobCode; a supplied
   * value is only compared against it so a spoof attempt is logged.
   */
  email?: string;
  /** navigator.userAgent from the browser (optional; best-effort). */
  userAgent?: string;
}

/**
 * Identity Toolkit base URL. Under the Auth emulator the same REST surface is
 * served at http://<host>/identitytoolkit.googleapis.com, so an emulator run
 * never reaches production.
 */
function identityToolkitBase(): string {
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  return emulator
    ? `http://${emulator}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';
}

type AccountRole = 'staff' | 'kinfolk' | 'unknown';

/**
 * Whose account this is, for the alert's key and label (#892 review). Staff hold
 * the `admin` custom claim (firestore.rules `isAuntie()`).
 *
 * #892 review 2: a failed lookup is 'unknown', not 'kinfolk', so the incident
 * does not claim a role nobody checked. The alert still goes out, under the
 * kinfolk key, so the operator hears about it either way.
 */
async function accountRoleOf(email: string): Promise<AccountRole> {
  try {
    const user = await auth().getUserByEmail(email);
    return user.customClaims?.['admin'] === true ? 'staff' : 'kinfolk';
  } catch (e) {
    logEvent({
      severity: 'warn',
      function: 'confirmSecureReset',
      event: 'security.roleLookupFailed',
      extra: { emailHash: hashEmail(email), error: String(e) },
    });
    return 'unknown';
  }
}

/**
 * #892 review 2: the consume call threw, which does not mean Identity Toolkit
 * did nothing. It may have used the code and changed the password before the
 * connection dropped.
 *
 *   - The code still verifies: it was not used, so nothing changed.
 *   - The account's `tokensValidAfterTime` (validSince, which a password change
 *     moves) is at or after the call started: the change landed.
 *   - Otherwise nobody can say.
 */
async function consumeOutcomeAfterThrow(
  resetUrl: string,
  oobCode: string,
  email: string,
  startedAtMs: number,
): Promise<'not_applied' | 'applied' | 'unknown'> {
  try {
    const recheck = await fetch(resetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode }),
    });
    if (recheck.ok) return 'not_applied';
  } catch {
    // Unreachable again; fall through to the account record.
  }
  try {
    const user = await auth().getUserByEmail(email);
    const validSinceMs = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : NaN;
    // validSince has one-second precision, so allow the second the call started in.
    if (Number.isFinite(validSinceMs) && validSinceMs >= startedAtMs - 1000) return 'applied';
  } catch {
    // Could not read the account either.
  }
  return 'unknown';
}

// ── Handler (exported for unit tests) ────────────────────────────────────────
export interface MinimalReq {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  json(payload: Record<string, unknown>): void;
}

export async function confirmSecureResetHandler(
  req: MinimalReq,
  res: MinimalRes,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const body = (req.body ?? {}) as Partial<ResetBody>;
  const { oobCode, newPassword, userAgent } = body;
  const suppliedEmail = typeof body.email === 'string' ? body.email : null;
  if (!oobCode || !newPassword) {
    res.status(400).json({ error: 'missing_required', fields: { oobCode: !oobCode, newPassword: !newPassword } });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'password_too_short', minLength: 8 });
    return;
  }
  const ts = new Date().toISOString();
  // The entry Google appended, never the caller's forgeable first entry (#892 review).
  const ip = clientIpOf({ headers: req.headers, ip: req.socket.remoteAddress });
  const ua = userAgent || (req.headers['user-agent'] as string | undefined) || 'unknown';
  const apiKey = process.env.WEB_API_KEY ?? '';
  if (!apiKey) {
    // Fail-loud: never attempt the reset without the key, we'd silently skip
    // password verification.
    logEvent({
      severity: 'error',
      function: 'confirmSecureReset',
      event: 'security.missingApiKey',
      extra: { message: 'WEB_API_KEY secret is unset, cannot verify oobCode' },
    });
    res.status(503).json({ error: 'server_misconfigured', detail: 'WEB_API_KEY not set' });
    return;
  }

  // ── Step 2: Per-IP limit before any Identity Toolkit call ────────────────────
  if (await ipIsRateLimited(ip)) {
    logEvent({
      severity: 'warn',
      function: 'confirmSecureReset',
      event: 'security.secureResetIpRateLimited',
      extra: { ipHash: hashIp(ip) },
    });
    res.status(429).json({ ok: false, reason: 'rate_limited' });
    return;
  }

  const resetUrl = `${identityToolkitBase()}/accounts:resetPassword?key=${apiKey}`;
  // ── Step 3: Verify the oobCode and DERIVE the account email ─────────────────
  // accounts:resetPassword with only an oobCode checks the code and returns
  // { email, requestType } WITHOUT consuming it (the client SDK's
  // verifyPasswordResetCode is this same call). The email a client sends is
  // never trusted (#892, CWE-345): the incident, the notification and the rate
  // limit all name the account that actually owns the code.
  let canonicalEmail: string;
  try {
    const verifyResp = await fetch(resetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode }),
    });
    if (!verifyResp.ok) {
      const detail = await verifyResp.text();
      logEvent({
        severity: 'warn',
        function: 'confirmSecureReset',
        event: 'security.oobCodeRejected',
        extra: { stage: 'verify', status: verifyResp.status, detail },
      });
      res.status(400).json({ error: 'reset_failed', detail });
      return;
    }
    const verified = (await verifyResp.json().catch(() => ({}))) as { email?: unknown; requestType?: unknown };
    if (typeof verified.email !== 'string' || !emailSchema.safeParse(verified.email).success) {
      logEvent({
        severity: 'warn',
        function: 'confirmSecureReset',
        event: 'security.oobCodeRejected',
        extra: { stage: 'verify', note: 'Identity Toolkit named no account for this oobCode' },
      });
      res.status(400).json({ error: 'reset_failed', detail: 'no_account_for_code' });
      return;
    }
    // #892 review: only a password reset code may set a password here. An email
    // verification or recovery code is refused before it touches the limit.
    if (verified.requestType !== 'PASSWORD_RESET') {
      logEvent({
        severity: 'warn',
        function: 'confirmSecureReset',
        event: 'security.oobCodeRejected',
        extra: { stage: 'verify', note: 'not a password reset code', requestType: String(verified.requestType) },
      });
      res.status(400).json({ error: 'reset_failed', detail: 'wrong_code_type' });
      return;
    }
    canonicalEmail = verified.email;
  } catch (e) {
    logEvent({
      severity: 'error',
      function: 'confirmSecureReset',
      event: 'security.authUnreachable',
      extra: { error: String(e) },
    });
    res.status(502).json({ error: 'auth_unreachable', detail: String(e) });
    return;
  }

  // ── Step 4: Hold a slot in the account limit (BEFORE the code is consumed) ──
  const holdId = await holdEmailAttempt(canonicalEmail);
  if (holdId === null) {
    // Log hash only, raw email in Cloud Logging is PII leakage (CWE-532).
    logEvent({
      severity: 'warn',
      function: 'confirmSecureReset',
      event: 'security.secureResetRateLimited',
      extra: { emailHash: hashEmail(canonicalEmail), ipHash: hashIp(ip) },
    });
    res.status(429).json({ ok: false, reason: 'rate_limited' });
    return;
  }

  // ── Step 5: Consume oobCode + set new password via Identity Toolkit REST ────
  const consumeStartedAtMs = Date.now();
  let outcome: 'applied' | 'unknown' = 'applied';
  try {
    const resetResp = await fetch(resetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode, newPassword }),
    });
    if (!resetResp.ok) {
      await settleEmailAttempt(canonicalEmail, holdId, false);
      const detail = await resetResp.text();
      logEvent({
        severity: 'warn',
        function: 'confirmSecureReset',
        event: 'security.oobCodeRejected',
        extra: { stage: 'consume', status: resetResp.status, detail, emailHash: hashEmail(canonicalEmail) },
      });
      res.status(400).json({ error: 'reset_failed', detail });
      return;
    }
  } catch (e) {
    const after = await consumeOutcomeAfterThrow(resetUrl, oobCode, canonicalEmail, consumeStartedAtMs);
    logEvent({
      severity: 'error',
      function: 'confirmSecureReset',
      event: 'security.authUnreachable',
      extra: { stage: 'consume', outcomeAfterThrow: after, emailHash: hashEmail(canonicalEmail), error: String(e) },
    });
    if (after === 'not_applied') {
      await settleEmailAttempt(canonicalEmail, holdId, false);
      res.status(502).json({ error: 'auth_unreachable', detail: String(e) });
      return;
    }
    // Landed, or cannot tell: count the slot, file the incident and alert, so a
    // password change never goes unreported.
    outcome = after;
  }
  await settleEmailAttempt(canonicalEmail, holdId, true);

  const emailMismatch =
    suppliedEmail !== null && suppliedEmail.toLowerCase() !== canonicalEmail.toLowerCase();
  if (emailMismatch) {
    logEvent({
      severity: 'warn',
      function: 'confirmSecureReset',
      event: 'security.emailMismatch',
      extra: {
        suppliedHash: hashEmail(suppliedEmail),
        canonicalHash: hashEmail(canonicalEmail),
        ipHash: hashIp(ip),
        note: 'Caller-supplied email does not match oobCode owner, possible spoof',
      },
    });
  }

  const role = await accountRoleOf(canonicalEmail);

  // ── Step 6: Write securityIncidents doc ──────────────────────────────────────
  const firestore = db();
  const incidentRef = firestore.collection('securityIncidents').doc();
  await incidentRef.set({
    type: 'unsolicited_password_reset',
    // 'applied' when the new password is known to be set; 'unknown' when the
    // consume call threw and nothing could confirm either way (#892 review 2).
    outcome,
    accountRole: role,
    accountEmail: canonicalEmail,
    // Kept for existing readers of kinfolk incidents; null unless the role is known kinfolk.
    kinfolkEmail: role === 'kinfolk' ? canonicalEmail : null,
    staffEmail: role === 'staff' ? canonicalEmail : null,
    suppliedEmail: emailMismatch ? suppliedEmail : null,
    timestampIso: ts,
    ip,
    userAgent: ua,
    // Store only the first 8 chars, enough for correlation, not enough to replay.
    oobCodePrefix: oobCode.slice(0, 8),
    createdAt: FieldValue.serverTimestamp(),
  });

  logEvent({
    severity: 'warn',
    function: 'confirmSecureReset',
    event: 'security.breachAttemptRecorded',
    extra: { incidentId: incidentRef.id, emailHash: hashEmail(canonicalEmail), role, outcome, ipHash: hashIp(ip) },
  });

  // ── Step 7: Dispatch notification ────────────────────────────────────────────
  // Notification failure MUST NOT block the reset response, the password has
  // already been changed and the account holder is waiting. Log loudly instead.
  const common = { timestampIso: ts, ip, userAgent: ua, incidentId: incidentRef.id };
  try {
    await enqueueNotification(
      role === 'staff'
        ? { key: 'security.breach_attempt.staff', data: { staffEmail: canonicalEmail, ...common } }
        : { key: 'security.breach_attempt.kinfolk', data: { kinfolkEmail: canonicalEmail, ...common } },
    );
  } catch (e) {
    // FAIL-LOUD: notification dispatch failed, log with full detail so admin
    // can correlate via Cloud Logging → incidentId.
    console.error('[confirmSecureReset] NOTIFICATION DISPATCH FAILED, admin alert not delivered', {
      incidentId: incidentRef.id,
      emailHash: hashEmail(canonicalEmail),
      error: String(e),
    });
    logEvent({
      severity: 'error',
      function: 'confirmSecureReset',
      event: 'security.notificationDispatchFailed',
      extra: { incidentId: incidentRef.id, emailHash: hashEmail(canonicalEmail), error: String(e) },
    });
  }

  if (outcome === 'unknown') {
    // The page must not tell the account holder their password is set when
    // nobody knows. The incident and alert above are already filed.
    res.status(502).json({ error: 'outcome_unknown', incidentId: incidentRef.id });
    return;
  }
  res.status(200).json({ ok: true, incidentId: incidentRef.id });
}

// ── Firebase Function registration ────────────────────────────────────────────
export const confirmSecureReset = onRequest(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    // WEB_API_KEY is the Firebase Web App API key, public in client config but
    // stored as a secret here to keep it out of source and allow rotation.
    // Operator: `firebase functions:secrets:set WEB_API_KEY --project auntieos-ttpc`
    secrets: ['WEB_API_KEY'],
  },
  async (req, res) => {
    const adapter: MinimalRes = {
      status(code: number) {
        res.status(code);
        return adapter;
      },
      json(payload: Record<string, unknown>) {
        res.json(payload);
      },
    };
    await confirmSecureResetHandler(
      {
        method: req.method,
        body: req.body,
        headers: req.headers as Record<string, string | string[] | undefined>,
        socket: { remoteAddress: req.socket?.remoteAddress },
      },
      adapter,
    );
  },
);
