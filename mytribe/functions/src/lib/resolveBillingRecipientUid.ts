import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { resolveKinfolkUid } from './resolveKinfolkUid';

/**
 * WHO IN THE HOUSEHOLD HEARS ABOUT MONEY (#1005).
 *
 * Every invoice, receipt, reminder, overdue and payment notice used to go to
 * `resolveKinfolkUid`, which reads `kinfolk/{id}.uid`. That field is a
 * backwrite from `syncKinfolkClaim`, stamped by whichever client doc synced
 * last. A SECONDARY accepting an invite syncs, so from then on the household's
 * bills, amounts and receipts went to the secondary, billing access or not.
 * An owner stepping into a household through the tribe picker syncs too.
 *
 * Operator ruling 2026-09-27: billing access is the owner or admin, the
 * PRIMARY, and a SECONDARY only when the PRIMARY granted `billing_full`. So:
 *
 *   backwrite uid is an ACTIVE member with billing access  -> that uid
 *     (the PRIMARY, or a SECONDARY holding `billing_full`; unchanged from before)
 *   backwrite uid is a member WITHOUT billing access       -> the household's
 *     ACTIVE PRIMARY instead, or null when there is none
 *   backwrite uid has NO member doc                        -> the ACTIVE PRIMARY
 *     when the household has one; otherwise the uid itself, because a household
 *     with no PRIMARY member predates the member model and its one account is
 *     its primary (the same anti-lockout `hasKinfolkPerm` makes)
 *   no backwrite uid                                       -> the ACTIVE PRIMARY,
 *     or null
 *
 * Null means "no household recipient", which every caller already handles as a
 * household with no portal account: the office copy still goes out.
 *
 * Only money notices use this. Visit, KinTale and profile notices stay on
 * `resolveKinfolkUid`; they carry no amounts.
 *
 * Read errors propagate, exactly as `resolveKinfolkUid`'s do. Falling back to
 * the backwrite uid on an error would send the amount to the very member this
 * exists to skip.
 */
export async function resolveBillingRecipientUid(kinfolkId: string): Promise<string | null> {
  const uid = await resolveKinfolkUid(kinfolkId);
  const members = db().collection('families').doc(kinfolkId).collection('members');

  if (uid) {
    const snap = await members.doc(uid).get();
    if (snap.exists) {
      const m = (snap.data() ?? {}) as Record<string, unknown>;
      const perms = (m['permissions'] ?? {}) as Record<string, unknown>;
      if (m['status'] === 'ACTIVE' && (m['role'] === 'PRIMARY' || perms['billing_full'] === true)) {
        return uid;
      }
      const primary = await activePrimaryUid(kinfolkId);
      logEvent({
        severity: 'info',
        function: 'resolveBillingRecipientUid',
        event: 'notification.billing.recipient.redirected',
        uid,
        familyId: kinfolkId,
        extra: { reason: 'no_billing_access', redirectedTo: primary === null ? 'none' : 'primary' },
      });
      return primary;
    }
    return (await activePrimaryUid(kinfolkId)) ?? uid;
  }
  return activePrimaryUid(kinfolkId);
}

/**
 * The household's ACTIVE PRIMARY. Queried on role alone and filtered on status
 * here, so no composite index is needed. A household has one PRIMARY; if a
 * defect ever left two, the first ACTIVE one wins and it is logged.
 */
async function activePrimaryUid(kinfolkId: string): Promise<string | null> {
  const q = await db()
    .collection('families')
    .doc(kinfolkId)
    .collection('members')
    .where('role', '==', 'PRIMARY')
    .get();
  const active = q.docs.filter((d) => (d.data() as Record<string, unknown>)['status'] === 'ACTIVE');
  if (active.length > 1) {
    logEvent({
      severity: 'warn',
      function: 'resolveBillingRecipientUid',
      event: 'notification.billing.recipient.multiple_primaries',
      familyId: kinfolkId,
      extra: { count: active.length },
    });
  }
  return active[0]?.id ?? null;
}
