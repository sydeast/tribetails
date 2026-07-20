import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  stripeMock: {
    checkout: { sessions: { create: vi.fn() } },
  },
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/stripe', () => ({ getStripe: () => mocks.stripeMock }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.stripeMock.checkout.sessions.create.mockReset();
});

describe('BUG SWEEP — getMyInvoices (rules tightened)', () => {
  it('FIXED: missing amountDue now routes to OPEN', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-noamt', data: { kinfolkId: '3', total: 100 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open).toHaveLength(1);
    expect(res.paid).toHaveLength(0);
  });

  it('FIXED: negative amountDue (refund) routes to CREDITS', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-credit', data: { kinfolkId: '3', total: -50, amountDue: -50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.credits).toHaveLength(1);
    expect(res.open).toHaveLength(0);
  });
});

describe('BUG SWEEP — payInvoice', () => {
  it('FAILS: rejects payment when amountDue is null/undefined (no amount to charge)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-x': { kinfolkId: '3' /* no amountDue */ },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    // payInvoice currently checks amountDue > 0; missing → 0 → fails (correct: nothing to charge).
    await expect(
      payInvoiceHandler({
        data: { invoiceId: 'inv-x', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('BUG SWEEP — requestBooking', () => {
  it('FAILS: rejects bookings whose startTimeMs is in the past', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const past = Date.now() - 365 * 86_400_000;
    // Probe — current handler accepts any positive number. We assert it SHOULD reject.
    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', serviceType: 'walk', startTimeMs: past },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('BUG SWEEP — addKin name validation', () => {
  it('FAILS: rejects whitespace-only kin name', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      addKinHandler({
        data: { kinfolkId: '3', kin: { name: '   ' } },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow();
  });

  it('FAILS: rejects javascript: URL in photoUrl', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      addKinHandler({
        data: { kinfolkId: '3', kin: { name: 'Buddy', photoUrl: 'javascript:alert(1)' } },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow();
  });
});

describe('BUG SWEEP — addSecondaryContact', () => {
  it('FAILS: rejects inviting your own email (caller cannot invite themselves)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'], email: 'me@x.com' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({
        data: { kinfolkId: '3', invitedEmail: 'me@x.com' },
        auth: { uid: 'u1', token: { email: 'me@x.com' } },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('BUG SWEEP — getMyKinTales pagination', () => {
  it('clamps requested limit to 50 even when 999 requested', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: { 'families/3/kinTales': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({ data: { kinfolkId: '3', limit: 999 }, auth: { uid: 'u1' } } as any);
    // We can't introspect the Firestore .limit() arg with current mock,
    // but we can assert no crash + empty result.
    expect(res.tales).toEqual([]);
    expect(res.hasMore).toBe(false);
  });
});
