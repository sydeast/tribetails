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
 * Task-24a: `getMyKinTales` now reads `thumbs` straight off the
 * `kin_care_reports` doc it already loaded — the triggers keep it in sync —
 * instead of resolving up to 8 `media_files` docs per tale on every read
 * (worst case 181 reads for a default 20-tale page). A tale written before
 * this shipped has no `thumbs` field yet: exactly ONE tale, per-tale, still
 * falls back to the old per-read resolution so it isn't silently
 * photo-less; a tale that already carries `thumbs` (including a stored
 * empty array, which means "resolved, nothing renderable") never touches
 * `media_files` at all. That skip is the entire point of this task.
 */
describe('getMyKinTalesHandler thumbs — task-24a read-cost fix', () => {
  const taleWith = (id: string, extra: Record<string, unknown>) => ({
    id,
    data: { kinfolkId: 'fam3', bodyCopy: 'x', sentAt: SENT_AT_ISO, sharedAsIds: [], mediaFileIds: [], ...extra },
  });

  it('a stored thumbs field is served as-is, with ZERO media_files reads', async () => {
    const storedThumbs = [{ id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' }];
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [taleWith('r-stamped', { mediaFileIds: ['m1'], thumbs: storedThumbs })],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual(storedThumbs);
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('a stored thumbs: [] (resolved, nothing renderable) is served as [] with ZERO media_files reads', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        // Present in the fixture to prove it's never read.
        'media_files/dead1': { storageUrl: 'https://cdn/dead1.jpg', mimeType: 'image/jpeg' },
      },
      queryDocs: {
        kin_care_reports: [taleWith('r-empty-resolved', { mediaFileIds: ['dead1'], thumbs: [] })],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual([]);
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('a tale with no thumbs field (pre-task-24a data) falls back to resolving media the old way', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'media_files/legacy1': { storageUrl: 'https://cdn/legacy1.jpg', mimeType: 'image/jpeg' },
      },
      queryDocs: {
        kin_care_reports: [taleWith('r-legacy', { mediaFileIds: ['legacy1'] })],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.thumbs).toEqual([
      { id: 'legacy1', url: 'https://cdn/legacy1.jpg', contentType: 'image/jpeg' },
    ]);
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
  });

  it('a mixed page only resolves media for the legacy tale, in one batched read', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'media_files/legacy1': { storageUrl: 'https://cdn/legacy1.jpg', mimeType: 'image/jpeg' },
      },
      queryDocs: {
        kin_care_reports: [
          taleWith('r-new', {
            mediaFileIds: ['new1'],
            thumbs: [{ id: 'new1', url: 'https://cdn/new1.jpg', contentType: 'image/jpeg' }],
          }),
          taleWith('r-legacy', { mediaFileIds: ['legacy1'] }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3', limit: 50 }, auth: { uid: 'u1' } } as any);

    const byId = Object.fromEntries(res.tales.map((t) => [t.id, t.thumbs]));
    expect(byId['r-new']).toEqual([{ id: 'new1', url: 'https://cdn/new1.jpg', contentType: 'image/jpeg' }]);
    expect(byId['r-legacy']).toEqual([{ id: 'legacy1', url: 'https://cdn/legacy1.jpg', contentType: 'image/jpeg' }]);
    // One batched getAll for the whole page's fallback candidates, not one per tale.
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
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

/**
 * task-25 (P4): visit facts. Arrival/departure live on the `kin_care_sessions`
 * row the report's `sessionId` points at, NOT on the report's own (possibly
 * stale, possibly absent) copy — see task-25-report.md Step 0. A missing time
 * is absent, never zero and never "now" (fail-loud rule).
 */
describe('getMyKinTalesHandler visit times', () => {
  const taleWithSession = (id: string, sessionId: string | undefined) => ({
    id,
    data: {
      kinfolkId: 'fam3',
      bodyCopy: 'x',
      mediaFileIds: [],
      sentAt: SENT_AT_ISO,
      sharedAsIds: [],
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  });

  it('resolves arrivedAtIso/departedAtIso from the session, not the report', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/sess-1': {
          arrivedAt: '2026-08-06T14:02:00.000Z',
          departedAt: '2026-08-06T14:41:00.000Z',
        },
      },
      queryDocs: { kin_care_reports: [taleWithSession('r1', 'sess-1')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.arrivedAtIso).toBe('2026-08-06T14:02:00.000Z');
    expect(res.tales[0]!.departedAtIso).toBe('2026-08-06T14:41:00.000Z');
  });

  it('a visit with no recorded departure shows departedAtIso: null, never a fabricated time', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/sess-2': { arrivedAt: '2026-08-06T09:00:00.000Z' },
      },
      queryDocs: { kin_care_reports: [taleWithSession('r2', 'sess-2')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.arrivedAtIso).toBe('2026-08-06T09:00:00.000Z');
    expect(res.tales[0]!.departedAtIso).toBeNull();
  });

  it('a garbage stored time (e.g. "6pm", a known legacy value) degrades to absent, not a parsed-wrong instant', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/sess-3': { arrivedAt: '2026-08-06T09:00:00.000Z', departedAt: '6pm' },
      },
      queryDocs: { kin_care_reports: [taleWithSession('r3', 'sess-3')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.departedAtIso).toBeNull();
  });

  it('no sessionId on the report: both times absent, and no session lookup is made', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [taleWithSession('r4', undefined)] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.arrivedAtIso).toBeNull();
    expect(res.tales[0]!.departedAtIso).toBeNull();
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('sessionId points at a session doc that no longer exists: both times absent, not a throw', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [taleWithSession('r5', 'sess-gone')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.arrivedAtIso).toBeNull();
    expect(res.tales[0]!.departedAtIso).toBeNull();
  });

  it('two tales sharing one session batch into a single getAll, not one lookup per tale', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/sess-shared': { arrivedAt: '2026-08-06T09:00:00.000Z' },
      },
      queryDocs: {
        kin_care_reports: [taleWithSession('r6', 'sess-shared'), taleWithSession('r7', 'sess-shared')],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3', limit: 50 }, auth: { uid: 'u1' } } as any);

    expect(res.tales.every((t) => t.arrivedAtIso === '2026-08-06T09:00:00.000Z')).toBe(true);
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
  });
});

/**
 * task-25 (P4): the task checklist. The live operator Android app
 * (`auntieos-admin/android`, `KinTaleReportScreen.kt` + `setChecklistResponse`)
 * writes checked items onto `kin_care_reports.fieldResponses`, keyed
 * "kinId|fieldKey", `{ fieldKey, kinId, boolValue }`. Only `boolValue === true`
 * responses render — see task-25-report.md for why an explicit `false` is NOT
 * rendered as "not done" (it's indistinguishable from never-tapped in the
 * capture UI, so it is not a real claim). Labels/order/scope are resolved from
 * the report's `templateId` (or the built-in default template when blank),
 * never invented client-side.
 */
describe('getMyKinTalesHandler checklist', () => {
  const taleWithResponses = (
    id: string,
    fieldResponses: Record<string, unknown> | undefined,
    templateId?: string,
  ) => ({
    id,
    data: {
      kinfolkId: 'fam3',
      bodyCopy: 'x',
      mediaFileIds: [],
      sentAt: SENT_AT_ISO,
      sharedAsIds: [],
      ...(fieldResponses !== undefined ? { fieldResponses } : {}),
      ...(templateId !== undefined ? { templateId } : {}),
    },
  });

  it('a checked item against the built-in default template (blank templateId) resolves its label, in template order', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses('r1', {
            '|fed': { fieldKey: 'fed', kinId: '', boolValue: true },
            '|peed': { fieldKey: 'peed', kinId: '', boolValue: true },
          }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    // 'peed' (order 0) sorts before 'fed' (order 2), regardless of map iteration order.
    expect(res.tales[0]!.checklist).toEqual([
      { key: 'peed', text: 'Peed' },
      { key: 'fed', text: 'Fed' },
    ]);
  });

  it('an item explicitly toggled false is NOT rendered as "not done" — omitted, not a false claim', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses('r2', {
            '|fed': { fieldKey: 'fed', kinId: '', boolValue: true },
            '|pooed': { fieldKey: 'pooed', kinId: '', boolValue: false },
          }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed' }]);
  });

  it('no fieldResponses at all: checklist is omitted (undefined), never an empty array standing in for "all done"', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [taleWithResponses('r3', undefined)] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toBeUndefined();
  });

  it('every response false, or none matching a known item: checklist is omitted, not []', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses('r4', {
            '|pooed': { fieldKey: 'pooed', kinId: '', boolValue: false },
            '|not_a_real_item': { fieldKey: 'not_a_real_item', kinId: '', boolValue: true },
          }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toBeUndefined();
  });

  it('a non-blank templateId resolves labels from that kintale_templates doc, not the built-in default', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kintale_templates/tmpl-1': {
          checklistItems: [
            { key: 'custom_key', text: 'Custom task from a real template', scope: 'PER_VISIT', order: 0 },
          ],
        },
      },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses(
            'r5',
            { '|custom_key': { fieldKey: 'custom_key', kinId: '', boolValue: true } },
            'tmpl-1',
          ),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'custom_key', text: 'Custom task from a real template' }]);
  });

  it('a checked key that only exists in the DEFAULT template does not leak in when a real template is set', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kintale_templates/tmpl-2': {
          checklistItems: [{ key: 'only_here', text: 'Only in tmpl-2', scope: 'PER_VISIT', order: 0 }],
        },
      },
      queryDocs: {
        kin_care_reports: [
          // 'fed' is a default-template key, but this report uses tmpl-2, which doesn't have it.
          taleWithResponses('r6', { '|fed': { fieldKey: 'fed', kinId: '', boolValue: true } }, 'tmpl-2'),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toBeUndefined();
  });

  it('duplicate checked keys (e.g. one per kin) collapse to one entry in the flat list', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses('r7', {
            'kinA|fed': { fieldKey: 'fed', kinId: 'kinA', boolValue: true },
            'kinB|fed': { fieldKey: 'fed', kinId: 'kinB', boolValue: true },
          }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed' }]);
  });

  it('a malformed fieldResponses value (not an object) is skipped, not a crash', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          taleWithResponses('r8', {
            '|fed': { fieldKey: 'fed', kinId: '', boolValue: true },
            '|bogus': 'not-an-object',
          }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');

    const res = await getMyKinTalesHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed' }]);
  });
});
