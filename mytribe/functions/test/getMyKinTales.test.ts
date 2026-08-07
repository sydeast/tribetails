import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

const SENT_AT_ISO = '2023-11-14T22:13:20.000Z';
const SENT_AT_MS = new Date(SENT_AT_ISO).getTime(); // 1700000000000

describe('getMyKinTalesHandler', () => {
  it('rejects unauthenticated request', async () => {
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    await expect(
      getMyKinTalesHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('queries kin_care_reports and maps all fields correctly', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r1',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'a story',
              mediaFileIds: ['m1', 'm2'],
              sentAt: SENT_AT_ISO,
              sharedAsIds: ['s1'],
              authorDisplayName: 'TiTi',
            },
          },
          {
            id: 'r2',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'another tale',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
              authorDisplayName: 'Auntie J',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 50 },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales).toHaveLength(2);

    const t1 = res.tales[0];
    expect(t1.id).toBe('r1');
    expect(t1.body).toBe('a story');
    expect(t1.mediaIds).toEqual(['m1', 'm2']);
    expect(t1.sentAtMs).toBe(SENT_AT_MS);
    expect(t1.shared).toBe(true);
    expect(t1.authorDisplayName).toBe('TiTi');

    const t2 = res.tales[1];
    expect(t2.shared).toBe(false);
    expect(t2.mediaIds).toEqual([]);
    expect(t2.sentAtMs).toBe(SENT_AT_MS);

    expect(res.hasMore).toBe(false);
  });

  it('falls back to "Auntie" when authorDisplayName missing or empty', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r-no-author',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'no name',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
            },
          },
          {
            id: 'r-empty-author',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'empty name',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
              authorDisplayName: '',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales[0].authorDisplayName).toBe('Auntie');
    expect(res.tales[1].authorDisplayName).toBe('Auntie');
  });

  it('hasMore is true when exactly limit+1 docs returned', async () => {
    const makeDoc = (id: string) => ({
      id,
      data: {
        kinfolkId: 'fam3',
        bodyCopy: 'x',
        mediaFileIds: [],
        sentAt: SENT_AT_ISO,
        sharedAsIds: [],
      },
    });
    // limit defaults to 20; return 21 docs
    const docs = Array.from({ length: 21 }, (_, i) => makeDoc(`r${i}`));
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { 'kin_care_reports': docs },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales).toHaveLength(20);
    expect(res.hasMore).toBe(true);
  });

  it('passes through gpsRoute and gpsSummary when present', async () => {
    const route = [
      { lat: 37.7749, lng: -122.4194, t: 1700000001000 },
      { lat: 37.775, lng: -122.419 },
    ];
    const summary = { distanceMeters: 1234.5, durationSeconds: 600 };
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r-gps',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'walk in the park',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
              gpsRoute: route,
              gpsSummary: summary,
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    const tale = res.tales[0];
    expect(tale.gpsRoute).toEqual([
      { lat: 37.7749, lng: -122.4194, t: 1700000001000 },
      { lat: 37.775, lng: -122.419 },
    ]);
    expect(tale.gpsSummary).toEqual({ distanceMeters: 1234.5, durationSeconds: 600 });
  });

  it('maps title and petMoods when present, omits/empties when absent or wrong-type', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r-headline',
            data: {
              kinfolkId: 'fam3',
              title: 'Checking on Biscuit',
              bodyCopy: 'great day',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
              petMoodSelections: { kinA: 'happy', kinB: 'sleepy', kinBad: 7 },
            },
          },
          {
            id: 'r-no-extras',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'plain',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
            },
          },
          {
            id: 'r-wrong-types',
            data: {
              kinfolkId: 'fam3',
              title: 42, // wrong type -> empty string
              bodyCopy: 'oops',
              mediaFileIds: [],
              sentAt: SENT_AT_ISO,
              sharedAsIds: [],
              petMoodSelections: ['not', 'a', 'map'], // array -> omitted
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 50 },
      auth: { uid: 'u1' },
    } as any);

    const present = res.tales[0];
    expect(present.title).toBe('Checking on Biscuit');
    // Non-string mood value is dropped, valid string moods survive.
    expect(present.petMoods).toEqual({ kinA: 'happy', kinB: 'sleepy' });

    const absent = res.tales[1];
    expect(absent.title).toBe('');
    expect(absent.petMoods).toBeUndefined();

    const wrong = res.tales[2];
    expect(wrong.title).toBe('');
    expect(wrong.petMoods).toBeUndefined();
  });
});

/**
 * Preview thumbnails (task-24, P3 "photo-first" cards): getMyKinTales now
 * resolves at most the first 8 media documents per tale and returns them as
 * `thumbs`, so the feed card can show photos without a getMyKinTaleMedia
 * round trip per card. `mediaIds` (the true count) is untouched.
 */
describe('getMyKinTalesHandler thumbs', () => {
  const baseTale = (id: string, mediaFileIds: string[]) => ({
    id,
    data: {
      kinfolkId: 'fam3',
      bodyCopy: 'x',
      mediaFileIds,
      sentAt: SENT_AT_ISO,
      sharedAsIds: [],
    },
  });

  it('a tale with 12 media returns exactly 8 thumbs, in media order', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    const mediaDocs: Record<string, Record<string, unknown>> = { 'clients/u1': { kinfolkIds: ['fam3'] } };
    ids.forEach((id) => {
      mediaDocs[`media_files/${id}`] = { storageUrl: `https://cdn/${id}.jpg`, mimeType: 'image/jpeg' };
    });
    const ctx = buildDbMock({
      docs: mediaDocs,
      queryDocs: { kin_care_reports: [baseTale('r-12', ids)] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual(
      ids.slice(0, 8).map((id) => ({ id, url: `https://cdn/${id}.jpg`, contentType: 'image/jpeg' })),
    );
  });

  it('a tale with 3 media returns 3 thumbs', async () => {
    const ids = ['ma', 'mb', 'mc'];
    const mediaDocs: Record<string, Record<string, unknown>> = { 'clients/u1': { kinfolkIds: ['fam3'] } };
    ids.forEach((id) => {
      mediaDocs[`media_files/${id}`] = { storageUrl: `https://cdn/${id}.jpg`, mimeType: 'image/jpeg' };
    });
    const ctx = buildDbMock({
      docs: mediaDocs,
      queryDocs: { kin_care_reports: [baseTale('r-3', ids)] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toHaveLength(3);
    expect(res.tales[0]!.thumbs.map((t) => t.id)).toEqual(ids);
  });

  it('a tale with no media returns thumbs: []', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [baseTale('r-none', [])] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual([]);
  });

  it('a video (contentType not image/*) is INCLUDED, with its content type intact', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'media_files/v1': { storageUrl: 'https://cdn/v1.mp4', mimeType: 'video/mp4' },
      },
      queryDocs: { kin_care_reports: [baseTale('r-video', ['v1'])] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual([{ id: 'v1', url: 'https://cdn/v1.mp4', contentType: 'video/mp4' }]);
  });

  it('a missing media doc, or one with no storageUrl, is simply absent — never a placeholder', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'media_files/ok1': { storageUrl: 'https://cdn/ok1.jpg', mimeType: 'image/jpeg' },
        // 'media_files/missing1' intentionally absent from the fixture — simulates a deleted doc.
        'media_files/nourl1': { mimeType: 'image/jpeg' }, // exists, but no storageUrl
      },
      queryDocs: { kin_care_reports: [baseTale('r-gaps', ['ok1', 'missing1', 'nourl1'])] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual([{ id: 'ok1', url: 'https://cdn/ok1.jpg', contentType: 'image/jpeg' }]);
  });

  it('mediaIds keeps its full count even when thumbs is capped at 8', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    const mediaDocs: Record<string, Record<string, unknown>> = { 'clients/u1': { kinfolkIds: ['fam3'] } };
    ids.forEach((id) => {
      mediaDocs[`media_files/${id}`] = { storageUrl: `https://cdn/${id}.jpg`, mimeType: 'image/jpeg' };
    });
    const ctx = buildDbMock({
      docs: mediaDocs,
      queryDocs: { kin_care_reports: [baseTale('r-12b', ids)] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.mediaIds).toHaveLength(12);
    expect(res.tales[0]!.thumbs).toHaveLength(8);
  });
});

/**
 * `kin_care_reports` is a FLAT collection, so the tenant predicate, the draft
 * exclusion (`sentAt > ''`) and the `before` cursor are the whole contract of
 * this read. None of them were verifiable while the double answered every query
 * with the entire fixture (P0-10).
 */
describe('getMyKinTalesHandler query semantics', () => {
  const tale = (id: string, kinfolkId: string, sentAt: string) => ({
    id,
    data: { kinfolkId, bodyCopy: 'x', mediaFileIds: [], sharedAsIds: [], sentAt },
  });

  function ctxFor(rows: Array<{ id: string; data: Record<string, unknown> }>) {
    return buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: rows },
    });
  }

  it('TENANT: another household\'s tales never appear', async () => {
    const ctx = ctxFor([
      tale('mine-1', 'fam3', '2026-07-01T00:00:00.000Z'),
      tale('theirs-1', 'fam9', '2026-07-02T00:00:00.000Z'),
      tale('mine-2', 'fam3', '2026-07-03T00:00:00.000Z'),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales.map((t) => t.id)).toEqual(['mine-2', 'mine-1']);
  });

  it('DRAFTS: an empty sentAt, and a report with no sentAt at all, stay hidden', async () => {
    const ctx = ctxFor([
      tale('sent', 'fam3', '2026-07-03T00:00:00.000Z'),
      tale('draft-empty', 'fam3', ''),
      { id: 'draft-missing', data: { kinfolkId: 'fam3', bodyCopy: 'x', mediaFileIds: [], sharedAsIds: [] } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales.map((t) => t.id)).toEqual(['sent']);
  });

  it('CURSOR: `before` resumes strictly past the previous page', async () => {
    const rows = ['05', '04', '03', '02', '01'].map((d) =>
      tale(`t${d}`, 'fam3', `2026-07-${d}T00:00:00.000Z`),
    );
    const ctx = ctxFor(rows);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const page1 = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 2 },
      auth: { uid: 'u1' },
    } as any);
    expect(page1.tales.map((t) => t.id)).toEqual(['t05', 't04']);
    expect(page1.hasMore).toBe(true);

    const page2 = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 2, before: page1.tales[1].sentAtMs },
      auth: { uid: 'u1' },
    } as any);
    expect(page2.tales.map((t) => t.id)).toEqual(['t03', 't02']);
    expect(page2.hasMore).toBe(true);

    const page3 = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 2, before: page2.tales[1].sentAtMs },
      auth: { uid: 'u1' },
    } as any);
    expect(page3.tales.map((t) => t.id)).toEqual(['t01']);
    expect(page3.hasMore).toBe(false);
  });
});
