/**
 * qaSandboxAccount.ts
 *
 * Shared safety checks for the one-off QA sandbox scripts (issue #860):
 * qa_enable_sandbox_login.ts and qa_set_sandbox_password.ts. Both scripts
 * touch a real Firebase Auth user and a real Firestore doc for the ONE
 * account QA testing is allowed to use, so both need the exact same two
 * refusals rather than two copies that can drift apart:
 *
 *   1. assertProjectAllowed - refuses to run against the production project,
 *      by either its project ID (auntieos-ttpc, see
 *      mytribe/functions/src/lib/integrationCatalog.ts) or its numeric
 *      project number (153396971788 - gcloud/firebase both accept a
 *      `--project` value in either form, and the numeric form resolves to
 *      the exact same project, so checking only the string id would let
 *      `--project 153396971788` walk straight past this refusal) - unless
 *      the operator passes --allow-production. This repo has no staging
 *      project, so the "throwaway --project id against the emulators" path
 *      this refusal leaves open is also how both scripts are proven in
 *      mytribe/scripts/test/*.emulator.test.ts: a throwaway id never equals
 *      either production value, so the emulator proof needs no flag at all.
 *
 *   2. resolveSandboxUid - looks up the fixed sandbox email and refuses
 *      unless it resolves to EXACTLY the fixed sandbox uid. Both scripts
 *      write a password or an access doc keyed by uid; a uid that doesn't
 *      match what the operator expects is exactly the failure mode that
 *      turns "reset the QA account's password" into "reset some other
 *      account's password". Deliberately a hard refuse, not the warn-and-
 *      continue seed_test_sandbox.ts:970-976 uses when it creates the
 *      account for the first time - these two scripts only ever modify an
 *      account that must already exist.
 */

import type { Auth } from 'firebase-admin/auth';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_UID, TEST_TRIBE_ID } from '../seed_test_sandbox';
import { FIREBASE_PROJECT_ID } from '../../functions/src/lib/integrationCatalog';

export { TEST_ADMIN_EMAIL, TEST_ADMIN_UID, TEST_TRIBE_ID };

/** The one real Firebase project (mytribe/functions/src/lib/integrationCatalog.ts). */
export const PRODUCTION_PROJECT_ID = FIREBASE_PROJECT_ID;

/**
 * The same production project's numeric project number. `--project` accepts
 * either form and both resolve to the identical project, so a check against
 * PRODUCTION_PROJECT_ID alone would let `--project 153396971788` walk
 * straight past assertProjectAllowed.
 */
export const PRODUCTION_PROJECT_NUMBER = '153396971788';

const PRODUCTION_PROJECT_VALUES = new Set([PRODUCTION_PROJECT_ID, PRODUCTION_PROJECT_NUMBER]);

/**
 * Refuses (throws) when `projectId` is the production project, by either its
 * string id or its numeric project number, and the operator has not passed
 * --allow-production. A throwaway emulator project id never matches, so
 * proving these scripts against the emulators needs no flag; only a real run
 * against production does.
 */
export function assertProjectAllowed(projectId: string, allowProduction: boolean): void {
  if (!PRODUCTION_PROJECT_VALUES.has(projectId)) return;
  if (allowProduction) return;
  throw new Error(
    [
      `Refusing: --project ${projectId} is the production Firebase project.`,
      'Pass --allow-production to run against it.',
      'Prove the script against the emulators first:',
      '  firebase emulators:exec --only auth,firestore --project <throwaway-id> \\',
      '    "npm --prefix mytribe/functions run <script-name> -- --apply --project <throwaway-id>"',
    ].join('\n'),
  );
}

/**
 * Looks up TEST_ADMIN_EMAIL and refuses (throws) unless it resolves to
 * EXACTLY TEST_ADMIN_UID. Never returns a uid the caller didn't ask for.
 */
export async function resolveSandboxUid(auth: Auth): Promise<string> {
  let uid: string;
  try {
    const user = await auth.getUserByEmail(TEST_ADMIN_EMAIL);
    uid = user.uid;
  } catch (err: unknown) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'auth/user-not-found') {
      throw new Error(
        `Refusing: no Auth user for ${TEST_ADMIN_EMAIL}. Run seed_test_sandbox.ts --apply first.`,
      );
    }
    throw err;
  }
  if (uid !== TEST_ADMIN_UID) {
    throw new Error(
      `Refusing: ${TEST_ADMIN_EMAIL} resolves to uid ${uid}, not the sandbox uid ${TEST_ADMIN_UID}. ` +
        'This script only ever touches the QA sandbox account.',
    );
  }
  return uid;
}
