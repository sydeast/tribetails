import { describe, it, expect, vi } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #866 fourth review: `reviewAndSendDraftInvoice` over the REAL dispatcher when
 * the only thing that fails is the office roster read.
 *
 * This callable does not catch its dispatch: a throw leaves the invoice a draft,
 * on purpose, so the admin sees the send did not happen. For a while #866 made
 * a failed roster read throw even though the household resolved, which turned
 * "the office could not be told" into "the invoice was not sent". The household
 * copy goes out and the invoice is sent, as on main; the office miss is logged.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';

function req(): CallableRequest<unknown> {
  return {
    data: { invoiceId: 'inv1' },
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('reviewAndSendDraftInvoice when only the office roster read fails', () => {
  it('still sends the invoice and delivers the household invoice.new', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40 } },
    });
    const readError = Object.assign(new Error('14 UNAVAILABLE: deadline exceeded'), { code: 14 });
    mocks.dbFn.mockReturnValue({
      ...ctx.db,
      collection: (path: string) => {
        const real = ctx.db.collection(path);
        if (path !== 'businessSettings') return real;
        return { ...real, doc: (id?: string) => (id === 'admins' ? { get: async () => { throw readError; } } : real.doc(id)) };
      },
    });

    await expect(reviewAndSendDraftInvoiceHandler(req())).resolves.toEqual({ ok: true, invoiceId: 'inv1' });

    const household = ctx.writes.filter(
      (w) => w.path.startsWith('notifications/') && w.data.key === 'invoice.new' && w.data.recipientUid === 'kin-uid-1',
    );
    expect(household).toHaveLength(1);
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1' && w.data.status === 'open')).toBeTruthy();
  });
});
