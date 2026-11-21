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

type Snap = { exists?: boolean; data(): Record<string, unknown> | undefined } | undefined;

/** The slice of a Firestore write event this handler reads. Exported for the tests. */
export interface FamilyProfileWriteEvent {
  params: { kinfolkId: string };
  data?: { before?: Snap; after?: Snap };
}

/**
 * Watches `families/{kinfolkId}` doc, fires `profile.updated` when any
 * profile-relevant field changed. Debounced 30 min via catalog.
 *
 * #1963: A CREATE IS NOT AN UPDATE. The envelope is written the moment a
 * household is made: `onKinfolkCreate` provisions it for every new AuntieOS
 * household (admin web, Android and the desktop console all create through
 * `kinfolk/{id}`), and `inviteKinfolkToPortal` writes it when none exists yet.
 * Read as a change from nothing, that first `displayName` sent the office a
 * "Profile updated" notice half an hour after the owner made the household
 * herself. Only a write to an envelope that already existed is a profile
 * update.
 */
export async function onFamilyProfileWriteHandler(event: FamilyProfileWriteEvent): Promise<void> {
  const beforeSnap = event.data?.before;
  const after = event.data?.after?.data();
  if (!after) return;
  if (beforeSnap?.exists !== true) return;
  const before = (beforeSnap.data() ?? {}) as Record<string, unknown>;

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
}

export const onFamilyProfileWrite = onDocumentWritten(
  {
    document: 'families/{kinfolkId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onFamilyProfileWrite', onFamilyProfileWriteHandler),
);
