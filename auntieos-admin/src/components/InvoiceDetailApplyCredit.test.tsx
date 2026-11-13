// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';

/**
 * #1872 (operator ruling 2026-11-11): account credit is never spent
 * automatically. On the invoice detail that means two things:
 *
 *   Review and send says only what it does (it sends the draft and marks the
 *   invoice open) and calls nothing that touches credit, and
 *
 *   an open invoice shows the household's available credit with a box to apply
 *   an amount she types, while a draft, a quote, a paid invoice and an archived
 *   one show no such box.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { reviewAndSendDraftInvoice, runAutoApply, getInvoiceLedger, previewInvoiceNotice, useCollection } = vi.hoisted(
  () => ({
    reviewAndSendDraftInvoice: vi.fn(),
    runAutoApply: vi.fn(),
    getInvoiceLedger: vi.fn(),
    previewInvoiceNotice: vi.fn(),
    useCollection: vi.fn(),
  }),
);
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  reviewAndSendDraftInvoice,
  runAutoApply,
  getInvoiceLedger,
  previewInvoiceNotice,
}));
const credit = vi.hoisted(() => ({
  getAccountCreditHistory: vi.fn(),
  applyAccountCredit: vi.fn(),
  giveAccountCredit: vi.fn(),
}));
vi.mock('../api/accountCredit', () => credit);
const { readInvoiceSendMarks } = vi.hoisted(() => ({ readInvoiceSendMarks: vi.fn() }));
vi.mock('../api/invoiceSendCheck', () => ({ readInvoiceSendMarks }));
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: {}, serviceDurations: {}, timeBlocks: [] }),
}));

import { InvoiceDetail } from './InvoiceDetail';

function fakeTs(iso: string): Timestamp {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() } as unknown as Timestamp;
}

function entry(over: Partial<InvoiceEntry> = {}): InvoiceEntry {
  return {
    _id: 'inv1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    client: '',
    invoiceNumber: '1026',
    date: '2026-11-05',
    dueDate: '2026-11-19',
    total: 100,
    amountDue: 100,
    amountDueCents: 10000,
    status: 'open',
    editScope: 'all',
    sessionIds: [],
    createdAt: fakeTs('2026-11-05T09:00:00Z'),
    ...over,
  };
}

const AMOUNT_BOX = 'Account credit to apply, in dollars';

beforeEach(() => {
  reviewAndSendDraftInvoice.mockReset().mockResolvedValue({ appOnly: false });
  runAutoApply.mockReset();
  // The ledger panel is not what this file is about: it stays loading.
  getInvoiceLedger.mockReset().mockReturnValue(new Promise(() => {}));
  // The confirm's who-and-how line. Never left to reach the network.
  previewInvoiceNotice.mockReset().mockResolvedValue({
    ok: true,
    key: 'invoice.new',
    hasRecipient: true,
    recipientName: 'Robin Wren',
    email: { on: true, address: 'catch@hanasamku.com' },
    sms: { on: false, address: '' },
    push: { on: false },
    disabled: null,
    householdGateLive: true,
  });
  readInvoiceSendMarks.mockReset();
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
  credit.getAccountCreditHistory
    .mockReset()
    .mockResolvedValue({ ok: true, kinfolkId: 'kf1', accountBalanceCents: 12000, credits: [], uses: [] });
  credit.applyAccountCredit.mockReset();
});

describe('Review and send says only what happens (#1872)', () => {
  const DRAFT = { status: 'draft' } as const;

  it('the confirm names the send and the open invoice, and nothing about credit or payment', async () => {
    render(<InvoiceDetail invoice={entry(DRAFT)} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review and send' }));

    const confirm = screen.getByText(/This sends the draft to the household on file and marks the invoice open\./);
    expect(confirm.textContent).not.toMatch(/credit|paid|payment/i);
  });

  it('sending calls the send and nothing that spends credit, and the notice says only that it was sent', async () => {
    render(<InvoiceDetail invoice={entry(DRAFT)} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(screen.getByRole('button', { name: 'Review and send' }));

    expect(await screen.findByText('Draft sent.')).toBeInTheDocument();
    expect(reviewAndSendDraftInvoice).toHaveBeenCalledTimes(1);
    expect(reviewAndSendDraftInvoice).toHaveBeenCalledWith('inv1');
    expect(runAutoApply).not.toHaveBeenCalled();
    expect(credit.applyAccountCredit).not.toHaveBeenCalled();
  });

  it('a draft offers no credit box and does not read the household balance', async () => {
    render(<InvoiceDetail invoice={entry(DRAFT)} onClose={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Account credit' })).toBeNull();
    expect(screen.queryByLabelText(AMOUNT_BOX)).toBeNull();
    expect(credit.getAccountCreditHistory).not.toHaveBeenCalled();
  });
});

describe('An open invoice lets her apply account credit she types (#1872)', () => {
  it('shows the household balance and the amount box', async () => {
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    expect(await screen.findByTestId('invoice-credit-available')).toHaveTextContent('$120.00 available');
    expect(screen.getByLabelText(AMOUNT_BOX)).toBeInTheDocument();
    expect(credit.getAccountCreditHistory).toHaveBeenCalledWith('kf1');
  });

  it('applies the amount after the confirm, then says what happened and reloads the payments', async () => {
    credit.applyAccountCredit.mockResolvedValue({
      ok: true,
      invoiceId: 'inv1',
      paymentId: 'acr_1790000000000_abc123',
      appliedCents: 2500,
      amountDueCents: 7500,
      accountBalanceCents: 9500,
      replayed: false,
    });
    render(<InvoiceDetail invoice={entry()} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(AMOUNT_BOX), '25');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    expect(
      screen.getByText(
        'Apply $25.00 of account credit to invoice 1026? The invoice will have $75.00 left to pay. The household keeps $95.00 of credit.',
      ),
    ).toBeInTheDocument();
    expect(credit.applyAccountCredit).not.toHaveBeenCalled();
    const ledgerReadsBefore = getInvoiceLedger.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    expect(
      await screen.findByText(
        'Applied $25.00 of account credit to invoice 1026. $75.00 is left to pay. The household has $95.00 of credit left.',
      ),
    ).toBeInTheDocument();
    expect(credit.applyAccountCredit).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv1', amountCents: 2500 }),
    );
    await waitFor(() => expect(getInvoiceLedger.mock.calls.length).toBeGreaterThan(ledgerReadsBefore));
  });

  it('a part-paid invoice checks the amount against what is left, not the total', async () => {
    render(<InvoiceDetail invoice={entry({ amountDue: 40, amountDueCents: 4000 })} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(AMOUNT_BOX), '40.01');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This invoice has $40.00 left to pay. Enter that much or less.');
    expect(credit.applyAccountCredit).not.toHaveBeenCalled();
  });
});

describe('Invoices that take no credit show no box (#1872)', () => {
  for (const [name, over] of [
    ['a paid invoice', { status: 'paid', amountDue: 0, amountDueCents: 0 }],
    ['a quote', { status: 'quote' }],
    ['an archived invoice', { archivedAt: fakeTs('2026-11-06T09:00:00Z') }],
  ] as const) {
    it(name, async () => {
      render(<InvoiceDetail invoice={entry(over as Partial<InvoiceEntry>)} onClose={vi.fn()} />);
      // Let any effect that would have asked for the balance run.
      await waitFor(() => expect(getInvoiceLedger).toHaveBeenCalled());
      expect(screen.queryByRole('region', { name: 'Account credit' })).toBeNull();
      expect(screen.queryByLabelText(AMOUNT_BOX)).toBeNull();
      expect(credit.getAccountCreditHistory).not.toHaveBeenCalled();
    });
  }
});
