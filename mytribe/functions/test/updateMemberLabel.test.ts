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

describe('updateMemberLabelHandler', () => {
  it('SECONDARY denied', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateMemberLabelHandler } = await import('../src/membership/updateMemberLabel');
    await expect(
      updateMemberLabelHandler({
        auth: { uid: 'u-sec' },
        data: { familyId: 'f1', targetUid: 'u-x', secondaryLabel: 'X' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('PRIMARY sanitizes and writes label', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
    const { updateMemberLabelHandler } = await import('../src/membership/updateMemberLabel');
    const r = await updateMemberLabelHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', targetUid: 'u-sec', secondaryLabel: 'CoParent' },
    } as any);
    expect(r.ok).toBe(true);
    const arg = docUpdate.mock.calls[0][0];
    expect(arg.secondaryLabel).toBe('CoParent');
    expect(auditMock).toHaveBeenCalled();
  });
});
