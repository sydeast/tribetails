import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

import {
  comparablePhone,
  householdClash,
  mergeEmergencyContacts,
  normaliseName,
  readStoredEmergencyContacts,
  recordedAtForLegacy,
  EMERGENCY_CONTACTS_TOO_MANY_MESSAGE,
  EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE,
  EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
  EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE,
  EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_REQUIRED_MESSAGE,
} from '../src/lib/emergencyContacts';
import {
  saveEmergencyContactsHandler,
  listEmergencyContactsHandler,
  refusalReason,
  REFUSAL_REASON_MAX,
} from '../src/portal/emergencyContacts';
import { maskPhoneDigits } from '../src/lib/maskPhoneDigits';

const NOW_ISO = '2026-09-14T15:00:00.000Z';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  mocks.writeAuditEntry.mockReset().mockResolvedValue('audit-1');
  delete process.env.AUNTIE_OPERATOR_UIDS;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

const PRIMARY_DOC = {
  firstName: 'Dana',
  lastName: 'Mercer',
  phoneNumber: '(805) 555-0100',
  secondaryPhone: '',
  updatedAt: '2026-03-02T10:00:00.000Z',
};

function household(opts: {
  caller?: { uid: string; member?: Record<string, unknown> | null };
  kinfolk?: Record<string, unknown>;
  members?: Array<{ id: string; data: Record<string, unknown> }>;
  people?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  const caller = opts.caller ?? { uid: 'primary-uid', member: { role: 'PRIMARY', status: 'ACTIVE' } };
  const members = opts.members ?? [];
  return buildDbMock({
    docs: {
      [`clients/${caller.uid}`]: { kinfolkIds: ['fam1'] },
      ...(caller.member ? { [`families/fam1/members/${caller.uid}`]: caller.member } : {}),
      ...Object.fromEntries(members.map((m) => [`families/fam1/members/${m.id}`, m.data])),
      'kinfolk/fam1': opts.kinfolk ?? PRIMARY_DOC,
    },
    queryDocs: { 'families/fam1/members': members, 'families/fam1/secondaryKinfolk': opts.people ?? [] },
  });
}

function call(data: unknown, uid = 'primary-uid', token: Record<string, unknown> = {}) {
  return { data, auth: { uid, token } } as never;
}

describe('emergencyContacts lib', () => {
  it('normaliseName ignores case and spacing', () => {
    expect(normaliseName('  Rae   MERCER ')).toBe('rae mercer');
  });

  it('comparablePhone matches formatted and E.164 spellings, and never throws on junk', () => {
    expect(comparablePhone('(805) 555-0199')).toBe(comparablePhone('+18055550199'));
    expect(comparablePhone('ext 12')).toBe('12');
    expect(comparablePhone('')).toBeNull();
  });

  it('householdClash finds a phone or a name that belongs to the household', () => {
    const who = { names: ['Dana Mercer', 'Sam  Mercer'], phones: ['805-555-0100'] };
    expect(householdClash([{ name: 'Rae', phone: '+18055550100', relationship: null }], who)).toBe(0);
    expect(householdClash([{ name: 'Rae', phone: '8055550199', relationship: null }, { name: 'sam mercer', phone: '8055550188', relationship: null }], who)).toBe(1);
    expect(householdClash([{ name: 'Rae', phone: '8055550199', relationship: null }], who)).toBe(-1);
  });

  it('merge keeps recordedAt for a known contact, and keeps updatedAt when nothing changed', () => {
    const then = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
    const now = Timestamp.fromDate(new Date(NOW_ISO));
    const existing = [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: then, updatedAt: then }];
    const [same] = mergeEmergencyContacts(existing, [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' }], now);
    expect(same.recordedAt).toEqual(then);
    expect(same.updatedAt).toEqual(then);
    const [edited] = mergeEmergencyContacts(existing, [{ name: 'Rae Mercer', phone: '+18055550199', relationship: null }], now);
    expect(edited.recordedAt).toEqual(then);
    expect(edited.updatedAt).toEqual(now);
    const [fresh] = mergeEmergencyContacts(existing, [{ name: 'Lee Park', phone: '+18055550177', relationship: null }], now);
    expect(fresh.recordedAt).toEqual(now);
  });

  it('reads the array first, then the flat triple as a legacy contact dated by updatedAt', () => {
    const legacy = readStoredEmergencyContacts({ ...PRIMARY_DOC, emergencyContactName: 'Rae Mercer', emergencyContactPhone: '805-555-0199', emergencyContactRelation: '' });
    expect(legacy.legacy).toBe(true);
    expect(legacy.contacts).toHaveLength(1);
    expect(legacy.contacts[0].relationship).toBeNull();
    expect(legacy.contacts[0].recordedAt?.toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(readStoredEmergencyContacts(PRIMARY_DOC)).toEqual({ contacts: [], legacy: false });
  });

  it('recordedAtForLegacy falls back from updatedAt to joinDate to null', () => {
    expect(recordedAtForLegacy({ updatedAt: '2026-03-02T10:00:00.000Z' }).source).toBe('updatedAt');
    expect(recordedAtForLegacy({ joinDate: '2025-11-20' }).source).toBe('joinDate');
    expect(recordedAtForLegacy({})).toEqual({ value: null, source: null });
  });
});

describe('saveEmergencyContactsHandler', () => {
  it('rejects unauth', async () => {
    await expect(saveEmergencyContactsHandler({ data: { contacts: [] }, auth: undefined } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REQUIRED: refuses an empty list with the spec message and writes nothing', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_REQUIRED_MESSAGE,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  // Operator ruling 2026-09-27 (Q2): one Emergency Contact per household.
  it('ONE: refuses a second contact with the shared message and writes nothing', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const c = (n: string, p: string) => ({ name: n, phone: p });
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [c('A', '8055550101'), c('B', '8055550102')] }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: EMERGENCY_CONTACTS_TOO_MANY_MESSAGE,
    });
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [c('A', '8055550101'), c('B', '8055550102'), c('C', '8055550103')] })),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: EMERGENCY_CONTACTS_TOO_MANY_MESSAGE });
    expect(ctx.writes).toHaveLength(0);
  });
  it('ONE: a household with two on file cannot save both back, and can save one of them', async () => {
    const t1 = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
    const t2 = Timestamp.fromDate(new Date('2026-02-01T00:00:00Z'));
    const ctx = household({
      kinfolk: {
        ...PRIMARY_DOC,
        emergencyContacts: [
          { name: 'Rae Mercer', phone: '+18055550199', relationship: null, recordedAt: t1, updatedAt: t1 },
          { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: t2, updatedAt: t2 },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae Mercer', phone: '+18055550199' }, { name: 'Lee Park', phone: '+18055550177' }] })),
    ).rejects.toMatchObject({ message: EMERGENCY_CONTACTS_TOO_MANY_MESSAGE });
    expect(ctx.writes).toHaveLength(0);
    // Removing one keeps the other's original date.
    await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Lee Park', phone: '+18055550177' }] }));
    const stored = ctx.writes[0].data.emergencyContacts as Array<{ name: string; recordedAt: Timestamp }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Lee Park');
    expect(stored[0].recordedAt).toEqual(t2);
  });
  it('STRICT: refuses an unknown key by name', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199', uid: 'x' }] })),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: /uid/ });
  });

  it('refuses a missing name and an invalid phone', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: '  ', phone: '8055550199' }] }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '12' }] }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  // #829 review: one wording, shown as-is by all five clients, so no field path
  // rides on the message and every limit says what it is.
  it('WORDING: each refusal is the exact shared message, with no field path suffix', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const refuse = (contacts: unknown[]) => saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts }));
    await expect(refuse([{ name: '  ', phone: '8055550199' }])).rejects.toMatchObject({ code: 'invalid-argument', message: EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE });
    await expect(refuse([{ name: 'Rae', phone: ' ' }])).rejects.toMatchObject({ message: EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE });
    await expect(refuse([{ name: 'R'.repeat(81), phone: '8055550199' }])).rejects.toMatchObject({ message: EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE });
    await expect(refuse([{ name: 'Rae', phone: '8'.repeat(33) }])).rejects.toMatchObject({ message: EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE });
    await expect(refuse([{ name: 'Rae', phone: '8055550199', relationship: 'S'.repeat(41) }])).rejects.toMatchObject({
      message: EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE,
    });
    for (const bad of [[{ name: '', phone: '8055550199' }], [{ name: 'Rae', phone: '12' }]]) {
      await expect(refuse(bad)).rejects.toSatisfy((e: { message: string }) => !e.message.includes('(contacts'));
    }
    expect(ctx.writes).toHaveLength(0);
  });

  it('WORDING: the messages read as sentences, the required one included', () => {
    expect(EMERGENCY_CONTACT_REQUIRED_MESSAGE).toBe('A household needs at least one Emergency Contact.');
    expect(EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE).toBe('An Emergency Contact needs a name.');
    expect(EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE).toBe('An Emergency Contact needs a phone number.');
    expect(EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE).toBe("An Emergency Contact's name can be at most 80 characters.");
    expect(EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE).toBe("An Emergency Contact's phone number can be at most 32 characters.");
    expect(EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE).toBe('A relationship can be at most 40 characters.');
    expect(EMERGENCY_CONTACTS_TOO_MANY_MESSAGE).toBe('A household can have only one Emergency Contact.');
  });

  it("OUTSIDE: refuses the primary's own phone, spelled differently", async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '+1 805 555 0100' }] }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it("OUTSIDE: refuses a secondary member's name, case and spacing ignored", async () => {
    const ctx = household({ members: [{ id: 'second-uid', data: { role: 'SECONDARY', status: 'ACTIVE', displayName: 'Sam Mercer', phone: '' } }] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: ' sam   MERCER', phone: '8055550177' }] }))).rejects.toMatchObject({
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
  });

  it('saves one: E.164 phone, empty relationship as null, dated now, never logging the phone', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: ' Rae Mercer ', phone: '(805) 555-0199', relationship: '' }] }));
    const write = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    const stored = write?.data.emergencyContacts as Array<Record<string, unknown>>;
    expect(stored.map((c) => c.name)).toEqual(['Rae Mercer']);
    expect(stored.map((c) => c.phone)).toEqual(['+18055550199']);
    expect(stored[0].relationship).toBeNull();
    expect((stored[0].recordedAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect(write?.data.updatedAt).toBe('__SERVER_TS__');
    expect(res.contacts[0]).toMatchObject({ name: 'Rae Mercer', recordedAt: NOW_ISO });
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('0199');
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('Rae');
  });
  it('GATE: a SECONDARY without home_access is denied and writes nothing', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: false } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'second-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('GATE: a SECONDARY with home_access may save', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: true } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'second-uid'));
    expect(res.contacts).toHaveLength(1);
  });

  it('GATE: staff with the admin claim may save on any household', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/fam1': PRIMARY_DOC }, queryDocs: { 'families/fam1/members': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'op-uid', { admin: true }));
    expect(res.contacts).toHaveLength(1);
  });
});

describe('listEmergencyContactsHandler', () => {
  it('projects the legacy flat triple, marks it legacy, and tells a primary it can edit', async () => {
    const ctx = household({ kinfolk: { ...PRIMARY_DOC, emergencyContactName: 'Rae Mercer', emergencyContactPhone: '805-555-0199' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }));
    expect(res).toMatchObject({ legacy: true, canEdit: true });
    expect(res.contacts[0]).toMatchObject({ name: 'Rae Mercer', phone: '805-555-0199', recordedAt: '2026-03-02T10:00:00.000Z' });
  });

  it('an ACTIVE SECONDARY without home_access reads, and cannot edit', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: {} } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }, 'second-uid'));
    expect(res).toEqual({ contacts: [], canEdit: false, legacy: false });
  });

  it('a member who is not ACTIVE is denied', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'REMOVED', permissions: { home_access: true } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }, 'second-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('saveEmergencyContactsHandler and secondary kinfolk (2026-09-27 Q3)', () => {
  // 2026-09-27 Q3: a secondary kinfolk with no portal account is a household
  // member (a person record), so they cannot be the Emergency Contact either.
  it("OUTSIDE: refuses a secondary kinfolk with no portal account, by name or phone", async () => {
    const ctx = household({ people: [{ id: 'p1', data: { name: 'Sam Lee', phone: '+18055550177', access: 'NONE' } }] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'sam  LEE', phone: '8055550199' }] }))).rejects.toMatchObject({
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '(805) 555-0177' }] }))).rejects.toMatchObject({
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
    expect(ctx.writes).toHaveLength(0);
  });
});

// #1049: a refused save is audited server side with the household, the caller and
// the refusal, on every client (portals included), so the operator can see a
// household that keeps failing to save its required Emergency Contact.
describe('saveEmergencyContactsHandler refusal audit (#1049)', () => {
  // Only this event: the access resolver writes its own OPERATOR_CROSSTENANT_ACCESS entry for staff.
  const refusals = () =>
    mocks.writeAuditEntry.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((e) => e['event'] === 'EMERGENCY_CONTACT_SAVE_REFUSED');

  it('audits a household-member refusal with the household, the caller, the code and the message', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '+1 805 555 0100' }] }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(refusals()).toEqual([
      {
        status: 'FAILURE',
        event: 'EMERGENCY_CONTACT_SAVE_REFUSED',
        severity: 'warn',
        actorRole: 'PRIMARY',
        actorUid: 'primary-uid',
        targetUid: 'fam1',
        targetCollection: 'kinfolk',
        familyId: 'fam1',
        description: `Emergency Contact not saved: ${EMERGENCY_CONTACT_OUTSIDE_MESSAGE}`,
        payload: { kinfolkId: 'fam1', code: 'failed-precondition', reason: EMERGENCY_CONTACT_OUTSIDE_MESSAGE },
      },
    ]);
  });

  it('audits an empty list, the refusal that leaves a household with no Emergency Contact', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]['payload']).toEqual({ kinfolkId: 'fam1', code: 'failed-precondition', reason: EMERGENCY_CONTACT_REQUIRED_MESSAGE });
  });

  it('audits a contact that fails to parse, and never writes the name or the phone that was sent', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae Mercer', phone: '805-555-01' }] }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199', uid: 'x' }] }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(refusals()).toHaveLength(2);
    expect(refusals().every((r) => r['targetUid'] === 'fam1' && r['event'] === 'EMERGENCY_CONTACT_SAVE_REFUSED')).toBe(true);
    const written = JSON.stringify(refusals());
    expect(written).not.toContain('Rae');
    expect(written).not.toMatch(/555/);
  });

  it('names a SECONDARY with Home access as SECONDARY', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: true } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }, 'second-uid'))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(refusals()[0]).toMatchObject({ actorRole: 'SECONDARY', actorUid: 'second-uid' });
  });

  it('names staff as AUNTIE', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/fam1': PRIMARY_DOC }, queryDocs: { 'families/fam1/members': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }, 'op-uid', { admin: true }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({ actorRole: 'AUNTIE', actorUid: 'op-uid', targetUid: 'fam1' });
  });
  it('a household deleted before the call is refused by the access check, which is not a contact refusal', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] } }, queryDocs: { 'families/gone/members': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'gone', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'op-uid', { admin: true })),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(refusals()).toHaveLength(0);
  });
  it('writes one entry per refused call: two presses of Save are two entries', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const press = () => saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }));
    await expect(press()).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(press()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(refusals()).toHaveLength(2);
  });

  it('writes nothing for a save that succeeds', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }));
    expect(refusals()).toHaveLength(0);
  });

  it('writes nothing for a caller refused Home access: that is permission-denied, not a refused contact', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: false } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }, 'second-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(refusals()).toHaveLength(0);
  });

  it('a caller with no access sending a bad payload still gets the parse error, and nothing is audited', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: '', phone: '8055550199' }] }, 'stranger-uid')),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE });
    expect(refusals()).toHaveLength(0);
  });

  it('a kinfolkId that is not a string names no household: the parse error, and no audit', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 7, contacts: [] }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(refusals()).toHaveLength(0);
  });

  it('a failed audit write never replaces the refusal the caller sees', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.writeAuditEntry.mockRejectedValueOnce(new Error('chain head busy'));
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_REQUIRED_MESSAGE,
    });
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.write.failed', extra: { kinfolkId: 'fam1' } }));
  });

  it('refusalReason masks phone-shaped digits and caps the length', () => {
    expect(refusalReason('That is (805) 555-0143, the primary.')).toBe('That is …0143, the primary.');
    expect(refusalReason("An Emergency Contact's name can be at most 80 characters.")).toBe("An Emergency Contact's name can be at most 80 characters.");
    const long = refusalReason('x'.repeat(REFUSAL_REASON_MAX + 50));
    expect(long).toHaveLength(REFUSAL_REASON_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('maskPhoneDigits masks E.164, dotted and plain runs of 7 or more digits, and leaves short numbers', () => {
    expect(maskPhoneDigits('+18055550143')).toBe('…0143');
    expect(maskPhoneDigits('call 805.555.0143 now')).toBe('call …0143 now');
    expect(maskPhoneDigits('5550143')).toBe('…0143');
    expect(maskPhoneDigits('at most 32 characters, max 1')).toBe('at most 32 characters, max 1');
    expect(maskPhoneDigits('')).toBe('');
  });
});
