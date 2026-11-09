// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';

/**
 * #1593, the Edit invoice half: a typed due date before the invoice date is
 * refused beside the field with Save disabled, and a discount larger than the
 * subtotal shows no total rather than a negative one.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { updateInvoice, getInvoiceLedger, previewInvoiceNotice, useCollection } = vi.hoisted(() => ({
  updateInvoice: vi.fn(),
  getInvoiceLedger: vi.fn(),
  previewInvoiceNotice: vi.fn(),
  useCollection: vi.fn(),
}));
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  updateInvoice,
  getInvoiceLedger,
  previewInvoiceNotice,
}));
const { readInvoiceSendMarks } = vi.hoisted(() => ({ readInvoiceSendMarks: vi.fn() }));
vi.mock('../api/invoiceSendCheck', () => ({ readInvoiceSendMarks }));
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: {}, serviceDurations: {}, timeBlocks: [] }),
}));

import { InvoiceDetail, editDueOrderProblem } from './InvoiceDetail';
import { DUE_BEFORE_INVOICE_DATE } from '../lib/invoiceDueOrder';

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
    invoiceNumber: '1042',
    date: '2026-11-05',
    dueDate: '2026-11-19',
    total: 40,
    amountDue: 40,
    status: 'open',
    editScope: 'all',
    sessionIds: [],
    createdAt: fakeTs('2026-11-05T09:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  updateInvoice.mockReset().mockResolvedValue({ subtotalCents: 0, totalCents: 0, paidCents: 0, amountDueCents: 0 });
  // The ledger panel is not what this file is about: it stays loading.
  getInvoiceLedger.mockReset().mockReturnValue(new Promise(() => {}));
  previewInvoiceNotice.mockReset();
  readInvoiceSendMarks.mockReset();
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
});

function describedText(input: HTMLElement): string | null {
  const id = input.getAttribute('aria-describedby');
  if (id === null) return null;
  return document.getElementById(id)?.textContent ?? null;
}

/** A figure in the line-items editor's own totals, not the invoice's read-only facts. */
function editorFigure(label: string): Element | null {
  const totals = document.querySelector<HTMLElement>('.invoice-lines-editor__totals');
  if (totals === null) throw new Error('the line-items editor is not open');
  return within(totals).getByText(label).nextElementSibling;
}
async function openEdit(over: Partial<InvoiceEntry> = {}) {
  render(<InvoiceDetail invoice={entry(over)} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
}

describe('editDueOrderProblem (pure)', () => {
  const stored: { date: string; dueDate: string; termsCode?: string } = { date: '2026-11-05', dueDate: '2026-11-19' };

  it('passes an edit that keeps the due date on or after the invoice date', () => {
    expect(editDueOrderProblem({ date: '2026-11-05', dueDate: '2026-11-05', termsChoice: 'kept' }, stored)).toBeNull();
  });

  it('refuses a typed due date moved before the invoice date', () => {
    expect(editDueOrderProblem({ date: '2026-11-05', dueDate: '2026-11-01', termsChoice: 'kept' }, stored)).toBe(
      DUE_BEFORE_INVOICE_DATE,
    );
  });

  it('refuses an invoice date moved past the stored due date', () => {
    expect(editDueOrderProblem({ date: '2026-11-20', dueDate: '2026-11-19', termsChoice: 'kept' }, stored)).toBe(
      DUE_BEFORE_INVOICE_DATE,
    );
  });

  it('leaves an untouched invoice alone, even one already in the wrong order', () => {
    const old = { date: '2026-11-05', dueDate: '2026-11-01' };
    expect(editDueOrderProblem({ ...old, termsChoice: 'kept' }, old)).toBeNull();
  });

  it('does not judge a due date set by structured terms', () => {
    expect(
      editDueOrderProblem({ date: '2026-11-05', dueDate: '2026-11-01', termsChoice: 'net_14' }, { ...stored }),
    ).toBeNull();
    expect(
      editDueOrderProblem(
        { date: '2026-11-05', dueDate: '2026-11-01', termsChoice: 'net_14' },
        { ...stored, termsCode: 'net_14' },
      ),
    ).toBeNull();
  });

  it('judges the due date once the terms are switched to custom', () => {
    expect(
      editDueOrderProblem(
        { date: '2026-11-05', dueDate: '2026-11-01', termsChoice: 'custom' },
        { ...stored, termsCode: 'net_14', dueDate: '2026-11-01' },
      ),
    ).toBe(DUE_BEFORE_INVOICE_DATE);
  });
});

describe('Edit invoice: due date before the invoice date', () => {
  it('is refused beside the due date field, and Save is disabled', async () => {
    await openEdit();
    const due = screen.getByLabelText('Invoice due date');
    fireEvent.change(due, { target: { value: '2026-11-01' } });

    expect(due).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(due)).toBe(DUE_BEFORE_INVOICE_DATE);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(updateInvoice).not.toHaveBeenCalled();
  });

  it('saves once the due date is put back after the invoice date', async () => {
    await openEdit();
    const due = screen.getByLabelText('Invoice due date');
    fireEvent.change(due, { target: { value: '2026-11-01' } });
    fireEvent.change(due, { target: { value: '2026-11-12' } });

    expect(due).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(DUE_BEFORE_INVOICE_DATE)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateInvoice).toHaveBeenCalledWith('inv1', { dueDate: '2026-11-12' }));
  });

  it('is not raised when structured terms are picked, which set the due date themselves', async () => {
    await openEdit({ dueDate: '2026-11-01' });
    await userEvent.selectOptions(screen.getByLabelText('Invoice terms'), 'net_30');
    expect(screen.getByLabelText('Invoice due date')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('shows the server refusal as its own sentence if one gets through', async () => {
    updateInvoice.mockRejectedValue(new Error(DUE_BEFORE_INVOICE_DATE));
    await openEdit();
    fireEvent.change(screen.getByLabelText('Invoice due date'), { target: { value: '2026-11-12' } });
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(`Could not save: ${DUE_BEFORE_INVOICE_DATE}`)).toBeInTheDocument();
  });
});

describe('Edit invoice: a discount larger than the subtotal', () => {
  const itemized = {
    lineItems: [{ description: 'Dog walk', qty: 1, unitCents: 2500 }],
    invoiceDiscountCents: 0,
    total: 25,
    amountDue: 25,
  } as Partial<InvoiceEntry>;

  it('shows no total and the refusal beside the discount field, never -$52.00', async () => {
    await openEdit(itemized);
    const discount = screen.getByLabelText('Whole invoice discount in dollars');
    await userEvent.type(discount, '77');

    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(discount)).toBe('Invoice discount ($77.00) is larger than the subtotal ($25.00).');
    expect(editorFigure('Total')).toHaveTextContent(/^-$/);
    expect(screen.queryByText('-$52.00')).toBeNull();
  });

  it('a line discount larger than its line is refused beside that line, with no amount shown', async () => {
    await openEdit(itemized);
    const lineDiscount = screen.getByLabelText('Line 1 discount in dollars');
    await userEvent.type(lineDiscount, '30');

    expect(lineDiscount).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(lineDiscount)).toBe('Discount for "Dog walk" ($30.00) is larger than the line itself ($25.00).');
    expect(editorFigure('Subtotal')).toHaveTextContent(/^-$/);
    expect(editorFigure('Total')).toHaveTextContent(/^-$/);
    expect(screen.queryByText('-$5.00')).toBeNull();
  });

  it('a discount within the subtotal shows the real total', async () => {
    await openEdit(itemized);
    await userEvent.type(screen.getByLabelText('Whole invoice discount in dollars'), '5');
    expect(screen.getByLabelText('Whole invoice discount in dollars')).toHaveAttribute('aria-invalid', 'false');
    expect(editorFigure('Total')).toHaveTextContent('$20.00');
  });
});
