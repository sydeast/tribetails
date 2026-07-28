import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

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
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
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
  sessionIds: ['s1', 's2'],
};

describe('createInvoice zod validation', () => {
  it('accepts a full valid payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBeTruthy();
  });

  it('rejects blank invoiceNumber', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createInvoiceHandler(req({ ...validPayload, invoiceNumber: '' }))).rejects.toThrow();
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
    await createInvoiceHandler(req(validPayload));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'kin-uid-1' }),
    );
  });

  it('still returns ok when notification dispatch fails (swallowed + logged)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const res = await createInvoiceHandler(req(validPayload));
    expect(res.ok).toBe(true);
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
