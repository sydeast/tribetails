import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { BUSINESS_SETTINGS_DOC } from '../src/lib/businessHours';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), recipient: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: mocks.recipient }));

import { previewInvoiceNoticeHandler } from '../src/admin/previewInvoiceNotice';

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as never,
    rawRequest: {} as never,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const INVOICE = { kinfolkId: 'fam1', kinfolkName: 'The Wrens', invoiceNumber: '1020', status: 'open' };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.recipient.mockReset();
});

/** #1609: the confirm says which person and which channel. */
describe('previewInvoiceNotice', () => {
  it('names the billing recipient and the channels the dispatcher would use, with the addresses on file', async () => {
    mocks.recipient.mockResolvedValue('u-wren');
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': INVOICE,
        'clients/u-wren': {
          displayName: 'Robin Wren',
          email: 'catch@hanasamku.com',
          phone: '',
          notificationPrefs: {},
        },
        [BUSINESS_SETTINGS_DOC]: { householdNotificationsLive: true },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await previewInvoiceNoticeHandler(req({ invoiceId: 'inv1', action: 'reminder' }));
    expect(res).toMatchObject({
      ok: true,
      key: 'invoice.reminder',
      hasRecipient: true,
      recipientName: 'Robin Wren',
      email: { on: true, address: 'catch@hanasamku.com' },
      disabled: null,
      householdGateLive: true,
    });
    // Nothing was written.
    expect(ctx.writes).toEqual([]);
  });

  it('says the gate is closed when household notices are not live yet', async () => {
    mocks.recipient.mockResolvedValue('u-wren');
    const ctx = buildDbMock({
      // The mock seeds the gate open unless the settings doc is given; shut it.
      docs: {
        'invoices/inv1': INVOICE,
        'clients/u-wren': { email: 'catch@hanasamku.com' },
        [BUSINESS_SETTINGS_DOC]: { householdNotificationsLive: false },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await previewInvoiceNoticeHandler(req({ invoiceId: 'inv1', action: 'reviewSend' }));
    expect(res.key).toBe('invoice.new');
    expect(res.householdGateLive).toBe(false);
    // No displayName on the account: the invoice's household name stands in.
    expect(res.recipientName).toBe('The Wrens');
  });

  it('reports no recipient rather than inventing one', async () => {
    mocks.recipient.mockResolvedValue(null);
    const ctx = buildDbMock({ docs: { 'invoices/inv1': INVOICE } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await previewInvoiceNoticeHandler(req({ invoiceId: 'inv1', action: 'reminder' }));
    expect(res).toMatchObject({ hasRecipient: false, email: { on: false }, sms: { on: false }, push: { on: false } });
  });

  it('is not-found for an unknown invoice', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(previewInvoiceNoticeHandler(req({ invoiceId: 'nope', action: 'reminder' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
