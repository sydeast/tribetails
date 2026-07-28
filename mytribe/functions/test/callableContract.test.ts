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
// Task 5.1 invoice slice. `updateInvoice` is NESTED (its `patch` is an object)
// and carries a `.refine`, so it is frozen by RECURSIVE signature below, not by
// a top-level key freeze. archive/unarchive are flat.
import { Args as UpdateInvoiceArgs } from '../src/admin/updateInvoice';
import { Args as ArchiveInvoiceArgs } from '../src/admin/archiveInvoice';
import { Args as UnarchiveInvoiceArgs } from '../src/admin/unarchiveInvoice';
// The partial-payment detection/repair pass (2026-07-25).
import { Args as RepairInvoicePaymentsArgs } from '../src/admin/repairInvoicePayments';
// W2-1 (ADR-0002): the callables that absorb Android's direct Firestore money
// writes. Frozen from birth: Android's W2-2 mirror is built from these shapes.
import { Args as LinkInvoiceSessionsArgs } from '../src/admin/linkInvoiceSessions';
import { Args as RecordPaymentArgs } from '../src/admin/recordPayment';
// Shared catalog write reached by BOTH the kinfolk portal and the AuntieOS
// admin vet-clinic picker (Task 1.8). Two independent clients now build this
// payload, which is exactly the condition this guard exists for.
import { Args as SubmitVetClinicArgs } from '../src/portal/submitVetClinic';
// 17.3 Home dashboard layout (added 2026-07-25). Three surfaces parse the SAME
// stored token list: the React admin (auntieos-admin/src/lib/dashboardLayout.ts),
// android (ui/home/DashboardLayout.kt) and the superseded Compose web build.
import { Args as SaveDashboardLayoutArgs } from '../src/admin/saveDashboardLayout';
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
// Google Calendar free/busy sync (Task 7.1, 2026-07-25). The React admin
// (src/api/calendarSync.ts) and android (BookingRepository) both call it, and
// both READ the four receipt fields back off business_settings, so the field
// NAMES are as much a contract as the request shape. The calendar-id rule is
// mirrored in both clients too; its detail code is frozen at the foot of this
// file.
import {
  Args as SyncGoogleCalendarBusyEventsArgs,
  calendarSyncStamp,
  CALENDAR_SYNC_SA_EMAIL,
} from '../src/admin/syncGoogleCalendarBusyEvents';
import { CALENDAR_ID_INVALID_CODE, calendarIdProblem } from '../src/lib/calendarSyncId';
// Google Calendar over OAuth (Task 7.2, 2026-07-25). The same mirroring problem
// as 7.1 and a heavier one: the React admin (src/api/googleCalendar.ts,
// src/lib/googleCalendarTargets.ts) and android (AuntieRepository,
// ui/admin/scheduling/GoogleCalendarTargets.kt) both build these payloads, both
// read the connection projection field by field, and both mirror the
// write-target rule. The redirect URI is frozen too because it is
// OPERATOR-facing: it has to match, character for character, what is registered
// on the OAuth client in Google Cloud Console, and Google refuses the whole flow
// on any difference including a trailing slash.
import { SetTargetsArgs } from '../src/admin/googleCalendar/googleCalendarSelection';
import { Args as PushVisitsArgs } from '../src/admin/googleCalendar/pushVisitsToGoogleCalendar';
import {
  calendarPushStamp,
  connectStamp,
  connectionFromDoc,
  publicConnection,
} from '../src/lib/googleCalendarConnection';
import {
  GOOGLE_CALENDAR_NOT_CONNECTED_CODE,
  GOOGLE_OAUTH_NOT_CONFIGURED_CODE,
  GOOGLE_OAUTH_REVOKED_CODE,
  WRITE_CALENDAR_INVALID_CODE,
  writeCalendarProblem,
} from '../src/lib/googleCalendarTargets';
import { GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_OAUTH_SECRETS } from '../src/lib/googleOAuth';
// External send + the Inbox outbound mirror (2026-07-25). Three surfaces build
// this payload: the Communicate external panel, the Inbox reply composer
// (auntieos-admin/src/api/externalSend.ts) and android's AuntieRepository. It is
// a `.superRefine` effects wrapper, so it is frozen by RECURSIVE signature
// below. `mirrorToChannel` is the field that earns the freeze: it decides
// whether a recipient's number is written to `sms_messages` IN THE CLEAR, so a
// silent rename here is a privacy regression, not only a broken client.
import { Args as SendExternalMessageArgs } from '../src/admin/sendExternalMessage';
import { MIRROR_SKIPPED } from '../src/lib/smsChannelMirror';

/**
 * AO-8 drift guard (design doc
 * `auntieos-admin/docs/2026-07-18-AO5-AO8-shared-contract-design.md`
 * Option C). The AuntieOS admin (React), the Compose app (web + desktop) and the
 * android app each HAND-MIRROR these callable request shapes; nothing but review
 * discipline keeps the four in sync. This test freezes the request field set of
 * every cross-app widget callable, so a backend shape change (added / removed /
 * renamed field) trips a red test HERE, forcing a deliberate update + a look at
 * the three mirrors, instead of drifting silently until a client breaks.
 *
 * Canonical request + response shapes live in `functions/CALLABLE_CONTRACT.md`,
 * beside this test at the functions root, NOT under any `docs/` directory (the
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
  // zod 4 internals: `def.type` is a lowercase kind string (the v3
  // `_def.typeName` PascalCase names are gone), wrappers carry `innerType`,
  // arrays carry `element`, and ZodEffects no longer exists — .transform
  // builds a `pipe` (walk its input side) while .refine/.superRefine attach
  // checks to the same schema without wrapping it.
  const def = (schema as unknown as { def: { type: string; innerType?: z.ZodTypeAny; in?: z.ZodTypeAny; element?: z.ZodTypeAny } }).def;
  const typeName = def?.type;
  if (typeName === 'optional' || typeName === 'nullable' || typeName === 'default' || typeName === 'readonly' || typeName === 'catch') {
    return shapeSignature(def.innerType as z.ZodTypeAny, prefix);
  }
  if (typeName === 'pipe') {
    return shapeSignature(def.in as z.ZodTypeAny, prefix);
  }
  if (typeName === 'array') {
    return shapeSignature(def.element as z.ZodTypeAny, `${prefix}[]`);
  }
  if (typeName === 'object') {
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
  // NOTE: `createInvoice` USED to be frozen here and has MOVED to the deep
  // (recursive-signature) table below. Task 5.1 gave it a `lineItems` array of
  // objects, and a top-level key freeze would have gone on passing while
  // `lineItems[].unitCents` was renamed underneath it. That is the exact drift
  // this guard exists to catch, so the freeze followed the shape.
  createQuote: {
    schema: CreateQuoteArgs,
    keys: ['address', 'amountDue', 'client', 'date', 'discount', 'dueDate', 'familyId', 'invoiceNumber', 'kinfolkName', 'sendToKinfolk', 'sessionIds', 'status', 'terms', 'total'],
  },
  markInvoicePaid: { schema: MarkInvoicePaidArgs, keys: ['amount', 'invoiceId', 'method', 'paidAt', 'reference'] },
  // `mode` defaults to the read-only 'detect'; the destructive mode is always
  // named by the caller, so a shape change here is a change to how a billing
  // mass-write is triggered.
  repairInvoicePayments: {
    schema: RepairInvoicePaymentsArgs,
    keys: ['limit', 'mode', 'startAfterId'],
  },
  archiveInvoice: { schema: ArchiveInvoiceArgs, keys: ['force', 'invoiceId'] },
  unarchiveInvoice: { schema: UnarchiveInvoiceArgs, keys: ['invoiceId'] },
  // W2-1 (ADR-0002 callable-only invoice writes). Both replace direct Android
  // Firestore writes, so the mirror Android builds in W2-2 is built FROM these
  // frozen shapes. `sessionIds` is an array of plain strings (like
  // createQuote's), so the flat freeze stays accurate.
  linkInvoiceSessions: { schema: LinkInvoiceSessionsArgs, keys: ['invoiceId', 'sessionIds'] },
  recordPayment: {
    schema: RecordPaymentArgs,
    keys: [
      'address', 'amount', 'client', 'date', 'email', 'invoiceId', 'invoiceNumber',
      'kinfolkId', 'kinfolkName', 'notes', 'paymentMethod', 'referenceNumber', 'tip',
    ],
  },
  assignTemplate: { schema: AssignTemplateArgs, keys: ['active', 'audience', 'catalogKey', 'templateId', 'triggerKey'] },
  deleteTrainingDocument: { schema: DeleteTrainingDocumentArgs, keys: ['docId'] },

  // Shared vet catalog. `isEmergency` was added 2026-07-25 for the AuntieOS
  // picker; it is optional, so every legacy portal payload (the four fields
  // before it) still validates. The freeze is the SUPERSET.
  submitVetClinic: { schema: SubmitVetClinicArgs, keys: ['address', 'isEmergency', 'name', 'phone', 'website'] },

  // 17.3 operator dashboard layout. One key, so the top-level freeze is thin on
  // its own; the token-VALUE freeze below is the part that actually matters.
  saveDashboardLayout: { schema: SaveDashboardLayoutArgs, keys: ['tokens'] },

  // Task 7.1 calendar sync. One optional key, and it must STAY one: the calendar
  // id is resolved server-side from business_settings, never sent by a client,
  // so adding a `calendarId` here would let any admin client sync a calendar the
  // operator never saved. The receipt + error freezes below carry the rest.
  syncGoogleCalendarBusyEvents: {
    schema: SyncGoogleCalendarBusyEventsArgs,
    keys: ['lookAheadDays'],
  },

  // Task 7.2 OAuth calendars. `setGoogleCalendarTargets` is the only request in
  // this feature that names a calendar, and it must stay the only one: the push
  // takes no calendar id at all, so a client cannot aim our households' visits
  // at a calendar the operator never picked.
  setGoogleCalendarTargets: {
    schema: SetTargetsArgs,
    keys: ['enabledCalendarIds', 'writeCalendarId'],
  },
  pushVisitsToGoogleCalendar: { schema: PushVisitsArgs, keys: ['lookAheadDays'] },
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
  // MOVED here from the flat table in Task 5.1, when `lineItems` arrived. The
  // freeze is the SUPERSET: every key of the legacy 13-field payload is still
  // listed, so a caller that omits the two new optional fields still validates
  // and this guard still describes it accurately.
  createInvoice: {
    schema: CreateInvoiceArgs,
    signature: [
      'address', 'amountDue', 'client', 'date', 'discount', 'dueDate', 'familyId',
      'invoiceDiscountCents', 'invoiceNumber', 'kinfolkName',
      'lineItems[].description', 'lineItems[].discountCents',
      'lineItems[].qty', 'lineItems[].unitCents',
      // `sessionIds[]`, not `sessionIds`: the walker descends arrays, and a
      // string array's element is a leaf it still names.
      'sessionIds[]', 'status', 'terms', 'total',
    ],
  },
  updateInvoice: {
    schema: UpdateInvoiceArgs,
    signature: [
      'invoiceId',
      // `address`/`client`/`discount`/`kinfolkName` added in W2-1 (ADR-0002):
      // the descriptive fields Android's whole-model merge-set writes, so the
      // patch can express that write once Android re-points. All optional, so
      // every pre-existing payload still validates; the freeze is the SUPERSET.
      // `discount` is the legacy FREE-TEXT field, not money;
      // `invoiceDiscountCents` remains the computed one.
      'patch.address', 'patch.client',
      'patch.date', 'patch.discount', 'patch.dueDate', 'patch.invoiceDiscountCents',
      'patch.invoiceNumber', 'patch.kinfolkName',
      'patch.lineItems[].description', 'patch.lineItems[].discountCents',
      'patch.lineItems[].qty', 'patch.lineItems[].unitCents',
      'patch.terms',
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
  sendExternalMessage: {
    schema: SendExternalMessageArgs,
    signature: ['body', 'channel', 'mirrorToChannel', 'subject', 'to', 'transactional'],
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
/**
 * STORED-FIELD + ERROR-SURFACE freeze for the calendar sync.
 *
 * `syncGoogleCalendarBusyEvents` has a one-key request, so the shape freeze
 * above barely says anything. What two clients actually mirror is everything
 * around it: the four receipt fields they READ off `business_settings` to render
 * "last sync" without a callable of their own, the detail code they branch on to
 * tell a bad calendar id apart from a broken sync, and the service account
 * address they PRINT in their own setup copy. Rename any of those on the server
 * and the panels go quietly blank or start naming an account that cannot help.
 */
describe('AO-8 callable contract drift guard (calendar sync stored fields + errors)', () => {
  it('the receipt field names are unchanged (both clients read these off the settings doc)', () => {
    expect(Object.keys(calendarSyncStamp({ status: 'ok', imported: 1 }, 'now')).sort()).toEqual([
      'calendarSyncLastError',
      'calendarSyncLastImported',
      'calendarSyncLastRunAt',
      'calendarSyncLastStatus',
    ]);
  });

  it('the status values are the two both clients branch on', () => {
    expect(calendarSyncStamp({ status: 'ok', imported: 1 }, 'now').calendarSyncLastStatus).toBe('ok');
    expect(calendarSyncStamp({ status: 'error', error: 'x' }, 'now').calendarSyncLastStatus).toBe(
      'error',
    );
  });

  it('the bad-calendar-id detail code is unchanged', () => {
    expect(CALENDAR_ID_INVALID_CODE).toBe('calendar_id_invalid');
  });

  it('the service account the operator must share with is unchanged', () => {
    // Printed verbatim in the React panel's setup copy and android's field hint.
    expect(CALENDAR_SYNC_SA_EMAIL).toBe(
      'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com',
    );
  });

  it('the id rule agrees with the two client mirrors on the cases that matter', () => {
    // These five are the exact cases `auntieos-admin/src/lib/calendarSyncId.test.ts`
    // and `CalendarSyncIdTest.kt` assert. A server rule that drifts looser than
    // the clients blocks a legal id; drifting tighter lets one through to a
    // "0 imported" that reads as an empty calendar.
    expect(calendarIdProblem('abc@group.calendar.google.com')).toBeNull();
    expect(calendarIdProblem('auntie@tribetails.com')).toBeNull();
    expect(calendarIdProblem('primary')).not.toBeNull();
    expect(calendarIdProblem('team-cal')).not.toBeNull();
    expect(calendarIdProblem('')).not.toBeNull();
  });
});

/**
 * STORED-FIELD + ERROR-SURFACE + OPERATOR-SETUP freeze for the OAuth calendar
 * (Task 7.2).
 *
 * Three separate contracts hang off this feature and none of them is the request
 * shape frozen above:
 *   1. THE PROJECTION. Both clients render the connection panel straight off
 *      `publicConnection`, field by field. A rename blanks both panels, and,
 *      worse, an ADDED field could carry the refresh token out to a client, so
 *      the key set is frozen exactly rather than as a superset.
 *   2. THE DETAIL CODES. Both clients branch on `details.code` to tell "never
 *      set up" from "not connected" from "the grant was revoked", which are
 *      three different operator actions.
 *   3. THE OPERATOR SETUP STRINGS. The two secret names and the redirect URI are
 *      typed by a human into Google Cloud Console and into
 *      `firebase functions:secrets:set`. A change here is a change to an
 *      instruction someone already followed.
 */
describe('AO-8 callable contract drift guard (Google Calendar OAuth)', () => {
  it('the client projection carries every field the panels read and NO token', () => {
    const view = publicConnection(
      connectionFromDoc({ connected: true, refreshToken: '1//tok', googleAccountEmail: 'a@b.com' }),
    );
    expect(Object.keys(view).sort()).toEqual([
      'calendarPushLastError',
      'calendarPushLastPushed',
      'calendarPushLastRunAt',
      'calendarPushLastStatus',
      'connectLastAttemptAt',
      'connectLastError',
      'connectLastStatus',
      'connected',
      'connectedAt',
      'disconnectedAt',
      'disconnectedError',
      'enabledCalendarIds',
      'googleAccountEmail',
      'scopes',
      'writeCalendarId',
    ]);
    expect(JSON.stringify(view)).not.toContain('1//tok');
  });

  it('the two receipt shapes are unchanged (both clients read them off the projection)', () => {
    expect(Object.keys(connectStamp({ status: 'ok' }, 'now')).sort()).toEqual([
      'connectLastAttemptAt',
      'connectLastError',
      'connectLastStatus',
    ]);
    expect(Object.keys(calendarPushStamp({ status: 'ok', pushed: 1 }, 'now')).sort()).toEqual([
      'calendarPushLastError',
      'calendarPushLastPushed',
      'calendarPushLastRunAt',
      'calendarPushLastStatus',
    ]);
  });

  it('the status values are the two both clients branch on', () => {
    expect(connectStamp({ status: 'error', error: 'x' }, 'now').connectLastStatus).toBe('error');
    expect(calendarPushStamp({ status: 'ok', pushed: 0 }, 'now').calendarPushLastStatus).toBe('ok');
  });

  it('the four detail codes are unchanged', () => {
    expect(GOOGLE_OAUTH_NOT_CONFIGURED_CODE).toBe('google_oauth_not_configured');
    expect(GOOGLE_CALENDAR_NOT_CONNECTED_CODE).toBe('google_calendar_not_connected');
    expect(GOOGLE_OAUTH_REVOKED_CODE).toBe('google_oauth_revoked');
    expect(WRITE_CALENDAR_INVALID_CODE).toBe('write_calendar_invalid');
  });

  it('the operator-typed setup strings are unchanged', () => {
    // Both are printed in the React panel and android card setup copy, and both
    // are typed by hand into Google Cloud Console / the firebase CLI.
    expect(GOOGLE_OAUTH_SECRETS).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
    expect(GOOGLE_OAUTH_REDIRECT_URI).toBe(
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback',
    );
  });

  it('the write-target rule agrees with the two client mirrors on the cases that matter', () => {
    // These six are the exact cases `auntieos-admin/src/lib/googleCalendarTargets.test.ts`
    // and `GoogleCalendarTargetsTest.kt` assert. Note the deliberate DIFFERENCE
    // from the free/busy rule above: `primary` is legal here, because under
    // OAuth it means the operator's own real calendar rather than a robot's
    // permanently empty one.
    const account = 'auntie@tribetails.com';
    expect(writeCalendarProblem('primary', '', account)).toBeNull();
    expect(writeCalendarProblem('work@group.calendar.google.com', '', account)).toBeNull();
    expect(writeCalendarProblem('', '', account)).not.toBeNull();
    expect(writeCalendarProblem('team-cal', '', account)).not.toBeNull();
    // The echo loop, in both spellings of the same calendar.
    expect(writeCalendarProblem('shared@g.calendar.google.com', 'shared@g.calendar.google.com', account)).not.toBeNull();
    expect(writeCalendarProblem('primary', account, account)).not.toBeNull();
  });
});

/**
 * VALUE freeze, not a key freeze.
 *
 * `saveDashboardLayout` takes one field, so `shapeKeys` alone would pass even if
 * the token grammar changed completely. The grammar IS the contract here: the
 * React admin and android each build and parse these strings themselves
 * (`src/lib/dashboardLayout.ts`, `ui/home/DashboardLayout.kt`), and both read the
 * same stored list, so a size token renamed on the server would leave layouts
 * saved by one surface silently unreadable by the other. These cases pin what the
 * schema accepts and refuses.
 */
describe('AO-8 callable contract drift guard (dashboard layout token grammar)', () => {
  const parse = (tokens: unknown) => SaveDashboardLayoutArgs.safeParse({ tokens });
  it('accepts the two size tokens every renderer branches on', () => {
    expect(parse(['stats:wide', 'todaysPack:compact']).success).toBe(true);
  });
  it('refuses any third size token', () => {
    for (const bad of ['stats:huge', 'stats:full', 'stats:WIDE', 'stats:']) {
      expect(parse([bad]).success, `${bad} must be refused`).toBe(false);
    }
  });
  it('accepts an unrecognized KEY, so an older server cannot reject a newer client', () => {
    expect(parse(['someFutureWidget:compact']).success).toBe(true);
  });
  it('refuses a key that is not plain letters, which no client can produce', () => {
    for (const bad of ['stats row:wide', 'stats_row:wide', 'stats-row:wide', '2stats:wide', ':wide']) {
      expect(parse([bad]).success, `${bad} must be refused`).toBe(false);
    }
  });
  it('caps the list at 30, and an empty list stays legal (restore the default)', () => {
    expect(parse([]).success).toBe(true);
    expect(parse(Array.from({ length: 30 }, () => 'stats:wide')).success).toBe(true);
    expect(parse(Array.from({ length: 31 }, () => 'stats:wide')).success).toBe(false);
  });
});

/**
 * Task 5.2 branding. Two clients hand-mirror this payload (the React admin's
 * `api/brandAsset.ts`, and Android once it adopts the callable), and the shape
 * carries a NULL that means "remove" rather than "missing", which is exactly
 * the kind of detail a well-meaning tidy-up turns into `.optional()` and
 * silently breaks.
 *
 * Imported inside the block rather than at the top of this file on purpose: it
 * keeps every line this task added contiguous at the end, so a concurrent
 * branch editing the import header does not conflict with it.
 */
describe('callable contract drift guard (brand asset confirm/remove)', () => {
  it('freezes the top-level request keys', async () => {
    const { Args } = await import('../src/admin/confirmBrandAssetUpload');
    expect(Object.keys(Args.shape).sort()).toEqual(['kind', 'secureUrl']);
  });
  it('accepts exactly the two logo kinds, and no third', async () => {
    const { Args } = await import('../src/admin/confirmBrandAssetUpload');
    const url = 'https://res.cloudinary.com/tribetails/image/upload/a.png';
    for (const kind of ['businessLogo', 'portalLogo']) {
      expect(Args.safeParse({ kind, secureUrl: url }).success, `${kind} must be accepted`).toBe(true);
    }
    for (const bad of ['faviconLogo', 'businesslogo', 'BUSINESSLOGO', '']) {
      expect(Args.safeParse({ kind: bad, secureUrl: url }).success, `${bad} must be refused`).toBe(false);
    }
  });
  it('keeps null a LEGAL secureUrl, because null is the remove action', async () => {
    // If this ever becomes `.optional()` instead of `.nullable()`, an omitted
    // key would start meaning "remove", and every client that sends a partial
    // payload would silently clear the operator's logo.
    const { Args } = await import('../src/admin/confirmBrandAssetUpload');
    expect(Args.safeParse({ kind: 'businessLogo', secureUrl: null }).success).toBe(true);
    expect(Args.safeParse({ kind: 'businessLogo' }).success).toBe(false);
  });
  it('refuses a non-url string and an over-long one', async () => {
    const { Args } = await import('../src/admin/confirmBrandAssetUpload');
    expect(Args.safeParse({ kind: 'businessLogo', secureUrl: 'not-a-url' }).success).toBe(false);
    expect(Args.safeParse({ kind: 'businessLogo', secureUrl: `https://x.test/${'a'.repeat(2100)}` }).success).toBe(false);
  });
  it('pins the shared limits against the admin copy of them', async () => {
    // Duplicated in auntieos-admin/src/lib/brandAssetFile.ts (separate npm
    // package, no shared module). Pinned on both sides so a drift fails a build.
    const m = await import('../src/lib/brandAsset');
    expect(m.MAX_BRAND_ASSET_BYTES).toBe(5_000_000);
    expect(m.MIN_BRAND_ASSET_PX).toBe(48);
    expect(m.MAX_BRAND_ASSET_PX).toBe(4000);
    expect([...m.ACCEPTED_BRAND_ASSET_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(m.BRAND_ASSET_FOLDER).toBe('tribetails/business/business_settings');
  });
});
/**
 * Mirror-decision freeze. Two clients hand-mirror these three codes to decide
 * what the operator is told after a reply goes out, and the wrong branch is not
 * a cosmetic bug: it either promises a row in a list where none was written, or
 * it reads as a failed send and the operator texts the same person twice.
 *
 * The email refusal is frozen too. If `mirrorToChannel` ever became silently
 * ignored on email instead of rejected, a banner would claim an `sms_messages`
 * row for a send that touched only `emails`.
 */
describe('sendExternalMessage outbound mirror contract', () => {
  it('freezes the skip reason codes both clients branch on', () => {
    expect(MIRROR_SKIPPED.NOT_REQUESTED).toBe('not_requested');
    expect(MIRROR_SKIPPED.NO_EXISTING_THREAD).toBe('no_existing_thread');
    expect(MIRROR_SKIPPED.WRITE_FAILED).toBe('write_failed');
  });
  it('defaults mirrorToChannel to false, so a legacy payload never mirrors', () => {
    const parsed = SendExternalMessageArgs.parse({ channel: 'sms', to: '+14155552671', body: 'hi' });
    expect(parsed.mirrorToChannel).toBe(false);
  });
  it('accepts mirrorToChannel on sms', () => {
    const ok = SendExternalMessageArgs.safeParse({
      channel: 'sms',
      to: '+14155552671',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(ok.success).toBe(true);
  });
  it('REFUSES mirrorToChannel on email rather than ignoring it', () => {
    const bad = SendExternalMessageArgs.safeParse({
      channel: 'email',
      to: 'a@example.com',
      subject: 's',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(bad.success).toBe(false);
  });
});
/**
 * STORED-FIELD freeze for the Invoice State Stamp (ADR-0002).
 *
 * Not a request shape: the two fields every money-touching invoice callable
 * now PERSISTS onto `invoices/{id}` (`lib/invoiceStateStamp.ts`), which the
 * three clients will read in place of their own classifiers once those are
 * deleted. That makes the field NAMES, the eight status VALUES and the three
 * editScope VALUES a cross-app contract exactly like the calendar receipt
 * fields above: rename or respell any of them and three renderers go quietly
 * blank, plus every already-stamped doc in the collection becomes stale.
 * The backfill's skip check and the runbook both assume these exact strings.
 *
 * Imported inside the block rather than at the top of this file on purpose
 * (the confirmBrandAssetUpload precedent): it keeps every line this task
 * added contiguous at the end, so the parallel invoice-callables branch
 * editing the import header does not conflict with it.
 */
describe('callable contract drift guard (invoice state stamp stored fields)', () => {
  it('the stamp writes exactly the two fields clients will read', async () => {
    const { invoiceStateStampOf } = await import('../src/lib/invoiceStateStamp');
    const stamp = invoiceStateStampOf({ status: 'open', amountDue: 40, total: 40 }, 0);
    expect(Object.keys(stamp).sort()).toEqual(['editScope', 'status']);
  });
  it('the eight status values are unchanged, lowercase, in precedence order', async () => {
    const { INVOICE_STATES } = await import('../src/lib/invoiceEditPolicy');
    expect([...INVOICE_STATES]).toEqual([
      'quote',
      'draft',
      'cancelled',
      'credit',
      'redeemed',
      'paid',
      'zero',
      'open',
    ]);
    for (const s of INVOICE_STATES) expect(s).toBe(s.toLowerCase());
  });
  it('the three editScope values are unchanged', async () => {
    const { invoiceStateStampOf } = await import('../src/lib/invoiceStateStamp');
    // One representative doc per scope; the VALUES are what clients branch on.
    expect(invoiceStateStampOf({ status: 'draft' }, 0).editScope).toBe('all');
    expect(
      invoiceStateStampOf({ status: 'open', amountDue: 40, total: 40, totalCents: 4000 }, 4000)
        .editScope,
    ).toBe('metadataOnly');
    expect(invoiceStateStampOf({ status: 'cancelled' }, 0).editScope).toBe('none');
  });
  it('every stamped status is itself a legal classifier INPUT (the fixpoint clients rely on)', async () => {
    const { INVOICE_STATES, invoiceStateOf } = await import('../src/lib/invoiceEditPolicy');
    // A doc carrying a stamped status plus the money that produced it must
    // classify back to that status, or a stamp could go stale the moment it
    // was written. The per-state fixtures live in invoiceStateStamp.test.ts;
    // here the freeze only pins that the five label-read states round-trip on
    // the label alone.
    for (const s of ['quote', 'draft', 'cancelled', 'paid'] as const) {
      expect(invoiceStateOf({ status: s })).toBe(s);
    }
    expect(invoiceStateOf({ status: 'redeemed', creditRedeemedAt: 'ts' })).toBe('redeemed');
    expect(INVOICE_STATES).toContain('redeemed');
  });
});
