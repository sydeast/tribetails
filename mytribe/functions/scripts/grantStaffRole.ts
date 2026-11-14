/**
 * The staff role tool behind `scripts/grant-staff-role.mjs`. Mints or revokes
 * the `staffRole` custom claim on a staff account. Today the only value is
 * `auntie`: a caretaker, a contractor or employee.
 *
 * Issue #944, operator ruling 2026-09-22. Spec:
 * docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
 *
 * WHY THIS IS TYPESCRIPT BEHIND AN `.mjs` (#2228). Revoking the role also takes
 * her off the business admin list and unregisters her work devices from
 * business notices, with an Activity Log line on the hash chain. That is
 * `src/lib/staffAccessEnd.ts`, the same code `onClientsWrite` runs. A plain
 * `.mjs` cannot import it, and a second copy of the chain writer here would
 * drift, so `grant-staff-role.mjs` starts this file through ts-node, the way
 * `npm run contracts:check` and the backfills run. The command the operator
 * types is unchanged.
 *
 * THE WHOLE MIGRATION IS THIS SCRIPT. There is no backfill and nothing to run
 * against existing accounts: the operator holds `admin: true` and no
 * `staffRole`, which is `isOwner()`, which is every grant they had before the
 * split. This runs once per Auntie, at hire, and once when she leaves.
 *
 * WHY AN AUNTIE MUST NOT ALSO HOLD `admin: true`. 116 Firestore rule sites and
 * 62 server expressions read the admin claim. The split works because an Auntie
 * carries none of it, so every site nobody revisited refuses her instead of
 * silently handing her the owner's authority. An account with both claims
 * breaks that argument, so this script refuses to create one. Both
 * `firestore.rules:isOwner()` and `lib/staffGate.ts:isOwnerClaim()` degrade a
 * double-claimed token to the caretaker boundary if one shows up anyway, but
 * that is a backstop, not a supported state.
 *
 * CLAIMS ARE MERGED, NEVER REPLACED. `setCustomUserClaims` overwrites the whole
 * object, so this reads the existing set first, the same contract
 * `syncKinfolkClaim` (lib/kinfolkClaim.ts) and `grant-admin-claim.mjs` keep.
 *
 * `--role none`, IN THIS ORDER, so a failure at any step leaves the evidence
 * a re-run needs (her claim or her staff record) and a re-run finishes the
 * job:
 *   1. one transaction takes her off `businessSettings/admins`, deletes her
 *      admin-app device registrations and writes the Activity Log line;
 *   2. the `staffRole` claim comes off;
 *   3. her `staff/{uid}` record is deleted, LAST.
 * Any failed step is reported and the run exits 1. An owner account (the
 * `admin` claim) is never taken off the list this way.
 *
 * `--password` is only read when the account does not exist yet; an existing
 * account's password is never touched. Prints nothing sensitive: the password
 * is echoed by your own shell, not by this script.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from '../src/lib/firestoreAdmin';
import { endStaffBusinessAccess, type StaffAccessEndResult } from '../src/lib/staffAccessEnd';

export const STAFF_ROLES = ['auntie', 'none'] as const;
export type StaffRoleArg = (typeof STAFF_ROLES)[number];

export interface GrantStaffRoleArgs {
  email: string;
  role: StaffRoleArg;
  password?: string;
  displayName?: string;
}

export const USAGE =
  'Usage: node scripts/grant-staff-role.mjs --email <addr> --role <auntie|none> [--password <pw>] [--displayName <name>]';

/** Where the run reports. The CLI passes the console; tests collect the lines. */
export interface StaffRoleOutput {
  log(line: string): void;
  error(line: string): void;
}

/** The command line, or null when it is not a valid one (the CLI prints USAGE). */
export function parseGrantStaffRoleArgs(argv: readonly string[]): GrantStaffRoleArgs | null {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const email = arg('email');
  const role = arg('role');
  if (!email || !STAFF_ROLES.includes(role as StaffRoleArg)) return null;
  const password = arg('password');
  const displayName = arg('displayName');
  return {
    email,
    role: role as StaffRoleArg,
    ...(password !== undefined && { password }),
    ...(displayName !== undefined && { displayName }),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs one grant or revoke. Resolves to the process exit code. */
export async function runGrantStaffRole(args: GrantStaffRoleArgs, out: StaffRoleOutput): Promise<number> {
  const { email, role, password, displayName } = args;

  let user: { uid: string; displayName?: string | undefined } | null = null;
  try {
    user = await auth().getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: unknown })?.code !== 'auth/user-not-found') {
      out.error(`FAILED to look up the account for ${email}: ${errMessage(err)}\nNothing was changed. Re-run this command.`);
      return 1;
    }
  }

  let uid: string;
  if (user) {
    uid = user.uid;
    out.log(`Found existing account ${email} (${uid}).`);
  } else {
    if (role === 'none') {
      out.error(`No account for ${email}; nothing to revoke.`);
      return 2;
    }
    if (!password) {
      out.error(`No account for ${email} and no --password given to create one.`);
      return 2;
    }
    try {
      const created = await auth().createUser({ email, password, emailVerified: true, displayName });
      uid = created.uid;
    } catch (err) {
      out.error(`FAILED to create the account for ${email}: ${errMessage(err)}\nNothing was changed. Re-run this command.`);
      return 1;
    }
    out.log(`Created ${email} (${uid}).`);
  }

  let existing: Record<string, unknown>;
  try {
    existing = ((await auth().getUser(uid)).customClaims ?? {}) as Record<string, unknown>;
  } catch (err) {
    out.error(`FAILED to read the claims on ${email}: ${errMessage(err)}\nNothing was changed. Re-run this command.`);
    return 1;
  }

  if (role === 'auntie') {
    // The refusal that keeps the claim split meaningful. Naming the remedy
    // rather than silently stripping `admin`: revoking the owner claim is a
    // decision for whoever runs this, not a side effect of granting another.
    if (existing['admin'] === true) {
      out.error(
        `REFUSED: ${email} already holds the owner claim (admin: true).\n`
          + 'An account must be one role or the other. Revoke the owner claim first,\n'
          + "via the admin app's setAdminClaim with isAdmin:false, then re-run this.",
      );
      return 1;
    }
    try {
      await auth().setCustomUserClaims(uid, { ...existing, staffRole: role });
    } catch (err) {
      out.error(`FAILED to add the staff role claim to ${email}: ${errMessage(err)}\nNothing was changed. Re-run this command.`);
      return 1;
    }
    // staff/{uid} is what the Assigned Auntie picker (listStaff) renders from,
    // and what the business notice filter reads when the claims do not say.
    // A claim without this row is an Auntie no screen can name.
    try {
      await db()
        .collection('staff')
        .doc(uid)
        .set(
          {
            uid,
            email,
            displayName: displayName ?? user?.displayName ?? email,
            staffRole: role,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (err) {
      out.error(
        `FAILED to write the staff record for ${email}: ${errMessage(err)}\n`
          + 'The staff role claim is on, but the Assigned Auntie picker cannot list her yet. Re-run this command.',
      );
      return 1;
    }
    await reportClaims(uid, out);
    // Where she can sign in today (#2228 review): the admin web app admits the
    // Auntie role (auntieos-admin/src/lib/access.ts); the Android app's
    // `isOwnerClaims` and the desktop console's `ownerFromClaims` admit only an owner.
    out.log('She signs in on the AuntieOS web app. The AuntieOS Android app and the desktop console admit only an owner today.');
    return 0;
  }

  return revokeStaffRole(uid, email, existing, out);
}

/** The closing lines of a run that did what it set out to. A failed read-back does not undo that. */
async function reportClaims(uid: string, out: StaffRoleOutput): Promise<void> {
  try {
    out.log(`Claims now: ${JSON.stringify((await auth().getUser(uid)).customClaims ?? {})}`);
  } catch (err) {
    out.log(`Done. The claims could not be read back just now (${errMessage(err)}).`);
  }
  out.log('The token is minted at sign-in, so this takes effect on the next sign-in.');
}

async function revokeStaffRole(
  uid: string,
  email: string,
  existing: Record<string, unknown>,
  out: StaffRoleOutput,
): Promise<number> {
  // An owner with no staff role has nothing to revoke. Before #2228 this went
  // on to delete her staff record, which holds her notice settings. The one
  // exception is a double-claimed account whose earlier run removed the claim
  // and then failed to take the role off her record: that run is finished
  // below (`owner-kept` keeps the record and only drops `staffRole`).
  if (existing['admin'] === true && existing['staffRole'] === undefined) {
    let recordRole: unknown;
    try {
      recordRole = (await db().collection('staff').doc(uid).get()).data()?.['staffRole'];
    } catch (err) {
      out.error(`FAILED to read the staff record for ${email}: ${errMessage(err)}\nNothing was changed. Re-run this command.`);
      return 1;
    }
    if (recordRole !== 'auntie') {
      out.error(
        `${email} holds the owner claim and no staff role; nothing to revoke. `
          + 'An owner account is never taken off the business admin list this way.',
      );
      return 2;
    }
  }

  // 1. The business admin list, her work devices and the Activity Log line.
  let ended: StaffAccessEndResult;
  try {
    ended = await endStaffBusinessAccess({ uid, claimsBefore: existing, source: 'grant-staff-role' });
  } catch (err) {
    out.error(
      `FAILED to take ${email} off the business admin list and clear her work devices: ${errMessage(err)}\n`
        + 'Nothing was changed: her staff role, her staff record and the list are as they were. Re-run this command.',
    );
    return 1;
  }
  reportEnded(ended, email, out);

  // 2. The claim.
  try {
    if (existing['staffRole'] !== undefined) {
      const next = { ...existing };
      delete next['staffRole'];
      await auth().setCustomUserClaims(uid, next);
      out.log('Staff role claim removed.');
    } else {
      out.log('No staff role claim on this account; finishing the rest.');
    }
  } catch (err) {
    out.error(
      `FAILED to remove the staff role claim from ${email}: ${errMessage(err)}\n`
        + 'She can still sign in as an Auntie. Re-run this command.',
    );
    return 1;
  }

  // 3. The staff record, last.
  const staffRef = db().collection('staff').doc(uid);
  try {
    if (ended.outcome === 'owner-kept') {
      // A double-claimed account is the owner once the staff role is gone.
      // Her record holds her notice settings, so only the role comes off it.
      const snap = await staffRef.get();
      if (snap.exists) await staffRef.update({ staffRole: FieldValue.delete() });
      out.log('Staff role taken off her staff record; the record itself was kept.');
    } else if (ended.outcome === 'not-staff') {
      out.log('Staff record left as it was: it does not name an Auntie.');
    } else {
      await staffRef.delete();
      out.log('Staff record deleted.');
    }
  } catch (err) {
    const step = ended.outcome === 'owner-kept'
      ? `take the staff role off the staff record for ${email}`
      : `delete the staff record for ${email}`;
    out.error(
      `FAILED to ${step}: ${errMessage(err)}\n`
        + 'The Assigned Auntie picker can still list her. Re-run this command.',
    );
    return 1;
  }

  await reportClaims(uid, out);
  return 0;
}

function reportEnded(ended: StaffAccessEndResult, email: string, out: StaffRoleOutput): void {
  switch (ended.outcome) {
    case 'owner-kept':
      out.log(`${email} still holds the owner claim, so it stays on the business admin list.`);
      return;
    case 'not-staff':
      out.log(
        `${email} holds no staff role and has no staff record naming an Auntie, `
          + 'so the business admin list and its devices were left alone.',
      );
      return;
    case 'nothing-to-change':
      out.log('Not on the business admin list and no work devices registered; nothing else to change.');
      return;
    case 'ended':
      out.log(
        ended.removedFromList
          ? 'Taken off the business admin list.'
          : 'Was not on the business admin list.',
      );
      if (ended.defaultAssigneeCleared) {
        out.log('She was the default Auntie for new visits; new visits now go to the first person left on the list.');
      }
      out.log(`Work devices unregistered from business notices: ${ended.devicesCleared}.`);
      if (ended.listEmptied) {
        out.error(
          'WARNING: the business admin list is now empty. Run provisionBusinessAdmins from an owner account '
            + 'so business notices have somebody to reach.',
        );
      }
      return;
  }
}
