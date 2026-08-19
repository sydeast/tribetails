import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * The household photo archive behind the Tribe hub's "All photos" (#399 item 1).
 *
 * The tenant boundary is the assertion that matters most here: this reads the
 * FLAT `kin_care_reports` collection, so unlike a subcollection read the path
 * itself does not scope it. `resolveKinfolkAccess` plus the `kinfolkId ==`
 * predicate are the whole of the scoping, and both are asserted below.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

const SENT_NEW = '2026-08-10T12:00:00.000Z';
const SENT_OLD = '2026-08-01T12:00:00.000Z';

function tale(id: string, sentAt: string, mediaFileIds: string[], title = '') {
  return { id, data: { kinfolkId: 'f1', sentAt, title, mediaFileIds } };
}

function mediaDoc(url: string, mimeType: string | null = 'image/jpeg') {
  return mimeType === null ? { storageUrl: url } : { storageUrl: url, mimeType };
}

/** Two sent tales, four resolvable photos between them, plus a two-Kin roster. */
function household() {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['f1'] },
      'media_files/m1': mediaDoc('https://cdn/1.jpg'),
      'media_files/m2': mediaDoc('https://cdn/2.jpg'),
      'media_files/m3': mediaDoc('https://cdn/3.mp4', 'video/mp4'),
      'media_files/m4': mediaDoc('https://cdn/4.jpg', null),
    },
    queryDocs: {
      kin_care_reports: [
        tale('t2', SENT_NEW, ['m1', 'm2'], 'Beach day'),
        tale('t1', SENT_OLD, ['m3', 'm4']),
      ],
      'families/f1/kin': [
        { id: 'k1', data: { name: 'Biscuit', status: 'active', photoUrl: 'https://cdn/biscuit.jpg' } },
        { id: 'k2', data: { name: 'Nutmeg', status: 'active' } },
      ],
    },
  });
}

describe('getMyKinPhotosHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    await expect(getMyKinPhotosHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it("returns the household's photos newest first, with the tale each came from", async () => {
    mocks.dbFn.mockReturnValue(household().db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));

    expect(res.photos.map((p) => p.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(res.photos[0]).toMatchObject({
      url: 'https://cdn/1.jpg',
      contentType: 'image/jpeg',
      taleId: 't2',
      taleTitle: 'Beach day',
      takenAtMs: new Date(SENT_NEW).getTime(),
    });
    // A media doc with no mimeType is described as unknown, not dropped.
    expect(res.photos[3]).toMatchObject({ id: 'm4', contentType: null });
  });

  it('includes Kin portraits on the first page and names the Kin', async () => {
    mocks.dbFn.mockReturnValue(household().db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    // Nutmeg has no photoUrl, so there is no portrait to show. One Kin, one tile.
    expect(res.portraits).toEqual([
      { kinId: 'k1', kinName: 'Biscuit', url: 'https://cdn/biscuit.jpg' },
    ]);
  });

  it('leaves portraits off a later page, so the same faces do not repeat', async () => {
    mocks.dbFn.mockReturnValue(household().db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(
      callableRequest({ before: new Date(SENT_NEW).getTime() }, { uid: 'u1' }),
    );
    expect(res.portraits).toEqual([]);
  });

  it('hides a Kin the roster hides, and keeps a memorial Kin visible', async () => {
    // `isPortalHiddenKinStatus` hides only the legacy admin spellings; a
    // memorial Kin (`noLongerWithUs`) stays on the roster and keeps its photo,
    // which is much of the point of a gallery for a household that lost one.
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] } },
      queryDocs: {
        kin_care_reports: [],
        'families/f1/kin': [
          { id: 'k1', data: { name: 'Archived', status: 'archived', photoUrl: 'https://cdn/a.jpg' } },
          { id: 'k2', data: { name: 'Remembered', status: 'noLongerWithUs', photoUrl: 'https://cdn/r.jpg' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.portraits).toEqual([
      { kinId: 'k2', kinName: 'Remembered', url: 'https://cdn/r.jpg' },
    ]);
  });

  it('skips a media record that is missing or carries no URL, rather than tiling a blank', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'media_files/m1': mediaDoc('https://cdn/1.jpg'),
        'media_files/m2': { mimeType: 'image/jpeg' },
      },
      queryDocs: {
        kin_care_reports: [tale('t1', SENT_NEW, ['m1', 'm2', 'missing-id'])],
        'families/f1/kin': [],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.photos.map((p) => p.id)).toEqual(['m1']);
  });

  it('shows a photo attached to two tales once', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'media_files/m1': mediaDoc('https://cdn/1.jpg'),
      },
      queryDocs: {
        kin_care_reports: [tale('t2', SENT_NEW, ['m1']), tale('t1', SENT_OLD, ['m1'])],
        'families/f1/kin': [],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.photos).toHaveLength(1);
    // The most recent tale is the one it is credited to.
    expect(res.photos[0]?.taleId).toBe('t2');
  });

  it('reports the empty archive as empty, not as a failure', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] } },
      queryDocs: { kin_care_reports: [], 'families/f1/kin': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ photos: [], portraits: [], hasMore: false, nextBefore: null });
  });

  it('pages by tale and hands back a cursor', async () => {
    mocks.dbFn.mockReturnValue(household().db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({ limit: 1 }, { uid: 'u1' }));
    expect(res.hasMore).toBe(true);
    expect(res.nextBefore).toBe(new Date(SENT_NEW).getTime());
    expect(res.photos.map((p) => p.taleId)).toEqual(['t2', 't2']);
  });

  it('refuses a page size outside the allowed range', async () => {
    mocks.dbFn.mockReturnValue(household().db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    await expect(
      getMyKinPhotosHandler(callableRequest({ limit: 500 }, { uid: 'u1' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it("denies a household that is not the caller's own", async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['OTHER'] } },
      queryDocs: { kin_care_reports: [], 'families/f1/kin': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    await expect(
      getMyKinPhotosHandler(callableRequest({ kinfolkId: 'f1' }, { uid: 'u1' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('never returns another household’s tale, even from the flat collection', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'media_files/mine': mediaDoc('https://cdn/mine.jpg'),
        'media_files/theirs': mediaDoc('https://cdn/theirs.jpg'),
      },
      queryDocs: {
        kin_care_reports: [
          { id: 't-mine', data: { kinfolkId: 'f1', sentAt: SENT_NEW, mediaFileIds: ['mine'] } },
          { id: 't-theirs', data: { kinfolkId: 'OTHER', sentAt: SENT_NEW, mediaFileIds: ['theirs'] } },
        ],
        'families/f1/kin': [],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.photos.map((p) => p.id)).toEqual(['mine']);
  });

  it('leaves an unsent draft out of the archive', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'media_files/draft': mediaDoc('https://cdn/draft.jpg'),
        'media_files/sent': mediaDoc('https://cdn/sent.jpg'),
      },
      queryDocs: {
        kin_care_reports: [
          { id: 't-sent', data: { kinfolkId: 'f1', sentAt: SENT_NEW, mediaFileIds: ['sent'] } },
          { id: 't-draft', data: { kinfolkId: 'f1', sentAt: '', mediaFileIds: ['draft'] } },
        ],
        'families/f1/kin': [],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinPhotosHandler } = await import('../src/portal/getMyKinPhotos');
    const res = await getMyKinPhotosHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.photos.map((p) => p.id)).toEqual(['sent']);
  });
});
