// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    sessions: [],
    missingSessionIds: [],
    orphanSessionIds: [],
    truncated: false,
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
  recordPayment.mockReset().mockResolvedValue({ ok: true, paymentId: 'led1', kinfolkId: 'kf1' });
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
        payments: [
          {
            paymentId: 'p1',
            amountCents: 2000,
            method: 'check',
            reference: '#881',
            paidAt: '2026-07-20T10:00:00Z',
            recordedBy: 'admin1',
          },
        ],
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
          { paymentId: 'p1', amountCents: 500, method: null, reference: null, paidAt: null, recordedBy: null },
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
        payments: [
          { paymentId: 'p1', amountCents: 4000, method: 'cash', reference: null, paidAt: '2026-07-20T10:00:00Z', recordedBy: 'a1' },
        ],
        paidCents: 4000,
        amountDueCents: 0,
        ledgerPayments: [
          {
            paymentId: 'r1',
            amountCents: 4000,
            tipCents: 500,
            method: 'card',
            reference: 'ch_1',
            date: '2026-07-20',
            notes: '',
            recordedBy: 'a1',
          },
        ],
      }),
    );
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByText(/NOT counted in the figures above/i)).toBeInTheDocument();
    // The tip rides on the ledger row's own amount and nowhere near the balance.
    expect(screen.getByText(/includes \$5\.00 tip/i)).toBeInTheDocument();
    expect(screen.getByText('Collected').closest('tr')).toHaveTextContent('$40.00');
  });
  it('names the Stripe case: a ledger that covers a balance nothing settled', async () => {
    getInvoiceLedger.mockResolvedValue(
      ledgerResult({
        amountDueCents: 4000,
        ledgerPayments: [
          {
            paymentId: 'r1',
            amountCents: 4000,
            tipCents: 0,
            method: 'card',
            reference: 'ch_1',
            date: '2026-07-20',
            notes: '',
            recordedBy: null,
          },
        ],
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
