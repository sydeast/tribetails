import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  clinicMatchCandidates,
  acknowledgesAll,
  type ClinicCandidate,
} from '../lib/vetClinicMatch';

/**
 * Exported for `test/callableContract.test.ts`: three clients now build this
 * payload (the kinfolk portal, the AuntieOS React admin, and Android), so the
 * field set is frozen there.
 *
 * `isEmergency` is OPTIONAL with a `false` default, which is what keeps every
 * payload written before 2026-07-25 valid: the portal has never sent it and
 * still does not. It is not `.coerce`d, because "yes" or 1 arriving from a
 * mis-wired client should fail loudly rather than quietly flag a clinic as a
 * 24-hour emergency room that it is not.
 */
export const Args = z.object({
  name: z.string().trim().min(1, 'A clinic name is required.').max(160),
  phone: z.string().trim().max(40).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  website: z.string().trim().max(400).optional().default(''),
  isEmergency: z.boolean().optional().default(false),
  /**
   * The ids of the near-matches the caller was shown and the user chose NOT to
   * use. Having ALL current candidates listed here is what authorizes a create.
   *
   * Deliberately NOT a `confirmCreate: true` boolean. A boolean can be set by
   * any client that never rendered anything, which would defeat the ruling. The
   * only way to know these ids is to have been handed them by the previous
   * call, so echoing them back is evidence the user saw the choice. See
   * `lib/vetClinicMatch.ts#acknowledgesAll`.
   */
  acknowledgedMatchIds: z.array(z.string().min(1).max(200)).max(20).optional().default([]),
});

/**
 * The RESPONSE shape. Exported for the contract guard, and `.strict()` so an
 * added field is reported rather than absorbed.
 *
 * `status` is the field to branch on:
 *   'created'      a clinic was written; `clinicId` is it.
 *   'needs_choice' NOTHING was written. `candidates` are possible matches the
 *                  user must choose between: select one of them, or re-call
 *                  with their ids in `acknowledgedMatchIds` to create anyway.
 */
export const Result = z
  .object({
    status: z.enum(['created', 'needs_choice']),
    /** The new clinic's id, or '' when the caller still has a choice to make. */
    clinicId: z.string(),
    /** True only on `status: 'created'`. Kept for callers that branch on it. */
    created: z.boolean(),
    /** True for a kinfolk submission awaiting approval; false for staff writes. */
    pending: z.boolean(),
    candidates: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        address: z.string(),
        phone: z.string(),
        isEmergency: z.boolean(),
        verified: z.boolean(),
        reason: z.enum(['name', 'phone', 'similar']),
      }),
    ),
  })
  .strict();

/**
 * Kinfolk-facing and operator-facing "add a vet that isn't on the list".
 * Firestore rules block ALL direct client writes to `vet_clinics`, so this
 * admin-SDK callable is the only create path.
 *
 * A kinfolk submission lands PENDING (`verified: false`) tagged with
 * `submittedBy`; the operator approves it in AuntieOS, which is when it becomes
 * visible to other households via `getVetClinics`.
 *
 * STAFF BRANCH (2026-07-25): the AuntieOS vet-clinic picker creates through
 * this same callable, and an operator typing a clinic into a household's record
 * IS the curation step. Landing it pending would queue the operator's own entry
 * for the operator's own approval, and the clinic would be invisible to every
 * household until they did that. So a staff caller lands `verified: true`.
 *
 * THE DEDUPE IS NOW A CHOICE, NOT A SUBSTITUTION (operator ruling 2026-08-01:
 * "If the 'created' vet matches one already in the system, we give kinfolk to
 * select the vet found in our system or to go ahead and create this new vet
 * clinic").
 *
 * This used to normalize the name, find the first clinic that matched, and
 * return THAT clinic's id with `created: false`. The caller asked to create and
 * silently got somebody else's record. Two practices genuinely can share a name
 * in different cities, so a household adding its own vet could be quietly
 * pointed at a different one, with a different phone number, on the record
 * somebody reads in an emergency.
 *
 * Now a match returns `status: 'needs_choice'` with the candidates and writes
 * nothing. The client renders them. Selecting an existing clinic is purely
 * client-side (it already has the id and calls nothing at all); creating anyway
 * re-calls with those ids in `acknowledgedMatchIds`, which is what proves the
 * user was shown the match. See `lib/vetClinicMatch.ts` for why the match test
 * is deliberately wider than normalized-name-only, and why a false positive is
 * cheap once the user is the one deciding.
 */
export async function submitVetClinicHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid clinic.');
  }
  const args = parsed.data;

  // Small collection; a full read is fine and keeps the match rule in one place.
  const snap = await db().collection('vet_clinics').get();
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));

  const candidates: ClinicCandidate[] = clinicMatchCandidates(args.name, args.phone, rows);

  if (candidates.length > 0 && !acknowledgesAll(candidates, args.acknowledgedMatchIds)) {
    logEvent({
      severity: 'info',
      function: 'submitVetClinic',
      event: 'portal.vetClinic.choiceOffered',
      uid,
      extra: { count: candidates.length, candidateIds: candidates.map((c) => c.id) },
    });
    return { status: 'needs_choice', clinicId: '', created: false, pending: false, candidates };
  }

  const staff = isStaff(uid, req.auth?.token?.admin === true, 'submitVetClinic');

  const ref = await db().collection('vet_clinics').add({
    name: args.name,
    phone: args.phone,
    address: args.address,
    website: args.website,
    googleMapsUrl: '',
    hours: '',
    isEmergency: args.isEmergency,
    verified: staff,
    archived: false,
    submittedBy: uid,
    notes: '',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logEvent({
    severity: 'info',
    function: 'submitVetClinic',
    event: 'portal.vetClinic.submitted',
    uid,
    extra: {
      clinicId: ref.id,
      name: args.name,
      verified: staff,
      // Recorded so the trail shows a deliberate duplicate accepted AFTER the
      // user was shown the alternatives, rather than a blind create.
      overrodeMatches: candidates.map((c) => c.id),
    },
  });
  return { status: 'created', clinicId: ref.id, created: true, pending: !staff, candidates: [] };
}

export const submitVetClinic = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('submitVetClinic', submitVetClinicHandler),
);
