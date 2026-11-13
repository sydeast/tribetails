import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { isAuntieClaim, isOwner, type StaffToken } from './staffGate';
import { STAFF_ROLE_AUNTIE } from './auntieAccess';
import { resolveNonStaffKinfolkId } from './resolveNonStaffKinfolkId';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';

export interface ResolvedKinfolkAccess {
  kinfolkId: string;
  isOperator: boolean;
}

/**
 * Resolves the kinfolkId a portal callable should operate on, given the caller
 * uid and the optional requested kinfolkId.
 *
 * Non-staff: delegated wholesale to `resolveNonStaffKinfolkId`, which is the
 * one place the own-household discriminator lives (empty ids, omitted-or-`''`
 * with one id, omitted-or-`''` with more than one, requested in/not in the
 * set). See that file for the per-case table and the PR28a/PR28b rationale.
 * It performs the same single `clients/{uid}` read this function used to do
 * inline, so a non-staff call still costs exactly one read.
 *
 * Staff (RULING O-6: `admin` claim, or the AUNTIE_OPERATOR_UIDS transition
 * fallback — see `isOwner`):
 *   - any requested kinfolkId   -> ok, IF it exists (existence check —
 *     RULING O-6 hardening 1). An AUNTIE's look at a household is
 *     audit-logged in plain words with her name (hardening 2). The OWNER's own
 *     looks write nothing (#1839, operator ruling 2026-11-12, which reverses
 *     hardening 2 for the owner only): the Activity Log is hers, and a line for
 *     every screen she opens buried the lines that matter. A write she makes
 *     still records its own line from the callable that made it.
 *   - omitted, has own ids      -> defaults to first own id
 *   - omitted, no own ids       -> failed-precondition (client must pick from directory)
 *
 * Use this helper in every portal callable that takes a kinfolkId arg —
 * READS AND WRITES (sendKinfolkMessage, requestBookingCancellation, etc.
 * intentionally use this resolver too: staff acting on a household's
 * messages/bookings as part of the job is the intended contract, audited by
 * hardening 2 above, not a special case to avoid).
 *
 * `caller` is the request's `auth`. The staff flag alone cannot tell the owner
 * from an Auntie (`staffBypass` is true for both), so a callable an Auntie can
 * reach MUST pass it, or her looks go unrecorded. `test/auntieHouseholdLook.test.ts`
 * holds every such callable to that.
 */
export async function resolveKinfolkAccess(
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
  caller?: { token?: StaffToken },
): Promise<ResolvedKinfolkAccess> {
  const staff = isOwner(uid, hasAdminClaim, functionName);

  if (staff) {
    // The `clients/{uid}` read lives inside this branch, not above it: the
    // non-staff tail below delegates to a helper that does its own read, so
    // hoisting it would double-read every non-staff call.
    const clientSnap = await db().collection('clients').doc(uid).get();
    const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
    // Caretaker first, the precedence every #944 gate uses.
    const auntie = isAuntieClaim(caller?.token);
    if (requested) {
      const kinSnap = await db().collection('kinfolk').doc(requested).get();
      if (!kinSnap.exists) {
        throw new HttpsError('not-found', 'kinfolkId not found.');
      }
      // Her own kinfolkIds are tribes she was assigned, never a household of
      // her own, so a look there is a look at a household too.
      if (auntie) await recordAuntieLook(uid, requested, kinSnap.data(), functionName);
      return { kinfolkId: requested, isOperator: true };
    }
    if (allowedIds.length > 0) {
      if (auntie) await recordAuntieLook(uid, allowedIds[0], undefined, functionName);
      return { kinfolkId: allowedIds[0], isOperator: true };
    }
    throw new HttpsError(
      'failed-precondition',
      'Operator must specify a kinfolkId (no default available).',
    );
  }

  // Non-staff. This used to be a hand-copy of the discriminator that PR28b
  // extracted into `resolveNonStaffKinfolkId` for the four staff-blind write
  // callables; the two were the same discriminator apart from two message
  // strings and the return shape (this one carries `isOperator`), so they are
  // now one. The delegation runs in this direction only:
  // the helper still has no staff branch, which is exactly why those four
  // callables must NOT be routed back through this function: under RULING O-6
  // that would hand them a cross-tenant operator bypass.
  return { kinfolkId: await resolveNonStaffKinfolkId(uid, requested), isOperator: false };
}

/**
 * One Activity Log line for an Auntie's look at a household (#1839): her name
 * and the household's in the sentence, the household as the entry's target, and
 * the same `admin` / `staffRole` stamp `lib/auditActor.ts` puts on her other
 * lines so every client prints "Auntie". Best-effort: a name that will not read
 * falls back to plain words, and a line that will not write never blocks the
 * look. The words and the name readers load here, inside her branch, so they
 * stay out of every portal callable's cold start.
 */
async function recordAuntieLook(
  uid: string,
  kinfolkId: string,
  kinfolk: Record<string, unknown> | undefined,
  functionName: string,
): Promise<void> {
  try {
    const [{ auntieHouseholdLookWords }, { resolveStaffIdentities }] = await Promise.all([
      import('./activityWords.js'),
      import('./staffIdentity.js'),
    ]);
    const doc = kinfolk ?? (await db().collection('kinfolk').doc(kinfolkId).get().catch(() => undefined))?.data();
    const part = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const household = [part(doc?.['firstName']), part(doc?.['lastName'])].filter((s) => s !== '').join(' ');
    const name = await resolveStaffIdentities([uid], functionName)
      .then((ids) => ids[0]?.displayName ?? '')
      .catch(() => '');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: kinfolkId,
      familyId: kinfolkId,
      description: auntieHouseholdLookWords(name, functionName, household),
      payload: { function: functionName, kinfolkId, admin: false, staffRole: STAFF_ROLE_AUNTIE },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
}
