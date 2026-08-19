// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import type {
  ListUninvoicedSessionsResult,
  ListUninvoicedSessionsResultSession,
} from '../contracts/invoiceContracts.generated';

/**
 * The router's `Link`, rendered as the anchor it becomes. Same stub the rest of
 * this suite uses (`Invites.test.tsx`, `HouseholdMembers.test.tsx`): these
 * components are unit-rendered without a router, and the assertion worth making
 * is WHERE the link points.
 */
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...rest}>
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

import { InvoiceCreate, buildBoundLines, isValidInvoiceDate, validateBlankInvoice } from './InvoiceCreate';

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

function session(over: Partial<ListUninvoicedSessionsResultSession> = {}): ListUninvoicedSessionsResultSession {
  return {
    sessionId: 's1',
    kinfolkId: 'kf1',
    serviceType: 'Dog walk',
    durationMinutes: 60,
    startTime: '2026-07-10T14:00:00.000Z',
    unitCents: 2500,
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

/** Today, as the composer computes it, so date assertions do not rot overnight. */
function todayIso(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [kinfolk({})] } satisfies Async<Kinfolk[]>);
  createInvoice.mockReset().mockResolvedValue({ invoiceId: 'inv-1' });
  createQuote.mockReset().mockResolvedValue({ invoiceId: 'inv-2' });
  listUninvoicedSessions.mockReset().mockResolvedValue(work());
  setSessionDoNotInvoice.mockReset();
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

describe('validateBlankInvoice (pure)', () => {
  const valid = { kinfolkId: 'kf1', totalText: '10', date: '', dueDate: '' };

  it('passes a fully valid blank invoice', () => {
    expect(validateBlankInvoice(valid)).toBeNull();
  });

  it('requires a household', () => {
    expect(validateBlankInvoice({ ...valid, kinfolkId: '' })).toMatch(/household/i);
  });

  it('rejects a negative or blank total', () => {
    expect(validateBlankInvoice({ ...valid, totalText: '-1' })).toMatch(/total/i);
    expect(validateBlankInvoice({ ...valid, totalText: '' })).toMatch(/total/i);
  });

  it('rejects an unparseable date or due date', () => {
    expect(validateBlankInvoice({ ...valid, date: 'nope' })).toMatch(/date/i);
    expect(validateBlankInvoice({ ...valid, dueDate: 'nope' })).toMatch(/due date/i);
  });

  // #408 took both of those questions off the form, so neither is a rule this
  // validator can still enforce: the number is assigned by the server, and the
  // amount due on an unpaid invoice IS its total.
  it('no longer takes an invoice number or an amount due', () => {
    expect(Object.keys(valid)).toEqual(['kinfolkId', 'totalText', 'date', 'dueDate']);
  });
});

describe('buildBoundLines (pure)', () => {
  it('binds each line to the visit it bills for', () => {
    const out = buildBoundLines([session()], new Set(['s1']), {});
    expect(out.error).toBeNull();
    expect(out.lines).toEqual([
      { description: 'Dog walk, 2026-07-10', qty: 1, unitCents: 2500, sessionId: 's1' },
    ]);
  });

  it('bills ONE visit, not one unit per hour', () => {
    // The rate card is keyed by service name and priced per service, so
    // multiplying by duration would silently multiply the bill.
    const out = buildBoundLines([session({ durationMinutes: 180 })], new Set(['s1']), {});
    expect(out.lines[0]?.qty).toBe(1);
  });

  it('ignores a visit that is not ticked', () => {
    expect(buildBoundLines([session()], new Set(), {}).lines).toEqual([]);
  });

  it('REFUSES an unpriced visit rather than billing zero for it', () => {
    const out = buildBoundLines([session({ unitCents: null })], new Set(['s1']), {});
    expect(out.lines).toEqual([]);
    expect(out.error).toMatch(/has no rate on file/i);
  });

  it('takes the typed price for a visit the rate card could not price', () => {
    const out = buildBoundLines([session({ unitCents: null })], new Set(['s1']), { s1: '32.50' });
    expect(out.lines[0]?.unitCents).toBe(3250);
  });

  it('refuses a typed price it cannot read, rather than rounding it into something', () => {
    const out = buildBoundLines([session({ unitCents: null })], new Set(['s1']), { s1: 'about thirty' });
    expect(out.error).toMatch(/needs a dollar amount/i);
  });
});

describe('InvoiceCreate shape', () => {
  it('asks for the household first and shows nothing else until it has one', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'New invoice' })).toBeInTheDocument();
    expect(screen.getByLabelText('Household')).toBeInTheDocument();
    expect(screen.getByText(/pick a household and its un-invoiced work appears here/i)).toBeInTheDocument();
    expect(listUninvoicedSessions).not.toHaveBeenCalled();
  });

  // The whole of #408's field audit, asserted as absences.
  it('no longer asks for the fields that already had answers elsewhere', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/invoice number/i)).toBeNull();
    expect(screen.queryByLabelText(/^client/i)).toBeNull();
    expect(screen.queryByLabelText(/^address/i)).toBeNull();
    expect(screen.queryByLabelText(/amount due/i)).toBeNull();
    expect(screen.queryByLabelText(/^status$/i)).toBeNull();
    // The free-text terms box, and the duplicate free-text discount beside it,
    // are gone with them: terms are a choice now.
    expect(screen.getByLabelText('Terms').tagName).toBe('SELECT');
  });

  it('opens on today, so a new invoice is not born undated', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Invoice date')).toHaveValue(todayIso());
  });

  it('surfaces a household-load failure, fail loud, not a silently empty picker', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByText(/couldn.t load households/i)).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('shows the create button DISABLED with the reason stated, never hidden', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
    expect(screen.getByText(/pick a household first/i)).toBeInTheDocument();
  });

  it('says the invoice lands as a draft, because sending is a separate action', () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    expect(screen.getByText(/this lands as a draft/i)).toBeInTheDocument();
  });
});

describe('InvoiceCreate work path', () => {
  async function pickHousehold() {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
  }

  it('loads that household\'s work as soon as it is chosen, with no range to guess at', async () => {
    await pickHousehold();
    expect(listUninvoicedSessions).toHaveBeenCalledWith('kf1', undefined);
  });

  it('creates an invoice from the ticked work, bound to the visits it bills for', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<InvoiceCreate mode="invoice" onClose={onClose} onCreated={onCreated} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');

    await userEvent.click(screen.getByRole('button', { name: /create invoice for 1 visit/i }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    const sent = createInvoice.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      familyId: 'kf1',
      kinfolkName: 'Pat Whitfield',
      // Inherited from the household one field above, not asked for.
      client: 'Pat Whitfield',
      total: 25,
      amountDue: 25,
      status: 'draft',
      sessionIds: ['s1'],
      termsCode: 'due_on_receipt',
    });
    expect(sent.lineItems).toEqual([
      { description: 'Dog walk, 2026-07-10', qty: 1, unitCents: 2500, sessionId: 's1' },
    ]);
    // Nothing is sent for the fields the form stopped asking about.
    expect(sent).not.toHaveProperty('invoiceNumber');
    expect(sent).not.toHaveProperty('address');
    expect(onCreated).toHaveBeenCalledWith('inv-1');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('states the derived total and offers nowhere to type one', async () => {
    await pickHousehold();
    expect(screen.getByText(/will be created for \$25\.00/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^total$/i)).toBeNull();
  });

  it('promises no figure at all when nothing is ticked, rather than "$0.00"', async () => {
    await pickHousehold();
    await userEvent.click(screen.getByRole('checkbox'));
    // The composer's own line promises no figure: an empty set and a zero
    // total are different facts. (The extra-charges editor below keeps its own
    // running preview, which is about the lines typed into it.)
    expect(screen.queryByText(/will be created for/i)).toBeNull();
    expect(screen.getByText(/tick a visit above, or add a line of your own/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeDisabled();
  });

  it('refuses an unpriced visit until its price is typed, naming the visit', async () => {
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [session({ unitCents: null })] }));
    await pickHousehold();
    expect(screen.getByText(/Dog walk, 2026-07-10 has no rate on file/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create invoice for 1 visit/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/price for dog walk/i), '30');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create invoice for 1 visit/i })).toBeEnabled(),
    );
    expect(screen.getByText(/will be created for \$30\.00/i)).toBeInTheDocument();
  });

  it('carries an extra typed charge alongside the bound lines', async () => {
    await pickHousehold();
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await userEvent.type(screen.getByLabelText('Line 1 description'), 'Mileage');
    await userEvent.type(screen.getByLabelText('Line 1 unit price in dollars'), '10.00');
    await userEvent.click(screen.getByRole('button', { name: /create invoice for 1 visit/i }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    const sent = createInvoice.mock.calls[0]?.[0];
    expect(sent.total).toBe(35);
    expect(sent.lineItems).toHaveLength(2);
    // The typed line has no visit behind it, and does not pretend to.
    expect(sent.lineItems[1]).not.toHaveProperty('sessionId');
    expect(sent.sessionIds).toEqual(['s1']);
  });

  it('fails loud when createInvoice rejects: banner shown, dialog stays open, not swallowed', async () => {
    createInvoice.mockRejectedValue(new Error('permission-denied'));
    const onClose = vi.fn();
    render(<InvoiceCreate mode="invoice" onClose={onClose} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('button', { name: /create invoice for 1 visit/i }));

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

describe('InvoiceCreate blank path', () => {
  it('is offered when the household has nothing to bill, and takes a typed total', async () => {
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [], scanned: 3 }));
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(await screen.findByRole('button', { name: /write a blank invoice instead/i }));

    await userEvent.type(screen.getByLabelText('Total'), '80');
    await userEvent.click(screen.getByRole('button', { name: /^create invoice$/i }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    const sent = createInvoice.mock.calls[0]?.[0];
    // The amount due on an invoice nobody has paid IS the total. It is no
    // longer asked for, so the two can no longer disagree.
    expect(sent).toMatchObject({ total: 80, amountDue: 80, sessionIds: [] });
    // No `lineItems` key AT ALL, not an empty array: the server reads the key's
    // presence as "this invoice is itemized".
    expect(sent).not.toHaveProperty('lineItems');
  });

  it('says out loud that a blank invoice is not linked to any logged work', async () => {
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [] }));
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(await screen.findByRole('button', { name: /write a blank invoice instead/i }));
    expect(screen.getByText(/nothing on it is linked to logged work/i)).toBeInTheDocument();
  });

  it('goes back to the work path, which is the front door', async () => {
    listUninvoicedSessions.mockResolvedValue(work({ sessions: [] }));
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(await screen.findByRole('button', { name: /write a blank invoice instead/i }));
    await userEvent.click(screen.getByRole('button', { name: /bill this household's logged work instead/i }));
    expect(await screen.findByText(/no un-invoiced completed visits/i)).toBeInTheDocument();
  });
});

describe('InvoiceCreate terms and due date', () => {
  async function pick() {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
  }

  it('works the due date out from the terms, and leaves nowhere to type it', async () => {
    await pick();
    const due = screen.getByLabelText('Invoice due date');
    expect(due).toBeDisabled();
    // Due on receipt: the invoice's own date.
    expect(due).toHaveValue(todayIso());

    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'net_14');
    await waitFor(() => expect(screen.getByLabelText('Invoice due date')).not.toHaveValue(todayIso()));
  });

  it('hands the date back only for the terms that say so, and says as much', async () => {
    await pick();
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'custom');
    expect(screen.getByLabelText('Invoice due date')).toBeEnabled();
    expect(screen.getByText(/these terms leave the due date to you/i)).toBeInTheDocument();
  });

  it('sends the resolved date and the code, so the server can check its own working', async () => {
    await pick();
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'net_14_after_last_visit');
    await userEvent.click(screen.getByRole('button', { name: /create invoice for 1 visit/i }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    const sent = createInvoice.mock.calls[0]?.[0];
    expect(sent.termsCode).toBe('net_14_after_last_visit');
    // 14 days after the only visit, 2026-07-10.
    expect(sent.dueDate).toBe('2026-07-24');
  });

  it('SAYS a service-relative due date has already passed rather than moving it', async () => {
    await pick();
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'due_on_last_visit');
    expect(await screen.findByText(/that date has already passed/i)).toBeInTheDocument();
    // And it still creates: an overdue invoice for old work is the truth, not
    // an error to block on.
    expect(screen.getByRole('button', { name: /create invoice for 1 visit/i })).toBeEnabled();
  });

  it('blocks with the reason stated when the terms cannot work a date out at all', async () => {
    await pick();
    await userEvent.selectOptions(screen.getByLabelText('Terms'), 'net_7_after_last_visit');
    // Untick the only visit: there is now nothing to count from.
    await userEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText(/no visits on this invoice yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeDisabled();
  });
});

describe('InvoiceCreate quotes', () => {
  it('is a kind of the same document, chosen here rather than at a second button', async () => {
    render(<InvoiceCreate mode="invoice" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('What is this'), 'quote');
    expect(screen.getByRole('heading', { name: 'New quote' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /send to kinfolk now/i })).toBeInTheDocument();
  });

  it('routes to createQuote, carrying the send-to-kinfolk toggle', async () => {
    render(<InvoiceCreate mode="quote" onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('switch', { name: /send to kinfolk now/i }));
    await userEvent.click(screen.getByRole('button', { name: /create quote for 1 visit/i }));

    await waitFor(() => expect(createQuote).toHaveBeenCalledTimes(1));
    expect(createQuote.mock.calls[0]?.[0]).toMatchObject({ sendToKinfolk: true, status: '' });
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('opens on the quote kind when the notifications feed seeded it', () => {
    render(<InvoiceCreate mode="quote" onClose={vi.fn()} seedKinfolkId="kf1" />);
    expect(screen.getByLabelText('What is this')).toHaveValue('quote');
    expect(screen.getByLabelText('Household')).toHaveValue('kf1');
  });
});
