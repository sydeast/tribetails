import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';
/**
 * #1283: a household reads back what it told its Auntie. The load-bearing case
 * is the one that says what it must NOT read back.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());
const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const ts = (ms: number) => ({ toMillis: () => ms });
/** `notes` rows are a query fixture: the handler lists the subcollection, it does not get() each row. */
function setup(docs: Record<string, Record<string, unknown>>, notes: Array<{ id: string; data: Record<string, unknown> }> = []) {
  const ctx = buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['f1'] },
      'families/f1/bookings/b1': { notes: '  Gate sticks, lift and pull.  ' },
      [VISIT]: { status: 'confirmed' },
      ...docs,
    },
    queryDocs: { [`${VISIT}/notes`]: notes },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}
async function read(data: Record<string, unknown> = { batchId: 'b1', visitId: 'v1' }, uid: string | null = 'u1') {
  const { getBookingNotesHandler } = await import('../src/portal/getBookingNotes');
  return getBookingNotesHandler(callableRequest({ kinfolkId: 'f1', ...data }, uid ? { uid } : undefined));
}
describe('getBookingNotes', () => {
  it('rejects an unauthenticated caller', async () => {
    setup({});
    await expect(read(undefined, null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it("returns the household's own notes oldest first, with the time written, plus the booking note", async () => {
    setup({}, [
      { id: 'n2', data: { authorRole: 'kinfolk', body: 'Second', createdAt: ts(2000) } },
      { id: 'n1', data: { authorRole: 'kinfolk', body: 'First', createdAt: ts(1000) } },
    ]);
    const res = await read();
    expect(res.bookingNote).toBe('Gate sticks, lift and pull.');
    expect(res.notes).toEqual([
      { id: 'n1', body: 'First', createdAtMs: 1000 },
      { id: 'n2', body: 'Second', createdAtMs: 2000 },
    ]);
  });
  it("keeps the household's own list to the household's own rows", async () => {
    setup({}, [
      { id: 'mine', data: { authorRole: 'kinfolk', body: 'Mine', createdAt: ts(1000) } },
      { id: 'staff', data: { authorRole: 'admin', body: 'From the office', createdAt: ts(1500) } },
      { id: 'unstamped', data: { body: 'No role on this row', createdAt: ts(1600) } },
    ]);
    const res = await read();
    expect(res.notes.map((n) => n.body)).toEqual(['Mine']);
    // #2030: the office's row is in its own list, never under the household's.
    expect(res.fromBusiness.map((n) => n.body)).toEqual(['From the office']);
    // A row nobody stamped is in neither list.
    expect(JSON.stringify(res)).not.toContain('No role on this row');
  });
  it('returns null and [] when nothing was written', async () => {
    setup({ 'families/f1/bookings/b1': { notes: '   ' } });
    const res = await read();
    expect(res).toEqual({ bookingNote: null, notes: [], fromBusiness: [] });
  });
  // ── #2030: what the office said to the household ──────────────────────────
  it('returns the accept note, the decline note and a kinfolk-facing visit note, each dated and named, oldest first', async () => {
    setup(
      {
        [VISIT]: {
          status: 'confirmed',
          requestAcceptNote: '  Booked. Bring the spare key.  ',
          requestAcceptedAt: ts(3000),
          requestAcceptedBy: 'owner1',
          requestDeclineNote: 'We are full that week.',
          requestDeclinedAt: ts(1000),
          requestDeclinedBy: 'owner1',
        },
        'staff/owner1': { displayName: 'Syd' },
        'staff/auntie1': { displayName: 'Dre' },
      },
      [
        { id: 'n9', data: { authorRole: 'admin', authorUid: 'auntie1', body: 'Treats are on the shelf.', createdAt: ts(2000) } },
        { id: 'n8', data: { authorRole: 'kinfolk', authorUid: 'u1', body: 'Thanks!', createdAt: ts(4000) } },
      ],
    );
    const res = await read();
    expect(res.fromBusiness).toEqual([
      { id: 'request-declined', kind: 'requestDeclined', body: 'We are full that week.', createdAtMs: 1000, authorName: 'Syd' },
      { id: 'n9', kind: 'visitNote', body: 'Treats are on the shelf.', createdAtMs: 2000, authorName: 'Dre' },
      { id: 'request-accepted', kind: 'requestAccepted', body: 'Booked. Bring the spare key.', createdAtMs: 3000, authorName: 'Syd' },
    ]);
    expect(res.notes.map((n) => n.body)).toEqual(['Thanks!']);
  });
  it('never names a writer by an email address or by uid; the client names the business instead', async () => {
    setup(
      {
        [VISIT]: { status: 'confirmed', requestAcceptNote: 'See you then.', requestAcceptedAt: ts(1000), requestAcceptedBy: 'owner1' },
        'staff/owner1': { displayName: 'e2e-admin@tribetails.com' },
      },
      [{ id: 'n1', data: { authorRole: 'admin', authorUid: 'ghost', body: 'Gate code changed.', createdAt: ts(2000) } }],
    );
    const res = await read();
    expect(res.fromBusiness.map((n) => n.authorName)).toEqual([null, null]);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('@');
    expect(wire).not.toContain('owner1');
    expect(wire).not.toContain('ghost');
  });
  it('NEVER returns the internal thread, admin-only notes or the session notes text', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'families/f1/bookings/b1': { notes: null },
        [VISIT]: { status: 'confirmed', sessionId: 'vis_v1', notes: 'Visit-record remark' },
        'kin_care_sessions/vis_v1': { notes: 'Session remark for staff', kinfolkNotes: '' },
      },
      queryDocs: {
        [`${VISIT}/notes`]: [{ id: 'n1', data: { authorRole: 'admin', body: 'For the household', createdAt: ts(1000) } }],
        [`${VISIT}/internalNotes`]: [{ id: 'i1', data: { authorRole: 'auntie', body: 'Shared staff note', createdAt: ts(1100) } }],
        [`${VISIT}/adminNotes`]: [{ id: 'a1', data: { authorRole: 'admin', body: 'Owner-only note', createdAt: ts(1200) } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await read();
    expect(res.fromBusiness.map((n) => n.body)).toEqual(['For the household']);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('Shared staff note');
    expect(wire).not.toContain('Owner-only note');
    expect(wire).not.toContain('Session remark for staff');
    expect(wire).not.toContain('Visit-record remark');
  });
  it('leaves out a blank answer note', async () => {
    setup({ [VISIT]: { status: 'cancelled', requestDeclineNote: null, requestDeclinedAt: ts(1000), requestAcceptNote: '   ' } });
    const res = await read();
    expect(res.fromBusiness).toEqual([]);
  });
  it("denies a visit outside the caller's own households", async () => {
    setup({ 'clients/u1': { kinfolkIds: ['OTHER'] } });
    await expect(read()).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('reports a missing visit as not-found', async () => {
    setup({});
    await expect(read({ batchId: 'b1', visitId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
  });
  it('reports a missing visitId as a validation failure', async () => {
    setup({});
    await expect(read({ batchId: 'b1' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
