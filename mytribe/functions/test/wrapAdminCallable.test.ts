import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn().mockReturnValue('s1'), initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
// #557: wrapAdminCallable delegates to wrapCallable, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = 'uid-auntie';
});

describe('wrapAdminCallable', () => {
  it('rejects non-allowlisted callers', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'uid-stranger' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('allows allowlisted caller', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    const r = await wrapped({ auth: { uid: 'uid-auntie' } } as any);
    expect(r.ok).toBe(true);
  });

  it('rejects unauthenticated', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    await expect(wrapped({ auth: undefined } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
