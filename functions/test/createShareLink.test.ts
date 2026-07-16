import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadMemberMock = vi.fn();
const requirePrimaryMock = vi.fn();
const taleGet = vi.fn();
const sharedAdd = vi.fn();
const taleUpdate = vi.fn();
const auditMock = vi.fn().mockResolvedValue('a1');

vi.mock('../src/lib/memberGate', () => ({
  loadMember: (...a: unknown[]) => loadMemberMock(...a),
  requirePrimary: (...a: unknown[]) => requirePrimaryMock(...a),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => ({
      get: () => taleGet(p),
      update: (...a: unknown[]) => taleUpdate(p, ...a),
    }),
    collection: (_c: string) => ({ add: (d: unknown) => sharedAdd(d) }),
  }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));
vi.mock('argon2', () => ({ default: { hash: async (s: string) => `h:${s}` } }));

beforeEach(() => {
  loadMemberMock.mockReset();
  requirePrimaryMock.mockReset();
  taleGet.mockReset();
  sharedAdd.mockReset();
  taleUpdate.mockReset();
  process.env.SHARE_LINK_BASE_URL = 'https://kinfolk.tribetails.com/share';
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

describe('createShareLinkHandler', () => {
  it('happy path returns shareId+url', async () => {
    loadMemberMock.mockResolvedValue({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} });
    requirePrimaryMock.mockReturnValue(undefined);
    taleGet.mockResolvedValue({
      exists: true,
      data: () => ({ bodyCopy: 'hi', mediaFileIds: [], authorDisplayName: 'P', kinfolkId: 'f1' }),
    });
    sharedAdd.mockResolvedValue({ id: 'share-1' });
    taleUpdate.mockResolvedValue(undefined);
    const { createShareLinkHandler } = await import('../src/share/createShareLink');
    const out = await createShareLinkHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
    } as never);
    expect(out.shareId).toBe('share-1');
    expect(out.shareUrl).toBe('https://kinfolk.tribetails.com/share/share-1');
    expect(auditMock).toHaveBeenCalled();
  });

  it('SECONDARY denied via requirePrimary', async () => {
    loadMemberMock.mockResolvedValue({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} });
    requirePrimaryMock.mockImplementation(() => {
      throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
    });
    const { createShareLinkHandler } = await import('../src/share/createShareLink');
    await expect(createShareLinkHandler({
      auth: { uid: 'u-sec' },
      data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
    } as never)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('AuntieOS operator bypasses the family PRIMARY gate', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'u-op,u-other';
    taleGet.mockResolvedValue({
      exists: true,
      data: () => ({ bodyCopy: 'hi', mediaFileIds: [], authorDisplayName: 'Auntie', kinfolkId: 'f1' }),
    });
    sharedAdd.mockResolvedValue({ id: 'share-op' });
    taleUpdate.mockResolvedValue(undefined);
    const { createShareLinkHandler } = await import('../src/share/createShareLink');
    const out = await createShareLinkHandler({
      auth: { uid: 'u-op' },
      data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
    } as never);
    expect(out.shareId).toBe('share-op');
    // operator path must NOT consult the family member gate
    expect(loadMemberMock).not.toHaveBeenCalled();
    expect(requirePrimaryMock).not.toHaveBeenCalled();
  });
});
