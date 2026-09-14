/**
 * confirmSecureReset, public HTTPS endpoint.
 *
 * Called from MyTribe /account/secure-reset after a kinfolk flags an
 * unsolicited password-reset email. The user is signed-out; no auth token.
 *
 * Flow:
 *   1. Validate input ({ oobCode, newPassword }; any client-sent email is ignored).
 *   2. Verify the oobCode via Identity Toolkit REST and derive the account email from it.
 *   3. Rate-limit on the derived email.
 *   4. Consume oobCode via Identity Toolkit REST (sets the new password).
 *   5. Write securityIncidents/{auto} Firestore doc.
 *   6. Dispatch security.breach_attempt.kinfolk notification to business admins.
 *   7. Return { ok: true, incidentId }.
 *
 * Fail-loud: auth/Firestore errors propagate as 4xx/5xx.
 * Notification errors are logged loudly but MUST NOT block the reset response
 * (password was already changed by the time we dispatch).
 *
 * Env: WEB_API_KEY secret, Firebase Web API key for Identity Toolkit calls.
 * Wire: `firebase functions:secrets:set WEB_API_KEY --project auntieos-ttpc`
 */

import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';
import { enqueueNotification } from '../notifications/dispatcher.js';
import { logEvent } from '../lib/logger.js';
import { TRIBETAILS_CORS } from '../lib/cors';

// ── Email-based rate limit for confirmSecureReset ─────────────────────────────
// Prevents a single kinfolk address being used to flood breach-incident writes
// or to probe oobCode validity en-masse. Keyed on sha256(email) so no plaintext
// email is stored in the rate-limit doc.
const EMAIL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour window
const EMAIL_RATE_LIMIT = 3;                        // max 3 attempts per window

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

/** Strict Zod email validator. Rejects garbage like `@`, `a@`, `@b`. */
const emailSchema = z.string().email();

/**
 * Check and record a secure-reset attempt for the given email address.
 * Uses a Firestore transaction so concurrent requests don't double-count.
 *
 * @throws never, returns boolean instead of throwing so the caller can issue
 *   the correct HTTP 429 response (this is an onRequest handler, not onCall).
 */
async function checkEmailRateLimit(email: string): Promise<boolean> {
  const db = getFirestore();
  const key = `secureReset_${hashEmail(email)}`;
  const ref = db.collection('securityRateLimits').doc(key);
  const nowMs = Date.now();
  const cutoff = nowMs - EMAIL_RATE_WINDOW_MS;

  let limited = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const timestamps: number[] = (snap.data()?.timestamps as number[] | undefined) ?? [];
    const recent = timestamps.filter((t) => t >= cutoff);
    if (recent.length >= EMAIL_RATE_LIMIT) {
      limited = true;
      return; // do not record, don't let the array grow unboundedly on abuse
    }
    recent.push(nowMs);
    tx.set(ref, { timestamps: recent, updatedAtMs: nowMs }, { merge: true });
  });
  return limited;
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
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
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
  const resetUrl = `${identityToolkitBase()}/accounts:resetPassword?key=${apiKey}`;
  // ── Step 1: Verify the oobCode and DERIVE the account email ─────────────────
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
    const verified = (await verifyResp.json().catch(() => ({}))) as { email?: unknown };
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
  // ── Step 2: Rate-limit on the derived email (BEFORE the code is consumed) ───
  // Max 3 confirmSecureReset attempts per account per 24h, so one account
  // cannot be used to flood breach-incident writes. Keyed on the derived email,
  // so rotating a client-sent address no longer buys fresh attempts.
  const rateLimited = await checkEmailRateLimit(canonicalEmail);
  if (rateLimited) {
    // Log hash only, raw email in Cloud Logging is PII leakage (CWE-532).
    logEvent({
      severity: 'warn',
      function: 'confirmSecureReset',
      event: 'security.secureResetRateLimited',
      extra: { emailHash: hashEmail(canonicalEmail), ip },
    });
    res.status(429).json({ ok: false, reason: 'rate_limited' });
    return;
  }
  // ── Step 3: Consume oobCode + set new password via Identity Toolkit REST ────
  let resetResp: Response;
  try {
    resetResp = await fetch(resetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode, newPassword }),
    });
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
  if (!resetResp.ok) {
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
        ip,
        note: 'Caller-supplied email does not match oobCode owner, possible spoof',
      },
    });
  }
  // ── Step 2: Write securityIncidents doc ───────────────────────────────────────
  const db = getFirestore();
  const incidentRef = db.collection('securityIncidents').doc();
  await incidentRef.set({
    type: 'unsolicited_password_reset',
    kinfolkEmail: canonicalEmail,
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
    extra: { incidentId: incidentRef.id, emailHash: hashEmail(canonicalEmail), ip },
  });

  // ── Step 3: Dispatch notification ─────────────────────────────────────────────
  // Notification failure MUST NOT block the reset response, the password has
  // already been changed and the kinfolk is waiting. Log loudly instead.
  try {
    await enqueueNotification({
      key: 'security.breach_attempt.kinfolk',
      data: {
        kinfolkEmail: canonicalEmail,
        timestampIso: ts,
        ip,
        userAgent: ua,
        incidentId: incidentRef.id,
      },
    });
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
