/**
 * #912, the acceptInvite half. Same defect and same reasoning as
 * `claimInviteSignupAppInit.test.ts`: nothing initializes the Admin SDK at module
 * load, so a bare `getAuth()` throws "The default Firebase app does not exist"
 * whenever it is the first admin call on the path. Here it sits in
 * `sendInviteVerificationEmail`, the branch an invitee with an unverified email
 * lands on, and today it is saved only by the `db()` read further up the handler.
 *
 * ASSERTING ON THE LOG, NOT ON THE REFUSAL. `sendInviteVerificationEmail` is
 * documented to never throw: it swallows every send failure and reports it
 * through its return value, so the invitee gets the same `failed-precondition`
 * either way and the refusal text cannot tell the two versions apart. The
 * swallowed error IS logged, as `invite.verification.send.failed`, so that log is
 * where the defect is visible.
 *
 * HOW IT DISCRIMINATES. Only `db` is stubbed, through `importOriginal`, so
 * nothing initializes the app before the auth call while `getAdmin` stays the
 * REAL accessor with the real `ensureApp()` behind it. `firebase-admin/auth` is
 * NOT mocked. Against the bare `getAuth()` this test replaces, the swallowed
 * error is the default-app message and `getApps()` is still empty — both
 * assertions below fail. Against `getAdmin().auth()` the app is really
 * initialized and the link request goes on to a REST call, which is refused by
 * the closed port FIREBASE_AUTH_EMULATOR_HOST names, so nothing leaves the
 * machine and no credentials are loaded. That refusal is still a failed send,
 * and still logged — the point is which failure it is.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';

const mocks = vi.hoisted(() => ({
  logs: [] as Array<{ event?: string; extra?: Record<string, unknown> }>,
}));

vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: vi.fn(async () => 'msg-1') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn(async () => ['n1']) }));
vi.mock('../src/lib/logger', () => ({
  logEvent: (entry: { event?: string; extra?: Record<string, unknown> }) => {
    mocks.logs.push(entry);
  },
}));

/**
 * Firestore only. `getAdmin` is deliberately left as the real export: it is the
 * accessor under test.
 */
vi.mock('../src/lib/firestoreAdmin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/firestoreAdmin')>();
  return {
    ...actual,
    db: () => ({
      doc: () => ({
        get: async () => ({
          exists: true,
          data: () => ({
            status: 'EMAIL_SENT',
            invitedEmail: 'kin@example.test',
            tribeId: 't1',
            proposedRole: 'SECONDARY',
            proposedPermissions: {},
            expiresAt: { toMillis: () => Date.now() + 100_000 },
          }),
        }),
      }),
    }),
  };
});

const saved = { ...process.env };

beforeAll(() => {
  process.env.GCLOUD_PROJECT = 'demo-912-appinit-accept';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9'; // closed port: nothing answers
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.test';
});

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  process.env = saved;
});

describe('acceptInvite: runs in a process where nobody initialized the Admin SDK', () => {
  it('mints the verification link without "default Firebase app does not exist"', async () => {
    expect(getApps()).toHaveLength(0);

    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const call = acceptInviteHandler({
      auth: { uid: 'u-912', token: { email: 'kin@example.test', email_verified: false } },
      data: { inviteId: 'i-912' },
    } as never);

    let thrown: unknown = null;
    await Promise.race([
      call.catch((err: unknown) => {
        thrown = err;
      }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    call.catch(() => undefined); // it may still be waiting on the closed port

    // The unverified-email branch is the one that mints the link.
    expect(String((thrown as Error)?.message ?? thrown ?? '')).not.toMatch(
      /default Firebase app does not exist/i,
    );
    const sendFailures = mocks.logs.filter((l) => l.event === 'invite.verification.send.failed');
    expect(
      sendFailures.map((l) => String(l.extra?.err ?? '')).join(' | '),
      'the swallowed send failure must not be the default-app error',
    ).not.toMatch(/default Firebase app does not exist/i);
    // The handler's own auth access initialized the default app.
    expect(getApps().length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
