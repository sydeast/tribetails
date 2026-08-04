import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { wrapTrigger } from '../../lib/wrapTrigger';
import { logEvent } from '../../lib/logger';
import { getNotificationDef } from '../catalog';
import { enrichTemplateData } from '../enrichTemplateData';
import { channelSenders } from '../senders';
import type { Channel } from '../types';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';

const CHANNELS: ReadonlySet<Channel> = new Set(['email', 'sms', 'push']);

/**
 * Processes a single channel subdoc. Looks up the parent WORK ORDER, resolves
 * the catalog def, and calls the channel sender. On success/failure, stamps
 * status + providerMessageId / error on the subdoc. Failures throw, which the
 * wrapTrigger wrap captures to Sentry and Cloud Functions retries.
 *
 * THE SUBDOCS MOVED (operator ruling R5, 2026-08-03). They used to hang off the
 * notification itself, at `notifications/{id}/channels/{channel}`, so an inbox
 * document carried a subcollection of per-channel `status` / `providerMessageId`
 * / `sentAt` / `errorMessage` / `attempts`. All of that is delivery plumbing, and
 * it now lives under the work order at
 * `notificationDispatch/{id}/channels/{channel}`. The parent doc carries `key`,
 * `recipientUid` and the merge `data` itself, so this handler still needs
 * exactly one parent read and never has to reach across into `notifications/`.
 *
 * The audit write below is UNCHANGED and was already correct: NOTIFICATION_RECEIVED
 * has always gone to the hash-chained `activity_log`, targeting the notification
 * id. That was the half of this that was already wired to the right home.
 *
 * Exported separately from the CloudFunction wrapper so it is unit-testable
 * without a real Firestore CloudEvent (matches the `...Handler` convention used
 * by the other notification triggers).
 */
export async function onNotificationChannelCreateHandler(event: any): Promise<void> {
    const snap = event.data;
    if (!snap) return;
    const channel = event.params.channel as Channel;
    if (!CHANNELS.has(channel)) {
      throw new Error(`onNotificationChannelCreate: invalid channel '${channel}'`);
    }
    const subData = snap.data() as { status?: string } | undefined;
    if (!subData || subData.status !== 'pending') return;

    const parentRef = snap.ref.parent.parent;
    if (!parentRef) {
      throw new Error('onNotificationChannelCreate: channel subdoc has no parent dispatch ref');
    }
    const parentSnap = await parentRef.get();
    const parent = parentSnap.data() as
      | {
          key?: string;
          recipientUid?: string;
          data?: Record<string, unknown>;
          notificationId?: string;
        }
      | undefined;
    if (!parent || !parent.key || !parent.recipientUid) {
      throw new Error(`onNotificationChannelCreate: parent dispatch ${parentRef.path} missing key/recipientUid`);
    }
    // Id-matched by construction (dispatcher writes the work order under the
    // notification's own id), but read the explicit field first so a future
    // change to that convention surfaces here instead of silently auditing
    // against the wrong document id.
    const notificationId = parent.notificationId ?? parentRef.id;

    const def = getNotificationDef(parent.key);
    const sender = channelSenders[channel];
    // CENTRAL enrichment: emitters pass mostly IDs (kinfolkId/invoiceId/bookingId);
    // hydrate the standard entities into the full {{token}} context here, once at
    // the single fan-out choke point, so every channel + delivery mode benefits.
    // Emitter-provided values win; a missing entity degrades to blank (never throws).
    const enrichedData = await enrichTemplateData(parent.key, parent.recipientUid, parent.data ?? {});
    try {
      const result = await sender({
        def,
        recipientUid: parent.recipientUid,
        data: enrichedData,
      });
      // Fail-soft skip (e.g. recipient has no email on file): a permanent,
      // undeliverable-on-this-channel condition that must NOT throw — throwing
      // would Sentry-capture + retry an unfixable case (MYTRIBE-FUNCTIONS-8).
      // Record it visibly (status 'skipped' + a warning log) so it is never
      // silently swallowed, then return without the delivery audit entry.
      if (result.skipped) {
        await snap.ref.set(
          {
            status: 'skipped',
            skipReason: result.skipReason ?? 'unknown',
            skippedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        logEvent({
          severity: 'warn',
          function: 'onNotificationChannelCreate',
          event: 'notification.channel.skipped',
          uid: parent.recipientUid,
          extra: { key: parent.key, channel, reason: result.skipReason ?? 'unknown' },
        });
        return;
      }
      await snap.ref.set(
        {
          status: 'sent',
          providerMessageId: result.providerMessageId ?? null,
          sentAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // Audit: per-channel delivery acknowledgement. NOTIFICATION_RECEIVED is
      // fired the moment the sender returns success, provider delivery
      // semantics differ per channel (SendGrid = accepted, Twilio = queued,
      // FCM = enqueued for device) but this is the earliest confirmation we
      // have without channel-specific webhooks.
      await writeAuditEntry({
        status: 'SUCCESS',
        event: AUDIT_EVENTS.NOTIFICATION_RECEIVED,
        severity: 'info',
        actorRole: 'SYSTEM',
        // Audit target is the notification doc itself; recipientUid kept in
        // payload so admin Activity Log "Target" column stays consistent
        // (collection + doc id) per writeAuditEntry canonical schema.
        targetUid: notificationId,
        targetCollection: 'notifications',
        description: `Notification ${parent.key} delivered via ${channel}`,
        payload: {
          notificationId,
          key: parent.key,
          channel,
          recipientUid: parent.recipientUid,
          providerMessageId: result.providerMessageId ?? null,
        },
      }).catch(() => {
        // Audit failures here are non-fatal, sender already succeeded; the
        // wrapTrigger Sentry hook records audit-write exceptions separately.
      });
    } catch (err) {
      await snap.ref.set(
        {
          status: 'failed',
          errorMessage: (err as Error)?.message ?? String(err),
          failedAt: FieldValue.serverTimestamp(),
          attempts: FieldValue.increment(1),
        },
        { merge: true },
      );
      throw err;
    }
}

export const onNotificationChannelCreate = onDocumentCreated(
  {
    // Repointed from `notifications/{id}/channels/{channel}` (R5). The export
    // name is kept so Firebase updates this trigger in place rather than
    // standing up a second one alongside the old path; see the note in
    // onNotificationCreate.ts for why that window would be harmful.
    document: 'notificationDispatch/{id}/channels/{channel}',
    secrets: [
      'SENTRY_DSN',
      'SMTP2GO_API_KEY',
      'EMAIL_FROM',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
    ],
  },
  wrapTrigger('onNotificationChannelCreate', onNotificationChannelCreateHandler),
);
