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
  it('NEVER returns staff notes or the internal thread', async () => {
    setup({}, [
      { id: 'mine', data: { authorRole: 'kinfolk', body: 'Mine', createdAt: ts(1000) } },
      { id: 'staff', data: { authorRole: 'admin', body: 'Staff-only remark', createdAt: ts(1500) } },
      { id: 'unstamped', data: { body: 'No role on this row', createdAt: ts(1600) } },
    ]);
    const res = await read();
    expect(res.notes.map((n) => n.body)).toEqual(['Mine']);
    expect(JSON.stringify(res)).not.toContain('Staff-only remark');
  });
  it('returns null and [] when nothing was written', async () => {
    setup({ 'families/f1/bookings/b1': { notes: '   ' } });
    const res = await read();
    expect(res).toEqual({ bookingNote: null, notes: [] });
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
