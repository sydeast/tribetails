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
import { findLinkedHouseholds, readClinicFields, isClinicArchived } from '../lib/vetClinicCatalog';

/**
 * Retires a clinic from the shared catalog, or brings it back.
 *
 * ARCHIVE, NOT DELETE, and the reason is the reference shape rather than a
 * general preference for soft deletes.
 *
 * A household stores `vetClinicId` (or `emergencyVetClinicId`) pointing at a
 * `vet_clinics` doc, plus a denormalized copy of that clinic's name, phone and
 * address. Firestore has no referential integrity and nothing in this repo
 * sweeps for orphans, so a hard delete leaves every linked household holding an
 * id that resolves to nothing. Two things follow, and the second is the one
 * that decided this:
 *
 *  1. The household's vet silently becomes an "unlinked legacy" record, the
 *     pre-2026-07-25 state the clients already tolerate. Recoverable, but the
 *     household is now unreachable by `updateVetClinic`'s fan-out, so it can
 *     never be corrected in bulk again. A hard delete would quietly opt those
 *     households out of the very repair path this change exists to build.
 *  2. Nothing records what the clinic WAS. If a phone number turns out to have
 *     been wrong, the archived row is the evidence of what households were told
 *     to dial and when. A deleted row cannot answer that.
 *
 * The two Kotlin clients hard-delete today (`AuntieRepository.kt:2215`,
 * `FirestoreInterop.wasmJs.kt:1064`), including on "reject a pending
 * submission". Archive covers rejection too: an archived, `verified: false` row
 * is invisible everywhere a rejected submission should be invisible, and it
 * still says who submitted it.
 *
 * WHAT ARCHIVING DOES NOT DO: it does not touch the households. Their
 * denormalized name/phone/address stay exactly as they were, because the
 * doorstep read must not go blank when the operator tidies the catalog. An
 * archived clinic disappears from the pickers and from `getVetClinics`; a
 * household already on it keeps reading the number it always read.
 *
 * There is deliberately NO hard-delete callable. If one is ever wanted, it
 * needs a rule for what happens to the linked households, and that is a
 * product decision this callable does not have a mandate to make.
 */
// Exported so `test/callableContract.test.ts` can freeze the request shape.
export const Args = z.object({
  clinicId: z.string().trim().min(1, 'A clinic id is required.').max(200),
  /**
   * `false` unarchives. One callable rather than an archive/unarchive pair,
   * matching the set-and-clear-on-one-doc convention in CALLABLE_CONTRACT.md.
   */
  archived: z.boolean(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    clinicId: z.string().min(1),
    archived: z.boolean(),
    /**
     * Households still pointing at this clinic. Returned so the manager UI can
     * say "3 households still use this" after an archive rather than implying
     * the clinic vanished from their records, which it does not.
     */
    householdCount: z.number().int().min(0),
  })
  .strict();

export async function archiveVetClinicHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'archiveVetClinic validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('vet_clinics').doc(args.clinicId);
  const snap = await ref.get();
  if (!snap.exists) {
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED,
      severity: 'warn',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.clinicId,
      targetCollection: 'vet_clinics',
      description: `Vet clinic archive refused: '${args.clinicId}' not found`,
      payload: { refusalCode: 'vet_clinic_not_found', clinicId: args.clinicId },
    }).catch(() => undefined);
    throw new HttpsError('not-found', `Clinic '${args.clinicId}' not found.`, {
      code: 'vet_clinic_not_found',
    });
  }

  const stored = (snap.data() ?? {}) as Record<string, unknown>;
  const fields = readClinicFields(stored);

  // Refused rather than treated as a no-op success: two operators tidying the
  // same catalog should be told the row already moved, not shown a green toast
  // that implies their click is what moved it.
  if (isClinicArchived(stored) === args.archived) {
    const message = args.archived
      ? `'${fields.name}' is already archived.`
      : `'${fields.name}' is not archived.`;
    const code = args.archived ? 'vet_clinic_already_archived' : 'vet_clinic_not_archived';
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED,
      severity: 'warn',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.clinicId,
      targetCollection: 'vet_clinics',
      description: `Vet clinic archive refused: ${message}`,
      payload: { refusalCode: code, clinicId: args.clinicId, name: fields.name },
    }).catch(() => undefined);
    throw new HttpsError('failed-precondition', message, { code });
  }

  const linked = await findLinkedHouseholds(db(), args.clinicId);

  await ref.set(
    {
      archived: args.archived,
      // Cleared rather than left stale on unarchive, so the pair of fields can
      // never disagree about whether the row is currently retired.
      archivedAt: args.archived ? FieldValue.serverTimestamp() : null,
      archivedBy: args.archived ? uid : '',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.VET_CLINIC_ARCHIVED,
    // Retiring a clinic households still use is the case worth finding later.
    severity: args.archived && linked.length > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.clinicId,
    targetCollection: 'vet_clinics',
    description: `Vet clinic '${fields.name}' ${args.archived ? 'archived' : 'restored'}${
      args.archived && linked.length > 0 ? `, still used by ${linked.length} household(s)` : ''
    }`,
    payload: {
      clinicId: args.clinicId,
      name: fields.name,
      archived: args.archived,
      householdCount: linked.length,
      householdIds: linked,
      wasPending: stored['verified'] === false,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'archiveVetClinic',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'archiveVetClinic',
    event: 'admin.vetClinic.archived',
    uid,
    extra: { clinicId: args.clinicId, archived: args.archived, householdCount: linked.length },
  });

  return { ok: true, clinicId: args.clinicId, archived: args.archived, householdCount: linked.length };
}

export const archiveVetClinic = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('archiveVetClinic', archiveVetClinicHandler),
);
