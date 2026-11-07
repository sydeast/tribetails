import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { listVisitInternalNotesHandler } from '../src/admin/listVisitInternalNotes';
import { auntieMayCall } from '../src/lib/auntieAccess';

const VISIT = 'families/f1/bookings/batch1/kinCares/v1';
const SESSION = 'kin_care_sessions/vis_v1';

function call(data: unknown, token: Record<string, unknown>): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: String(token['uid'] ?? 'u'), token: token as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}
const OWNER = { uid: 'owner1', admin: true };
const AUNTIE = { uid: 'auntie1', staffRole: 'auntie' };

function seed() {
  const ctx = buildDbMock({
    docs: {
      [VISIT]: { startTime: new Date(), sessionId: 'vis_v1' },
      [SESSION]: {
        kinfolkId: 'f1',
        kinCareBatchId: 'batch1',
        kinCareVisitId: 'v1',
        notes: '[2026-11-05T15:00:00Z] (office) Key under the blue pot',
      },
      'staff/owner1': { displayName: 'Syd' },
      'staff/auntie1': { displayName: 'Dee' },
    },
    queryDocs: {
      [`${VISIT}/internalNotes`]: [
        { id: 'n2', data: { body: 'Fed at 5', authorUid: 'auntie1', authorRole: 'auntie', createdAt: Timestamp.fromMillis(2_000) } },
        { id: 'n1', data: { body: 'Bring the long leash', authorUid: 'owner1', authorRole: 'admin', createdAt: Timestamp.fromMillis(1_000) } },
      ],
      [`${VISIT}/adminNotes`]: [
        { id: 'a1', data: { body: 'Raise the rate in January', authorUid: 'owner1', authorRole: 'admin', visibility: 'adminOnly', createdAt: Timestamp.fromMillis(1_500) } },
      ],
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

describe('listVisitInternalNotes (#1580)', () => {
  it('gives the owner one list: the session text first, then both kinds in time order', async () => {
    seed();
    const res = await listVisitInternalNotesHandler(call({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1' }, OWNER));
    expect(res.canMarkAdminOnly).toBe(true);
    expect(res.hasBookingRecord).toBe(true);
    expect(res.notes.map((n) => [n.id, n.visibility, n.source])).toEqual([
      ['session:vis_v1', 'shared', 'visitRecord'],
      ['n1', 'shared', 'thread'],
      ['a1', 'adminOnly', 'thread'],
      ['n2', 'shared', 'thread'],
    ]);
    expect(res.notes[1]).toMatchObject({ authorName: 'Syd', authorRole: 'admin', createdAtMs: 1_000 });
    expect(res.notes[3]).toMatchObject({ authorName: 'Dee', authorRole: 'auntie' });
  });

  it('never hands an Auntie an admin-only note, and does not offer her the mark', async () => {
    seed();
    const res = await listVisitInternalNotesHandler(call({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1' }, AUNTIE));
    expect(res.canMarkAdminOnly).toBe(false);
    expect(res.notes.map((n) => n.id)).toEqual(['session:vis_v1', 'n1', 'n2']);
    expect(JSON.stringify(res)).not.toContain('Raise the rate');
  });

  it('reads the same list from the session side (Auntie Time) as from Bookings', async () => {
    seed();
    const bySession = await listVisitInternalNotesHandler(call({ sessionId: 'vis_v1' }, OWNER));
    seed();
    const byVisit = await listVisitInternalNotesHandler(call({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1' }, OWNER));
    expect(bySession.notes).toEqual(byVisit.notes);
  });

  it('an older visit with no booking record lists its session text alone', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s9': { kinfolkId: 'f1', notes: 'Old office note' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listVisitInternalNotesHandler(call({ sessionId: 's9' }, OWNER));
    expect(res.hasBookingRecord).toBe(false);
    expect(res.notes).toEqual([
      expect.objectContaining({ id: 'session:s9', body: 'Old office note', visibility: 'shared', source: 'visitRecord' }),
    ]);
  });

  it('a visit with no notes anywhere is an empty list', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { startTime: new Date() } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listVisitInternalNotesHandler(call({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1' }, OWNER));
    expect(res.notes).toEqual([]);
  });

  it('a missing visit is not-found', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(listVisitInternalNotesHandler(call({ sessionId: 'nope' }, OWNER))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('is on the Auntie allowlist, so the filter above is what keeps her from the admin-only kind', () => {
    expect(auntieMayCall('listVisitInternalNotes')).toBe(true);
  });
});
