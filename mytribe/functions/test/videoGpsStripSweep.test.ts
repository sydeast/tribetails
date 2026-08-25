/**
 * #593. The retry / catch-up sweep for the asynchronous video location strip.
 *
 * What matters here is the QUERY, because that is what decides whether a
 * failure is findable and whether a historical asset gets touched:
 *   - it takes PENDING and FAILED, so a transient network failure is retried
 *     rather than leaving a video with its coordinates forever,
 *   - it stops at MAX_STRIP_ATTEMPTS, so a broken asset surfaces as a standing
 *     FAILED row instead of being re-downloaded every ten minutes forever,
 *   - and it matches on a field only the post-#593 clients write, so it is not
 *     a backfill: videos uploaded before this change are untouched, which is
 *     what the issue asked for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level statement, so the
// doubles they close over have to be created with `vi.hoisted` rather than by a
// plain `const` that has not been initialised yet when the factory runs.
const { stripVideoLocationForMedia, dbMock } = vi.hoisted(() => ({
  stripVideoLocationForMedia: vi.fn(),
  dbMock: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/wrapScheduled', () => ({ wrapScheduled: (_n: string, h: unknown) => h }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => dbMock() }));
vi.mock('../src/lib/stripVideoLocationJob', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/stripVideoLocationJob')>();
  return { ...actual, stripVideoLocationForMedia };
});
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => `secret-${name}` }),
}));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_o: unknown, h: unknown) => h }));

import { videoGpsStripSweepHandler } from '../src/scheduled/videoGpsStripSweep';
import { GPS_STRIP_STATUS, MAX_STRIP_ATTEMPTS } from '../src/lib/stripVideoLocationJob';

interface RecordedQuery {
  field: string;
  op: string;
  value: unknown;
}

function fakeFirestore(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const wheres: RecordedQuery[] = [];
  let limit = 0;
  const query = {
    where(field: string, op: string, value: unknown) {
      wheres.push({ field, op, value });
      return query;
    },
    limit(n: number) {
      limit = n;
      return query;
    },
    async get() {
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
      };
    },
  };
  return {
    wheres,
    getLimit: () => limit,
    db: { collection: (name: string) => ((query as unknown as { name?: string }).name = name, query) },
  };
}

describe('videoGpsStripSweepHandler', () => {
  beforeEach(() => {
    stripVideoLocationForMedia.mockReset();
    stripVideoLocationForMedia.mockResolvedValue({ kind: 'stripped', publicId: 'p', secureUrl: 'u', neutralised: [] });
  });

  it('asks only for videos that are pending or failed AND still under the attempt cap', async () => {
    const fake = fakeFirestore([]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    expect(fake.wheres).toEqual([
      { field: 'gpsStripStatus', op: 'in', value: [GPS_STRIP_STATUS.pending, GPS_STRIP_STATUS.failed] },
      { field: 'gpsStripAttempts', op: '<', value: MAX_STRIP_ATTEMPTS },
    ]);
  });

  it('is NOT a backfill: the query cannot match a video that predates #593', async () => {
    // A pre-#593 row has no gpsStripStatus field at all, and Firestore's `in`
    // never matches a missing field. Stated as a test because "historical
    // videos are out of scope" is a promise the query has to keep, not a
    // comment.
    const fake = fakeFirestore([]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    const statusClause = fake.wheres.find((w) => w.field === 'gpsStripStatus');
    expect(statusClause?.op).toBe('in');
    expect(statusClause?.value).not.toContain('');
  });

  it('bounds the batch: each row is a multi-megabyte download plus an upload', async () => {
    const fake = fakeFirestore([]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    expect(fake.getLimit()).toBeGreaterThan(0);
    expect(fake.getLimit()).toBeLessThanOrEqual(10);
  });

  it('runs the same job the trigger runs, once per matched doc', async () => {
    const fake = fakeFirestore([
      { id: 'a', data: { fileType: 'VIDEO' } },
      { id: 'b', data: { fileType: 'VIDEO' } },
    ]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    expect(stripVideoLocationForMedia).toHaveBeenCalledTimes(2);
    expect(stripVideoLocationForMedia.mock.calls[0][0]).toBe('a');
    expect(stripVideoLocationForMedia.mock.calls[1][0]).toBe('b');
  });

  it('keeps going after one document fails, rather than abandoning the batch', async () => {
    stripVideoLocationForMedia
      .mockResolvedValueOnce({ kind: 'failed', publicId: 'p', error: 'boom', attempts: 1 })
      .mockResolvedValueOnce({ kind: 'stripped', publicId: 'q', secureUrl: 'u', neutralised: [] });
    const fake = fakeFirestore([
      { id: 'a', data: { fileType: 'VIDEO' } },
      { id: 'b', data: { fileType: 'VIDEO' } },
    ]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    expect(stripVideoLocationForMedia).toHaveBeenCalledTimes(2);
  });

  it('does no work at all when nothing is queued', async () => {
    const fake = fakeFirestore([]);
    dbMock.mockReturnValue(fake.db);
    await videoGpsStripSweepHandler();
    expect(stripVideoLocationForMedia).not.toHaveBeenCalled();
  });
});
