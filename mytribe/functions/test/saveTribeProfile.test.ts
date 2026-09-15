import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { EMERGENCY_CONTACT_OUTSIDE_MESSAGE } from '../src/lib/emergencyContacts';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), enforceRateLimitFn: vi.fn(), hasKinfolkPermSpy: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
// #873 second review. The limiter runs its own transaction; mocked so it neither
// passes through installOptimisticTransactions nor counts across tests. The real
// limiter is covered in rateLimit.test.ts and the emulator round trip.
vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: mocks.enforceRateLimitFn }));
// The real gate, wrapped so a test can count how often it ran.
vi.mock('../src/lib/memberGate', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/memberGate')>('../src/lib/memberGate');
  mocks.hasKinfolkPermSpy.mockImplementation(actual.hasKinfolkPerm);
  return { ...actual, hasKinfolkPerm: mocks.hasKinfolkPermSpy };
});
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
  mocks.enforceRateLimitFn.mockReset();
  mocks.enforceRateLimitFn.mockResolvedValue(undefined);
  mocks.hasKinfolkPermSpy.mockClear();
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
 * #873. A household with a tribeProfile form schema saved `customFields` rebuilt
 * from the schema keys, and the callable replaced the stored list whole, so every
 * office-set, older-schema or hand-added row was deleted on the next save. The
 * callable now merges by key and removes a row only when it is named in
 * `removeCustomFieldKeys`.
 */
describe('saveTribeProfileHandler: customFields merge by key (#873)', () => {
  const OFFICE = { key: 'gateNote', label: 'Set by Auntie', value: 'Side gate sticks' };
  const ALLERGY = { key: 'allergy', label: 'Allergies', value: 'Chicken' };
  const VET = { key: 'vetClinicId', label: 'Vet Clinic', value: 'clinic-1' };
  const EC = { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Halbrook' };

  function household(stored: Array<Record<string, string>>) {
    const docs: Record<string, any> = {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3': { displayName: 'The Foster', customFields: stored },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }
  async function save(data: Record<string, unknown>) {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    return saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'The Foster', ...data }, auth: { uid: 'u1' } } as any);
  }
  const stored = (docs: Record<string, any>) => docs['families/3'].customFields as Array<{ key: string; label: string; value: string }>;

  it('an OLD client sending only its schema rows no longer deletes a stored non-schema row', async () => {
    const { docs } = household([OFFICE, ALLERGY, VET]);
    await expect(save({ customFields: [{ ...ALLERGY, value: 'Beef' }, VET] })).resolves.toEqual({ ok: true });
    expect(stored(docs)).toEqual([OFFICE, { ...ALLERGY, value: 'Beef' }, VET]);
  });

  it('a NEW client (full list plus an empty removeCustomFieldKeys) keeps the non-schema row and its order', async () => {
    const { docs } = household([OFFICE, ALLERGY]);
    await expect(save({ customFields: [OFFICE, { ...ALLERGY, value: 'Beef' }], removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    expect(stored(docs)).toEqual([OFFICE, { ...ALLERGY, value: 'Beef' }]);
  });

  it("a cleared schema field really clears: a sent '' is stored as ''", async () => {
    const { docs } = household([OFFICE, ALLERGY]);
    await save({ customFields: [{ ...ALLERGY, value: '' }], removeCustomFieldKeys: [] });
    expect(stored(docs)).toEqual([OFFICE, { ...ALLERGY, value: '' }]);
  });

  it('a row named in removeCustomFieldKeys is removed, and nothing else is', async () => {
    const { docs } = household([OFFICE, VET, ALLERGY]);
    await save({ customFields: [], removeCustomFieldKeys: ['vetClinicId'] });
    expect(stored(docs)).toEqual([OFFICE, ALLERGY]);
  });

  it('removeCustomFieldKeys works without customFields', async () => {
    const { docs } = household([OFFICE, VET]);
    await save({ removeCustomFieldKeys: ['vetClinicId'] });
    expect(stored(docs)).toEqual([OFFICE]);
  });

  it('removeCustomFieldKeys cannot remove the stored Emergency Contact copy the #829 migration reads', async () => {
    const { docs } = household([OFFICE, EC]);
    await save({ customFields: [OFFICE], removeCustomFieldKeys: ['emergencyContactName'] });
    expect(stored(docs)).toEqual([OFFICE, EC]);
  });

  it('refuses a key that is both sent and named for removal, and writes nothing', async () => {
    const { ctx } = household([OFFICE, ALLERGY]);
    await expect(save({ customFields: [ALLERGY], removeCustomFieldKeys: ['allergy'] })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * #829: the `emergencyContact*` keys in `families/{id}.customFields` are a dead
 * store. Emergency Contacts live on the kinfolk record and are gated on
 * `home_access` inside `saveEmergencyContacts`. This callable strips the keys
 * from every payload, never writes a sent value into customFields, and carries a
 * stored copy through untouched until the migration moves it. A payload without
 * them (the new portal) is never judged over them. An old client's edit is
 * covered by the next describe.
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

  it('#829 old client, no Home access: a changed Emergency Contact in the payload is stripped, never written, not refused, and flagged', async () => {
    const ctx = household(SECONDARY_NO_HOME);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    const changed = STORED_EC.map((f) => (f.key === 'emergencyContactPhone' ? { ...f, value: '555-9999' } : f));
    await expect(
      saveTribeProfileHandler({ data: { kinfolkId: '3', customFields: changed }, auth: { uid: 'u2' } } as any),
    ).resolves.toEqual({ ok: true, emergencyContactIgnored: true });
    expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
    const fields = writtenFields(ctx);
    expect(valueOf(fields, 'emergencyContactPhone')).toBe('555-0100');
    expect(JSON.stringify(fields)).not.toContain('555-9999');
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

/**
 * #829, old clients. A cached portal web bundle, or portal Android on an old
 * install, still edits the Emergency Contact as emergencyContact* rows in
 * customFields. That edit must reach the real store or fail visibly, never
 * vanish under "Saved.":
 *   - Home access: applied to kinfolk.emergencyContacts slot 1 through the same
 *     validation saveEmergencyContacts uses, slot 2 kept. A refusal fails the call.
 *   - No Home access: the profile saves, the contact is untouched, and the reply
 *     carries emergencyContactIgnored.
 *   - An echo of what the client loaded (the families copy) or of what the store
 *     holds is a no-op, never an error.
 * The rows are stripped from customFields in every case.
 */
describe('saveTribeProfileHandler: an old client editing the Emergency Contact', () => {
  const T1 = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
  const T2 = Timestamp.fromDate(new Date('2026-02-01T00:00:00Z'));
  const K1 = { key: 'k1', label: 'Anniversary', value: 'Oct 14' };
  const PERMS = { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true };
  const MEMBERS = {
    primary: { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
    secondaryNoHome: { role: 'SECONDARY', status: 'ACTIVE', displayName: 'Sam Foster', permissions: { ...PERMS, home_access: false } },
    secondaryWithHome: { role: 'SECONDARY', status: 'ACTIVE', displayName: 'Sam Foster', permissions: { ...PERMS, home_access: true } },
  } as const;
  const KINFOLK = {
    firstName: 'Dana',
    lastName: 'Foster',
    phoneNumber: '(805) 555-0100',
    emergencyContacts: [
      { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: T1, updatedAt: T1 },
      { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: T2, updatedAt: T2 },
    ],
  };

  function oldClientHousehold(
    member: keyof typeof MEMBERS,
    familiesFields: Array<Record<string, string>> = [K1],
    kinfolk: Record<string, unknown> = KINFOLK,
  ) {
    return buildDbMock({
      docs: {
        'clients/u9': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'The Foster', customFields: familiesFields },
        'families/3/members/u9': MEMBERS[member],
        'kinfolk/3': kinfolk,
      },
      queryDocs: { 'families/3/members': [{ id: 'u9', data: MEMBERS[member] }] },
    });
  }

  const ec = (name: string, phone: string, relation?: string) => [
    { key: 'emergencyContactName', label: 'Emergency Contact', value: name },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: phone },
    ...(relation !== undefined ? [{ key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: relation }] : []),
  ];

  async function save(data: Record<string, unknown>) {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    return saveTribeProfileHandler({ data: { kinfolkId: '3', ...data }, auth: { uid: 'u9' } } as any);
  }

  it('a primary edit lands in kinfolk slot 1, slot 2 is kept, the rows are stripped, and the audit says PRIMARY', async () => {
    const ctx = oldClientHousehold('primary');
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ displayName: 'The Foster Tribe', customFields: [K1, ...ec('Sam Ortiz', '805-555-0111', 'Brother')] })).resolves.toEqual({ ok: true });

    const kin = ctx.writes.find((w) => w.path === 'kinfolk/3');
    const stored = kin?.data.emergencyContacts as Array<Record<string, any>>;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111', relationship: 'Brother' });
    expect(stored[1]).toMatchObject({ name: 'Lee Park', phone: '+18055550177', relationship: null });
    expect(stored[1]!.recordedAt).toEqual(T2);

    const fam = ctx.writes.find((w) => w.path === 'families/3');
    expect(fam?.data.displayName).toBe('The Foster Tribe');
    expect((fam?.data.customFields as Array<{ key: string }>).map((f) => f.key)).toEqual(['k1']);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRole: 'PRIMARY',
        payload: expect.objectContaining({ fields: expect.arrayContaining(['emergencyContacts']) }),
      }),
    );
  });

  it('only the slot being written is validated: a stored slot 2 with an invalid phone is carried through unchanged', async () => {
    const withBadSlot2 = {
      ...KINFOLK,
      emergencyContacts: [KINFOLK.emergencyContacts[0], { name: 'Lee Park', phone: 'ask the neighbour', relationship: null, recordedAt: T2, updatedAt: T2 }],
    };
    const ctx = oldClientHousehold('primary', [K1], withBadSlot2);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ customFields: [K1, ...ec('Sam Ortiz', '805-555-0111')] })).resolves.toEqual({ ok: true });
    const stored = ctx.writes.find((w) => w.path === 'kinfolk/3')?.data.emergencyContacts as Array<Record<string, any>>;
    expect(stored[0]).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111', relationship: null });
    expect(stored[1]).toMatchObject({ name: 'Lee Park', phone: 'ask the neighbour', relationship: null });
    expect(stored[1]!.recordedAt).toEqual(T2);
  });

  it('a secondary with Home access edits it the same way, audited as SECONDARY', async () => {
    const ctx = oldClientHousehold('secondaryWithHome');
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ customFields: ec('Kim Lee', '8055550122') })).resolves.toEqual({ ok: true });
    const stored = ctx.writes.find((w) => w.path === 'kinfolk/3')?.data.emergencyContacts as Array<Record<string, any>>;
    expect(stored[0]).toMatchObject({ name: 'Kim Lee', phone: '+18055550122', relationship: null });
    expect(stored[1]).toMatchObject({ name: 'Lee Park' });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'SECONDARY' }));
  });

  it('a secondary without Home access: the profile saves, the contact is untouched, and the reply says it was ignored', async () => {
    const ctx = oldClientHousehold('secondaryNoHome');
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ displayName: 'The Foster Tribe', customFields: [K1, ...ec('Kim Lee', '8055550122')] })).resolves.toEqual({
      ok: true,
      emergencyContactIgnored: true,
    });
    expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
    const fam = ctx.writes.find((w) => w.path === 'families/3');
    expect(fam?.data.displayName).toBe('The Foster Tribe');
    expect(JSON.stringify(fam?.data.customFields)).not.toContain('Kim Lee');
  });

  it('an echo of the families copy the old client loaded is a no-op, even when it differs from the store', async () => {
    const loaded = ec('Rae Halbrook', '(805) 555-0133');
    const ctx = oldClientHousehold('primary', [K1, ...loaded]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ displayName: 'The Foster Tribe', customFields: [K1, ...loaded] })).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'families/3')?.data.displayName).toBe('The Foster Tribe');
  });

  it('an echo of the stored slot 1, spelled differently, is a no-op and never flagged, even without Home access', async () => {
    const ctx = oldClientHousehold('secondaryNoHome');
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ customFields: [K1, ...ec(' rae  MERCER', '(805) 555-0199', 'Sister')] })).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
  });

  it('a validation refusal fails the whole call with the message new clients show, and writes nothing', async () => {
    const ctx = oldClientHousehold('primary');
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(save({ displayName: 'The Foster Tribe', customFields: [K1, ...ec('Sam Ortiz', '+1 805 555 0100')] })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
    await expect(save({ customFields: [K1, ...ec('Sam Ortiz', '12')] })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('That phone number is not a valid number.'),
    });
    await expect(save({ customFields: [K1, ...ec('Sam Ortiz', '+18055550177')] })).rejects.toMatchObject({
      message: 'The two Emergency Contacts need different phone numbers.',
    });
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * #829, what this caller was served. saveTribeProfile cannot see what an old
 * client loaded, and a client-carried token cannot survive old web (which shows
 * unreserved rows as fields) or Android (which rebuilds rows from schema keys).
 * So getMyTribeProfile records, server-side, a key for each contact it served
 * each uid, and a sent contact matching any of them is an echo. These run both
 * callables against one write-through store, in the order a household lives it.
 */
describe('saveTribeProfileHandler: what this caller was served decides an echo', () => {
  type Contact = { name: string; phone: string; relationship: string | null };
  const A: Contact = { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' };
  const B: Contact = { name: 'Lee Park', phone: '+18055550177', relationship: null };
  const C: Contact = { name: 'Sam Ortiz', phone: '805-555-0111', relationship: 'Brother' };
  const K1 = { key: 'k1', label: 'Anniversary', value: 'Oct 14' };
  const PERMS = { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true };
  const MEMBERS = {
    primary: { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
    secondaryNoHome: { role: 'SECONDARY', status: 'ACTIVE', displayName: 'Sam Foster', permissions: { ...PERMS, home_access: false } },
  } as const;

  const slot = (c: Contact) => ({ ...c, recordedAt: null, updatedAt: null });
  const rows = (c: Contact) => [
    { key: 'emergencyContactName', label: 'Emergency Contact', value: c.name },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: c.phone },
    ...(c.relationship ? [{ key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: c.relationship }] : []),
  ];

  function household(member: keyof typeof MEMBERS) {
    const docs: Record<string, any> = {
      'clients/u9': { kinfolkIds: ['3'] },
      'families/3': { displayName: 'The Foster', customFields: [K1] },
      'families/3/members/u9': MEMBERS[member],
      'kinfolk/3': { firstName: 'Dana', lastName: 'Foster', phoneNumber: '(805) 555-0100', emergencyContacts: [slot(A)] },
    };
    const ctx = buildDbMock({ docs, writeThrough: true, queryDocs: { 'families/3/members': [{ id: 'u9', data: MEMBERS[member] }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }

  /** An old client opening the Tribe screen. */
  async function load() {
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    return getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u9' } } as any);
  }
  /** The office changing slot 1 in the admin, outside this caller's view. */
  function officeSets(docs: Record<string, any>, c: Contact) {
    docs['kinfolk/3'] = { ...docs['kinfolk/3'], emergencyContacts: [slot(c)] };
  }
  async function save(customFields: Array<{ key: string; label: string; value: string }>) {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    return saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'The Foster Tribe', customFields }, auth: { uid: 'u9' } } as any);
  }
  async function events() {
    const { logEvent } = await import('../src/lib/logger');
    return vi.mocked(logEvent).mock.calls.map((c) => c[0] as { severity: string; event: string; function?: string; extra?: Record<string, unknown> });
  }
  const slot1Name = (docs: Record<string, any>) => (docs['kinfolk/3'].emergencyContacts as Array<{ name: string }>)[0]?.name;

  beforeEach(async () => {
    const { logEvent } = await import('../src/lib/logger');
    vi.mocked(logEvent).mockClear();
  });

  it.each(['primary', 'secondaryNoHome'] as const)(
    '%s: loaded A, the office set B, an untouched save re-sends A: slot 1 stays B, no warn, not flagged',
    async (member) => {
      const { ctx, docs } = household(member);
      await load();
      officeSets(docs, B);
      await expect(save([K1, ...rows(A)])).resolves.toEqual({ ok: true });
      expect(slot1Name(docs)).toBe('Lee Park');
      expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
      expect(docs['families/3'].displayName).toBe('The Foster Tribe');
      const logged = await events();
      expect(logged.filter((e) => e.severity === 'warn')).toEqual([]);
      expect(logged.find((e) => e.event === 'portal.tribe.emergency_contact_keys.stripped')?.extra).toMatchObject({ outcome: 'echo' });
    },
  );

  it('two devices: served A, then B to the same uid, and the stale device re-sends A: still an echo', async () => {
    const { ctx, docs } = household('primary');
    await load();
    officeSets(docs, B);
    await load();
    await expect(save([K1, ...rows(A)])).resolves.toEqual({ ok: true });
    expect(slot1Name(docs)).toBe('Lee Park');
    expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
  });

  it('a real edit to C is still applied, logged as the callable logs a save, with kinfolk in the audit targets', async () => {
    const { docs } = household('primary');
    await load();
    await expect(save([K1, ...rows(C)])).resolves.toEqual({ ok: true });
    expect(docs['kinfolk/3'].emergencyContacts[0]).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111', relationship: 'Brother' });
    const logged = await events();
    expect(logged.find((e) => e.event === 'kinfolk.emergencyContacts.saved')).toMatchObject({
      severity: 'info',
      extra: expect.objectContaining({ kinfolkId: '3', count: 1 }),
    });
    expect(JSON.stringify(logged)).not.toContain('Sam Ortiz');
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          targets: expect.arrayContaining([
            { collection: 'families', id: '3' },
            { collection: 'kinfolk', id: '3' },
          ]),
        }),
      }),
    );
  });

  it.each([true, false])(
    'sent no rows (served a contact first: %s): the contact is kept, the rest saves, and nothing about it is logged',
    async (servedFirst) => {
      const { ctx, docs } = household('primary');
      if (servedFirst) await load();
      await expect(save([K1])).resolves.toEqual({ ok: true });
      expect(slot1Name(docs)).toBe('Rae Mercer');
      expect(ctx.writes.find((w) => w.path === 'kinfolk/3')).toBeUndefined();
      expect(docs['families/3'].displayName).toBe('The Foster Tribe');
      const logged = await events();
      // A new client never sends these rows, so any event here would fire on every save.
      expect(logged.filter((e) => /emergency_contact|emergencyContacts/.test(e.event))).toEqual([]);
      expect(logged.filter((e) => e.severity === 'warn')).toEqual([]);
    },
  );
});

/**
 * #873 review. The request schema capped rows at 40 and required a label, but
 * current clients send every stored row back and getMyTribeProfile serves a
 * missing label as '', so one big or unlabeled household could never save
 * again. And the read-merge-write was not a transaction, so two devices saving
 * at once dropped each other's rows.
 */
describe('saveTribeProfileHandler: limits and concurrent saves (#873 review)', () => {
  const ALLERGY = { key: 'allergy', label: 'Allergies', value: 'Chicken' };
  const OFFICE = { key: 'gateNote', label: 'Set by Auntie', value: 'Side gate sticks' };
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `field${i}`, label: `Field ${i}`, value: `v${i}` }));

  function household(stored: unknown[], extra: Record<string, any> = {}) {
    const docs: Record<string, any> = {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3': { displayName: 'The Foster', customFields: stored },
      ...extra,
    };
    const ctx = buildDbMock({ docs, writeThrough: true, queryDocs: { 'families/3/members': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }
  async function save(data: Record<string, unknown>) {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    return saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'The Foster', ...data }, auth: { uid: 'u1' } } as any);
  }
  const storedList = (docs: Record<string, any>) => docs['families/3'].customFields as unknown[];

  it('a household with 60 stored rows saves when a current client sends every row back', async () => {
    const sixty = rowsOf(60);
    const { docs } = household(sixty);
    const sent = sixty.map((r, i) => (i === 59 ? { ...r, value: 'edited' } : r));
    await expect(save({ customFields: sent, removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toHaveLength(60);
    expect(storedList(docs)[59]).toEqual({ ...sixty[59], value: 'edited' });
  });

  it("a stored row with an empty or missing label, echoed back as '', saves and keeps the stored label", async () => {
    const { docs } = household([{ key: 'legacyNote', value: 'Old' }, { key: 'blank', label: '', value: 'x' }, ALLERGY]);
    await expect(
      save({
        customFields: [
          { key: 'legacyNote', label: '', value: 'Old' },
          { key: 'blank', label: '', value: 'y' },
          { key: 'allergy', label: '', value: 'Beef' },
        ],
        removeCustomFieldKeys: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([
      { key: 'legacyNote', label: '', value: 'Old' },
      { key: 'blank', label: '', value: 'y' },
      { ...ALLERGY, value: 'Beef' },
    ]);
  });

  it('a NEW key with a blank label and a value is refused, and nothing is written', async () => {
    const { ctx } = household([ALLERGY]);
    await expect(save({ customFields: [ALLERGY, { key: 'pool', label: ' ', value: 'Heated' }] })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('pool'),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it("a NEW key with a blank label and an empty value is not refused, and writes no row", async () => {
    const { docs } = household([ALLERGY]);
    await expect(save({ customFields: [ALLERGY, { key: 'pool', label: '', value: '' }] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([ALLERGY]);
  });

  it('a 200-character label saves, because the form schema allows one', async () => {
    const { docs } = household([ALLERGY]);
    const long = { key: 'pool', label: 'L'.repeat(200), value: 'Heated' };
    await expect(save({ customFields: [ALLERGY, long] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([ALLERGY, long]);
  });

  it('a household already over 64 KiB still saves without growing, and cannot grow', async () => {
    const big = Array.from({ length: 70 }, (_, i) => ({ key: `k${i}`, label: 'L', value: 'x'.repeat(1000) }));
    const { ctx, docs } = household(big);
    await expect(save({ customFields: [...big, { key: 'pool', label: 'Pool', value: 'Heated' }] })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
    await expect(save({ customFields: big, removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    await expect(save({ customFields: big.map((r, i) => (i === 0 ? { ...r, value: 'y'.repeat(1000) } : r)) })).resolves.toEqual({ ok: true });
    await expect(save({ removeCustomFieldKeys: ['k1'] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toHaveLength(69);
  });

  it('RATE LIMIT: every save counts against this household in the profileSave bucket, 60 an hour', async () => {
    household([ALLERGY]);
    await expect(save({ customFields: [ALLERGY] })).resolves.toEqual({ ok: true });
    expect(mocks.enforceRateLimitFn).toHaveBeenCalledTimes(1);
    expect(mocks.enforceRateLimitFn).toHaveBeenCalledWith('profileSave', '3', 60, 3600);
  });

  it('RATE LIMIT: a refused save rejects with resource-exhausted and writes nothing', async () => {
    const { ctx } = household([ALLERGY]);
    const { HttpsError } = await import('firebase-functions/v2/https');
    mocks.enforceRateLimitFn.mockRejectedValueOnce(new HttpsError('resource-exhausted', 'Too many attempts. Try again later.'));
    await expect(save({ customFields: [{ ...ALLERGY, value: 'Beef' }] })).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('RATE LIMIT: a save with nothing to write spends no save', async () => {
    household([ALLERGY]);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(saveTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
    expect(mocks.enforceRateLimitFn).not.toHaveBeenCalled();
  });

  it('CONCURRENT: a row another device adds between this save reading and writing survives', async () => {
    const { ctx, docs } = household([OFFICE, ALLERGY]);
    const { installOptimisticTransactions } = await import('./_helpers/optimisticTransaction');
    const ANDROID = { key: 'pool', label: 'Pool', value: 'Heated' };
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== 'families/3' || attempt !== 1) return;
        docs['families/3'] = { ...docs['families/3'], customFields: [...docs['families/3'].customFields, ANDROID] };
      },
    });
    await expect(save({ customFields: [OFFICE, { ...ALLERGY, value: 'Beef' }], removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([OFFICE, { ...ALLERGY, value: 'Beef' }, ANDROID]);
    expect(tx.attempts()).toBe(2);
  });

  it("CONCURRENT: an old client's contact edit reads and writes inside the same transaction as the rows", async () => {
    const { ctx, docs } = household([ALLERGY], {
      'kinfolk/3': { firstName: 'Dana', lastName: 'Foster', phoneNumber: '(805) 555-0100', emergencyContacts: [] },
    });
    const { installOptimisticTransactions } = await import('./_helpers/optimisticTransaction');
    const ANDROID = { key: 'pool', label: 'Pool', value: 'Heated' };
    const kinfolkOnRetry: unknown[] = [];
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== 'kinfolk/3') return;
        if (attempt === 1 && docs['families/3'].customFields.length === 1) {
          // Another device adds a row while this save is between its reads and its commit.
          docs['families/3'] = { ...docs['families/3'], customFields: [...docs['families/3'].customFields, ANDROID] };
        }
        // #873 second review: attempt 1 must not have written the contact already.
        // A write made straight on the ref inside the callback lands here, and the
        // retry would then read it back as an echo and pass.
        if (attempt === 2) kinfolkOnRetry.push(docs['kinfolk/3'].emergencyContacts);
      },
    });
    await expect(
      save({
        customFields: [
          ALLERGY,
          { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Sam Ortiz' },
          { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '(805) 555-0111' },
        ],
      }),
    ).resolves.toEqual({ ok: true });
    expect(tx.attempts()).toBe(2);
    expect(kinfolkOnRetry.length).toBeGreaterThan(0);
    for (const seen of kinfolkOnRetry) expect(seen).toEqual([]);
    // Both writes went through the transaction, by the attempt that committed. A
    // contact write made after the commit is not in this list.
    expect(tx.committed()).toEqual(['kinfolk/3', 'families/3']);
    expect(docs['kinfolk/3'].emergencyContacts[0]).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111' });
    expect(storedList(docs)).toEqual([ALLERGY, ANDROID]);
    // #873 second review: Home access is checked once, before the transaction, not once per attempt.
    expect(mocks.hasKinfolkPermSpy).toHaveBeenCalledTimes(1);
  });

  it('PERMISSION: a new-client save with no contact rows never reads Home access', async () => {
    household([ALLERGY]);
    await expect(save({ customFields: [{ ...ALLERGY, value: 'Beef' }] })).resolves.toEqual({ ok: true });
    expect(mocks.hasKinfolkPermSpy).not.toHaveBeenCalled();
  });
});
