// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';
import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';

const {
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
  getInvoiceLedger,
  recordPayment,
  reviewAndSendDraftInvoice,
  updateInvoice,
  archiveInvoice,
  unarchiveInvoice,
} = vi.hoisted(() => ({
  sendInvoiceReminder: vi.fn(),
  markInvoicePaid: vi.fn(),
  generateReceipt: vi.fn(),
  getInvoiceLedger: vi.fn(),
  recordPayment: vi.fn(),
  reviewAndSendDraftInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  archiveInvoice: vi.fn(),
  unarchiveInvoice: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
  getInvoiceLedger,
  recordPayment,
  reviewAndSendDraftInvoice,
  updateInvoice,
  archiveInvoice,
  unarchiveInvoice,
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

/**
 * A `getInvoiceLedger` answer. The default is an invoice with nothing recorded
 * against it and no visit linked, which is what most of the cases below want:
 * they are asserting the ACTION matrix, and the ledger only has to resolve so
 * the panel leaves its loading state.
 */
function ledgerResult(over: Partial<GetInvoiceLedgerResult> = {}): GetInvoiceLedgerResult {
  return {
    invoiceId: 'inv1',
    payments: [],
    paidCents: 0,
    totalCents: 4000,
    amountDueCents: 4000,
    ledgerPayments: [],
    // Same-household money naming no invoice. The callable carries it so the
    // staff Android invoice screen can stop reading the root `payments`
    // collection directly and inherit the server's units resolution; this
    // React panel does not render it.
    unlinkedKinfolkPayments: [],
    unresolvedAmountCount: 0,
    sessions: [],
    missingSessionIds: [],
    orphanSessionIds: [],
    truncated: false,
    ...over,
  };
}

/**
 * One row of the settlement authority, complete. Cases override the one field
 * they are about.
 */
function subPayment(
  over: Partial<GetInvoiceLedgerResult['payments'][number]> = {},
): GetInvoiceLedgerResult['payments'][number] {
  return {
    paymentId: 'p1',
    amountCents: 2000,
    method: 'check',
    reference: '#881',
    paidAt: '2026-07-20T10:00:00Z',
    recordedBy: 'admin1',
    sourcePaymentId: null,
    ...over,
  };
}
/**
 * One Payment History row, complete.
 *
 * The DEFAULT IS A LEGACY ROW: `tipBasis: 'unknown'`, no fee. That is what the
 * database is mostly full of, and it is the shape the migration left
 * unreconcilable, so it is the shape most cases should be written against.
 */
function ledgerPayment(
  over: Partial<GetInvoiceLedgerResult['ledgerPayments'][number]> = {},
): GetInvoiceLedgerResult['ledgerPayments'][number] {
  return {
    paymentId: 'r1',
    amountCents: 4000,
    amountResolved: true,
    tipCents: 0,
    feeCents: 0,
    tipBasis: 'unknown',
    reconciles: true,
    appliedCents: 0,
    unappliedCents: 4000,
    proceedsCents: 4000,
    autoApply: false,
    appliedInvoiceId: '',
    appliedInvoiceNumber: '',
    method: 'card',
    reference: 'ch_1',
    date: '2026-07-20',
    notes: '',
    recordedBy: 'a1',
    ...over,
  };
}
function ledgerSession(
  over: Partial<GetInvoiceLedgerResult['sessions'][number]> = {},
): GetInvoiceLedgerResult['sessions'][number] {
  return {
    sessionId: 's1',
    serviceType: 'Dog walking',
    status: 'COMPLETED',
    startTime: '2026-07-10T14:00:00Z',
    completedAt: '2026-07-10T14:30:00Z',
    durationMinutes: 30,
    linkedBack: true,
    ...over,
  };
}

/**
 * The default doc is a STAMPED open invoice (`status: 'open'`,
 * `editScope: 'all'`), which is what the server writes for an unpaid sent
 * bill. Per ADR-0002 the stamp arrives ON the doc; these tests hand the panel
 * stored fields and assert rendered affordances, they never rely on the panel
 * deriving a state from the money.
 */
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
    status: 'open',
    editScope: 'all',
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
  updateInvoice.mockReset().mockResolvedValue({
    subtotalCents: 0, totalCents: 0, paidCents: 0, amountDueCents: 0,
  });
  archiveInvoice.mockReset().mockResolvedValue(undefined);
  unarchiveInvoice.mockReset().mockResolvedValue(undefined);
  getInvoiceLedger.mockReset().mockResolvedValue(ledgerResult());
  recordPayment.mockReset().mockResolvedValue({
    ok: true,
    paymentId: 'led1',
    kinfolkId: 'kf1',
    amountCents: 4000,
    tipCents: 0,
    feeCents: 0,
    tipBasis: 'gross',
    appliedCents: 0,
    unappliedCents: 4000,
    proceedsCents: 4000,
    tipNetCents: 0,
    autoApply: false,
    application: null,
    creditedToAccountCents: 0,
    confirmationEmailSent: false,
  });
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
      render(
        <InvoiceDetail
          invoice={entry({ status: 'paid', editScope: 'none', amountDue: 0, total: 40 })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('PAID')).toBeInTheDocument();
      expectExactActions(['Generate receipt']);
    });

    it('UNSTAMPED: a doc with no recognizable stamp gets the neutral chip and NO actions', () => {
      // This slot used to assert the money-field read of paid (blank status,
      // retired balance) gated identically to the label. That derivation moved
      // to the server (ADR-0002), which stamps its verdict onto the doc, so a
      // legacy free-text status now means the doc was NEVER stamped — and the
      // panel's answer is the deliberate fail-soft, not a guess: render the
      // doc's own word as a neutral chip, offer nothing, and ignore even a
      // valid-looking stored editScope (left at the fixture's 'all' here on
      // purpose: no readable state, no money controls).
      render(
        <InvoiceDetail
          invoice={entry({ status: 'sent' as unknown as InvoiceEntry['status'], amountDue: 0, total: 40 })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('SENT')).toBeInTheDocument();
      expectExactActions([]);
      expect(screen.getByText(/carries no recognized state/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    });

    it('OUTSTANDING: Record payment and Send reminder, no receipt, no draft send', () => {
      render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('OPEN')).toBeInTheDocument();
      expectExactActions(['Send reminder', 'Record payment']);
    });

    it('OVERDUE: the same set as outstanding (overdue refines open, it is not its own state)', () => {
      render(
        <InvoiceDetail
          invoice={entry({ amountDue: 40, total: 40, dueDate: '2000-01-01' })}
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
      // "No COLLECTION actions", not "no actions": since Task 5.1 a quote can
      // still be edited and archived, so the old blanket wording had become a
      // lie sitting directly beside two working buttons.
      expect(screen.getByText(/no collection actions for a quote invoice/i)).toBeInTheDocument();
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
      render(
        <InvoiceDetail
          invoice={entry({ status: 'credit', editScope: 'none', amountDue: -20, total: -20 })}
          onClose={vi.fn()}
        />,
      );
      expectExactActions([]);
    });

    it('CANCELLED: no actions', () => {
      render(
        <InvoiceDetail
          invoice={entry({ status: 'cancelled', editScope: 'none', amountDue: 40, total: 40 })}
          onClose={vi.fn()}
        />,
      );
      expectExactActions([]);
    });

    it('ZERO: nothing was billed, so nothing to collect or receipt', () => {
      render(<InvoiceDetail invoice={entry({ status: 'zero', amountDue: 0, total: 0 })} onClose={vi.fn()} />);
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

  /**
   * Mark 10 of the 2026-08-17 walk: "why green box when there was a failure".
   * `markInvoicePaid` had settled the invoice, `recordPayment` had answered 400,
   * and the sentence saying so was appended to a banner still rendering green
   * under the title "Done". The words were right and the colour was not, and
   * the colour is what gets read first.
   */
  it('turns the banner to a warning when the ledger row did not save', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    recordPayment.mockRejectedValue(new Error('recordPayment validation failed'));
    render(<InvoiceDetail invoice={entry({ _id: 'inv7', kinfolkId: 'kf7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/payment ledger row did not save/i)).toBeInTheDocument();
    const banner = screen.getByText(/payment ledger row did not save/i).closest('[data-tone]');
    expect(banner).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByText(/^Done$/)).toBeNull();
  });
  it('stays green when everything landed, so the warning tone keeps meaning something', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    render(<InvoiceDetail invoice={entry({ _id: 'inv7', kinfolkId: 'kf7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    const banner = (await screen.findByText(/paid in full/i)).closest('[data-tone]');
    expect(banner).toHaveAttribute('data-tone', 'success');
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
    render(
      <InvoiceDetail
        invoice={entry({ _id: 'inv9', status: 'paid', editScope: 'none', amountDue: 0 })}
        onClose={vi.fn()}
      />,
    );
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

  it('AO-12 regression guard: a stored credit stamp renders CREDIT, never PAID', () => {
    // The precedence table that decides credit-vs-paid is asserted server-side
    // now (ADR-0002); what this panel owes AO-12 is rendering the stored
    // verdict verbatim rather than second-guessing it from the money.
    render(
      <InvoiceDetail
        invoice={entry({ status: 'credit', editScope: 'none', amountDue: -20, total: -20 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
  });
});
/**
 * Task 5.1: the itemization, the disagreement banner, editing and archiving.
 */
describe('InvoiceDetail line items', () => {
  const lines = [
    { description: 'Dog walk', qty: 3, unitCents: 2500 },
    { description: 'Overnight stay', qty: 1, unitCents: 8000, discountCents: 500 },
  ];
  it('says an un-itemized invoice has no breakdown, rather than rendering an empty table', () => {
    // The common case: every invoice created before 5.1 is un-itemized. A table
    // with a heading and no rows would read as "nothing was billed", which is a
    // different and much worse claim than "nobody broke this down".
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(screen.getByText(/has no itemized breakdown/i)).toBeInTheDocument();
    expect(screen.queryByText('What was billed')).toBeNull();
  });
  it('distinguishes an EMPTY itemization from an absent one', () => {
    render(<InvoiceDetail invoice={entry({ lineItems: [], total: 0, amountDue: 0 })} onClose={vi.fn()} />);
    expect(screen.getByText(/itemized as billing nothing/i)).toBeInTheDocument();
  });
  it('renders the lines with derived per-line amounts', () => {
    render(<InvoiceDetail invoice={entry({ lineItems: lines, totalCents: 15000, total: 150 })} onClose={vi.fn()} />);
    expect(screen.getByText('What was billed')).toBeInTheDocument();
    expect(screen.getByText('Dog walk')).toBeInTheDocument();
    // 3 x $25.00 = $75.00, derived here rather than read off the doc.
    expect(screen.getAllByText('$75.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/includes \$5\.00 off/i)).toBeInTheDocument();
  });
  it('shows the invoice-level discount as its own row', () => {
    render(
      <InvoiceDetail
        invoice={entry({ lineItems: lines, invoiceDiscountCents: 2000, totalCents: 13000, total: 130 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Invoice discount')).toBeInTheDocument();
    expect(screen.getByText('-$20.00')).toBeInTheDocument();
  });
  it('drops a malformed line rather than blanking the whole panel', () => {
    render(
      <InvoiceDetail
        invoice={entry({
          lineItems: [{ description: 'Good', qty: 1, unitCents: 100 }, null, { description: 'no qty' }] as never,
          totalCents: 100,
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Good')).toBeInTheDocument();
  });
});
describe('InvoiceDetail lines-versus-total disagreement banner', () => {
  const lines = [{ description: 'Dog walk', qty: 3, unitCents: 2500 }];
  it('NAMES BOTH FIGURES when the stored total disagrees with the lines', () => {
    // Reachable, not hypothetical: firestore.rules grants `allow update: if
    // isAuntie()` over the whole collection and postInvoiceEvent merges an
    // arbitrary payload, so both bypass every callable.
    render(<InvoiceDetail invoice={entry({ lineItems: lines, totalCents: 4000, total: 40 })} onClose={vi.fn()} />);
    const banner = screen.getByText(/disagrees with itself/i).closest('.banner') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('$75.00'); // the lines
    expect(banner.textContent).toContain('$40.00'); // the stored total
  });
  it('RECONCILES NEITHER: it says so, and changes nothing', () => {
    render(<InvoiceDetail invoice={entry({ lineItems: lines, totalCents: 4000, total: 40 })} onClose={vi.fn()} />);
    expect(screen.getByText(/nothing has been changed to make them match/i)).toBeInTheDocument();
    // The stored figure still drives the money facts. The banner does not
    // quietly swap in the derived one, which would hide the drift from the only
    // person who can resolve it.
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$40.00');
  });
  it('says where the stored figure came from', () => {
    render(<InvoiceDetail invoice={entry({ lineItems: lines, total: 40 })} onClose={vi.fn()} />);
    expect(screen.getByText(/legacy dollar field/i)).toBeInTheDocument();
  });
  it('shows NO banner when the two agree', () => {
    render(<InvoiceDetail invoice={entry({ lineItems: lines, totalCents: 7500, total: 75 })} onClose={vi.fn()} />);
    expect(screen.queryByText(/disagrees with itself/i)).toBeNull();
  });
  it('shows NO banner on an un-itemized invoice, which has nothing to disagree with', () => {
    render(<InvoiceDetail invoice={entry({ total: 40, amountDue: 40 })} onClose={vi.fn()} />);
    expect(screen.queryByText(/disagrees with itself/i)).toBeNull();
  });
});
describe('InvoiceDetail editing', () => {
  it('offers Edit per the STORED editScope: on an open/all invoice, not on a paid/none one', () => {
    const { unmount } = render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    unmount();
    render(
      <InvoiceDetail
        invoice={entry({ status: 'paid', editScope: 'none', amountDue: 0, total: 40 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
  });
  it('sends ONLY the changed metadata field, and NO lineItems key, on an un-itemized invoice', async () => {
    // THE GUARD THAT MATTERS MOST on today's data. Every invoice in the
    // collection is un-itemized, and `updateInvoice` refuses to recompute one.
    // Sending `lineItems: []` here would arm that recompute and rewrite a real
    // $40 invoice to $0 because somebody corrected its due date.
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await userEvent.type(screen.getByLabelText('Invoice terms'), 'Net 30');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateInvoice).toHaveBeenCalled());
    expect(updateInvoice).toHaveBeenCalledWith('inv1', { terms: 'Net 30' });
  });
  it('refuses an empty patch instead of writing an audit entry for nothing', async () => {
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/nothing has changed yet/i)).toBeInTheDocument();
    expect(updateInvoice).not.toHaveBeenCalled();
  });
  it('sends line items once the invoice is itemized', async () => {
    render(
      <InvoiceDetail
        invoice={entry({ lineItems: [{ description: 'Walk', qty: 1, unitCents: 2500 }], totalCents: 2500, total: 25 })}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await userEvent.clear(screen.getByLabelText('Line 1 quantity'));
    await userEvent.type(screen.getByLabelText('Line 1 quantity'), '2');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateInvoice).toHaveBeenCalled());
    expect(updateInvoice).toHaveBeenCalledWith('inv1', {
      lineItems: [{ description: 'Walk', qty: 2, unitCents: 2500 }],
      invoiceDiscountCents: 0,
    });
  });
  it('refuses to save a line whose unit price cannot be read, rather than billing zero', async () => {
    render(
      <InvoiceDetail
        invoice={entry({ lineItems: [{ description: 'Walk', qty: 1, unitCents: 2500 }], totalCents: 2500, total: 25 })}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await userEvent.clear(screen.getByLabelText('Line 1 unit price in dollars'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/needs a dollar amount/i)).toBeInTheDocument();
    expect(updateInvoice).not.toHaveBeenCalled();
  });
  it('surfaces a server refusal verbatim rather than rewording it', async () => {
    updateInvoice.mockRejectedValueOnce(
      new Error('A payment has already been recorded against this invoice, so its line items and discounts are locked.'),
    );
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await userEvent.type(screen.getByLabelText('Invoice terms'), 'Net 30');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/line items and discounts are locked/i)).toBeInTheDocument();
  });
});
describe('InvoiceDetail archive and restore', () => {
  it('offers Archive in every state, because archiving is orthogonal to the money', () => {
    // Each stamp pairs the state with the editScope the server actually writes
    // for it (mytribe/functions/src/lib/invoiceEditPolicy.ts#invoiceEditScope).
    const stamps: readonly [InvoiceEntry['status'], InvoiceEntry['editScope']][] = [
      ['draft', 'all'],
      ['quote', 'all'],
      ['paid', 'none'],
      ['cancelled', 'none'],
      ['credit', 'none'],
    ];
    for (const [status, editScope] of stamps) {
      const { unmount } = render(<InvoiceDetail invoice={entry({ status, editScope })} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
      unmount();
    }
    // Even an UNSTAMPED doc can be archived: the fail-soft withholds the money
    // affordances, not the filing ones.
    render(
      <InvoiceDetail invoice={entry({ status: 'sent' as unknown as InvoiceEntry['status'] })} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
  });
  it('confirms first, and says what archiving does NOT do', async () => {
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    expect(screen.getByText(/does NOT delete it, cancel it, or forgive what is owed/i)).toBeInTheDocument();
    expect(archiveInvoice).not.toHaveBeenCalled();
  });
  it('archives without force on confirm', async () => {
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(screen.getByRole('button', { name: /archive invoice/i }));
    await waitFor(() => expect(archiveInvoice).toHaveBeenCalledWith('inv1', false));
  });
  it('re-offers the choice as an explicit write-off when money is still owed', async () => {
    // The server refuses rather than silently dropping a real balance out of
    // the outstanding total. That is a decision to hand back to the operator,
    // not an error to bounce off.
    archiveInvoice.mockRejectedValueOnce(
      new Error('This invoice still has $40.00 owing. Archiving it would drop that from the outstanding total.'),
    );
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(screen.getByRole('button', { name: /archive invoice/i }));
    expect(await screen.findByText(/writes that balance off the outstanding total/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /archive anyway/i }));
    await waitFor(() => expect(archiveInvoice).toHaveBeenLastCalledWith('inv1', true));
  });
  it('shows Restore, and an explanatory banner, on an already-archived invoice', async () => {
    render(<InvoiceDetail invoice={entry({ archivedAt: fakeTs('2026-07-20T00:00:00Z') })} onClose={vi.fn()} />);
    expect(screen.getByText(/has not been deleted or cancelled/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^restore$/i }));
    await userEvent.click(screen.getByRole('button', { name: /restore invoice/i }));
    await waitFor(() => expect(unarchiveInvoice).toHaveBeenCalledWith('inv1'));
  });

  // #406: this Archived notice used to have no close button at all — the
  // literal walk complaint, captured with this overlay open.
  it('the Archived notice can be dismissed without touching the archive state', async () => {
    render(<InvoiceDetail invoice={entry({ archivedAt: fakeTs('2026-07-20T00:00:00Z') })} onClose={vi.fn()} />);
    expect(screen.getByText(/has not been deleted or cancelled/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(/has not been deleted or cancelled/i)).toBeNull();
    // Restore is still offered: dismissing the notice is not the same as
    // restoring the invoice, and the archived state itself did not change.
    expect(screen.getByRole('button', { name: /^restore$/i })).toBeInTheDocument();
    expect(unarchiveInvoice).not.toHaveBeenCalled();
  });
});
/**
 * A1: the two panels this overlay went without. Before this change
 * `InvoiceDetail.tsx` contained no reference to `sessionIds` and none to the
 * payments subcollection, so an operator opening an invoice could see what it
 * was worth and nothing about which visits it billed or what had come in
 * against it.
 */
describe('the payments panel', () => {
  it('renders the subcollection rows, the collected total, and what is still owed', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({
        payments: [subPayment()],
        paidCents: 2000,
        amountDueCents: 2000,
      }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText('check')).toBeInTheDocument();
    expect(screen.getByText('2026-07-20')).toBeInTheDocument();
    expect(screen.getByText('#881')).toBeInTheDocument();
    expect(screen.getByText('Collected').closest('tr')).toHaveTextContent('$20.00');
    expect(screen.getByText('Still owed').closest('tr')).toHaveTextContent('$20.00');
  });
  it('says nothing has been recorded rather than rendering an empty table', async () => {
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(
      await screen.findByText(/No payment has been recorded against this invoice/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Collected')).toBeNull();
  });
  it('points at Record payment only when the invoice is actually offering it', async () => {
    // A cancelled invoice has no Record payment button, so telling an operator
    // to use one is telling them to look for a control that is not there.
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/Use Record payment below to log one/i)).toBeInTheDocument();
    render(
      <InvoiceDetail
        invoice={entry({ status: 'cancelled', editScope: 'none' })}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/No payment has been recorded against this invoice/i)).toHaveLength(2),
    );
    expect(screen.getAllByText(/Use Record payment below to log one/i)).toHaveLength(1);
  });
  it('reports a blank method as unrecorded, never as an empty cell', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({
        payments: [
          subPayment({ amountCents: 500, method: null, reference: null, paidAt: null, recordedBy: null }),
        ],
        paidCents: 500,
      }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText('no method recorded')).toBeInTheDocument();
    expect(screen.getByText('no date recorded')).toBeInTheDocument();
  });
  it('keeps the root ledger in its OWN table, stated as not counted', async () => {
    // Two collections, two jobs. Folding them together would either double a
    // payment recorded through both paths or claim a balance had moved when it
    // had not.
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({
        payments: [subPayment({ amountCents: 4000, method: 'cash', reference: null, recordedBy: 'a1' })],
        paidCents: 4000,
        amountDueCents: 0,
        ledgerPayments: [
          ledgerPayment({ tipCents: 500, tipBasis: 'gross', feeCents: 271, reconciles: true }),
        ],
      }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/NOT counted in the figures above/i)).toBeInTheDocument();
    // The tip is its OWN column now, and the fee beside it. Neither goes
    // anywhere near the balance.
    expect(screen.getByText('Payment history', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('$5.00')).toBeInTheDocument();
    expect(screen.getByText('$2.71')).toBeInTheDocument();
    expect(screen.getByText('Collected').closest('tr')).toHaveTextContent('$40.00');
  });
  it('names the Stripe case: a ledger that covers a balance nothing settled', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({
        amountDueCents: 4000,
        ledgerPayments: [ledgerPayment({ recordedBy: null })],
      }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(
      await screen.findByText(/The ledger shows money this balance does not/i),
    ).toBeInTheDocument();
  });
  it('fails loud on a refused read, verbatim, and offers a retry', async () => {
    getInvoiceLedger.mockRejectedValueOnce(new Error('Invoice not found.'));
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/getInvoiceLedger failed: Invoice not found\./i)).toBeInTheDocument();
    // Not "there are no payments". The distinction is the whole point.
    expect(screen.queryByText(/No payment has been recorded/i)).toBeNull();
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/No payment has been recorded/i)).toBeInTheDocument();
  });
});
describe('the linked visits panel', () => {
  it('renders the visits the invoice bills', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({ sessions: [ledgerSession()] }),
    );
    render(<InvoiceDetail invoice={entry({ sessionIds: ['s1'] })} onClose={vi.fn()} />);
    expect(await screen.findByText('Dog walking')).toBeInTheDocument();
    expect(screen.getByText('2026-07-10')).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });
  it('shows a visit with no recorded length as unrecorded, never as 0 min', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({ sessions: [ledgerSession({ durationMinutes: null })] }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText('not recorded')).toBeInTheDocument();
    expect(screen.queryByText('0 min')).toBeNull();
  });
  it('says no visit is linked, and that the total is unattributed', async () => {
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/No visit is linked to this invoice/i)).toBeInTheDocument();
  });
  it('names a claimed visit with no record behind it', async () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult({ missingSessionIds: ['ghost'] }));
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(
      await screen.findByText(/This invoice claims a visit that does not exist/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/ghost/)).toBeInTheDocument();
  });
  it('warns when a linked visit does not point back, because it can be billed twice', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({ sessions: [ledgerSession({ linkedBack: false })] }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/does not point back/i)).toBeInTheDocument();
    expect(screen.getByText(/billed a second time/i)).toBeInTheDocument();
  });
  it('warns when a visit points at this invoice and the invoice does not claim it', async () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult({ orphanSessionIds: ['s-orphan'] }));
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(
      await screen.findByText(/points at this invoice, which does not claim it/i),
    ).toBeInTheDocument();
  });
});
/**
 * A1, second half: this app called ONLY `markInvoicePaid`, so a payment taken
 * through the web admin never reached the root `payments` ledger the Payments
 * screens read, while Android's identical action wrote both.
 */
describe('recording a payment writes both the settlement and the ledger row', () => {
  async function recordTwenty(invoice = entry({ amountDue: 40, total: 40 })) {
    render(<InvoiceDetail invoice={invoice} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    const amount = screen.getByLabelText(/amount collected/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '20');
    await userEvent.type(screen.getByLabelText(/payment method/i), 'check');
    await userEvent.type(screen.getByLabelText(/payment reference/i), '#881');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
  }
  it('calls markInvoicePaid FIRST, then recordPayment with this payment amount', async () => {
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay1',
      state: 'partial' as const,
      totalCents: 4000,
      paidCents: 2000,
      amountDueCents: 2000,
      overpaidCents: 0,
    });
    await recordTwenty();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(markInvoicePaid).toHaveBeenCalledWith('inv1', {
      amount: 20,
      method: 'check',
      reference: '#881',
    });
    // $20, NOT the $20.00 cumulative figure that happens to match here by
    // coincidence. See the second-payment case below for the one that bites.
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 20,
        invoiceId: 'inv1',
        invoiceNumber: '1042',
        kinfolkId: 'kf1',
        paymentMethod: 'check',
        referenceNumber: '#881',
      }),
    );
  });
  it('records THIS payment, not everything ever collected on the invoice', async () => {
    // The trap. markInvoicePaid's `paidCents` is cumulative, so a second $20
    // against a part-paid invoice answers 4000, and writing that to the ledger
    // would book a $40 row for a $20 payment.
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay2',
      state: 'settled' as const,
      totalCents: 4000,
      paidCents: 4000,
      amountDueCents: 0,
      overpaidCents: 0,
    });
    await recordTwenty();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 }));
  });
  it('derives an omitted amount from the ledger it already read, not from a guess', async () => {
    // Leaving the field blank means "settle the rest". markInvoicePaid's answer
    // is cumulative, so the payment's own size is the difference against the
    // cumulative figure the panel had already loaded. Both come from the same
    // subcollection, so they cannot disagree.
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({ paidCents: 1500, amountDueCents: 2500 }),
    );
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay2',
      state: 'settled' as const,
      totalCents: 4000,
      paidCents: 4000,
      amountDueCents: 0,
      overpaidCents: 0,
    });
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await screen.findByText(/Collected|No payment has been recorded/i);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.clear(screen.getByLabelText(/amount collected/i));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 25 }));
  });
  it('writes NO ledger row when the amount cannot be stated exactly, and says so', async () => {
    // Blank amount AND an unreadable ledger. A guessed figure on a payment
    // record is worse than a missing one.
    getInvoiceLedger.mockRejectedValue(new Error('unavailable'));
    markInvoicePaid.mockResolvedValue(settledResult());
    render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    await screen.findByText(/getInvoiceLedger failed/i);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.clear(screen.getByLabelText(/amount collected/i));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/No row was added to the payment ledger/i)).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();
  });
  it('does NOT fail the action when only the ledger row fails, and says what is missing', async () => {
    // The money has already moved. Throwing here would offer a retry that
    // collects a second time.
    markInvoicePaid.mockResolvedValue(settledResult());
    recordPayment.mockRejectedValueOnce(new Error('unavailable'));
    await recordTwenty();
    expect(await screen.findByText(/paid in full/i)).toBeInTheDocument();
    expect(screen.getByText(/payment ledger row did not save/i)).toBeInTheDocument();
    expect(screen.getByText(/The invoice itself is correct/i)).toBeInTheDocument();
  });
  it('does NOT call recordPayment when markInvoicePaid refused: no payment happened', async () => {
    markInvoicePaid.mockRejectedValueOnce(new Error('Invoice is already settled.'));
    await recordTwenty();
    expect(await screen.findByText(/markInvoicePaid failed: Invoice is already settled\./i)).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();
  });
  it('reloads the ledger after a payment, so the panel is not describing the invoice as it was', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    await recordTwenty();
    // Once on mount, once after the write.
    await waitFor(() => expect(getInvoiceLedger).toHaveBeenCalledTimes(2));
  });
});
/**
 * `initialAction`: the panel opened ALREADY ON a confirm step, which is how the
 * Invoices list's per-row quick action reaches an action without a second click
 * and without a second confirm flow whose wording could drift from this one.
 *
 * It ARMS; it never performs. And it is validated against the stored state
 * rather than trusted, because the live listener can deliver a newer doc between
 * the row click and this render.
 */
describe('InvoiceDetail initialAction', () => {
  it('opens on the reminder confirm step without calling anything', () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(<InvoiceDetail invoice={entry()} initialAction="reminder" onClose={vi.fn()} />);
    expect(screen.getByText(/sends a real payment-reminder notification/i)).toBeInTheDocument();
    expect(sendInvoiceReminder).not.toHaveBeenCalled();
  });
  it('opens on the review-and-send confirm step for a draft', () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(
      <InvoiceDetail
        invoice={entry({ status: 'draft' })}
        initialAction="reviewSend"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/sends the draft to the household on file/i)).toBeInTheDocument();
  });
  it('opens on the receipt confirm step for a paid invoice', () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(
      <InvoiceDetail
        invoice={entry({ status: 'paid', amountDue: 0, editScope: 'none' })}
        initialAction="receipt"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/issues a receipt and notifies the household/i)).toBeInTheDocument();
  });
  it('performs the armed action on confirm, exactly as the in-panel button does', async () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    sendInvoiceReminder.mockResolvedValue(undefined);
    render(<InvoiceDetail invoice={entry()} initialAction="reminder" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send reminder' }));
    await waitFor(() => expect(sendInvoiceReminder).toHaveBeenCalledWith('inv1'));
  });
  it('fails loud on the armed action, naming the callable', async () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    sendInvoiceReminder.mockRejectedValue(new Error('permission-denied'));
    render(<InvoiceDetail invoice={entry()} initialAction="reminder" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send reminder' }));
    expect(await screen.findByText(/sendInvoiceReminder failed: permission-denied/i)).toBeInTheDocument();
  });
  it('IGNORES an action the stored state does not permit, falling back to the action list', () => {
    // The list armed "reminder" off an open invoice; by the time this renders,
    // the live listener has delivered the PAID doc. A reminder confirm here
    // would offer to nag a household that has already paid.
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(
      <InvoiceDetail
        invoice={entry({ status: 'paid', amountDue: 0, editScope: 'none' })}
        initialAction="reminder"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate receipt' })).toBeInTheDocument();
  });
  it('IGNORES an armed action on a doc with no recognizable state stamp', () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(
      <InvoiceDetail
        invoice={entry({ status: 'weird' as InvoiceEntry['status'] })}
        initialAction="reminder"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(screen.getByText(/carries no recognized state/i)).toBeInTheDocument();
  });
  it('cancelling the armed step lands on the action list and does not re-arm', async () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(<InvoiceDetail invoice={entry()} initialAction="reminder" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
  it('opens on the plain action list when nothing is armed', () => {
    getInvoiceLedger.mockResolvedValue(ledgerResult());
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(screen.queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
  });
});
/**
 * ── THE FEE / TIP / AUTO-APPLY FORM, 2026-08-04 ───────────────────────────
 *
 * The operator's legacy Add New Transaction screen carried Fees, Tip, an
 * Unapplied Balance, an Auto-apply toggle, staff Notes and a Send Confirmation
 * Email switch alongside the amount. None of them existed here. Invoice #1029
 * is what their absence cost: Amount $137.50, Applied $127.50, Tip $7.29, and
 * $2.71 that nothing on the record could account for.
 */
describe('the record-payment form: fee, gross tip, notes and the two switches', () => {
  async function openForm(invoice = entry({ amountDue: 127.5, total: 127.5 })) {
    render(<InvoiceDetail invoice={invoice} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
  }
  async function submit() {
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
  }
  it('offers every field her legacy screen had, beside the one that was already here', async () => {
    await openForm();
    expect(screen.getByLabelText(/amount collected/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tip in dollars/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/processor fee in dollars/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/staff-only notes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/automatically apply any unapplied amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send a confirmation email/i)).toBeInTheDocument();
  });
  it('records invoice #1029: the gross tip and the fee, on top of what settled the bill', async () => {
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay1',
      state: 'settled' as const,
      totalCents: 12750,
      paidCents: 12750,
      amountDueCents: 0,
      overpaidCents: 0,
    });
    await openForm();
    await userEvent.clear(screen.getByLabelText(/amount collected/i));
    await userEvent.type(screen.getByLabelText(/amount collected/i), '127.50');
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), '10');
    await userEvent.type(screen.getByLabelText(/processor fee in dollars/i), '2.71');
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    // The invoice is settled by the APPLIED part alone.
    expect(markInvoicePaid).toHaveBeenCalledWith('inv1', expect.objectContaining({ amount: 127.5 }));
    // The ledger row is the whole TRANSACTION: $137.50, tip included.
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 137.5, tip: 10, fee: 2.71 }),
    );
  });
  it('NEVER sends an apply, because markInvoicePaid already settled the invoice', async () => {
    // Sending one would put the same money against the same bill twice.
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment.mock.calls[0]![0]).not.toHaveProperty('apply');
  });
  it('sends zero for an untouched tip and fee, which is what a blank box means', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ tip: 0, fee: 0 }));
  });
  it('sends the switches OFF unless she turned them on', async () => {
    // A confirmation is a message to a real household. It goes out because she
    // ticked the box, never because the panel assumed she meant to.
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ autoApply: false, sendConfirmationEmail: false }),
    );
  });
  it('sends both switches on when she turns them on', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await userEvent.click(screen.getByLabelText(/automatically apply any unapplied amount/i));
    await userEvent.click(screen.getByLabelText(/send a confirmation email/i));
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ autoApply: true, sendConfirmationEmail: true }),
    );
  });
  it('sends the staff notes, trimmed', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await userEvent.type(screen.getByLabelText(/staff-only notes/i), '  took the fee out of the tip  ');
    await submit();
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'took the fee out of the tip' }),
    );
  });
  it('clears every new field between one payment and the next', async () => {
    // A tip left in the box from the last household is a tip recorded against
    // the wrong one.
    markInvoicePaid.mockResolvedValue(settledResult());
    await openForm();
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), '10');
    await userEvent.click(screen.getByLabelText(/send a confirmation email/i));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(screen.getByLabelText(/tip in dollars/i)).toHaveValue('');
    expect(screen.getByLabelText(/send a confirmation email/i)).not.toBeChecked();
  });
});
describe('the record-payment form: refusals it makes before any money moves', () => {
  async function openForm() {
    render(<InvoiceDetail invoice={entry({ amountDue: 127.5, total: 127.5 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
  }
  it('refuses an unreadable tip instead of silently recording none', async () => {
    // Reading "abc" as $0 would drop a tip she believes she entered.
    await openForm();
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/"abc" is not a tip/i)).toBeInTheDocument();
    expect(markInvoicePaid).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
  });
  it('refuses an unreadable fee the same way', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/processor fee in dollars/i), 'lots');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/"lots" is not a fee/i)).toBeInTheDocument();
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });
  it('refuses a negative fee, which is not a fee', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/processor fee in dollars/i), '-2.71');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/is not a fee/i)).toBeInTheDocument();
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });
  it('refuses a payment that does not cover what is applied plus the tip', async () => {
    // The mis-key the Unapplied Balance exists to catch, refused BEFORE
    // markInvoicePaid runs rather than after it has already collected.
    await openForm();
    await userEvent.clear(screen.getByLabelText(/amount collected/i));
    await userEvent.type(screen.getByLabelText(/amount collected/i), '127.50');
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), '10');
    await userEvent.type(screen.getByLabelText(/total payment amount/i), '100');
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/does not cover/i)).toBeInTheDocument();
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });
});
describe('the Unapplied Balance, shown before Save', () => {
  async function openForm(amountDue = 127.5) {
    render(<InvoiceDetail invoice={entry({ amountDue, total: amountDue })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
  }
  it('reads zero on the ordinary payment, where nothing is left over', async () => {
    await openForm();
    expect(screen.getByText('Unapplied balance')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });
  it('shows the leftover the moment a bigger payment is typed', async () => {
    // $300 handed over against a $127.50 bill, no tip: $172.50 over.
    await openForm();
    await userEvent.type(screen.getByLabelText(/total payment amount/i), '300');
    await waitFor(() => expect(screen.getByText('$172.50')).toBeInTheDocument());
  });
  it('takes the GROSS tip out of the leftover, because the tip is not unapplied money', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/total payment amount/i), '300');
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), '10');
    await waitFor(() => expect(screen.getByText('$162.50')).toBeInTheDocument());
  });
  it('does NOT move when a fee is entered: the fee is off proceeds, not off the payment', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/total payment amount/i), '300');
    await userEvent.type(screen.getByLabelText(/processor fee in dollars/i), '2.71');
    await waitFor(() => expect(screen.getByText('$172.50')).toBeInTheDocument());
  });
  it('says what will happen to the leftover, and it depends on the auto-apply switch', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/total payment amount/i), '300');
    expect(await screen.findByText(/will not be applied to anything/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/automatically apply any unapplied amount/i));
    expect(await screen.findByText(/held as this household's account credit/i)).toBeInTheDocument();
  });
  it('shows NOTHING rather than a figure derived from a half-typed number', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText(/tip in dollars/i), 'abc');
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument();
  });
});
describe('what the operator is told after the payment lands', () => {
  it('says where the leftover went when it became account credit', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    recordPayment.mockResolvedValue({
      ok: true,
      paymentId: 'led1',
      kinfolkId: 'kf1',
      amountCents: 30000,
      tipCents: 0,
      feeCents: 0,
      tipBasis: 'gross',
      appliedCents: 0,
      unappliedCents: 17250,
      proceedsCents: 30000,
      tipNetCents: 0,
      autoApply: true,
      application: null,
      creditedToAccountCents: 17250,
      confirmationEmailSent: false,
    });
    render(<InvoiceDetail invoice={entry({ amountDue: 127.5, total: 127.5 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(await screen.findByText(/added to the household's account credit/i)).toBeInTheDocument();
  });
  it('says the confirmation did NOT go out rather than letting her assume it did', async () => {
    markInvoicePaid.mockResolvedValue(settledResult());
    recordPayment.mockResolvedValue({
      ok: true,
      paymentId: 'led1',
      kinfolkId: 'kf1',
      amountCents: 12750,
      tipCents: 0,
      feeCents: 0,
      tipBasis: 'gross',
      appliedCents: 0,
      unappliedCents: 12750,
      proceedsCents: 12750,
      tipNetCents: 0,
      autoApply: false,
      application: null,
      creditedToAccountCents: 0,
      confirmationEmailSent: false,
    });
    render(<InvoiceDetail invoice={entry({ amountDue: 127.5, total: 127.5 })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(screen.getByLabelText(/send a confirmation email/i));
    await userEvent.click(screen.getByRole('button', { name: /^record payment$/i }));
    expect(
      await screen.findByText(/confirmation email did not go out/i),
    ).toBeInTheDocument();
  });
});
/**
 * ── PAYMENT HISTORY, THE COLUMN SET ───────────────────────────────────────
 *
 * Measured against the operator's production screen, three columns were
 * missing from this table: Applied to #n, Tip and Balance. Tip was not even a
 * server gap: `getInvoiceLedger` has returned `tipCents` since this panel
 * shipped and the panel simply never rendered it. Fee is the fourth, and the
 * only one that needed a new field.
 */
describe('payment history columns', () => {
  function renderWithRow(over: Partial<GetInvoiceLedgerResult['ledgerPayments'][number]> = {}) {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({ amountDueCents: 0, ledgerPayments: [ledgerPayment(over)] }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
  }
  /**
   * The AMOUNT cell of the single ledger row, by position.
   *
   * Named by column index rather than by its text because the two cases below
   * turn on telling `$0.00` apart from the honest absence of a figure, and Tip,
   * Fee and Balance on the same row are legitimately `$0.00` too. A
   * document-wide search for that string cannot distinguish them.
   */
  async function amountCellText(): Promise<string> {
    return ledgerCellText(3);
  }
  /**
   * The BALANCE cell, located the same way and for the same reason: a real
   * $0.00 balance and a balance nobody can vouch for are different facts that
   * a document-wide text search cannot tell apart.
   */
  async function balanceCellText(): Promise<string> {
    return ledgerCellText(7);
  }
  /** One cell of the single ledger row, by column index. */
  async function ledgerCellText(column: number): Promise<string> {
    const table = await screen.findByRole('table', { name: /Payment history/i });
    const bodyRow = within(table).getAllByRole('row')[1]!;
    return within(bodyRow).getAllByRole('cell')[column]!.textContent ?? '';
  }
  it('renders every column her production screen has, plus the fee', async () => {
    renderWithRow();
    expect(await screen.findByRole('columnheader', { name: /transaction date/i })).toBeInTheDocument();
    for (const name of [/^method$/i, /reference #/i, /^amount$/i, /applied to/i, /^tip$/i, /^fee$/i, /^balance$/i]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });
  it('reads invoice #1029 across, and the row adds up', async () => {
    // amount(137.50) = applied(127.50) + tipGross(10.00) + balance(0.00)
    renderWithRow({
      amountCents: 13750,
      tipCents: 1000,
      feeCents: 271,
      tipBasis: 'gross',
      reconciles: true,
      appliedCents: 12750,
      unappliedCents: 0,
      appliedInvoiceId: 'inv1029',
      appliedInvoiceNumber: '1029',
      date: 'February 17, 2026',
    });
    expect(await screen.findByText('February 17, 2026')).toBeInTheDocument();
    expect(screen.getByText('$137.50')).toBeInTheDocument();
    expect(screen.getByText('#1029')).toBeInTheDocument();
    expect(screen.getByText('$127.50')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByText('$2.71')).toBeInTheDocument();
  });
  it('does NOT add the tip onto the amount, which would count the gratuity twice', async () => {
    // The amount on the operator's data already contains the tip.
    renderWithRow({ amountCents: 13750, tipCents: 1000, tipBasis: 'gross', reconciles: true });
    expect(await screen.findByText('$137.50')).toBeInTheDocument();
    expect(screen.queryByText('$147.50')).toBeNull();
  });
  it('marks a gross tip as gross, because that is the tax-relevant fact', async () => {
    renderWithRow({ tipCents: 1000, tipBasis: 'gross', reconciles: true });
    expect(await screen.findByText('gross')).toBeInTheDocument();
  });
  it('does NOT print $0.00 for an amount the server could not read', async () => {
    // THE DEFECT. `resolveLedgerAmountCents` returns `{ amountCents: 0,
    // resolved: false }` for a Stripe event the webhook gave up on, and the 0
    // is the floor `CentsSchema` allows, not a figure. This cell used to render
    // it as "$0.00" with nothing beside it, so a payment nobody could read was
    // indistinguishable from a payment of nothing.
    //
    // Every other money cell on this row is a REAL zero and still renders as
    // $0.00, which is why the assertion below names the Amount cell instead of
    // sweeping the document for the string.
    renderWithRow({
      amountCents: 0,
      amountResolved: false,
      tipCents: 0,
      feeCents: 0,
      reconciles: true,
      appliedCents: 0,
      unappliedCents: 0,
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1042',
    });
    expect(await amountCellText()).toMatch(/could not be read/i);
    expect(await amountCellText()).not.toContain('$0.00');
    // And the panel says why, rather than leaving a cell that reads as a
    // rendering bug.
    expect(screen.getByText(/Some of these rows cannot be reconciled/i)).toBeInTheDocument();
    expect(screen.getByText(/never a reading/i)).toBeInTheDocument();
  });
  it('still prints a REAL $0.00 amount, which is a reading and not an absence', async () => {
    // The negative case has a twin: a row whose amount genuinely resolved to
    // zero must keep showing the figure. Suppressing both would trade one lie
    // for another.
    renderWithRow({ amountCents: 0, amountResolved: true, tipCents: 0, feeCents: 0, reconciles: true });
    expect(await amountCellText()).toBe('$0.00');
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
  /**
   * ── THE BALANCE ON A ROW WHOSE AMOUNT COULD NOT BE READ ────────────────
   *
   * The server derives the balance as amount - applied - tip. On an unresolved
   * row the amount it subtracted from was `CentsSchema`'s floor of 0 rather
   * than a reading, so the figure that falls out is arithmetic over a
   * non-number. Printing it renders "-$127.50", which reads as a real
   * over-application against a real payment, and it is neither. Android's
   * Balance slot has said "could not be read" here since PR #319; this is the
   * web half of the same promise.
   */
  it('does NOT print a dollar figure for the balance of a row whose amount could not be read', async () => {
    renderWithRow({
      amountCents: 0,
      amountResolved: false,
      appliedCents: 12750,
      tipCents: 0,
      feeCents: 0,
      reconciles: true,
      unappliedCents: -12750,
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1042',
    });
    expect(await balanceCellText()).toMatch(/could not be read/i);
    // The fake over-application, named exactly. This is the string the operator
    // would otherwise read as money applied past what the payment covers.
    expect(await balanceCellText()).not.toContain('$127.50');
    expect(await balanceCellText()).not.toContain('$0.00');
  });
  it('does not claim the leftover on such a row is held as credit either', async () => {
    // `unappliedCents` is positive here, but it came out of the same arithmetic
    // over a non-number. Saying where a leftover went re-asserts the figure the
    // cell beside it has just declined to vouch for.
    renderWithRow({
      amountCents: 0,
      amountResolved: false,
      appliedCents: 0,
      tipCents: 0,
      feeCents: 0,
      reconciles: true,
      unappliedCents: 12000,
      autoApply: true,
    });
    expect(await balanceCellText()).toMatch(/could not be read/i);
    expect(screen.queryByText('held as credit')).toBeNull();
  });
  it('still shows a REAL over-application as a negative figure, which is not hidden or clamped', async () => {
    // The honest case the suppression above must not swallow. More was applied
    // than this payment covers, the amount behind it WAS read, and the operator
    // has to see it.
    renderWithRow({
      amountCents: 12250,
      amountResolved: true,
      appliedCents: 12750,
      tipCents: 0,
      feeCents: 0,
      reconciles: true,
      unappliedCents: -500,
    });
    expect(await balanceCellText()).toBe('-$5.00');
    expect(screen.getByText(/does not balance/i)).toBeInTheDocument();
  });
  it('still prints a REAL $0.00 balance, which is a reading and not an absence', async () => {
    // Invoice #1029 itself: amount(137.50) = applied(127.50) + tip(10.00) + 0.
    renderWithRow({
      amountCents: 13750,
      amountResolved: true,
      appliedCents: 12750,
      tipCents: 1000,
      feeCents: 271,
      tipBasis: 'gross',
      reconciles: true,
      unappliedCents: 0,
    });
    expect(await balanceCellText()).toBe('$0.00');
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
  it('says a migrated fee is NOT RECORDED, never $0.00, because zero would be a claim', async () => {
    renderWithRow({ tipCents: 729, tipBasis: 'unknown', reconciles: false, feeCents: 0 });
    expect(await screen.findByText('not recorded')).toBeInTheDocument();
  });
  it('names the rows that cannot be reconciled, and guesses nothing to make them balance', async () => {
    renderWithRow({ tipCents: 729, tipBasis: 'unknown', reconciles: false });
    expect(await screen.findByText(/Some of these rows cannot be reconciled/i)).toBeInTheDocument();
    expect(screen.getByText(/migrated without its processor fee/i)).toBeInTheDocument();
    // NO BACK-COMPUTED GROSS. The gross cannot be recovered from a net tip
    // whose deduction is unknown, and a guess would put a number that was never
    // collected onto a tax return.
    expect(screen.getByText(/no gross tip has been guessed/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been guessed to make them balance/i)).toBeInTheDocument();
  });
  it('stays quiet on a row that reconciles on its own', async () => {
    renderWithRow({ tipCents: 1000, feeCents: 271, tipBasis: 'gross', reconciles: true });
    await screen.findByText('$10.00');
    expect(screen.queryByText(/Some of these rows cannot be reconciled/i)).toBeNull();
  });
  it('says NOT APPLIED rather than $0.00 when the payment touched no balance', async () => {
    // A payment that applied to nothing is a different fact from one that
    // applied zero dollars.
    renderWithRow({ appliedInvoiceId: '', appliedInvoiceNumber: '' });
    expect(await screen.findByText('not applied')).toBeInTheDocument();
  });
  it('says a leftover is held as credit when auto-apply is on', async () => {
    renderWithRow({
      amountCents: 30000,
      appliedCents: 18000,
      unappliedCents: 12000,
      autoApply: true,
      tipBasis: 'gross',
      reconciles: true,
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1042',
    });
    expect(await screen.findByText('held as credit')).toBeInTheDocument();
    expect(screen.getByText('$120.00')).toBeInTheDocument();
  });
  it('does not claim a leftover is held when auto-apply is off', async () => {
    renderWithRow({
      amountCents: 30000,
      appliedCents: 18000,
      unappliedCents: 12000,
      autoApply: false,
      tipBasis: 'gross',
      reconciles: true,
    });
    await screen.findByText('$120.00');
    expect(screen.queryByText('held as credit')).toBeNull();
  });
});
/**
 * THE CHARGEBACK PANEL.
 *
 * A dispute does not un-pay the invoice (see functions/src/billing/stripeDispute.ts:
 * flipping it back to outstanding would restart dunning at a household over
 * their own bank's action). So the invoice keeps reading PAID with money that
 * may already be gone, and this panel is the only thing on the screen that says
 * so. Both facts are separate on the doc on purpose: `disputeStatus` is where
 * the CONTEST stands, `disputeFundsState` is whether the BALANCE moved.
 */
describe('InvoiceDetail dispute panel', () => {
  const paidDisputed = (over: Partial<InvoiceEntry> = {}) =>
    entry({ status: 'paid', editScope: 'none', amountDue: 0, paidCents: 4000, ...over });
  /**
   * By class, the way the Invoices row cases locate a row. `Banner` is the
   * shared fail-loud primitive and carries no test id, and the two attributes
   * these cases turn on (`role`, `data-tone`) sit on its root element.
   */
  function disputePanel(): HTMLElement {
    const el = document.querySelector('.invoice-detail__dispute');
    expect(el, 'expected the dispute panel to render').not.toBeNull();
    return el as HTMLElement;
  }
  it('says a paid invoice is disputed, and that the paid state was left alone', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeId: 'dp_1', disputeAmountCents: 4000 })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    expect(panel).toHaveAttribute('data-tone', 'error');
    expect(panel).toHaveAttribute('role', 'alert');
    expect(within(panel).getByText(/needs_response/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$40\.00/)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/still reads paid/i);
  });
  /**
   * THE ONE THE OPERATOR ASKED FOR. `disputeStatus` is never cleared, so every
   * invoice that was ever disputed keeps the flag for good. Rendering any
   * non-empty status as an alarm would leave every previously-disputed invoice
   * permanently on fire. `won` is a past event.
   */
  it('renders a WON dispute as history, not as an open problem', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'won', disputeId: 'dp_1', disputeAmountCents: 4000, disputeFundsState: 'reinstated' })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    // Not an alarm: no alert role, no error tone, and nothing telling the
    // operator to act.
    expect(panel).not.toHaveAttribute('role', 'alert');
    expect(panel.getAttribute('data-tone')).not.toBe('error');
    expect(panel.getAttribute('data-tone')).not.toBe('warning');
    expect(panel).toHaveTextContent(/was disputed/i);
    expect(panel).toHaveTextContent(/resolved in your favor/i);
    expect(panel).not.toHaveTextContent(/respond|deadline|evidence/i);
  });
  // #406: the walk complaint. "Dispute won" is history the operator already
  // knows once read; it had no way to get it out of the way.
  it('the WON dispute notice has a close button and can be dismissed', async () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'won', disputeId: 'dp_1', disputeAmountCents: 4000, disputeFundsState: 'reinstated' })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    const closeButton = within(panel).getByRole('button', { name: 'Dismiss' });

    await userEvent.click(closeButton);

    expect(document.querySelector('.invoice-detail__dispute')).toBeNull();
  });
  it('still says the money is out on a won dispute Stripe has not reinstated yet', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'won', disputeFundsState: 'withdrawn' })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    expect(panel.getAttribute('data-tone')).not.toBe('error');
    expect(panel).toHaveTextContent(/not been reported back/i);
  });
  /**
   * The funds lane writes `disputeFundsState` with NO `disputeStatus`, and the
   * two Stripe lanes have no ordering guarantee, so this doc shape is real.
   */
  it('renders a withdrawal that arrived before any status, and says the status is unknown', () => {
    render(
      <InvoiceDetail invoice={paidDisputed({ disputeFundsState: 'withdrawn', disputeId: 'dp_1' })} onClose={vi.fn()} />,
    );
    const panel = disputePanel();
    expect(panel).toHaveAttribute('data-tone', 'error');
    expect(panel).toHaveTextContent(/not said where the dispute stands/i);
    expect(panel).toHaveTextContent(/pulled/i);
  });
  /**
   * NEVER A FIGURE WE CANNOT SOURCE. Two separate rules meet here: an absent
   * `disputeAmountCents` must not print as $0.00, and no debit total may be
   * printed at all, because what leaves the balance is the disputed amount
   * PLUS Stripe's dispute fee and only the first is on the object.
   */
  it('names an unknown disputed amount in words rather than printing $0.00', () => {
    render(<InvoiceDetail invoice={paidDisputed({ disputeStatus: 'lost' })} onClose={vi.fn()} />);
    const panel = disputePanel();
    expect(panel).not.toHaveTextContent(/\$0\.00/);
    expect(panel).toHaveTextContent(/did not carry|not stated/i);
  });
  it('says the withdrawal is larger than the disputed amount without inventing the figure', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'lost', disputeAmountCents: 4000, disputeFundsState: 'withdrawn' })}
        onClose={vi.fn()}
      />,
    );
    expect(disputePanel()).toHaveTextContent(/dispute fee/i);
  });
  /** Nothing may clear the flag: the contest happened, and it stays on record. */
  it('offers no way to dismiss or clear the dispute', () => {
    render(<InvoiceDetail invoice={paidDisputed({ disputeStatus: 'lost' })} onClose={vi.fn()} />);
    const panel = disputePanel();
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
  });
  it('renders nothing at all on an invoice that was never disputed', () => {
    render(<InvoiceDetail invoice={paidDisputed()} onClose={vi.fn()} />);
    expect(document.querySelector('.invoice-detail__dispute')).toBeNull();
  });
});
/**
 * THE DEADLINE AND THE REASON.
 *
 * A chargeback you fail to answer in time is lost by default, so the date is the
 * time-critical half of the panel above. Everything here turns on the panel
 * refusing to state a time it cannot source.
 *
 * These cases assert STATE CARRIERS — `data-deadline-state` on the deadline
 * line — rather than visibility. jsdom ships no user-agent stylesheet, so
 * `toBeVisible()` returns true for content a real browser would hide, and a
 * countdown that "passes" while invisible is exactly the failure mode a
 * countdown cannot afford.
 *
 * Deadlines are expressed relative to `Date.now()` on purpose. The component
 * reads the clock once at render; pinning fake timers inside this 1600-line file
 * would reach into cases these have nothing to do with.
 */
describe('InvoiceDetail dispute deadline and reason', () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const paidDisputed = (over: Partial<InvoiceEntry> = {}) =>
    entry({ status: 'paid', editScope: 'none', amountDue: 0, paidCents: 4000, ...over });
  function disputePanel(): HTMLElement {
    const el = document.querySelector('.invoice-detail__dispute');
    expect(el, 'expected the dispute panel to render').not.toBeNull();
    return el as HTMLElement;
  }
  /** The one element that carries which of the four deadline states was chosen. */
  function deadlineLine(): HTMLElement | null {
    return document.querySelector('.invoice-detail__dispute-deadline');
  }

  it('counts down an open chargeback the operator can still answer', () => {
    // Comfortably inside the third day, so the case cannot straddle a boundary
    // however long the suite takes to reach it.
    const dueByMs = Date.now() + 3 * DAY + HOUR;
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeId: 'dp_1', disputeEvidenceDueByMs: dueByMs })}
        onClose={vi.fn()}
      />,
    );
    const line = deadlineLine();
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute('data-deadline-state', 'due');
    expect(line).toHaveTextContent(/3 days left/);
    // MILLISECONDS, NOT SECONDS. Dividing by 1000 would date this to 1970, and
    // the year is the cheapest possible proof it did not happen.
    expect(line).toHaveTextContent(String(new Date(dueByMs).getFullYear()));
    expect(line).not.toHaveTextContent(/1970/);
    expect(line).not.toHaveTextContent(/-\d/);
  });
  /**
   * NULL IS NEITHER ZERO NOR AN ERROR. Stripe sends `due_by: 0` on purpose,
   * meaning the issuing bank allows no response at all, and the webhook maps it
   * and a genuinely absent value both to null. The banner still renders, the
   * countdown is suppressed, and the operator is sent to Stripe.
   */
  it('says plainly that no deadline is stated rather than counting down to nothing', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeId: 'dp_1' })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    expect(panel).toHaveAttribute('data-tone', 'error');
    const line = deadlineLine();
    expect(line).toHaveAttribute('data-deadline-state', 'unstated');
    expect(line).toHaveTextContent(/no response deadline/i);
    expect(line).toHaveTextContent(/Stripe dashboard/i);
    expect(line).not.toHaveTextContent(/1970|1 January|Jan 1/i);
    expect(line).not.toHaveTextContent(/left/);
  });
  /** A stored 0 is the same statement as an absent one, and never a date. */
  it('treats a stored deadline of 0 as no deadline, not as the epoch', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: 0 })}
        onClose={vi.fn()}
      />,
    );
    expect(deadlineLine()).toHaveAttribute('data-deadline-state', 'unstated');
    expect(disputePanel()).not.toHaveTextContent(/1970/);
  });
  /**
   * A DEADLINE THAT HAS PASSED IS ITS OWN STATE. `disputeStatus` is a mirror of
   * Stripe's, updated by webhook, so it can still read `needs_response` after
   * the window shut. The panel says the window closed, says the status can lag,
   * and sends the operator to Stripe — it does not declare the dispute lost,
   * and it does not print a negative countdown.
   */
  it('says the response window closed, without claiming the dispute is lost', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({
          disputeStatus: 'needs_response',
          disputeId: 'dp_1',
          disputeEvidenceDueByMs: Date.now() - 2 * DAY,
        })}
        onClose={vi.fn()}
      />,
    );
    const line = deadlineLine();
    expect(line).toHaveAttribute('data-deadline-state', 'passed');
    expect(line).toHaveTextContent(/closed/i);
    expect(line).toHaveTextContent(/Stripe dashboard/i);
    expect(line).not.toHaveTextContent(/left/);
    expect(line).not.toHaveTextContent(/-\d/);
    // Not a verdict. The screen knows the clock, not the outcome.
    expect(line).not.toHaveTextContent(/you lost|has been lost|is lost/i);
  });
  /**
   * THE ONE THE OPERATOR ASKED FOR, EXTENDED TO THE CLOCK. A won dispute keeps
   * its deadline on the document forever — nothing ever clears any of these
   * fields — and counting down to it would send the operator to fight a contest
   * that is already over.
   */
  it('shows a WON dispute no countdown, deadline on the document or not', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({
          disputeStatus: 'won',
          disputeId: 'dp_1',
          disputeEvidenceDueByMs: Date.now() + 5 * DAY,
          disputeReason: 'fraudulent',
        })}
        onClose={vi.fn()}
      />,
    );
    const panel = disputePanel();
    expect(panel.getAttribute('data-tone')).not.toBe('error');
    expect(deadlineLine()).toBeNull();
    expect(panel).not.toHaveTextContent(/left\b/);
    expect(panel).not.toHaveTextContent(/deadline/i);
  });
  /**
   * `lost` stays an alarm per #309 — where contested money ends up is the
   * operator's call — but there is nothing left to answer, so no clock.
   */
  it('shows a lost or in-review dispute the alarm and no countdown', () => {
    for (const disputeStatus of ['lost', 'under_review']) {
      const { unmount } = render(
        <InvoiceDetail
          invoice={paidDisputed({ disputeStatus, disputeEvidenceDueByMs: Date.now() + 5 * DAY })}
          onClose={vi.fn()}
        />,
      );
      expect(disputePanel(), disputeStatus).toHaveAttribute('data-tone', 'error');
      expect(deadlineLine(), disputeStatus).toBeNull();
      unmount();
    }
  });
  /** A reason this build knows gets the token AND plain English beside it. */
  it('renders a known reason as the raw Stripe token plus plain English', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeReason: 'product_not_received' })}
        onClose={vi.fn()}
      />,
    );
    const reason = document.querySelector('.invoice-detail__dispute-reason');
    expect(reason).not.toBeNull();
    expect(reason).toHaveAttribute('data-dispute-reason', 'product_not_received');
    expect(reason).toHaveTextContent('product_not_received');
    expect(reason).toHaveTextContent(/never delivered/i);
  });
  /**
   * FALL THROUGH TO THE RAW TOKEN. `reason` is a plain `string` in the pinned
   * SDK and Stripe adds categories without asking. A category this build has
   * never seen is shown as sent; it is not relabelled, not called "Unknown",
   * and it does not take the banner down with it.
   */
  it('shows a reason it has never seen as the raw token, never as "Unknown"', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'needs_response', disputeReason: 'a_category_from_2027' })}
        onClose={vi.fn()}
      />,
    );
    const reason = document.querySelector('.invoice-detail__dispute-reason');
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent('a_category_from_2027');
    expect(reason).not.toHaveTextContent(/unknown/i);
    expect(disputePanel()).toHaveAttribute('data-tone', 'error');
  });
  /** No reason on the document is no reason line. Nothing is guessed into it. */
  it('renders no reason line when the dispute event carried no reason', () => {
    render(
      <InvoiceDetail invoice={paidDisputed({ disputeStatus: 'needs_response' })} onClose={vi.fn()} />,
    );
    expect(document.querySelector('.invoice-detail__dispute-reason')).toBeNull();
  });
  /** The reason is history worth keeping on a settled dispute; the clock is not. */
  it('keeps the reason on a won dispute while keeping the countdown off it', () => {
    render(
      <InvoiceDetail
        invoice={paidDisputed({ disputeStatus: 'won', disputeReason: 'duplicate' })}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector('.invoice-detail__dispute-reason')).toHaveTextContent('duplicate');
    expect(deadlineLine()).toBeNull();
  });
});
