// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ExpenseSummary } from '../../api/expenses';

const { listExpenses, logExpense } = vi.hoisted(() => ({
  listExpenses: vi.fn(),
  logExpense: vi.fn(),
}));
vi.mock('../../api/expenses', async (orig) => ({
  ...(await orig<typeof import('../../api/expenses')>()),
  listExpenses,
  logExpense,
}));

import { ExpenseQuickLogWidget } from './ExpenseQuickLogWidget';

function summary(over: Partial<ExpenseSummary> = {}): ExpenseSummary {
  return {
    weekTotalCents: 4500,
    monthTotalCents: 18000,
    expenses: [{ _id: 'x1', kind: 'gas', amountCents: 3200, note: 'Tuesday loop', occurredAt: '2026-07-18T09:00:00.000Z' }],
    ...over,
  };
}

beforeEach(() => {
  listExpenses.mockReset();
  logExpense.mockReset();
});

describe('ExpenseQuickLogWidget', () => {
  it('shows the server totals and recent rows', async () => {
    listExpenses.mockResolvedValue(summary());
    render(<ExpenseQuickLogWidget />);

    expect(await screen.findByText('$45.00')).toBeInTheDocument(); // week
    expect(screen.getByText('$180.00')).toBeInTheDocument(); // month
    expect(screen.getByText('$32.00')).toBeInTheDocument(); // row amount
    expect(screen.getByText('Tuesday loop')).toBeInTheDocument();
  });

  it('logs an expense in cents then reloads the list', async () => {
    listExpenses.mockResolvedValue(summary());
    logExpense.mockResolvedValue({ id: 'new1' });
    render(<ExpenseQuickLogWidget />);
    await screen.findByText('$45.00');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: /log expense/i }));

    await waitFor(() =>
      expect(logExpense).toHaveBeenCalledWith({ kind: 'gas', amountCents: 1250 }),
    );
    // Mount load + post-log reload.
    await waitFor(() => expect(listExpenses).toHaveBeenCalledTimes(2));
  });

  it('refuses a non-positive amount without calling the callable', async () => {
    listExpenses.mockResolvedValue(summary());
    render(<ExpenseQuickLogWidget />);
    await screen.findByText('$45.00');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /log expense/i }));

    expect(await screen.findByText(/greater than \$0\.00/i)).toBeInTheDocument();
    expect(logExpense).not.toHaveBeenCalled();
  });

  it('fails loud when the log rejects', async () => {
    listExpenses.mockResolvedValue(summary());
    logExpense.mockRejectedValue(new Error('write-failed'));
    render(<ExpenseQuickLogWidget />);
    await screen.findByText('$45.00');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '9.99' } });
    fireEvent.click(screen.getByRole('button', { name: /log expense/i }));

    expect(await screen.findByText(/logExpense failed:.*write-failed/i)).toBeInTheDocument();
  });
});
