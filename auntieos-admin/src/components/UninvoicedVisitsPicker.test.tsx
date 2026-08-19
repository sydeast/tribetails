// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const { listUninvoicedSessions, setSessionDoNotInvoice } = vi.hoisted(() => ({
  listUninvoicedSessions: vi.fn(),
  setSessionDoNotInvoice: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  listUninvoicedSessions,
  setSessionDoNotInvoice,
}));

import { UninvoicedVisitsPicker, visitLineDescription } from './UninvoicedVisitsPicker';

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

function result(over: Partial<ListUninvoicedSessionsResult> = {}): ListUninvoicedSessionsResult {
  return {
    sessions: [session()],
    unpriceable: [],
    unplaceable: [],
    excluded: [],
    rateCardLoaded: true,
    scanned: 12,
    truncated: false,
    ...over,
  };
}

/**
 * The panel with the selection state the composer owns held here instead, so
 * every assertion below is about what the panel does with it rather than about
 * a stub that never changes.
 */
function Harness({ kinfolkId = 'kf1' }: { kinfolkId?: string }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [prices, setPrices] = useState<Record<string, string>>({});
  return (
    <UninvoicedVisitsPicker
      kinfolkId={kinfolkId}
      householdLabel="the Whitfields"
      selected={selected}
      onSelectedChange={setSelected}
      prices={prices}
      onPriceChange={(id, text) => setPrices((p) => ({ ...p, [id]: text }))}
      onSessionsLoaded={vi.fn()}
      onWriteBlankInvoice={vi.fn()}
    />
  );
}

beforeEach(() => {
  listUninvoicedSessions.mockReset().mockResolvedValue(result());
  setSessionDoNotInvoice.mockReset().mockResolvedValue({
    ok: true,
    doNotInvoice: true,
    changed: ['s1'],
    unchanged: [],
  });
});

describe('visitLineDescription', () => {
  it('names the service and the day, so the household can recognise the line', () => {
    expect(visitLineDescription(session())).toBe('Dog walk, 2026-07-10');
  });

  it('falls back to a generic label rather than an empty description', () => {
    expect(visitLineDescription(session({ serviceType: '' }))).toContain('Visit');
  });
});

describe('UninvoicedVisitsPicker loading', () => {
  it('asks for the household with NO date range, so old work is not hidden behind a window', async () => {
    render(<Harness />);
    await waitFor(() => expect(listUninvoicedSessions).toHaveBeenCalled());
    expect(listUninvoicedSessions.mock.calls[0]).toEqual(['kf1', undefined]);
  });

  it('shows nothing at all before a household is chosen', () => {
    render(<Harness kinfolkId="" />);
    expect(listUninvoicedSessions).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('selects every billable visit as soon as they load', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({ sessions: [session(), session({ sessionId: 's2', startTime: '2026-07-11T14:00:00.000Z' })] }),
    );
    render(<Harness />);
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 of 2 un-invoiced visits selected for the Whitfields',
    );
  });

  it('names the household and the count it checked when there is nothing to bill', async () => {
    listUninvoicedSessions.mockResolvedValue(result({ sessions: [], scanned: 7 }));
    render(<Harness />);
    expect(
      await screen.findByText(
        /No un-invoiced completed visits for the Whitfields\. 7 visits were checked\./i,
      ),
    ).toBeInTheDocument();
    // And the way out of an empty list is offered, not left to be guessed at.
    expect(screen.getByRole('button', { name: /write a blank invoice instead/i })).toBeInTheDocument();
  });

  it('fails loud when the read rejects, and offers the retry', async () => {
    listUninvoicedSessions.mockRejectedValue(new Error('permission-denied'));
    render(<Harness />);
    expect(
      await screen.findByText(/listUninvoicedSessions failed:.*permission-denied/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

/**
 * The rule this component has always existed to enforce: `unitCents: null`
 * means the rate card could not price this visit, and NULL IS NOT ZERO.
 */
describe('UninvoicedVisitsPicker pricing', () => {
  it('shows a priced visit as money, with no field to type over it', async () => {
    render(<Harness />);
    expect(await screen.findByText('$25.00')).toBeInTheDocument();
    // The #408 ruling: a bound line's money is the visit's. The row routes to
    // the visit instead of offering a price box.
    expect(screen.queryByLabelText(/price for dog walk/i)).toBeNull();
    expect(screen.getByRole('link', { name: /open this visit/i })).toHaveAttribute(
      'href',
      '/sessions?sessionId=s1',
    );
  });

  it('says an unpriced visit needs a price, and NEVER shows it as $0.00', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({
        sessions: [session({ unitCents: null })],
        unpriceable: [{ sessionId: 's1', serviceType: 'Dog walk' }],
      }),
    );
    render(<Harness />);
    expect(await screen.findByText(/not on the rate card/i)).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).toBeNull();
    // And the one place a price IS typed: where there is none to disagree with.
    expect(screen.getByLabelText(/price for dog walk/i)).toHaveValue('');
  });

  it('separates a missing rate card from a service missing off it', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({ sessions: [session({ unitCents: null })], rateCardLoaded: false }),
    );
    render(<Harness />);
    expect(await screen.findByText(/business settings has no service rates/i)).toBeInTheDocument();
    expect(screen.getByText(/needs a price/i)).toBeInTheDocument();
  });
});

describe('UninvoicedVisitsPicker do not invoice', () => {
  it('marks the selection, with a reason, and says what happened', async () => {
    render(<Harness />);
    await screen.findByRole('checkbox');

    await userEvent.click(screen.getByRole('button', { name: /do not invoice 1 selected/i }));
    await userEvent.type(screen.getByLabelText(/why this work is not being invoiced/i), 'Comped');
    await userEvent.click(screen.getByRole('button', { name: /mark 1 do not invoice/i }));

    await waitFor(() => expect(setSessionDoNotInvoice).toHaveBeenCalledWith(['s1'], true, 'Comped'));
    expect(await screen.findByText(/1 visit is marked do not invoice/i)).toBeInTheDocument();
    // The list is re-read, so the row leaves rather than lingering as a lie.
    expect(listUninvoicedSessions).toHaveBeenCalledTimes(2);
  });

  it('cannot exclude nothing: the button is disabled and says what it wants', async () => {
    render(<Harness />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /select visits to mark do not invoice/i })).toBeDisabled();
  });

  it('lists excluded work and puts it back on request', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({
        excluded: [
          {
            sessionId: 'gone1',
            kinfolkId: 'kf1',
            serviceType: 'Dog walk',
            startTime: '2026-07-02T14:00:00.000Z',
            reason: 'Comped after the late arrival',
          },
        ],
      }),
    );
    render(<Harness />);
    expect(
      await screen.findByText(/1 completed visit is marked do not invoice, so it is not on the list above/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Comped after the late arrival/)).toBeInTheDocument();

    setSessionDoNotInvoice.mockResolvedValue({
      ok: true,
      doNotInvoice: false,
      changed: ['gone1'],
      unchanged: [],
    });
    await userEvent.click(screen.getByRole('button', { name: /put it back/i }));
    await waitFor(() => expect(setSessionDoNotInvoice).toHaveBeenCalledWith(['gone1'], false, ''));
  });

  it('fails loud when the exclusion rejects, naming the callable', async () => {
    setSessionDoNotInvoice.mockRejectedValue(new Error('that visit is already billed on invoice INV-9'));
    render(<Harness />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('button', { name: /do not invoice 1 selected/i }));
    await userEvent.click(screen.getByRole('button', { name: /mark 1 do not invoice/i }));
    expect(
      await screen.findByText(/setSessionDoNotInvoice failed:.*already billed on invoice INV-9/i),
    ).toBeInTheDocument();
  });
});

describe('UninvoicedVisitsPicker narrowing', () => {
  it('offers the date range only when the page cap was actually reached', async () => {
    render(<Harness />);
    await screen.findByRole('checkbox');
    expect(screen.queryByLabelText(/window start date/i)).toBeNull();
  });

  it('narrows on request when there are more visits than fit', async () => {
    listUninvoicedSessions.mockResolvedValue(result({ truncated: true }));
    render(<Harness />);
    expect(await screen.findByText(/more un-invoiced visits than one page holds/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /narrow the dates/i }));
    await waitFor(() => expect(listUninvoicedSessions).toHaveBeenCalledTimes(2));
    const second = listUninvoicedSessions.mock.calls[1];
    expect(second?.[0]).toBe('kf1');
    expect(second?.[1]).toMatchObject({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});

describe('UninvoicedVisitsPicker unreachable work', () => {
  it('names visits no window can reach rather than dropping them', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({ unplaceable: [{ sessionId: 'lost1', kinfolkId: 'kf1' }] }),
    );
    render(<Harness />);
    expect(await screen.findByText(/has no start time/i)).toBeInTheDocument();
    expect(screen.getByText(/lost1/)).toBeInTheDocument();
  });
});
