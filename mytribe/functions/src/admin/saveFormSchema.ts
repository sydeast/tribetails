import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';

/**
 * formSchemas/{schemaId} authoring callable. Read-side lives in
 * portal/getFormSchema.ts (kinfolk-facing, unchanged). This callable mutates;
 * gated by the admin claim (env-allowlist fallback) via wrapAdminCallable.
 *
 * Server-side responsibilities:
 *   - Validate input shape + invariants w/ Zod (fail loud, no silent coercion)
 *   - Bump `version` monotonically (increment current Firestore value, default 1)
 *   - Stamp updatedAt + updatedBy; createdAt + createdBy on first save
 *   - Write `SAVE_FORM_SCHEMA` audit entry w/ {version, sectionsCount, fieldsCount}
 *   - Emit `portal.formSchema.saved` log
 *
 * Concurrency: read + version compute + write are wrapped in a Firestore
 * transaction so concurrent saves either get distinct version numbers (in
 * arrival order) or one fails, never silent clobber. Audit + log writes
 * happen outside the transaction (best-effort observability, not part of the
 * integrity contract).
 */

const FIELD_TYPES = [
  'text',
  'textarea',
  'select',
  'multiselect',
  'date',
  'number',
  'checkbox',
  'phone',
  'email',
] as const;

// Plaintext: no control chars (0x00-0x1F, 0x7F), no HTML tag characters (<, >),
// no ampersand (entity injection). Allows spaces, punctuation, unicode.
// XSS hardening for fields rendered to every signed-in kinfolk.
//
// Note: spec task suggested /^[^ -<>]*$/ but that range blocks space (0x20)
// through < (0x3C), i.e. digits, uppercase letters, parens, periods, commas.
// That would reject legitimate labels like "Family name" or "Phone (mobile)".
// Hardened equivalent below blocks only the actual injection vectors.
// eslint-disable-next-line no-control-regex -- intentionally blocks control chars as injection vectors
const PLAINTEXT_RE = /^[^<>&\x00-\x1F\x7F]*$/;
const PLAINTEXT_MSG = 'Must be plaintext (no HTML or control characters)';
const plaintext = (max: number) =>
  z.string().max(max).regex(PLAINTEXT_RE, PLAINTEXT_MSG);

const FieldSchema = z
  .object({
    key: z
      .string()
      .min(1, 'field.key required')
      .max(80)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
        message: 'field.key must be camelCase identifier',
      }),
    label: plaintext(200).min(1, 'field.label required'),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    helperText: plaintext(500).nullable(),
    placeholder: plaintext(200).nullable(),
    options: z.array(plaintext(200).min(1)).max(100).nullable(),
    defaultValue: plaintext(2000).nullable(),
    group: z.string().max(80).nullable(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select' || field.type === 'multiselect') {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: `options required for type '${field.type}'`,
        });
      }
    }
  });

const SectionSchema = z
  .object({
    title: plaintext(200).min(1, 'section.title required'),
    description: plaintext(2000).nullable(),
    fields: z.array(FieldSchema).min(1, 'section.fields must be non-empty').max(200),
  })
  .superRefine((section, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < section.fields.length; i++) {
      const key = section.fields[i].key;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', i, 'key'],
          message: `duplicate field key '${key}' within section`,
        });
      }
      seen.add(key);
    }
  });

// 1C: which entity a schema attaches to. NONE = global/standalone schema (e.g.
// tribeProfile, accountSettings). The entity targets absorb the legacy
// dynamic_fields `appliesTo` so FormSchema is the single field-authoring system.
const APPLIES_TO = ['NONE', 'KINFOLK', 'KIN', 'HOUSEHOLD', 'SESSION', 'BOOKING', 'KINTALE'] as const;

const SchemaInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, {
      message: 'schema.id must be [a-zA-Z][a-zA-Z0-9_.-]*',
    }),
  name: plaintext(200).min(1, 'schema.name required'),
  description: plaintext(2000).nullable(),
  appliesTo: z.enum(APPLIES_TO).default('NONE'),
  version: z.number().int().min(0), // ignored on save, server bumps
  sections: z.array(SectionSchema).min(1, 'schema.sections must be non-empty').max(50),
});

const Args = z.object({ schema: SchemaInputSchema });

export interface SaveFormSchemaResult {
  ok: true;
  id: string;
  version: number;
}

export async function saveFormSchemaHandler(
  req: CallableRequest<unknown>,
): Promise<SaveFormSchemaResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let parsed: z.infer<typeof Args>;
  try {
    parsed = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      const validationErrors = err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const data = (req.data ?? {}) as { schema?: { id?: unknown } };
      const schemaId =
        typeof data.schema?.id === 'string' ? (data.schema.id as string) : null;
      logEvent({
        severity: 'warn',
        function: 'saveFormSchema',
        event: 'portal.formSchema.validation_failed',
        uid,
        extra: { schemaId, validationErrors },
      });
      throw new HttpsError('invalid-argument', 'formSchema validation failed', {
        validationErrors,
      });
    }
    throw err;
  }
  const input = parsed.schema;

  const ref = db().collection('formSchemas').doc(input.id);

  const sectionsCount = input.sections.length;
  const fieldsCount = input.sections.reduce((sum, s) => sum + s.fields.length, 0);

  // Read + version compute + write atomically. Without the transaction, two
  // concurrent saves can both read version=N then both write version=N+1,
  // silently clobbering each other.
  const { nextVersion, isCreate } = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const txIsCreate = !snap.exists;
    const current = snap.exists ? (snap.data() as Record<string, unknown>) : {};
    const currentVersion =
      typeof current['version'] === 'number' &&
      isFinite(current['version'] as number) &&
      !isNaN(current['version'] as number)
        ? (current['version'] as number)
        : 0;
    const txNextVersion = txIsCreate ? 1 : currentVersion + 1;

    tx.set(
      ref,
      {
        id: input.id,
        name: input.name,
        description: input.description,
        appliesTo: input.appliesTo,
        version: txNextVersion,
        sections: input.sections.map((s) => ({
          title: s.title,
          description: s.description,
          fields: s.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            helperText: f.helperText,
            placeholder: f.placeholder,
            options: f.options,
            defaultValue: f.defaultValue,
            group: f.group,
          })),
        })),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: uid,
        ...(txIsCreate
          ? { createdAt: FieldValue.serverTimestamp(), createdBy: uid }
          : {}),
      },
      { merge: true },
    );

    return { nextVersion: txNextVersion, isCreate: txIsCreate };
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.SAVE_FORM_SCHEMA,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      schemaId: input.id,
      version: nextVersion,
      sectionsCount,
      fieldsCount,
      isCreate,
    },
  });

  logEvent({
    severity: 'info',
    function: 'saveFormSchema',
    event: 'portal.formSchema.saved',
    uid,
    extra: {
      schemaId: input.id,
      version: nextVersion,
      sectionCount: sectionsCount,
      fieldCount: fieldsCount,
      isCreate,
    },
  });

  return { ok: true, id: input.id, version: nextVersion };
}

export const saveFormSchema = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('saveFormSchema', saveFormSchemaHandler),
);
