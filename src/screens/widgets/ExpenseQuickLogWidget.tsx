import { useState } from 'react';
import { useOneShot } from '../../lib/useOneShot';
import {
  listExpenses,
  logExpense,
  EXPENSE_KINDS,
  type ExpenseKind,
  type ExpenseRow,
} from '../../api/expenses';
import { recentExpenses, formatCents } from '../../lib/dashboardInsights';
import { humanizeDate } from '../../lib/invoiceFormat';
import { DenPanel, EmptyHint, ErrorHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { PrimaryButton } from '../../components/Buttons';
import './widgets.css';

/** Day label ("May 21") for an ISO instant, or "-" when it is unparseable/blank. */
function expenseDay(occurredAt: string): string {
  const day = humanizeDate(occurredAt);
  return day.trim() === '' ? '-' : day;
}

/**
 * AO-40 Expense Quick-Log. Loads `listExpenses` (this week's and this month's
 * server-computed totals plus the recent rows) and offers a quick-log control:
 * pick a kind, type a dollar amount and an optional note, and it calls
 * `logExpense` then reloads the list. A rejected log fails LOUD beside the button
 * (never a silent success). Totals come straight from the server; the widget
 * never re-sums them. Row logic is in `lib/dashboardInsights.ts`.
 *
 * Reload is driven by [nonce] in the one-shot's label: bumping it changes the
 * label, which re-fires `useOneShot`'s load effect (a genuine refetch, not a
 * stale re-render).
 */
export function ExpenseQuickLogWidget() {
  const [nonce, setNonce] = useState(0);
  const summary = useOneShot(() => listExpenses(), `listExpenses#${nonce}`);

  return (
    <DenPanel
      title="Expense quick-log"
      subtitle="Log gas, parking and supplies on the go."
      hoverLift
    >
      <QuickLogForm onLogged={() => setNonce((n) => n + 1)} />
      <AsyncRegion
        state={summary}
        what="expenses"
        isEmpty={() => false}
        loading={<EmptyHint>Loading expenses…</EmptyHint>}
        empty={<EmptyHint>No expenses logged yet.</EmptyHint>}
      >
        {(data) => {
          const recent = recentExpenses(data.expenses, 5);
          return (
            <div className="dash-widget">
              <div className="expense-totals">
                <span className="expense-total">
                  <span className="expense-total__label">This week</span>
                  <span className="expense-total__value">{formatCents(data.weekTotalCents)}</span>
                </span>
                <span className="expense-total">
                  <span className="expense-total__label">This month</span>
                  <span className="expense-total__value">{formatCents(data.monthTotalCents)}</span>
                </span>
              </div>
              {recent.length === 0 ? (
                <EmptyHint>No expenses logged yet.</EmptyHint>
              ) : (
                <ul className="dash-widget__list">
                  {recent.map((x: ExpenseRow) => (
                    <li key={x._id} className="expense-row">
                      <span className="expense-row__kind">{x.kind}</span>
                      <span className="expense-row__note">
                        {x.note.trim() === '' ? '(no note)' : x.note}
                      </span>
                      <span className="expense-row__amount">{formatCents(x.amountCents)}</span>
                      <time className="expense-row__day" dateTime={x.occurredAt}>
                        {expenseDay(x.occurredAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

interface QuickLogFormProps {
  /** Called after a successful log so the parent can reload the list. */
  onLogged: () => void;
}

/**
 * The inline quick-log control. Converts the dollar input to integer cents,
 * refuses a non-positive amount with a visible message (rather than logging a
 * $0.00 phantom), and shows any `logExpense` rejection fail-loud beside the
 * button. `busy` blocks a double-submit while the write is in flight.
 */
function QuickLogForm({ onLogged }: QuickLogFormProps) {
  const [kind, setKind] = useState<ExpenseKind>('gas');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError('Enter an amount greater than $0.00.');
      return;
    }
    const amountCents = Math.round(dollars * 100);
    setBusy(true);
    setError(null);
    const trimmedNote = note.trim();
    void logExpense({
      kind,
      amountCents,
      ...(trimmedNote !== '' ? { note: trimmedNote } : {}),
    })
      .then(() => {
        setAmount('');
        setNote('');
        setBusy(false);
        onLogged();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(`logExpense failed: ${err instanceof Error ? err.message : 'Log failed'}`);
      });
  };

  return (
    <form
      className="expense-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="expense-form__row">
        <label className="expense-form__field">
          <span className="expense-form__label">Kind</span>
          <select
            className="expense-form__input"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExpenseKind)}
          >
            {EXPENSE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="expense-form__field">
          <span className="expense-form__label">Amount ($)</span>
          <input
            className="expense-form__input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      </div>
      <label className="expense-form__field">
        <span className="expense-form__label">Note (optional)</span>
        <input
          className="expense-form__input"
          type="text"
          placeholder="e.g. fuel for the Tuesday loop"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <PrimaryButton label={busy ? 'Logging…' : 'Log expense'} onClick={submit} busy={busy} />
      {error !== null && <ErrorHint>{error}</ErrorHint>}
    </form>
  );
}
