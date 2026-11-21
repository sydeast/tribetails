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
  auditMock.mockClear();
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

  it("copies the tale's title into the share payload (#1322)", async () => {
    loadMemberMock.mockResolvedValue({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} });
    requirePrimaryMock.mockReturnValue(undefined);
    taleGet.mockResolvedValue({
      exists: true,
      data: () => ({ title: '  Biscuit at the beach ', bodyCopy: 'hi', mediaFileIds: [], authorDisplayName: 'P', kinfolkId: 'f1' }),
    });
    sharedAdd.mockResolvedValue({ id: 'share-1' });
    const { createShareLinkHandler } = await import('../src/share/createShareLink');
    await createShareLinkHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
    } as never);
    expect(sharedAdd.mock.calls[0][0].scrubbedPayload).toEqual({
      authorDisplayName: 'P',
      title: 'Biscuit at the beach',
      body: 'hi',
      photos: [],
    });
  });
  it('stores an empty title for a tale that has none (#1322)', async () => {
    loadMemberMock.mockResolvedValue({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} });
    requirePrimaryMock.mockReturnValue(undefined);
    taleGet.mockResolvedValue({
      exists: true,
      data: () => ({ bodyCopy: 'hi', mediaFileIds: [], authorDisplayName: 'P', kinfolkId: 'f1' }),
    });
    sharedAdd.mockResolvedValue({ id: 'share-1' });
    const { createShareLinkHandler } = await import('../src/share/createShareLink');
    await createShareLinkHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
    } as never);
    expect(sharedAdd.mock.calls[0][0].scrubbedPayload.title).toBe('');
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

  /**
   * With photos on, a share link carries the tale's own photos: a visit's, a
   * Kin's and a household's, and a file older than the stored kind. A file
   * stored as any other kind is left off the link, whatever ids the tale
   * carries (`taleShowsMedia`, lib/kinTaleThumbs.ts).
   */
  describe('the photos a share link carries', () => {
    const url = (name: string) => `https://res.cloudinary.com/tribetails/image/upload/v1/${name}.jpg`;

    /** Serves the tale and its media files by path, the way the handler reads them. */
    function seed(mediaFileIds: string[], files: Record<string, Record<string, unknown>>) {
      taleGet.mockImplementation(async (path: string) => {
        if (path === 'kin_care_reports/t1') {
          return {
            exists: true,
            data: () => ({ bodyCopy: 'hi', mediaFileIds, authorDisplayName: 'Auntie', kinfolkId: 'f1' }),
          };
        }
        const file = files[path.replace('media_files/', '')];
        return file ? { exists: true, data: () => file } : { exists: false, data: () => undefined };
      });
      sharedAdd.mockResolvedValue({ id: 'share-photos' });
      taleUpdate.mockResolvedValue(undefined);
    }

    async function sharedPhotos(auth: unknown, includePhotos = true): Promise<string[]> {
      const { createShareLinkHandler } = await import('../src/share/createShareLink');
      await createShareLinkHandler({
        auth,
        data: { familyId: 'f1', kinTaleId: 't1', includePhotos },
      } as never);
      const stored = sharedAdd.mock.calls[0]![0] as { scrubbedPayload: { photos: string[] } };
      return stored.scrubbedPayload.photos;
    }

    const OWNER = { uid: 'owner-1', token: { admin: true } };
    const AUNTIE = { uid: 'auntie-1', token: { staffRole: 'auntie' } };
    const PRIMARY = { uid: 'u-prim' };

    beforeEach(() => {
      loadMemberMock.mockResolvedValue({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} });
      requirePrimaryMock.mockReturnValue(undefined);
    });

    it('HAPPY: each of the five stored kinds is on the link, in the order the tale holds them', async () => {
      const kinds = ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk'];
      const files = Object.fromEntries(kinds.map((k, i) => [`m${i}`, { storageUrl: url(`m${i}`), entityType: k }]));
      seed(Object.keys(files), files);
      expect(await sharedPhotos(PRIMARY)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'].map(url));
    });

    it('HAPPY: a file with no stored kind, or a blank one, is still on the link', async () => {
      seed(['older', 'blank'], {
        older: { storageUrl: url('older') },
        blank: { storageUrl: url('blank'), entityType: '' },
      });
      expect(await sharedPhotos(PRIMARY)).toEqual([url('older'), url('blank')]);
    });

    it.each([
      ['the household', PRIMARY],
      ['the owner', OWNER],
      ['an Auntie', AUNTIE],
    ])('NEGATIVE: shared by %s, a file of another kind on the tale is left off the link', async (_who, auth) => {
      seed(['intel', 'visit', 'company', 'account', 'later', 'gone'], {
        visit: { storageUrl: url('visit'), entityType: 'VISIT_LOG' },
        intel: { storageUrl: url('intel'), entityType: 'TRIBAL_INTEL' },
        company: { storageUrl: url('company'), entityType: 'BUSINESS' },
        account: { storageUrl: url('account'), entityType: 'USER' },
        later: { storageUrl: url('later'), entityType: 'SOMETHING_NEW' },
      });
      expect(await sharedPhotos(auth)).toEqual([url('visit')]);
      const stored = JSON.stringify(sharedAdd.mock.calls[0]![0]);
      for (const name of ['intel', 'company', 'account', 'later']) expect(stored).not.toContain(url(name));
    });

    it('SAD: with photos off, no media file is read and the link carries none', async () => {
      seed(['visit'], { visit: { storageUrl: url('visit'), entityType: 'VISIT_LOG' } });
      expect(await sharedPhotos(PRIMARY, false)).toEqual([]);
      expect(taleGet.mock.calls.map((c) => c[0])).toEqual(['kin_care_reports/t1']);
    });
  });

  describe('SHARE_LINK_BASE_URL guard', () => {
    const call = () => {
      loadMemberMock.mockResolvedValue({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} });
      requirePrimaryMock.mockReturnValue(undefined);
      taleGet.mockResolvedValue({
        exists: true,
        data: () => ({ bodyCopy: 'hi', mediaFileIds: [], authorDisplayName: 'P', kinfolkId: 'f1' }),
      });
      sharedAdd.mockResolvedValue({ id: 'share-1' });
      taleUpdate.mockResolvedValue(undefined);
      return import('../src/share/createShareLink').then(({ createShareLinkHandler }) =>
        createShareLinkHandler({
          auth: { uid: 'u-prim' },
          data: { familyId: 'f1', kinTaleId: 't1', includePhotos: false },
        } as never),
      );
    };

    it('throws failed-precondition, and writes nothing, when unset', async () => {
      delete process.env.SHARE_LINK_BASE_URL;
      await expect(call()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('SHARE_LINK_BASE_URL'),
      });
      expect(sharedAdd).not.toHaveBeenCalled();
      expect(taleUpdate).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('throws failed-precondition, and writes nothing, when empty', async () => {
      process.env.SHARE_LINK_BASE_URL = '';
      await expect(call()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('SHARE_LINK_BASE_URL'),
      });
      expect(sharedAdd).not.toHaveBeenCalled();
      expect(taleUpdate).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('throws failed-precondition, and writes nothing, when only slashes', async () => {
      // Normalization strips a trailing slash before the emptiness check
      // runs, so a value of just "/" (or "///") must not slip through as
      // "configured" — it strips down to "", same as unset.
      process.env.SHARE_LINK_BASE_URL = '/';
      await expect(call()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('SHARE_LINK_BASE_URL'),
      });
      expect(sharedAdd).not.toHaveBeenCalled();
      expect(taleUpdate).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('is not invalid-argument: a misconfigured server is not the caller’s fault', async () => {
      delete process.env.SHARE_LINK_BASE_URL;
      await expect(call()).rejects.not.toMatchObject({ code: 'invalid-argument' });
    });

    it('strips a trailing slash from the base URL instead of doubling it', async () => {
      process.env.SHARE_LINK_BASE_URL = 'https://kinfolk.tribetails.com/share/';
      const out = await call();
      expect(out.shareUrl).toBe('https://kinfolk.tribetails.com/share/share-1');
    });
  });
});
