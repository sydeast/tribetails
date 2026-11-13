import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #2168 review: two rules that keep a visit from being billed twice.
 *
 *   1. AN ARCHIVED INVOICE IS READ-ONLY UNTIL IT IS RESTORED. Archiving a draft
 *      lets go of its visits, and only a restore takes them back, checking each
 *      one is still free. So a send, an Edit and a Link visits on an archived
 *      invoice are refused (`invoice_archived`), with nothing sent and nothing
 *      written. Repros A, B and C from the review are the first three tests.
 *   2. A DRAFT IS SENT ONLY WHEN EVERY VISIT ITS LINES BILL IS ITS OWN. A visit
 *      another invoice now bills, a cancelled one or one with no record refuses
 *      the send (`draft_visits_not_billable`), named by its Chicago day and the
 *      other invoice's number. Checked before the household is told, and again
 *      in the transaction that flips the status.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: async (args: unknown) => ({
    written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
    suppressed: [],
    unresolved: [],
    appOnly: [],
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: vi.fn().mockResolvedValue('kin-uid-1') }));
vi.mock('../src/lib/payMethodSnapshot', () => ({ payMethodSnapshotForIssue: vi.fn().mockResolvedValue(null) }));

import { createInvoiceHandler } from '../src/admin/createInvoice';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { archiveInvoiceHandler } from '../src/admin/archiveInvoice';
import { unarchiveInvoiceHandler } from '../src/admin/unarchiveInvoice';
import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
import { postInvoiceEventHandler } from '../src/admin/postInvoiceEvent';
import { isSessionBillable } from '../src/lib/sessionInvoicing';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return { data, auth: { uid, token: { admin: true } } as any, rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false } as unknown as CallableRequest<unknown>;
}
const visit = (extra: Record<string, unknown> = {}) => ({ kinfolkId: 'fam1', status: 'COMPLETED', serviceType: '30Minute', startTime: '2026-06-02T14:00:00.000Z', ...extra });
const line = (sessionId: string) => ({ description: '30 Minute Quick Check', qty: 1, unitCents: 4500, sessionId });
const composerDraft = (sessionIds: string[]) => {
  const lineItems = sessionIds.map(line);
  const total = (lineItems.length * 4500) / 100;
  return { familyId: 'fam1', kinfolkName: 'Test Household', client: 'Test Household', date: '2026-06-10', terms: 'Net 30', dueDate: '2026-07-10', total, amountDue: total, status: 'draft', sessionIds, lineItems };
};

const ARCHIVED = {
  code: 'failed-precondition',
  message: 'This invoice is archived. Restore it before sending or changing it.',
  details: { code: 'invoice_archived' },
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
});

/** A New invoice draft billing s1 and s2, then archived (which lets both go). */
async function archivedDraft(docs: Record<string, Record<string, unknown>> = {}) {
  const ctx = buildDbMock({
    docs: { 'kin_care_sessions/s1': visit(), 'kin_care_sessions/s2': visit(), 'kin_care_sessions/s3': visit(), ...docs },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  const { invoiceId } = await createInvoiceHandler(req({ ...composerDraft(['s1', 's2']), idempotencyKey: 'inv_1700000002168_x' }));
  await archiveInvoiceHandler(req({ invoiceId }));
  mocks.enqueue.mockClear();
  const docOf = async (p: string) => ((await ctx.db.doc(p).get()).data() ?? {}) as Record<string, unknown>;
  return { ctx, invoiceId, docOf };
}

describe('#2168 review: an archived invoice is read-only until it is restored', () => {
  it('A: Review and send on an archived draft is refused, and nothing is sent or written', async () => {
    const { ctx, invoiceId, docOf } = await archivedDraft();
    const writesBefore = ctx.writes.length;

    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId }))).rejects.toMatchObject(ARCHIVED);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes.length).toBe(writesBefore);
    expect((await docOf(`invoices/${invoiceId}`))['status']).toBe('draft');
    // Its visits stay on the un-invoiced list, where archiving put them.
    expect(isSessionBillable(await docOf('kin_care_sessions/s1'))).toBe(true);
    expect(isSessionBillable(await docOf('kin_care_sessions/s2'))).toBe(true);
  });

  it('A, old clients: the draft send on the postInvoiceEvent wire is refused the same way', async () => {
    const { ctx, invoiceId } = await archivedDraft();
    const writesBefore = ctx.writes.length;

    await expect(
      postInvoiceEventHandler(req({ familyId: 'fam1', invoiceId, payload: { status: 'sent' } })),
    ).rejects.toMatchObject(ARCHIVED);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes.length).toBe(writesBefore);
  });

  it('B: Edit that drops a line while archived is refused, so the restore never re-claims a visit with no line', async () => {
    const { ctx, invoiceId, docOf } = await archivedDraft();
    const before = await docOf(`invoices/${invoiceId}`);
    const writesBefore = ctx.writes.length;

    await expect(
      updateInvoiceHandler(req({ invoiceId, patch: { lineItems: [line('s2')] } })),
    ).rejects.toMatchObject(ARCHIVED);
    expect(ctx.writes.length).toBe(writesBefore);
    expect((await docOf(`invoices/${invoiceId}`))['lineItems']).toEqual(before['lineItems']);

    // Restored, both lines are still there and both visits come back with them.
    const res = await unarchiveInvoiceHandler(req({ invoiceId }));
    expect(res.reclaimedSessionIds.sort()).toEqual(['s1', 's2']);
    expect((await docOf('kin_care_sessions/s1'))['invoiceId']).toBe(invoiceId);
  });

  it('C: Edit that adds a line while archived is refused, so the archived draft holds no visit', async () => {
    const { ctx, invoiceId, docOf } = await archivedDraft();
    const writesBefore = ctx.writes.length;

    await expect(
      updateInvoiceHandler(req({ invoiceId, patch: { lineItems: [line('s1'), line('s2'), line('s3')] } })),
    ).rejects.toMatchObject(ARCHIVED);

    expect(ctx.writes.length).toBe(writesBefore);
    expect(isSessionBillable(await docOf('kin_care_sessions/s3'))).toBe(true);
  });

  it('an Edit that touches no line is refused too: the whole invoice is read-only', async () => {
    const { ctx, invoiceId } = await archivedDraft();
    const writesBefore = ctx.writes.length;
    await expect(updateInvoiceHandler(req({ invoiceId, patch: { terms: 'Net 7' } }))).rejects.toMatchObject(ARCHIVED);
    expect(ctx.writes.length).toBe(writesBefore);
  });

  it('Link visits on an archived invoice is refused, linking nothing', async () => {
    const { ctx, invoiceId, docOf } = await archivedDraft();
    const writesBefore = ctx.writes.length;

    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId, sessionIds: ['s1', 's3'] })),
    ).rejects.toMatchObject(ARCHIVED);

    expect(ctx.writes.length).toBe(writesBefore);
    expect(isSessionBillable(await docOf('kin_care_sessions/s3'))).toBe(true);
  });

  it('a SENT invoice that was archived is read-only as well', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': {
          kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', total: 45, amountDue: 0, paidCents: 4500,
          sessionIds: ['s1'], lineItems: [line('s1')], archivedAt: '__TS__',
        },
        'kin_care_sessions/s1': visit({ invoiceId: 'inv1' }),
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 7' } }))).rejects.toMatchObject(ARCHIVED);
    await expect(linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }))).rejects.toMatchObject(ARCHIVED);
    expect(ctx.writes).toEqual([]);
  });

  it('once restored, the same draft can be edited and sent', async () => {
    const { invoiceId, docOf } = await archivedDraft();
    await unarchiveInvoiceHandler(req({ invoiceId }));

    await updateInvoiceHandler(req({ invoiceId, patch: { lineItems: [line('s2')] } }));
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId }))).resolves.toMatchObject({ ok: true, invoiceId });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect((await docOf(`invoices/${invoiceId}`))['status']).toBe('open');
    expect(isSessionBillable(await docOf('kin_care_sessions/s1'))).toBe(true);
    expect((await docOf('kin_care_sessions/s2'))['invoiceId']).toBe(invoiceId);
  });
});

describe('#2168 review: a draft is sent only when every visit its lines bill is its own', () => {
  /** A draft whose lines bill s1 and s2, stored directly so each visit's state is the test's to set. */
  function draftBilling(sessions: Record<string, Record<string, unknown> | null>, others: Record<string, Record<string, unknown>> = {}) {
    const docs: Record<string, Record<string, unknown>> = {
      'invoices/d1': {
        kinfolkId: 'fam1', invoiceNumber: 'INV-20', status: 'draft', total: 90, amountDue: 90,
        sessionIds: Object.keys(sessions), lineItems: Object.keys(sessions).map(line),
      },
    };
    for (const [id, data] of Object.entries(sessions)) if (data !== null) docs[`kin_care_sessions/${id}`] = data;
    for (const [id, data] of Object.entries(others)) docs[`invoices/${id}`] = data;
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const docOf = async (p: string) => ((await ctx.db.doc(p).get()).data() ?? {}) as Record<string, unknown>;
    return { ctx, docOf };
  }

  it('a visit another invoice now bills refuses the send, naming its Chicago day and that invoice', async () => {
    // 00:30 UTC on June 3 is 7:30 PM on June 2 in Chicago.
    const { ctx, docOf } = draftBilling(
      { s1: visit({ invoiceId: 'd1' }), s2: visit({ invoiceId: 'other', startTime: '2026-06-03T00:30:00.000Z' }) },
      { other: { kinfolkId: 'fam1', invoiceNumber: 'INV-31', status: 'open' } },
    );

    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message:
        'This draft cannot be sent: the visit on 2026-06-02 is billed on invoice INV-31. ' +
        'Remove its line in Edit, then send the draft.',
      details: {
        code: 'draft_visits_not_billable',
        visits: [{ sessionId: 's2', reason: 'on_other_invoice', invoiceNumber: 'INV-31' }],
      },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes).toEqual([]);
    expect((await docOf('invoices/d1'))['status']).toBe('draft');
  });

  it('an other invoice with no number is "another invoice", never its id', async () => {
    const { ctx } = draftBilling(
      { s1: visit({ invoiceId: 'd1' }), s2: visit({ invoiceId: 'inv_numberless' }) },
      { inv_numberless: { kinfolkId: 'fam1', status: 'draft' } },
    );
    const err = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' })).catch((e) => e);
    expect(err.message).toBe(
      'This draft cannot be sent: the visit on 2026-06-02 is billed on another invoice. Remove its line in Edit, then send the draft.',
    );
    expect(err.message).not.toContain('inv_numberless');
    expect(err.details.visits).toEqual([{ sessionId: 's2', reason: 'on_other_invoice', invoiceNumber: '' }]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes).toEqual([]);
  });

  it('a cancelled visit refuses the send', async () => {
    const { ctx } = draftBilling({ s1: visit({ invoiceId: 'd1' }), s2: visit({ invoiceId: 'd1', status: 'CANCELLED', startTime: '2026-06-05T15:00:00.000Z' }) });
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject({
      message: 'This draft cannot be sent: the visit on 2026-06-05 was cancelled. Remove its line in Edit, then send the draft.',
      details: { code: 'draft_visits_not_billable', visits: [{ sessionId: 's2', reason: 'cancelled', invoiceNumber: '' }] },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes).toEqual([]);
  });

  it('a visit with no record refuses the send', async () => {
    const { ctx } = draftBilling({ s1: visit({ invoiceId: 'd1' }), s2: null });
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject({
      message: 'This draft cannot be sent: one visit no longer has a record. Remove its line in Edit, then send the draft.',
      details: { code: 'draft_visits_not_billable', visits: [{ sessionId: 's2', reason: 'not_found', invoiceNumber: '' }] },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(ctx.writes).toEqual([]);
  });

  it('several reasons are named together, and the fix names "those lines"', async () => {
    const { ctx } = draftBilling(
      { s1: visit({ invoiceId: 'other' }), s2: visit({ status: 'CANCELLED', startTime: '2026-06-05T15:00:00.000Z' }), s3: null, s4: null },
      { other: { invoiceNumber: 'INV-31' } },
    );
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject({
      message:
        'This draft cannot be sent: the visit on 2026-06-02 is billed on invoice INV-31; the visit on 2026-06-05 was cancelled; ' +
        '2 visits no longer have a record. Remove those lines in Edit, then send the draft.',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('sends when every visit is its own, and claims a line visit whose back-link was blank', async () => {
    const { ctx, docOf } = draftBilling({ s1: visit({ invoiceId: 'd1' }), s2: visit() });

    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).resolves.toMatchObject({ ok: true, invoiceId: 'd1' });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const inv = await docOf('invoices/d1');
    expect(inv['status']).toBe('open');
    expect(inv['sessionIds']).toEqual(['s1', 's2']);
    expect((await docOf('kin_care_sessions/s2'))['invoiceId']).toBe('d1');
    expect(isSessionBillable(await docOf('kin_care_sessions/s2'))).toBe(false);
    // The visit that was already its own is not written again.
    expect(ctx.writes.some((w) => w.path === 'kin_care_sessions/s1')).toBe(false);
  });

  it('a visit linked with no line is attribution and does not block the send', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/d1': { kinfolkId: 'fam1', invoiceNumber: 'INV-20', status: 'draft', total: 45, amountDue: 45, sessionIds: ['s1', 's9'], lineItems: [line('s1')] },
        'kin_care_sessions/s1': visit({ invoiceId: 'd1' }),
        'kin_care_sessions/s9': visit({ invoiceId: 'other' }),
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).resolves.toMatchObject({ ok: true });
  });

  it('a claim that lands while the household is being told is refused at the flip, and the draft stays a draft', async () => {
    const { docOf, ctx } = draftBilling({ s1: visit({ invoiceId: 'd1' }), s2: visit() }, { other: { invoiceNumber: 'INV-31' } });
    // The first transaction claimed s2 for the draft. A write that took it
    // anyway between the check and the flip (outside any callable) is caught
    // by the second read rather than overwritten.
    mocks.enqueue.mockImplementation(async () => {
      await ctx.db.doc('kin_care_sessions/s2').set({ invoiceId: 'other' }, { merge: true });
      return ['n1'];
    });

    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject({
      details: { code: 'draft_visits_not_billable', visits: [{ sessionId: 's2', reason: 'on_other_invoice', invoiceNumber: 'INV-31' }] },
    });
    expect((await docOf('invoices/d1'))['status']).toBe('draft');
  });

  it('an archive that lands while the household is being told is refused at the flip', async () => {
    const { docOf, ctx } = draftBilling({ s1: visit({ invoiceId: 'd1' }) });
    mocks.enqueue.mockImplementation(async () => {
      await ctx.db.doc('invoices/d1').set({ archivedAt: '__TS__' }, { merge: true });
      return ['n1'];
    });
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'd1' }))).rejects.toMatchObject(ARCHIVED);
    expect((await docOf('invoices/d1'))['status']).toBe('draft');
  });
});
