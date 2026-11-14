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
/**
 * #2074: the two DESCRIPTION fields are multi-line boxes on the clients (the
 * schema description is a textarea), so a line break is ordinary input there
 * and refusing it made a form that passed every on-screen check fail on save.
 * Line feed, carriage return and tab are allowed in descriptions only; every
 * other control character, and `<`, `>`, `&`, is still refused.
 */
// eslint-disable-next-line no-control-regex -- intentionally blocks control chars as injection vectors
const MULTILINE_PLAINTEXT_RE = /^[^<>&\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/;
const PLAINTEXT_MSG = 'Must be plaintext (no HTML or control characters)';
const plaintext = (max: number) =>
  z.string().max(max).regex(PLAINTEXT_RE, PLAINTEXT_MSG);
const multilinePlaintext = (max: number) =>
  z.string().max(max).regex(MULTILINE_PLAINTEXT_RE, PLAINTEXT_MSG);

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
    description: multilinePlaintext(2000).nullable(),
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
  description: multilinePlaintext(2000).nullable(),
  appliesTo: z.enum(APPLIES_TO).default('NONE'),
  version: z.number().int().min(0), // ignored on save, server bumps
  sections: z.array(SectionSchema).min(1, 'schema.sections must be non-empty').max(50),
});

// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z.object({ schema: SchemaInputSchema });

/**
 * One refused input, as every admin client shows it (#2074).
 *
 * Before this the refusal carried only Zod's own path and message
 * (`schema.sections.0.fields.0.label`, "Must be plaintext ..."), the clients
 * printed neither, and the operator read "Something in this form was not
 * accepted" with no step or field marked. `text` is the operator's sentence,
 * already naming the section and field; `sectionIndex` / `fieldIndex` let a
 * client mark the card the input sits on. Both are null for a schema-level
 * input (id, name, description, the section list itself).
 */
export interface FormSchemaRefusal {
  path: string;
  message: string;
  text: string;
  sectionIndex: number | null;
  fieldIndex: number | null;
}

const SCHEMA_FIELD_NAMES: Record<string, string> = {
  id: 'Schema id',
  name: 'Name',
  description: 'Description',
  appliesTo: 'Applies to',
  version: 'Version',
  sections: 'Sections',
};
const SECTION_FIELD_NAMES: Record<string, string> = {
  title: 'Section title',
  description: 'Section description',
  fields: 'Fields',
};
const FIELD_FIELD_NAMES: Record<string, string> = {
  key: 'Key',
  label: 'Label',
  type: 'Type',
  required: 'Required',
  helperText: 'Helper text',
  placeholder: 'Placeholder',
  options: 'Options',
  defaultValue: 'Default value',
  group: 'Group',
};

/** The value the issue's path points at, or undefined. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/**
 * PURE. The operator's sentence for one Zod issue on `{ schema }`.
 *
 * Every message names the input in the words the editor labels it with and
 * says what to change. No path, no Zod wording, no field key in code form.
 */
export function describeFormSchemaIssue(
  issue: { code: string; path: readonly PropertyKey[]; message: string; maximum?: unknown; origin?: unknown },
  data: unknown,
): FormSchemaRefusal {
  // Drop the leading `schema` the Args wrapper adds.
  const path = issue.path[0] === 'schema' ? issue.path.slice(1) : issue.path;
  let sectionIndex: number | null = null;
  let fieldIndex: number | null = null;
  let thing = 'This form';
  let optionNumber: number | null = null;
  if (path[0] === 'sections' && typeof path[1] === 'number') {
    sectionIndex = path[1];
    if (path[2] === 'fields' && typeof path[3] === 'number') {
      fieldIndex = path[3];
      const leaf = String(path[4] ?? '');
      thing = FIELD_FIELD_NAMES[leaf] ?? 'This field';
      if (leaf === 'options' && typeof path[5] === 'number') optionNumber = path[5] + 1;
    } else {
      thing = SECTION_FIELD_NAMES[String(path[2] ?? '')] ?? 'This section';
    }
  } else {
    thing = SCHEMA_FIELD_NAMES[String(path[0] ?? '')] ?? 'This form';
  }
  if (optionNumber !== null) thing = `Option ${optionNumber}`;

  const where =
    sectionIndex === null
      ? ''
      : fieldIndex === null
        ? `Section ${sectionIndex + 1}: `
        : `Section ${sectionIndex + 1}, Field ${fieldIndex + 1}: `;

  const value = valueAt((data as { schema?: unknown } | null)?.schema, path);
  const max = typeof issue.maximum === 'number' || typeof issue.maximum === 'bigint' ? Number(issue.maximum) : null;
  let reason: string;
  switch (issue.code) {
    case 'too_big':
      if (typeof value === 'string' && max !== null) {
        reason = `${thing} is ${value.length} characters long. The limit is ${max}.`;
      } else if (thing === 'Sections' && max !== null) {
        reason = `A form can have at most ${max} sections.`;
      } else if (thing === 'Fields' && max !== null) {
        reason = `A section can have at most ${max} fields.`;
      } else if (thing === 'Options' && max !== null) {
        reason = `A field can have at most ${max} options.`;
      } else {
        reason = `${thing} is too long.`;
      }
      break;
    case 'too_small':
      if (thing === 'Sections') reason = 'Add at least one section.';
      else if (thing === 'Fields') reason = 'Add at least one field to this section.';
      else if (optionNumber !== null) reason = `${thing} is empty.`;
      else reason = `${thing} is required.`;
      break;
    case 'invalid_format':
    case 'invalid_string':
      if (thing === 'Key') {
        reason = 'Key must start with a letter and use only letters, numbers or underscores.';
      } else if (thing === 'Schema id') {
        reason = 'Schema id must start with a letter and use only letters, numbers, underscores, periods or hyphens.';
      } else if (typeof value === 'string' && /[<>&]/.test(value)) {
        reason = `${thing} cannot contain <, > or &.`;
      } else {
        reason = `${thing} cannot contain a tab, a line break or another hidden character.`;
      }
      break;
    case 'invalid_value':
    case 'invalid_enum_value':
      reason = `${thing} is not one of the choices.`;
      break;
    case 'custom':
      if (issue.message.startsWith('duplicate field key')) {
        reason = 'Another field in this section already uses this key.';
      } else if (issue.message.startsWith('options required')) {
        reason = 'Add at least one option for this field type.';
      } else {
        reason = `${thing} was not accepted.`;
      }
      break;
    default:
      reason = `${thing} was not accepted.`;
  }
  return {
    path: issue.path.map(String).join('.'),
    message: issue.message,
    text: `${where}${reason}`,
    sectionIndex,
    fieldIndex,
  };
}

/** Every issue described, one per input (the first issue on a path wins). */
export function describeFormSchemaIssues(err: ZodError, data: unknown): FormSchemaRefusal[] {
  const seen = new Set<string>();
  const out: FormSchemaRefusal[] = [];
  for (const issue of err.issues) {
    const described = describeFormSchemaIssue(issue as never, data);
    if (seen.has(described.path)) continue;
    seen.add(described.path);
    out.push(described);
  }
  return out;
}

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
      const validationErrors = describeFormSchemaIssues(err, req.data);
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
      // `reason` is the token a client branches on; each entry's `text` is
      // what it shows (#2074).
      throw new HttpsError('invalid-argument', 'formSchema validation failed', {
        reason: 'form-schema-refused',
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
    status: 'SUCCESS',
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
