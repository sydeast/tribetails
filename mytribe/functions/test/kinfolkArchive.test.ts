import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// #2161, operator ruling 2026-11-13: only the owner archives or restores a
// Kinfolk household. The `setKinfolkArchived` callable is the one way any
// client does either, and it writes the Activity Log line itself.

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.audit }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.audit.mockReset().mockResolvedValue('a1');
});

const ACTIVE = { firstName: 'Dre', lastName: 'East', status: 'active', archivedAt: '', archivedReason: '', archivedBy: '' };
const ARCHIVED = {
  firstName: 'Dre',
  lastName: 'East',
  status: 'archived',
  archivedAt: '2026-11-01T10:00:00.000Z',
  archivedReason: 'moved away',
  archivedBy: 'owner',
};

function office(doc: Record<string, unknown> | null = ACTIVE) {
  return buildDbMock({ writeThrough: true, docs: { 'kinfolk/kf1': doc } });
}

const OWNER = { uid: 'owner', token: { admin: true } };

function call(data: Record<string, unknown>, auth: Record<string, unknown> = OWNER) {
  return { data, auth } as any;
}

const kinfolkWrites = (ctx: ReturnType<typeof office>) => ctx.writes.filter((w) => w.path === 'kinfolk/kf1');
const archiveAudits = () =>
  mocks.audit.mock.calls.map((c) => c[0]).filter((e) => e.event === 'ARCHIVE_KINFOLK' || e.event === 'RESTORE_KINFOLK');

describe('setKinfolkArchived: who may call it (#2161)', () => {
  it('refuses a caller who is not signed in', async () => {
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await expect(setKinfolkArchivedHandler({ data: { kinfolkId: 'kf1', archived: true } } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses an Auntie an archive, and writes nothing', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({
        data: { kinfolkId: 'kf1', archived: true, reason: 'x' },
        auth: { uid: 'auntie1', token: { staffRole: 'auntie' } },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinfolkWrites(ctx)).toEqual([]);
    expect(archiveAudits()).toEqual([]);
  });

  it('refuses an Auntie a restore, and writes nothing', async () => {
    const ctx = office(ARCHIVED);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({
        data: { kinfolkId: 'kf1', archived: false },
        auth: { uid: 'auntie1', token: { staffRole: 'auntie' } },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinfolkWrites(ctx)).toEqual([]);
  });

  it('refuses an account carrying both the admin claim and the Auntie role', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({
        data: { kinfolkId: 'kf1', archived: true },
        auth: { uid: 'both1', token: { admin: true, staffRole: 'auntie' } },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinfolkWrites(ctx)).toEqual([]);
  });

  it('refuses a household', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({
        data: { kinfolkId: 'kf1', archived: true },
        auth: { uid: 'u1', token: { role: 'kinfolk', kinfolkId: 'kf1' } },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinfolkWrites(ctx)).toEqual([]);
  });

  it('refuses a sandbox test admin, even on its own household', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({
        data: { kinfolkId: 'kf1', archived: true },
        auth: { uid: 'test-admin-uid', token: { testTribeId: 'kf1' } },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinfolkWrites(ctx)).toEqual([]);
    expect(archiveAudits()).toEqual([]);
  });

  it('is not on the Auntie allowlist', async () => {
    const { auntieMayCall } = await import('../src/lib/auntieAccess');
    expect(auntieMayCall('setKinfolkArchived')).toBe(false);
  });

  it('lets the owner through the gate', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchived } = await import('../src/admin/kinfolkArchive');
    await expect(
      (setKinfolkArchived as any).run({ data: { kinfolkId: 'kf1', archived: true }, auth: OWNER }),
    ).resolves.toMatchObject({ ok: true, archived: true, changed: true });
  });
});

describe('setKinfolkArchived: what it writes (#2161)', () => {
  it('archive sets the status, when, why and by whom', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: ' kf1 ', archived: true, reason: '  moved away  ' }));

    const w = kinfolkWrites(ctx);
    expect(w).toHaveLength(1);
    expect(w[0]!.merge).toBe(true);
    expect(w[0]!.data).toMatchObject({
      status: 'archived',
      archivedReason: 'moved away',
      archivedBy: 'owner',
      updatedAt: '__TS__',
    });
    expect(Number.isNaN(Date.parse(String(w[0]!.data['archivedAt'])))).toBe(false);
    expect(res).toEqual({ ok: true, archived: true, status: 'archived', changed: true });
  });

  it('archive without a reason writes a blank reason', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    expect(kinfolkWrites(ctx)[0]!.data).toMatchObject({ status: 'archived', archivedReason: '' });
  });

  it('restore of a household archived before #1958 (no kept status) sets active and clears the archive fields', async () => {
    const ctx = office(ARCHIVED);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false, reason: 'ignored' }));
    const w = kinfolkWrites(ctx);
    expect(w).toHaveLength(1);
    expect(w[0]!.data).toEqual({
      status: 'active',
      archivedAt: '',
      archivedReason: '',
      archivedBy: '',
      statusBeforeArchive: '',
      updatedAt: '__TS__',
    });
    expect(res).toEqual({ ok: true, archived: false, status: 'active', changed: true });
  });

  // #1958: an archive keeps the status the household held, and a restore gives it back.
  it.each([
    ['prospect', 'prospect'],
    ['active', 'active'],
    ['inactive', 'inactive'],
    [' Prospect ', 'prospect'],
    ['', 'active'],
    ['lead', 'active'],
  ])('archive of a household held as %j keeps %j', async (held, kept) => {
    const ctx = office({ ...ACTIVE, status: held });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    expect(kinfolkWrites(ctx)[0]!.data).toMatchObject({ status: 'archived', statusBeforeArchive: kept });
  });

  it.each([
    ['prospect', 'prospect'],
    ['inactive', 'inactive'],
    ['active', 'active'],
    [' PROSPECT ', 'prospect'],
    ['archived', 'active'],
    ['lead', 'active'],
    [42, 'active'],
  ])('restore with %j kept gives back %j, and clears it', async (kept, restored) => {
    const ctx = office({ ...ARCHIVED, statusBeforeArchive: kept });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(kinfolkWrites(ctx)[0]!.data).toMatchObject({ status: restored, statusBeforeArchive: '' });
    expect(res).toEqual({ ok: true, archived: false, status: restored, changed: true });
  });

  it('a Prospect household archived then restored comes back as Prospect (#1958 walk)', async () => {
    const ctx = office({ ...ACTIVE, status: 'prospect' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(res).toMatchObject({ changed: true, status: 'prospect' });
    expect(archiveAudits().map((e) => e.payload.status)).toEqual(['archived', 'prospect']);
  });

  it('restores a household stored as Archived', async () => {
    const ctx = office({ ...ARCHIVED, status: 'Archived' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(kinfolkWrites(ctx)[0]!.data).toMatchObject({ status: 'active' });
    expect(res).toMatchObject({ changed: true, status: 'active' });
  });

  it('restores a household stored with spaces and capitals around archived', async () => {
    const ctx = office({ ...ARCHIVED, status: ' ARCHIVED ' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(kinfolkWrites(ctx)[0]!.data).toMatchObject({ status: 'active', archivedAt: '' });
    expect(res).toMatchObject({ changed: true, status: 'active' });
  });

  it('archiving a household stored as " Archived " changes nothing and logs nothing', async () => {
    const ctx = office({ ...ARCHIVED, status: ' Archived ' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    expect(kinfolkWrites(ctx)).toEqual([]);
    expect(archiveAudits()).toEqual([]);
    expect(res).toMatchObject({ changed: false, status: ' Archived ' });
  });

  it('archiving an archived household changes nothing and logs nothing', async () => {
    const ctx = office(ARCHIVED);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    expect(kinfolkWrites(ctx)).toEqual([]);
    expect(archiveAudits()).toEqual([]);
    expect(res).toEqual({ ok: true, archived: true, status: 'archived', changed: false });
  });

  it('restoring a household that is not archived changes nothing and logs nothing', async () => {
    const ctx = office({ ...ACTIVE, status: 'prospect' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    const res = await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(kinfolkWrites(ctx)).toEqual([]);
    expect(archiveAudits()).toEqual([]);
    expect(res).toEqual({ ok: true, archived: false, status: 'prospect', changed: false });
  });

  it('refuses a household that does not exist, and writes nothing', async () => {
    const ctx = office(null);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await expect(setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }))).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a blank household id', async () => {
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await expect(setKinfolkArchivedHandler(call({ kinfolkId: '  ', archived: true }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('refuses a missing archived flag', async () => {
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await expect(setKinfolkArchivedHandler(call({ kinfolkId: 'kf1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

describe('setKinfolkArchived: the Activity Log line (#2161)', () => {
  it('an owner archive writes exactly one ARCHIVE_KINFOLK line, filed under the owner', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true, reason: 'moved away' }));
    expect(archiveAudits()).toHaveLength(1);
    expect(archiveAudits()[0]).toMatchObject({
      status: 'SUCCESS',
      event: 'ARCHIVE_KINFOLK',
      actorRole: 'AUNTIE',
      actorUid: 'owner',
      targetUid: 'kf1',
      targetCollection: 'kinfolk',
      familyId: 'kf1',
      description: 'Archived Kinfolk Dre East (reason: moved away)',
      payload: { kinfolkId: 'kf1', status: 'archived', reason: 'moved away', admin: true, staffRole: null },
    });
  });

  it('an owner restore writes exactly one RESTORE_KINFOLK line', async () => {
    const ctx = office(ARCHIVED);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: false }));
    expect(archiveAudits()).toHaveLength(1);
    expect(archiveAudits()[0]).toMatchObject({
      event: 'RESTORE_KINFOLK',
      actorUid: 'owner',
      targetUid: 'kf1',
      description: 'Restored Kinfolk Dre East',
      payload: { kinfolkId: 'kf1', status: 'active', admin: true },
    });
    expect(archiveAudits()[0].payload).not.toHaveProperty('reason');
  });

  it('a household with no name on file reads as "a Kinfolk household"', async () => {
    const ctx = office({ status: 'active' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }));
    expect(archiveAudits()[0].description).toBe('Archived a Kinfolk household');
  });

  it('the archive stands when the Activity Log write fails', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.audit.mockRejectedValue(new Error('chain busy'));
    const { setKinfolkArchivedHandler } = await import('../src/admin/kinfolkArchive');
    await expect(setKinfolkArchivedHandler(call({ kinfolkId: 'kf1', archived: true }))).resolves.toMatchObject({
      changed: true,
    });
    expect(kinfolkWrites(ctx)).toHaveLength(1);
  });
});
