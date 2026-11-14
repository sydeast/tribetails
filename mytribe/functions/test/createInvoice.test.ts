import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  // #1511: what the dispatcher did to each recipient's copy (see recordPayment.test.ts).
  appOnlyUids: vi.fn<() => string[]>(),
  suppressed: vi.fn<() => Array<{ recipientUid: string; reason: 'duplicate' | 'prefs' | 'gate' }>>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
// #1511: the handler reads the detailed outcome. One counted mock answers both
// entry points, so every assertion below on `enqueue` still holds.
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: async (args: unknown) => ({
    written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
    suppressed: mocks.suppressed(),
    unresolved: [],
    appOnly: mocks.appOnlyUids(),
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createInvoiceHandler } from '../src/admin/createInvoice';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.appOnlyUids.mockReset().mockReturnValue([]);
  mocks.suppressed.mockReset().mockReturnValue([]);
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const validPayload = {
  familyId: 'fam1',
  kinfolkName: 'Smith Household',
  invoiceNumber: 'INV-001',
  client: 'Smith',
  address: '1 Main St',
  date: '2026-06-01',
  terms: 'Net 30',
  dueDate: '2026-07-01',
  discount: '0',
  total: 150.5,
  amountDue: 150.5,
  status: 'sent',
  // #1901: an invoice now claims the visits it names, and a visit with no record
  // is refused, so the shared fixture names none. Suites about visits seed them.
  sessionIds: [] as string[],
};

describe('createInvoice zod validation', () => {
  it('accepts a full valid payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBeTruthy();
  });

  // #408 CHANGED THIS. A blank invoice number used to be a refusal, because the
  // composer made the operator invent one. It now means "assign it", which is
  // what the composer sends on every new invoice. #1609 ruled the style: the
  // plain count continues (#1020 on) until 2027-01-01 in Chicago.
  it('assigns the next plain number when the caller sends a blank one, instead of refusing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T18:00:00Z'));
    try {
      const ctx = buildDbMock({
        queryDocs: {
          invoices: [
            { id: 'a', data: { invoiceNumber: '1019' } },
            { id: 'b', data: { invoiceNumber: 'INV-2026-0001' } },
            { id: 'c', data: {} },
          ],
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const res = await createInvoiceHandler(req({ ...validPayload, invoiceNumber: '' }));
      expect(res.ok).toBe(true);
      const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
      expect(written?.data.invoiceNumber).toBe('1020');
      expect(ctx.writes.find((w) => w.path === 'counters/invoiceNumber')?.data.nextPlain).toBe(1021);
    } finally {
      vi.useRealTimers();
    }
  });
  it('assigns a number when the caller omits the field entirely', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-01T18:00:00Z'));
    try {
      const { invoiceNumber: _omitted, ...noNumber } = validPayload;
      const ctx = buildDbMock({});
      mocks.dbFn.mockReturnValue(ctx.db);
      await createInvoiceHandler(req(noNumber));
      const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
      expect(written?.data.invoiceNumber).toBe('INV-2027-0001');
    } finally {
      vi.useRealTimers();
    }
  });
  it('continues the stored plain counter rather than starting over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T18:00:00Z'));
    try {
      const ctx = buildDbMock({ docs: { 'counters/invoiceNumber': { nextPlain: 1042 } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      await createInvoiceHandler(req({ ...validPayload, invoiceNumber: '' }));
      const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
      expect(written?.data.invoiceNumber).toBe('1042');
      // And the counter moved on, so the next invoice cannot be handed the same number.
      expect(ctx.writes.find((w) => w.path === 'counters/invoiceNumber')?.data.nextPlain).toBe(1043);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a number the caller did send, untouched', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...validPayload, invoiceNumber: 'INV-001' }));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.invoiceNumber).toBe('INV-001');
    // Nothing was drawn from the sequence for an invoice that named itself.
    expect(ctx.writes.find((w) => w.path === 'counters/invoiceNumber')).toBeUndefined();
  });
  it('#1609 refuses a typed number another invoice already holds', async () => {
    const ctx = buildDbMock({ queryDocs: { invoices: [{ id: 'other', data: { invoiceNumber: '1018' } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createInvoiceHandler(req({ ...validPayload, invoiceNumber: '1018' }))).rejects.toMatchObject({
      code: 'already-exists',
    });
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))).toBeUndefined();
  });
  it('rejects negative total', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createInvoiceHandler(req({ ...validPayload, total: -5 }))).rejects.toThrow();
  });

  it('rejects negative amountDue', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createInvoiceHandler(req({ ...validPayload, amountDue: -1 }))).rejects.toThrow();
  });

  it('rejects missing familyId', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { familyId, ...noFamily } = validPayload;
    await expect(createInvoiceHandler(req(noFamily))).rejects.toThrow();
  });

  // THE FIELD THE ADMIN LIST RANGE-QUERIES AND ORDERS ON. Firestore compares it
  // as a string, byte by byte, and every letter outranks every digit, so a
  // stored "Feb 12, 2026" satisfies `date >= '2026-07-05'` on its first
  // character and sorts above every real date. "Last 30 days" was listing
  // six-month-old invoices at the top of the page. `updateInvoice` has enforced
  // YYYY-MM-DD since W2-1; creation now states the same rule.
  describe('date and dueDate are days, not free text', () => {
    for (const field of ['date', 'dueDate'] as const) {
      it(`rejects a month-name ${field}`, async () => {
        const ctx = buildDbMock({});
        mocks.dbFn.mockReturnValue(ctx.db);
        await expect(
          createInvoiceHandler(req({ ...validPayload, [field]: 'Feb 12, 2026' })),
        ).rejects.toThrow();
      });

      it(`rejects a ${field} that is not a date at all`, async () => {
        const ctx = buildDbMock({});
        mocks.dbFn.mockReturnValue(ctx.db);
        await expect(
          createInvoiceHandler(req({ ...validPayload, [field]: 'Net 14' })),
        ).rejects.toThrow();
      });

      it(`still accepts a blank ${field}, which is the documented default`, async () => {
        // An invoice nobody has dated yet is a real thing, and inventing "today"
        // for it would be a fabricated fact on a bill. Every legacy caller omits
        // these fields and must keep working.
        const ctx = buildDbMock({});
        mocks.dbFn.mockReturnValue(ctx.db);
        await expect(
          createInvoiceHandler(req({ ...validPayload, [field]: '' })),
        ).resolves.toMatchObject({ ok: true });
      });
    }

    it('still accepts a payload that omits both fields entirely', async () => {
      const ctx = buildDbMock({});
      mocks.dbFn.mockReturnValue(ctx.db);
      const { date, dueDate, ...noDates } = validPayload;
      const res = await createInvoiceHandler(req(noDates));
      const write = ctx.writes.find((w) => w.path.startsWith('invoices/'));
      expect(res.ok).toBe(true);
      expect(write!.data.date).toBe('');
      expect(write!.data.dueDate).toBe('');
    });
  });
});

describe('#1593 a typed due date is on or after the invoice date', () => {
  it('refuses a due date before the invoice date, and writes nothing', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(req({ ...validPayload, date: '2026-06-10', dueDate: '2026-06-01' })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'The due date has to be on or after the invoice date.',
      details: { code: 'invoice_due_before_date', field: 'dueDate' },
    });
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/'))).toHaveLength(0);
  });
  it('takes a due date on the invoice date, and one after it', async () => {
    for (const dueDate of ['2026-06-10', '2026-06-11']) {
      const ctx = buildDbMock({});
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(createInvoiceHandler(req({ ...validPayload, date: '2026-06-10', dueDate }))).resolves.toMatchObject({ ok: true });
    }
  });
  it('a blank on either side is not judged', async () => {
    for (const pair of [{ date: '', dueDate: '2026-06-01' }, { date: '2026-06-10', dueDate: '' }]) {
      const ctx = buildDbMock({});
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(createInvoiceHandler(req({ ...validPayload, ...pair }))).resolves.toMatchObject({ ok: true });
    }
  });
  it('custom terms are a typed date too', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(req({ ...validPayload, termsCode: 'custom', date: '2026-06-10', dueDate: '2026-06-01' })),
    ).rejects.toMatchObject({ details: { code: 'invoice_due_before_date' } });
  });
});
describe('createInvoice handler effects', () => {
  it('stamps kinfolkId + server id + serverTimestamps on the new doc', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(write).toBeTruthy();
    expect(write!.data.kinfolkId).toBe('fam1');
    expect(write!.data._id).toBe(res.invoiceId);
    expect(write!.data.invoiceNumber).toBe('INV-001');
    expect(write!.data.total).toBe(150.5);
    expect(write!.data.createdAt).toBe('__TS__');
    expect(write!.data.updatedAt).toBe('__TS__');
  });

  it('writes a BILLING_INVOICE_CREATED audit entry', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(validPayload));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_INVOICE_CREATED', familyId: 'fam1', actorUid: 'admin1' }),
    );
  });

  it('enqueues invoice.new notification to the resolved kinfolk uid', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'kin-uid-1' }),
    );
    // #1511: a channel carried the household's copy.
    expect(res.appOnly).toBe(false);
  });

  it("#1513 an explicit draft stores as draft, enqueues nothing and says nothing about delivery", async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req({ ...validPayload, status: 'draft' }));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('draft');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('appOnly');
  });
  it.each(['sent', ''])("#1513 caller status %j canonicalizes to open and still notifies once", async (status) => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.appOnlyUids.mockReturnValue(['kin-uid-1']);
    const res = await createInvoiceHandler(req({ ...validPayload, status }));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('open');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'kin-uid-1' }),
    );
    expect(res.appOnly).toBe(true);
  });
  it('still returns ok when notification dispatch fails (swallowed + logged)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
    // #1511: no record was written, so the answer makes no claim about one.
    expect(res).not.toHaveProperty('appOnly');
  });

  // ── #1511: the notice that reached the household in the app only ──────────
  it('#1511 every channel off for the household: appOnly true', async () => {
    mocks.appOnlyUids.mockReturnValue(['kin-uid-1']);
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
    expect(res.appOnly).toBe(true);
  });

  it('#1511 the office copy having no channels is not the household copy having none', async () => {
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.appOnly).toBe(false);
  });

  it('#1511 no portal account: the office copy alone was written, so appOnly is omitted', async () => {
    mocks.resolveUid.mockResolvedValue(null);
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('appOnly');
  });

  it('#1511 a household copy the dispatcher held back has no delivery to describe', async () => {
    mocks.suppressed.mockReturnValue([{ recipientUid: 'kin-uid-1', reason: 'gate' }]);
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res).not.toHaveProperty('appOnly');
  });
});

describe('createInvoice state stamp (ADR-0002)', () => {
  it("persists the classifier's reading in the same write: a sent invoice stamps open/all", async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    // The caller's free-text 'sent' canonicalizes to what every classifier
    // already resolved it to: money owed on a non-draft doc is 'open'.
    expect(write.data.status).toBe('open');
    expect(write.data.editScope).toBe('all');
    // And the stored stamp IS the classifier's output for the doc as written.
    expect(invoiceStateStampOf(write.data, 0)).toEqual({ status: 'open', editScope: 'all' });
  });

  it('keeps an explicit draft a draft', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...validPayload, status: 'draft' }));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('draft');
    expect(write.data.editScope).toBe('all');
  });

  it('stamps an itemized zero-worth invoice zero/all, so it can receive its first real line', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...validPayload, status: '', total: 0, amountDue: 0, lineItems: [] }));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('zero');
    expect(write.data.editScope).toBe('all');
  });
});

/**
 * Task 5.1's additive `lineItems`.
 *
 * The first test here is the one that matters most: the legacy 13-key payload
 * every un-migrated caller still sends must keep behaving EXACTLY as it did,
 * which means no `lineItems: []` and no `totalCents: 0` appearing on the doc.
 * `updateInvoice`'s un-itemized guard reads the presence of `lineItems` to
 * decide whether recomputing is safe, so an empty array written here would
 * quietly re-arm the very bug that guard exists to prevent: a later due-date
 * edit would recompute a real invoice down to $0.
 */
describe('createInvoice line items', () => {
  const twoLines = [
    { description: 'Dog walk', qty: 3, unitCents: 2500 },
    { description: 'Overnight stay', qty: 1, unitCents: 8000, discountCents: 500 },
  ];
  // 3 x 2500 = 7500, plus 8000 - 500 = 7500 -> subtotal 15000
  const subtotalCents = 15000;

  it('writes NO cents fields at all for a legacy un-itemized payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data).not.toHaveProperty('lineItems');
    expect(write.data).not.toHaveProperty('totalCents');
    expect(write.data).not.toHaveProperty('subtotalCents');
    expect(write.data).not.toHaveProperty('amountDueCents');
    expect(write.data).not.toHaveProperty('invoiceDiscountCents');
    // And the caller's dollars are still stored verbatim.
    expect(write.data.total).toBe(150.5);
    expect(write.data.amountDue).toBe(150.5);
  });

  it('stores the lines and derives every cents figure from them', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.lineItems).toEqual(twoLines);
    expect(write.data.subtotalCents).toBe(subtotalCents);
    expect(write.data.totalCents).toBe(subtotalCents);
    expect(write.data.amountDueCents).toBe(subtotalCents);
    expect(write.data.invoiceDiscountCents).toBe(0);
  });

  it('projects the legacy dollar scalars from the same cents figures', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.total).toBe(150);
    expect(write.data.amountDue).toBe(150);
  });

  it('applies an invoice-level discount to the total but not the subtotal', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({
        ...validPayload,
        total: 130,
        amountDue: 130,
        lineItems: twoLines,
        invoiceDiscountCents: 2000,
      }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.subtotalCents).toBe(subtotalCents);
    expect(write.data.totalCents).toBe(subtotalCents - 2000);
    expect(write.data.total).toBe(130);
  });

  it('REFUSES a total that disagrees with the lines, naming both figures', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(req({ ...validPayload, total: 999, amountDue: 999, lineItems: twoLines })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_total_mismatch' },
      message: expect.stringContaining('$999.00'),
    });
    await expect(
      createInvoiceHandler(req({ ...validPayload, total: 999, amountDue: 999, lineItems: twoLines })),
    ).rejects.toMatchObject({ message: expect.stringContaining('$150.00') });
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))).toBeUndefined();
  });

  it('REFUSES an amountDue that disagrees with the lines', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(req({ ...validPayload, total: 150, amountDue: 10, lineItems: twoLines })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_amount_due_mismatch' },
    });
  });

  it('refuses a discount larger than the line it is taken off', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(
        req({
          ...validPayload,
          total: 0,
          amountDue: 0,
          lineItems: [{ description: 'Dog walk', qty: 1, unitCents: 2500, discountCents: 9999 }],
        }),
      ),
    ).rejects.toMatchObject({ details: { code: 'invoice_money_invalid' } });
  });

  it('refuses an invoice discount larger than the subtotal', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(
        req({ ...validPayload, total: 0, amountDue: 0, lineItems: twoLines, invoiceDiscountCents: 999_999 }),
      ),
    ).rejects.toMatchObject({ details: { code: 'invoice_money_invalid' } });
  });

  it('rejects a non-integer unitCents at the schema boundary', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(
        req({ ...validPayload, lineItems: [{ description: 'x', qty: 1, unitCents: 25.5 }] }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a blank line description at the schema boundary', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(req({ ...validPayload, lineItems: [{ description: '', qty: 1, unitCents: 100 }] })),
    ).rejects.toThrow();
  });

  it('records whether the invoice was itemized in the audit payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ itemized: true, lineCount: 2 }) }),
    );
  });

  it('an EMPTY lineItems array is an itemized invoice worth zero, not an un-itemized one', async () => {
    // Deliberate and tested: `[]` is the operator saying "this bills nothing",
    // which is a different statement from never having itemized it. The doc
    // gets the cents fields so `updateInvoice` may recompute it later, which is
    // what lets a blank invoice receive its first line.
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...validPayload, total: 0, amountDue: 0, lineItems: [] }));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.lineItems).toEqual([]);
    expect(write.data.totalCents).toBe(0);
    expect(write.data.total).toBe(0);
  });
});

/**
 * Structured terms (#408). The rule the operator picked decides the due date,
 * and the server resolves it from the visits it is actually linking, so the
 * invoice cannot state a due date its own terms do not support.
 */
describe('createInvoice structured terms', () => {
  const session = (startTime: string) => ({ kinfolkId: 'fam1', status: 'COMPLETED', startTime });
  it('writes the rule in words and the date it works out to', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, sessionIds: [], termsCode: 'net_14', dueDate: '', terms: 'ignored' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.terms).toBe('Due 14 days after the invoice date');
    expect(written?.data.termsCode).toBe('net_14');
    // 14 days after the invoice's own date, 2026-06-01.
    expect(written?.data.dueDate).toBe('2026-06-15');
  });
  it('counts service-relative terms from the LAST linked visit, read off the visits themselves', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': session('2026-06-02T14:00:00.000Z'),
        'kin_care_sessions/s2': session('2026-06-09T14:00:00.000Z'),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, sessionIds: ['s1', 's2'], termsCode: 'net_7_after_last_visit', dueDate: '' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.dueDate).toBe('2026-06-16');
    expect(written?.data.terms).toBe('Due 7 days after the last visit');
  });
  it('REFUSES a due date that disagrees with the terms, naming both dates', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createInvoiceHandler(
        req({ ...validPayload, sessionIds: [], termsCode: 'net_14', dueDate: '2026-07-01' }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('2026-06-15'),
    });
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))).toBeUndefined();
  });
  it('#1966: makes visit-relative terms on an invoice with no visits due on receipt, and says so', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, sessionIds: [], termsCode: 'net_14_after_last_visit', dueDate: '' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.dueDate).toBe('2026-06-01');
    expect(written?.data.termsCode).toBe('due_on_receipt');
    expect(written?.data.terms).toBe('Due on receipt');
  });
  it('#1966: counts an evening visit on its Chicago day, not its UTC day', async () => {
    const ctx = buildDbMock({
      docs: {
        // 7 PM on Nov 30 in Chicago.
        'kin_care_sessions/s1': session('2026-12-01T01:00:00.000Z'),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, date: '2026-12-01', sessionIds: ['s1'], termsCode: 'net_14_after_last_visit', dueDate: '' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.dueDate).toBe('2026-12-14');
  });
  it('#1966: counts visit days on the zone the business set', async () => {
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': { timeZone: 'Asia/Tokyo' },
        'kin_care_sessions/s1': session('2026-12-01T01:00:00.000Z'),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, date: '2026-12-01', sessionIds: ['s1'], termsCode: 'due_on_last_visit', dueDate: '' }),
    );
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))?.data.dueDate).toBe('2026-12-01');
  });
  it('#1966: counts before-first-visit terms back from the first visit, even before the invoice date', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': session('2026-06-04T14:00:00.000Z'),
        'kin_care_sessions/s2': session('2026-06-09T14:00:00.000Z'),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, sessionIds: ['s1', 's2'], termsCode: 'net_7_before_first_visit', dueDate: '' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    // 7 days before Jun 4. Structured terms are not judged against the invoice date.
    expect(written?.data.dueDate).toBe('2026-05-28');
    expect(written?.data.terms).toBe('Due 7 days before the first visit');
  });
  it('lets custom terms keep the operator typed date', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({ ...validPayload, sessionIds: [], termsCode: 'custom', dueDate: '2026-07-04' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.dueDate).toBe('2026-07-04');
    expect(written?.data.terms).toBe('Due by the date shown on this invoice');
  });
  it('stores free-text terms verbatim when no code is sent, exactly as it always did', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(validPayload));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.terms).toBe('Net 30');
    expect(written?.data.dueDate).toBe('2026-07-01');
    expect(written?.data.termsCode).toBeUndefined();
  });
});

/**
 * #1966: a caller that names no terms, no code and no due date gets the
 * business's Payment terms setting, so no new invoice is born without a date.
 */
describe('createInvoice payment terms setting', () => {
  const session = (startTime: string) => ({ kinfolkId: 'fam1', status: 'COMPLETED', startTime });
  const bare = { ...validPayload, terms: '', dueDate: '' };
  it('is due on receipt when the business has not set one', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(bare));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.termsCode).toBe('due_on_receipt');
    expect(written?.data.dueDate).toBe('2026-06-01');
  });
  it('uses the stored setting, counted from the visits', async () => {
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': { invoicePaymentTerms: 'net_14_after_last_visit' },
        'kin_care_sessions/s1': session('2026-06-02T14:00:00.000Z'),
        'kin_care_sessions/s2': session('2026-06-09T14:00:00.000Z'),
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...bare, sessionIds: ['s1', 's2'] }));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.termsCode).toBe('net_14_after_last_visit');
    expect(written?.data.terms).toBe('Due 14 days after the last visit');
    expect(written?.data.dueDate).toBe('2026-06-23');
  });
  it('reads a stored value that is not a setting option as due on receipt', async () => {
    const ctx = buildDbMock({ docs: { 'business_settings/business_settings': { invoicePaymentTerms: 'custom' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req(bare));
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))?.data.termsCode).toBe('due_on_receipt');
  });
  it('never overrides a code the composer sent', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { invoicePaymentTerms: 'net_30_after_last_visit' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(req({ ...bare, termsCode: 'custom', dueDate: '2026-06-20' }));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.termsCode).toBe('custom');
    expect(written?.data.dueDate).toBe('2026-06-20');
  });
});
/** #408: a line drawn from a visit stays bound to it. */
describe('createInvoice bound line items', () => {
  it('stores the session a line was drawn from', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': { kinfolkId: 'fam1', status: 'COMPLETED' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createInvoiceHandler(
      req({
        ...validPayload,
        total: 25,
        amountDue: 25,
        lineItems: [{ description: 'Dog walking, 2026-06-02', qty: 1, unitCents: 2500, sessionId: 's1' }],
      }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect((written?.data.lineItems as any[])[0].sessionId).toBe('s1');
  });
});
