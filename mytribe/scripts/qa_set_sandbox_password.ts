/**
 * qa_set_sandbox_password.ts
 *
 * One-off QA helper: set a new password on the TEST SANDBOX account.
 *
 * Ported from qa_set_sandbox_password.js (issue #860). The old script
 * imported '../functions/node_modules/firebase-admin' directly and called
 * the removed `admin` namespace's credential/auth members directly (see git
 * history for the exact call shape), both `undefined` on
 * the installed firebase-admin 14.3.0 (the legacy namespace was removed), so
 * it threw a TypeError on its first real line. This version imports the
 * guarded modular API from mytribe/scripts/lib/firebaseAdmin.ts (issue
 * #846), which resolves firebase-admin from mytribe/functions/node_modules
 * and refuses to start if a stray copy is reachable ahead of it.
 *
 * The old script also hard-coded the new password as a source constant AND
 * printed it to stdout. That constant has been public (this repo went
 * public 2026-09-11) since before this fix (see git history, or the PR
 * description for #860); the operator should rotate the sandbox account's
 * password regardless of this change.
 *
 * The new password is read from the QA_SANDBOX_PASSWORD env var, NOT a CLI
 * flag. A CLI flag would be wrong even if nothing in this file ever printed
 * it: `npm run <script> -- --password=<pw>` has npm itself echo the full
 * command line, flag and all, to stdout before this file even starts
 * running. An env var is never echoed that way. It is also never printed or
 * logged anywhere in this file - do not add a console.log/console.error line
 * that includes it.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Prints the plan; --apply is required to write.
 *   - Refuses (mytribe/scripts/lib/qaSandboxAccount.ts) unless
 *     test-admin+sandbox@tribetails.test resolves to EXACTLY the sandbox
 *     uid. No account, or an account under a different uid: refuse.
 *   - Refuses to run against the production project (auntieos-ttpc) unless
 *     --allow-production is also passed.
 *   - NEVER prints or logs the password.
 *
 * Proven against the Auth + Firestore emulators, never production:
 * mytribe/scripts/test/qaSandboxScripts.emulator.test.ts.
 *
 * Operator run commands (from repo root):
 *   # dry-run (prints the plan, writes nothing):
 *   npm --prefix mytribe/functions run qa:set-sandbox-password
 *   # apply, against the real (only) project - requires GOOGLE_APPLICATION_CREDENTIALS:
 *   read -s QA_SANDBOX_PASSWORD && export QA_SANDBOX_PASSWORD
 *   npm --prefix mytribe/functions run qa:set-sandbox-password -- --apply --allow-production
 *   unset QA_SANDBOX_PASSWORD
 */

import type { Auth } from 'firebase-admin/auth';
import { getApps, initializeApp, applicationDefault, getAuth } from './lib/firebaseAdmin';
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_UID,
  PRODUCTION_PROJECT_ID,
  assertProjectAllowed,
  resolveSandboxUid,
} from './lib/qaSandboxAccount';

export { TEST_ADMIN_EMAIL, TEST_ADMIN_UID, PRODUCTION_PROJECT_ID, assertProjectAllowed };

// ---------------------------------------------------------------------------
// Args. No --password flag on purpose - see the file header.
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
          'qa_set_sandbox_password.ts - set a new password on the QA sandbox account',
          '',
          'Usage:',
          '  ts-node qa_set_sandbox_password.ts                            # dry-run (default)',
          '  ts-node qa_set_sandbox_password.ts --apply --allow-production # write, real project',
          '  ts-node qa_set_sandbox_password.ts --apply --project <id>     # write, emulator project',
          '',
          'Env:',
          '  QA_SANDBOX_PASSWORD                                required for --apply. NOT a CLI flag:',
          '                                                      npm echoes CLI args to stdout, an env',
          '                                                      var is never echoed that way.',
          '  GOOGLE_APPLICATION_CREDENTIALS                     required for --apply against the real project',
          '  FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST   alternative, for the emulators',
          '  GCLOUD_PROJECT                                     Firebase project id (default auntieos-ttpc)',
          '',
          'Never prints or logs the password.',
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
// The actual write. Handles are injected so tests exercise this against the
// emulators without going through the guarded ./lib/firebaseAdmin import
// (mirrors mytribe/scripts/test/backfillKinfolkVetToHousehold.emulator.test.ts).
// ---------------------------------------------------------------------------
export interface SetPasswordResult {
  uid: string;
}

export async function run(deps: { auth: Auth }, opts: { password: string }): Promise<SetPasswordResult> {
  const uid = await resolveSandboxUid(deps.auth);
  await deps.auth.updateUser(uid, { password: opts.password });
  console.log('[done] password set (value not logged).');
  return { uid };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId = resolveProjectId(args);

  console.log(`qa_set_sandbox_password  mode=${args.apply ? 'apply' : 'dry-run'}  project=${projectId}`);
  console.log(`[plan] set a new password on the Auth user for ${TEST_ADMIN_EMAIL} (value never logged)`);
  console.log(`[plan] refuses unless ${TEST_ADMIN_EMAIL} resolves to uid ${TEST_ADMIN_UID}`);

  if (!args.apply) {
    console.log('\nDRY-RUN. No Auth writes performed. Re-run with --apply (and QA_SANDBOX_PASSWORD set) to commit.');
    return;
  }

  // The dry-run above does zero I/O, so there is nothing to protect and no
  // reason to demand --allow-production just to print a plan. Only a real
  // write needs the refusal.
  assertProjectAllowed(projectId, args.allowProduction);

  const password = process.env.QA_SANDBOX_PASSWORD;
  if (!password) {
    throw new Error(
      '--apply requires the QA_SANDBOX_PASSWORD env var to be set. Never pass the password as a ' +
        'CLI flag: npm echoes the full command line (flags included) to stdout before this script runs.',
    );
  }

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

  const result = await run({ auth: getAuth() }, { password });
  console.log(`\nfinal: uid=${result.uid}, password updated (not logged)`);
}

// Run main only when invoked directly. Importing for tests does not write.
if (require.main === module) {
  main().catch((err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
