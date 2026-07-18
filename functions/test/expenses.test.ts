import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__TS__' } }));

import {
  LogExpenseArgs,
  summarizeExpenses,
  logExpenseHandler,
  listExpensesHandler,
  type ExpenseRow,
} from '../src/admin/expenses';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

function req(data: unknown, uid: string | null = 'auntie-1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

describe('LogExpenseArgs validation', () => {
  it('accepts a valid gas expense', () => {
    expect(LogExpenseArgs.safeParse({ kind: 'gas', amountCents: 4200 }).success).toBe(true);
  });
  it('rejects a bad kind', () => {
    expect(LogExpenseArgs.safeParse({ kind: 'rent', amountCents: 100 }).success).toBe(false);
  });
  it('rejects a non-positive / non-integer amount', () => {
    expect(LogExpenseArgs.safeParse({ kind: 'gas', amountCents: 0 }).success).toBe(false);
    expect(LogExpenseArgs.safeParse({ kind: 'gas', amountCents: 12.5 }).success).toBe(false);
  });
});

describe('summarizeExpenses (pure)', () => {
  const now = Date.parse('2026-07-18T12:00:00Z');
  const rows: ExpenseRow[] = [
    { _id: 'a', kind: 'gas', amountCents: 1000, note: '', occurredAt: '2026-07-18T09:00:00Z' }, // today
    { _id: 'b', kind: 'parking', amountCents: 500, note: '', occurredAt: '2026-07-14T09:00:00Z' }, // 4d ago
    { _id: 'c', kind: 'other', amountCents: 300, note: '', occurredAt: '2026-07-01T09:00:00Z' }, // 17d ago
    { _id: 'd', kind: 'supplies', amountCents: 999, note: '', occurredAt: '2026-05-01T09:00:00Z' }, // >30d ago
  ];
  it('sums the trailing 7-day and 30-day windows, excluding older', () => {
    const { weekTotalCents, monthTotalCents } = summarizeExpenses(rows, now);
    expect(weekTotalCents).toBe(1500); // a + b
    expect(monthTotalCents).toBe(1800); // a + b + c, not d
  });
});

describe('logExpenseHandler', () => {
  it('writes an expense and returns its id', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await logExpenseHandler(req({ kind: 'gas', amountCents: 4200, note: 'fill up', occurredAt: '2026-07-18T09:00:00Z' }));
    expect(res.id).toBeTruthy();
    const w = ctx.writes.find((x) => x.path.startsWith('expenses/'));
    expect(w?.data.kind).toBe('gas');
    expect(w?.data.amountCents).toBe(4200);
    expect(w?.data.occurredAt).toBe('2026-07-18T09:00:00Z');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'EXPENSE_LOGGED' }));
  });

  it('defaults occurredAt to now when omitted', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await logExpenseHandler(req({ kind: 'parking', amountCents: 200 }));
    const w = ctx.writes.find((x) => x.path.startsWith('expenses/'));
    expect(typeof w?.data.occurredAt).toBe('string');
    expect(Number.isNaN(Date.parse(w?.data.occurredAt as string))).toBe(false);
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(logExpenseHandler(req({ kind: 'gas', amountCents: 1 }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects invalid args with invalid-argument', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(logExpenseHandler(req({ kind: 'bad', amountCents: 1 }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('listExpensesHandler', () => {
  it('returns rows plus week/month totals', async () => {
    const nowIso = new Date().toISOString();
    const ctx = buildDbMock({
      queryDocs: {
        expenses: [
          { id: 'a', data: { kind: 'gas', amountCents: 1000, note: 'x', occurredAt: nowIso } },
          { id: 'b', data: { kind: 'other', amountCents: 500, note: '', occurredAt: nowIso } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listExpensesHandler(req({}));
    expect(res.expenses.length).toBe(2);
    expect(res.expenses[0]).toHaveProperty('_id');
    expect(res.weekTotalCents).toBe(1500);
    expect(res.monthTotalCents).toBe(1500);
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(listExpensesHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
