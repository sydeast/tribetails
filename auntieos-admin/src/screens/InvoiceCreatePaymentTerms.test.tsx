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
import type { InvoiceTermsSetting } from '../lib/useInvoiceTermsSetting';

/**
 * #1966: New invoice starts on the business's Payment terms setting, counts
 * visit days on the business's clock, and makes an invoice with no visits due
 * on receipt. The terms and the due date stay the operator's to change.
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

vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: {}, serviceDurations: {}, timeBlocks: [] }),
}));

const { termsSetting } = vi.hoisted(() => ({ termsSetting: vi.fn<() => InvoiceTermsSetting>() }));
vi.mock('../lib/useInvoiceTermsSetting', () => ({ useInvoiceTermsSetting: termsSetting }));

import { InvoiceCreate } from './InvoiceCreate';

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
    startTime: '2026-11-20T15:00:00.000Z',
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

function setting(over: Partial<InvoiceTermsSetting> = {}): InvoiceTermsSetting {
  return { status: 'ready', paymentTerms: 'due_on_receipt', timeZone: 'America/Chicago', retry: vi.fn(), ...over };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [kinfolk()] } satisfies Async<Kinfolk[]>);
  createInvoice.mockReset().mockResolvedValue({ invoiceId: 'inv-1' });
  createQuote.mockReset().mockResolvedValue({ invoiceId: 'inv-2' });
  listUninvoicedSessions.mockReset().mockResolvedValue(work());
  setSessionDoNotInvoice.mockReset();
  termsSetting.mockReset().mockReturnValue(setting());
});

async function openWithVisits() {
  render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
  await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
  await screen.findAllByRole('checkbox');
  fireEvent.change(screen.getByLabelText('Invoice date'), { target: { value: '2026-12-01' } });
}

describe('New invoice: Payment terms from Settings (#1966)', () => {
  it('starts on due on receipt when the business has not changed it', async () => {
    await openWithVisits();
    expect(screen.getByLabelText('Terms')).toHaveValue('due_on_receipt');
    expect(screen.getByLabelText('Invoice due date')).toHaveValue('2026-12-01');
  });

  it('starts on the business setting and works the due date out from the visits', async () => {
    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_14_after_last_visit' }));
    await openWithVisits();
    expect(screen.getByLabelText('Terms')).toHaveValue('net_14_after_last_visit');
    // Nov 20 + 14.
    expect(screen.getByLabelText('Invoice due date')).toHaveValue('2026-12-04');
    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice.mock.calls[0]?.[0]).toMatchObject({
      termsCode: 'net_14_after_last_visit',
      dueDate: '2026-12-04',
    });
  });

  it('counts an evening visit on its Chicago day', async () => {
    termsSetting.mockReturnValue(setting({ paymentTerms: 'due_on_last_visit' }));
    // 7 PM on Nov 30 in Chicago, 01:00 on Dec 1 in UTC.
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [session({ startTime: '2026-12-01T01:00:00.000Z' })] }));
    await openWithVisits();
    expect(screen.getByLabelText('Invoice due date')).toHaveValue('2026-11-30');
  });

  it('counts back from the first visit for before-first-visit terms', async () => {
    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_3_before_first_visit' }));
    listUninvoicedSessions.mockResolvedValue(
      work({
        sessions: [
          session({ sessionId: 's1', startTime: '2026-12-09T15:00:00.000Z' }),
          session({ sessionId: 's2', startTime: '2026-12-04T15:00:00.000Z' }),
        ],
      }),
    );
    await openWithVisits();
    expect(screen.getByLabelText('Invoice due date')).toHaveValue('2026-12-01');
  });

  it('makes an invoice with no visits due on receipt, and says why', async () => {
    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_14_after_last_visit' }));
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [], scanned: 3 }));
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(await screen.findByRole('button', { name: /write a blank invoice instead/i }));
    fireEvent.change(screen.getByLabelText('Invoice date'), { target: { value: '2026-12-01' } });
    expect(screen.getByLabelText('Invoice due date')).toHaveValue('2026-12-01');
    expect(screen.getByText('There are no visits on this invoice, so it is due on receipt.')).toBeInTheDocument();
  });

  it('keeps terms the operator picked when the setting arrives later', async () => {
    termsSetting.mockReturnValue(setting({ status: 'loading' }));
    const view = render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findAllByRole('checkbox');
    // While it loads, Terms waits and Create says why.
    expect(screen.getByLabelText('Terms')).toBeDisabled();
    expect(screen.getAllByText('Loading your payment terms…').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();

    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_7_after_last_visit' }));
    view.rerender(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Terms')).toHaveValue('net_7_after_last_visit');
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'net_30');
    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_7_after_last_visit' }));
    view.rerender(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Terms')).toHaveValue('net_30');
  });

  it('still lets the operator pick the due date by hand', async () => {
    termsSetting.mockReturnValue(setting({ paymentTerms: 'net_14_after_last_visit' }));
    await openWithVisits();
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'custom');
    const due = screen.getByLabelText('Invoice due date');
    expect(due).toBeEnabled();
    fireEvent.change(due, { target: { value: '2026-12-24' } });
    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice.mock.calls[0]?.[0]).toMatchObject({ termsCode: 'custom', dueDate: '2026-12-24' });
  });

  it('says so when the setting cannot be read, starts on due on receipt, and offers a retry', async () => {
    const retry = vi.fn();
    termsSetting.mockReturnValue(setting({ status: 'error', retry }));
    await openWithVisits();
    expect(screen.getByLabelText('Terms')).toHaveValue('due_on_receipt');
    expect(screen.getByRole('alert')).toHaveTextContent('Your payment terms could not be loaded');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
