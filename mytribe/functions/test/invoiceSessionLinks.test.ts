import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1901 / #1970 / #2091: a visit's billed link and the invoice that bills it
 * agree, and are set and cleared in the same transaction, whichever of the
 * three callables changes them.
 *
 *   - New invoice (`createInvoice`) marks every visit it bills.
 *   - Edit (`updateInvoice`) unlinks a visit whose line it removes.
 *   - Link visits (`linkInvoiceSessions`) says which linked visits carry no
 *     line, and refuses to unlink a visit a line still bills.
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

import { createInvoiceHandler } from '../src/admin/createInvoice';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { isSessionBillable } from '../src/lib/sessionInvoicing';
import { boundSessionIds, linkedWithoutLine } from '../src/lib/invoiceSessionLinks';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const visit = (extra: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  status: 'COMPLETED',
  serviceType: '30Minute',
  startTime: '2026-06-02T14:00:00.000Z',
  ...extra,
});

const line = (sessionId: string | undefined, unitCents = 4500, description = '30 Minute Quick Check') => ({
  description,
  qty: 1,
  unitCents,
  ...(sessionId ? { sessionId } : {}),
});

/** What New invoice sends for a draft drawn from visits. */
const composerDraft = (sessionIds: string[], extra: Record<string, unknown> = {}) => {
  const lineItems = sessionIds.map((id) => line(id));
  const total = (lineItems.length * 4500) / 100;
  return {
    familyId: 'fam1',
    kinfolkName: 'Test Household',
    client: 'Test Household',
    date: '2026-06-10',
    terms: 'Net 30',
    dueDate: '2026-07-10',
    total,
    amountDue: total,
    status: 'draft',
    sessionIds,
    lineItems,
    ...extra,
  };
};

function writeAt(ctx: ReturnType<typeof buildDbMock>, path: string) {
  return ctx.writes.find((w) => w.path === path);
}

/**
 * Firestore runs a transaction, and when a document it read changed before it
 * committed, runs it again against what is there now. The mock runs callbacks
 * as they arrive, so two saves interleave and both read "unclaimed". This
 * gives the mock the outcome Firestore guarantees: one at a time, the second
 * reading what the first committed.
 */
function serializeTransactions(ctx: ReturnType<typeof buildDbMock>) {
  const inner = ctx.db.runTransaction;
  let chain: Promise<unknown> = Promise.resolve();
  ctx.db.runTransaction = (fn: any) => {
    const run = chain.then(() => inner(fn));
    chain = run.catch(() => undefined);
    return run;
  };
}

// ── New invoice (#1901) ─────────────────────────────────────────────────────

describe('#1901 createInvoice marks every visit it bills', () => {
  it('sets each visit’s back-link to the new invoice, in the same transaction as the invoice', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit(), 'kin_care_sessions/s2': visit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(composerDraft(['s1', 's2'])));

    const inv = writeAt(ctx, `invoices/${res.invoiceId}`);
    expect(inv?.data.sessionIds).toEqual(['s1', 's2']);
    for (const sid of ['s1', 's2']) {
      const w = writeAt(ctx, `kin_care_sessions/${sid}`);
      expect(w?.merge).toBe(true);
      expect(w?.data.invoiceId).toBe(res.invoiceId);
      expect(w?.data._attribution).toBe('manual');
      // ISO text, never a Timestamp: Android decodes it as a String.
      expect(typeof w?.data._attributionAt).toBe('string');
    }
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('the visit leaves the un-invoiced list once the draft exists', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit() }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(isSessionBillable(visit())).toBe(true);
    await createInvoiceHandler(req(composerDraft(['s1'])));
    const stored = (await ctx.db.doc('kin_care_sessions/s1').get()).data();
    expect(isSessionBillable(stored)).toBe(false);
  });

  it('a line bound to a visit the id list left out still marks that visit, and joins the set', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit(), 'kin_care_sessions/s2': visit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(
      req({ ...composerDraft(['s1', 's2']), sessionIds: ['s1', ' ', 's1'] }),
    );
    expect(writeAt(ctx, `invoices/${res.invoiceId}`)?.data.sessionIds).toEqual(['s1', 's2']);
    expect(writeAt(ctx, 'kin_care_sessions/s2')?.data.invoiceId).toBe(res.invoiceId);
  });

  it('a typed-total invoice with visits named and no lines still marks them', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { lineItems: _drop, ...typed } = composerDraft(['s1']);
    const res = await createInvoiceHandler(req({ ...typed, total: 30, amountDue: 30 }));
    expect(writeAt(ctx, 'kin_care_sessions/s1')?.data.invoiceId).toBe(res.invoiceId);
  });

  it('an invoice with no visits writes no visit', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(composerDraft([])));
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toEqual([]);
  });

  it('refuses a visit another invoice already bills, naming that invoice, and writes nothing at all', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': visit(),
        'kin_care_sessions/s2': visit({ invoiceId: 'invA' }),
        'invoices/invA': { invoiceNumber: '1024', sessionIds: ['s2'] },
        'counters/invoiceNumber': { value: 1030 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await createInvoiceHandler(req(composerDraft(['s1', 's2']))).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'failed-precondition',
      message: 'Already billed on another invoice: the visit on 2026-06-02 is on invoice 1024. Unlink it there first.',
      details: { code: 'session_on_other_invoice', conflicts: [{ sessionId: 's2', invoiceId: 'invA', invoiceNumber: '1024' }] },
    });
    // No invoice, no visit, and no number spent on an invoice that was not written.
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a cancelled visit, and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit({ status: 'cancelled' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createInvoiceHandler(req(composerDraft(['s1'])))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'session_cancelled', sessionIds: ['s1'] },
    });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a visit with no record, in words with no id in them, and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await createInvoiceHandler(req(composerDraft(['s1', 'ghost']))).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: 'session_not_found', missing: ['ghost'] } });
    expect((err as Error).message).not.toContain('ghost');
    expect(ctx.writes).toEqual([]);
  });

  it('a visit whose back-link already names this invoice is a retry completing it, not a conflict', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit({ invoiceId: 'inv_1700000000001_a' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000000001_a' }));
    expect(res.invoiceId).toBe('inv_1700000000001_a');
    expect(writeAt(ctx, 'kin_care_sessions/s1')?.data.invoiceId).toBe('inv_1700000000001_a');
  });

  it('a replay of a stored invoice writes no visit again', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv_1700000000001_a': { createdBy: 'admin1', invoiceNumber: '1031', sessionIds: ['s1'] },
        'kin_care_sessions/s1': visit({ invoiceId: 'inv_1700000000001_a' }),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000000001_a' }));
    expect(res.invoiceId).toBe('inv_1700000000001_a');
    expect(ctx.writes).toEqual([]);
  });

  it('two New invoice saves for the same visit at once: one bills it, the other is refused and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': visit() }, writeThrough: true });
    serializeTransactions(ctx);
    mocks.dbFn.mockReturnValue(ctx.db);
    const [a, b] = await Promise.allSettled([
      createInvoiceHandler(req({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000000002_a' })),
      createInvoiceHandler(req({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000000002_b' })),
    ]);
    const outcomes = [a, b];
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ details: { code: 'session_on_other_invoice' } });
    const winner = (won[0] as PromiseFulfilledResult<{ invoiceId: string }>).value.invoiceId;
    const loser = winner === 'inv_1700000000002_a' ? 'inv_1700000000002_b' : 'inv_1700000000002_a';
    expect((await ctx.db.doc('kin_care_sessions/s1').get()).data().invoiceId).toBe(winner);
    expect((await ctx.db.doc(`invoices/${loser}`).get()).exists).toBe(false);
  });
});

// ── Edit (#1970) ────────────────────────────────────────────────────────────

describe('#1970 updateInvoice unlinks a visit whose line it removes', () => {
  const twoVisitDraft = {
    kinfolkId: 'fam1',
    invoiceNumber: '1024',
    status: 'draft',
    total: 90,
    amountDue: 90,
    totalCents: 9000,
    lineItems: [line('s1'), line('s2')],
    sessionIds: ['s1', 's2'],
  };
  function seedEdit(invoice: Record<string, unknown>, sessions: Record<string, Record<string, unknown>>, payments: any[] = []) {
    const docs: Record<string, Record<string, unknown>> = { 'invoices/inv1': invoice };
    for (const [id, d] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = d;
    return buildDbMock({ docs, queryDocs: { 'invoices/inv1/payments': payments } });
  }

  it('drops the visit from the invoice and clears its back-link, in the same transaction', async () => {
    const ctx = seedEdit(twoVisitDraft, { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'inv1' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1')] } }));
    expect(res.totals.totalCents).toBe(4500);

    const inv = writeAt(ctx, 'invoices/inv1');
    expect(inv?.data.sessionIds).toEqual(['s1']);
    const s2 = writeAt(ctx, 'kin_care_sessions/s2');
    expect(s2?.data.invoiceId).toBe('');
    expect(s2?.data._attribution).toBe('manual_unlink');
    expect(writeAt(ctx, 'kin_care_sessions/s1')).toBeUndefined();
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry as any).mock.calls[0][0].payload).toMatchObject({
      sessionsLinked: [],
      sessionsUnlinked: ['s2'],
    });
  });

  it('the released visit is back on the un-invoiced list', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv1': twoVisitDraft, 'kin_care_sessions/s2': visit({ invoiceId: 'inv1' }), 'kin_care_sessions/s1': visit({ invoiceId: 'inv1' }) },
      queryDocs: { 'invoices/inv1/payments': [] },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1')] } }));
    expect(isSessionBillable((await ctx.db.doc('kin_care_sessions/s2').get()).data())).toBe(true);
    expect(isSessionBillable((await ctx.db.doc('kin_care_sessions/s1').get()).data())).toBe(false);
  });

  it('a visit linked by hand with no line of its own stays linked through a line edit', async () => {
    const ctx = seedEdit(
      { ...twoVisitDraft, sessionIds: ['s1', 's2', 'handLinked'] },
      { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'inv1' }), handLinked: visit({ invoiceId: 'inv1' }) },
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1'), line(undefined, 900, 'Key cutting')] } }));
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual(['s1', 'handLinked']);
    expect(writeAt(ctx, 'kin_care_sessions/handLinked')).toBeUndefined();
  });

  it('#1259: a removed visit whose back-link names another invoice leaves this invoice and keeps that back-link', async () => {
    const ctx = seedEdit(twoVisitDraft, { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'invOther' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1')] } }));
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual(['s1']);
    expect(writeAt(ctx, 'kin_care_sessions/s2')).toBeUndefined();
  });

  it('an edit that keeps every visit line writes no visit and leaves the set alone', async () => {
    const ctx = seedEdit(twoVisitDraft, { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'inv1' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { lineItems: [line('s2', 5000), line('s1')], kinfolkName: 'Renamed' } }),
    );
    expect('sessionIds' in (writeAt(ctx, 'invoices/inv1')?.data ?? {})).toBe(false);
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toEqual([]);
  });

  it('a patch with no lines touches no visit', async () => {
    const ctx = seedEdit(twoVisitDraft, { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'inv1' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { address: '2 Side St' } }));
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toEqual([]);
  });

  it('a newly bound line on a visit another invoice bills is refused, and nothing is written', async () => {
    const ctx = seedEdit(
      { ...twoVisitDraft, lineItems: [line('s1')], sessionIds: ['s1'] },
      { s1: visit({ invoiceId: 'inv1' }), s3: visit({ invoiceId: 'invA' }) },
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1'), line('s3')] } })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'session_on_other_invoice' } });
    expect(ctx.writes).toEqual([]);
  });

  it('a newly bound line on an unclaimed visit marks it billed here', async () => {
    const ctx = seedEdit({ ...twoVisitDraft, lineItems: [line('s1')], sessionIds: ['s1'] }, { s1: visit({ invoiceId: 'inv1' }), s3: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1'), line('s3')] } }));
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual(['s1', 's3']);
    expect(writeAt(ctx, 'kin_care_sessions/s3')?.data.invoiceId).toBe('inv1');
  });

  it('a paid invoice still refuses a line change, so no visit moves either', async () => {
    const ctx = seedEdit(
      { ...twoVisitDraft, status: 'paid', amountDue: 0 },
      { s1: visit({ invoiceId: 'inv1' }), s2: visit({ invoiceId: 'inv1' }) },
      [{ id: 'p1', data: { amountCents: 9000 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { lineItems: [line('s1')] } }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('terms counted from the last visit use the visits this edit leaves linked', async () => {
    const ctx = seedEdit(twoVisitDraft, {
      s1: visit({ invoiceId: 'inv1', startTime: '2026-06-02T14:00:00.000Z' }),
      s2: visit({ invoiceId: 'inv1', startTime: '2026-06-09T14:00:00.000Z' }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { lineItems: [line('s1')], termsCode: 'net_7_after_last_visit', date: '2026-06-10' } }),
    );
    // s2 (06-09) left with its line, so the last visit is s1 (06-02).
    expect(writeAt(ctx, 'invoices/inv1')?.data.dueDate).toBe('2026-06-09');
  });
});

// ── Link visits (#2091) ─────────────────────────────────────────────────────

describe('#2091 linkInvoiceSessions says what linking did not do', () => {
  function seedLink(invoice: Record<string, unknown>, sessions: Record<string, Record<string, unknown>>) {
    const docs: Record<string, Record<string, unknown>> = { 'invoices/inv1': invoice };
    for (const [id, d] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = d;
    return buildDbMock({ docs, queryDocs: { 'invoices/inv1/payments': [] } });
  }
  const manualLineDraft = {
    kinfolkId: 'fam1',
    invoiceNumber: '1024',
    status: 'draft',
    total: 9,
    amountDue: 9,
    totalCents: 900,
    lineItems: [line(undefined, 900, 'Key cutting')],
    sessionIds: [],
  };

  it('a visit linked to an invoice with no line for it is named in linkedWithoutLine, and the money is untouched', async () => {
    const ctx = seedLink(manualLineDraft, { s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(res.added).toEqual(['s1']);
    expect(res.linkedWithoutLine).toEqual(['s1']);
    const inv = writeAt(ctx, 'invoices/inv1')?.data ?? {};
    for (const money of ['lineItems', 'total', 'amountDue', 'totalCents', 'amountDueCents']) {
      expect(money in inv).toBe(false);
    }
  });

  it('a visit a line already bills is not named', async () => {
    const ctx = seedLink(
      { ...manualLineDraft, lineItems: [line('s1'), line(undefined, 900, 'Key cutting')], sessionIds: ['s1'] },
      { s1: visit({ invoiceId: 'inv1' }), s2: visit() },
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1', 's2'] }));
    expect(res.linkedWithoutLine).toEqual(['s2']);
  });

  it('on a typed-total invoice with no lines, every linked visit is named', async () => {
    const { lineItems: _l, totalCents: _t, ...typed } = manualLineDraft;
    const ctx = seedLink({ ...typed, sessionIds: ['s0'] }, { s0: visit({ invoiceId: 'inv1' }), s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s0', 's1'] }));
    expect(res.linkedWithoutLine).toEqual(['s0', 's1']);
  });

  it('refuses to unlink a visit a line on this invoice still bills, naming the line, and writes nothing', async () => {
    const ctx = seedLink(
      { ...manualLineDraft, lineItems: [line('s1', 4500, '30 Minute Quick Check, Jun 2')], sessionIds: ['s1'] },
      { s1: visit({ invoiceId: 'inv1' }) },
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] })).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'failed-precondition',
      message:
        '"30 Minute Quick Check, Jun 2" is billed on a line of this invoice, so it stays linked. Remove the line in Edit, and the visit is unlinked with it.',
      details: { code: 'session_billed_on_line', sessionIds: ['s1'] },
    });
    expect(ctx.writes).toEqual([]);
  });

  it('on a paid invoice the refusal does not send the operator to Edit, whose lines are locked', async () => {
    const docs: Record<string, Record<string, unknown>> = {
      'invoices/inv1': {
        ...manualLineDraft,
        status: 'paid',
        amountDue: 0,
        total: 45,
        totalCents: 4500,
        lineItems: [line('s1', 4500, '30 Minute Quick Check')],
        sessionIds: ['s1'],
      },
      'kin_care_sessions/s1': visit({ invoiceId: 'inv1' }),
    };
    const ctx = buildDbMock({ docs, queryDocs: { 'invoices/inv1/payments': [{ id: 'p1', data: { amountCents: 4500 } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] })).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      '"30 Minute Quick Check" is billed on a line of this invoice, so it stays linked. This invoice\'s lines are locked, so the line cannot be removed.',
    );
    expect(ctx.writes).toEqual([]);
  });
  it('a linked visit whose record is gone can be unlinked, so the warning about it can be cleared', async () => {
    const ctx = seedLink({ ...manualLineDraft, sessionIds: ['gone'] }, {});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }));
    expect(res.removed).toEqual(['gone']);
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual([]);
    expect(writeAt(ctx, 'kin_care_sessions/gone')).toBeUndefined();
  });

  it('a visit New invoice billed shows as on another invoice to every other invoice (end to end)', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': visit(),
        'invoices/inv1': { ...manualLineDraft },
      },
      queryDocs: { 'invoices/inv1/payments': [] },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const created = await createInvoiceHandler(req({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000000003_n' }));
    // The issue's step 4: the same visit, ticked on another invoice of the household.
    await expect(linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }))).rejects.toMatchObject({
      details: { code: 'session_on_other_invoice', conflicts: [{ sessionId: 's1', invoiceId: created.invoiceId }] },
    });
  });
});

describe('lib/invoiceSessionLinks pure helpers', () => {
  it('boundSessionIds: distinct, trimmed, blanks and junk skipped, in line order', () => {
    expect(
      boundSessionIds([{ sessionId: ' s2 ' }, { sessionId: 's1' }, { sessionId: 's2' }, { sessionId: '' }, {}, null, { sessionId: 7 }]),
    ).toEqual(['s2', 's1']);
    expect(boundSessionIds(undefined)).toEqual([]);
  });
  it('linkedWithoutLine: linked ids no line is bound to', () => {
    expect(linkedWithoutLine(['a', 'b', 'c'], [{ sessionId: 'b' }])).toEqual(['a', 'c']);
    expect(linkedWithoutLine(['a'], undefined)).toEqual(['a']);
  });
});
