import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

const PROFILE_FIELDS = [
  'displayName',
  'name',
  'email',
  'phone',
  'address',
  'homeAccess',
  'tribeProfile',
  'photoUrl',
];

/**
 * Watches `families/{kinfolkId}` doc, fires `profile.updated` when any
 * profile-relevant field changed. Debounced 30 min via catalog.
 */
export const onFamilyProfileWrite = onDocumentWritten(
  {
    document: 'families/{kinfolkId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onFamilyProfileWrite', async (event) => {
    const before = (event.data?.before.data() ?? {}) as Record<string, unknown>;
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    if (!after) return;

    const changed = PROFILE_FIELDS.some(
      (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
    );
    if (!changed) return;

    const kinfolkId = event.params.kinfolkId;
    const recipientUid = await resolveKinfolkUid(kinfolkId);
    try {
      await enqueueNotification({
        key: 'profile.updated',
        recipientUid: recipientUid ?? '',
        data: { kinfolkId },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'onFamilyProfileWrite',
        event: 'notification.dispatch.failed',
        extra: { kinfolkId, err: (err as Error)?.message },
      });
    }
  }),
);
