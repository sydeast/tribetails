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
import { normClinicName, findLinkedHouseholds, readClinicFields } from '../lib/vetClinicCatalog';

/**
 * Corrects one clinic in the shared `vet_clinics` catalog, and pushes the
 * correction out to every household linked to it.
 *
 * WHY THIS EXISTS (punchlist B4). The catalog had a create (`submitVetClinic`)
 * and a read (`getVetClinics`) and no update on the server at all. The two
 * Kotlin trees filled the gap with a direct `vet_clinics` write under
 * `firestore.rules` `write: if isAuntie()`, which meant a clinic's phone number
 * could be changed with no validation, no dedupe check, and no audit entry, and
 * the React admin could not change it at all. A clinic entered with a wrong
 * phone number could not be corrected from the live admin, and that number is
 * what somebody reads in an emergency.
 *
 * THIS IS WHAT MAKES THE EMERGENCY NUMBER FIXABLE. `household_data` holds the
 * canonical household vet (operator ruling 2026-08-01) as a CLINIC ID, and
 * resolves the name, phone, address and hours through this row at read time.
 * There is exactly one copy of a clinic's details in the product, so a
 * correction here is not propagated to households, it simply IS what every
 * linked household reads from the next render on. `householdCount` reports how
 * far the change reaches; nothing is written to any household.
 *
 * THIS IS A WHOLE-RECORD SAVE, not a patch. The clients edit a clinic in a form
 * seeded from the current row, so an omitted optional field means "cleared",
 * not "unchanged". Sending a patch shape instead would make clearing a wrong
 * address impossible, which is the same class of defect as not being able to
 * correct the phone.
 */
// Exported so `test/callableContract.test.ts` can freeze the request shape.
// Frozen from birth: two clients (React admin + Android) build this payload.
export const Args = z.object({
  clinicId: z.string().trim().min(1, 'A clinic id is required.').max(200),
  name: z.string().trim().min(1, 'A clinic name is required.').max(160),
  phone: z.string().trim().max(40).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  website: z.string().trim().max(400).optional().default(''),
  /** Opening hours. Lives on the clinic, not the household. See A2 migration. */
  hours: z.string().trim().max(160).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
  /**
   * Not `.coerce`d, for the same reason `submitVetClinic` refuses to coerce it:
   * a mis-wired client sending "yes" should fail loudly rather than quietly
   * flag a clinic as a 24-hour emergency room that it is not.
   */
  isEmergency: z.boolean().optional().default(false),
  /**
   * Approving a pending kinfolk submission is this same call with
   * `verified: true`, rather than a sibling `approveVetClinic`. Omitted leaves
   * the stored value alone, so an ordinary edit of a pending row cannot
   * accidentally approve it.
   */
  verified: z.boolean().optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    clinicId: z.string().min(1),
    /** Households linked to this clinic, which now read the corrected details. */
    householdCount: z.number().int().min(0),
  })
  .strict();

export async function updateVetClinicHandler(
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
      throw new HttpsError('invalid-argument', 'updateVetClinic validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  /** Records a refusal before throwing it. Best-effort: never masks the refusal. */
  async function refuse(code: string, message: string): Promise<never> {
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED,
      severity: 'warn',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.clinicId,
      targetCollection: 'vet_clinics',
      description: `Vet clinic update refused: ${message}`,
      payload: { refusalCode: code, clinicId: args.clinicId, name: args.name },
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'updateVetClinic',
        event: 'audit.write.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    });
    throw new HttpsError('failed-precondition', message, { code });
  }

  const ref = db().collection('vet_clinics').doc(args.clinicId);
  const snap = await ref.get();
  if (!snap.exists) {
    // not-found rather than failed-precondition, so a client can tell a stale
    // list apart from a rule it broke.
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED,
      severity: 'warn',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.clinicId,
      targetCollection: 'vet_clinics',
      description: `Vet clinic update refused: '${args.clinicId}' not found`,
      payload: { refusalCode: 'vet_clinic_not_found', clinicId: args.clinicId },
    }).catch(() => undefined);
    throw new HttpsError('not-found', `Clinic '${args.clinicId}' not found.`, {
      code: 'vet_clinic_not_found',
    });
  }

  const stored = (snap.data() ?? {}) as Record<string, unknown>;
  const before = readClinicFields(stored);

  // A rename onto another row's name would leave the bank holding two clinics
  // the dedupe in `submitVetClinic` considers identical, and every later
  // create would resolve to an arbitrary one of them. Refused rather than
  // merged: merging two clinics is a decision about which households move, and
  // this callable has no mandate to make it.
  const wanted = normClinicName(args.name);
  if (wanted !== normClinicName(before.name)) {
    const all = await db().collection('vet_clinics').get();
    const clash = all.docs.find((d) => {
      if (d.id === args.clinicId) return false;
      const n = (d.data() as Record<string, unknown>)['name'];
      return typeof n === 'string' && normClinicName(n) === wanted;
    });
    if (clash) {
      await refuse(
        'vet_clinic_duplicate_name',
        `Another clinic is already called '${args.name}'. Rename that one, or edit it instead of creating a second copy.`,
      );
    }
  }

  const after = {
    name: args.name,
    phone: args.phone,
    address: args.address,
    website: args.website,
    hours: args.hours,
    isEmergency: args.isEmergency,
    notes: args.notes,
  };

  await ref.set(
    {
      ...after,
      ...(args.verified === undefined ? {} : { verified: args.verified }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // Read purely to REPORT reach. No household is written to: `household_data`
  // holds the clinic id and resolves the details through this row, so every
  // linked household is already correct the moment the write above lands.
  const linked = await findLinkedHouseholds(db(), args.clinicId);

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.VET_CLINIC_UPDATED,
    // A correction that changes what a linked household reads is worth more
    // than an info line when someone reads the trail after a bad edit.
    severity: linked.length > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.clinicId,
    targetCollection: 'vet_clinics',
    description: `Vet clinic '${args.name}' updated${
      linked.length > 0 ? `, read by ${linked.length} household(s)` : ''
    }`,
    payload: {
      clinicId: args.clinicId,
      name: args.name,
      phoneChanged: before.phone !== after.phone,
      nameChanged: before.name !== after.name,
      addressChanged: before.address !== after.address,
      householdCount: linked.length,
      householdIds: linked,
      verifiedSet: args.verified,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'updateVetClinic',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'updateVetClinic',
    event: 'admin.vetClinic.updated',
    uid,
    extra: { clinicId: args.clinicId, householdCount: linked.length },
  });

  return { ok: true, clinicId: args.clinicId, householdCount: linked.length };
}

export const updateVetClinic = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('updateVetClinic', updateVetClinicHandler),
);
