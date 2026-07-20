import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  saveAudienceSegmentHandler,
  listAudienceSegmentsHandler,
  deleteAudienceSegmentHandler,
} from '../src/admin/audienceSegments';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as any) : undefined,
  } as unknown as CallableRequest<unknown>;
}

describe('saveAudienceSegment', () => {
  it('creates a new segment, writes the doc, audits SAVED', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveAudienceSegmentHandler(
      req({ name: 'VIPs', criteria: { kind: 'tags', tags: ['vip'], tagMatch: 'any' } }),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBeTruthy();
    const write = ctx.writes.find((w) => w.path.startsWith('audience_segments/'));
    expect(write?.data.name).toBe('VIPs');
    expect(write?.data.description).toContain('vip');
    expect(write?.data.createdAtMs).toBeTypeOf('number');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'AUDIENCE_SEGMENT_SAVED', actorUid: 'admin1' }),
    );
  });

  it('updates an existing segment without re-stamping createdAt', async () => {
    const ctx = buildDbMock({ docs: { 'audience_segments/seg1': { name: 'Old', createdAtMs: 111 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveAudienceSegmentHandler(
      req({ id: 'seg1', name: 'New', criteria: { kind: 'all' } }),
    );
    const write = ctx.writes.find((w) => w.path === 'audience_segments/seg1');
    expect(write?.data.name).toBe('New');
    expect(write?.data.createdAtMs).toBeUndefined(); // not re-stamped on update
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveAudienceSegmentHandler(req({ name: 'x', criteria: { kind: 'all' } }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an empty-name segment (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveAudienceSegmentHandler(req({ name: '', criteria: { kind: 'all' } })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a tag segment with no tags (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveAudienceSegmentHandler(req({ name: 'bad', criteria: { kind: 'tags', tags: [] } })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('listAudienceSegments', () => {
  it('returns segments newest-updated first', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        audience_segments: [
          { id: 'a', data: { name: 'A', criteria: { kind: 'all' }, description: 'd', createdAtMs: 1, updatedAtMs: 10 } },
          { id: 'b', data: { name: 'B', criteria: { kind: 'all' }, description: 'd', createdAtMs: 2, updatedAtMs: 20 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listAudienceSegmentsHandler(req({}));
    expect(res.segments.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(listAudienceSegmentsHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('deleteAudienceSegment', () => {
  it('deletes an existing segment and audits DELETED', async () => {
    const ctx = buildDbMock({ docs: { 'audience_segments/seg1': { name: 'Gone' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteAudienceSegmentHandler(req({ id: 'seg1' }));
    expect(res).toEqual({ ok: true, id: 'seg1' });
    expect(ctx.deletes).toContain('audience_segments/seg1');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'AUDIENCE_SEGMENT_DELETED' }),
    );
  });

  it('throws not-found for a missing segment', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(deleteAudienceSegmentHandler(req({ id: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});
