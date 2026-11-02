import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// #1408: a household asks the office to remove a Kin WITH history; the office
// archives it (both copies, nothing deleted) or declines. The portal half is
// `requestKinRemovalHandler` beside `deleteKinHandler` (#1314) in
// portal/kinWrites.ts; the office half is admin/kinRemovalRequests.ts.

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveUid: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.audit }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveUid.mockReset().mockResolvedValue('household-uid');
  mocks.audit.mockReset().mockResolvedValue('a1');
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const FAMILY_KIN = { name: 'Buddy', status: 'active', legacyKinId: 'flat1', familyKinPath: 'families/3/kin/k1' };
const FLAT_KIN = { name: 'Buddy', kinfolkId: '3', familyKinPath: 'families/3/kin/k1', legacyKinId: 'flat1', status: 'active' };
const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true },
};
const REQUEST_ID = '3_k1';
const REQUEST_PATH = `kin_removal_requests/${REQUEST_ID}`;
const ts = (ms: number) => ({ toMillis: () => ms });

/** A household whose Kin has a visit session on file (history), writes visible to later reads. */
function householdWithHistory(docs: Record<string, Record<string, unknown> | null> = {}) {
  return buildDbMock({
    writeThrough: true,
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3/kin/k1': FAMILY_KIN,
      'kin/flat1': FLAT_KIN,
      ...docs,
    },
    queryDocs: { kin_care_sessions: [{ id: 's1', data: { kinfolkId: '3', kinIds: ['flat1'] } }] },
  });
}

function request(data: Record<string, unknown>, uid = 'u1') {
  return { data, auth: { uid } } as any;
}

describe('requestKinRemovalHandler (#1408)', () => {
  it('rejects unauth', async () => {
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler({ data: { kinId: 'k1' }, auth: undefined } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('DENIES a kintales_only secondary (kin_edit gate) and records nothing', async () => {
    const ctx = householdWithHistory({ 'families/3/members/u1': KINTALES_ONLY_MEMBER });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes.find((w) => w.path === REQUEST_PATH)).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('DENIES a stranger', async () => {
    const ctx = householdWithHistory({ 'clients/stranger': { kinfolkIds: ['other'] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }, 'stranger'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('records a pending request with who asked, when and why, and tells the office', async () => {
    const ctx = householdWithHistory();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    const res = await requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1', reason: '  Rehomed with family  ' }));

    const write = ctx.writes.find((w) => w.path === REQUEST_PATH);
    expect(write?.data).toMatchObject({
      kinfolkId: '3',
      kinId: 'k1',
      flatKinId: 'flat1',
      kinName: 'Buddy',
      reason: 'Rehomed with family',
      status: 'pending',
      blockedBy: ['visits'],
      requestedByUid: 'u1',
      requestedAt: '__SERVER_TS__',
      resolvedByUid: null,
      resolutionNote: null,
    });
    expect(res.ok).toBe(true);
    expect(res.removalRequest).toMatchObject({ id: REQUEST_ID, status: 'pending', reason: 'Rehomed with family', kinName: 'Buddy' });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      key: 'kin.removal.requested',
      data: { kinfolkId: '3', kinId: 'k1', flatKinId: 'flat1', kinName: 'Buddy', reason: 'Rehomed with family', requestId: REQUEST_ID },
      actorUid: 'u1',
      targetType: 'kinfolk',
      targetId: '3',
    });
    // The Kin itself is untouched until the office acts.
    expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')).toBeUndefined();
  });

  it('a blank reason is stored as none', async () => {
    const ctx = householdWithHistory();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1', reason: '   ' }));
    expect(ctx.writes.find((w) => w.path === REQUEST_PATH)?.data).toMatchObject({ reason: null });
  });

  it('refuses a second request while one is pending, and writes nothing', async () => {
    const ctx = householdWithHistory({ [REQUEST_PATH]: { kinfolkId: '3', kinId: 'k1', status: 'pending' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }))).rejects.toMatchObject({
      code: 'already-exists',
      message: 'Removal of Buddy has already been requested.',
    });
    expect(ctx.writes.find((w) => w.path === REQUEST_PATH)).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('after a decline, a new request replaces the declined one', async () => {
    const ctx = householdWithHistory({
      [REQUEST_PATH]: { kinfolkId: '3', kinId: 'k1', status: 'declined', resolutionNote: 'Buddy has a visit next week.' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    const res = await requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }));
    expect(res.removalRequest).toMatchObject({ status: 'pending', resolutionNote: null });
  });

  it('a Kin with NOTHING on file is refused and pointed at the delete row (the two paths never overlap)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/kin/k1': FAMILY_KIN, 'kin/flat1': FLAT_KIN },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Buddy has nothing on file, so you can delete this profile from here instead.',
    });
    expect(ctx.writes).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('not-found when the Kin is gone', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a Kin the office already archived', async () => {
    const ctx = householdWithHistory({ 'families/3/kin/k1': { ...FAMILY_KIN, status: 'archived' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Buddy is already archived.',
    });
  });

  it('a failed notice does not undo the request', async () => {
    mocks.enqueue.mockRejectedValue(new Error('queue down'));
    const ctx = householdWithHistory();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    const res = await requestKinRemovalHandler(request({ kinfolkId: '3', kinId: 'k1' }));
    expect(res.removalRequest.status).toBe('pending');
  });
});

describe('deleteKinHandler read mode reports the removal request (#1408)', () => {
  it('returns the pending request beside canDelete false', async () => {
    const ctx = householdWithHistory({
      [REQUEST_PATH]: { kinfolkId: '3', kinId: 'k1', flatKinId: 'flat1', kinName: 'Buddy', status: 'pending', reason: 'Moved', requestedAt: ts(1_700_000_000_000) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler(request({ kinfolkId: '3', kinId: 'k1' }));
    expect(res.canDelete).toBe(false);
    expect(res.removalRequest).toEqual({
      id: REQUEST_ID,
      kinfolkId: '3',
      kinId: 'k1',
      flatKinId: 'flat1',
      kinName: 'Buddy',
      reason: 'Moved',
      status: 'pending',
      requestedAtMs: 1_700_000_000_000,
      resolvedAtMs: null,
      resolutionNote: null,
    });
  });
});

describe('resolveKinRemovalRequestHandler (#1408)', () => {
  const PENDING = {
    kinfolkId: '3',
    kinId: 'k1',
    flatKinId: 'flat1',
    kinName: 'Buddy',
    reason: 'Rehomed',
    status: 'pending',
    requestedByUid: 'u1',
    requestedAt: ts(1_700_000_000_000),
  };

  function office(docs: Record<string, Record<string, unknown> | null> = {}) {
    return buildDbMock({
      writeThrough: true,
      docs: {
        [REQUEST_PATH]: PENDING,
        'families/3/kin/k1': FAMILY_KIN,
        'kin/flat1': FLAT_KIN,
        ...docs,
      },
    });
  }

  it('the gate refuses an Auntie: archiving is owner-only', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequest } = await import('../src/admin/kinRemovalRequests');
    await expect(
      (resolveKinRemovalRequest as any).run({ data: { requestId: REQUEST_ID, decision: 'archive' }, auth: { uid: 'auntie1', token: { staffRole: 'auntie' } } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('the gate refuses a household', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequest } = await import('../src/admin/kinRemovalRequests');
    await expect(
      (resolveKinRemovalRequest as any).run({ data: { requestId: REQUEST_ID, decision: 'decline' }, auth: { uid: 'u1', token: { role: 'kinfolk' } } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('archive sets archived on the flat doc AND the family doc, closes the request, deletes nothing', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'archive' }, 'owner'));

    expect(ctx.writes.find((w) => w.path === 'kin/flat1')?.data).toMatchObject({ status: 'archived' });
    expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')?.data).toMatchObject({
      status: 'archived',
      removalRequestId: REQUEST_ID,
      updatedByUid: 'owner',
    });
    expect(ctx.writes.find((w) => w.path === REQUEST_PATH)?.data).toMatchObject({
      status: 'archived',
      resolvedByUid: 'owner',
      resolvedAt: '__SERVER_TS__',
      resolutionNote: null,
    });
    expect(ctx.deletes).toEqual([]);
    expect(res).toMatchObject({ ok: true, decision: 'archive', flatArchived: true, familyArchived: true, householdNotified: true });
    expect(res.request.status).toBe('archived');
  });

  it('archive tells the household with kin.removal.archived and audits the decision', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    await resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'archive', note: 'Take care.' }, 'owner'));
    expect(mocks.resolveUid).toHaveBeenCalledWith('3');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      key: 'kin.removal.archived',
      recipientUid: 'household-uid',
      data: { kinfolkId: '3', kinId: 'k1', kinName: 'Buddy', note: 'Take care.', requestId: REQUEST_ID },
      targetType: 'kinfolk',
      targetId: '3',
    });
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      event: 'KIN_REMOVAL_REQUEST_RESOLVED',
      actorUid: 'owner',
      payload: { requestId: REQUEST_ID, decision: 'archive', flatArchived: true, familyArchived: true },
    });
  });

  it('decline changes no Kin, records the note, and sends kin.removal.declined', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(
      request({ requestId: REQUEST_ID, decision: 'decline', note: '  Buddy has a visit booked next week.  ' }, 'owner'),
    );
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === REQUEST_PATH)?.data).toMatchObject({
      status: 'declined',
      resolvedByUid: 'owner',
      resolutionNote: 'Buddy has a visit booked next week.',
    });
    expect(res).toMatchObject({ decision: 'decline', flatArchived: false, familyArchived: false });
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      key: 'kin.removal.declined',
      data: { note: 'Buddy has a visit booked next week.' },
    });
  });

  it('refuses a request that was already answered, and writes nothing', async () => {
    const ctx = office({ [REQUEST_PATH]: { ...PENDING, status: 'declined' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    await expect(
      resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'archive' }, 'owner')),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'This removal request has already been answered.' });
    expect(ctx.writes).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('not-found for an unknown request', async () => {
    const ctx = office({ [REQUEST_PATH]: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    await expect(
      resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'decline' }, 'owner')),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('invalid-argument on an unknown decision', async () => {
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    await expect(
      resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'delete' }, 'owner')),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('a failed household notice is reported, and the decision stands', async () => {
    mocks.enqueue.mockRejectedValue(new Error('queue down'));
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: REQUEST_ID, decision: 'decline' }, 'owner'));
    expect(res.householdNotified).toBe(false);
    expect(res.request.status).toBe('declined');
  });
});

describe('listKinRemovalRequestsHandler (#1408)', () => {
  it('lists only pending requests, oldest first', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_removal_requests: [
          { id: 'b_k2', data: { kinfolkId: 'b', kinId: 'k2', status: 'pending', requestedAt: ts(2000) } },
          { id: 'a_k1', data: { kinfolkId: 'a', kinId: 'k1', status: 'pending', requestedAt: ts(1000) } },
          { id: 'c_k3', data: { kinfolkId: 'c', kinId: 'k3', status: 'declined', requestedAt: ts(500) } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listKinRemovalRequestsHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await listKinRemovalRequestsHandler(request({}, 'owner'));
    expect(res.requests.map((r) => r.id)).toEqual(['a_k1', 'b_k2']);
  });

  it('with flatKinId, returns that Kin\'s pending request only', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_removal_requests: [
          { id: 'a_k1', data: { kinfolkId: 'a', kinId: 'k1', flatKinId: 'flat1', status: 'pending', requestedAt: ts(1000) } },
          { id: 'b_k2', data: { kinfolkId: 'b', kinId: 'k2', flatKinId: 'flat2', status: 'pending', requestedAt: ts(2000) } },
          { id: 'c_k3', data: { kinfolkId: 'c', kinId: 'k3', flatKinId: 'flat1', status: 'archived', requestedAt: ts(500) } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listKinRemovalRequestsHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await listKinRemovalRequestsHandler(request({ flatKinId: 'flat1' }, 'owner'));
    expect(res.requests.map((r) => r.id)).toEqual(['a_k1']);
  });

  it('an Auntie may read the queue (a kin record), and only the owner may answer it', async () => {
    const { auntieMayCall } = await import('../src/lib/auntieAccess');
    expect(auntieMayCall('listKinRemovalRequests')).toBe(true);
    expect(auntieMayCall('resolveKinRemovalRequest')).toBe(false);
  });
});
