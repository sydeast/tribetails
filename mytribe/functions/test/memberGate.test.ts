import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: getMock }) }),
}));

beforeEach(() => getMock.mockReset());

describe('loadMember', () => {
  it('returns ACTIVE PRIMARY', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: { kin_edit: true } }),
    });
    const { loadMember } = await import('../src/lib/memberGate');
    const m = await loadMember('f1', 'u1');
    expect(m.role).toBe('PRIMARY');
  });

  it('throws permission-denied when SUSPENDED', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'SECONDARY', status: 'SUSPENDED', permissions: {} }),
    });
    const { loadMember } = await import('../src/lib/memberGate');
    await expect(loadMember('f1', 'u1')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('throws permission-denied when missing', async () => {
    getMock.mockResolvedValue({ exists: false });
    const { loadMember } = await import('../src/lib/memberGate');
    await expect(loadMember('f1', 'u1')).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('requirePerm', () => {
  it('PRIMARY satisfies any perm', async () => {
    const { requirePerm } = await import('../src/lib/memberGate');
    requirePerm({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} } as any, 'billing_full');
  });

  it('SECONDARY without perm denied', async () => {
    const { requirePerm } = await import('../src/lib/memberGate');
    expect(() => requirePerm({
      role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false },
    } as any, 'billing_full')).toThrowError(/permission-denied/);
  });
});

// CRITICAL-4: the centralized portal permission gate. Every portal
// write/billing/messaging callable funnels through this.
describe('requireKinfolkPerm', () => {
  beforeEach(() => {
    delete process.env.AUNTIE_OPERATOR_UIDS;
  });

  it('DENIES a kintales_only SECONDARY for a perm it lacks', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({
        role: 'SECONDARY',
        status: 'ACTIVE',
        permissions: {
          billing_full: false,
          messaging_direct: false,
          messaging_group: false,
          kin_edit: false,
          kintales_only: true,
        },
      }),
    });
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    await expect(requireKinfolkPerm('u1', 'f1', 'kin_edit', false, 'memberGate.test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(requireKinfolkPerm('u1', 'f1', 'billing_full', false, 'memberGate.test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(requireKinfolkPerm('u1', 'f1', 'messaging_direct', false, 'memberGate.test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('ALLOWS a SECONDARY that holds the specific perm', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({
        role: 'SECONDARY',
        status: 'ACTIVE',
        permissions: { kin_edit: true, billing_full: false },
      }),
    });
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    // Returns the resolved member so callers can label audits with the real role.
    await expect(requireKinfolkPerm('u1', 'f1', 'kin_edit', false, 'memberGate.test')).resolves.toMatchObject({
      role: 'SECONDARY',
    });
    // but still denied for one it does NOT hold
    await expect(requireKinfolkPerm('u1', 'f1', 'billing_full', false, 'memberGate.test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('ALLOWS a PRIMARY for any perm', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }),
    });
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    await expect(requireKinfolkPerm('u1', 'f1', 'billing_full', false, 'memberGate.test')).resolves.toMatchObject({ role: 'PRIMARY' });
    await expect(requireKinfolkPerm('u1', 'f1', 'kin_edit', false, 'memberGate.test')).resolves.toMatchObject({ role: 'PRIMARY' });
  });

  it('DENIES an INACTIVE member even with the perm flag set', async () => {
    getMock.mockResolvedValue({
      exists: true,
      data: () => ({
        role: 'SECONDARY',
        status: 'SUSPENDED',
        permissions: { kin_edit: true },
      }),
    });
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    await expect(requireKinfolkPerm('u1', 'f1', 'kin_edit', false, 'memberGate.test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('ALLOWS (legacy) when the member doc is MISSING', async () => {
    getMock.mockResolvedValue({ exists: false });
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    // null (not a member doc) on the legacy anti-lockout branch.
    await expect(requireKinfolkPerm('u1', 'f1', 'billing_full', false, 'memberGate.test')).resolves.toBeNull();
  });

  it('ALLOWS (bypass) an auntie operator without reading a member doc', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    getMock.mockReset(); // ensure no member-doc read is required
    const { requireKinfolkPerm } = await import('../src/lib/memberGate');
    // null (no member doc) on the operator-bypass branch.
    await expect(requireKinfolkPerm('op-uid', 'f1', 'billing_full', false, 'memberGate.test')).resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});
