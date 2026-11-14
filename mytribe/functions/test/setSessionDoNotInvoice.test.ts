import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { setSessionDoNotInvoiceHandler } from '../src/admin/setSessionDoNotInvoice';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

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

const visit = (extra: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  status: 'COMPLETED',
  startTime: '2026-07-10T14:00:00Z',
  ...extra,
});

function seed(
  sessions: Record<string, Record<string, unknown> | null>,
  extra: Record<string, Record<string, unknown> | null> = {},
) {
  const docs: Record<string, Record<string, unknown> | null> = { ...extra };
  for (const [id, data] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = data;
  return buildDbMock({ docs });
}

function writeAt(ctx: ReturnType<typeof seed>, id: string) {
  return ctx.writes.find((w) => w.path === `kin_care_sessions/${id}`);
}

describe('setSessionDoNotInvoice marking', () => {
  it('flags the visit, keeps the reason, and records who decided', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(
      req({ sessionIds: ['s1'], doNotInvoice: true, reason: 'Comped after the late arrival' }),
    );

    expect(res).toMatchObject({ ok: true, doNotInvoice: true, changed: ['s1'], unchanged: [] });
    const write = writeAt(ctx, 's1');
    expect(write?.merge).toBe(true);
    expect(write?.data).toMatchObject({
      doNotInvoice: true,
      doNotInvoiceReason: 'Comped after the late arrival',
      doNotInvoiceBy: 'admin1',
    });
    // Nothing else on the visit is touched: this is a decision about billing,
    // not an edit to the work.
    expect(write?.data).not.toHaveProperty('status');
  });

  it('marks a whole selection in one call', async () => {
    const ctx = seed({ s1: visit(), s2: visit(), s3: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(
      req({ sessionIds: ['s1', 's2', 's3'], doNotInvoice: true }),
    );

    expect(res.changed).toEqual(['s1', 's2', 's3']);
    expect(['s1', 's2', 's3'].every((id) => writeAt(ctx, id)?.data.doNotInvoice === true)).toBe(true);
  });

  it('counts the same id twice as one visit', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1', 's1'], doNotInvoice: true }));

    expect(res.changed).toEqual(['s1']);
  });

  it('reports a visit already in the requested state as unchanged, not as an error', async () => {
    const ctx = seed({ s1: visit({ doNotInvoice: true }), s2: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1', 's2'], doNotInvoice: true }));

    expect(res.changed).toEqual(['s2']);
    expect(res.unchanged).toEqual(['s1']);
    expect(writeAt(ctx, 's1')).toBeUndefined();
  });
});

describe('setSessionDoNotInvoice reversal', () => {
  it('puts a visit back in the queue and clears the reason with it', async () => {
    const ctx = seed({ s1: visit({ doNotInvoice: true, doNotInvoiceReason: 'Comped' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: false }));

    expect(res).toMatchObject({ ok: true, doNotInvoice: false, changed: ['s1'] });
    expect(writeAt(ctx, 's1')?.data).toMatchObject({
      doNotInvoice: false,
      doNotInvoiceReason: '',
      doNotInvoiceClearedBy: 'admin1',
    });
  });

  it('undoes the flag on a visit that has since been invoiced, rather than stranding it', async () => {
    // Excluding a billed visit is refused; UNDOING an exclusion on one is
    // harmless, because the invoice already keeps it out of the queue.
    const ctx = seed({ s1: visit({ doNotInvoice: true, invoiceId: 'inv1' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: false }));

    expect(res.changed).toEqual(['s1']);
  });
});

describe('setSessionDoNotInvoice refusals', () => {
  it('#2196: REFUSES to exclude a visit an invoice already bills for, naming the invoice by its number, never its id', async () => {
    const ctx = seed({ s1: visit({ invoiceId: 'inv_42' }) }, { 'invoices/inv_42': { status: 'open', invoiceNumber: '1042' } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true })).catch((e) => e);

    expect(err).toMatchObject({
      code: 'failed-precondition',
      details: { code: 'session_already_invoiced', sessionIds: ['s1'] },
    });
    expect(err.message).toBe(
      'That visit is billed on invoice 1042, so it cannot be marked do not invoice. Unlink it from that invoice first, then mark it.',
    );
    expect(err.message).not.toContain('inv_42');
    expect(ctx.writes).toHaveLength(0);
  });

  it('#2196: a visit a QUOTE holds is "on quote N", never "billed"', async () => {
    const ctx = seed({ s1: visit({ invoiceId: 'q_9' }) }, { 'invoices/q_9': { status: 'quote', invoiceNumber: '1026' } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true })).catch((e) => e);

    expect(err.message).toBe(
      'That visit is on quote 1026, so it cannot be marked do not invoice. Remove its line from that quote first, then mark it.',
    );
    expect(err.message).not.toMatch(/billed/);
    expect(err.message).not.toContain('q_9');
  });

  it('#2196: a quote saved unsent is a quote too, and one with no number is "another quote"', async () => {
    const ctx = seed({ s1: visit({ invoiceId: 'q_10' }) }, { 'invoices/q_10': { status: 'draft', quoteDraft: true } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true })).catch((e) => e);

    expect(err.message).toBe(
      'That visit is on another quote, so it cannot be marked do not invoice. Remove its line from that quote first, then mark it.',
    );
  });

  it('#2196: an invoice with no record is "another invoice", never its id', async () => {
    const ctx = seed({ s1: visit({ invoiceId: 'gone_1' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true })).catch((e) => e);

    expect(err.message).toBe(
      'That visit is billed on another invoice, so it cannot be marked do not invoice. Unlink it from that invoice first, then mark it.',
    );
  });

  it('#2196: a batch held by a quote and an invoice names the first by number and neither id', async () => {
    const ctx = seed(
      { s1: visit({ invoiceId: 'q_9' }), s2: visit({ invoiceId: 'inv_42' }) },
      {
        'invoices/q_9': { status: 'quote', invoiceNumber: '1026' },
        'invoices/inv_42': { status: 'open', invoiceNumber: '1042' },
      },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1', 's2'], doNotInvoice: true })).catch((e) => e);

    expect(err.message).toBe(
      '2 of these visits are already on other invoices or quotes (the first is on quote 1026), so nothing was changed. Take them off there first, then mark them.',
    );
    expect(err.message).not.toMatch(/q_9|inv_42/);
  });

  it('writes NOTHING when one visit of a batch is already billed', async () => {
    // A half-applied selection leaves the operator guessing which half took.
    const ctx = seed({ s1: visit(), s2: visit({ invoiceId: 'inv_7' }), s3: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1', 's2', 's3'], doNotInvoice: true })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a visit that no longer exists, with its id in details and not in the sentence (#2196)', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1', 'ghost'], doNotInvoice: true })).catch(
      (e) => e,
    );

    expect(err).toMatchObject({ code: 'not-found', details: { code: 'session_not_found', sessionIds: ['ghost'] } });
    expect(err.message).toBe('That visit no longer exists, so nothing was changed. Refresh the list and try again.');
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects an empty selection and an over-long one', async () => {
    const ctx = seed({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setSessionDoNotInvoiceHandler(req({ sessionIds: [], doNotInvoice: true })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      setSessionDoNotInvoiceHandler(
        req({ sessionIds: Array.from({ length: 101 }, (_, i) => `s${String(i)}`), doNotInvoice: true }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a payload that does not say which way it is going', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'] })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('is unauthenticated with no caller and permission-denied for a non-admin', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    const guarded = wrapAdminCallable('setSessionDoNotInvoice', setSessionDoNotInvoiceHandler);
    await expect(
      guarded({
        data: { sessionIds: ['s1'], doNotInvoice: true },
        auth: { uid: 'kinfolk-9', token: {} },
      } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('setSessionDoNotInvoice audit trail', () => {
  it('logs the two directions under two different events, so the trail is queryable', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true, reason: 'Duplicate' }));
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({
      event: AUDIT_EVENTS.BILLING_SESSION_DO_NOT_INVOICE_SET,
      actorUid: 'admin1',
    });

    (writeAuditEntry as any).mockClear();
    const ctx2 = seed({ s1: visit({ doNotInvoice: true }) });
    mocks.dbFn.mockReturnValue(ctx2.db);
    await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: false }));
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({
      event: AUDIT_EVENTS.BILLING_SESSION_DO_NOT_INVOICE_CLEARED,
    });
  });

  it('records the decision even when the audit write itself fails', async () => {
    // The visit is what the operator changed; losing the trail must not lose
    // the change or fail a call that already committed.
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    (writeAuditEntry as any).mockRejectedValueOnce(new Error('audit down'));

    const res = await setSessionDoNotInvoiceHandler(req({ sessionIds: ['s1'], doNotInvoice: true }));

    expect(res.ok).toBe(true);
    expect(writeAt(ctx, 's1')?.data.doNotInvoice).toBe(true);
  });
});
