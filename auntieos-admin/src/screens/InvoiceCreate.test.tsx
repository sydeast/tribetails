// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createInvoice, createQuote } = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  createQuote: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  createInvoice,
  createQuote,
}));

import { InvoiceCreate, isValidInvoiceDate, validateInvoiceCreate } from './InvoiceCreate';

function kinfolk(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Pat',
    lastName: 'Whitfield',
    phoneNumber: '',
    email: '',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '2026-01-01',
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [kinfolk({})] } satisfies Async<Kinfolk[]>);
  createInvoice.mockReset();
  createQuote.mockReset();
});

describe('isValidInvoiceDate (pure)', () => {
  it('accepts a real calendar date', () => {
    expect(isValidInvoiceDate('2026-07-16')).toBe(true);
  });

  it('rejects an out-of-range month or day', () => {
    expect(isValidInvoiceDate('2026-13-01')).toBe(false);
    expect(isValidInvoiceDate('2026-04-31')).toBe(false);
  });

  it('rejects a malformed string without throwing', () => {
    expect(isValidInvoiceDate('Net 14')).toBe(false);
    expect(isValidInvoiceDate('')).toBe(false);
  });
});

describe('validateInvoiceCreate (pure)', () => {
  const valid = { kinfolkId: 'kf1', invoiceNumber: '1', totalText: '10', amountDueText: '10', date: '', dueDate: '' };

  it('passes a fully valid form', () => {
    expect(validateInvoiceCreate(valid)).toBeNull();
  });

  it('requires a household', () => {
    expect(validateInvoiceCreate({ ...valid, kinfolkId: '' })).toMatch(/household/i);
  });

  it('requires an invoice number', () => {
    expect(validateInvoiceCreate({ ...valid, invoiceNumber: '' })).toMatch(/invoice number/i);
  });

  it('rejects a negative or blank total', () => {
    expect(validateInvoiceCreate({ ...valid, totalText: '-1' })).toMatch(/total/i);
    expect(validateInvoiceCreate({ ...valid, totalText: '' })).toMatch(/total/i);
  });

  it('rejects a negative or blank amount due', () => {
    expect(validateInvoiceCreate({ ...valid, amountDueText: '-1' })).toMatch(/amount due/i);
  });

  it('rejects an unparseable date or due date', () => {
    expect(validateInvoiceCreate({ ...valid, date: 'nope' })).toMatch(/date/i);
    expect(validateInvoiceCreate({ ...valid, dueDate: 'nope' })).toMatch(/due date/i);
  });
});

describe('InvoiceCreate', () => {
  it('titles the dialog "New invoice" in invoice mode', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'New invoice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });

  it('titles the dialog "New quote" in quote mode and shows the send-to-kinfolk toggle instead of a status picker', () => {
    render(<InvoiceCreate mode="quote" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'New quote' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create quote/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /send to kinfolk now/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^status$/i)).toBeNull();
  });

  it('lists households from the live kinfolk stream', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [kinfolk({ _id: 'kf9', firstName: 'Cher', lastName: '' })] });
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Cher' })).toBeInTheDocument();
  });

  it('surfaces a household-load failure, fail loud, not a silently empty picker', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByText(/couldn.t load households/i)).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('blocks submit and shows a validation message when required fields are missing', async () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    // Scoped to the banner (role="alert"), not the picker's own placeholder
    // option, which shares the same "Pick a household" wording.
    expect(await screen.findByRole('alert')).toHaveTextContent(/pick a household for this invoice/i);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('creates an invoice with the trimmed, typed payload and closes on success', async () => {
    createInvoice.mockResolvedValue({ invoiceId: 'inv-1' });
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<InvoiceCreate mode="invoice" onClose={onClose} onCreated={onCreated} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText(/invoice number/i), ' 2001 ');
    await userEvent.type(screen.getByLabelText(/^total/i), '75');
    await userEvent.type(screen.getByLabelText(/amount due/i), '75');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    const sent = createInvoice.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      familyId: 'kf1',
      kinfolkName: 'Pat Whitfield',
      invoiceNumber: '2001',
      total: 75,
      amountDue: 75,
      status: 'draft',
      sessionIds: [],
    });
    expect(onCreated).toHaveBeenCalledWith('inv-1');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('creates a quote via createQuote, carrying the send-to-kinfolk toggle', async () => {
    createQuote.mockResolvedValue({ invoiceId: 'inv-2' });
    render(<InvoiceCreate mode="quote" onClose={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText(/invoice number/i), '3001');
    await userEvent.type(screen.getByLabelText(/^total/i), '50');
    await userEvent.type(screen.getByLabelText(/amount due/i), '50');
    await userEvent.click(screen.getByRole('switch', { name: /send to kinfolk now/i }));
    await userEvent.click(screen.getByRole('button', { name: /create quote/i }));

    await waitFor(() => expect(createQuote).toHaveBeenCalledTimes(1));
    expect(createQuote.mock.calls[0]?.[0]).toMatchObject({ sendToKinfolk: true, status: '' });
  });

  it('fails loud when createInvoice rejects: banner shown, dialog stays open, not swallowed', async () => {
    createInvoice.mockRejectedValue(new Error('permission-denied'));
    const onClose = vi.fn();
    render(<InvoiceCreate mode="invoice" onClose={onClose} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText(/invoice number/i), '4001');
    await userEvent.type(screen.getByLabelText(/^total/i), '10');
    await userEvent.type(screen.getByLabelText(/amount due/i), '10');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/createInvoice failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Cancel closes without calling createInvoice', async () => {
    const onClose = vi.fn();
    render(<InvoiceCreate mode="invoice" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(createInvoice).not.toHaveBeenCalled();
  });
});
/**
 * Task 5.1: the itemized path.
 *
 * Both entry paths are kept because both are legitimate. Forcing itemization
 * would make the composer refuse the quick one-off bill it exists to write;
 * dropping the flat path would strand every workflow that predates 5.1.
 */
describe('InvoiceCreate itemized path', () => {
  async function openItemized() {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Invoice number'), 'INV-1');
    await userEvent.click(screen.getByRole('button', { name: /itemize it/i }));
  }
  it('sends NO lineItems key at all on the flat path', async () => {
    // The server treats the key's PRESENCE as "this invoice is itemized", and
    // an empty array would arm `updateInvoice`'s recompute on an invoice whose
    // total was typed by hand: a later due-date fix would rewrite it to $0.
    createInvoice.mockResolvedValue({ invoiceId: 'new1' });
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Invoice number'), 'INV-1');
    await userEvent.type(screen.getByLabelText(/^total/i), '40');
    await userEvent.type(screen.getByLabelText(/^amount due/i), '40');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    const sent = createInvoice.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('lineItems');
    expect(sent).not.toHaveProperty('invoiceDiscountCents');
    expect(sent.total).toBe(40);
  });
  it('replaces the total fields with a derived figure once itemized', async () => {
    await openItemized();
    // There is nowhere to type a total on this path, by design.
    expect(screen.queryByLabelText(/^total \(\$\)/i)).toBeNull();
    expect(screen.queryByLabelText(/^amount due/i)).toBeNull();
    // And with no lines yet it does NOT promise "$0.00": an empty set and a
    // zero total are different facts, and only one of them can be sent.
    expect(screen.getByText(/add a line, or bring some in from the visits picker/i)).toBeInTheDocument();
    expect(screen.queryByText(/will be sent for \$0\.00/i)).toBeNull();
  });
  it('sends the DERIVED total, matching the lines the server will recompute', async () => {
    createInvoice.mockResolvedValue({ invoiceId: 'new1' });
    await openItemized();
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await userEvent.type(screen.getByLabelText('Line 1 description'), 'Dog walk');
    await userEvent.clear(screen.getByLabelText('Line 1 quantity'));
    await userEvent.type(screen.getByLabelText('Line 1 quantity'), '3');
    await userEvent.type(screen.getByLabelText('Line 1 unit price in dollars'), '25.00');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    const sent = createInvoice.mock.calls[0]![0] as Record<string, unknown>;
    // The server REFUSES a total that disagrees with the lines, so these two
    // must come from the same computation. They do: both are the mirrored
    // invoiceMath module the server recomputes from.
    expect(sent.total).toBe(75);
    expect(sent.amountDue).toBe(75);
    expect(sent.lineItems).toEqual([{ description: 'Dog walk', qty: 3, unitCents: 2500 }]);
    expect(sent.invoiceDiscountCents).toBe(0);
  });
  it('refuses to submit an itemized invoice with no lines', async () => {
    await openItemized();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/add at least one line item/i)).toBeInTheDocument();
    expect(createInvoice).not.toHaveBeenCalled();
  });
  it('refuses a line whose price cannot be read, rather than billing zero for it', async () => {
    await openItemized();
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await userEvent.type(screen.getByLabelText('Line 1 description'), 'Dog walk');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/needs a dollar amount/i)).toBeInTheDocument();
    expect(createInvoice).not.toHaveBeenCalled();
  });
  it('offers the visits picker only once a household is chosen', async () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /itemize it/i }));
    expect(screen.getByRole('button', { name: /add from visits/i })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.getByRole('button', { name: /add from visits/i })).toBeEnabled();
  });
  it('uses real date inputs, so "Net 14" can no longer reach the field the list sorts on', async () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Invoice date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Invoice due date')).toHaveAttribute('type', 'date');
  });
});
