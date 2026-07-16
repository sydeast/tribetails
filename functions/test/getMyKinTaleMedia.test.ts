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
});
