// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';

const { sendInvoiceReminder, markInvoicePaid, generateReceipt, reviewAndSendDraftInvoice } = vi.hoisted(
  () => ({
    sendInvoiceReminder: vi.fn(),
    markInvoicePaid: vi.fn(),
    generateReceipt: vi.fn(),
    reviewAndSendDraftInvoice: vi.fn(),
  }),
);
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
  reviewAndSendDraftInvoice,
}));

import { InvoiceDetail } from './InvoiceDetail';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

/** A settling markInvoicePaid response, the common case. */
function settledResult() {
  return {
    paymentId: 'pay1',
    state: 'settled' as const,
    totalCents: 4000,
    paidCents: 4000,
    amountDueCents: 0,
    overpaidCents: 0,
  };
}

function entry(over: Partial<InvoiceEntry> = {}): InvoiceEntry {
  return {
    _id: 'inv1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    client: '',
    invoiceNumber: '1042',
    date: '',
    dueDate: '',
    total: 40,
    amountDue: 40,
    status: '',
    sessionIds: [],
    createdAt: fakeTs('2026-07-16T09:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  sendInvoiceReminder.mockReset();
  markInvoicePaid.mockReset();
  generateReceipt.mockReset();
  reviewAndSendDraftInvoice.mockReset();
});

/**
 * Every action label the panel can ever render. The per-state cases below
 * assert the EXACT set: each expected label present, every other label
 * absent, so a future action leaking into the wrong state fails here rather
 * than reaching an operator (the AO-19 report: a PAID invoice still offering
 * "Mark paid").
 */
const ALL_ACTION_LABELS = ['Send reminder', 'Record payment', 'Generate receipt', 'Review and send'] as const;

function expectExactActions(expected: readonly string[]) {
  for (const label of ALL_ACTION_LABELS) {
    const button = screen.queryByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    if (expected.includes(label)) expect(button, `expected "${label}" to render`).not.toBeNull();
    else expect(button, `expected "${label}" NOT to render`).toBeNull();
  }
}

describe('InvoiceDetail', () => {
  it('renders the household, invoice number, chip, and money facts', () => {
    // total and amountDue deliberately differ so the two $ facts aren't the
    // same text twice, each assertion below is scoped to its own <dd>.
    render(<InvoiceDetail invoice={entry({ total: 40, amountDue: 25 })} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /invoice #1042/i })).toBeInTheDocument();
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$40.00');
    expect(screen.getByText('Amount due').nextElementSibling).toHaveTextContent('$25.00');
  });

  describe('actions gated by invoice state', () => {
    it('PAID: Generate receipt only, no Record payment and no Send reminder', () => {
      render(<InvoiceDetail invoice={entry({ status: 'paid', amountDue: 0, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('PAID')).toBeInTheDocument();
      expectExactActions(['Generate receipt']);
    });

    it('PAID with no status label, retired balance: still receipt only', () => {
      // amountDue <= 0 with a real billed total is the money-field read of paid
      // (invoiceState's last branch), and it must gate identically to the label.
      render(<InvoiceDetail invoice={entry({ status: '', amountDue: 0, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('PAID')).toBeInTheDocument();
      expectExactActions(['Generate receipt']);
    });

    it('OUTSTANDING: Record payment and Send reminder, no receipt, no draft send', () => {
      render(<InvoiceDetail invoice={entry({ status: '', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('OPEN')).toBeInTheDocument();
      expectExactActions(['Send reminder', 'Record payment']);
    });

    it('OVERDUE: the same set as outstanding (overdue refines open, it is not its own state)', () => {
      render(
        <InvoiceDetail
          invoice={entry({ status: '', amountDue: 40, total: 40, dueDate: '2000-01-01' })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('OVERDUE')).toBeInTheDocument();
      expectExactActions(['Send reminder', 'Record payment']);
    });

    it('DRAFT: Review and send only', () => {
      render(<InvoiceDetail invoice={entry({ status: 'draft', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expectExactActions(['Review and send']);
    });

    it('DRAFT past its due date is still a draft, never overdue: no payment actions', () => {
      // The overlap ruling: `dueDate` is ignored on anything that is not open,
      // so a stale-dated draft can never pick up Record payment / Send reminder.
      render(
        <InvoiceDetail
          invoice={entry({ status: 'draft', amountDue: 40, total: 40, dueDate: '2000-01-01' })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expectExactActions(['Review and send']);
    });

    it('QUOTE: no payment actions at all', () => {
      render(<InvoiceDetail invoice={entry({ status: 'quote', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('QUOTE')).toBeInTheDocument();
      expectExactActions([]);
      expect(screen.getByText(/no actions available for a quote invoice/i)).toBeInTheDocument();
    });

    it('QUOTE past its due date is still a quote: no payment actions', () => {
      render(
        <InvoiceDetail
          invoice={entry({ status: 'quote', amountDue: 40, total: 40, dueDate: '2000-01-01' })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('QUOTE')).toBeInTheDocument();
      expectExactActions([]);
    });

    it('CREDIT: no payment actions (money is owed TO the household, not by them)', () => {
      render(<InvoiceDetail invoice={entry({ status: 'credit', amountDue: -20, total: -20 })} onClose={vi.fn()} />);
      expectExactActions([]);
    });

    it('CANCELLED: no actions', () => {
      render(<InvoiceDetail invoice={entry({ status: 'cancelled', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expectExactActions([]);
    });

    it('ZERO: nothing was billed, so nothing to collect or receipt', () => {
      render(<InvoiceDetail invoice={entry({ status: '', amountDue: 0, total: 0 })} onClose={vi.fn()} />);
      expect(screen.getByText('ZERO')).toBeInTheDocument();
      expectExactActions([]);
    });
  });

  it('sends a draft through reviewAndSendDraftInvoice, behind the same confirm step', async () => {
    reviewAndSendDraftInvoice.mockResolvedValue(undefined);
    render(
      <InvoiceDetail invoice={entry({ _id: 'inv4', status: 'draft', total: 40, amountDue: 40 })} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^review and send$/i }));
    expect(reviewAndSendDraftInvoice).not.toHaveBeenCalled();
    expect(screen.getByText(/sends the draft/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^review and send$/i }));
    await waitFor(() => expect(reviewAndSendDraftInvoice).toHaveBeenCalledWith('inv4'));
    expect(await screen.findByText(/draft sent/i)).toBeInTheDocument();
  });

  it('fails loud, naming the callable, when reviewAndSendDraftInvoice rejects', async () => {
    reviewAndSendDraftInvoice.mockRejectedValue(
      new Error('Draft invoice is missing: total. Complete it before sending.'),
    );
    render(
      <InvoiceDetail invoice={entry({ _id: 'inv5', status: 'draft', total: 40, amountDue: 40 })} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^review and send$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^review and send$/i }));
    expect(
      await screen.findByText(/reviewAndSendDraftInvoice failed:.*missing: total/i),
    ).toBeInTheDocument();
  });

  it('gates Send reminder behind an inline confirm before calling the callable', async () => {
    render(<InvoiceDetail invoice={entry({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^send reminder$/i }));
    expect(sendInvoiceReminder).not.toHaveBeenCalled();
    expect(screen.getByText(/real payment-reminder notification/i)).toBeInTheDocument();

    sendInvoiceReminder.mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole('button', { name: /^send reminder$/i }));
    await waitFor(() => expect(sendInvoiceReminder).toHaveBeenCalledWith('inv1'));
    expect(await screen.findByText(/reminder sent/i)).toBeInTheDocument();
  });

  it('Cancel on the confirm step returns to the action list without calling the callable', async () => {
    render(<InvoiceDetail invoice={entry({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^send reminder$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(sendInvoiceReminder).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^send reminder$/i })).toBeInTheDocument();
  });

  it('sends the full outstanding balance when the prefilled amount is left as-is', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    render(<InvoiceDetail invoice={entry({ _id: 'inv7', kinfolkId: 'kf7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await waitFor(() => expect(markInvoicePaid).toHaveBeenCalledWith('inv7', { amount: 40 }));
    expect(await screen.findByText(/paid in full/i)).toBeInTheDocument();
  });

  it('records a PARTIAL amount and reports the balance still owed rather than claiming paid', async () => {
    // The defect this whole change exists to fix: the panel used to report
    // "Invoice marked paid." for a payment that covered half the invoice.
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay1',
      state: 'partial' as const,
      totalCents: 4000,
      paidCents: 2000,
      amountDueCents: 2000,
      overpaidCents: 0,
    });
    render(<InvoiceDetail invoice={entry({ _id: 'inv7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    const amount = screen.getByRole('textbox', { name: /amount collected/i });
    await userEvent.clear(amount);
    await userEvent.type(amount, '20');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));

    await waitFor(() => expect(markInvoicePaid).toHaveBeenCalledWith('inv7', { amount: 20 }));
    expect(await screen.findByText(/\$20\.00 is still owed/i)).toBeInTheDocument();
    expect(screen.queryByText(/paid in full/i)).toBeNull();
  });

  it('reports an overpayment as one, and says it was not turned into a credit', async () => {
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay1',
      state: 'overpaid' as const,
      totalCents: 3950,
      paidCents: 4000,
      amountDueCents: 0,
      overpaidCents: 50,
    });
    render(<InvoiceDetail invoice={entry({ _id: 'inv7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/overpaid by \$0\.50/i)).toBeInTheDocument();
    expect(screen.getByText(/not been turned into a credit/i)).toBeInTheDocument();
  });

  it('refuses an unparseable amount with a sentence, and never calls the callable', async () => {
    render(<InvoiceDetail invoice={entry({ _id: 'inv7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    const amount = screen.getByRole('textbox', { name: /amount collected/i });
    await userEvent.clear(amount);
    await userEvent.type(amount, 'twenty');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/is not an amount/i)).toBeInTheDocument();
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });

  it('passes the entered method and reference alongside the amount', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    render(<InvoiceDetail invoice={entry({ _id: 'inv8', kinfolkId: 'kf8' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /payment method/i }), 'check');
    await userEvent.type(screen.getByRole('textbox', { name: /payment reference/i }), 'CK-100');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await waitFor(() =>
      expect(markInvoicePaid).toHaveBeenCalledWith('inv8', {
        amount: 40,
        method: 'check',
        reference: 'CK-100',
      }),
    );
    expect(await screen.findByText(/paid in full/i)).toBeInTheDocument();
  });

  it('the confirm copy names the optional fields and warns that a partial stays open', async () => {
    render(<InvoiceDetail invoice={entry({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(screen.queryByText(/does not record a payment method/i)).toBeNull();
    expect(screen.getByText(/method and reference are optional/i)).toBeInTheDocument();
    expect(screen.getByText(/leaves the invoice open for the rest/i)).toBeInTheDocument();
  });

  it('shows what has been collected and what is still owed on a PART-PAID invoice', async () => {
    render(
      <InvoiceDetail
        invoice={entry({ status: 'open', total: 40, amountDue: 20, paidCents: 2000 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('PART PAID')).toBeInTheDocument();
    expect(screen.getByText('Paid so far')).toBeInTheDocument();
    expect(screen.getByText('Still owed')).toBeInTheDocument();
    // And it keeps the whole outstanding action set, which is what makes
    // collecting the balance possible at all.
    expect(screen.getByRole('button', { name: /^record payment$/i })).toBeInTheDocument();
  });

  it('issues a receipt through generateReceipt', async () => {
    generateReceipt.mockResolvedValue(undefined);
    // Receipt is a PAID-only action now, so this exercises it on a paid invoice.
    render(<InvoiceDetail invoice={entry({ _id: 'inv9', status: 'paid', amountDue: 0 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /generate receipt/i }));
    await userEvent.click(screen.getByRole('button', { name: /^generate receipt$/i }));
    await waitFor(() => expect(generateReceipt).toHaveBeenCalledWith('inv9'));
    expect(await screen.findByText(/receipt issued/i)).toBeInTheDocument();
  });

  it('fails loud, naming the callable, when sendInvoiceReminder rejects', async () => {
    sendInvoiceReminder.mockRejectedValue(new Error('Invoice is already paid; nothing to remind.'));
    render(<InvoiceDetail invoice={entry({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^send reminder$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send reminder$/i }));
    expect(await screen.findByText(/sendInvoiceReminder failed:.*already paid/i)).toBeInTheDocument();
  });

  it('AO-12 regression guard: an unredeemed credit renders CREDIT, never PAID', () => {
    render(<InvoiceDetail invoice={entry({ status: 'credit', amountDue: -20, total: -20 })} onClose={vi.fn()} />);
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
  });
});
