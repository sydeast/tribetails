import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const HOME_ACCESS_DOC = {
  gateCode: '1234',
  keyLocation: 'Under frog',
  wifiPassword: 'TribeNet_5G',
  customFields: [{ key: 'h1', label: 'Alarm Code', value: '5678' }],
  updatedAt: Timestamp.fromMillis(1_700_000_000_000),
};

const FAMILY_DOC = {
  displayName: 'The Foster',
  customFields: [{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }],
};

const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
    home_access: false,
  },
};

const HOME_ACCESS_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
    home_access: true,
  },
};

const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };

describe('getMyTribeProfileHandler', () => {
  it('rejects unauth', async () => {
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    await expect(getMyTribeProfileHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns profile + homeAccess + customFields (legacy: no member doc)', async () => {
    // No member doc -> legacy primary -> hasKinfolkPerm returns true -> secrets visible
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.profile.displayName).toBe('The Foster');
    expect(res.profile.customFields).toHaveLength(1);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.updatedAtMs).toBe(1_700_000_000_000);
    expect(res.homeAccess.customFields[0].label).toBe('Alarm Code');
  });

  it('handles missing homeAccess doc (legacy primary)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'X' },
        'families/3/homeAccess/current': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
  });

  // --- home_access read-gating ---

  it('REDACTS homeAccess secrets for a kintales_only secondary (home_access=false)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u2': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u2' } } as any);
    // Profile still returned normally
    expect(res.profile.displayName).toBe('The Foster');
    // homeAccess secrets are all null/empty — not leaked
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.keyLocation).toBeNull();
    expect(res.homeAccess.wifiPassword).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
    expect(res.homeAccess.updatedAtMs).toBeNull();
  });

  // #868: the portal clients hide the home details off canEditHomeDetails, so
  // the values themselves must never be in the response for them to hide.
  it('#868: no home access value appears anywhere in the response for a secondary without Home access', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u2': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u2' } } as any);
    const wire = JSON.stringify(res);
    for (const secret of ['1234', 'Under frog', 'TribeNet_5G', 'Alarm Code', '5678']) {
      expect(wire).not.toContain(secret);
    }
    expect(res.canEditHomeDetails).toBe(false);
  });

  it('EXPOSES homeAccess secrets for a home_access=true secondary', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u3': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u3': HOME_ACCESS_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u3' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.keyLocation).toBe('Under frog');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
    expect(res.homeAccess.customFields).toHaveLength(1);
    expect(res.homeAccess.updatedAtMs).toBe(1_700_000_000_000);
  });

  it('EXPOSES homeAccess secrets for a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u4': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u4': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u4' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
  });

  it('EXPOSES homeAccess secrets for an operator (bypass)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        // RULING O-6 hardening 1: staff branch existence-checks kinfolk/{id}.
        'kinfolk/3': { firstName: 'Test' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'op-uid' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
    expect(res.homeAccess.keyLocation).toBe('Under frog');
  });

  it('REDACTS homeAccess but returns profile intact (non-home_access secondary, missing homeAccess doc)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u5': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': null,
        'families/3/members/u5': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u5' } } as any);
    expect(res.profile.displayName).toBe('The Foster');
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
  });

  // #843: the portal disables the Emergency Contact inputs off this flag, the
  // same permission saveTribeProfile now enforces on those keys.
  it('tells a secondary without home_access they cannot edit home details', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u5': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u5': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u5' } } as any);
    expect(res.canEditHomeDetails).toBe(false);
  });

  it('tells a secondary with home_access, and a primary, they can edit home details', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u6': { kinfolkIds: ['3'] },
        'clients/u7': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u6': HOME_ACCESS_MEMBER,
        'families/3/members/u7': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const secondary = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u6' } } as any);
    const primary = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u7' } } as any);
    expect(secondary.canEditHomeDetails).toBe(true);
    expect(primary.canEditHomeDetails).toBe(true);
  });
});

/**
 * #829, old clients. Portal Android before Task 10 and cached portal web bundles
 * show and re-send the Emergency Contact as emergencyContact* rows in
 * profile.customFields. Those rows now come from kinfolk.emergencyContacts slot 1,
 * the real store, so an old client shows the current contact and its echo on
 * save matches slot 1. The families copy is served only until the migration has
 * given the kinfolk a contact.
 */
describe('getMyTribeProfileHandler: legacy Emergency Contact rows for old clients', () => {
  const STALE_FAMILIES_EC = [
    { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
    { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Old Name' },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0133' },
    { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: 'Neighbour' },
  ];

  async function profileFor(docs: Record<string, unknown>) {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/members/u1': PRIMARY_MEMBER, ...docs } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    return getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
  }

  it('serves kinfolk slot 1 as the legacy rows, overriding a different families copy, and keeps every other field', async () => {
    const res = await profileFor({
      'families/3': { displayName: 'The Foster', customFields: STALE_FAMILIES_EC },
      'kinfolk/3': {
        firstName: 'Dana',
        emergencyContacts: [
          { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: null, updatedAt: null },
          { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null },
        ],
      },
    });
    expect(res.profile.customFields).toEqual([
      { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
      { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Mercer' },
      { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '+18055550199' },
      { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: 'Sister' },
    ]);
  });

  it('a slot 1 with no relationship serves no relation row, even when the families copy had one', async () => {
    const res = await profileFor({
      'families/3': { displayName: 'The Foster', customFields: STALE_FAMILIES_EC },
      'kinfolk/3': { emergencyContacts: [{ name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null }] },
    });
    expect(res.profile.customFields.map((f) => f.key)).toEqual(['k1', 'emergencyContactName', 'emergencyContactPhone']);
    expect(JSON.stringify(res.profile.customFields)).not.toContain('Neighbour');
  });

  it('with no kinfolk contacts yet (not migrated), serves the families copy as stored', async () => {
    const res = await profileFor({
      'families/3': { displayName: 'The Foster', customFields: STALE_FAMILIES_EC },
      'kinfolk/3': { firstName: 'Dana' },
    });
    expect(res.profile.customFields).toEqual(STALE_FAMILIES_EC);
  });

  it('with neither a kinfolk contact nor a families copy, serves no Emergency Contact rows', async () => {
    const res = await profileFor({ 'families/3': FAMILY_DOC, 'kinfolk/3': { firstName: 'Dana' } });
    expect(res.profile.customFields.map((f) => f.key)).toEqual(['k1']);
  });

  // Same read rule as listEmergencyContacts: any ACTIVE member reads, a member
  // who is not ACTIVE does not. Only the Emergency Contact rows follow it.
  const WITH_BOTH_COPIES = {
    'families/3': { displayName: 'The Foster', customFields: STALE_FAMILIES_EC },
    'families/3/homeAccess/current': HOME_ACCESS_DOC,
    'kinfolk/3': {
      firstName: 'Dana',
      emergencyContacts: [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: null, updatedAt: null }],
    },
  };

  async function profileAs(member: Record<string, unknown>, extraDocs: Record<string, unknown> = WITH_BOTH_COPIES) {
    const ctx = buildDbMock({ docs: { 'clients/u8': { kinfolkIds: ['3'] }, 'families/3/members/u8': member, ...extraDocs } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    return getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u8' } } as any);
  }

  it('a member who is not ACTIVE gets no Emergency Contact rows, slot 1 or families copy, and the rest of the profile unchanged', async () => {
    const suspended = { ...KINTALES_ONLY_MEMBER, status: 'SUSPENDED' };
    const res = await profileAs(suspended);
    expect(res.profile.customFields).toEqual([{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }]);
    expect(JSON.stringify(res)).not.toContain('Rae Mercer');
    expect(JSON.stringify(res)).not.toContain('Old Name');

    // Everything else matches what the same member got with no contact on file at all.
    const baseline = await profileAs(suspended, {
      'families/3': { displayName: 'The Foster', customFields: [{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }] },
      'families/3/homeAccess/current': HOME_ACCESS_DOC,
      'kinfolk/3': { firstName: 'Dana' },
    });
    expect(res).toEqual(baseline);
  });

  it('an ACTIVE secondary without Home access still gets the rows: reading is open to any member', async () => {
    const res = await profileAs(KINTALES_ONLY_MEMBER);
    expect(res.canEditHomeDetails).toBe(false);
    expect(res.profile.customFields.find((f) => f.key === 'emergencyContactName')?.value).toBe('Rae Mercer');
    expect(res.profile.customFields.find((f) => f.key === 'emergencyContactPhone')?.value).toBe('+18055550199');
  });
});

/**
 * #829: families/{fid}/legacyEcServed/{uid} is the server-only record of which
 * contact each caller was served, so saveTribeProfile can recognise an old
 * client's echo of something it loaded before the office changed slot 1. It
 * holds one-way keys, never a name or phone, and is never part of the response.
 */
describe('getMyTribeProfileHandler: the record of what each caller was served', () => {
  type Contact = { name: string; phone: string; relationship: string | null };
  const contact = (name: string, phone: string): Contact => ({ name, phone, relationship: null });
  const SERVED_PATH = 'families/3/legacyEcServed/u1';

  function household(opts: { member?: Record<string, unknown>; slot1?: Contact | null; familiesFields?: Array<Record<string, string>> } = {}) {
    const docs: Record<string, any> = {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3/members/u1': opts.member ?? PRIMARY_MEMBER,
      'families/3': { displayName: 'The Foster', customFields: opts.familiesFields ?? [{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }] },
      'kinfolk/3': {
        firstName: 'Dana',
        ...(opts.slot1 ? { emergencyContacts: [{ ...opts.slot1, recordedAt: null, updatedAt: null }] } : {}),
      },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }
  async function load() {
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    return getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
  }
  const servedKeys = (docs: Record<string, any>) => ((docs[SERVED_PATH]?.served ?? []) as Array<{ key: string }>).map((s) => s.key);

  it('records a key for the served contact, writes only when it changes, keeps the last three, and never returns it', async () => {
    const { legacyServedKey } = await import('../src/lib/emergencyContacts');
    const A = contact('Rae Mercer', '+18055550199');
    const { ctx, docs } = household({ slot1: A });

    const first = await load();
    await load();
    expect(servedKeys(docs)).toEqual([legacyServedKey(A)]);
    expect(ctx.writes.filter((w) => w.path === SERVED_PATH)).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('legacyEcServed');
    expect(JSON.stringify(first)).not.toContain(legacyServedKey(A));
    expect(JSON.stringify(docs[SERVED_PATH])).not.toContain('Rae');
    expect(JSON.stringify(docs[SERVED_PATH])).not.toContain('0199');

    const later = ['Lee Park', 'Sam Ortiz', 'Kim Lee'].map((n, i) => contact(n, `+1805555012${i}`));
    for (const c of later) {
      docs['kinfolk/3'] = { firstName: 'Dana', emergencyContacts: [{ ...c, recordedAt: null, updatedAt: null }] };
      await load();
    }
    expect(servedKeys(docs)).toEqual(later.map(legacyServedKey));
    expect(ctx.writes.filter((w) => w.path === SERVED_PATH)).toHaveLength(4);
  });

  it('two reads with an unchanged contact make one write: a client reloading the screen adds nothing', async () => {
    const { ctx, docs } = household({ slot1: contact('Rae Mercer', '+18055550199') });
    await load();
    await load();
    expect(ctx.writes.filter((w) => w.path === SERVED_PATH)).toHaveLength(1);
    // The same contact in another spelling is the same served value: still no second write.
    docs['kinfolk/3'] = {
      firstName: 'Dana',
      emergencyContacts: [{ name: ' rae  MERCER', phone: '(805) 555-0199', relationship: null, recordedAt: null, updatedAt: null }],
    };
    await load();
    expect(ctx.writes.filter((w) => w.path === SERVED_PATH)).toHaveLength(1);
  });

  it('records the families copy when that is what was served (not migrated yet)', async () => {
    const { legacyServedKey } = await import('../src/lib/emergencyContacts');
    const { docs } = household({
      familiesFields: [
        { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Old Name' },
        { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0133' },
      ],
    });
    await load();
    expect(servedKeys(docs)).toEqual([legacyServedKey(contact('Old Name', '555-0133'))]);
  });

  // #829 review: the served record is bookkeeping for old clients. A failure to
  // write it must never cost a household its profile.
  it('still returns the profile when writing the served record fails, and logs the failure', async () => {
    const { ctx } = household({ slot1: contact('Rae Mercer', '+18055550199') });
    const realDoc = ctx.db.doc.bind(ctx.db);
    ctx.db.doc = ((path: string) => {
      const ref = realDoc(path);
      if (path !== SERVED_PATH) return ref;
      return { ...ref, get: () => Promise.reject(new Error('deadline exceeded')), set: () => Promise.reject(new Error('deadline exceeded')) };
    }) as typeof ctx.db.doc;
    const { logEvent } = await import('../src/lib/logger');
    vi.mocked(logEvent).mockClear();

    const res = await load();
    expect(res.profile.displayName).toBe('The Foster');
    expect(res.profile.customFields.find((f) => f.key === 'emergencyContactName')?.value).toBe('Rae Mercer');
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(expect.objectContaining({ event: 'portal.tribe.legacyServedFailed' }));
  });

  it('records nothing for staff: an operator is never an old portal client', async () => {
    const { ctx, docs } = household({ slot1: contact('Rae Mercer', '+18055550199') });
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1', token: { admin: true } } } as any);
    expect(res.profile.displayName).toBe('The Foster');
    expect(docs[SERVED_PATH]).toBeUndefined();
    expect(ctx.writes.find((w) => w.path.includes('legacyEcServed'))).toBeUndefined();

    process.env.AUNTIE_OPERATOR_UIDS = 'u1';
    await load();
    expect(ctx.writes.find((w) => w.path.includes('legacyEcServed'))).toBeUndefined();
  });

  it('records nothing when no contact was served, or for a member who is not ACTIVE', async () => {
    const none = household();
    await load();
    expect(none.ctx.writes.find((w) => w.path === SERVED_PATH)).toBeUndefined();

    const suspended = household({ member: { ...KINTALES_ONLY_MEMBER, status: 'SUSPENDED' }, slot1: contact('Rae Mercer', '+18055550199') });
    await load();
    expect(suspended.ctx.writes.find((w) => w.path === SERVED_PATH)).toBeUndefined();
  });
});
