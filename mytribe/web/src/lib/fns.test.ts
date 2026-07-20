import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it, vi } from 'vitest';
import { call, CallableTimeoutError } from './fns';

vi.mock('./firebase', () => ({ functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));

describe('call', () => {
  it('returns the callable result data', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: { ok: true } }) as never);
    await expect(call('getMyHome', {})).resolves.toEqual({ ok: true });
  });

  it('passes a bounded timeout to httpsCallable so a stuck call cannot hang forever', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: {} }) as never);
    await call('getMyHome', {});
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'getMyHome', { timeout: 20_000 });
  });

  it('converts a deadline-exceeded rejection into a CallableTimeoutError naming the callable', async () => {
    const deadlineExceeded = new FirebaseError('functions/deadline-exceeded', 'deadline exceeded');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(deadlineExceeded) as never);
    await expect(call('addKinTaleComment', {})).rejects.toThrow(CallableTimeoutError);
    await expect(call('addKinTaleComment', {})).rejects.toThrow(/addKinTaleComment/);
  });

  it('rethrows non-timeout errors unchanged', async () => {
    const permissionDenied = new FirebaseError('functions/permission-denied', 'nope');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(permissionDenied) as never);
    await expect(call('archiveKin', {})).rejects.toBe(permissionDenied);
  });
});
