import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntry: vi.fn().mockResolvedValue('a1'),
  resolveStaffIdentities: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/staffIdentity', () => ({ resolveStaffIdentities: mocks.resolveStaffIdentities }));

const OWNER = { token: { admin: true } };
const AUNTIE = { token: { staffRole: 'auntie' } };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntry.mockReset();
  mocks.writeAuditEntry.mockResolvedValue('a1');
  mocks.logEvent.mockClear();
  mocks.resolveStaffIdentities.mockReset();
  mocks.resolveStaffIdentities.mockResolvedValue([{ uid: 'aunt', displayName: 'Jane Rivers', email: null, hasStaffRecord: true }]);
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('resolveKinfolkAccess', () => {
  it('non-operator with no clients doc throws failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('non-operator with a single linked id and no requested resolves it (the normal path, unchanged)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', undefined, false, 'test');
    expect(res).toEqual({ kinfolkId: '3', isOperator: false });
  });

  it('non-operator with MULTIPLE linked ids and no requested refuses to guess (defect account, PR28a)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it("non-operator with a single linked id and '' resolves it ('' is omitted, not a wrong id)", async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', '', false, 'test');
    expect(res).toEqual({ kinfolkId: '3', isOperator: false });
  });

  it("non-operator with MULTIPLE linked ids and '' refuses to guess ('' omitted here too)", async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', '', false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('non-operator allows own id', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', '5', false, 'test');
    expect(res).toEqual({ kinfolkId: '5', isOperator: false });
  });

  it('non-operator denied for foreign id', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', '999', false, 'test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('non-operator branch is unaffected by the admin claim alone (no env allowlist, no claim in this scenario)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', '3', false, 'test');
    expect(res).toEqual({ kinfolkId: '3', isOperator: false });
  });

  it('staff (admin claim) with explicit EXISTING kinfolkId always allowed', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': { firstName: 'X' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', '777', true, 'test');
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
  });

  it('RULING O-6 hardening 1: staff + nonexistent kinfolkId -> not-found', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('op', '777', true, 'test')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it("#1839: the OWNER resolving another household writes no Activity Log line", async () => {
    const ctx = buildDbMock({
      docs: { 'clients/op': { kinfolkIds: ['own-id'] }, 'kinfolk/777': { firstName: 'X' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', '777', true, 'listMembers', OWNER);
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('#1839: an owner-only portal callable passes no caller, and her look writes no line', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': { firstName: 'X' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', '777', true, 'getMyInvoices');
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('#1839: the owner through the allowlist fallback (no claim) writes no line either', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': { firstName: 'X' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('op', '777', false, 'listMembers', { token: {} });
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('#1839: the owner on her OWN id writes no line', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/op': { kinfolkIds: ['own-id'] }, 'kinfolk/own-id': { firstName: 'X' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('op', 'own-id', true, 'someFunction', OWNER);
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it("#1839: an AUNTIE's look writes ONE plain line with her name and the household's", async () => {
    const ctx = buildDbMock({
      docs: { 'clients/aunt': null, 'kinfolk/777': { firstName: 'Dre', lastName: 'East' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('aunt', '777', true, 'listMembers', AUNTIE);
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
    expect(mocks.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith({
      status: 'SUCCESS',
      event: 'OPERATOR_CROSSTENANT_ACCESS',
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: 'aunt',
      targetUid: '777',
      familyId: '777',
      description: 'Jane Rivers looked at the members of Kinfolk Dre East',
      payload: { function: 'listMembers', kinfolkId: '777', admin: false, staffRole: 'auntie' },
    });
    const line = String(mocks.writeAuditEntry.mock.calls[0]?.[0]?.description);
    expect(line).not.toMatch(/OPERATOR|CROSSTENANT|uid=|target=|777/);
  });

  it('#1839: an Auntie on a tribe she was assigned (her own kinfolkIds) is still logged', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/aunt': { kinfolkIds: ['777'] }, 'kinfolk/777': { firstName: 'Dre', lastName: 'East' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('aunt', '777', true, 'listEmergencyContacts', AUNTIE);
    expect(mocks.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]?.description).toBe(
      'Jane Rivers looked at the emergency contacts of Kinfolk Dre East',
    );
  });

  it('#1839: an Auntie defaulting to her assigned tribe (no id sent) is logged with its name', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/aunt': { kinfolkIds: ['42'] }, 'kinfolk/42': { firstName: 'Mo', lastName: 'Lane' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('aunt', undefined, true, 'getMyKinTaleMedia', AUNTIE);
    expect(res).toEqual({ kinfolkId: '42', isOperator: true });
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]).toMatchObject({
      targetUid: '42',
      description: 'Jane Rivers looked at KinTale photos of Kinfolk Mo Lane',
    });
  });

  it('#1839: an Auntie with no name on record, or only an email, reads "An Auntie", never the email', async () => {
    mocks.resolveStaffIdentities.mockResolvedValue([
      { uid: 'aunt', displayName: 'catch@hanasamku.com', email: 'catch@hanasamku.com', hasStaffRecord: true },
    ]);
    const ctx = buildDbMock({ docs: { 'clients/aunt': null, 'kinfolk/777': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('aunt', '777', true, 'listMembers', AUNTIE);
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]?.description).toBe(
      'An Auntie looked at the members of a Kinfolk household',
    );
  });

  it('#1839: a name read that fails still writes the line, in plain fallback words', async () => {
    mocks.resolveStaffIdentities.mockRejectedValue(new Error('auth down'));
    const ctx = buildDbMock({ docs: { 'clients/aunt': null, 'kinfolk/777': { lastName: 'East' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('aunt', '777', true, 'saveSecondaryKinfolk', AUNTIE);
    expect(mocks.writeAuditEntry.mock.calls[0]?.[0]?.description).toBe(
      'An Auntie saved a secondary Kinfolk for Kinfolk East',
    );
  });

  it("#1839: a failed audit write never blocks the Auntie's look, and is logged", async () => {
    mocks.writeAuditEntry.mockRejectedValue(new Error('audit chain head locked'));
    const ctx = buildDbMock({ docs: { 'clients/aunt': null, 'kinfolk/777': { firstName: 'Dre' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('aunt', '777', true, 'listMembers', AUNTIE);
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
    expect(JSON.stringify(mocks.logEvent.mock.calls)).toContain('audit.write.failed');
  });

  it('#1839: an Auntie asking for a household that does not exist is refused and logs nothing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/aunt': null, 'kinfolk/777': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('aunt', '777', true, 'listMembers', AUNTIE)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('env-allowlist staff (no admin claim) with no requested, no own ids throws (must specify)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    const ctx = buildDbMock({ docs: { 'clients/op': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('op', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('env-allowlist staff (no admin claim) with own ids and no requested defaults to first own id', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    const ctx = buildDbMock({ docs: { 'clients/op': { kinfolkIds: ['42'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', undefined, false, 'test');
    expect(res).toEqual({ kinfolkId: '42', isOperator: true });
  });

  it("staff with '' falls back to their own ids, same as omitted (staff branch still reads clients/{uid})", async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': { kinfolkIds: ['42'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', '', true, 'test');
    expect(res).toEqual({ kinfolkId: '42', isOperator: true });
  });
});
