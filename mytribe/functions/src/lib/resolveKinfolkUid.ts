import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * WHO IN A HOUSEHOLD A NOTICE MAY GO TO (#1840): a login that is an ACTIVE
 * member of `families/{kinfolkId}/members`, and nobody else.
 *
 *   `kinfolk/{id}.uid` is blank                       -> null
 *   that login is an ACTIVE member of the household   -> that login
 *   that login is NOT an active member                -> the household's ACTIVE
 *     PRIMARY when it has one, otherwise null
 *
 * WHY THE STORED UID IS NOT ENOUGH. `kinfolk.uid` is a backwrite, not a
 * membership record. `syncKinfolkClaim` stamps it for whichever `clients/{uid}`
 * document last listed the household in `kinfolkIds`, and that list is written
 * without anyone joining the household: `seedDemoKinfolk --link-uid` and
 * `qa_enable_sandbox_login` set it for a tester's login, and staff assigned a
 * tribe sync the same way (#984). When that login is a staff account, the
 * household's "portal login" becomes the Admin. On the Nov 10 walk an
 * unclaimed household's On-the-way and cancel notices were emailed to the
 * Admin's own login that way, while the Members panel, which reads
 * `families/{id}/members`, said nobody had claimed it. #1805 made the confirm
 * text and the server agree with each other on `kinfolk.uid`, and so both
 * agreed with the bad value.
 *
 * The member record is what a real sign-up leaves behind: `acceptInvite` is the
 * only way a person joins a household, and it writes the ACTIVE member doc in
 * the same transaction that lists the household on their client record. A
 * staff login passes only when it holds such a record for THIS household,
 * which is the one case where a staff person really is the household.
 *
 * WHY THE PRIMARY WHEN THE STORED LOGIN IS NOT A MEMBER. A staff login landing
 * in the backwrite of a household that HAS been claimed must not silence that
 * household: its PRIMARY is still a member and is still who the Members panel
 * shows. `resolveBillingRecipientUid` has made the same redirect since #1005.
 *
 * A BLANK UID STAYS NOBODY, with no look at the members. `revokeKinfolkClaim`
 * unlinks a login by blanking `kinfolk.uid` and leaves the member doc ACTIVE,
 * so reading members there would keep sending to a login the operator
 * unlinked (#1802).
 *
 * Every member read is under the household's own id, so a login can never be
 * confirmed by its membership of a different household.
 *
 * Callers treat null as a household with no portal sign-in: nothing goes to
 * the household, the office copy still does. Read errors propagate.
 */
export async function resolveKinfolkUid(kinfolkId: string): Promise<string | null> {
  const snap = await db().collection('kinfolk').doc(kinfolkId).get();
  const uid = (snap.data() as { uid?: unknown } | undefined)?.uid;
  if (typeof uid !== 'string' || uid.trim() === '') return null;

  const memberSnap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  const status = memberSnap.exists
    ? (memberSnap.data() as { status?: unknown } | undefined)?.status
    : undefined;
  if (status === 'ACTIVE') return uid;

  const primary = await activePrimaryUid(kinfolkId);
  logEvent({
    severity: 'warn',
    function: 'resolveKinfolkUid',
    event: 'notification.household.recipient.not_a_member',
    uid,
    familyId: kinfolkId,
    extra: {
      member: memberSnap.exists ? 'not_active' : 'missing',
      redirectedTo: primary === null ? 'none' : 'primary',
    },
  });
  return primary;
}

/**
 * The household's ACTIVE PRIMARY. Queried on role alone and filtered on status
 * here, so no composite index is needed. A household has one PRIMARY; if a
 * defect ever left two, the first ACTIVE one wins and it is logged.
 *
 * `resolveBillingRecipientUid` keeps its own copy of this lookup: a module
 * shared by the two would be one more file every cold start loads
 * (`coldStartImportGraph.test.ts`), and the billing suites replace this
 * module wholesale.
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
      function: 'resolveKinfolkUid',
      event: 'notification.household.recipient.multiple_primaries',
      familyId: kinfolkId,
      extra: { count: active.length },
    });
  }
  return active[0]?.id ?? null;
}
