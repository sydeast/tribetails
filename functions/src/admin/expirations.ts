import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * AO-39 Expiration Countdown (dashboard widget). Admin-only `expirations`
 * collection: gate codes, vet records, cards, licenses and the like that lapse
 * on a date. listExpirations returns every row sorted by dateIso ascending (the
 * widget filters to the near-term window client-side); upsertExpiration
 * creates or updates one. Fail loud: no fabricated dates.
 */

export const EXPIRATIONS_COLLECTION = 'expirations';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ExpirationKind = z.enum(['gateCode', 'vetRecord', 'card', 'license', 'other']);

export const UpsertExpirationArgs = z.object({
  expirationId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200),
  dateIso: z.string().regex(DATE_RE, 'dateIso must be YYYY-MM-DD'),
  kind: ExpirationKind,
  kinfolkId: z.string().min(1).max(200).optional(),
});

export interface ExpirationRow {
  _id: string;
  label: string;
  dateIso: string;
  kinfolkId: string;
  kind: z.infer<typeof ExpirationKind>;
}

export async function listExpirationsHandler(
  req: CallableRequest<unknown>,
): Promise<{ expirations: ExpirationRow[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection(EXPIRATIONS_COLLECTION).get();
  const expirations: ExpirationRow[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const kindRaw = typeof data.kind === 'string' ? data.kind : 'other';
    const kind = (['gateCode', 'vetRecord', 'card', 'license', 'other'].includes(kindRaw)
      ? kindRaw
      : 'other') as z.infer<typeof ExpirationKind>;
    return {
      _id: d.id,
      label: typeof data.label === 'string' ? data.label : '',
      dateIso: typeof data.dateIso === 'string' ? data.dateIso : '',
      kinfolkId: typeof data.kinfolkId === 'string' ? data.kinfolkId : '',
      kind,
    };
  });
  // Server sorts by dateIso ascending (YYYY-MM-DD sorts lexically == chronologically).
  expirations.sort((a, b) => a.dateIso.localeCompare(b.dateIso));

  return { expirations };
}

export async function upsertExpirationHandler(
  req: CallableRequest<unknown>,
): Promise<{ id: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof UpsertExpirationArgs>;
  try {
    args = UpsertExpirationArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'upsertExpiration validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const coll = db().collection(EXPIRATIONS_COLLECTION);
  const ref = args.expirationId ? coll.doc(args.expirationId) : coll.doc();
  const created = !args.expirationId;
  await ref.set(
    {
      label: args.label,
      dateIso: args.dateIso,
      kind: args.kind,
      kinfolkId: args.kinfolkId ?? '',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
      ...(created ? { createdAt: FieldValue.serverTimestamp() } : {}),
    },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.EXPIRATION_UPSERTED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: EXPIRATIONS_COLLECTION,
    payload: { id: ref.id, created, kind: args.kind, dateIso: args.dateIso },
  });

  logEvent({
    severity: 'info',
    function: 'upsertExpiration',
    event: 'admin.expiration.upserted',
    uid,
    extra: { id: ref.id, created, kind: args.kind },
  });

  return { id: ref.id };
}

export const listExpirations = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listExpirations', listExpirationsHandler),
);

export const upsertExpiration = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('upsertExpiration', upsertExpirationHandler),
);
