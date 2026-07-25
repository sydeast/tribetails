// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';

const {
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
  reviewAndSendDraftInvoice,
  updateInvoice,
  archiveInvoice,
  unarchiveInvoice,
} = vi.hoisted(() => ({
  sendInvoiceReminder: vi.fn(),
  markInvoicePaid: vi.fn(),
  generateReceipt: vi.fn(),
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
  reviewAndSendDraftInvoice,
  updateInvoice,
  archiveInvoice,
  unarchiveInvoice,
}));

import { InvoiceDetail } from './InvoiceDetail';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
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
  updateInvoice.mockReset().mockResolvedValue({
    subtotalCents: 0, totalCents: 0, paidCents: 0, amountDueCents: 0,
  });
  archiveInvoice.mockReset().mockResolvedValue(undefined);
  unarchiveInvoice.mockReset().mockResolvedValue(undefined);
});

/**
 * Every action label the panel can ever render. The per-state cases below
 * assert the EXACT set: each expected label present, every other label
 * absent, so a future action leaking into the wrong state fails here rather
 * than reaching an operator (the AO-19 report: a PAID invoice still offering
 * "Mark paid").
 */
const ALL_ACTION_LABELS = ['Send reminder', 'Mark paid', 'Generate receipt', 'Review and send'] as const;

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
    it('PAID: Generate receipt only, no Mark paid and no Send reminder', () => {
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

    it('OUTSTANDING: Mark paid and Send reminder, no receipt, no draft send', () => {
      render(<InvoiceDetail invoice={entry({ status: '', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('OPEN')).toBeInTheDocument();
      expectExactActions(['Send reminder', 'Mark paid']);
    });

    it('OVERDUE: the same set as outstanding (overdue refines open, it is not its own state)', () => {
      render(
        <InvoiceDetail
          invoice={entry({ status: '', amountDue: 40, total: 40, dueDate: '2000-01-01' })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('OVERDUE')).toBeInTheDocument();
      expectExactActions(['Send reminder', 'Mark paid']);
    });

    it('DRAFT: Review and send only', () => {
      render(<InvoiceDetail invoice={entry({ status: 'draft', amountDue: 40, total: 40 })} onClose={vi.fn()} />);
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expectExactActions(['Review and send']);
    });

    it('DRAFT past its due date is still a draft, never overdue: no payment actions', () => {
      // The overlap ruling: `dueDate` is ignored on anything that is not open,
      // so a stale-dated draft can never pick up Mark paid / Send reminder.
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

  it('marks paid through markInvoicePaid with no payment details when the fields are left blank', async () => {
    markInvoicePaid.mockResolvedValue(undefined);
    render(<InvoiceDetail invoice={entry({ _id: 'inv7', kinfolkId: 'kf7' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^mark paid$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^mark paid$/i }));
    await waitFor(() => expect(markInvoicePaid).toHaveBeenCalledWith('inv7', {}));
    expect(await screen.findByText(/marked paid/i)).toBeInTheDocument();
  });

  it('marks paid through markInvoicePaid, passing the entered method and reference', async () => {
    markInvoicePaid.mockResolvedValue(undefined);
    render(<InvoiceDetail invoice={entry({ _id: 'inv8', kinfolkId: 'kf8' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^mark paid$/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /payment method/i }), 'check');
    await userEvent.type(screen.getByRole('textbox', { name: /payment reference/i }), 'CK-100');
    await userEvent.click(screen.getByRole('button', { name: /^mark paid$/i }));
    await waitFor(() =>
      expect(markInvoicePaid).toHaveBeenCalledWith('inv8', { method: 'check', reference: 'CK-100' }),
    );
    expect(await screen.findByText(/marked paid/i)).toBeInTheDocument();
  });

  it('no longer claims mark paid records nothing, the confirm copy names the optional fields instead', async () => {
    render(<InvoiceDetail invoice={entry({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^mark paid$/i }));
    expect(screen.queryByText(/does not record a payment method/i)).toBeNull();
    expect(screen.getByText(/method and reference are optional/i)).toBeInTheDocument();
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
  it('offers Edit on an open invoice and not on a paid one', () => {
    const { unmount } = render(<InvoiceDetail invoice={entry({ amountDue: 40, total: 40 })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    unmount();
    render(<InvoiceDetail invoice={entry({ status: 'paid', amountDue: 0, total: 40 })} onClose={vi.fn()} />);
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
    for (const status of ['draft', 'quote', 'paid', 'cancelled', 'credit', '']) {
      const { unmount } = render(<InvoiceDetail invoice={entry({ status })} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
      unmount();
    }
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
