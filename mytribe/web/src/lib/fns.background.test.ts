import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from './fns';
import { resetRevokedSessionForTest } from './revokedSession';

/**
 * #1282: `CallOptions.background`. A warm-up read that is refused must not be
 * the thing that signs the household out; the screen's own foreground call is.
 * Same harness as fns.test.ts.
 */

vi.mock('./firebase', () => ({ functions: {}, auth: { name: 'test-auth' } }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./auth', () => ({ purgeSessionCaches: vi.fn() }));

const revoked = new FirebaseError('functions/unauthenticated', 'Your session was ended (session-revoked). Sign in again.');

beforeEach(() => {
  resetRevokedSessionForTest();
  vi.mocked(firebaseSignOut).mockClear();
});

describe('call with { background: true }', () => {
  it('rethrows a revoked-session refusal without signing the household out', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(revoked) as never);
    await expect(call('getMyInvoices', {}, { background: true })).rejects.toBe(revoked);
    expect(firebaseSignOut).not.toHaveBeenCalled();
  });

  it('the same refusal in the foreground still ends the session', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(revoked) as never);
    await expect(call('getMyInvoices', {})).rejects.toBe(revoked);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('returns the result data like any other call', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: { invoices: [] } }) as never);
    await expect(call('getMyInvoices', {}, { background: true })).resolves.toEqual({ invoices: [] });
  });
});
