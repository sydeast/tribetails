// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import type {
  ListUninvoicedSessionsResult,
  ListUninvoicedSessionsResultSession,
} from '../contracts/invoiceContracts.generated';

/**
 * #1593, the New invoice half: a typed due date before the invoice date, a
 * typed blank-path total that is not dollars, and a discount larger than the
 * subtotal. Each one is refused BESIDE its field while it is wrong, with Create
 * disabled, and no negative figure is ever printed.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createInvoice, createQuote, listUninvoicedSessions, setSessionDoNotInvoice } = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  createQuote: vi.fn(),
  listUninvoicedSessions: vi.fn(),
  setSessionDoNotInvoice: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  createInvoice,
  createQuote,
  listUninvoicedSessions,
  setSessionDoNotInvoice,
}));

// #1966: the business's Payment terms setting, unset (due on receipt).
vi.mock('../lib/useInvoiceTermsSetting', () => ({
  useInvoiceTermsSetting: () => ({ status: 'ready', paymentTerms: 'due_on_receipt', timeZone: 'America/Chicago', retry: () => {} }),
}));
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: {}, serviceDurations: {}, timeBlocks: [] }),
}));

import { InvoiceCreate, BLANK_TOTAL_PROBLEM, blankTotalProblem, validateBlankInvoice } from './InvoiceCreate';
import { DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem } from '../lib/invoiceDueOrder';

function kinfolk(): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Pat',
    lastName: 'Whitfield',
    phoneNumber: '',
    email: '',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '2026-01-01',
  };
}

function session(over: Partial<ListUninvoicedSessionsResultSession> = {}): ListUninvoicedSessionsResultSession {
  return {
    sessionId: 's1',
    kinfolkId: 'kf1',
    serviceType: 'Dog walk',
    durationMinutes: 60,
    startTime: '2026-07-10T14:00:00.000Z',
    unitCents: 2500,
    pricedAs: null,
    ...over,
  };
}

function work(over: Partial<ListUninvoicedSessionsResult> = {}): ListUninvoicedSessionsResult {
  return {
    sessions: [session()],
    unpriceable: [],
    unplaceable: [],
    excluded: [],
    rateCardLoaded: true,
    scanned: 4,
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [kinfolk()] } satisfies Async<Kinfolk[]>);
  createInvoice.mockReset().mockResolvedValue({ invoiceId: 'inv-1' });
  createQuote.mockReset().mockResolvedValue({ invoiceId: 'inv-2' });
  listUninvoicedSessions.mockReset().mockResolvedValue(work());
  setSessionDoNotInvoice.mockReset();
});

/** The sentence an input names as its description, or null when it names none. */
function describedText(input: HTMLElement): string | null {
  const id = input.getAttribute('aria-describedby');
  if (id === null) return null;
  return document.getElementById(id)?.textContent ?? null;
}

describe('dueDateOrderProblem (pure, the server rule mirrored)', () => {
  it('passes a due date on or after the invoice date', () => {
    expect(dueDateOrderProblem('2026-11-05', '2026-11-05', 'custom')).toBeNull();
    expect(dueDateOrderProblem('2026-11-05', '2026-11-19', 'custom')).toBeNull();
  });

  it('refuses a typed due date before the invoice date, with no code or custom', () => {
    expect(dueDateOrderProblem('2026-11-05', '2026-11-04', 'custom')).toBe(DUE_BEFORE_INVOICE_DATE);
    expect(dueDateOrderProblem('2026-11-05', '2026-11-04', undefined)).toBe(DUE_BEFORE_INVOICE_DATE);
    expect(dueDateOrderProblem('2026-11-05', '2026-11-04', '')).toBe(DUE_BEFORE_INVOICE_DATE);
    expect(DUE_BEFORE_INVOICE_DATE).toBe('The due date has to be on or after the invoice date.');
  });

  it('does not judge a due date the terms set', () => {
    expect(dueDateOrderProblem('2026-11-05', '2026-11-04', 'net_14')).toBeNull();
  });

  it('does not judge a blank or a free-text date', () => {
    expect(dueDateOrderProblem('2026-11-05', '', 'custom')).toBeNull();
    expect(dueDateOrderProblem('', '2026-11-04', 'custom')).toBeNull();
    expect(dueDateOrderProblem('2026-11-05', 'Nov 4', 'custom')).toBeNull();
  });
});

describe('blankTotalProblem (pure)', () => {
  it('passes dollars, zero or more', () => {
    expect(blankTotalProblem('120.00')).toBeNull();
    expect(blankTotalProblem('0')).toBeNull();
  });

  it('refuses letters, a negative and a blank with the one sentence all three clients use', () => {
    expect(BLANK_TOTAL_PROBLEM).toBe('Enter the total as dollars, zero or more, like 120.00.');
    expect(blankTotalProblem('abc')).toBe(BLANK_TOTAL_PROBLEM);
    expect(blankTotalProblem('-5')).toBe(BLANK_TOTAL_PROBLEM);
    expect(blankTotalProblem('')).toBe(BLANK_TOTAL_PROBLEM);
    expect(validateBlankInvoice({ kinfolkId: 'kf1', totalText: '12x', date: '', dueDate: '' })).toBe(
      BLANK_TOTAL_PROBLEM,
    );
  });
});

describe('New invoice: a custom due date before the invoice date', () => {
  async function customTerms() {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
    fireEvent.change(screen.getByLabelText('Invoice date'), { target: { value: '2026-11-05' } });
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'custom');
  }

  it('is refused beside the due date field, and Create is disabled', async () => {
    await customTerms();
    const due = screen.getByLabelText('Invoice due date');
    fireEvent.change(due, { target: { value: '2026-11-04' } });

    expect(due).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(due)).toBe(DUE_BEFORE_INVOICE_DATE);
    // Said once, beside the field, not again beside the button.
    expect(screen.getAllByText(DUE_BEFORE_INVOICE_DATE)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('clears once the due date is on the invoice date, and creates with it', async () => {
    await customTerms();
    const due = screen.getByLabelText('Invoice due date');
    fireEvent.change(due, { target: { value: '2026-11-04' } });
    fireEvent.change(due, { target: { value: '2026-11-05' } });

    expect(due).toHaveAttribute('aria-invalid', 'false');
    expect(due).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(DUE_BEFORE_INVOICE_DATE)).toBeNull();
    const create = screen.getByRole('button', { name: /create invoice/i });
    expect(create).toBeEnabled();
    await userEvent.click(create);
    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice.mock.calls[0]?.[0]).toMatchObject({
      date: '2026-11-05',
      dueDate: '2026-11-05',
      termsCode: 'custom',
    });
  });

  it('is re-judged when the invoice date moves past the due date', async () => {
    await customTerms();
    fireEvent.change(screen.getByLabelText('Invoice due date'), { target: { value: '2026-11-10' } });
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Invoice date'), { target: { value: '2026-11-11' } });
    expect(describedText(screen.getByLabelText('Invoice due date'))).toBe(DUE_BEFORE_INVOICE_DATE);
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
  });

  it('shows the server refusal as its own sentence if one gets through', async () => {
    createInvoice.mockRejectedValue(new Error(DUE_BEFORE_INVOICE_DATE));
    await customTerms();
    fireEvent.change(screen.getByLabelText('Invoice due date'), { target: { value: '2026-11-20' } });
    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    expect(await screen.findByText(/the due date has to be on or after the invoice date\./i)).toBeInTheDocument();
  });
});

describe('New invoice: the blank path typed total', () => {
  async function blankPath() {
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [], scanned: 3 }));
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(await screen.findByRole('button', { name: /write a blank invoice instead/i }));
  }

  it('an empty total holds Create back, with the reason on screen', async () => {
    await blankPath();
    expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeDisabled();
    expect(screen.getByText(BLANK_TOTAL_PROBLEM)).toBeInTheDocument();
    // Not flagged red before anything has been typed.
    expect(screen.getByLabelText('Total')).toHaveAttribute('aria-invalid', 'false');
  });

  it('letters in the total are refused beside the field, before any click', async () => {
    await blankPath();
    const total = screen.getByLabelText('Total');
    await userEvent.type(total, 'abc');
    expect(total).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(total)).toBe(BLANK_TOTAL_PROBLEM);
    expect(screen.getAllByText(BLANK_TOTAL_PROBLEM)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeDisabled();
  });

  it('a negative total is refused the same way', async () => {
    await blankPath();
    await userEvent.type(screen.getByLabelText('Total'), '-5');
    expect(describedText(screen.getByLabelText('Total'))).toBe(BLANK_TOTAL_PROBLEM);
    expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeDisabled();
  });

  it('a real total enables Create and sends it', async () => {
    await blankPath();
    await userEvent.type(screen.getByLabelText('Total'), '120.00');
    expect(screen.queryByText(BLANK_TOTAL_PROBLEM)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^create invoice$/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice.mock.calls[0]?.[0]).toMatchObject({ total: 120, amountDue: 120 });
  });
});

describe('New invoice: a discount larger than the subtotal', () => {
  async function oneVisit() {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
  }

  it('shows no total and the refusal beside the discount field, never a negative figure', async () => {
    await oneVisit();
    const discount = screen.getByLabelText('Whole invoice discount in dollars');
    await userEvent.type(discount, '77');

    const sentence = 'Invoice discount ($77.00) is larger than the subtotal ($25.00).';
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(discount)).toBe(sentence);
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent(/^-$/);
    expect(screen.queryByText(/-\$/)).toBeNull();
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
  });

  it('letters in the discount are refused beside the field too', async () => {
    await oneVisit();
    const discount = screen.getByLabelText('Whole invoice discount in dollars');
    await userEvent.type(discount, 'ten');
    expect(describedText(discount)).toBe('Invoice discount needs a dollar amount, or leave it empty.');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent(/^-$/);
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
  });

  it('a discount within the visits is measured against them, not against the extra charges alone', async () => {
    await oneVisit();
    await userEvent.type(screen.getByLabelText('Whole invoice discount in dollars'), '10');

    expect(screen.getByLabelText('Whole invoice discount in dollars')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByText('Subtotal').nextElementSibling).toHaveTextContent('$25.00');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$15.00');
    expect(screen.getByText(/will be created for \$15\.00/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create invoice for 1 visit/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice.mock.calls[0]?.[0]).toMatchObject({ total: 15, amountDue: 15, invoiceDiscountCents: 1000 });
  });
});
