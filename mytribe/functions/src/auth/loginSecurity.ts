import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { isIP } from 'net';
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
 *   5 failures in 10 min: a warning burst starts (at most one per 10 min).
 *       'auth.failedLogin.attempts' goes to the kinfolk only, and
 *       'security.failedLogin.attempts.operator' to every business admin on
 *       the roster (#877).
 *   10 failures in 20 min: the account locks. 'auth.account.locked' goes to
 *       the kinfolk only, and 'security.account.locked.operator' to every
 *       business admin on the roster (#869).
 *
 * The lock lasts LOCKOUT_DURATION_MS (30 minutes) and then clears by itself.
 * It clears sooner on an admin call to `unlockKinfolkAccount`, or on the first
 * sign-in after a password reset (beforeSignIn sees Firebase Auth's
 * tokensValidAfterTime rise above the lock start).
 *
 * Both kinds of alert are saved before they are sent. The counting transaction
 * stores the burst or lock start with a pending marker, both copies carry a
 * dedupe key built from that stored start, and a later failed login re-sends
 * whatever did not go out. The marker is cleared once both copies are accepted.
 * A pending warning is retried only while its 10-minute burst is open and the
 * account is not locked: once the account locks, later failures only retry the
 * lock alerts, which tell both audiences more than the warning would.
 *
 * The reset-PW link must remain on the login screen at all times (frontend
 * responsibility) so a locked user has a recovery path.
 *
 * ⚠️ recordFailedLogin is unauthenticated, frontend reports after a failed
 * Firebase Auth signin call. Hardened with three layers to prevent
 * attacker-driven permanent lockouts of arbitrary emails (CWE-307 DoS):
 *   1. Per-IP sliding window (30/5min), keyed on the address Google appended
 *      to X-Forwarded-For, not the caller's own first entry (#891, clientIpOf)
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
  return createHash('sha256').update(ipRateLimitKey(ip)).digest('hex').slice(0, 32);
}

/**
 * #908 review: how long after its last write a rate-limit ledger doc may be
 * deleted by Firestore TTL, beyond the longest window it is read over. Nothing
 * reads `expiresAt`; the windows filter on their own timestamps, so a doc TTL
 * has not reached yet can never refuse a call it should allow.
 */
export const RATE_LIMIT_TTL_MARGIN_MS = 60 * 60 * 1000;

/** The `expiresAt` for a ledger doc read over `windowMs`, written at `nowMs`. */
export function rateLimitExpiresAt(nowMs: number, windowMs: number): Timestamp {
  return Timestamp.fromMillis(nowMs + windowMs + RATE_LIMIT_TTL_MARGIN_MS);
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 32);
}

const EMAIL_RATE_LIMIT_MESSAGE = 'Too many failed login reports for this account. Try again later.';

function emailRateLimitRef(email: string) {
  return db().collection('failedLoginEmailRateLimits').doc(hashEmail(email));
}

type EmailReportDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** The saved exhaustion whose operator alert to send now (new or pending), else null. */
      alertExhaustedAtMs: number | null;
    };

/**
 * Counts one report against the email's daily budget, or refuses it.
 *
 * #891: a refusal no longer throws inside the transaction, so it can save
 * `budgetExhaustedAtMs` and its pending marker in the same write, before the
 * operator alert is sent. One exhaustion is open for EMAIL_RATE_WINDOW_MS
 * (24 hours) after it starts; inside it, a refusal only retries an alert that is
 * still pending. The caller still throws the same `resource-exhausted`.
 */
async function reserveFailedLoginReport(email: string): Promise<EmailReportDecision> {
  const ref = emailRateLimitRef(email);
  return db().runTransaction(async (tx): Promise<EmailReportDecision> => {
    const nowMs = Date.now();
    const data = (await tx.get(ref)).data() ?? {};
    const timestamps: number[] = Array.isArray(data['timestamps']) ? (data['timestamps'] as number[]) : [];
    const recent = timestamps.filter((t) => t >= nowMs - EMAIL_RATE_WINDOW_MS);
    if (recent.length < EMAIL_RATE_LIMIT) {
      recent.push(nowMs);
      tx.set(
        ref,
        { timestamps: recent, updatedAtMs: nowMs, expiresAt: rateLimitExpiresAt(nowMs, EMAIL_RATE_WINDOW_MS) },
        { merge: true },
      );
      return { allowed: true };
    }
    const exhaustedAt = typeof data['budgetExhaustedAtMs'] === 'number' ? (data['budgetExhaustedAtMs'] as number) : undefined;
    if (exhaustedAt === undefined || exhaustedAt <= nowMs - EMAIL_RATE_WINDOW_MS) {
      tx.set(
        ref,
        {
          budgetExhaustedAtMs: nowMs,
          budgetAlertPendingForMs: nowMs,
          updatedAtMs: nowMs,
          expiresAt: rateLimitExpiresAt(nowMs, EMAIL_RATE_WINDOW_MS),
        },
        { merge: true },
      );
      return { allowed: false, alertExhaustedAtMs: nowMs };
    }
    return {
      allowed: false,
      alertExhaustedAtMs: data['budgetAlertPendingForMs'] === exhaustedAt ? exhaustedAt : null,
    };
  });
}

/**
 * How many proxies Google puts between the internet and a DIRECTLY called
 * function that each append one entry to `X-Forwarded-For`. See `clientIpOf`.
 */
export const TRUSTED_PROXY_HOPS = 1;

type RawRequestLike = { headers?: Record<string, string | string[] | undefined>; ip?: string } | undefined;

/** Why an entry cannot be the address Google appended for a caller on the internet. */
export type UntrustedRangeClass =
  | 'private'
  | 'loopback'
  | 'linkLocal'
  | 'uniqueLocal'
  | 'unspecified'
  | 'googleFrontEnd'
  | 'notAnIp';

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  const bare = ip.split('%')[0]!;
  if (isIP(bare) !== 6) return null;
  let text = bare.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const headParts = head ? head.split(':') : [];
  const restParts = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - headParts.length - restParts.length;
  return [...headParts, ...Array<string>(fill).fill('0'), ...restParts].map((g) => parseInt(g, 16));
}

/**
 * One X-Forwarded-For entry as an address: brackets and a port stripped, and an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) turned into its IPv4 address.
 * Anything that is not an IP comes back trimmed and unchanged.
 */
function normalizeIp(entry: string): string {
  let ip = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  const g = ipv6Groups(ip);
  if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return isIP(ip) === 6 ? ip.toLowerCase() : ip;
}

/**
 * Null for a public address, else why it cannot be the one Google's front end
 * appended for a caller on the internet: RFC 1918 private, loopback,
 * link-local (169.254.0.0/16, fe80::/10), unique-local (fc00::/7), unspecified,
 * a Google front end or health-check range (35.191.0.0/16, 130.211.0.0/22,
 * https://docs.cloud.google.com/load-balancing/docs/health-check-concepts), or
 * not an IP at all.
 */
function untrustedRangeClass(ip: string): UntrustedRangeClass | null {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'linkLocal';
    if (a === 0) return 'unspecified';
    if ((a === 35 && b === 191) || (a === 130 && b === 211 && c <= 3)) return 'googleFrontEnd';
    return null;
  }
  const g = ipv6Groups(ip);
  if (!g) return 'notAnIp';
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'linkLocal';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'uniqueLocal';
  return null;
}

/**
 * #908 review: the string the per-IP limit hashes. IPv4 is the address itself,
 * exactly as before, so stored IPv4 counters keep their meaning. IPv6 is its
 * /64 (`2001:db8:1:2::/64`), because one subscriber is usually handed a whole
 * /64 and could otherwise rotate through 2^64 buckets. An IPv4-mapped IPv6
 * address is its IPv4 address.
 */
export function ipRateLimitKey(ip: string): string {
  const normalized = normalizeIp(ip);
  const g = ipv6Groups(normalized);
  if (!g) return normalized;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * #891: the caller's IP as Google's front end saw it, for rate limiting and audit rows.
 *
 * ONLY VALID FOR A FUNCTION CALLED DIRECTLY (at `cloudfunctions.net` or its
 * `*.run.app` URL), with `trustedHops` left at 1. Behind a Hosting rewrite or a
 * load balancer there are more hops, and the caller must pass that count.
 *
 * WHY NOT THE FIRST `X-Forwarded-For` ENTRY. A caller can send its own
 * `X-Forwarded-For`, and Google keeps what was sent and appends after it. The
 * External Application Load Balancer docs say so directly: "The load balancer
 * appends two IP addresses to the X-Forwarded-For header ... <existing-value>,
 * <client-ip>,<load-balancer-ip>", and it does not verify anything before them
 * (https://docs.cloud.google.com/load-balancing/docs/https, "X-Forwarded-For
 * header"). The first entry is whatever the caller wrote. The #888 review
 * showed it on the emulator: a rotating first entry got 32 of 32 reports
 * through a 30-per-5-minute limit.
 *
 * WHY NOT `rawRequest.ip`. Gen 2 functions run on the Functions Framework,
 * which calls `app.enable('trust proxy')` "To respect X-Forwarded-For header"
 * (GoogleCloudPlatform/functions-framework-nodejs, src/server.ts). With
 * `trust proxy` set to true, Express takes the client address as "the
 * left-most entry in the X-Forwarded-For header" (https://expressjs.com/en/guide/behind-proxies.html).
 * So `rawRequest.ip` is the same forgeable first entry.
 *
 * WHAT IS USED. The entry `TRUSTED_PROXY_HOPS` from the right. These callables
 * are called straight at `cloudfunctions.net` (the SDKs and the desktop REST
 * client; no Hosting rewrite points at them), where Google's front end appends
 * one entry, the connecting client's address, after anything the caller sent.
 * No Google page states that single append for Cloud Run ingress in so many
 * words; it is the load balancer's documented behaviour minus the load
 * balancer's own address, and it is what the operator can confirm after a
 * release: send one report with a forged `X-Forwarded-For: 1.2.3.4` and read
 * the `ip` on its `AUTH_LOGIN_FAIL` audit row, which must be the real address.
 *
 * IF A LOAD BALANCER OR HOSTING REWRITE IS EVER PUT IN FRONT, the hop count must
 * become 2: the rightmost entry would be the balancer's own address, and every
 * caller would share one 30-per-5-minute bucket.
 *
 * FAILS SAFE WHEN THE HOP COUNT IS WRONG (#908 review). Gen 2 callables answer on
 * both `cloudfunctions.net` and `*.run.app`, and nothing proves those two add
 * the same number of entries. If the chosen entry is private, loopback,
 * link-local, unique-local, unspecified, a Google front end range or not an IP
 * (`untrustedRangeClass`), it cannot be a caller on the internet, so this logs
 * `clientIp.untrustedRightmost` at error (the range class, never the address)
 * and steps one entry left, repeating while entries remain. When none remains it
 * keeps the entry it has. Zero entries log `clientIp.noForwardedFor` at error
 * and fall back to `rawRequest.ip`, which is then the socket address, and then
 * to 'unknown'. Production always carries the header; the emulator does not.
 *
 * An IPv4-mapped IPv6 entry comes back as its IPv4 address.
 */
export function clientIpOf(rawRequest: RawRequestLike, trustedHops: number = TRUSTED_PROXY_HOPS): string {
  const header = rawRequest?.headers?.['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header ?? '';
  const entries = joined
    .split(',')
    .map((e) => normalizeIp(e))
    .filter((e) => e !== '');
  const hops = Number.isInteger(trustedHops) && trustedHops >= 1 ? trustedHops : TRUSTED_PROXY_HOPS;
  if (entries.length === 0) {
    logEvent({
      severity: 'error',
      function: 'clientIpOf',
      event: 'clientIp.noForwardedFor',
      extra: { trustedHops: hops, hasSocketIp: typeof rawRequest?.ip === 'string' && rawRequest.ip.trim() !== '' },
    });
    const socketIp = typeof rawRequest?.ip === 'string' ? normalizeIp(rawRequest.ip) : '';
    return socketIp || 'unknown';
  }
  let index = Math.max(0, entries.length - hops);
  for (;;) {
    const rangeClass = untrustedRangeClass(entries[index]!);
    if (rangeClass === null) break;
    logEvent({
      severity: 'error',
      function: 'clientIpOf',
      event: 'clientIp.untrustedRightmost',
      extra: { rangeClass, entryCount: entries.length, position: entries.length - index, trustedHops: hops },
    });
    if (index === 0) break;
    index -= 1;
  }
  return entries[index]!;
}

/**
 * The shared per-IP limit (30 per 5 minutes) for the unauthenticated auth
 * callables. Keyed on `clientIpOf` (#891), hashed through `ipRateLimitKey`
 * (#908), and returns the address so the caller stores it on its audit row.
 * `trustedHops` as for `clientIpOf`: leave it at 1 for a directly called function.
 */
export async function checkIpRateLimit(
  rawRequest: RawRequestLike,
  trustedHops: number = TRUSTED_PROXY_HOPS,
): Promise<string> {
  const rawIp = clientIpOf(rawRequest, trustedHops);
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
    tx.set(
      ref,
      { timestamps: recent, updatedAtMs: nowMs, expiresAt: rateLimitExpiresAt(nowMs, IP_RATE_WINDOW_MS) },
      { merge: true },
    );
  });
  return rawIp;
}

interface LoginAttempt {
  ts: number;
  ip?: string;
  userAgent?: string;
}

interface LoginSecurityDoc {
  attempts: LoginAttempt[];
  /**
   * When the current warning burst started. Written in the counting
   * transaction that crossed the threshold, BEFORE the warning is sent (#877),
   * so it is the burst's identity rather than a delivery receipt.
   */
  warnSentAtMs?: number;
  /**
   * Set to `warnSentAtMs` in the same transaction, and deleted once both
   * warning copies have been accepted. While it equals the stored
   * `warnSentAtMs` and the burst is under 10 minutes old, a later failed login
   * re-sends that burst's warnings (#877). A warning stamped before this field
   * existed never matches, so it is never re-sent.
   */
  warnAlertsPendingForMs?: number;
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

/**
 * #886 review: `ip` and `userAgent` are optional and no client sends them, but
 * when sent they are stored on every attempt entry. Capped so nine oversized
 * reports cannot push `clients/{uid}/security/loginAttempts` toward the 1 MiB
 * document limit.
 */
const CALLER_FIELD_MAX = 256;

export const RecordFailedLoginArgs = z.object({
  email: z.string().email(),
  ip: z.string().max(CALLER_FIELD_MAX).optional(),
  userAgent: z.string().max(CALLER_FIELD_MAX).optional(),
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
    warnAlertsPendingForMs:
      typeof data?.warnAlertsPendingForMs === 'number' ? data.warnAlertsPendingForMs : undefined,
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

/**
 * #891: when the account's current lock started, or null when it is not locked.
 *
 * `requestPasswordReset` reads this to exempt a locked account from its daily
 * cap, so the lock start names the lock window that gets its own cap. A lock
 * saved without `lockStartedAtMs` is dated from its end. Any read failure
 * answers null, which only means the ordinary cap applies.
 */
export async function activeLockStartedAtMs(uid: string, nowMs: number = Date.now()): Promise<number | null> {
  try {
    const doc = await readSecurityDoc(uid);
    if (typeof doc.lockedUntilMs !== 'number' || doc.lockedUntilMs <= nowMs) return null;
    return typeof doc.lockStartedAtMs === 'number' ? doc.lockStartedAtMs : doc.lockedUntilMs - LOCKOUT_DURATION_MS;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'requestPasswordReset',
      event: 'reset.lock.read.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
    return null;
  }
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
 * The #832 dedupe identity of one warning burst's copies (#877): the household
 * account and the moment its burst started, read from the saved burst rather
 * than the current call. Shaped like `lockAlertDedupeKey`.
 */
export function failedLoginWarningDedupeKey(kinfolkUid: string, warnStartedAtMs: number): string {
  return `auth.warn:${kinfolkUid}:${warnStartedAtMs}`;
}

/**
 * What an operator alert (the lock alert, #869, and the warning, #877) says
 * about the household.
 *
 * `kinfolkName` is always sent, so a subject can never render as
 * "Account locked:  (email)". It is the first non-empty of: the household's
 * name (`families/{kinfolkId}`, only when the account holds exactly ONE
 * household), the account's own name, the email's local part.
 *
 * `kinfolkId` is sent only for exactly one household, which also gives the card
 * its deep link. Kinfolk with two or more tribes are a defect state (only admins
 * hold several), and naming one of them would be a guess. Never throws: a failed
 * read still sends the alert with the email and the local-part name.
 */
async function operatorHouseholdData(
  uid: string,
  email: string,
  lookupFailedEvent: string,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { kinfolkUid: uid, kinfolkEmail: email };
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
      event: lookupFailedEvent,
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
  data['kinfolkName'] = name || email.split('@')[0] || email;
  return data;
}

/**
 * Deletes a pending-alert marker, but only while it still names `startedAtMs`.
 *
 * Between the burst or lock being saved and this call, a newer burst or lock
 * can replace the marker with its own, and deleting that one would silently
 * cancel the newer retry. Harmless if it fails: the next retry is deduped by
 * the ledger.
 */
async function clearPendingAlertMarker(
  uid: string,
  field: 'lockAlertsPendingForMs' | 'warnAlertsPendingForMs',
  startedAtMs: number,
  failedEvent: string,
): Promise<void> {
  const ref = securityDocRef(uid);
  await db()
    .runTransaction(async (tx) => {
      const stored = parseSecurityDoc((await tx.get(ref)).data());
      if (stored[field] !== startedAtMs) return;
      tx.set(ref, { [field]: FieldValue.delete() }, { merge: true });
    })
    .catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'recordFailedLogin',
        event: failedEvent,
        uid,
        errorMessage: (err as Error)?.message,
      });
    });
}

/**
 * Sends both copies of one saved warning burst (#877), then clears its marker.
 *
 * Both copies are caught, and either failure leaves the marker so the next
 * failed login in the burst retries. The household copy is caught (#877
 * review) because `recordFailedLogin` is unauthenticated: an error thrown only
 * for a real account's warning would tell the caller the email exists. Its
 * failure is logged at error. The operator copy is caught so a resolver
 * failure never fails the call. Both carry the burst's dedupe key with a window
 * as long as the burst, so a retry after a partial success sends only the copy
 * that is still missing. A retry sends the current `attemptsInWindow`, which
 * may be higher than when the burst started.
 */
async function sendWarningAlerts(
  uid: string,
  email: string,
  warnStartedAtMs: number,
  attemptsInWindow: number,
): Promise<void> {
  const dedupeKey = failedLoginWarningDedupeKey(uid, warnStartedAtMs);
  let householdAccepted = true;
  await enqueueNotification({
    key: 'auth.failedLogin.attempts',
    recipientUid: uid,
    data: { email, attemptsInWindow },
    dedupeKey,
    dedupeWindowMs: WINDOW_WARN_MS,
  }).catch((err) => {
    householdAccepted = false;
    logEvent({
      severity: 'error',
      function: 'recordFailedLogin',
      event: 'auth.warn.notify.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  let operatorAccepted = true;
  await enqueueNotification({
    key: 'security.failedLogin.attempts.operator',
    data: {
      ...(await operatorHouseholdData(uid, email, 'admin.warn.household.lookup.failed')),
      attemptsInWindow,
      warnStartedAtMs,
    },
    dedupeKey,
    dedupeWindowMs: WINDOW_WARN_MS,
  }).catch((err) => {
    operatorAccepted = false;
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'admin.warn.notify.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  if (!householdAccepted || !operatorAccepted) return;

  await clearPendingAlertMarker(uid, 'warnAlertsPendingForMs', warnStartedAtMs, 'admin.warn.pending.clear.failed');
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
    data: {
      ...(await operatorHouseholdData(uid, email, 'admin.lock.household.lookup.failed')),
      lockStartedAtMs,
    },
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

  // Cleared only while the stored marker still names THIS lock: an admin unlock
  // or a password reset followed by a fresh lock can replace it in between.
  await clearPendingAlertMarker(uid, 'lockAlertsPendingForMs', lockStartedAtMs, 'admin.lock.pending.clear.failed');
}

/**
 * Deletes `field` on `ref`, but only while it still names `startedAtMs`, so a
 * newer exhaustion or spike that replaced the marker keeps its retry. The
 * `clearPendingAlertMarker` rule, for the #891 signal docs.
 */
async function clearSignalMarker(
  ref: FirebaseFirestore.DocumentReference,
  field: 'budgetAlertPendingForMs' | 'spikeAlertPendingForMs',
  startedAtMs: number,
  failedEvent: string,
): Promise<void> {
  await db()
    .runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.[field] !== startedAtMs) return;
      tx.set(ref, { [field]: FieldValue.delete() }, { merge: true });
    })
    .catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'recordFailedLogin',
        event: failedEvent,
        errorMessage: (err as Error)?.message,
      });
    });
}

/**
 * The #832 dedupe identity of one report-budget alert (#891): the account and
 * the moment its budget was found spent, read from the saved exhaustion. One
 * per account per 24 hours, since a new exhaustion can only start after the
 * previous one's 24 hours.
 */
export function reportBudgetAlertDedupeKey(kinfolkUid: string, budgetExhaustedAtMs: number): string {
  return `auth.budget:${kinfolkUid}:${budgetExhaustedAtMs}`;
}

/**
 * #891: tells the operator that an account's failed-login reports stopped
 * counting.
 *
 * Fifteen slow reports (under 5 in 10 minutes) spend an email's daily budget
 * without warning anyone, and every later report, the owner's real failures
 * included, is refused for 24 hours: no warning, no lock. So the refusal itself
 * is the signal. Sent for real accounts only. An address that is not an account
 * has nobody to protect, and alerting on it would let anyone flood the operator
 * with one alert per made-up address. Both kinds still do the same account
 * lookup here, and both get the same refusal afterwards.
 *
 * Never throws: the caller's answer is the refusal, whatever happens here.
 */
async function sendReportBudgetAlert(email: string, budgetExhaustedAtMs: number | null): Promise<void> {
  try {
    const uid = await uidForEmail(email);
    if (!uid || budgetExhaustedAtMs === null) return;
    await enqueueNotification({
      key: 'security.failedLogin.budgetExhausted.operator',
      data: {
        ...(await operatorHouseholdData(uid, email, 'admin.budget.household.lookup.failed')),
        reportLimit: EMAIL_RATE_LIMIT,
        budgetExhaustedAtMs,
      },
      dedupeKey: reportBudgetAlertDedupeKey(uid, budgetExhaustedAtMs),
      dedupeWindowMs: EMAIL_RATE_WINDOW_MS,
    });
    await clearSignalMarker(
      emailRateLimitRef(email),
      'budgetAlertPendingForMs',
      budgetExhaustedAtMs,
      'admin.budget.pending.clear.failed',
    );
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'admin.budget.notify.failed',
      errorMessage: (err as Error)?.message,
    });
  }
}

/**
 * #891 operator decision: a lock spike is LOCK_SPIKE_ACCOUNTS distinct accounts
 * locking inside LOCK_SPIKE_WINDOW_MS.
 *
 * Tribe Tails has about 13 households. A lock takes 10 failed sign-ins in 20
 * minutes, and one household locking itself is rare; two in half an hour can
 * still be coincidence. Three distinct accounts in 30 minutes (the length of a
 * lock) is roughly a quarter of the households and is not a normal day. Every
 * lock still sends its own alert; this is one extra alert per spike.
 */
export const LOCK_SPIKE_ACCOUNTS = 3;
export const LOCK_SPIKE_WINDOW_MS = 30 * 60 * 1000;

function lockSpikeRef() {
  return db().collection('securitySignals').doc('lockSpike');
}

/** The #832 dedupe identity of one spike's alert (#891): the moment the spike was saved. */
export function lockSpikeAlertDedupeKey(spikeStartedAtMs: number): string {
  return `auth.lockSpike:${spikeStartedAtMs}`;
}

interface SpikeLock {
  uid: string;
  ts: number;
}

/**
 * #891: records one lock on `securitySignals/lockSpike` and alerts the operator
 * once per spike.
 *
 * The doc keeps the locks of the last LOCK_SPIKE_WINDOW_MS. The lock that
 * brings the distinct accounts to LOCK_SPIKE_ACCOUNTS, with no spike open,
 * saves `spikeStartedAtMs` and a pending marker in the same transaction, before
 * the alert is sent. A spike is open for the window after it starts; a later
 * lock inside it retries the alert only while its marker is pending. The doc is
 * server-only: no rule matches `securitySignals`, so clients are denied.
 *
 * Never throws: a lock must hold, and its own alerts must go out, whatever
 * happens here.
 */
async function recordLockForSpike(uid: string, lockStartedAtMs: number): Promise<void> {
  const ref = lockSpikeRef();
  try {
    const decision = await db().runTransaction(async (tx): Promise<{ startedAtMs: number; accounts: number } | null> => {
      const nowMs = Date.now();
      const data = (await tx.get(ref)).data() ?? {};
      const prior: SpikeLock[] = Array.isArray(data['locks'])
        ? (data['locks'] as unknown[]).filter(
            (l): l is SpikeLock =>
              !!l && typeof (l as SpikeLock).uid === 'string' && typeof (l as SpikeLock).ts === 'number',
          )
        : [];
      const locks = [...prior.filter((l) => !(l.uid === uid && l.ts === lockStartedAtMs)), { uid, ts: lockStartedAtMs }]
        .filter((l) => l.ts > nowMs - LOCK_SPIKE_WINDOW_MS)
        .map((l) => ({ uid: l.uid, ts: l.ts }));
      const accounts = new Set(locks.map((l) => l.uid)).size;
      const startedAt = typeof data['spikeStartedAtMs'] === 'number' ? (data['spikeStartedAtMs'] as number) : undefined;
      const open = startedAt !== undefined && startedAt > nowMs - LOCK_SPIKE_WINDOW_MS;

      if (accounts >= LOCK_SPIKE_ACCOUNTS && !open) {
        tx.set(ref, { locks, spikeStartedAtMs: nowMs, spikeAlertPendingForMs: nowMs, updatedAtMs: nowMs }, { merge: true });
        return { startedAtMs: nowMs, accounts };
      }
      tx.set(ref, { locks, updatedAtMs: nowMs }, { merge: true });
      return open && data['spikeAlertPendingForMs'] === startedAt ? { startedAtMs: startedAt, accounts } : null;
    });
    if (!decision) return;

    await enqueueNotification({
      key: 'security.account.locked.spike.operator',
      data: {
        lockedAccounts: decision.accounts,
        windowMinutes: LOCK_SPIKE_WINDOW_MS / 60_000,
        spikeStartedAtMs: decision.startedAtMs,
      },
      dedupeKey: lockSpikeAlertDedupeKey(decision.startedAtMs),
      dedupeWindowMs: LOCK_SPIKE_WINDOW_MS,
    });
    await clearSignalMarker(ref, 'spikeAlertPendingForMs', decision.startedAtMs, 'admin.lockSpike.pending.clear.failed');
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordFailedLogin',
      event: 'admin.lockSpike.notify.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
}

type LockDecision =
  | { kind: 'alreadyLocked'; lockedUntilMs: number; pendingLockStartedAtMs: number | null }
  | { kind: 'lockedNow'; lockedUntilMs: number; lockStartedAtMs: number }
  | {
      kind: 'counted';
      countLock: number;
      countWarn: number;
      /** The saved burst whose warnings to send now (new or pending), else null. */
      warnStartedAtMs: number | null;
    };

export async function recordFailedLoginHandler(
  req: CallableRequest<unknown>,
): Promise<RecordFailedLoginResponse> {
  // #886 review: the IP limit runs BEFORE the request is parsed, so malformed
  // requests spend the same per-IP budget as well-formed ones. And a bad request
  // is `invalid-argument`, not a thrown ZodError: `wrapCallable` turns anything
  // that is not an HttpsError into `internal`, captures it to Sentry and writes an
  // audit failure row, so an unauthenticated caller could mint unlimited Sentry
  // events. Same order and code as `requestPasswordReset`.
  // #891: the server-side IP is the entry Google appended (`clientIpOf`), never
  // the caller's first `X-Forwarded-For` entry or the client-supplied `args.ip`.
  const remoteIp = await checkIpRateLimit(req.rawRequest);
  const parsed = RecordFailedLoginArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'email (valid email address) is required');
  }
  const args = parsed.data;
  // Per-target rate limit. Even if the attacker rotates IPs, a single target
  // email can only be reported EMAIL_RATE_LIMIT times per window. #891: a
  // refusal alerts the operator once per exhaustion, then answers exactly as
  // before.
  const budget = await reserveFailedLoginReport(args.email);
  if (!budget.allowed) {
    await sendReportBudgetAlert(args.email, budget.alertExhaustedAtMs);
    throw new HttpsError('resource-exhausted', EMAIL_RATE_LIMIT_MESSAGE);
  }

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
    // #886 review: an address that is not an account is typed by a stranger and
    // may be someone else's; it is stored hashed, as `requestPasswordReset` does,
    // still stable per address for spotting credential stuffing.
    description: 'Failed login (no matching account)',
    payload: { emailHash: hashEmail(email), ip: remoteIp, reason: 'no-such-user' },
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
    // #908 review: kept a day for the operator's credential-stuffing view, then TTL.
    tx.set(
      ref,
      { attempts, updatedAtMs: nowMs, expiresAt: rateLimitExpiresAt(nowMs, EMAIL_RATE_WINDOW_MS) },
      { merge: true },
    );
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

    // #877: a burst is open for WINDOW_WARN_MS after it starts. Crossing the
    // threshold with no open burst starts one, saved here with its pending
    // marker before either warning is sent. Inside an open burst whose marker is
    // still pending, the warnings are re-sent for THAT burst. The retry stops
    // when the burst closes, because the dedupe window is the burst's length
    // and a later send could double the household's copy.
    const burstOpen = current.warnSentAtMs !== undefined && current.warnSentAtMs > nowMs - WINDOW_WARN_MS;
    let warnStartedAtMs: number | null = null;
    if (countWarn >= THRESHOLD_WARN && !burstOpen) {
      warnStartedAtMs = nowMs;
      tx.set(
        ref,
        { attempts: nextAttempts, warnSentAtMs: nowMs, warnAlertsPendingForMs: nowMs, updatedAtMs: nowMs },
        { merge: true },
      );
    } else {
      if (burstOpen && current.warnAlertsPendingForMs === current.warnSentAtMs) {
        warnStartedAtMs = current.warnSentAtMs!;
      }
      tx.set(ref, { attempts: nextAttempts, updatedAtMs: nowMs }, { merge: true });
    }
    return { kind: 'counted', countLock, countWarn, warnStartedAtMs };
  });

  switch (decision.kind) {
    case 'alreadyLocked': {
      if (decision.pendingLockStartedAtMs !== null) {
        await sendLockAlerts(uid, args.email, decision.pendingLockStartedAtMs);
      }
      return;
    }
    case 'lockedNow': {
      try {
        await sendLockAlerts(uid, args.email, decision.lockStartedAtMs);
      } finally {
        // #891: counted even when this lock's own household alert failed.
        await recordLockForSpike(uid, decision.lockStartedAtMs);
      }
      return;
    }
    case 'counted': {
      if (decision.warnStartedAtMs !== null) {
        await sendWarningAlerts(uid, args.email, decision.warnStartedAtMs, decision.countWarn);
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
          warnAlertsPendingForMs: FieldValue.delete(),
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
        // #877: no burst is left whose warnings could be pending.
        warnAlertsPendingForMs: FieldValue.delete(),
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
