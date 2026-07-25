import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LogExpenseArgs, ListExpensesArgs } from '../src/admin/expenses';
import { OptimizeRouteArgs } from '../src/admin/optimizeRoute';
import { AdjustSupplyArgs, UpsertSupplyArgs } from '../src/admin/supplies';
import { UpsertExpirationArgs } from '../src/admin/expirations';
// Money + state mutations the admin hand-mirrors. Added 2026-07-21: the guard
// covered only the 8 widget callables, leaving the highest blast-radius shapes
// (invoices, payment, template assignment) unfrozen. A backend rename here
// silently broke the client once (signCloudinaryUpload). These four are flat
// ZodObjects, so a top-level key freeze is accurate; the nested/effects shapes
// (broadcastMessage, saveTemplate, saveFormSchema) need a deeper mechanism and
// are the next tranche.
import { Args as CreateInvoiceArgs } from '../src/admin/createInvoice';
import { Args as CreateQuoteArgs } from '../src/admin/createQuote';
import { Args as MarkInvoicePaidArgs } from '../src/admin/markInvoicePaid';
import { Args as AssignTemplateArgs } from '../src/admin/assignTemplate';
// Shared catalog write reached by BOTH the kinfolk portal and the AuntieOS
// admin vet-clinic picker (Task 1.8). Two independent clients now build this
// payload, which is exactly the condition this guard exists for.
import { Args as SubmitVetClinicArgs } from '../src/portal/submitVetClinic';
// Nested / effects shapes (2026-07-21 next tranche). A top-level key freeze is
// blind below level 1: saveFormSchema's top level is just `{ schema }`, but the
// client mirrors 3 levels down (schema.sections[].fields[].required). These get
// a RECURSIVE key-path signature so a nested rename fails the guard too.
import { Args as SaveFormSchemaArgs } from '../src/admin/saveFormSchema';
import { Args as SaveTemplateArgs } from '../src/admin/saveTemplate';
import { Args as BroadcastMessageArgs } from '../src/admin/broadcastMessage';
// Tribal Intel writes (added 2026-07-25). The React admin now hand-mirrors these
// three client-side (auntieos-admin/src/lib/tribalIntelDraftSchema.ts +
// src/api/tribalIntelWrite.ts) alongside android's AuntieRepository, so a
// backend rename here breaks two clients silently. Both create and update wrap a
// nested `attachments[]` in two `.refine`s, so they need the recursive
// signature, not a top-level key freeze.
import { TrainingDocumentArgs as CreateTrainingDocumentArgs } from '../src/admin/createTrainingDocument';
import { UpdateTrainingDocumentArgs } from '../src/admin/updateTrainingDocument';
import { DeleteTrainingDocumentArgs } from '../src/admin/deleteTrainingDocument';
// Not a request shape: the SHARED REJECTION both booking-note callables throw.
// See the error-surface guard at the foot of this file.
import {
  NOTE_CUTOFF_MS,
  NOTE_CUTOFF_CODE,
  NOTE_CUTOFF_MESSAGE,
} from '../src/lib/bookingNoteCutoff';

/**
 * AO-8 drift guard (design doc `docs/2026-07-18-AO5-AO8-shared-contract-design.md`
 * Option C). The AuntieOS admin (React), the Compose app (web + desktop) and the
 * android app each HAND-MIRROR these callable request shapes; nothing but review
 * discipline keeps the four in sync. This test freezes the request field set of
 * every cross-app widget callable, so a backend shape change (added / removed /
 * renamed field) trips a red test HERE, forcing a deliberate update + a look at
 * the three mirrors, instead of drifting silently until a client breaks.
 *
 * Canonical request + response shapes live in `docs/CALLABLE_CONTRACT.md` (the
 * single human source the mirrors are built from). When you intentionally change
 * a shape: update that doc, update this frozen set, and update all three client
 * mirrors in the same change.
 */

/** Sorted top-level key set of a zod object schema. */
function shapeKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

/**
 * RECURSIVE key-path signature of a zod schema: every leaf field as a dotted
 * path, arrays marked `[]`, wrappers (optional / nullable / default / effects)
 * unwrapped. So `{ schema: { sections: [{ fields: [{ required }] }] } }`
 * produces `schema.sections[].fields[].required`. A nested rename changes the
 * signature; a top-level-only freeze would miss it. Sorted, so order is stable.
 */
function shapeSignature(schema: z.ZodTypeAny, prefix = ''): string[] {
  // Unwrap the wrappers that do not change the field PATH, only its modality.
  const def = (schema as { _def?: { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny } })._def;
  const typeName = def?.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault') {
    return shapeSignature(def!.innerType as z.ZodTypeAny, prefix);
  }
  if (typeName === 'ZodEffects') {
    // .superRefine / .refine / .transform wrap the real schema (broadcastMessage).
    return shapeSignature(def!.schema as z.ZodTypeAny, prefix);
  }
  if (typeName === 'ZodArray') {
    return shapeSignature(def!.type as z.ZodTypeAny, `${prefix}[]`);
  }
  if (typeName === 'ZodObject') {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const out: string[] = [];
    for (const key of Object.keys(shape)) {
      const child = prefix ? `${prefix}.${key}` : key;
      out.push(...shapeSignature(shape[key] as z.ZodTypeAny, child));
    }
    return out.sort();
  }
  // Leaf (string, number, enum, boolean, record, union, ...): the path itself.
  return [prefix];
}

const FROZEN_REQUEST_SHAPES: Record<string, { schema: z.ZodObject<z.ZodRawShape>; keys: string[] }> = {
  // AO-35
  optimizeRoute: { schema: OptimizeRouteArgs, keys: ['date'] },
  // AO-40
  logExpense: { schema: LogExpenseArgs, keys: ['amountCents', 'kind', 'note', 'occurredAt'] },
  listExpenses: { schema: ListExpensesArgs, keys: ['sinceIso'] },
  // AO-41
  adjustSupply: { schema: AdjustSupplyArgs, keys: ['delta', 'supplyId'] },
  upsertSupply: { schema: UpsertSupplyArgs, keys: ['name', 'onHand', 'par', 'supplyId', 'unit'] },
  // AO-39
  upsertExpiration: { schema: UpsertExpirationArgs, keys: ['dateIso', 'expirationId', 'kind', 'kinfolkId', 'label'] },
  // listSupplies / listExpirations take no args (empty request), so nothing to freeze.

  // Money + state mutations (flat shapes, top-level freeze is accurate here).
  createInvoice: {
    schema: CreateInvoiceArgs,
    keys: ['address', 'amountDue', 'client', 'date', 'discount', 'dueDate', 'familyId', 'invoiceNumber', 'kinfolkName', 'sessionIds', 'status', 'terms', 'total'],
  },
  createQuote: {
    schema: CreateQuoteArgs,
    keys: ['address', 'amountDue', 'client', 'date', 'discount', 'dueDate', 'familyId', 'invoiceNumber', 'kinfolkName', 'sendToKinfolk', 'sessionIds', 'status', 'terms', 'total'],
  },
  markInvoicePaid: { schema: MarkInvoicePaidArgs, keys: ['amount', 'invoiceId', 'method', 'paidAt', 'reference'] },
  assignTemplate: { schema: AssignTemplateArgs, keys: ['active', 'audience', 'catalogKey', 'templateId', 'triggerKey'] },
  deleteTrainingDocument: { schema: DeleteTrainingDocumentArgs, keys: ['docId'] },

  // Shared vet catalog. `isEmergency` was added 2026-07-25 for the AuntieOS
  // picker; it is optional, so every legacy portal payload (the four fields
  // before it) still validates. The freeze is the SUPERSET.
  submitVetClinic: { schema: SubmitVetClinicArgs, keys: ['address', 'isEmergency', 'name', 'phone', 'website'] },
};

describe('AO-8 callable contract drift guard', () => {
  for (const [name, { schema, keys }] of Object.entries(FROZEN_REQUEST_SHAPES)) {
    it(`${name} request shape is unchanged (update the mirrors + CALLABLE_CONTRACT.md if this fails)`, () => {
      expect(shapeKeys(schema)).toEqual([...keys].sort());
    });
  }
});

// The nested / effects shapes, frozen by RECURSIVE signature. A rename at ANY
// depth (schema.sections[].fields[].required, a channel field, a nested
// criteria key) fails the guard, which a top-level freeze could not catch.
const FROZEN_DEEP_SHAPES: Record<string, { schema: z.ZodTypeAny; signature: string[] }> = {
  saveFormSchema: {
    schema: SaveFormSchemaArgs,
    signature: [
      'schema.appliesTo', 'schema.description', 'schema.id', 'schema.name',
      'schema.sections[].description',
      'schema.sections[].fields[].defaultValue', 'schema.sections[].fields[].group',
      'schema.sections[].fields[].helperText', 'schema.sections[].fields[].key',
      'schema.sections[].fields[].label', 'schema.sections[].fields[].options[]',
      'schema.sections[].fields[].placeholder', 'schema.sections[].fields[].required',
      'schema.sections[].fields[].type', 'schema.sections[].title', 'schema.version',
    ],
  },
  saveTemplate: {
    schema: SaveTemplateArgs,
    signature: [
      'body', 'category', 'description', 'html',
      'sectionDefinitions[].description', 'sectionDefinitions[].title',
      'subject', 'tags[]', 'templateId', 'title', 'usageInstructions',
    ],
  },
  broadcastMessage: {
    schema: BroadcastMessageArgs,
    signature: [
      'body', 'channels[]',
      'criteria.kind', 'criteria.statuses[]', 'criteria.tagMatch', 'criteria.tags[]',
      'segmentId', 'subject',
    ],
  },
  createTrainingDocument: {
    schema: CreateTrainingDocumentArgs,
    signature: [
      'attachments[].cloudinaryPublicId', 'attachments[].fileName', 'attachments[].fileType',
      'attachments[].mimeType', 'attachments[].storageUrl',
      'communicationType', 'content', 'notes',
      'targetKinId', 'targetKinfolkId', 'targetType', 'title',
    ],
  },
  updateTrainingDocument: {
    schema: UpdateTrainingDocumentArgs,
    signature: [
      'attachments[].cloudinaryPublicId', 'attachments[].fileName', 'attachments[].fileType',
      'attachments[].mimeType', 'attachments[].storageUrl',
      'communicationType', 'content', 'docId', 'notes',
      'targetKinId', 'targetKinfolkId', 'targetType', 'title',
    ],
  },
};

describe('AO-8 callable contract drift guard (deep / effects shapes)', () => {
  for (const [name, { schema, signature }] of Object.entries(FROZEN_DEEP_SHAPES)) {
    it(`${name} recursive request signature is unchanged`, () => {
      expect(shapeSignature(schema)).toEqual([...signature].sort());
    });
  }
});
/**
 * ERROR-SURFACE freeze, not a request-shape freeze.
 *
 * The two booking-note callables take identical request shapes and neither
 * changed here. What three clients now hand-mirror is their shared REJECTION:
 * the React admin, android and the household portal each branch on
 * `details.code` to tell "the note window closed" apart from "the write
 * broke", and each renders the message. A silent edit to either would leave
 * those branches matching nothing, which reads to a user as a button that does
 * nothing, the same failure mode the request-shape guard above exists to catch.
 *
 * The 3-hour value is frozen alongside them because two client mirrors compute
 * a courtesy lock from it (`bookingDetailFormat.ts`, `BookingNoteCutoff.kt`);
 * changing the server window without those would show an unlocked composer that
 * the callable then rejects.
 */
describe('AO-8 callable contract drift guard (booking note cutoff error surface)', () => {
  it('the cutoff window is unchanged', () => {
    expect(NOTE_CUTOFF_MS).toBe(3 * 60 * 60 * 1000);
  });
  it('the machine-readable detail code is unchanged', () => {
    expect(NOTE_CUTOFF_CODE).toBe('booking_note_cutoff');
  });
  it('the user-facing message is unchanged', () => {
    expect(NOTE_CUTOFF_MESSAGE).toBe(
      'Notes cannot be edited within 3 hours of booking start window.',
    );
  });
});
