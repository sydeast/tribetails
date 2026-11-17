import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUsers: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: () => ({ getUsers: mocks.getUsers }), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-id') }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUsers.mockReset().mockResolvedValue({ users: [], notFound: [] });
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset().mockResolvedValue('uid_kinfolk');
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

import { getKinTaleCommentsHandler } from '../src/portal/getKinTaleComments';
import { onKinTaleCommentCreateHandler } from '../src/triggers/onKinTaleCommentCreate';
import { listPublicComments, FAMILY_NAME, ANONYMOUS_GUEST_NAME } from '../src/share/sharedKinTaleComments';
import { renderComment } from '../src/share/getSharedKinTalePage';
import {
  HOUSEHOLD_MEMBER_FALLBACK,
  inAppAuthorName,
  nameOrNull,
  resolveHouseholdAuthors,
} from '../src/lib/kinTaleCommentAuthor';

/**
 * #1923. The fixtures here hold what PRODUCTION holds: a member record whose
 * `displayName` is the login's email, because that is what `acceptInvite` and
 * `primaryMemberRecord` write. #1371's fixtures held a real name in that field,
 * which is how a fix that printed the address passed its own tests.
 */
const PRIMARY_EMAIL = 'pawsome@hanasamku.com';
const SECONDARY_EMAIL = 'catch@hanasamku.com';
const STAFF_EMAIL = 'e2e-admin@tribetails.com';
/** A uid of the real shape: 28 letters and digits. */
const UID = 'k3Jx9QmP2rTz7LwYb4VnHs6DfA1c';

function req(data: unknown, uid = 'reader1', admin = true): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: admin ? ({ admin: true } as any) : ({} as any) },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

type Docs = Record<string, Record<string, unknown>>;
type Row = Record<string, unknown>;

/** The thread as the in-app callable returns it, for a staff reader. */
async function thread(docs: Docs, rows: Row[]) {
  const ctx = buildDbMock({
    docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' }, ...docs },
    queryDocs: {
      'kin_care_reports/t1/comments': rows.map((data, i) => ({ id: `c${i + 1}`, data: { createdAtMs: i + 1, body: 'hi', ...data } })),
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  const res = await getKinTaleCommentsHandler(req({ taleId: 't1' }));
  return { ctx, comments: res.comments, names: res.comments.map((c) => c['authorDisplayName']) };
}

const kin = (authorUid: string, extra: Row = {}): Row => ({ authorRole: 'kinfolk', authorUid, ...extra });

describe('nameOrNull: what may be printed as a name', () => {
  it('keeps a name and tidies its spacing', () => {
    expect(nameOrNull('  Dana   Ruiz ')).toBe('Dana Ruiz');
    expect(nameOrNull("O'Neil-Smith")).toBe("O'Neil-Smith");
  });
  it('refuses an email address', () => {
    expect(nameOrNull(PRIMARY_EMAIL)).toBeNull();
    expect(nameOrNull(` ${STAFF_EMAIL} `)).toBeNull();
  });
  it('refuses a stored id, by shape and by the ids the caller names', () => {
    expect(nameOrNull(UID)).toBeNull();
    expect(nameOrNull('4417', ['4417'])).toBeNull();
    expect(nameOrNull('Tribe 4417', ['4417'])).toBeNull();
    expect(nameOrNull('4417')).toBe('4417');
  });
  it('refuses blank and non-text values', () => {
    for (const v of ['', '   ', null, undefined, 7, {}]) expect(nameOrNull(v)).toBeNull();
  });
});

describe('getKinTaleComments names a household author (#1923)', () => {
  it('REGRESSION: a member record holding the sign-in email never names the author', async () => {
    const { comments, names } = await thread(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'clients/k1': { displayName: PRIMARY_EMAIL, kinfolkIds: ['f1'] },
      },
      [kin('k1')],
    );
    expect(names).toEqual([HOUSEHOLD_MEMBER_FALLBACK]);
    expect(JSON.stringify(comments)).not.toContain('@');
  });

  it('email on the member record, a real name on the account: the first name', async () => {
    const { names } = await thread(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'clients/k1': { displayName: 'Dana Ruiz' },
      },
      [kin('k1')],
    );
    expect(names).toEqual(['Dana']);
  });

  it('email in both records: the PRIMARY takes the household contact first name', async () => {
    const { comments, names } = await thread(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'clients/k1': { displayName: PRIMARY_EMAIL },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega', email: PRIMARY_EMAIL },
      },
      [kin('k1')],
    );
    expect(names).toEqual(['Casey']);
    expect(JSON.stringify(comments)).not.toContain('@');
  });

  it('a login from before member records is the primary: the household contact first name', async () => {
    const { names } = await thread({ 'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' } }, [kin('k1')]);
    expect(names).toEqual(['Casey']);
  });

  it('a SECONDARY with only an email is never signed as the primary: the household name', async () => {
    const { names } = await thread(
      {
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' },
        'families/f1': { displayName: 'The Ortega household' },
      },
      [kin('k2')],
    );
    expect(names).toEqual(['The Ortega household']);
  });

  it('a SECONDARY is named from the Secondary Kinfolk record linked to the login', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1' },
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' },
      },
      queryDocs: {
        'kin_care_reports/t1/comments': [{ id: 'c1', data: { ...kin('k2'), body: 'hi', createdAtMs: 1 } }],
        'families/f1/secondaryKinfolk': [
          { id: 'p1', data: { name: 'Someone Else', memberUid: 'other' } },
          { id: 'p2', data: { name: 'Robin Vale', memberUid: 'k2', email: SECONDARY_EMAIL } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ taleId: 't1' }));
    expect(res.comments.map((c) => c['authorDisplayName'])).toEqual(['Robin']);
  });

  it('no household name on the household record: the contact name stands in for it', async () => {
    const { names } = await thread(
      {
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' },
      },
      [kin('k2')],
    );
    expect(names).toEqual(['Casey Ortega']);
  });

  it('nothing on file: "A member of the household", never "Kinfolk", null or an id', async () => {
    const { comments, names } = await thread(
      {
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'families/f1': { displayName: 'Tribe f1' },
        'families/f1/members/k3': { displayName: UID, role: 'SECONDARY' },
      },
      [kin('k2'), kin('k3'), { authorRole: 'kinfolk' }],
    );
    expect(names).toEqual([HOUSEHOLD_MEMBER_FALLBACK, HOUSEHOLD_MEMBER_FALLBACK, HOUSEHOLD_MEMBER_FALLBACK]);
    expect(JSON.stringify(comments.map((c) => c['authorDisplayName']))).not.toMatch(/Kinfolk|@|Tribe f1/);
  });

  it('a comment with no author uid still takes the household name', async () => {
    const { names } = await thread({ 'families/f1': { displayName: 'The Ortega household' } }, [{ authorRole: 'kinfolk' }]);
    expect(names).toEqual(['The Ortega household']);
  });

  it('OLD COMMENT: a comment written before this fix is named on read, with no backfill', async () => {
    // The comment doc holds only what #1371-era code wrote; the records hold
    // the email the walk saw. The name comes from the profile, worked out now.
    mocks.getUsers.mockResolvedValue({ users: [{ uid: 'k1', displayName: 'Dana Ruiz' }], notFound: [] });
    const { comments, names } = await thread(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'clients/k1': { displayName: PRIMARY_EMAIL },
      },
      [kin('k1', { createdAt: 'old', body: 'from before' })],
    );
    expect(names).toEqual(['Dana']);
    expect(comments[0]).toMatchObject({ authorNameIsPerson: true, authorRole: 'kinfolk' });
    expect(JSON.stringify(comments)).not.toContain('@');
  });
  it('the sign-in profile is read only for authors the records leave unnamed', async () => {
    mocks.getUsers.mockResolvedValue({ users: [{ uid: 'k2', displayName: PRIMARY_EMAIL }], notFound: [] });
    const { names } = await thread(
      {
        'clients/k1': { displayName: 'Dana Ruiz' },
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'families/f1': { displayName: 'The Ortega household' },
      },
      [kin('k1'), kin('k2')],
    );
    expect(names).toEqual(['Dana', 'The Ortega household']);
    expect(mocks.getUsers).toHaveBeenCalledTimes(1);
    expect(mocks.getUsers).toHaveBeenCalledWith([{ uid: 'k2' }]);
  });
  it('a failed sign-in profile read still leaves the record names standing', async () => {
    mocks.getUsers.mockRejectedValue(new Error('unavailable'));
    const { names } = await thread(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' },
      },
      [kin('k1')],
    );
    expect(names).toEqual(['Casey']);
  });
  it('says whether the name is the person: a household name or the generic line is not', async () => {
    const { comments } = await thread(
      {
        'clients/k1': { displayName: 'Dana Ruiz' },
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'families/f1': { displayName: 'The Ortega household' },
      },
      [kin('k1'), kin('k2'), { authorRole: 'admin', authorUid: 'a9' }],
    );
    expect(comments.map((c) => c['authorNameIsPerson'])).toEqual([true, false, false]);
  });
  it('a guest note stored without a role is still returned as a guest', async () => {
    const { comments } = await thread({}, [{ authorUid: null, guestName: 'Grandma Rose' }]);
    expect(comments[0]).toMatchObject({ authorRole: 'guest', authorDisplayName: 'Grandma Rose', authorNameIsPerson: true });
  });
  it('ERROR: the record read throws, and the thread still loads with the generic line', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' } },
      queryDocs: {
        'kin_care_reports/t1/comments': [
          { id: 'c1', data: { ...kin('k1'), body: 'still here', createdAtMs: 1 } },
          { id: 'c2', data: { authorRole: 'admin', authorUid: 'a1', body: 'reply', createdAtMs: 2 } },
        ],
      },
    });
    ctx.db.getAll.mockRejectedValue(new Error('unavailable'));
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ taleId: 't1' }));
    expect(res.comments.map((c) => c['body'])).toEqual(['still here', 'reply']);
    expect(res.comments.map((c) => c['authorDisplayName'])).toEqual([HOUSEHOLD_MEMBER_FALLBACK, null]);
  });

  it('an Auntie whose staff name is an email is left for the client to call "Auntie"', async () => {
    const { comments, names } = await thread(
      { 'staff/a1': { displayName: STAFF_EMAIL }, 'staff/a2': { displayName: 'Maya' } },
      [
        { authorRole: 'admin', authorUid: 'a1' },
        { authorRole: 'admin', authorUid: 'a2' },
      ],
    );
    expect(names).toEqual([null, 'Maya']);
    expect(JSON.stringify(comments)).not.toContain('@');
  });

  it('a guest who typed an address as their name is returned unnamed, still as a guest', async () => {
    const { comments } = await thread({}, [
      { authorRole: 'guest', authorUid: null, guestName: SECONDARY_EMAIL },
      { authorRole: 'guest', authorUid: null, guestName: 'Grandma Rose' },
    ]);
    expect(comments[0]).toMatchObject({ authorRole: 'guest', guestName: null, authorDisplayName: null });
    expect(comments[1]).toMatchObject({ authorRole: 'guest', guestName: 'Grandma Rose', authorDisplayName: 'Grandma Rose' });
    expect(JSON.stringify(comments)).not.toContain('@');
  });

  it('reads the records once for a thread, however many comments one person wrote', async () => {
    const { ctx, names } = await thread({ 'clients/k1': { displayName: 'Dana Ruiz' } }, [kin('k1'), kin('k1'), kin('k1')]);
    expect(names).toEqual(['Dana', 'Dana', 'Dana']);
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
  });
});

describe('the comment notice names the author the same way (#1923)', () => {
  async function noticeAuthor(comment: Row, docs: Docs = {}) {
    const ctx = buildDbMock({ docs: { 'kin_care_reports/r1': { kinfolkId: 'f1', title: 'Park day' }, ...docs } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: { data: () => comment },
    } as any);
    return (mocks.enqueue.mock.calls[0]![0] as { data: Record<string, unknown> }).data['authorName'];
  }

  it('the records, by first name, never the email on the member record', async () => {
    expect(await noticeAuthor(kin('k1', { body: 'x' }), { 'clients/k1': { displayName: 'Dana Ruiz' } })).toBe('Dana');
    mocks.enqueue.mockClear();
    expect(
      await noticeAuthor(kin('k1', { body: 'x' }), {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'PRIMARY' },
        'kinfolk/f1': { firstName: 'Casey' },
      }),
    ).toBe('Casey');
  });

  it('nobody named: empty, never the household name or the generic line', async () => {
    expect(
      await noticeAuthor(kin('k2', { body: 'x' }), {
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'families/f1': { displayName: 'The Ortega household' },
      }),
    ).toBe('');
  });

  it('a guest who typed an address is unnamed', async () => {
    expect(await noticeAuthor({ authorRole: 'guest', guestName: SECONDARY_EMAIL, body: 'x' })).toBe('');
  });
});

describe('the public share page signs the same person, and never an address (#1923)', () => {
  async function publicNames(docs: Docs, rows: Row[]) {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' }, ...docs },
      queryDocs: {
        'kin_care_reports/t1/comments': rows.map((data, i) => ({ id: `c${i + 1}`, data: { createdAtMs: i + 1, body: 'hi', ...data } })),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const out = await listPublicComments('t1');
    return { out, names: out.map((c) => c.name) };
  }

  it('REGRESSION: an email on the member record is never served to a stranger', async () => {
    const { out, names } = await publicNames(
      {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, role: 'SECONDARY' },
        'clients/k1': { displayName: PRIMARY_EMAIL },
        'staff/a1': { displayName: STAFF_EMAIL },
      },
      [kin('k1'), { authorRole: 'admin', authorUid: 'a1' }, { authorRole: 'guest', guestName: SECONDARY_EMAIL }],
    );
    expect(names).toEqual([FAMILY_NAME, 'Auntie', ANONYMOUS_GUEST_NAME]);
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('a person is signed "First L."; the household name never reaches the page', async () => {
    const { out, names } = await publicNames(
      {
        'clients/k1': { displayName: 'Dana Ruiz' },
        'families/f1/members/k2': { displayName: SECONDARY_EMAIL, role: 'SECONDARY' },
        'families/f1': { displayName: 'The Ortega household' },
        'kinfolk/f1': { firstName: 'Casey', lastName: 'Ortega' },
        'clients/k3': { displayName: 'Robin Vale' },
      },
      [kin('k1'), kin('k2'), kin('k3')],
    );
    expect(names).toEqual(['Dana R.', FAMILY_NAME, 'Robin V.']);
    expect(JSON.stringify(out)).not.toMatch(/Ortega|Ruiz|Vale|@/);
  });

  it('markup in a name on file is escaped by the page', async () => {
    const { out } = await publicNames({ 'clients/k1': { displayName: '<img src=x onerror=alert(1)> <b>Ruiz</b>' } }, [kin('k1')]);
    const html = out.map(renderComment).join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('resolveHouseholdAuthors', () => {
  it('SAD: no authors and no household id read nothing and name nobody', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const out = await resolveHouseholdAuthors('', ['k1']);
    expect(out.byUid.get('k1')).toEqual({ personName: null, householdName: null });
    expect(ctx.db.getAll).not.toHaveBeenCalled();
    expect(inAppAuthorName(undefined)).toEqual({ name: HOUSEHOLD_MEMBER_FALLBACK, isPerson: false });
  });

  it('the Secondary Kinfolk name is a display name, so it comes before a first name field', async () => {
    const ctx = buildDbMock({
      docs: { 'families/f1/members/k2': { displayName: SECONDARY_EMAIL, firstName: 'Rob', role: 'SECONDARY' } },
      queryDocs: { 'families/f1/secondaryKinfolk': [{ id: 'p2', data: { name: 'Robin Vale', memberUid: 'k2' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await resolveHouseholdAuthors('f1', ['k2'])).byUid.get('k2')?.personName).toBe('Robin Vale');
  });
  it('ERROR: the Secondary Kinfolk read fails, and the first name field still names them', async () => {
    const ctx = buildDbMock({
      docs: { 'families/f1/members/k2': { displayName: SECONDARY_EMAIL, firstName: 'Rob', role: 'SECONDARY' } },
    });
    const collection = ctx.db.collection;
    ctx.db.collection = vi.fn((path: string) => {
      if (path.endsWith('/secondaryKinfolk')) return { get: () => Promise.reject(new Error('unavailable')) };
      return collection(path);
    }) as typeof ctx.db.collection;
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await resolveHouseholdAuthors('f1', ['k2'])).byUid.get('k2')?.personName).toBe('Rob');
  });
  it('a first name field on the member record is used before the household contact', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/f1/members/k1': { displayName: PRIMARY_EMAIL, firstName: 'Dee', role: 'PRIMARY' },
        'kinfolk/f1': { firstName: 'Casey' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await resolveHouseholdAuthors('f1', ['k1'])).byUid.get('k1')?.personName).toBe('Dee');
  });
});
