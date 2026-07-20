import { call } from '../lib/fns';

/**
 * AO-40 Expense Quick-Log. Two admin-gated MyTribe callables over the new
 * top-level `expenses` collection (admin-only read+write in firestore.rules,
 * mirroring the other admin-only collections). Shapes are fixed by the
 * dashboard fan-out contract (WIDGET_FANOUT_SPEC.md) so web, desktop and android
 * all call the same thing; deviating here would break parity.
 *
 * `amountCents` is an integer count of cents (never a float dollar amount), the
 * same money convention the invoice backend uses; format it through
 * `lib/dashboardInsights.ts#formatCents`, never a raw division at the call site.
 * `occurredAt` is a free-text ISO instant string, not a Firestore Timestamp.
 */

/** The four expense buckets the quick-log offers. Free-text on the doc; one of these. */
export type ExpenseKind = 'gas' | 'parking' | 'supplies' | 'other';

export const EXPENSE_KINDS: readonly ExpenseKind[] = ['gas', 'parking', 'supplies', 'other'];

/** One `expenses/{id}` row as returned by `listExpenses`. */
export interface ExpenseRow {
  _id: string;
  /** One of ExpenseKind; free-text on the source doc, so typed loosely. */
  kind: string;
  amountCents: number;
  note: string;
  /** Free-text ISO instant string, not a Timestamp. */
  occurredAt: string;
}

/**
 * The `listExpenses` response: the rows plus the two server-computed rolling
 * totals the widget headlines. The totals are AUTHORITATIVE (the server sums
 * over the real window); the widget renders them, it does not re-derive them.
 */
export interface ExpenseSummary {
  expenses: ExpenseRow[];
  weekTotalCents: number;
  monthTotalCents: number;
}

/**
 * `listExpenses` (admin-gated): recent expenses since [sinceIso] (default the
 * last 30 days, server-side) plus this week's and this month's totals. Throws
 * (via `lib/fns.call`) on auth/network failure, surfaced fail-loud by the
 * widget rather than swallowed.
 */
export async function listExpenses(sinceIso?: string): Promise<ExpenseSummary> {
  const req = sinceIso !== undefined ? { sinceIso } : {};
  const res = await call<
    { sinceIso?: string },
    { expenses?: ExpenseRow[]; weekTotalCents?: number; monthTotalCents?: number }
  >('listExpenses', req);
  return {
    expenses: res.expenses ?? [],
    weekTotalCents: res.weekTotalCents ?? 0,
    monthTotalCents: res.monthTotalCents ?? 0,
  };
}

/** What the quick-log form submits. `occurredAt` defaults to now on the server. */
export interface LogExpenseInput {
  kind: ExpenseKind;
  amountCents: number;
  note?: string;
  occurredAt?: string;
}

/**
 * `logExpense` (admin-gated): append one expense, returns its new id. Rejects
 * fail-loud on a bad payload or write failure; the widget shows the rejection
 * beside the control instead of pretending the log succeeded.
 */
export async function logExpense(input: LogExpenseInput): Promise<{ id: string }> {
  const res = await call<LogExpenseInput, { id: string }>('logExpense', input);
  return { id: res.id };
}
