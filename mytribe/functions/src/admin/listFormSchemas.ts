import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isOwner, isOwnerClaim } from '../lib/staffGate';

/**
 * Returns lightweight summaries of every formSchemas/{schemaId} document for
 * admin authoring UI. Full schema bodies fetched via getFormSchema.
 *
 * WHO. The owner gets every form. An Auntie (#2461 ruling, 2026-11-20: she
 * sees the full KinTale) gets the KinTale form only, the one whose
 * `appliesTo` is exactly `KINTALE`, because its field labels are what a
 * KinTale's custom field answers are shown under. She gets no `updatedBy`, and
 * authoring stays the owner's (`saveFormSchema` and `deleteFormSchema` are not
 * on her list in `lib/auntieAccess.ts`).
 */

/** The placement of the KinTale form, the only one an Auntie lists. */
export const KINTALE_FORM_PLACEMENT = 'KINTALE';

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
  const callerIsOwner = isOwner(uid, isOwnerClaim(req.auth?.token), 'listFormSchemas');
  const snap = await db().collection('formSchemas').get();
  const all: FormSchemaSummary[] = snap.docs.map((d) => {
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

  // Anyone who is not the owner, an Auntie included, gets the KinTale form and
  // nothing else, with no record of who last edited it.
  const schemas = callerIsOwner
    ? all
    : all
        .filter((s) => s.appliesTo === KINTALE_FORM_PLACEMENT)
        .map((s) => ({ ...s, updatedBy: null }));

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
    extra: { count: schemas.length, kinTaleFormOnly: !callerIsOwner },
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
