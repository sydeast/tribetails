/**
 * confirmSecureReset is a v2 onRequest function, so it deploys as its own Cloud
 * Run service. Nothing in that process initializes the Admin SDK before it runs:
 * `lib/firestoreAdmin.ts` does it lazily, on the first `db()` or `auth()`. A bare
 * `getFirestore()` or `getAuth()` there throws "The default Firebase app does not
 * exist" on every request (#903 review, found from the #904 review).
 *
 * THIS FILE MOCKS NOTHING THAT COULD HIDE THAT. No `firebase-admin/app`, no
 * `firebase-admin/firestore`, no `firebase-admin/auth`, no `lib/firestoreAdmin`,
 * and no global `initializeApp`. Only the network edges are stubbed: `fetch`, the
 * notification dispatcher and Sentry. Firestore is pointed at a closed local port
 * through FIRESTORE_EMULATOR_HOST, so the SDK never loads credentials and never
 * leaves the machine.
 *
 * A bare getter throws synchronously, on the first admin call, before any
 * network. The fixed handler instead gets as far as a Firestore request that
 * cannot connect, and is still waiting when the race below settles.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';

vi.mock('../src/notifications/dispatcher.js', () => ({ enqueueNotification: vi.fn(async () => ['n1']) }));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn(async () => ['n1']) }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn(), initSentry: vi.fn() }));

const saved = { ...process.env };

beforeAll(() => {
  process.env.GCLOUD_PROJECT = 'demo-892-appinit';
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:9'; // closed port: nothing answers
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9';
  process.env.WEB_API_KEY = 'test-api-key';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ email: 'pepper@tribetails.test', requestType: 'PASSWORD_RESET' }),
      text: async () => '{}',
    })),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all(getApps().map((app) => deleteApp(app)));
  process.env = saved;
});

describe('confirmSecureReset: runs in a process where nobody initialized the Admin SDK', () => {
  it('does not throw "default Firebase app does not exist" on a request', async () => {
    expect(getApps()).toHaveLength(0);

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const request = confirmSecureResetHandler(
      {
        method: 'POST',
        body: { oobCode: 'oob-appinit-1', newPassword: 'hunter2hunter' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
        socket: { remoteAddress: '10.0.0.1' },
      },
      res,
    );

    let thrown: unknown = null;
    await Promise.race([
      request.catch((err: unknown) => {
        thrown = err;
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    request.catch(() => undefined); // it may still be waiting on the closed port

    expect(String(thrown ?? '')).not.toMatch(/default Firebase app does not exist/);
    // The handler's first admin call initialized the default app itself.
    expect(getApps().length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
