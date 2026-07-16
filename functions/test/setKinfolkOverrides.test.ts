import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberGet = vi.fn();
const docUpdate = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: memberGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  memberGet.mockReset();
  docUpdate.mockClear();
  auditMock.mockClear();
});

describe('setKinfolkOverridesHandler', () => {
  it('SECONDARY denied', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { setKinfolkOverridesHandler } = await import('../src/theme/setKinfolkOverrides');
    await expect(
      setKinfolkOverridesHandler({
        auth: { uid: 'u-sec' },
        data: { familyId: 'f1', overrides: { layoutDensity: 'comfy' } },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('PRIMARY filters allowlisted keys', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
    const { setKinfolkOverridesHandler } = await import('../src/theme/setKinfolkOverrides');
    const r = await setKinfolkOverridesHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', overrides: { layoutDensity: 'comfy', maliciousKey: 'x' } },
    } as any);
    expect(r.ok).toBe(true);
    const arg = docUpdate.mock.calls[0][0];
    expect(arg.kinfolkOverrides).toEqual({ layoutDensity: 'comfy' });
  });
});
