import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Returns lightweight summaries of every formSchemas/{schemaId} document for
 * admin authoring UI. Full schema bodies fetched via getFormSchema. Admin-only.
 */

export interface FormSchemaSummary {
  id: string;
  name: string;
  appliesTo: string; // NONE | KINFOLK | KIN | HOUSEHOLD | SESSION | BOOKING (1C placement)
  version: number;
  updatedAt: string | null; // ISO-8601 or null when never written
  updatedBy: string | null;
}

export interface ListFormSchemasResult {
  schemas: FormSchemaSummary[];
}

export async function listFormSchemasHandler(
  req: CallableRequest<unknown>,
): Promise<ListFormSchemasResult> {
  initSentry();
  const uid = req.auth?.uid;
  // defense-in-depth, wrapAdminCallable already enforces, kept in-handler for resilience to refactor
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const snap = await db().collection('formSchemas').get();
  const schemas: FormSchemaSummary[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: typeof data['name'] === 'string' && (data['name'] as string).length > 0
        ? (data['name'] as string)
        : d.id,
      appliesTo: typeof data['appliesTo'] === 'string' ? (data['appliesTo'] as string) : 'NONE',
      version:
        typeof data['version'] === 'number' &&
        isFinite(data['version'] as number) &&
        !isNaN(data['version'] as number)
          ? (data['version'] as number)
          : 0,
      updatedAt: toIsoOrNull(data['updatedAt']),
      updatedBy: typeof data['updatedBy'] === 'string' ? (data['updatedBy'] as string) : null,
    };
  });

  // Stable order: name asc, then id asc, keeps admin list predictable.
  schemas.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });

  logEvent({
    severity: 'info',
    function: 'listFormSchemas',
    event: 'portal.formSchema.listed',
    uid,
    extra: { count: schemas.length },
  });

  return { schemas };
}

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  // Firestore Timestamp → has toDate()
  if (typeof v === 'object' && v !== null && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try {
      const d = (v as { toDate: () => Date }).toDate();
      return d.toISOString();
    } catch {
      return null;
    }
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

export const listFormSchemas = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('listFormSchemas', listFormSchemasHandler),
);
