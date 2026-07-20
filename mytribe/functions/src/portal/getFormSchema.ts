import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  schemaId: z.string().min(1).max(80),
});

type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'date' | 'number' | 'checkbox' | 'phone' | 'email';

interface FieldDto {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helperText: string | null;
  placeholder: string | null;
  options: string[] | null;
  defaultValue: string | null;
  /** Optional grouping inside a section, e.g. "left-column", "right-column". */
  group: string | null;
}

interface SectionDto {
  title: string;
  description: string | null;
  fields: FieldDto[];
}

interface FormSchemaDto {
  id: string;
  name: string;
  description: string | null;
  /** 1C placement: which entity this schema attaches to (NONE = global). */
  appliesTo: string;
  sections: SectionDto[];
  /** Optional schema version pin so AuntieOS can roll forward without breaking clients. */
  version: number;
}

/**
 * Reads `formSchemas/{schemaId}` written by AuntieOS admins.
 * Auth-only; not scoped to kinfolkId since schemas are global.
 *
 * Schemas drive Tribe Profile, Account Settings, Notification Settings,
 * Kin Profile, Home Information forms, fields live in Firestore so admins
 * can change copy / add fields without app deploys.
 */
export async function getFormSchemaHandler(
  req: CallableRequest<unknown>,
): Promise<FormSchemaDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const snap = await db().collection('formSchemas').doc(args.schemaId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Schema '${args.schemaId}' not found.`);
  const data = snap.data() as Record<string, unknown>;

  const result: FormSchemaDto = {
    id: args.schemaId,
    name: stringOrEmpty(data['name']) || args.schemaId,
    description: stringOrNull(data['description']),
    appliesTo: stringOrEmpty(data['appliesTo']) || 'NONE',
    version: numericOrZero(data['version']),
    sections: parseSections(data['sections']),
  };

  logEvent({
    severity: 'info',
    function: 'getFormSchema',
    event: 'portal.formSchema.resolved',
    uid,
    extra: { schemaId: args.schemaId, sectionCount: result.sections.length },
  });
  return result;
}

function parseSections(raw: unknown): SectionDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      title: stringOrEmpty(s['title']),
      description: stringOrNull(s['description']),
      fields: parseFields(s['fields']),
    }));
}

function parseFields(raw: unknown): FieldDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .filter((f) => typeof f['key'] === 'string')
    .map((f) => ({
      key: f['key'] as string,
      label: stringOrEmpty(f['label']),
      type: parseFieldType(f['type']),
      required: f['required'] === true,
      helperText: stringOrNull(f['helperText']),
      placeholder: stringOrNull(f['placeholder']),
      options: Array.isArray(f['options'])
        ? (f['options'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : null,
      defaultValue: stringOrNull(f['defaultValue']),
      group: stringOrNull(f['group']),
    }));
}

function parseFieldType(v: unknown): FieldType {
  const allowed: FieldType[] = ['text', 'textarea', 'select', 'multiselect', 'date', 'number', 'checkbox', 'phone', 'email'];
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as FieldType;
  return 'text';
}

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function numericOrZero(v: unknown): number {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  return 0;
}

export const getFormSchema = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getFormSchema', getFormSchemaHandler),
);
