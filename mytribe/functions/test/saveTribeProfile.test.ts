import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

describe('saveTribeProfileHandler', () => {
  it('rejects unauth', async () => {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(saveTribeProfileHandler({ data: { displayName: 'X' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('STAFF GATE: denies a stranger (not staff, kinfolkIds does not include the target)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'X' }, auth: { uid: 'stranger' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes.find((w) => w.path === 'families/3')).toBeUndefined();
  });

  it('STAFF GATE: an operator with the admin claim can save a household that is not their own', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: [] },
        'kinfolk/3': { firstName: 'Doe' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      saveTribeProfileHandler({
        data: { kinfolkId: '3', displayName: 'Foster' },
        auth: { uid: 'op-uid', token: { admin: true } },
      } as any),
    ).resolves.toEqual({ ok: true });
    const w = ctx.writes.find((w) => w.path === 'families/3');
    expect(w?.data.displayName).toBe('Foster');
  });

  it('STAFF GATE: an operator on the AUNTIE_OPERATOR_UIDS allowlist (no admin claim) can save a household that is not their own', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: [] },
        'kinfolk/3': { firstName: 'Doe' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      saveTribeProfileHandler({
        data: { kinfolkId: '3', displayName: 'Foster' },
        auth: { uid: 'op-uid' },
      } as any),
    ).resolves.toEqual({ ok: true });
    const w = ctx.writes.find((w) => w.path === 'families/3');
    expect(w?.data.displayName).toBe('Foster');
  });

  it('writes only fields that the caller passed', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'Foster' }, auth: { uid: 'u1' } } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3');
    expect(w).toBeDefined();
    expect(w!.data.displayName).toBe('Foster');
    expect(w!.data.customFields).toBeUndefined();
    expect(w!.merge).toBe(true);
  });

  it('emits PROFILE_UPDATED audit on successful save', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'Foster' }, auth: { uid: 'u1' } } as any);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROFILE_UPDATED',
        actorRole: 'PRIMARY',
        actorUid: 'u1',
        targetUid: '3',
        targetCollection: 'families',
      }),
    );
  });

  it('returns ok without writing when nothing besides timestamp would change', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * #829: the `emergencyContact*` keys in `families/{id}.customFields` are a dead
 * store. Emergency Contacts live on the kinfolk record and are gated on
 * `home_access` inside `saveEmergencyContacts`. This callable strips the keys
 * from every payload, never writes a sent value, and carries a stored copy
 * through untouched until the migration moves it. So a payload without them
 * (the new portal) and a payload with them (an old client) both save, for every
 * member, and neither is ever refused over them.
 *
 * (#843 used to refuse here on a before/after comparison of those keys. Once the
 * new portal stopped sending them, that comparison read every save as "cleared"
 * and locked secondaries without Home access out of profile saves.)
 */
describe('saveTribeProfileHandler: the old Emergency Contact keys are stripped, never gated', () => {
  const PERMS_OFF = {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
    home_access: false,
  };
  const SECONDARY_NO_HOME = { role: 'SECONDARY', status: 'ACTIVE', permissions: PERMS_OFF };
  const SECONDARY_WITH_HOME = { role: 'SECONDARY', status: 'ACTIVE', permissions: { ...PERMS_OFF, home_access: true } };
  const STORED_EC = [
    { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Halbrook' },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0100' },
    { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
  ];

  function household(member: Record<string, unknown> | null) {
    return buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'The Foster', customFields: STORED_EC },
        'families/3/members/u2': member,
      },
    });
  }

  function writtenFields(ctx: ReturnType<typeof household>) {
    return ctx.writes.find((w) => w.path === 'families/3')?.data.customFields as Array<{ key: string; value: string }> | undefined;
  }
  const valueOf = (fields: Array<{ key: string; value: string }> | undefined, key: string) => fields?.find((f) => f.key === key)?.value;

  it('#829 new portal: stored keys, a payload without them, no Home access: saved, and the stored copy is left as it was', async () => {
    const ctx = household(SECONDARY_NO_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    const withoutEc = STORED_EC.filter((f) => !f.key.startsWith('emergencyContact'));
    await expect(
      saveTribeProfileHandler({
        data: { kinfolkId: '3', displayName: 'The Foster Tribe', customFields: withoutEc },
        auth: { uid: 'u2' },
      } as any),
    ).resolves.toEqual({ ok: true });
    const fields = writtenFields(ctx);
    expect(ctx.writes.find((w) => w.path === 'families/3')?.data.displayName).toBe('The Foster Tribe');
    expect(valueOf(fields, 'k1')).toBe('Oct 14');
    // Carried through for the migration, never deleted by a save.
    expect(valueOf(fields, 'emergencyContactName')).toBe('Rae Halbrook');
    expect(valueOf(fields, 'emergencyContactPhone')).toBe('555-0100');
  });

  it('#829 old client, no Home access: a changed Emergency Contact in the payload is stripped, never written, and not refused', async () => {
    const ctx = household(SECONDARY_NO_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    const changed = STORED_EC.map((f) => (f.key === 'emergencyContactPhone' ? { ...f, value: '555-9999' } : f));
    await expect(
      saveTribeProfileHandler({ data: { kinfolkId: '3', customFields: changed }, auth: { uid: 'u2' } } as any),
    ).resolves.toEqual({ ok: true });
    const fields = writtenFields(ctx);
    expect(valueOf(fields, 'emergencyContactPhone')).toBe('555-0100');
    expect(JSON.stringify(fields)).not.toContain('555-9999');
  });

  it('#829 old client, primary: sent keys are stripped for every caller, so a household with none stored gets none written', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'The Foster', customFields: [{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }] },
        'families/3/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      saveTribeProfileHandler({
        data: {
          kinfolkId: '3',
          customFields: [
            { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
            { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Sam Ortiz' },
            { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0111' },
            { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: 'Brother' },
          ],
        },
        auth: { uid: 'u1' },
      } as any),
    ).resolves.toEqual({ ok: true });
    const fields = writtenFields(ctx) ?? [];
    expect(fields.map((f) => f.key)).toEqual(['k1']);
  });

  it('#829 old client, secondary with Home access: the keys are stripped here too; the callable is the only write path', async () => {
    const ctx = household(SECONDARY_WITH_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    const changed = STORED_EC.map((f) => (f.key === 'emergencyContactName' ? { ...f, value: 'Sam Ortiz' } : f));
    await expect(
      saveTribeProfileHandler({ data: { kinfolkId: '3', customFields: changed }, auth: { uid: 'u2' } } as any),
    ).resolves.toEqual({ ok: true });
    expect(valueOf(writtenFields(ctx), 'emergencyContactName')).toBe('Rae Halbrook');
  });

  it('a secondary without Home access re-sending the stored copy unchanged still saves the rest of the profile', async () => {
    const ctx = household(SECONDARY_NO_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      saveTribeProfileHandler({
        data: { kinfolkId: '3', displayName: 'The Foster Tribe', customFields: STORED_EC },
        auth: { uid: 'u2' },
      } as any),
    ).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === 'families/3')?.data.displayName).toBe('The Foster Tribe');
  });

  it("records a secondary's save as SECONDARY in the audit, not as the primary", async () => {
    const ctx = household(SECONDARY_NO_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'The Foster Tribe' }, auth: { uid: 'u2' } } as any);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'SECONDARY', actorUid: 'u2' }));
  });
});
