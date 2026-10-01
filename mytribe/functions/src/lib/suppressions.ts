import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { normalizeE164 } from './phoneNormalize';

/**
 * `message_suppressions/{encodeURIComponent(normalizedRecipient)}`: the one
 * list every outbound send consults before mailing or texting someone.
 *
 * Two things put a recipient on it:
 *
 *   - an OPT-OUT (`suppressExternalRecipient`, admin-driven). These docs carry
 *     no `reason` field. They silence marketing-class sends (one-off external
 *     messages, broadcasts) and nothing else: a household that opted out of a
 *     one-off message still gets its invoices, which notification preferences
 *     govern.
 *   - a HARD BOUNCE (#1077, the smtp2go event webhook). `reason: 'hard_bounce'`
 *     plus a `hardBounce` block. The address does not exist, so mailing it again
 *     only bounces again and costs sender reputation. Every email path honours
 *     it, except a send the person explicitly asked for (a password reset, the
 *     invite verification mail from the claim screen): refusing those would lock
 *     the person out with no way back.
 *
 * When an opt-out doc already exists and the address then hard-bounces, the
 * hard-bounce block is merged in and `reason` is left as it was, so a check for
 * "hard-bounced" must look at the block too (`isHardBounced`).
 *
 * Writes are Admin SDK only. `mytribe/firestore.rules` has no
 * `message_suppressions` match, so clients get default-deny.
 *
 * Kept out of `lib/email.ts` on purpose (#1076 is changing `sendTemplatedEmail`
 * in parallel). The hard-bounce check could move into `sendTemplatedEmail` as
 * the single choke point once that lands, with an opt-out for person-requested
 * sends.
 */
export const SUPPRESSIONS = 'message_suppressions';

export const HARD_BOUNCE_REASON = 'hard_bounce';

/**
 * The refusal message for a hard-bounced address. Starts with the stable code
 * the clients match on; the rest is read verbatim by an operator when a client
 * has no mapping for it yet.
 */
export const RECIPIENT_HARD_BOUNCED =
  'recipient_hard_bounced: this address hard-bounced and is suppressed, so nothing was sent';

/**
 * Canonical id / suppression key for a recipient. Email lowercased+trimmed;
 * phone normalized to E.164. Used both as the suppression doc id and the
 * external_messages target. Throws (caller maps to invalid-argument) if a phone
 * cannot be normalized; that should not happen post-validation but we stay
 * fail-loud rather than writing a malformed key.
 */
export function normalizeRecipient(channel: 'email' | 'sms', to: string): string {
  const trimmed = to.trim();
  if (channel === 'email') return trimmed.toLowerCase();
  const e164 = normalizeE164(trimmed);
  if (!e164) throw new Error(`sendExternalMessage: could not normalize phone '${trimmed}'`);
  return e164;
}

/**
 * Firestore doc ids cannot contain '/'. Recipient keys (email/E.164) never
 * contain '/', but encode defensively so an unexpected value cannot escape the
 * collection path.
 */
export function suppressionDocId(normalized: string): string {
  return encodeURIComponent(normalized);
}

/**
 * Mask a recipient for audit storage. Email: keep first char of local-part +
 * full domain (`j***@example.com`). Phone: keep country/last-4, mask middle
 * (`+1******7890`). Never store the plaintext contact in activity_log.
 */
export function redactRecipient(channel: 'email' | 'sms', normalized: string): string {
  if (channel === 'email') {
    const at = normalized.indexOf('@');
    if (at <= 0) return '***';
    const local = normalized.slice(0, at);
    const domain = normalized.slice(at); // includes '@'
    const head = local.slice(0, 1);
    return `${head}***${domain}`;
  }
  // phone (E.164): + then digits
  const plus = normalized.startsWith('+') ? '+' : '';
  const digits = normalized.replace(/[^\d]/g, '');
  if (digits.length <= 4) return `${plus}${'*'.repeat(digits.length)}`;
  const cc = digits.slice(0, 1);
  const last4 = digits.slice(-4);
  const masked = '*'.repeat(Math.max(0, digits.length - 5));
  return `${plus}${cc}${masked}${last4}`;
}

/** True when a suppression doc records a hard bounce (its own reason, or merged onto an opt-out). */
export function isHardBounced(data: Record<string, unknown> | undefined | null): boolean {
  if (!data) return false;
  if (data.reason === HARD_BOUNCE_REASON) return true;
  const block = data.hardBounce;
  return block !== null && typeof block === 'object';
}

/** True when the email address carries a hard-bounce suppression. Blank input is never suppressed. */
export async function isEmailHardBounced(email: string): Promise<boolean> {
  const normalized = normalizeRecipient('email', email);
  if (!normalized) return false;
  const snap = await db().doc(`${SUPPRESSIONS}/${suppressionDocId(normalized)}`).get();
  return snap.exists && isHardBounced(snap.data());
}

/**
 * Throws failed-precondition `recipient_hard_bounced` when the address is
 * suppressed as a hard bounce. For the paths that must refuse loudly (an admin
 * action the operator should hear about) rather than skip.
 */
export async function assertNotHardBounced(email: string): Promise<void> {
  if (await isEmailHardBounced(email)) {
    throw new HttpsError('failed-precondition', RECIPIENT_HARD_BOUNCED);
  }
}

export interface HardBounceEvent {
  /** smtp2go `rcpt`: the address the email was sent to. */
  rcpt: string;
  /** smtp2go `id`: the webhook event id. */
  eventId: string | null;
  /** smtp2go `email_id`: the send's id. */
  emailId: string | null;
  /** smtp2go `time`: when the event happened (UTC, as sent). */
  eventTime: string | null;
  /** smtp2go `host`: the server that bounced it. */
  host: string | null;
}

export type HardBounceOutcome = 'created' | 'merged' | 'already-suppressed' | 'invalid';

/**
 * Records a hard bounce. Idempotent: the first hard bounce for an address is
 * the one kept. A replayed webhook event, or a later bounce of a different
 * send, finds the hard-bounce record already there and writes nothing.
 *
 *   - no doc            -> create it with reason `hard_bounce`
 *   - opt-out doc       -> merge ONLY the `hardBounce` block (reason, actor and
 *                          suppressedAtMs of the opt-out stay as they were)
 *   - hard-bounced doc  -> no-op
 */
export async function recordHardBounce(ev: HardBounceEvent): Promise<HardBounceOutcome> {
  const normalized = normalizeRecipient('email', ev.rcpt ?? '');
  if (!normalized || !normalized.includes('@')) return 'invalid';
  const ref = db().doc(`${SUPPRESSIONS}/${suppressionDocId(normalized)}`);
  const now = Date.now();
  const hardBounce = {
    eventId: ev.eventId,
    emailId: ev.emailId,
    eventTime: ev.eventTime,
    host: ev.host,
    recordedAtMs: now,
  };
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.create(ref, {
        channel: 'email',
        reason: HARD_BOUNCE_REASON,
        source: 'smtp2go',
        recipientRedacted: redactRecipient('email', normalized),
        suppressedAtMs: now,
        createdAt: FieldValue.serverTimestamp(),
        hardBounce,
      });
      return 'created';
    }
    if (isHardBounced(snap.data())) return 'already-suppressed';
    tx.set(ref, { hardBounce }, { merge: true });
    return 'merged';
  });
}
