import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
/**
 * Issue #380, at the seam where it actually bit: one dispatch, two recipients.
 *
 * `buildNotificationDetail` is unit-tested for the redaction itself. What only a
 * dispatcher-level test can catch is the plumbing — that `enqueueNotification`
 * derives the audience stream PER COPY and hands each copy its own. A key's own
 * `audience` cannot answer the question: `kincare.changed` is `audience: 'both'`,
 * resolves `businessAdmins` first and `kinfolkAcct` second, and writes two
 * `notifications/{id}` documents from one event. Only the operator's may carry
 * the booking notes.
 *
 * The scenario is the one on the issue verbatim: an operator edits a confirmed
 * visit and types an internal remark into `notes`.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' } };
});
beforeEach(() => mocks.dbFn.mockReset());
import { enqueueNotification } from '../src/notifications/dispatcher';
const OPERATOR_REMARK = 'Client disputes last invoice, do not discuss pricing.';
type Written = { path: string; data: Record<string, unknown> };
const detailOf = (w: Written): Record<string, unknown> =>
  (w.data.detail ?? {}) as Record<string, unknown>;
/** The operator roster, the household, and the edited visit carrying the remark. */
function changedVisitDb() {
  return buildDbMock({
    docs: {
      'businessSettings/admins': { uids: ['admin1'] },
      'staff/admin1': { displayName: 'Auntie Syd' },
      'clients/cli1': { displayName: 'Marisol Rivera' },
      'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      'families/fam1/bookings/batch1': { notes: OPERATOR_REMARK },
      'families/fam1/bookings/batch1/kinCares/v1': {
        serviceName: 'Drop-in visit',
        kinNames: ['Rex'],
      },
    },
  });
}
describe('kincare.changed fans out to the operator and the household', () => {
  it('writes the booking notes onto the operator copy and not the household copy', async () => {
    const ctx = changedVisitDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kincare.changed',
      recipientUid: 'cli1',
      actorUid: 'admin1',
      data: { kinfolkId: 'fam1', batchId: 'batch1', visitId: 'v1' },
    });
    // Two copies of one event: businessAdmins (primary) + kinfolkAcct (secondary).
    expect(ids.length).toBe(2);
    const inbox = ctx.writes.filter((w) => w.path.startsWith('notifications/'));
    expect(inbox.length).toBe(2);
    const staffCopy = inbox.find((w) => w.data.recipientUid === 'admin1');
    const kinfolkCopy = inbox.find((w) => w.data.recipientUid === 'cli1');
    expect(staffCopy).toBeTruthy();
    expect(kinfolkCopy).toBeTruthy();
    const staffDetail = detailOf(staffCopy!);
    const kinfolkDetail = detailOf(kinfolkCopy!);
    expect(staffDetail.notes).toBe(OPERATOR_REMARK);
    expect('notes' in kinfolkDetail).toBe(false);
    // The household still gets a card worth reading; only the one field is gone.
    expect(kinfolkDetail.kinfolkName).toBe('The Rivera Home');
    expect(kinfolkDetail.kinName).toBe('Rex');
    expect(kinfolkDetail.serviceType).toBe('Drop-in visit');
  });
  /**
   * The inbox document is the leak surface, not the card renderer:
   * `firestore.rules` lets a signed-in kinfolk read any `notifications/{id}`
   * whose `recipientUid` is theirs, whole. So the assertion has to be about the
   * whole written document, not just its `detail` block — `data` is the emitter's
   * merge bag and is written verbatim alongside it.
   */
  it('leaves the remark nowhere in the household document at all', async () => {
    const ctx = changedVisitDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.changed',
      recipientUid: 'cli1',
      actorUid: 'admin1',
      data: { kinfolkId: 'fam1', batchId: 'batch1', visitId: 'v1' },
    });
    const kinfolkCopy = ctx.writes.find(
      (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'cli1',
    );
    expect(JSON.stringify(kinfolkCopy!.data)).not.toContain('do not discuss pricing');
  });
});
