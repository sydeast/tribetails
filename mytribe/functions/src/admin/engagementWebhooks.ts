import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import {
  s2gProviderIdFromEvent,
  s2gEventToCounter,
  twilioStatusToCounter,
  s2gEventDedupeId,
  type EngagementCounter,
} from '../lib/engagement';
import { FULL_CPU } from '../lib/runtimeOptions';

/**
 * Engagement webhooks for the Communicate "Recent" panel.
 *
 * Outbound 1:1 sends are recorded in `external_messages` with a providerMessageId
 * (smtp2go email_id / Twilio MessageSid) + a zeroed `counts` map. These two
 * provider webhooks match the event back to that doc and bump a counter, deduped
 * by event id so provider retries cannot double-count. Mirrors the stripeWebhook
 * shape (onRequest + wrapHttp + signature verify + idempotent ledger).
 *
 * ACTIVATION (named operator/external config; the receivers are fully built):
 *   - smtp2go: create a webhook (app or webhook/add API) pointing at
 *     smtp2goEventWebhook's URL with events delivered/open/click/bounce/spam/reject,
 *     JSON encoding, and a custom secret header. Store the shared secret at
 *     `integrations_config/email`.webhookSecret (header name overridable via
 *     `webhookSecretHeader`, default 'x-webhook-secret'). Until the secret is
 *     configured the receiver FAILS CLOSED: every request is rejected 403 and a
 *     critical `s2g.verify.unconfigured` log is emitted (WARNING-24/38) so forged
 *     events cannot be accepted pre-activation.
 *   - Twilio: set TWILIO_STATUS_CALLBACK_URL (env) to twilioStatusCallback's URL so
 *     sends carry a statusCallback. Verification uses the existing TWILIO_AUTH_TOKEN.
 */

const SENDS = 'external_messages';
const EVENT_LEDGER = 'message_events';

/**
 * NOTE-58: hard caps for the public smtp2go receiver. The handler loops the
 * posted events array unbounded; without caps a forged-but-authenticated or
 * misconfigured upstream could POST a huge body / array and tie up the matcher
 * (one Firestore query + transaction per event). Reject oversized input 4xx.
 */
const MAX_BODY_BYTES = 1_000_000; // 1MB
const MAX_EVENTS_PER_REQUEST = 100;

/**
 * Increment one counter on the external_messages doc matched by providerMessageId,
 * deduped on eventKey. Returns true when applied, false on replay / no match.
 */
async function applyEngagement(
  providerMessageId: string,
  counter: EngagementCounter,
  eventKey: string,
  meta: Record<string, unknown>,
): Promise<boolean> {
  if (!providerMessageId || !counter || !eventKey) return false;
  const dedupeRef = db().doc(`${EVENT_LEDGER}/${encodeURIComponent(eventKey)}`);
  const matchSnap = await db()
    .collection(SENDS)
    .where('providerMessageId', '==', providerMessageId)
    .limit(1)
    .get();
  if (matchSnap.empty) {
    // No matching send (event for a non-external send, or arrived before the ledger
    // doc). Record nothing fabricated; log for observability and move on.
    logEvent({
      severity: 'info',
      function: 'engagementWebhook',
      event: 'engagement.unmatched',
      extra: { providerMessageId, counter, ...meta },
    });
    return false;
  }
  const sendRef = matchSnap.docs[0].ref;
  return db().runTransaction(async (tx) => {
    const dedupeSnap = await tx.get(dedupeRef);
    if (dedupeSnap.exists) return false; // replay
    tx.create(dedupeRef, {
      sendId: sendRef.id,
      counter,
      receivedAt: FieldValue.serverTimestamp(),
      ...meta,
    });
    tx.update(sendRef, {
      [`counts.${counter}`]: FieldValue.increment(1),
      lastEvent: counter,
      lastEventAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/**
 * Verify a smtp2go event webhook via its custom secret header. smtp2go webhooks
 * do not sign payloads; instead the webhook is configured to send a custom header
 * carrying a shared secret. Secret lives at integrations_config/email.webhookSecret
 * (env SMTP2GO_WEBHOOK_SECRET overrides); the header name defaults to
 * 'x-webhook-secret' and is overridable via the same doc's webhookSecretHeader.
 *
 * WARNING-24/38: this used to FAIL OPEN — it returned ok:true ('disabled') when
 * no secret was configured AND swallowed any Firestore read error before falling
 * through to that same accept path. An attacker could therefore POST forged
 * engagement events (or DoS the matcher) whenever the secret was unset or the
 * config read transiently failed. It now FAILS CLOSED, mirroring twilioVerify:
 * no secret -> reject; config read error -> reject; both emit a critical log so
 * the operator sees that real events are being dropped until activation.
 */
async function s2gVerify(req: Request): Promise<{ ok: boolean; reason: string }> {
  let secret = (process.env.SMTP2GO_WEBHOOK_SECRET ?? '').trim();
  let headerName = 'x-webhook-secret';
  if (!secret) {
    try {
      const cfg = await db().doc('integrations_config/email').get();
      secret = ((cfg.data()?.webhookSecret as string) ?? '').trim();
      headerName = ((cfg.data()?.webhookSecretHeader as string) ?? '').trim() || headerName;
    } catch (err) {
      // Config unreadable -> we cannot prove the secret, so we cannot trust the
      // request. Fail closed (do NOT fall through to an accept).
      logEvent({
        severity: 'error',
        function: 'smtp2goEventWebhook',
        event: 's2g.verify.config-error',
        extra: { reason: 'config-read-failed', err: (err as Error)?.message },
      });
      return { ok: false, reason: 'config-read-error' };
    }
  }
  if (!secret) {
    // No shared secret configured anywhere -> cannot verify -> reject. The
    // operator must set integrations_config/email.webhookSecret (or the env) to
    // activate the receiver. Logged loud so dropped events are visible.
    logEvent({
      severity: 'error',
      function: 'smtp2goEventWebhook',
      event: 's2g.verify.unconfigured',
      extra: { reason: 'no-secret-configured' },
    });
    return { ok: false, reason: 'unconfigured' };
  }
  const presented = (req.header(headerName) ?? '').trim();
  if (!presented) return { ok: false, reason: 'missing-secret' };
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return { ok, reason: ok ? 'verified' : 'bad-secret' };
}

export async function smtp2goEventWebhookHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const v = await s2gVerify(req);
  if (!v.ok) {
    logEvent({ severity: 'warn', function: 'smtp2goEventWebhook', event: 's2g.verify.fail', extra: { reason: v.reason } });
    res.status(403).json({ error: 'bad-secret' });
    return;
  }
  // NOTE-58: reject an oversized body before parsing/looping it (413).
  const bodyBytes = req.rawBody?.length ?? 0;
  if (bodyBytes > MAX_BODY_BYTES) {
    logEvent({
      severity: 'warn',
      function: 'smtp2goEventWebhook',
      event: 's2g.reject.oversized-body',
      extra: { bodyBytes, max: MAX_BODY_BYTES },
    });
    res.status(413).json({ error: 'payload-too-large' });
    return;
  }
  // smtp2go POSTs one JSON event object per request (configure the webhook for
  // JSON encoding, not form). Tolerate an array anyway so a batching change
  // upstream cannot silently drop events.
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'bad-json' });
    return;
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
  // NOTE-58: reject an over-cap events array (413) rather than looping it.
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    logEvent({
      severity: 'warn',
      function: 'smtp2goEventWebhook',
      event: 's2g.reject.too-many-events',
      extra: { count: events.length, max: MAX_EVENTS_PER_REQUEST },
    });
    res.status(413).json({ error: 'too-many-events' });
    return;
  }
  let applied = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const counter = s2gEventToCounter(ev.event as string | undefined);
    const providerId = s2gProviderIdFromEvent(ev.email_id as string | undefined);
    const dedupe = s2gEventDedupeId(ev as { id?: string; email_id?: string; event?: string });
    if (!counter || !providerId || !dedupe) continue;
    try {
      if (await applyEngagement(providerId, counter, `s2g:${dedupe}`, { provider: 'smtp2go', event: ev.event })) {
        applied++;
      }
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'smtp2goEventWebhook',
        event: 's2g.apply.fail',
        extra: { err: (err as Error)?.message },
      });
    }
  }
  logEvent({
    severity: 'info',
    function: 'smtp2goEventWebhook',
    event: 's2g.batch',
    extra: { received: events.length, applied, verify: v.reason },
  });
  res.status(200).json({ ok: true, applied });
}

async function twilioVerify(req: Request): Promise<boolean> {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false; // fail closed: cannot verify without the auth token
  const sig = req.header('X-Twilio-Signature') ?? '';
  // Twilio signs the exact URL it POSTs to. Prefer the configured callback URL to
  // avoid proxy host drift behind Cloud Functions; fall back to the observed URL.
  const url = process.env.TWILIO_STATUS_CALLBACK_URL || `https://${req.hostname}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  try {
    // Loaded here, not at file scope: see twilio/twilioInbound.ts. The
    // fail-closed token check above still runs before anything is loaded.
    const { default: twilio } = await import('twilio');
    return twilio.validateRequest(token, sig, url, params);
  } catch {
    return false;
  }
}

export async function twilioStatusCallbackHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!(await twilioVerify(req))) {
    logEvent({ severity: 'warn', function: 'twilioStatusCallback', event: 'twilio.verify.fail' });
    res.status(403).json({ error: 'bad-signature' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, string>;
  const sid = (body.MessageSid || body.SmsSid || '').trim();
  const counter = twilioStatusToCounter(body.MessageStatus || body.SmsStatus);
  if (sid && counter) {
    try {
      await applyEngagement(sid, counter, `tw:${sid}:${counter}`, { provider: 'twilio', status: body.MessageStatus });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'twilioStatusCallback',
        event: 'twilio.apply.fail',
        extra: { err: (err as Error)?.message },
      });
    }
  }
  res.status(200).json({ ok: true });
}

export const smtp2goEventWebhook = onRequest(
  // One callback per delivered message, so a broadcast arrives as a burst of
  // them. SMTP2GO retries on non-2xx; a full vCPU keeps 80-way concurrency so
  // the burst lands in one instance instead of one instance per event.
  { region: 'us-central1', secrets: ['SENTRY_DSN'], ...FULL_CPU },
  wrapHttp('smtp2goEventWebhook', smtp2goEventWebhookHandler),
);

export const twilioStatusCallback = onRequest(
  // One callback per sent SMS, so a broadcast arrives as a burst of them.
  // See smtp2goEventWebhook above.
  { region: 'us-central1', secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'], ...FULL_CPU },
  wrapHttp('twilioStatusCallback', twilioStatusCallbackHandler),
);
