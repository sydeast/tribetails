import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';

const Args = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, {
      message: 'schema.id must be [a-zA-Z][a-zA-Z0-9_.-]*',
    }),
});

export async function deleteFormSchemaHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  const ref = db().collection('formSchemas').doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Schema '${args.id}' not found.`);
  }

  await ref.delete();

  await writeAuditEntry({
    event: AUDIT_EVENTS.DELETE_FORM_SCHEMA,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { schemaId: args.id },
  });

  logEvent({
    severity: 'warn',
    function: 'deleteFormSchema',
    event: 'portal.formSchema.deleted',
    uid,
    extra: { schemaId: args.id },
  });

  return { ok: true };
}

export const deleteFormSchema = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('deleteFormSchema', deleteFormSchemaHandler),
);
