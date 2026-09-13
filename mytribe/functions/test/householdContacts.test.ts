import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * Household secondary contacts: the no-portal-account half of the operator's
 * 2026-09-12 ruling.
 *
 * The tests that matter most here are the REFUSALS. A contact callable that
 * quietly accepted `permissions` or `invitedEmail` would re-merge the two
 * concepts the ruling separates, and it would do it silently, because zod
 * strips unknown keys by default.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

/** A household whose primary is `primary-uid`, with no contacts yet. */
function primaryCtx(contacts: Array<{ id: string; data: Record<string, unknown> }> = []) {
  return buildDbMock({
    docs: {
      'clients/primary-uid': { kinfolkIds: ['fam1'] },
      'families/fam1/members/primary-uid': { role: 'PRIMARY', status: 'ACTIVE' },
      ...Object.fromEntries(contacts.map((c) => [`families/fam1/contacts/${c.id}`, c.data])),
    },
    queryDocs: { 'families/fam1/contacts': contacts },
  });
}

describe('saveHouseholdContactHandler', () => {
  it('rejects unauth', async () => {
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({ data: { name: 'Ada' }, auth: undefined } as never),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('THE WALL: refuses a permission set, naming the key, and writes nothing', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada', permissions: { billing_full: true } },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: /permissions/ });
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('THE WALL: refuses invitedEmail — an invite is a different callable', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada', invitedEmail: 'ada@example.com' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: /invitedEmail/ });
    expect(ctx.adds).toHaveLength(0);
  });

  it('THE WALL: refuses a role, so no contact can be minted as a member', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada', role: 'SECONDARY' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: /role/ });
  });

  it('creates a contact with NO email at all, and writes no inviteRequests row', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    const res = await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', name: 'Ada Rivera', label: 'Neighbour', phone: '805 555 0143' },
      auth: { uid: 'primary-uid' },
    } as never);

    expect(res.created).toBe(true);
    const wrote = ctx.adds.find((a) => a.collection === 'families/fam1/contacts');
    expect(wrote?.data).toMatchObject({
      name: 'Ada Rivera',
      label: 'Neighbour',
      phone: '805 555 0143',
      email: null,
      createdBy: 'primary-uid',
    });
    expect(wrote?.data).not.toHaveProperty('permissions');
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
  });

  it('an email on a contact is an address, not an invite: still no inviteRequests row', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', name: 'Ada', email: 'Ada@Example.COM' },
      auth: { uid: 'primary-uid' },
    } as never);
    const wrote = ctx.adds.find((a) => a.collection === 'families/fam1/contacts');
    expect(wrote?.data.email).toBe('ada@example.com');
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
  });

  it('defaults the label to Folk and refuses an empty name', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', name: 'Ada' },
      auth: { uid: 'primary-uid' },
    } as never);
    expect(ctx.adds[0]?.data.label).toBe('Folk');

    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: '   ' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a malformed email rather than storing it', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada', email: 'not-an-address' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.adds).toHaveLength(0);
  });

  it('EDIT IS A DIFF: sends every editable field plus updatedAt, and never resends createdAt', async () => {
    const ctx = primaryCtx([
      {
        id: 'c1',
        data: { name: 'Ada', label: 'Folk', phone: '805', email: null, createdAt: 'then', createdBy: 'someone-else' },
      },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    const res = await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', contactId: 'c1', name: 'Ada Rivera', label: 'Sister' },
      auth: { uid: 'primary-uid' },
    } as never);

    expect(res).toEqual({ contactId: 'c1', created: false });
    const write = ctx.writes.find((w) => w.path === 'families/fam1/contacts/c1');
    expect(write?.data).toEqual({
      name: 'Ada Rivera',
      label: 'Sister',
      // The caller sent neither: both clear, rather than silently keeping the
      // old value. A field that cannot be emptied is not editable.
      phone: null,
      email: null,
      updatedAt: '__SERVER_TS__',
      updatedBy: 'primary-uid',
    });
    expect(write?.data).not.toHaveProperty('createdAt');
    expect(write?.data).not.toHaveProperty('createdBy');
  });

  it('CLEARING STICKS: an empty phone persists as null', async () => {
    const ctx = primaryCtx([{ id: 'c1', data: { name: 'Ada', phone: '805 555 0143' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', contactId: 'c1', name: 'Ada', phone: '' },
      auth: { uid: 'primary-uid' },
    } as never);
    expect(ctx.writes[0]?.data.phone).toBeNull();
  });

  it('refuses to edit a contact that is not on the household', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', contactId: 'ghost', name: 'Ada' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('GATE: a stranger is denied and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada' },
        auth: { uid: 'stranger' },
      } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds).toHaveLength(0);
  });

  it('GATE: an ACTIVE SECONDARY of the same household is denied', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/second-uid': { kinfolkIds: ['fam1'] },
        'families/fam1/members/second-uid': { role: 'SECONDARY', status: 'ACTIVE' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      saveHouseholdContactHandler({
        data: { kinfolkId: 'fam1', name: 'Ada' },
        auth: { uid: 'second-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds).toHaveLength(0);
  });

  it('GATE: an operator with the admin claim may record a contact on any household', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/fam1': { firstName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHouseholdContactHandler } = await import('../src/portal/householdContacts');
    const res = await saveHouseholdContactHandler({
      data: { kinfolkId: 'fam1', name: 'Ada' },
      auth: { uid: 'op-uid', token: { admin: true } },
    } as never);
    expect(res.created).toBe(true);
    expect(ctx.adds[0]?.collection).toBe('families/fam1/contacts');
  });
});

describe('listHouseholdContactsHandler', () => {
  it('returns the rows by name, completing a half-written one rather than dropping it', async () => {
    const ctx = primaryCtx([
      { id: 'c2', data: { name: 'Zoe', label: 'Sister', phone: '805', email: 'z@x.com' } },
      { id: 'c1', data: { phone: '' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listHouseholdContactsHandler } = await import('../src/portal/householdContacts');
    const { contacts } = await listHouseholdContactsHandler({
      data: { kinfolkId: 'fam1' },
      auth: { uid: 'primary-uid' },
    } as never);

    expect(contacts.map((c) => c.contactId)).toEqual(['c1', 'c2']);
    expect(contacts[0]).toMatchObject({ name: '(unnamed contact)', label: 'Folk', phone: null });
    expect(contacts[1]).toMatchObject({ name: 'Zoe', label: 'Sister', email: 'z@x.com' });
  });

  it('carries no permission field on any row', async () => {
    const ctx = primaryCtx([{ id: 'c1', data: { name: 'Ada', permissions: { billing_full: true } } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listHouseholdContactsHandler } = await import('../src/portal/householdContacts');
    const { contacts } = await listHouseholdContactsHandler({
      data: { kinfolkId: 'fam1' },
      auth: { uid: 'primary-uid' },
    } as never);
    expect(contacts[0]).not.toHaveProperty('permissions');
  });

  it('GATE: a stranger is denied', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listHouseholdContactsHandler } = await import('../src/portal/householdContacts');
    await expect(
      listHouseholdContactsHandler({ data: { kinfolkId: 'fam1' }, auth: { uid: 'stranger' } } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('removeHouseholdContactHandler', () => {
  it('deletes the row outright — there is no account to suspend', async () => {
    const ctx = primaryCtx([{ id: 'c1', data: { name: 'Ada' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeHouseholdContactHandler } = await import('../src/portal/householdContacts');
    const res = await removeHouseholdContactHandler({
      data: { kinfolkId: 'fam1', contactId: 'c1' },
      auth: { uid: 'primary-uid' },
    } as never);
    expect(res).toEqual({ ok: true });
    expect(ctx.deletes).toContain('families/fam1/contacts/c1');
  });

  it('says so when the contact is already gone, instead of reporting a success', async () => {
    const ctx = primaryCtx();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      removeHouseholdContactHandler({
        data: { kinfolkId: 'fam1', contactId: 'ghost' },
        auth: { uid: 'primary-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.deletes).toHaveLength(0);
  });

  it('GATE: an ACTIVE SECONDARY cannot delete a contact', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/second-uid': { kinfolkIds: ['fam1'] },
        'families/fam1/members/second-uid': { role: 'SECONDARY', status: 'ACTIVE' },
        'families/fam1/contacts/c1': { name: 'Ada' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeHouseholdContactHandler } = await import('../src/portal/householdContacts');
    await expect(
      removeHouseholdContactHandler({
        data: { kinfolkId: 'fam1', contactId: 'c1' },
        auth: { uid: 'second-uid' },
      } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.deletes).toHaveLength(0);
  });
});
