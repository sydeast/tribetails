/**
 * Creates (or finds) a Firebase Auth user and stamps `admin: true` on it.
 *
 * WHY A SCRIPT RATHER THAN THE CONSOLE. The console can create the account but
 * cannot write a custom claim, and the claim is the whole point: `accessFromClaims`
 * (auntieos-admin/src/lib/access.ts) admits a user on `admin === true` and denies
 * everyone else, so a console-created account authenticates and is then refused at
 * the gate. Doing it here also makes the step re-runnable, which a console click is
 * not, and re-runnable is what lets the runbook be executed rather than remembered.
 *
 * CLAIMS ARE MERGED, NEVER REPLACED. `setCustomUserClaims` overwrites the whole
 * object, so this reads the existing set first — the same contract
 * `syncKinfolkClaim` keeps (lib/kinfolkClaim.ts). Re-running on an account that
 * has since been given `role`/`kinfolkId` will not strip them.
 *
 * Usage, from mytribe/functions, against the live project:
 *   GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-admin-claim.mjs \
 *     --email e2e-admin@tribetails.com --password "$(openssl rand -base64 24)"
 *
 * `--password` is only read when the account does not exist yet; an existing
 * account's password is never touched. Print nothing sensitive: the password is
 * echoed by your own shell, not by this script.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const email = arg('email');
const password = arg('password');
const projectId = process.env.GOOGLE_CLOUD_PROJECT;

if (!email) {
  console.error('Missing --email.');
  process.exit(2);
}

if (!projectId) {
  console.error('Missing GOOGLE_CLOUD_PROJECT. Refusing to guess which project to write to.');
  process.exit(2);
}

initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();

const user = await auth.getUserByEmail(email).catch((e) => {
  if (e?.code !== 'auth/user-not-found') throw e;
  return null;
});

let uid;
if (user) {
  uid = user.uid;
  console.log(`Found existing account ${email} (${uid}).`);
} else {
  if (!password) {
    console.error(`No account for ${email} and no --password given to create one.`);
    process.exit(2);
  }
  const created = await auth.createUser({ email, password, emailVerified: true });
  uid = created.uid;
  console.log(`Created ${email} (${uid}).`);
}

const existing = (await auth.getUser(uid)).customClaims ?? {};
await auth.setCustomUserClaims(uid, { ...existing, admin: true });

const after = (await auth.getUser(uid)).customClaims ?? {};
console.log(`Claims now: ${JSON.stringify(after)}`);
console.log(
  'The token is minted at sign-in, so this takes effect on the next sign-in. ' +
    'Nothing needs restarting.',
);
