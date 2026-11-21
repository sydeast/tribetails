import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyKinTaleMediaHandler', () => {
  it('rejects unauth', async () => {
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    await expect(
      getMyKinTaleMediaHandler({ data: { taleId: 't1' }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns empty array when no mediaFileIds', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'fam3', mediaFileIds: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toEqual([]);
  });

  it('reads media_files docs and returns storageUrl as CDN url', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': {
          kinfolkId: 'fam3',
          mediaFileIds: ['mf1', 'mf2'],
        },
        'media_files/mf1': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg', mimeType: 'image/jpeg' },
        'media_files/mf2': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/video/upload/q_auto/clip1.mp4', mimeType: 'video/mp4' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toHaveLength(2);
    expect(res.media[0].id).toBe('mf1');
    expect(res.media[0].url).toBe('https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg');
    expect(res.media[0].contentType).toBe('image/jpeg');
    expect(res.media[1].contentType).toBe('video/mp4');
  });

  it('throws not-found when kinfolkId mismatch', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'other_fam', mediaFileIds: ['mf1'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    await expect(
      getMyKinTaleMediaHandler({
        data: { taleId: 't1', kinfolkId: 'fam3' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('skips media_files doc that is missing storageUrl', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'fam3', mediaFileIds: ['mf1', 'mf_bad'] },
        'media_files/mf1': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg', mimeType: 'image/jpeg' },
        'media_files/mf_bad': { storageUrl: '', mimeType: 'image/jpeg' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toHaveLength(1);
    expect(res.media[0].id).toBe('mf1');
  });

  /**
   * A tale shows its own photos: a visit's, a Kin's and a household's, and a
   * file older than the stored kind. A file stored as any other kind is left
   * out, whatever ids the tale carries (`taleShowsMedia`, lib/kinTaleThumbs.ts).
   */
  describe('the kinds of file a tale shows', () => {
    const url = (name: string) => `https://res.cloudinary.com/tribetails/image/upload/v1/${name}.jpg`;
    const media = (name: string, entityType?: unknown) => ({
      storageUrl: url(name),
      mimeType: 'image/jpeg',
      ...(entityType === undefined ? {} : { entityType }),
    });

    async function mediaOf(mediaFileIds: string[], files: Record<string, Record<string, unknown>>, auth: unknown) {
      const ctx = buildDbMock({
        docs: {
          'clients/u1': { kinfolkIds: ['fam3'] },
          'kinfolk/fam3': { firstName: 'Dre', lastName: 'East' },
          'kin_care_reports/t1': { kinfolkId: 'fam3', mediaFileIds },
          ...Object.fromEntries(Object.entries(files).map(([id, f]) => [`media_files/${id}`, f])),
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
      const res = await getMyKinTaleMediaHandler({ data: { taleId: 't1', kinfolkId: 'fam3' }, auth } as any);
      return res.media;
    }

    const HOUSEHOLD = { uid: 'u1' };
    const OWNER = { uid: 'owner-1', token: { admin: true } };
    const AUNTIE = { uid: 'auntie-1', token: { staffRole: 'auntie' } };

    it('HAPPY: each of the five stored kinds comes back, in the order the tale holds them', async () => {
      const kinds = ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk'];
      const files = Object.fromEntries(kinds.map((k, i) => [`m${i}`, media(`m${i}`, k)]));
      const got = await mediaOf(Object.keys(files), files, HOUSEHOLD);
      expect(got.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    });

    it('HAPPY: a file with no stored kind, or a blank one, still comes back', async () => {
      const got = await mediaOf(
        ['older', 'blank', 'nulled'],
        { older: media('older'), blank: media('blank', ''), nulled: media('nulled', null) },
        HOUSEHOLD,
      );
      expect(got.map((m) => m.id)).toEqual(['older', 'blank', 'nulled']);
    });

    it.each([
      ['a household member', HOUSEHOLD],
      ['the owner', OWNER],
      ['an Auntie', AUNTIE],
    ])('NEGATIVE: for %s, a file of another kind on the tale is left out and its address is not returned', async (_who, auth) => {
      const files = {
        visit: media('visit', 'VISIT_LOG'),
        intel: media('intel', 'TRIBAL_INTEL'),
        company: media('company', 'BUSINESS'),
        account: media('account', 'USER'),
        later: media('later', 'SOMETHING_NEW'),
        odd: media('odd', 7),
      };
      const got = await mediaOf(['intel', 'visit', 'company', 'account', 'later', 'odd'], files, auth);
      expect(got).toEqual([{ id: 'visit', url: url('visit'), contentType: 'image/jpeg' }]);
      const sent = JSON.stringify(got);
      for (const name of ['intel', 'company', 'account', 'later', 'odd']) expect(sent).not.toContain(url(name));
    });

    it('SAD: a tale holding only files of another kind returns an empty list, not an error', async () => {
      const got = await mediaOf(['intel'], { intel: media('intel', 'TRIBAL_INTEL') }, AUNTIE);
      expect(got).toEqual([]);
    });
  });
});
