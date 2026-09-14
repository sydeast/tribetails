import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { run as runEnableLogin, TEST_TRIBE_ID, TEST_ADMIN_UID, TEST_ADMIN_EMAIL } from '../qa_enable_sandbox_login';
import { run as runSetPassword } from '../qa_set_sandbox_password';

/**
 * Proves qa_enable_sandbox_login.ts and qa_set_sandbox_password.ts's actual
 * write behavior (issue #860) against the Auth + Firestore emulators. Never
 * against production - see the header note on `run` in each script for why
 * this imports firebase-admin/app|firestore|auth directly instead of going
 * through the guarded ./lib/firebaseAdmin, exactly like
 * backfillKinfolkVetToHousehold.emulator.test.ts already does.
 *
 * ONE file for both scripts, deliberately, not one each. mytribe/firebase.json
 * sets emulators.singleProjectMode: true, and the Auth emulator's
 * client-facing REST routes (signInWithPassword, used below to prove a
 * password actually works - the Admin SDK has no "verify password" call)
 * resolve their target project from `--project` at emulator startup ONLY:
 * firebase-tools' getProjectIdByApiKey() ignores the "key" query param
 * entirely and always returns the emulator's single defaultProjectId. A
 * project id passed to initializeApp() that differs from `--project` still
 * accepts Admin SDK writes (those routes ARE project-scoped) but silently
 * signs in against the WRONG project's user store, which is indistinguishable
 * from a real bug (EMAIL_NOT_FOUND) until you trace it to this emulator
 * behavior. So both scripts' fixed sandbox account is exercised against the
 * SAME project id here, which must equal whatever `--project` the emulator
 * proof command below passes - and because it's the one project this whole
 * file shares, the two scripts' tests run through ONE beforeEach against ONE
 * Auth/Firestore state, never two files racing over the same fixed uid/email
 * in separate forked processes.
 *
 * Run (from mytribe/functions):
 *   firebase emulators:exec --only auth,firestore --project qa-sandbox-emulator-test \
 *     "npm run test:ci"
 *
 * Refuses to run (describe.runIf) without BOTH emulator hosts set, so a
 * plain `npm test` never touches anything real.
 */
const FIRESTORE_EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const AUTH_EMULATOR = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
const EMULATORS = Boolean(FIRESTORE_EMULATOR && AUTH_EMULATOR);

// Must equal the --project passed to `firebase emulators:exec` above - see
// the file header for why.
const EMULATOR_PROJECT_ID = 'qa-sandbox-emulator-test';

async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

describe.runIf(EMULATORS)('qa_enable_sandbox_login.ts and qa_set_sandbox_password.ts against the emulators', () => {
  let db: Firestore;
  let auth: Auth;

  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
    db = getFirestore();
    auth = getAuth();
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  beforeEach(async () => {
    // Clean slate: delete every Auth user and the one clients doc each test
    // touches. Safe here specifically because this whole file - both
    // scripts' tests - runs against one project in one file, so there is no
    // sibling file racing over the same fixed sandbox uid/email.
    const list = await auth.listUsers();
    await Promise.all(list.users.map((u) => auth.deleteUser(u.uid)));
    await db.collection('clients').doc(TEST_ADMIN_UID).delete().catch(() => undefined);
  });

  describe('qa_enable_sandbox_login.run', () => {
    it('links kinfolkIds and sets a real, working password when the uid matches, and never logs it', async () => {
      await auth.createUser({ uid: TEST_ADMIN_UID, email: TEST_ADMIN_EMAIL, password: 'old-password-123' });

      const logs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args);
      };
      let result: { uid: string; passwordFilePath: string };
      try {
        result = await runEnableLogin({ auth, db });
      } finally {
        console.log = originalLog;
      }

      expect(result.uid).toBe(TEST_ADMIN_UID);
      const client = (await db.collection('clients').doc(TEST_ADMIN_UID).get()).data();
      expect(client?.['kinfolkIds']).toEqual([TEST_TRIBE_ID]);

      // The password file holds the ACTUAL password: prove it by signing in
      // with it against the Auth emulator, the strongest available proof
      // that the write really landed (Admin SDK cannot verify a password).
      const fs = await import('fs');
      const written = fs.readFileSync(result.passwordFilePath, 'utf8').trim();
      const signIn = await signInWithPassword(TEST_ADMIN_EMAIL, written);
      expect(signIn.ok, JSON.stringify(signIn)).toBe(true);

      // Never printed or logged: the requirement this whole design exists for.
      for (const line of logs) {
        expect(line.join(' ')).not.toContain(written);
      }

      // The old password no longer works.
      const oldSignIn = await signInWithPassword(TEST_ADMIN_EMAIL, 'old-password-123');
      expect(oldSignIn.ok).toBe(false);

      fs.unlinkSync(result.passwordFilePath);
    });

    it('refuses and writes nothing when the sandbox email resolves to a different uid', async () => {
      const created = await auth.createUser({ email: TEST_ADMIN_EMAIL, password: 'old-password-123' });
      expect(created.uid).not.toBe(TEST_ADMIN_UID); // auto-generated uid, the whole point of this test

      await expect(runEnableLogin({ auth, db })).rejects.toThrow(/does not.*uid|not the sandbox uid/i);

      const client = await db.collection('clients').doc(created.uid).get();
      expect(client.exists).toBe(false);
      const stillWorks = await signInWithPassword(TEST_ADMIN_EMAIL, 'old-password-123');
      expect(stillWorks.ok, JSON.stringify(stillWorks)).toBe(true); // password untouched
    });

    it('refuses and writes nothing when the sandbox account does not exist at all', async () => {
      await expect(runEnableLogin({ auth, db })).rejects.toThrow(/no Auth user/i);
      const client = await db.collection('clients').doc(TEST_ADMIN_UID).get();
      expect(client.exists).toBe(false);
    });
  });

  describe('qa_set_sandbox_password.run', () => {
    it('sets a real, working password when the uid matches, and never returns or logs it', async () => {
      await auth.createUser({ uid: TEST_ADMIN_UID, email: TEST_ADMIN_EMAIL, password: 'old-password-123' });

      const logs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args);
      };
      let result: { uid: string };
      try {
        result = await runSetPassword({ auth }, { password: 'new-Sandbox-Pw-9!' });
      } finally {
        console.log = originalLog;
      }

      expect(result.uid).toBe(TEST_ADMIN_UID);
      for (const line of logs) {
        expect(line.join(' ')).not.toContain('new-Sandbox-Pw-9!');
      }

      const signIn = await signInWithPassword(TEST_ADMIN_EMAIL, 'new-Sandbox-Pw-9!');
      expect(signIn.ok, JSON.stringify(signIn)).toBe(true);
      const oldSignIn = await signInWithPassword(TEST_ADMIN_EMAIL, 'old-password-123');
      expect(oldSignIn.ok).toBe(false);
    });

    it('refuses and changes nothing when the sandbox email resolves to a different uid', async () => {
      await auth.createUser({ email: TEST_ADMIN_EMAIL, password: 'old-password-123' });

      await expect(runSetPassword({ auth }, { password: 'attacker-chosen-pw' })).rejects.toThrow(
        /does not.*uid|not the sandbox uid/i,
      );

      const stillWorks = await signInWithPassword(TEST_ADMIN_EMAIL, 'old-password-123');
      expect(stillWorks.ok, JSON.stringify(stillWorks)).toBe(true);
    });

    it('refuses when the sandbox account does not exist at all', async () => {
      await expect(runSetPassword({ auth }, { password: 'whatever' })).rejects.toThrow(/no Auth user/i);
    });
  });
});
