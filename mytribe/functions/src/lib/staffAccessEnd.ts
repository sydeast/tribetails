import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { isAuntieOperator } from './operatorAllowlist';
import { STAFF_ROLE_AUNTIE } from './auntieAccess';
import { AUDIT_EVENTS } from './auditEvents';
import { auditHashableDoc, readAuditChain, stageAuditEntry } from './writeAuditEntry';
import { businessAdminsRef, normalizeBusinessAdmins } from './businessAdmins';

/**
 * #2228: when an Auntie's staff role ends, she leaves the business admin list
 * and her work devices stop getting business notices, in one step, logged.
 *
 * Before this, removing her role (`grant-staff-role.mjs --role none`, or her
 * `clients/{uid}` doc deleted, which wipes every claim in `onClientsWrite`)
 * left her uid on `businessSettings/admins.uids`. Once the claim and the staff
 * record are both gone, that uid cannot be told apart from an owner known only
 * from the allowlist, so the send-time filter in `businessAdmins.ts` keeps it.
 *
 * ## What it changes, in one transaction
 *
 *   - Her uid comes off `businessSettings/admins.uids`, and the stored default
 *     assignee is cleared when it names her (assignment then falls back to the
 *     first uid left, as a revocation through `removeBusinessAdminUids` does).
 *   - Her `fcm_tokens` registrations from the admin app are deleted.
 *   - A `PERM_STAFF_ROLE_REMOVED` Activity Log line is sealed onto the chain.
 *
 * When none of that has anything to do (she is not on the list and has no
 * admin-app device), nothing is written and no line is logged. That is what
 * makes a re-run safe, and what keeps `onClientsWrite` quiet on every ordinary
 * household account deletion.
 *
 * ## Device registrations
 *
 * There is one `fcm_tokens` collection for both apps, keyed by token, with the
 * owner's `uid` stamped on it (`portal/registerFcmToken.ts`). The household
 * portal registers as `web` (MyTribe web) or `*-mytribe` (the MyTribe Android,
 * desktop and wasm apps); the AuntieOS admin Android app registers as bare
 * `android`. Only the latter are business-notice devices, so a household
 * portal registration under the same uid is left alone. The admin web app and
 * the desktop console register no device today.
 *
 * ## Only an Auntie, and owner accounts are never touched
 *
 * It acts only when the claims the account held before the change, or its
 * `staff/{uid}` record, say Auntie (`not-staff` otherwise). A household
 * account deletion therefore changes nothing here, and neither does a uid
 * with no evidence either way: that uid could be an owner known only from the
 * allowlist, which a shell running the staff role tool cannot read. The staff
 * role tool deletes the staff record LAST, so a failed run leaves the
 * evidence a re-run needs.
 *
 * An account holding the owner claim (`admin: true`), or named on the operator
 * allowlist, keeps its place on the list and its devices: the answer is
 * `owner-kept` and nothing is written. The claims checked are the ones the
 * account held BEFORE the role was taken away, so a wiped account does not
 * pass for a stranger. `AUNTIE_OPERATOR_UIDS` is a Secret Manager secret: a
 * function must bind it for the allowlist half to see anything.
 */

/** Which path ended the role. Recorded on the log line. */
export type StaffAccessEndSource = 'grant-staff-role' | 'onClientsWrite';

export type StaffAccessEndOutcome =
  /** Taken off the list and/or devices cleared. One log line written. */
  | 'ended'
  /** Not on the list and no admin-app device. Nothing written. */
  | 'nothing-to-change'
  /** An owner account. Nothing written. */
  | 'owner-kept'
  /** Neither the claims before the change nor the staff record name an Auntie. Nothing written. */
  | 'not-staff';

export interface StaffAccessEndResult {
  outcome: StaffAccessEndOutcome;
  removedFromList: boolean;
  /** She was the only uid on the list, so it is now empty (see `businessAdmins.ts`). */
  listEmptied: boolean;
  defaultAssigneeCleared: boolean;
  /** Admin-app device registrations deleted. */
  devicesCleared: number;
  /** Household portal registrations under the same uid, left alone. */
  householdDevicesKept: number;
}

export interface EndStaffAccessInput {
  uid: string;
  /**
   * The account's custom claims as they were BEFORE the role was taken away,
   * or null when there is no sign-in account. Used for the owner check and
   * as staff evidence.
   */
  claimsBefore: Record<string, unknown> | null;
  source: StaffAccessEndSource;
}

/**
 * The household portal's platform values: `web` from MyTribe web, `*-mytribe`
 * from the MyTribe Kotlin apps. Everything else is an admin-app device.
 */
export function isHouseholdAppPlatform(platform: unknown): boolean {
  return typeof platform === 'string' && (platform === 'web' || platform.endsWith('-mytribe'));
}

/** Owner claim, or the operator allowlist. A double-claimed account counts: removing her staff role leaves the owner. */
export function isOwnerAccount(uid: string, claims: Record<string, unknown> | null): boolean {
  return claims?.['admin'] === true || isAuntieOperator(uid);
}

const NOTHING: Omit<StaffAccessEndResult, 'outcome'> = {
  removedFromList: false,
  listEmptied: false,
  defaultAssigneeCleared: false,
  devicesCleared: 0,
  householdDevicesKept: 0,
};

export async function endStaffBusinessAccess(input: EndStaffAccessInput): Promise<StaffAccessEndResult> {
  const { uid, claimsBefore, source } = input;

  if (isOwnerAccount(uid, claimsBefore)) {
    logEvent({
      severity: 'info',
      function: 'staffAccessEnd',
      event: 'staffAccess.end.ownerKept',
      uid,
      extra: { source, note: 'an owner account keeps its place on the business admin list' },
    });
    return { outcome: 'owner-kept', ...NOTHING };
  }

  const firestore = db();
  const adminsRef = businessAdminsRef();
  const staffRef = firestore.collection('staff').doc(uid);
  const tokensQuery = firestore.collection('fcm_tokens').where('uid', '==', uid);
  // Captured once, outside the transaction: the hash input must be the same
  // on every attempt of a contended transaction.
  const timestampIso = new Date().toISOString();

  const result = await firestore.runTransaction(async (tx): Promise<StaffAccessEndResult> => {
    const adminsSnap = await tx.get(adminsRef);
    const tokensSnap = await tx.get(tokensQuery);

    const staffSnap = await tx.get(staffRef);
    const claimSays = claimsBefore?.['staffRole'] === STAFF_ROLE_AUNTIE;
    const recordSays = staffSnap.data()?.['staffRole'] === STAFF_ROLE_AUNTIE;
    if (!claimSays && !recordSays) return { outcome: 'not-staff', ...NOTHING };

    const current = normalizeBusinessAdmins(adminsSnap.data());
    const onList = current.uids.includes(uid);
    const businessDevices = tokensSnap.docs.filter((d) => !isHouseholdAppPlatform(d.data()?.['platform']));
    const householdDevicesKept = tokensSnap.docs.length - businessDevices.length;

    if (!onList && businessDevices.length === 0) {
      return { outcome: 'nothing-to-change', ...NOTHING, householdDevicesKept };
    }

    // Every read before the first write, as Firestore requires.
    const chain = await readAuditChain(firestore, tx);

    let listEmptied = false;
    let defaultAssigneeCleared = false;
    if (onList) {
      const next = current.uids.filter((u) => u !== uid);
      listEmptied = next.length === 0;
      const payload: Record<string, unknown> = { uids: next, updatedAt: FieldValue.serverTimestamp() };
      if (current.defaultAssigneeUid === uid) {
        payload['defaultAssigneeUid'] = FieldValue.delete();
        defaultAssigneeCleared = true;
      }
      tx.set(adminsRef, payload, { merge: true });
    }
    for (const device of businessDevices) tx.delete(device.ref);

    const changed: Omit<StaffAccessEndResult, 'outcome'> = {
      removedFromList: onList,
      listEmptied,
      defaultAssigneeCleared,
      devicesCleared: businessDevices.length,
      householdDevicesKept,
    };
    stageAuditEntry(
      firestore,
      tx,
      auditHashableDoc(
        {
          event: AUDIT_EVENTS.PERM_STAFF_ROLE_REMOVED,
          severity: 'warn',
          status: 'SUCCESS',
          actorRole: 'SYSTEM',
          targetUid: uid,
          targetCollection: 'staff',
          description:
            "An Auntie's staff role was removed, so business notices no longer reach her or her work devices.",
          payload: { source, ...changed },
        },
        timestampIso,
      ),
      chain,
    );
    return { outcome: 'ended', ...changed };
  });

  // Outside the transaction: a retried attempt is not a second change.
  if (result.outcome === 'ended') {
    logEvent({
      severity: result.listEmptied ? 'error' : 'warn',
      function: 'staffAccessEnd',
      event: 'staffAccess.end.done',
      uid,
      extra: {
        source,
        ...result,
        ...(result.listEmptied && {
          note: 'the business admin list is now empty; the next business notice refills it from the owner allowlist, or call provisionBusinessAdmins',
        }),
      },
    });
  }
  return result;
}
