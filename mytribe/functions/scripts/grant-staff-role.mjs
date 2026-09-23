/**
 * Mints the `staffRole` custom claim on a staff account. Today the only value
 * is `auntie`: a caretaker, a contractor or employee.
 *
 * Issue #944, operator ruling 2026-09-22. Spec:
 * docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
 *
 * THE WHOLE MIGRATION IS THIS SCRIPT. There is no backfill and nothing to run
 * against existing accounts: the operator holds `admin: true` and no
 * `staffRole`, which is `isOwner()`, which is every grant they had before the
 * split. Deploying the rules changes nothing for them. This runs once per
 * Auntie, at hire.
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
 * Usage, from mytribe/functions, against the live project:
 *   GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-staff-role.mjs \
 *     --email auntie@example.com --role auntie
 *
 * To revoke, which returns the account to holding no staff role at all:
 *   ... --email auntie@example.com --role none
 *
 * `--password` is only read when the account does not exist yet; an existing
 * account's password is never touched. Print nothing sensitive: the password is
 * echoed by your own shell, not by this script.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const ROLES = ['auntie', 'none'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const email = arg('email');
const role = arg('role');
const password = arg('password');
const displayName = arg('displayName');

if (!email || !ROLES.includes(role)) {
  console.error('Usage: node scripts/grant-staff-role.mjs --email <addr> --role <auntie|none> [--password <pw>] [--displayName <name>]');
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

let user = null;
try {
  user = await auth.getUserByEmail(email);
} catch (err) {
  if (err?.code !== 'auth/user-not-found') throw err;
}

let uid;
if (user) {
  uid = user.uid;
  console.log(`Found existing account ${email} (${uid}).`);
} else {
  if (role === 'none') {
    console.error(`No account for ${email}; nothing to revoke.`);
    process.exit(2);
  }
  if (!password) {
    console.error(`No account for ${email} and no --password given to create one.`);
    process.exit(2);
  }
  const created = await auth.createUser({ email, password, emailVerified: true, displayName });
  uid = created.uid;
  console.log(`Created ${email} (${uid}).`);
}

const existing = (await auth.getUser(uid)).customClaims ?? {};

// The refusal that keeps the claim split meaningful. Naming the remedy rather
// than silently stripping `admin`: revoking the owner claim is a decision for
// whoever runs this, not a side effect of granting a different one.
if (role === 'auntie' && existing.admin === true) {
  console.error(
    `REFUSED: ${email} already holds the owner claim (admin: true).\n`
    + 'An account must be one role or the other. Revoke the owner claim first,\n'
    + "via the admin app's setAdminClaim with isAdmin:false, then re-run this.",
  );
  process.exit(1);
}

const next = { ...existing };
if (role === 'none') delete next.staffRole;
else next.staffRole = role;

await auth.setCustomUserClaims(uid, next);

// staff/{uid} is what the Assigned Auntie picker (listStaff) renders from, and
// what provisionBusinessAdmins checks before adding a uid to the notification
// roster. A claim without this row is an Auntie no screen can name.
if (role === 'none') {
  await db.collection('staff').doc(uid).delete().catch(() => {});
} else {
  await db.collection('staff').doc(uid).set(
    {
      uid,
      email,
      displayName: displayName ?? user?.displayName ?? email,
      staffRole: role,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

console.log(`Claims now: ${JSON.stringify((await auth.getUser(uid)).customClaims ?? {})}`);
console.log('The token is minted at sign-in, so this takes effect on the next sign-in.');

if (role === 'auntie') {
  console.log('');
  console.log('WARNING: this account CANNOT SIGN IN TO THE ADMIN APP YET.');
  console.log('auntieos-admin/src/lib/access.ts:accessFromClaims admits on `admin === true`');
  console.log('or a testTribeId, and returns denied for everyone else. The server-side');
  console.log('Auntie boundary is live, but the client gate has not been taught the role.');
  console.log('That is item one of the #944 UI follow-up. Do not hand out this account');
  console.log('until that ships.');
}
