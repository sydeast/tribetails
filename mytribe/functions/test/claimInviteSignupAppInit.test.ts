/**
 * #912: `claimInviteSignup` deploys as its own Cloud Run service, and nothing in
 * that process initializes the Admin SDK at module load — `lib/firestoreAdmin.ts`
 * does it lazily, on the first guarded accessor. A bare `getAuth()` resolves the
 * DEFAULT app and throws "The default Firebase app does not exist" the moment it
 * is the first admin call on the path.
 *
 * On today's code it is not the first call: `enforceRateLimit` and the invite
 * read both go through `db()` beforehand, so the app is already up by the time
 * the handler reaches auth. That is an accident of statement order, not a
 * guarantee — moving the auth lookup above the invite read, or short-circuiting
 * the rate limiter, would make it throw on every signup. This file removes the
 * accident by proving the handler initializes the app through its OWN auth
 * access.
 *
 * HOW IT DISCRIMINATES. Only `db` is stubbed, through `importOriginal`, so the
 * one thing that would otherwise initialize the app first is gone while
 * `getAdmin` stays the REAL accessor with the real `ensureApp()` behind it.
 * `firebase-admin/auth` is NOT mocked — mocking it is exactly what would hide
 * the defect. Against the bare `getAuth()` this test replaces, the handler
 * rejects with "The default Firebase app does not exist" and leaves `getApps()`
 * empty; both assertions below fail. Against `getAdmin().auth()` the app is
 * really initialized and the call goes on to a REST request.
 *
 * That request never leaves the machine: FIREBASE_AUTH_EMULATOR_HOST points at a
 * closed local port, so it is refused, and no credentials are ever loaded.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';

vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

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
            expiresAt: { toMillis: () => Date.now() + 100_000 },
          }),
        }),
      }),
    }),
  };
});

const saved = { ...process.env };

beforeAll(() => {
  process.env.GCLOUD_PROJECT = 'demo-912-appinit';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9'; // closed port: nothing answers
});

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  process.env = saved;
});

describe('claimInviteSignup: runs in a process where nobody initialized the Admin SDK', () => {
  it('reaches Firebase Auth without "default Firebase app does not exist"', async () => {
    expect(getApps()).toHaveLength(0);

    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    const call = claimInviteSignupHandler({
      data: { inviteId: 'i-912', password: 'longenough' },
      rawRequest: { headers: { 'x-forwarded-for': '203.0.113.9, 35.191.0.9' } },
    } as never);

    let thrown: unknown = null;
    await Promise.race([
      call.catch((err: unknown) => {
        thrown = err;
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    call.catch(() => undefined); // it may still be waiting on the closed port

    expect(String((thrown as Error)?.message ?? thrown ?? '')).not.toMatch(
      /default Firebase app does not exist/i,
    );
    // The handler's own auth access initialized the default app.
    expect(getApps().length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
