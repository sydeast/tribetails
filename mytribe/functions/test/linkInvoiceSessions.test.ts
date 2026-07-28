import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

/** A staff request unless a token is given (test admins carry testTribeId, no admin). */
function req(
  data: unknown,
  uid: string | null = 'admin1',
  token: Record<string, unknown> = { admin: true },
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(opts: {
  invoice?: Record<string, unknown> | null;
  sessions?: Record<string, Record<string, unknown> | null>;
  payments?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  const invoice =
    opts.invoice === undefined
      ? { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40, sessionIds: [] }
      : opts.invoice;
  const docs: Record<string, Record<string, unknown> | null> = { 'invoices/inv1': invoice };
  for (const [sid, data] of Object.entries(opts.sessions ?? {})) {
    docs[`kin_care_sessions/${sid}`] = data;
  }
  return buildDbMock({
    docs,
    queryDocs: { 'invoices/inv1/payments': opts.payments ?? [] },
  });
}

const session = (kinfolkId = 'fam1', extra: Record<string, unknown> = {}) => ({
  kinfolkId,
  status: 'COMPLETED',
  ...extra,
});

function writeAt(ctx: ReturnType<typeof seed>, path: string) {
  return ctx.writes.find((w) => w.path === path);
}

describe('linkInvoiceSessions link', () => {
  it('writes the invoice set and stamps each added session, atomically in one call', async () => {
    const ctx = seed({ sessions: { s1: session(), s2: session() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1', 's2'] }));
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(['s1', 's2']);
    expect(res.removed).toEqual([]);

    const inv = writeAt(ctx, 'invoices/inv1');
    expect(inv?.merge).toBe(true);
    expect(inv?.data.sessionIds).toEqual(['s1', 's2']);
    expect(inv?.data._attribution).toBe('manual');
    // ISO-8601 STRING, never a Timestamp: android's Invoice model decodes
    // _attributionAt as a non-null Kotlin String (Class B decode crash).
    expect(typeof inv?.data._attributionAt).toBe('string');
    expect(inv?.data.updatedAt).toBe('__TS__');

    for (const sid of ['s1', 's2']) {
      const w = writeAt(ctx, `kin_care_sessions/${sid}`);
      expect(w?.data.invoiceId).toBe('inv1');
      expect(w?.data._attribution).toBe('manual');
      expect(typeof w?.data._attributionAt).toBe('string');
      expect(w?.data.updatedAt).toBe('__TS__');
    }
  });

  it('collapses duplicate ids in the request', async () => {
    const ctx = seed({ sessions: { s1: session() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1', 's1'] }));
    expect(res.sessionIds).toEqual(['s1']);
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual(['s1']);
  });

  it('leaves a session that stays in the set untouched', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, sessionIds: ['s1'] },
      sessions: { s2: session() },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1', 's2'] }));
    expect(res.added).toEqual(['s2']);
    expect(res.removed).toEqual([]);
    expect(writeAt(ctx, 'kin_care_sessions/s1')).toBeUndefined();
    expect(writeAt(ctx, 'kin_care_sessions/s2')?.data.invoiceId).toBe('inv1');
  });
});

describe('linkInvoiceSessions unlink', () => {
  it('clears a dropped session with the manual_unlink stamp and EMPTY-STRING invoiceId', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, sessionIds: ['s1', 's2'] },
      sessions: { s2: session('fam1', { invoiceId: 'inv1' }) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(res.removed).toEqual(['s2']);
    const w = writeAt(ctx, 'kin_care_sessions/s2');
    // '' and not a field delete: listUninvoicedSessions treats absent, empty
    // and whitespace as ONE unclaimed state.
    expect(w?.data.invoiceId).toBe('');
    expect(w?.data._attribution).toBe('manual_unlink');
    // The INVOICE still says 'manual' on an unlink, as android writes today.
    expect(writeAt(ctx, 'invoices/inv1')?.data._attribution).toBe('manual');
  });

  it('an empty set unlinks everything', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, sessionIds: ['s1', 's2'] },
      sessions: { s1: session('fam1'), s2: session('fam1') },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }));
    expect(res.removed).toEqual(['s1', 's2']);
    expect(writeAt(ctx, 'invoices/inv1')?.data.sessionIds).toEqual([]);
    expect(writeAt(ctx, 'kin_care_sessions/s1')?.data._attribution).toBe('manual_unlink');
    expect(writeAt(ctx, 'kin_care_sessions/s2')?.data._attribution).toBe('manual_unlink');
  });
});

describe('linkInvoiceSessions atomicity', () => {
  it('a missing session refuses the WHOLE write: nothing lands anywhere', async () => {
    const ctx = seed({ sessions: { s1: session() } }); // s2 does not exist
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1', 's2'] })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'session_not_found', missing: ['s2'] } });
    expect(ctx.writes).toEqual([]);
  });

  it('an unknown invoice is not-found, and nothing is written', async () => {
    const ctx = seed({ invoice: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] })),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.writes).toEqual([]);
  });
});

describe('linkInvoiceSessions state persist (ADR-0002)', () => {
  it('persists the classifier status + editScope on the invoice, normalizing casing', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'QUOTE', amountDue: 40, total: 40, sessionIds: [] },
      sessions: { s1: session() },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(res.status).toBe('quote');
    expect(res.editScope).toBe('all');
    const inv = writeAt(ctx, 'invoices/inv1');
    expect(inv?.data.status).toBe('quote');
    expect(inv?.data.editScope).toBe('all');
  });

  it('a settled invoice persists editScope metadataOnly (standing read from the payments subcollection)', async () => {
    // The `amountDue` SCALAR still claims a balance; the subcollection says
    // settled. The classifier reads the scalar (state 'open') while the
    // standing reads the payments. 'open' + settled is exactly the
    // metadataOnly cell of invoiceEditScope.
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, totalCents: 4000, sessionIds: [] },
      sessions: { s1: session() },
      payments: [{ id: 'p1', data: { amountCents: 4000 } }],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(res.editScope).toBe('metadataOnly');
    expect(writeAt(ctx, 'invoices/inv1')?.data.editScope).toBe('metadataOnly');
    // Linking is deliberately NOT gated on scope: the link moves no money.
    expect(writeAt(ctx, 'kin_care_sessions/s1')?.data.invoiceId).toBe('inv1');
  });
});

describe('linkInvoiceSessions TestMode scoping (server-side)', () => {
  const testToken = { testTribeId: 'test-kinfolk-001' };

  it('a test admin may link inside their sandbox', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'test-kinfolk-001', status: 'open', amountDue: 40, total: 40, sessionIds: [] },
      sessions: { s1: session('test-kinfolk-001') },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(
      req({ invoiceId: 'inv1', sessionIds: ['s1'] }, 'testuser1', testToken),
    );
    expect(res.ok).toBe(true);
    expect(writeAt(ctx, 'kin_care_sessions/s1')?.data.invoiceId).toBe('inv1');
  });

  it("refuses a test admin touching another household's invoice, writing nothing", async () => {
    const ctx = seed(); // invoice belongs to fam1
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }, 'testuser1', testToken)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it("refuses a test admin linking a live household's session, writing nothing", async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'test-kinfolk-001', status: 'open', amountDue: 40, total: 40, sessionIds: [] },
      sessions: { s1: session('fam1') }, // live data
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }, 'testuser1', testToken)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('staff are unscoped (kinfolkId is not compared on the staff path)', async () => {
    const ctx = seed({ sessions: { s1: session('some-other-fam') } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(res.ok).toBe(true);
  });
});

describe('linkInvoiceSessions gate + validation', () => {
  it('refuses an unauthenticated call', async () => {
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a caller with neither the admin claim nor a test claim', async () => {
    await expect(
      linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }, 'someone', {})),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a malformed request', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const bad of [
      {},
      { invoiceId: '', sessionIds: [] },
      { invoiceId: 'inv1' },
      { invoiceId: 'inv1', sessionIds: [''] },
      { invoiceId: 'inv1', sessionIds: 's1' },
    ]) {
      await expect(linkInvoiceSessionsHandler(req(bad))).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
  });

  it('writes the audit entry with the delta and the persisted state', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, sessionIds: ['s2'] },
      sessions: { s1: session(), s2: session() },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: ['s1'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_INVOICE_SESSIONS_LINKED',
        familyId: 'fam1',
        payload: expect.objectContaining({
          invoiceId: 'inv1',
          added: ['s1'],
          removed: ['s2'],
          status: 'open',
          editScope: 'all',
          testMode: false,
        }),
      }),
    );
  });
});
