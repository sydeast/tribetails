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
 * #1839, lead decision: ONE line per look, not one per read. Opening a
 * household's profile fires several of these reads at once (the members, the
 * secondary Kinfolk, the emergency contacts), and the walk's complaint was four
 * lines for one look. So an Auntie's looks at one household share one line per
 * window of this length.
 *
 * Ten minutes: every read one screen open makes lands within seconds, and an
 * Auntie moving between a household's tabs or reopening its profile on the same
 * visit to the screen is still the same look. A return after that is a new look
 * and gets its own line, so the log still shows each separate time she came
 * back. The windows are fixed (they start on the clock's ten-minute marks), so
 * a look that straddles a mark can write two lines; that is the price of a key
 * every concurrent read computes the same way without reading anything first.
 */
export const HOUSEHOLD_LOOK_WINDOW_MS = 10 * 60 * 1000;

/**
 * The fixed `activity_log` document id for one Auntie's look at one household
 * in one window. Every read in the window computes the same id, and
 * `writeAuditEntry`'s `docId` writes it at most once, inside its transaction
 * and with `create` as the backstop, so concurrent reads on one screen open
 * cannot write two lines.
 */
export function householdLookDocId(uid: string, kinfolkId: string, nowMs: number): string {
  return `household_look_${uid}_${kinfolkId}_${Math.floor(nowMs / HOUSEHOLD_LOOK_WINDOW_MS)}`;
}

/** Firestore's "already exists" (gRPC status 6): another read in the window wrote the line first. */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * The Activity Log line for an Auntie's look at a household (#1839): her name
 * and the household's in the sentence, the household as the entry's target, and
 * the same `admin` / `staffRole` stamp `lib/auditActor.ts` puts on her other
 * lines so every client prints "Auntie". One per window (above). Best-effort: a
 * name that will not read falls back to plain words, and a line that will not
 * write never blocks the look. The words and the name readers load here, inside
 * her branch, so they stay out of every portal callable's cold start.
 */
async function recordAuntieLook(
  uid: string,
  kinfolkId: string,
  kinfolk: Record<string, unknown> | undefined,
  functionName: string,
): Promise<void> {
  // Taken before any await, so reads that arrive together share a window.
  const docId = householdLookDocId(uid, kinfolkId, Date.now());
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
      // One line stands for every read in the window, so the sentence names
      // the household, not the one read that happened to land first. The
      // payload keeps that first read as evidence.
      description: auntieHouseholdLookWords(name, household),
      payload: { function: functionName, kinfolkId, admin: false, staffRole: STAFF_ROLE_AUNTIE },
      docId,
    });
  } catch (err) {
    // A read that lost the race to write the window's line is the design
    // working, not a failure.
    if (isAlreadyExists(err)) return;
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }
}
