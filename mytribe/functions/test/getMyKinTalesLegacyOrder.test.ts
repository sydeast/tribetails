import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());
import { parseLegacySentAt, parseSentAtMs } from '../src/lib/sentKinTales';
const row = (id: string, sentAt: string, kinfolkId = 'fam3') => ({
  id,
  data: { kinfolkId, bodyCopy: id, mediaFileIds: [], sharedAsIds: [], sentAt },
});
async function run(rows: ReturnType<typeof row>[], data: Record<string, unknown> = {}) {
  const ctx = buildDbMock({
    docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
    queryDocs: { kin_care_reports: rows },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
  return getMyKinTalesHandler({ data: { kinfolkId: 'fam3', ...data }, auth: { uid: 'u1' } } as any);
}
/** Pages through with the same cursor the clients send: the last tale's sentAtMs. */
async function walk(rows: ReturnType<typeof row>[], limit: number) {
  const seen: string[] = [];
  let before: number | undefined;
  for (let i = 0; i < 20; i += 1) {
    const res = await run(rows, { limit, ...(before !== undefined ? { before } : {}) });
    seen.push(...res.tales.map((t: any) => t.id));
    if (!res.hasMore) return seen;
    before = res.tales[res.tales.length - 1].sentAtMs ?? undefined;
    expect(before).toBeDefined();
  }
  throw new Error('paging did not terminate');
}
describe('parseLegacySentAt (America/Chicago)', () => {
  it('reads the migration text as Chicago wall time, CDT in September', () => {
    // 2:02pm CDT (UTC-5) = 19:02 UTC
    expect(parseLegacySentAt('September 3, 2025 2:02pm')).toBe(Date.UTC(2025, 8, 3, 19, 2));
  });
  it('uses CST in winter', () => {
    // 9:30am CST (UTC-6) = 15:30 UTC
    expect(parseLegacySentAt('January 15, 2026 9:30am')).toBe(Date.UTC(2026, 0, 15, 15, 30));
  });
  it('12am is midnight and 12pm is noon', () => {
    expect(parseLegacySentAt('September 3, 2025 12:00am')).toBe(Date.UTC(2025, 8, 3, 5, 0));
    expect(parseLegacySentAt('September 3, 2025 12:00pm')).toBe(Date.UTC(2025, 8, 3, 17, 0));
  });
  it('accepts a spaced meridiem, a short month and a bare hour', () => {
    expect(parseLegacySentAt('Sep 3, 2025 2:02 PM')).toBe(Date.UTC(2025, 8, 3, 19, 2));
    expect(parseLegacySentAt('September 3, 2025 2pm')).toBe(Date.UTC(2025, 8, 3, 19, 0));
  });
  it('is stable across the spring-forward gap day', () => {
    // 2026-03-08: 3:30am CDT (UTC-5) = 08:30 UTC; 1:30am CST (UTC-6) = 07:30 UTC
    expect(parseLegacySentAt('March 8, 2026 3:30am')).toBe(Date.UTC(2026, 2, 8, 8, 30));
    expect(parseLegacySentAt('March 8, 2026 1:30am')).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });
  it('refuses impossible and unreadable text', () => {
    for (const bad of ['February 30, 2026 1:00pm', 'September 3, 2025 13:00pm', 'last Tuesday-ish', '6pm', '', 'Smarch 3, 2025 1pm']) {
      expect(parseLegacySentAt(bad)).toBeNull();
    }
    expect(parseLegacySentAt(undefined)).toBeNull();
  });
  it('parseSentAtMs reads ISO and legacy, and nothing else', () => {
    expect(parseSentAtMs('2026-07-01T00:00:00.000Z')).toBe(Date.UTC(2026, 6, 1));
    expect(parseSentAtMs('2026-13-30T00:00:00.000Z')).toBeNull();
    expect(parseSentAtMs('September 3, 2025 2:02pm')).toBe(Date.UTC(2025, 8, 3, 19, 2));
    expect(parseSentAtMs('whenever')).toBeNull();
  });
});
describe('getMyKinTales order across ISO and migrated free text (#1775)', () => {
  it('ISO only: newest first', async () => {
    const res = await run([row('a', '2026-07-01T00:00:00.000Z'), row('b', '2026-07-03T00:00:00.000Z'), row('c', '2026-07-02T00:00:00.000Z')]);
    expect(res.tales.map((t: any) => t.id)).toEqual(['b', 'c', 'a']);
    expect(res.hasMore).toBe(false);
  });
  it('legacy only: by parsed date, not by month name', async () => {
    const res = await run([
      row('sep', 'September 3, 2025 2:02pm'),
      row('jan', 'January 9, 2026 10:00am'),
      row('aug', 'August 30, 2025 9:00am'),
    ]);
    expect(res.tales.map((t: any) => t.id)).toEqual(['jan', 'sep', 'aug']);
    expect(res.tales[0].sentAtMs).toBe(Date.UTC(2026, 0, 9, 16, 0));
    expect(res.tales[0].sentAtText).toBeUndefined();
  });
  it('mixed: a new tale heads the list above every migrated one, and a migrated one lands between ISO ones', async () => {
    const res = await run([
      row('new', '2026-10-01T15:00:00.000Z'),
      row('old-iso', '2025-01-01T00:00:00.000Z'),
      row('legacy-sep', 'September 3, 2025 2:02pm'),
      row('legacy-dec', 'December 25, 2024 8:00am'),
    ]);
    expect(res.tales.map((t: any) => t.id)).toEqual(['new', 'legacy-sep', 'old-iso', 'legacy-dec']);
  });
  it('unreadable text sorts last, keeps its stored text, and has no sentAtMs', async () => {
    const res = await run([
      row('junk', 'sometime in the spring'),
      row('iso', '2026-07-01T00:00:00.000Z'),
      row('legacy', 'September 3, 2025 2:02pm'),
    ]);
    expect(res.tales.map((t: any) => t.id)).toEqual(['iso', 'legacy', 'junk']);
    expect(res.tales[2].sentAtMs).toBeNull();
    expect(res.tales[2].sentAtText).toBe('sometime in the spring');
    expect(res.tales[0].sentAtText).toBeUndefined();
  });
  it('PAGING: a page boundary across the two sources neither skips nor repeats', async () => {
    const rows = [
      row('i1', '2026-10-05T00:00:00.000Z'),
      row('l1', 'October 1, 2026 9:00am'),
      row('i2', '2026-09-20T00:00:00.000Z'),
      row('l2', 'September 3, 2026 2:02pm'),
      row('i3', '2026-08-01T00:00:00.000Z'),
      row('l3', 'July 4, 2026 1:00pm'),
      row('i4', '2026-06-01T00:00:00.000Z'),
      row('l4', 'January 2, 2026 1:00pm'),
      row('junk', 'n/a'),
    ];
    const expected = ['i1', 'l1', 'i2', 'l2', 'i3', 'l3', 'i4', 'l4', 'junk'];
    for (const limit of [1, 2, 3, 4, 5, 8, 9, 50]) {
      expect(await walk(rows, limit)).toEqual(expected);
    }
  });
  it('PAGING: migrated rows are not held above the first page of new tales', async () => {
    const rows = [
      row('n1', '2026-10-03T00:00:00.000Z'),
      row('n2', '2026-10-02T00:00:00.000Z'),
      row('n3', '2026-10-01T00:00:00.000Z'),
      row('l1', 'December 1, 2025 9:00am'),
    ];
    const page1 = await run(rows, { limit: 2 });
    expect(page1.tales.map((t: any) => t.id)).toEqual(['n1', 'n2']);
    expect(page1.hasMore).toBe(true);
    const page2 = await run(rows, { limit: 2, before: page1.tales[1].sentAtMs });
    expect(page2.tales.map((t: any) => t.id)).toEqual(['n3', 'l1']);
    expect(page2.hasMore).toBe(false);
  });
  it('PAGING: a tie at the page boundary is taken whole, so the strict cursor strands nothing', async () => {
    const rows = [
      row('a', '2026-10-03T00:00:00.000Z'),
      row('tie-1', 'October 1, 2026 9:00am'),
      row('tie-2', '2026-10-01T14:00:00.000Z'),
      row('z', '2026-09-01T00:00:00.000Z'),
    ];
    // October 1 9:00am CDT = 14:00 UTC, the same instant as tie-2
    const page1 = await run(rows, { limit: 2 });
    expect(page1.tales.map((t: any) => t.id).sort()).toEqual(['a', 'tie-1', 'tie-2']);
    expect(await walk(rows, 2)).toHaveLength(4);
  });
  it('PAGING: unreadable rows all arrive on the page that exhausts the dated ones, never split', async () => {
    const rows = [
      row('d1', '2026-10-03T00:00:00.000Z'),
      row('j1', 'tbd'),
      row('j2', 'unknown'),
      row('j3', 'later'),
    ];
    const res = await run(rows, { limit: 2 });
    expect(res.tales.map((t: any) => t.id).sort()).toEqual(['d1', 'j1', 'j2', 'j3']);
    expect(res.hasMore).toBe(false);
  });
  it('cursor accepts the previous page when the last tale is a migrated row', async () => {
    const rows = [
      row('l1', 'September 3, 2025 2:02pm'),
      row('l2', 'September 2, 2025 2:02pm'),
      row('l3', 'September 1, 2025 2:02pm'),
    ];
    const p1 = await run(rows, { limit: 2 });
    expect(p1.tales.map((t: any) => t.id)).toEqual(['l1', 'l2']);
    const p2 = await run(rows, { limit: 2, before: p1.tales[1].sentAtMs });
    expect(p2.tales.map((t: any) => t.id)).toEqual(['l3']);
  });
  it('TENANT: another household migrated rows never appear; drafts stay hidden', async () => {
    const res = await run([
      row('mine', 'September 3, 2025 2:02pm'),
      row('theirs', 'September 4, 2025 2:02pm', 'fam9'),
      row('draft', ''),
    ]);
    expect(res.tales.map((t: any) => t.id)).toEqual(['mine']);
  });
  it('rejects a cursor that is not a real timestamp', async () => {
    await expect(run([row('a', '2026-07-01T00:00:00.000Z')], { before: 1e20 })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
