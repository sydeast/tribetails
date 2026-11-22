import {
  onDocumentWrittenWithAuthContext,
  type Change,
  type DocumentSnapshot,
  type FirestoreAuthEvent,
} from 'firebase-functions/v2/firestore';
import { wrapTrigger } from '../lib/wrapTrigger';

/**
 * #1892: the Activity Log line for a KinTale template created, saved,
 * archived, restored or deleted, from the write that committed it. The admin
 * clients (web, Android, desktop console) write `kintale_templates` directly,
 * so no callable could record it. The rules for which writes are a line live
 * in `lib/kinTaleTemplateAudit.ts`, loaded on the first event, so this entry is
 * the only module the cold-start graph gains.
 *
 * WHO. A client write carries the signed-in uid as `authId`. A server write
 * (service account) or a system one has no person behind it and is the
 * system's line.
 */

type TemplateData = Record<string, unknown>;

export type KinTaleTemplateWriteEvent = FirestoreAuthEvent<Change<DocumentSnapshot> | undefined, { templateId: string }>;

/** The uid behind the write, or null for a server or system write. Exported for the tests. */
export function templateWriterUidOf(event: Pick<KinTaleTemplateWriteEvent, 'authType' | 'authId'>): string | null {
  const authId = typeof event.authId === 'string' ? event.authId.trim() : '';
  if (authId === '' || event.authType === 'service_account' || event.authType === 'system') return null;
  return authId;
}

export async function onKinTaleTemplateWriteHandler(event: KinTaleTemplateWriteEvent): Promise<void> {
  const before = event.data?.before.exists ? (event.data.before.data() as TemplateData | undefined) : undefined;
  const after = event.data?.after.exists ? (event.data.after.data() as TemplateData | undefined) : undefined;
  const { recordKinTaleTemplateChange } = await import('../lib/kinTaleTemplateAudit.js');
  await recordKinTaleTemplateChange({
    templateId: event.params.templateId,
    before,
    after,
    actorUid: templateWriterUidOf(event),
    eventId: typeof event.id === 'string' ? event.id : '',
  });
}

export const onKinTaleTemplateWrite = onDocumentWrittenWithAuthContext(
  {
    document: 'kintale_templates/{templateId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleTemplateWrite', onKinTaleTemplateWriteHandler),
);
