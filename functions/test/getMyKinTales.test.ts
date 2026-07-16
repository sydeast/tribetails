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
