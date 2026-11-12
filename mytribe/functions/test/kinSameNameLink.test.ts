import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// #1912: a Kin added in the portal under the name of an archived Kin was
// adopted onto the archived Kin's admin record. Every fixture here runs with
// `writeThrough`, so a later read sees what an earlier step wrote, the way the
// portal and the admin see it.

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
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveUid.mockReset().mockResolvedValue('household-uid');
  mocks.audit.mockReset().mockResolvedValue('a1');
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

import { mirrorFamilyKinToFlat } from '../src/triggers/onFamilyKinWrite';

type Docs = Record<string, Record<string, unknown> | null>;

const HOUSEHOLD = '3';
const OLD_PATH = `families/${HOUSEHOLD}/kin/old`;
const NEW_PATH = `families/${HOUSEHOLD}/kin/new`;
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

/** The archived Kin as the office left it: both copies archived, visits on its admin record. */
const OLD_FAMILY = { name: 'Max', species: 'Dog', status: 'archived', legacyKinId: 'flatOld', familyKinPath: OLD_PATH, createdAt: day(1), createdByUid: 'u1' };
const OLD_FLAT = { name: 'Max', species: 'Dog', kinfolkId: HOUSEHOLD, status: 'archived', familyKinPath: OLD_PATH, legacyKinId: 'flatOld', officeNotes: 'older dog', createdAt: day(1) };
/** The Kin the household adds afterwards under the same name. */
const NEW_FAMILY = { name: 'Max', species: 'Bird', status: 'active', createdAt: day(10), createdByUid: 'u1' };

function world(seed: Docs, sessionsOn: string[] = []) {
  // The one map the mock reads and writes, so the test sees every write.
  const docs: Docs = { 'clients/u1': { kinfolkIds: [HOUSEHOLD] }, ...seed };
  const ctx = buildDbMock({
    writeThrough: true,
    docs,
    queryDocs: {
      kin_care_sessions: sessionsOn.map((id, i) => ({ id: `s${i}`, data: { kinfolkId: HOUSEHOLD, kinIds: [id] } })),
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs: docs as Record<string, Record<string, unknown>> };
}

/** What the trigger does for one family Kin write, read from the stored doc. */
async function runMirror(docs: Record<string, Record<string, unknown>>, kinId: string, before?: Record<string, unknown>) {
  return mirrorFamilyKinToFlat(HOUSEHOLD, kinId, before as any, docs[`families/${HOUSEHOLD}/kin/${kinId}`] as any);
}

function flatIdsOf(docs: Record<string, unknown>): string[] {
  return Object.keys(docs).filter((p) => /^kin\/[^/]+$/.test(p)).map((p) => p.slice(4));
}

function request(data: Record<string, unknown>, uid = 'u1') {
  return { data, auth: { uid } } as any;
}

describe('a Kin added in the portal gets its own admin record, whatever its name (#1912)', () => {
  it('same name as an ARCHIVED Kin: a new admin record is made and the archived one is not touched', async () => {
    const { docs } = world({ [OLD_PATH]: { ...OLD_FAMILY }, 'kin/flatOld': { ...OLD_FLAT }, [NEW_PATH]: { ...NEW_FAMILY } });
    const res = await runMirror(docs, 'new');

    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatOld');
    expect(docs['kin/flatOld']).toEqual(OLD_FLAT);
    expect(docs[`kin/${res.flatDocId}`]).toMatchObject({
      name: 'Max',
      species: 'Bird',
      status: 'active',
      kinfolkId: HOUSEHOLD,
      familyKinPath: NEW_PATH,
      legacyKinId: res.flatDocId,
    });
    expect(docs[NEW_PATH]).toMatchObject({ legacyKinId: res.flatDocId, familyKinPath: NEW_PATH });
  });

  it('same name as an archived Kin that only the office ever held (no household copy)', async () => {
    const { docs } = world({
      'kin/flatOld': { name: 'Max', species: 'Dog', kinfolkId: HOUSEHOLD, status: 'archived' },
      [NEW_PATH]: { ...NEW_FAMILY },
    });
    const res = await runMirror(docs, 'new');
    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatOld');
    expect(docs['kin/flatOld']).toEqual({ name: 'Max', species: 'Dog', kinfolkId: HOUSEHOLD, status: 'archived' });
  });

  it('same name as a MEMORIALISED Kin: not adopted', async () => {
    const memorialFlat = { ...OLD_FLAT, status: 'inactive' };
    const { docs } = world({
      [OLD_PATH]: { ...OLD_FAMILY, status: 'noLongerWithUs' },
      'kin/flatOld': { ...memorialFlat },
      [NEW_PATH]: { ...NEW_FAMILY },
    });
    const res = await runMirror(docs, 'new');
    expect(res.action).toBe('created');
    expect(docs['kin/flatOld']).toEqual(memorialFlat);
  });

  it('same name as an ACTIVE Kin: two Kin stay two Kin', async () => {
    const activeFlat = { ...OLD_FLAT, status: 'active' };
    const { docs } = world({
      [OLD_PATH]: { ...OLD_FAMILY, status: 'active' },
      'kin/flatOld': { ...activeFlat },
      [NEW_PATH]: { ...NEW_FAMILY },
    });
    const res = await runMirror(docs, 'new');
    expect(res.action).toBe('created');
    expect(docs['kin/flatOld']).toEqual(activeFlat);
    expect(flatIdsOf(docs).sort()).toEqual(['flatOld', res.flatDocId].sort());
  });

  it('a different name is the control: one new admin record', async () => {
    const { docs } = world({ [OLD_PATH]: { ...OLD_FAMILY }, 'kin/flatOld': { ...OLD_FLAT }, [NEW_PATH]: { ...NEW_FAMILY, name: 'Pip' } });
    const res = await runMirror(docs, 'new');
    expect(res.action).toBe('created');
    expect(docs[`kin/${res.flatDocId}`]).toMatchObject({ name: 'Pip', familyKinPath: NEW_PATH });
  });

  it('an active record the office made first, linked to no household copy, is still adopted by name', async () => {
    const { docs } = world({
      'kin/officeMade': { name: 'Max', species: 'Dog', kinfolkId: HOUSEHOLD, status: 'active', routine: 'two walks' },
      [NEW_PATH]: { ...NEW_FAMILY },
    });
    const res = await runMirror(docs, 'new');
    expect(res.flatDocId).toBe('officeMade');
    expect(flatIdsOf(docs)).toEqual(['officeMade']);
    expect(docs['kin/officeMade']).toMatchObject({ familyKinPath: NEW_PATH, legacyKinId: 'officeMade', routine: 'two walks', species: 'Bird' });
    expect(docs[NEW_PATH]).toMatchObject({ legacyKinId: 'officeMade' });
  });

  it('an office-made record whose link names a household copy that was never written is adopted too', async () => {
    const { docs } = world({
      'kin/officeMade': { name: 'Max', kinfolkId: HOUSEHOLD, status: 'active', familyKinPath: `families/${HOUSEHOLD}/kin/officeMade` },
      [NEW_PATH]: { ...NEW_FAMILY },
    });
    const res = await runMirror(docs, 'new');
    expect(res.flatDocId).toBe('officeMade');
    expect(flatIdsOf(docs)).toEqual(['officeMade']);
  });

  it('a record one portal Kin already adopted is never handed to a second Kin of the same name', async () => {
    const { docs } = world({
      'kin/officeMade': { name: 'Max', kinfolkId: HOUSEHOLD, status: 'active' },
      [NEW_PATH]: { ...NEW_FAMILY },
      [`families/${HOUSEHOLD}/kin/twin`]: { ...NEW_FAMILY, createdAt: day(11) },
    });
    const first = await runMirror(docs, 'new');
    const second = await runMirror(docs, 'twin');
    expect(first.flatDocId).toBe('officeMade');
    expect(second.action).toBe('created');
    expect(second.flatDocId).not.toBe('officeMade');
    expect(docs['kin/officeMade']).toMatchObject({ familyKinPath: NEW_PATH });
  });

  it('renaming a Kin onto an archived Kin\'s name edits its own record only', async () => {
    const rexFamily = { name: 'Max', species: 'Bird', status: 'active', legacyKinId: 'flatRex', familyKinPath: NEW_PATH, createdAt: day(10), createdByUid: 'u1' };
    const { docs } = world({
      [OLD_PATH]: { ...OLD_FAMILY },
      'kin/flatOld': { ...OLD_FLAT },
      [NEW_PATH]: rexFamily,
      'kin/flatRex': { name: 'Rex', species: 'Bird', kinfolkId: HOUSEHOLD, status: 'active', familyKinPath: NEW_PATH, legacyKinId: 'flatRex', createdAt: day(10) },
    });
    const res = await runMirror(docs, 'new', { ...rexFamily, name: 'Rex' });
    expect(res).toEqual({ action: 'updated', flatDocId: 'flatRex' });
    expect(docs['kin/flatRex']).toMatchObject({ name: 'Max', status: 'active' });
    expect(docs['kin/flatOld']).toEqual(OLD_FLAT);
  });

  it('a link that names another household\'s record is refused: that record is never written', async () => {
    const theirs = { name: 'Zed', species: 'Cat', kinfolkId: '9', status: 'active', familyKinPath: 'families/9/kin/z', legacyKinId: 'flatTheirs' };
    const { ctx, docs } = world({
      'families/9/kin/z': { name: 'Zed', status: 'active', legacyKinId: 'flatTheirs', familyKinPath: 'families/9/kin/z' },
      'kin/flatTheirs': { ...theirs },
      [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatTheirs' },
    });
    const res = await runMirror(docs, 'new');
    expect(docs['kin/flatTheirs']).toEqual(theirs);
    expect(ctx.writes.some((w) => w.path === 'kin/flatTheirs')).toBe(false);
    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatTheirs');
    expect(docs[NEW_PATH]).toMatchObject({ legacyKinId: res.flatDocId });
  });
});

/** The state the defect left behind: the new Kin linked onto the archived Kin's record. */
function crossedDocs(extra: Docs = {}): Docs {
  return {
    [OLD_PATH]: { ...OLD_FAMILY },
    [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatOld', familyKinPath: NEW_PATH },
    'kin/flatOld': { ...OLD_FLAT, species: 'Bird', familyKinPath: NEW_PATH },
    ...extra,
  };
}
const CROSSED_REQUEST_PATH = `kin_removal_requests/${HOUSEHOLD}_new`;
const CROSSED_REQUEST = {
  kinfolkId: HOUSEHOLD,
  kinId: 'new',
  flatKinId: 'flatOld',
  kinName: 'Max',
  reason: 'Added by mistake',
  status: 'pending',
  blockedBy: ['visits'],
  requestedByUid: 'u1',
  requestedAt: { toMillis: () => 1_700_000_000_000 },
};

describe('records already crossed by the defect are put right on normal use (#1912)', () => {
  it('the next save of the new Kin gives it its own record and hands the archived record back', async () => {
    const { docs } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }));
    const before = { ...docs[NEW_PATH] };
    docs[NEW_PATH] = { ...docs[NEW_PATH], sitterNotes: 'Sings at dawn' };
    const res = await runMirror(docs, 'new', before);

    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatOld');
    expect(docs[`kin/${res.flatDocId}`]).toMatchObject({ name: 'Max', species: 'Bird', status: 'active', familyKinPath: NEW_PATH, sitterNotes: 'Sings at dawn' });
    expect(docs[NEW_PATH]).toMatchObject({ legacyKinId: res.flatDocId });
    // The archived Kin's record: its own link, its own facts, still archived, staff notes kept.
    expect(docs['kin/flatOld']).toMatchObject({ familyKinPath: OLD_PATH, species: 'Dog', status: 'archived', officeNotes: 'older dog', legacyKinId: 'flatOld' });
    // The waiting removal request now names the new Kin's own record.
    expect(docs[CROSSED_REQUEST_PATH]).toMatchObject({ flatKinId: res.flatDocId, status: 'pending' });
  });

  it('a save of the ARCHIVED Kin puts the pair right as well', async () => {
    const { docs } = world(crossedDocs());
    const before = { ...docs[OLD_PATH] };
    docs[OLD_PATH] = { ...docs[OLD_PATH], sitterNotes: 'Shy' };
    const res = await runMirror(docs, 'old', before);
    expect(res.flatDocId).toBe('flatOld');
    expect(docs['kin/flatOld']).toMatchObject({ familyKinPath: OLD_PATH, species: 'Dog', status: 'archived' });
    const newFlat = docs[NEW_PATH]['legacyKinId'] as string;
    expect(newFlat).not.toBe('flatOld');
    expect(docs[`kin/${newFlat}`]).toMatchObject({ species: 'Bird', status: 'active', familyKinPath: NEW_PATH });
  });

  it('when the archived record had no household copy, the new Kin still leaves it and gets its own', async () => {
    const { docs } = world({
      [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatOld', familyKinPath: NEW_PATH },
      'kin/flatOld': { name: 'Max', species: 'Bird', kinfolkId: HOUSEHOLD, status: 'archived', familyKinPath: NEW_PATH, legacyKinId: 'flatOld', createdAt: day(1) },
    });
    const before = { ...docs[NEW_PATH] };
    docs[NEW_PATH] = { ...docs[NEW_PATH], sitterNotes: 'Sings at dawn' };
    const res = await runMirror(docs, 'new', before);
    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatOld');
    expect(docs['kin/flatOld']).toMatchObject({ status: 'archived', familyKinPath: '__DELETE__' });
    expect(docs[`kin/${res.flatDocId}`]).toMatchObject({ status: 'active', familyKinPath: NEW_PATH });
  });

  it('a household restoring its own memorial is not mistaken for a crossed pair', async () => {
    const family = { name: 'Max', status: 'active', legacyKinId: 'flatOld', familyKinPath: NEW_PATH, createdAt: day(10), createdByUid: 'u1' };
    const { docs } = world({
      [NEW_PATH]: family,
      'kin/flatOld': { name: 'Max', kinfolkId: HOUSEHOLD, status: 'inactive', familyKinPath: NEW_PATH, legacyKinId: 'flatOld', createdAt: day(1) },
    });
    const res = await runMirror(docs, 'new', { ...family, status: 'noLongerWithUs' });
    expect(res).toEqual({ action: 'updated', flatDocId: 'flatOld' });
    expect(docs['kin/flatOld']).toMatchObject({ status: 'active' });
    expect(flatIdsOf(docs)).toEqual(['flatOld']);
  });

  it('opening the new Kin\'s edit screen offers delete, and writes nothing', async () => {
    const { ctx } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }), ['flatOld']);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new' }));
    expect(res).toMatchObject({ deleted: false, canDelete: true, blockedBy: [] });
    expect(ctx.writes).toEqual([]);
    expect(ctx.deletes).toEqual([]);
  });

  it('deleting the new Kin removes it and its request, and the archived Kin keeps its record', async () => {
    const { ctx, docs } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }), ['flatOld']);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', confirm: true }));
    expect(res).toMatchObject({ deleted: true });
    expect(docs[NEW_PATH]).toBeUndefined();
    expect(docs[CROSSED_REQUEST_PATH]).toBeUndefined();
    expect(ctx.deletes).not.toContain('kin/flatOld');
    expect(docs['kin/flatOld']).toMatchObject({ familyKinPath: OLD_PATH, species: 'Dog', status: 'archived' });
    expect(flatIdsOf(docs)).toEqual(['flatOld']);
  });

  it('a late mirror event for a Kin deleted since does not bring it back', async () => {
    const { ctx, docs } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }));
    const seenByEvent = { ...docs[NEW_PATH] };
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', confirm: true }));
    const writesBefore = ctx.writes.length;
    // The event that fired before the delete, and the one the repair's own stamp fired.
    const late = await mirrorFamilyKinToFlat(HOUSEHOLD, 'new', undefined, seenByEvent as any);
    const fromRepair = await mirrorFamilyKinToFlat(HOUSEHOLD, 'new', seenByEvent as any, { ...seenByEvent, legacyKinId: 'gone' } as any);
    expect(late.action).toBe('skipped');
    expect(fromRepair.action).toBe('skipped');
    expect(ctx.writes.length).toBe(writesBefore);
    expect(docs[NEW_PATH]).toBeUndefined();
    expect(flatIdsOf(docs)).toEqual(['flatOld']);
  });
  it('a late mirror event that still carries the old link does not make a second record', async () => {
    const { ctx, docs } = world(crossedDocs());
    const seenByEvent = { ...docs[NEW_PATH] };
    await runMirror(docs, 'new', { ...seenByEvent, sitterNotes: 'x' });
    const own = docs[NEW_PATH]['legacyKinId'];
    const writesBefore = ctx.writes.length;
    const late = await mirrorFamilyKinToFlat(HOUSEHOLD, 'new', undefined, seenByEvent as any);
    expect(late.action).toBe('skipped');
    expect(ctx.writes.length).toBe(writesBefore);
    expect(docs[NEW_PATH]['legacyKinId']).toBe(own);
    expect(flatIdsOf(docs).sort()).toEqual(['flatOld', own].sort());
  });
  it('the office can ARCHIVE on the request that was sent while crossed: the new Kin is archived, not the old one again', async () => {
    const { docs } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }));
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: `${HOUSEHOLD}_new`, decision: 'archive' }, 'owner'));
    expect(res).toMatchObject({ ok: true, decision: 'archive', flatArchived: true, familyArchived: true });
    const newFlat = docs[NEW_PATH]['legacyKinId'] as string;
    expect(newFlat).not.toBe('flatOld');
    expect(res.request.flatKinId).toBe(newFlat);
    expect(docs[`kin/${newFlat}`]).toMatchObject({ status: 'archived', species: 'Bird' });
    expect(docs[NEW_PATH]).toMatchObject({ status: 'archived' });
    expect(docs['kin/flatOld']).toMatchObject({ familyKinPath: OLD_PATH, species: 'Dog', status: 'archived' });
  });

  it('the office can DECLINE it: the new Kin stays, now with its own record for the office to see', async () => {
    const { docs } = world(crossedDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST } }));
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: `${HOUSEHOLD}_new`, decision: 'decline', note: 'Kept' }, 'owner'));
    expect(res).toMatchObject({ ok: true, decision: 'decline', flatArchived: false, familyArchived: false });
    const newFlat = docs[NEW_PATH]['legacyKinId'] as string;
    expect(docs[`kin/${newFlat}`]).toMatchObject({ status: 'active', familyKinPath: NEW_PATH });
    expect(docs[NEW_PATH]).toMatchObject({ status: 'active' });
    expect(docs[CROSSED_REQUEST_PATH]).toMatchObject({ status: 'declined', resolutionNote: 'Kept' });
  });

  it('restoring the archived Kin from the admin writes the archived Kin\'s household copy, never the new Kin\'s', async () => {
    const { docs } = world(crossedDocs());
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(request({ kinId: 'flatOld', archived: false }, 'owner'));
    expect(res).toMatchObject({ ok: true, archived: false, flatStatus: 'active', familyStatus: 'active' });
    expect(docs[OLD_PATH]).toMatchObject({ status: 'active' });
    expect(docs[NEW_PATH]['legacyKinId']).not.toBe('flatOld');
    expect(docs['kin/flatOld']).toMatchObject({ status: 'active', familyKinPath: OLD_PATH });
  });
});

/** After the fix: the new Kin has its own record beside the archived namesake. */
function healthyDocs(extra: Docs = {}): Docs {
  return {
    [OLD_PATH]: { ...OLD_FAMILY },
    'kin/flatOld': { ...OLD_FLAT },
    [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatNew', familyKinPath: NEW_PATH },
    'kin/flatNew': { name: 'Max', species: 'Bird', kinfolkId: HOUSEHOLD, status: 'active', familyKinPath: NEW_PATH, legacyKinId: 'flatNew', createdAt: day(10) },
    ...extra,
  };
}

describe('delete and removal for a Kin that shares a name with an archived Kin (#1912)', () => {
  it('no history of its own: delete is offered though the archived namesake has visits', async () => {
    world(healthyDocs(), ['flatOld', 'old']);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new' }))).resolves.toMatchObject({ canDelete: true, blockedBy: [] });
  });

  it('a confirmed delete removes the new Kin and its own record only', async () => {
    const { ctx, docs } = world(healthyDocs(), ['flatOld']);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', confirm: true }))).resolves.toMatchObject({ deleted: true });
    expect(ctx.deletes.sort()).toEqual(['kin/flatNew', NEW_PATH].sort());
    expect(docs['kin/flatOld']).toEqual(OLD_FLAT);
    expect(docs[OLD_PATH]).toEqual(OLD_FAMILY);
  });

  it('with no history a removal request is refused and points at delete', async () => {
    const { ctx } = world(healthyDocs(), ['flatOld']);
    const { requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(requestKinRemovalHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Max has nothing on file, so you can delete this profile from here instead.',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('with history of its own, removal is requested for ITS record and the office is told which', async () => {
    const { docs } = world(healthyDocs(), ['flatNew']);
    const { requestKinRemovalHandler, deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await requestKinRemovalHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', reason: 'Rehomed' }));
    expect(res.removalRequest).toMatchObject({ status: 'pending', kinId: 'new', flatKinId: 'flatNew', kinName: 'Max' });
    expect(docs[`kin_removal_requests/${HOUSEHOLD}_new`]).toMatchObject({ flatKinId: 'flatNew', blockedBy: ['visits'] });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kin.removal.requested',
        data: expect.objectContaining({ kinfolkId: HOUSEHOLD, kinId: 'new', flatKinId: 'flatNew', requestId: `${HOUSEHOLD}_new` }),
      }),
    );
    await expect(deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', confirm: true }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('the office archives it: the new Kin\'s two copies are archived, the namesake is left as it was', async () => {
    const { docs } = world(healthyDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST, flatKinId: 'flatNew' } }), ['flatNew']);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: `${HOUSEHOLD}_new`, decision: 'archive' }, 'owner'));
    expect(res).toMatchObject({ flatArchived: true, familyArchived: true });
    expect(docs['kin/flatNew']).toMatchObject({ status: 'archived' });
    expect(docs[NEW_PATH]).toMatchObject({ status: 'archived', removalRequestId: `${HOUSEHOLD}_new` });
    expect(docs['kin/flatOld']).toEqual(OLD_FLAT);
    expect(docs[OLD_PATH]).toEqual(OLD_FAMILY);
  });

  it('the office declines it: nothing about either Kin changes', async () => {
    const { docs } = world(healthyDocs({ [CROSSED_REQUEST_PATH]: { ...CROSSED_REQUEST, flatKinId: 'flatNew' } }), ['flatNew']);
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    const res = await resolveKinRemovalRequestHandler(request({ requestId: `${HOUSEHOLD}_new`, decision: 'decline' }, 'owner'));
    expect(res).toMatchObject({ decision: 'decline', flatArchived: false, familyArchived: false });
    expect(docs['kin/flatNew']).toMatchObject({ status: 'active' });
    expect(docs[NEW_PATH]).toMatchObject({ status: 'active' });
    expect(docs['kin/flatOld']).toEqual(OLD_FLAT);
  });
});

describe('a household only ever touches its own Kin (#1912)', () => {
  const THEIR_FLAT = { name: 'Zed', kinfolkId: '9', status: 'active', familyKinPath: 'families/9/kin/z', legacyKinId: 'flatTheirs' };
  const theirs: Docs = {
    'families/9/kin/z': { name: 'Zed', status: 'active', legacyKinId: 'flatTheirs', familyKinPath: 'families/9/kin/z' },
    'kin/flatTheirs': { ...THEIR_FLAT },
  };

  it('delete and removal of another household\'s Kin are refused', async () => {
    const { ctx } = world({ ...theirs }, ['flatTheirs']);
    const { deleteKinHandler, requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(deleteKinHandler(request({ kinfolkId: '9', kinId: 'z', confirm: true }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(requestKinRemovalHandler(request({ kinfolkId: '9', kinId: 'z' }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
    expect(ctx.deletes).toEqual([]);
  });

  it('a link field sent with a new Kin or an edit is not stored', async () => {
    const { ctx } = world({ ...theirs, [NEW_PATH]: { ...NEW_FAMILY } });
    const { addKinHandler, updateKinHandler } = await import('../src/portal/kinWrites');
    await addKinHandler(request({ kinfolkId: HOUSEHOLD, kin: { name: 'Max', legacyKinId: 'flatTheirs' } }));
    await updateKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', kin: { breed: 'Budgie', legacyKinId: 'flatTheirs' } }));
    expect(ctx.adds[0].data).not.toHaveProperty('legacyKinId');
    expect(ctx.writes.find((w) => w.path === NEW_PATH)?.data).not.toHaveProperty('legacyKinId');
  });

  it('a Kin whose link names another household\'s record: delete leaves that record, and its visits do not count', async () => {
    const { ctx, docs } = world({ ...theirs, [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatTheirs' } }, ['flatTheirs']);
    const { deleteKinHandler, requestKinRemovalHandler } = await import('../src/portal/kinWrites');
    await expect(deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new' }))).resolves.toMatchObject({ canDelete: true });
    await expect(requestKinRemovalHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(deleteKinHandler(request({ kinfolkId: HOUSEHOLD, kinId: 'new', confirm: true }))).resolves.toMatchObject({ deleted: true });
    expect(ctx.deletes).toEqual([NEW_PATH]);
    expect(docs['kin/flatTheirs']).toEqual(THEIR_FLAT);
  });
});
