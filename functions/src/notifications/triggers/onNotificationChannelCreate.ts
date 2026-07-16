import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { wrapTrigger } from '../../lib/wrapTrigger';
import { getNotificationDef } from '../catalog';
import { enrichTemplateData } from '../enrichTemplateData';
import { channelSenders } from '../senders';
import type { Channel } from '../types';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';

const CHANNELS: ReadonlySet<Channel> = new Set(['email', 'sms', 'push']);

/**
 * Processes a single channel subdoc. Looks up the parent notification, resolves
 * the catalog def, and calls the channel sender. On success/failure, stamps
 * status + providerMessageId / error on the subdoc. Failures throw, which the
 * wrapTrigger wrap captures to Sentry and Cloud Functions retries.
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
      throw new Error('onNotificationChannelCreate: channel subdoc has no parent notification ref');
    }
    const parentSnap = await parentRef.get();
    const parent = parentSnap.data() as
      | { key?: string; recipientUid?: string; data?: Record<string, unknown> }
      | undefined;
    if (!parent || !parent.key || !parent.recipientUid) {
      throw new Error(`onNotificationChannelCreate: parent notification ${parentRef.path} missing key/recipientUid`);
    }

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
        event: AUDIT_EVENTS.NOTIFICATION_RECEIVED,
        severity: 'info',
        actorRole: 'SYSTEM',
        // Audit target is the notification doc itself; recipientUid kept in
        // payload so admin Activity Log "Target" column stays consistent
        // (collection + doc id) per writeAuditEntry canonical schema.
        targetUid: parentRef.id,
        targetCollection: 'notifications',
        description: `Notification ${parent.key} delivered via ${channel}`,
        payload: {
          notificationId: parentRef.id,
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
    document: 'notifications/{id}/channels/{channel}',
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
