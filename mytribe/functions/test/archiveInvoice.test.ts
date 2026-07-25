import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { archiveInvoiceHandler } from '../src/admin/archiveInvoice';
import { unarchiveInvoiceHandler } from '../src/admin/unarchiveInvoice';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(invoice: Record<string, unknown> | null) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}

const PAID = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'paid', amountDue: 0, total: 40 };
const OPEN_OWING = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40 };
const DRAFT = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', amountDue: 40, total: 40 };

function write(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'invoices/inv1');
}

describe('archiveInvoice', () => {
  it('stamps archivedAt and archivedBy on a settled invoice', async () => {
    const ctx = seed(PAID);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await archiveInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    expect(write(ctx)!.data.archivedAt).toBe('__TS__');
    expect(write(ctx)!.data.archivedBy).toBe('admin1');
  });

  it('archives a draft even though it carries a balance', async () => {
    // A draft was never sent, so its "balance" was never claimed from anyone.
    // Abandoning one is routine and must not need a force flag.
    const ctx = seed(DRAFT);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).resolves.toMatchObject({ ok: true });
  });

  it('REFUSES to archive a sent invoice that still has money owed', async () => {
    const ctx = seed(OPEN_OWING);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_still_owing' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('names the outstanding amount in the refusal', async () => {
    const ctx = seed(OPEN_OWING);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow(/40\.00/);
  });

  it('allows it with force: true, and records that it was forced', async () => {
    const ctx = seed(OPEN_OWING);
    mocks.dbFn.mockReturnValue(ctx.db);

    await archiveInvoiceHandler(req({ invoiceId: 'inv1', force: true }));
    expect(write(ctx)!.data.archivedAt).toBe('__TS__');
    // Forcing is writing off real money, so the audit must be able to tell a
    // forced archive from an ordinary one.
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_INVOICE_ARCHIVED',
        payload: expect.objectContaining({ forced: true }),
      }),
    );
  });

  it('refuses to archive an already-archived invoice rather than restamping it', async () => {
    const ctx = seed({ ...PAID, archivedAt: 'already' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_already_archived' },
    });
  });

  it('treats a null archivedAt as not archived', async () => {
    // unarchiveInvoice writes null rather than deleting the field, so a restored
    // invoice must be archivable again.
    const ctx = seed({ ...PAID, archivedAt: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).resolves.toMatchObject({ ok: true });
  });

  it('rejects a missing invoiceId, an unknown id, and an unauthenticated caller', async () => {
    const ctx = seed(PAID);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(archiveInvoiceHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    const missing = seed(null);
    mocks.dbFn.mockReturnValue(missing.db);
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a signed-in non-admin through the wrapper', async () => {
    const ctx = seed(PAID);
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('archiveInvoice', archiveInvoiceHandler);
    await expect(
      guarded({
        data: { invoiceId: 'inv1' },
        auth: { uid: 'kinfolk-9', token: {} },
      } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('unarchiveInvoice', () => {
  it('clears archivedAt by writing null, not by deleting the field', async () => {
    // Null rather than a field delete so a future backfill has ONE shape to
    // converge on, and because the admin's isArchivedInvoice already reads null
    // as "not archived".
    const ctx = seed({ ...PAID, archivedAt: 'stamped', archivedBy: 'admin1' });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await unarchiveInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    expect(write(ctx)!.data.archivedAt).toBeNull();
    expect(write(ctx)!.data.archivedBy).toBeNull();
  });

  it('writes a BILLING_INVOICE_UNARCHIVED audit entry', async () => {
    const ctx = seed({ ...PAID, archivedAt: 'stamped' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await unarchiveInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_INVOICE_UNARCHIVED' }),
    );
  });

  it('refuses to restore an invoice that was never archived', async () => {
    const ctx = seed(PAID);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(unarchiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_not_archived' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects a missing invoiceId, an unknown id, and an unauthenticated caller', async () => {
    const ctx = seed({ ...PAID, archivedAt: 'stamped' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(unarchiveInvoiceHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(unarchiveInvoiceHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    const missing = seed(null);
    mocks.dbFn.mockReturnValue(missing.db);
    await expect(unarchiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a signed-in non-admin through the wrapper', async () => {
    const ctx = seed({ ...PAID, archivedAt: 'stamped' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('unarchiveInvoice', unarchiveInvoiceHandler);
    await expect(
      guarded({
        data: { invoiceId: 'inv1' },
        auth: { uid: 'kinfolk-9', token: {} },
      } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
