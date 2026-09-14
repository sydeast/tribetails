/**
 * qa_enable_sandbox_login.ts
 *
 * One-off QA helper: make the TEST SANDBOX account a usable kinfolk login.
 *   1. clients/<uid>.kinfolkIds -> ['test-kinfolk-001']  (so getMyAccess routes to Home)
 *   2. a fresh random temp password on the Auth user, written to a local
 *      0600 file (never printed or logged - see writePasswordFile below)
 * Safe: test-kinfolk-001 is isolated isTestData. Reversible (clear kinfolkIds after).
 *
 * Ported from qa_enable_sandbox_login.js (issue #860). The old script
 * imported '../functions/node_modules/firebase-admin' directly and called
 * the removed `admin` namespace's credential/firestore/auth members
 * directly (see git history for the exact call shape), all of which are
 * `undefined` on the installed firebase-admin 14.3.0 (the
 * legacy namespace was removed), so it threw a TypeError on its first real
 * line. This version imports the guarded modular API from
 * mytribe/scripts/lib/firebaseAdmin.ts (issue #846), which resolves
 * firebase-admin from mytribe/functions/node_modules and refuses to start if
 * a stray copy (e.g. a root-owned $HOME/node_modules/firebase-admin) is
 * reachable ahead of it.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Prints the plan; --apply is required to write.
 *   - Refuses (mytribe/scripts/lib/qaSandboxAccount.ts) unless
 *     test-admin+sandbox@tribetails.test resolves to EXACTLY the sandbox
 *     uid. No account, or an account under a different uid: refuse.
 *   - Refuses to run against the production project (auntieos-ttpc) unless
 *     --allow-production is also passed.
 *   - NEVER prints or logs the password. --apply writes it to a 0600 file
 *     under the OS temp dir and prints only that file's path.
 *
 * Proven against the Auth + Firestore emulators, never production:
 * mytribe/scripts/test/qaSandboxScripts.emulator.test.ts.
 *
 * Operator run commands (from repo root):
 *   # dry-run (prints the plan, writes nothing):
 *   npm --prefix mytribe/functions run qa:enable-sandbox-login
 *   # apply, against the real (only) project - requires GOOGLE_APPLICATION_CREDENTIALS:
 *   npm --prefix mytribe/functions run qa:enable-sandbox-login -- --apply --allow-production
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getApps, initializeApp, applicationDefault, getFirestore, getAuth } from './lib/firebaseAdmin';
import {
  TEST_TRIBE_ID,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_UID,
  PRODUCTION_PROJECT_ID,
  assertProjectAllowed,
  resolveSandboxUid,
} from './lib/qaSandboxAccount';

export { TEST_TRIBE_ID, TEST_ADMIN_EMAIL, TEST_ADMIN_UID, PRODUCTION_PROJECT_ID, assertProjectAllowed };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
export interface Args {
  apply: boolean;
  projectId: string | null;
  allowProduction: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, projectId: null, allowProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') {
      args.apply = true;
    } else if (a === '--allow-production') {
      args.allowProduction = true;
    } else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'qa_enable_sandbox_login.ts - make the QA sandbox account a usable kinfolk login',
          '',
          'Usage:',
          '  ts-node qa_enable_sandbox_login.ts                            # dry-run (default)',
          '  ts-node qa_enable_sandbox_login.ts --apply --allow-production # write, against the real project',
          '  ts-node qa_enable_sandbox_login.ts --apply --project <id>     # write, against an emulator project',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS                     required for --apply against the real project',
          '  FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST   alternative, for the emulators',
          '  GCLOUD_PROJECT                                     Firebase project id (default auntieos-ttpc)',
          '',
          'Never prints or logs the password. --apply writes it to a 0600 temp file and prints only the path.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export function resolveProjectId(args: Args): string {
  return args.projectId ?? process.env.GCLOUD_PROJECT ?? PRODUCTION_PROJECT_ID;
}

// ---------------------------------------------------------------------------
// Password. Generated fresh every --apply; the caller never sees it in a
// console.log/console.error call anywhere in this file.
// ---------------------------------------------------------------------------
export function generateTempPassword(): string {
  return 'QA-' + crypto.randomBytes(9).toString('base64url') + '!7';
}

/**
 * Writes the password to a 0600 file under the OS temp dir. Returns the
 * path, never the value. `flag: 'wx'` (exclusive create) rather than the
 * default 'w': it fails loud instead of silently overwriting if the
 * timestamped path ever collided with an existing file, which is exactly
 * the kind of surprise this function should never paper over.
 */
export function writePasswordFile(password: string): string {
  const filePath = path.join(os.tmpdir(), `qa-sandbox-login-password-${Date.now()}.txt`);
  fs.writeFileSync(filePath, password + '\n', { mode: 0o600, flag: 'wx' });
  return filePath;
}

// ---------------------------------------------------------------------------
// The actual write. Handles are injected so tests exercise this against the
// emulators without going through the guarded ./lib/firebaseAdmin import
// (mirrors mytribe/scripts/test/backfillKinfolkVetToHousehold.emulator.test.ts,
// which imports firebase-admin/app|firestore directly for the same reason).
// ---------------------------------------------------------------------------
export interface EnableResult {
  uid: string;
  passwordFilePath: string;
}

export async function run(
  deps: { auth: Auth; db: Firestore },
  opts: { writePasswordFile?: (password: string) => string } = {},
): Promise<EnableResult> {
  const write = opts.writePasswordFile ?? writePasswordFile;
  const uid = await resolveSandboxUid(deps.auth);

  await deps.db.collection('clients').doc(uid).set({ kinfolkIds: [TEST_TRIBE_ID] }, { merge: true });
  console.log(`[1/2] linked kinfolkIds -> [${TEST_TRIBE_ID}]`);

  const password = generateTempPassword();
  // Persist the password BEFORE changing it in Auth, not after. If the write
  // fails (disk full, unwritable temp dir, ...), the account's password is
  // simply left unchanged - known, recoverable. Applying the change first and
  // writing the file second would mean a failed write loses the only copy of
  // a password that is now, silently, the account's real one: an unknown
  // password on a live QA account, discoverable only by trying to sign in.
  const passwordFilePath = write(password);
  await deps.auth.updateUser(uid, { password });
  console.log('[2/2] temp password set.');

  return { uid, passwordFilePath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId = resolveProjectId(args);

  console.log(`qa_enable_sandbox_login  mode=${args.apply ? 'apply' : 'dry-run'}  project=${projectId}`);
  console.log(`[plan] clients/${TEST_ADMIN_UID}.kinfolkIds -> [${TEST_TRIBE_ID}] (merge)`);
  console.log('[plan] set a fresh random password on the Auth user (value never logged)');
  console.log(`[plan] refuses unless ${TEST_ADMIN_EMAIL} resolves to uid ${TEST_ADMIN_UID}`);

  if (!args.apply) {
    console.log('\nDRY-RUN. No Auth or Firestore writes performed. Re-run with --apply to commit.');
    return;
  }

  // The dry-run above does zero I/O, so there is nothing to protect and no
  // reason to demand --allow-production just to print a plan. Only a real
  // write needs the refusal.
  assertProjectAllowed(projectId, args.allowProduction);

  const usingEmulator = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
  if (!usingEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS not set (and no FIRESTORE_EMULATOR_HOST + ' +
        'FIREBASE_AUTH_EMULATOR_HOST pair is set). Export the service-account key path, ' +
        'or run this against the emulators, before --apply.',
    );
  }

  if (!getApps().length) {
    initializeApp(usingEmulator ? { projectId } : { credential: applicationDefault(), projectId });
  }
  console.log(`\n[init] projectId=${projectId}`);

  const result = await run({ auth: getAuth(), db: getFirestore() });
  console.log(`\nfinal: uid=${result.uid}`);
  console.log(`Password written to ${result.passwordFilePath} (not printed here). Read it, then delete the file.`);
}

// Run main only when invoked directly. Importing for tests does not write.
if (require.main === module) {
  main().catch((err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
