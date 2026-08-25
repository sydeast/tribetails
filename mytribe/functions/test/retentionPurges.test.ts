import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ISSUE #519: the two jobs that delete records permanently.
 *
 * Every case here is written in BOTH directions, because a test that only
 * proves deletion is half a test: for each rule there is a row inside the window
 * that must survive and a row outside it that must go. The survivors are the
 * point. A purge is judged by what it leaves alone.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
  writeAuditEntry: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import { runVisitRoutePurge } from '../src/scheduled/purgeOldVisitRoutes';
import { runDraftPurge, isPurgeableDraft, isUntriagedOrphan } from '../src/scheduled/purgeOldDrafts';
import { stampToMillis, firstReadableStamp } from '../src/lib/purgeTimestamps';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  mocks.writeAuditEntry.mockReset().mockResolvedValue('audit-1');
});

interface Row {
  id: string;
  data: Record<string, unknown>;
}

/**
 * A db whose one collection (or collection-group) holds `rows`, whose settings
 * doc holds `settings`, and which records every ref a batch deleted.
 */
function purgeDbMock(rows: Row[], settings: Record<string, unknown>) {
  const deletedIds: string[] = [];
  const committed: number[] = [];

  const docs = rows.map((row) => ({
    id: row.id,
    data: () => row.data,
    ref: { id: row.id },
  }));

  function query(startId: string | null, limit: number | null): Record<string, unknown> {
    let from = 0;
    if (startId) {
      const i = docs.findIndex((d) => d.id === startId);
      from = i < 0 ? docs.length : i + 1;
    }
    const slice = limit == null ? docs.slice(from) : docs.slice(from, from + limit);
    const q: Record<string, unknown> = {
      where: vi.fn(() => query(startId, limit)),
      orderBy: vi.fn(() => query(startId, limit)),
      limit: vi.fn((n: number) => query(startId, n)),
      startAfter: vi.fn((cursor: { id: string }) => query(cursor.id, limit)),
      get: vi.fn(async () => ({ docs: slice })),
    };
    return q;
  }

  const db = {
    collection: vi.fn(() => query(null, null)),
    collectionGroup: vi.fn(() => query(null, null)),
    doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => settings })) })),
    batch: vi.fn(() => {
      const staged: string[] = [];
      return {
        delete: (ref: { id: string }) => staged.push(ref.id),
        commit: async () => {
          deletedIds.push(...staged);
          committed.push(staged.length);
        },
      };
    }),
  };
  return { db, deletedIds, committed };
}

// ── stamp reading ───────────────────────────────────────────────────────────

describe('stampToMillis', () => {
  it('reads epoch milliseconds from the Android writer', () => {
    expect(stampToMillis(NOW)).toBe(NOW);
  });

  it('reads an ISO string from the desktop writer', () => {
    expect(stampToMillis('2026-08-24T12:00:00.000Z')).toBe(NOW);
  });

  it('reads a Firestore Timestamp', () => {
    expect(stampToMillis({ toMillis: () => NOW })).toBe(NOW);
  });

  it('returns null for everything it cannot read, so an undated row is skipped not purged', () => {
    expect(stampToMillis(undefined)).toBeNull();
    expect(stampToMillis(null)).toBeNull();
    expect(stampToMillis('')).toBeNull();
    expect(stampToMillis('   ')).toBeNull();
    expect(stampToMillis('not-a-date')).toBeNull();
    expect(stampToMillis(0)).toBeNull();
    expect(stampToMillis(-1)).toBeNull();
    expect(stampToMillis({})).toBeNull();
  });
});

describe('firstReadableStamp', () => {
  it('prefers the first field it can read, in the caller\'s order', () => {
    const ms = firstReadableStamp(
      { updatedAt: '2026-08-20T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' },
      ['updatedAt', 'createdAt'],
    );
    expect(ms).toBe(Date.parse('2026-08-20T00:00:00.000Z'));
  });

  it('falls through to the next field when the first is blank', () => {
    const ms = firstReadableStamp({ updatedAt: '', createdAt: '2020-01-01T00:00:00.000Z' }, ['updatedAt', 'createdAt']);
    expect(ms).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('returns null when no field is readable', () => {
    expect(firstReadableStamp({ updatedAt: '', createdAt: '' }, ['updatedAt', 'createdAt'])).toBeNull();
  });
});

// ── route purge ─────────────────────────────────────────────────────────────

describe('runVisitRoutePurge', () => {
  it('deletes pings outside the window and KEEPS pings inside it, in both stamp shapes', async () => {
    const rows: Row[] = [
      // Android shape (epoch ms).
      { id: 'old-ms', data: { timestamp: NOW - 100 * DAY, lat: 1 } },
      { id: 'fresh-ms', data: { timestamp: NOW - 10 * DAY, lat: 1 } },
      // Desktop shape (ISO string).
      { id: 'old-iso', data: { timestamp: new Date(NOW - 100 * DAY).toISOString() } },
      { id: 'fresh-iso', data: { timestamp: new Date(NOW - 10 * DAY).toISOString() } },
    ];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 90 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runVisitRoutePurge(NOW);

    expect(result).toMatchObject({ deleted: 2, scanned: 4, days: 90 });
    expect(ctx.deletedIds.sort()).toEqual(['old-iso', 'old-ms']);
    expect(ctx.deletedIds).not.toContain('fresh-ms');
    expect(ctx.deletedIds).not.toContain('fresh-iso');
  });

  it('keeps a ping exactly on the boundary', async () => {
    const rows: Row[] = [{ id: 'boundary', data: { timestamp: NOW - 90 * DAY } }];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 90 });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await runVisitRoutePurge(NOW)).deleted).toBe(0);
    expect(ctx.deletedIds).toEqual([]);
  });

  it('leaves an undated ping alone however old the rest of the collection is', async () => {
    const rows: Row[] = [
      { id: 'undated', data: { lat: 1, lng: 2 } },
      { id: 'blank', data: { timestamp: '' } },
      { id: 'garbage', data: { timestamp: 'whenever' } },
      { id: 'old', data: { timestamp: NOW - 400 * DAY } },
    ];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 90 });
    mocks.dbFn.mockReturnValue(ctx.db);

    await runVisitRoutePurge(NOW);

    expect(ctx.deletedIds).toEqual(['old']);
  });

  it('honours a SHORTER configured window, deleting what the default would have kept', async () => {
    const rows: Row[] = [{ id: 'twenty-days', data: { timestamp: NOW - 20 * DAY } }];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 7 });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await runVisitRoutePurge(NOW)).deleted).toBe(1);
  });

  it('uses the 90-day default when the key is absent, and says so in the audit', async () => {
    const rows: Row[] = [
      { id: 'day-95', data: { timestamp: NOW - 95 * DAY } },
      { id: 'day-85', data: { timestamp: NOW - 85 * DAY } },
    ];
    const ctx = purgeDbMock(rows, {});
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runVisitRoutePurge(NOW);

    expect(result.days).toBe(90);
    expect(ctx.deletedIds).toEqual(['day-95']);
    const audit = mocks.writeAuditEntry.mock.calls[0]?.[0];
    expect(audit.event).toBe('RETENTION_ROUTES_PURGED');
    expect(audit.payload).toMatchObject({ deleted: 1, retentionDays: 90, retentionSource: 'default' });
  });

  it('DELETES NOTHING and audits the refusal when the window is zero', async () => {
    const rows: Row[] = [{ id: 'ancient', data: { timestamp: NOW - 4000 * DAY } }];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 0 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runVisitRoutePurge(NOW);

    expect(result).toMatchObject({ deleted: 0, days: null });
    expect(ctx.deletedIds).toEqual([]);
    expect(ctx.db.collectionGroup).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]?.event).toBe('RETENTION_PURGE_SKIPPED');
  });

  it('DELETES NOTHING when the window is negative', async () => {
    const ctx = purgeDbMock([{ id: 'x', data: { timestamp: NOW - 4000 * DAY } }], { saveRoutesForDays: -30 });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await runVisitRoutePurge(NOW)).deleted).toBe(0);
    expect(ctx.deletedIds).toEqual([]);
  });

  it('is safe to re-run: the second pass over what survived deletes nothing more', async () => {
    const rows: Row[] = [{ id: 'fresh', data: { timestamp: NOW - 1 * DAY } }];
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 90 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runVisitRoutePurge(NOW);
    await runVisitRoutePurge(NOW);
    expect(ctx.deletedIds).toEqual([]);
  });

  it('batches its deletes rather than committing one at a time', async () => {
    const rows: Row[] = Array.from({ length: 600 }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`,
      data: { timestamp: NOW - 200 * DAY },
    }));
    const ctx = purgeDbMock(rows, { saveRoutesForDays: 90 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runVisitRoutePurge(NOW);

    expect(result.deleted).toBe(600);
    // 500 at the cap, then the final flush. Never 600 single commits.
    expect(ctx.committed).toEqual([500, 100]);
  });
});

// ── draft purge ─────────────────────────────────────────────────────────────

describe('isPurgeableDraft / isUntriagedOrphan', () => {
  it('accepts an unsent draft', () => {
    expect(isPurgeableDraft({ status: 'DRAFT', sentAt: '' })).toBe(true);
    expect(isPurgeableDraft({ status: 'draft' })).toBe(true);
  });

  it('refuses anything that was sent, by either signal', () => {
    expect(isPurgeableDraft({ status: 'SENT', sentAt: '2026-01-01T00:00:00Z' })).toBe(false);
    // The two disagree; the send wins and the row lives.
    expect(isPurgeableDraft({ status: 'DRAFT', sentAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('refuses an untriaged migration orphan, which is awaiting a human', () => {
    const orphan = { status: 'DRAFT', sentAt: '', sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '' };
    expect(isUntriagedOrphan(orphan)).toBe(true);
    expect(isPurgeableDraft(orphan)).toBe(false);
    expect(isPurgeableDraft({ ...orphan, sentVia: 'legacy_visit_logs' })).toBe(false);
  });

  it('allows a legacy row that HAS been triaged or linked', () => {
    expect(isPurgeableDraft({ status: 'DRAFT', sentVia: 'legacy_orphan', kinfolkId: 'kf1', triageStatus: '' })).toBe(true);
    expect(isPurgeableDraft({ status: 'DRAFT', sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: 'archived' })).toBe(true);
  });
});

describe('runDraftPurge', () => {
  it('deletes an old unsent draft and KEEPS a recent one', async () => {
    const rows: Row[] = [
      { id: 'old-draft', data: { status: 'DRAFT', sentAt: '', updatedAt: new Date(NOW - 60 * DAY).toISOString() } },
      { id: 'new-draft', data: { status: 'DRAFT', sentAt: '', updatedAt: new Date(NOW - 3 * DAY).toISOString() } },
    ];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runDraftPurge(NOW);

    expect(result).toMatchObject({ deleted: 1, days: 30 });
    expect(ctx.deletedIds).toEqual(['old-draft']);
  });

  it('KEEPS a sent KinTale however old it is', async () => {
    const rows: Row[] = [
      {
        id: 'sent-2019',
        data: {
          status: 'SENT',
          sentAt: '2019-01-01T00:00:00.000Z',
          updatedAt: '2019-01-01T00:00:00.000Z',
        },
      },
    ];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);

    await runDraftPurge(NOW);

    expect(ctx.deletedIds).toEqual([]);
  });

  /** The row this job is most likely to destroy by accident: blank stamp AND awaiting triage. */
  it('KEEPS an untriaged migration orphan with a blank createdAt', async () => {
    const rows: Row[] = [
      {
        id: 'legacy_79',
        data: { status: 'DRAFT', sentAt: '', sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '', createdAt: '', updatedAt: '' },
      },
      { id: 'old-draft', data: { status: 'DRAFT', updatedAt: new Date(NOW - 60 * DAY).toISOString() } },
    ];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);

    await runDraftPurge(NOW);

    expect(ctx.deletedIds).toEqual(['old-draft']);
    expect(ctx.deletedIds).not.toContain('legacy_79');
  });

  it('KEEPS an undated draft that is not an orphan either', async () => {
    const rows: Row[] = [{ id: 'undated', data: { status: 'DRAFT', sentAt: '' } }];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runDraftPurge(NOW);
    expect(ctx.deletedIds).toEqual([]);
  });

  /** An old draft edited recently is work in progress, not an abandoned one. */
  it('dates a draft by updatedAt, so a recently edited old draft survives', async () => {
    const rows: Row[] = [
      {
        id: 'started-long-ago-edited-yesterday',
        data: {
          status: 'DRAFT',
          createdAt: new Date(NOW - 400 * DAY).toISOString(),
          updatedAt: new Date(NOW - 1 * DAY).toISOString(),
        },
      },
    ];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runDraftPurge(NOW);
    expect(ctx.deletedIds).toEqual([]);
  });

  it('falls back to createdAt when updatedAt is blank', async () => {
    const rows: Row[] = [
      { id: 'never-edited', data: { status: 'DRAFT', updatedAt: '', createdAt: new Date(NOW - 90 * DAY).toISOString() } },
    ];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runDraftPurge(NOW);
    expect(ctx.deletedIds).toEqual(['never-edited']);
  });

  it('uses the 30-day default when the key is absent, and audits the source', async () => {
    const rows: Row[] = [{ id: 'day-40', data: { status: 'DRAFT', updatedAt: new Date(NOW - 40 * DAY).toISOString() } }];
    const ctx = purgeDbMock(rows, {});
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runDraftPurge(NOW);

    expect(result.days).toBe(30);
    const audit = mocks.writeAuditEntry.mock.calls[0]?.[0];
    expect(audit.event).toBe('RETENTION_DRAFTS_PURGED');
    expect(audit.payload).toMatchObject({ deleted: 1, retentionDays: 30, retentionSource: 'default' });
  });

  it('DELETES NOTHING and audits the refusal when the window is unreadable', async () => {
    const rows: Row[] = [{ id: 'ancient-draft', data: { status: 'DRAFT', updatedAt: '2019-01-01T00:00:00.000Z' } }];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 'thirty' });
    mocks.dbFn.mockReturnValue(ctx.db);

    const result = await runDraftPurge(NOW);

    expect(result).toMatchObject({ deleted: 0, days: null });
    expect(ctx.deletedIds).toEqual([]);
    expect(ctx.db.collection).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]?.event).toBe('RETENTION_PURGE_SKIPPED');
  });

  it('is safe to re-run', async () => {
    const rows: Row[] = [{ id: 'fresh', data: { status: 'DRAFT', updatedAt: new Date(NOW - 1 * DAY).toISOString() } }];
    const ctx = purgeDbMock(rows, { draftRetentionDays: 30 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runDraftPurge(NOW);
    await runDraftPurge(NOW);
    expect(ctx.deletedIds).toEqual([]);
  });
});
