// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
    search?: Record<string, string>;
  }) => (
    <a href={hrefOf(to, params, search)} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * The href a router `Link` would produce, path params substituted first (a
 * visit's own route is `/sessions/$sessionId` since #753), then any search.
 */
function hrefOf(
  to: string,
  params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const path = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
  const q = new URLSearchParams(search ?? {}).toString();
  return q === '' ? path : `${path}?${q}`;
}


const { listUninvoicedSessions, setSessionDoNotInvoice } = vi.hoisted(() => ({
  listUninvoicedSessions: vi.fn(),
  setSessionDoNotInvoice: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  listUninvoicedSessions,
  setSessionDoNotInvoice,
}));

// #1744: services are named from the KinCare catalog. "Long walk" runs 45
// minutes, so a stored `visit_45` reads as "Long walk".
const CATALOG = vi.hoisted(() => ({
  serviceRates: { 'Long walk': '45' },
  serviceDurations: { 'Long walk': '45' },
  timeBlocks: [],
}));
vi.mock('../lib/useBookingCatalog', () => ({ useBookingCatalog: () => CATALOG }));

import {
  UninvoicedVisitsPicker,
  carriedSelection,
  leftUntickedAfter,
  visitLineDescription,
} from './UninvoicedVisitsPicker';

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

  it('#1744: names the KinCare off the catalog, never the stored key the household would read', () => {
    expect(visitLineDescription(session({ serviceType: 'visit_45' }), CATALOG)).toBe('Long walk, 2026-07-10');
  });
});

describe('UninvoicedVisitsPicker service names (#1744)', () => {
  it('names each billable and excluded visit by its KinCare, labels included', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({
        sessions: [session({ serviceType: 'visit_45', unitCents: null })],
        excluded: [
          {
            sessionId: 'gone1',
            kinfolkId: 'kf1',
            serviceType: 'visit_45',
            startTime: '2026-07-02T14:00:00.000Z',
            reason: '',
          },
        ],
      }),
    );
    render(<Harness />);
    expect(await screen.findByRole('checkbox', { name: 'Bill Long walk on 2026-07-10' })).toBeInTheDocument();
    expect(screen.getAllByText('Long walk')).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Price for Long walk on 2026-07-10' })).toBeInTheDocument();
    expect(screen.queryByText(/visit_45/)).toBeNull();
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
      await screen.findByText(/Could not load:.*permission-denied/i),
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
      '/sessions/s1',
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

  it('#1750: says which KinCare a resolved key was priced as, beside the price', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({ sessions: [session({ serviceType: 'visit_45', unitCents: 4500, pricedAs: 'Long walk' })] }),
    );
    render(<Harness />);
    const row = (await screen.findByRole('checkbox', { name: 'Bill Long walk on 2026-07-10' })).closest('li')!;
    expect(within(row).getByText('priced as Long walk')).toBeInTheDocument();
    expect(within(row).getByText('$45.00')).toBeInTheDocument();
  });

  it('#1750: says nothing about resolving when the stored key was on the card as written', async () => {
    render(<Harness />);
    expect(await screen.findByText('$25.00')).toBeInTheDocument();
    expect(screen.queryByText(/priced as/i)).toBeNull();
  });

  it('#1750: says nothing about resolving on an unpriced row, even if a field arrives', async () => {
    listUninvoicedSessions.mockResolvedValue(
      result({
        sessions: [session({ unitCents: null, pricedAs: 'Long walk' })],
        unpriceable: [{ sessionId: 's1', serviceType: 'Dog walk' }],
      }),
    );
    render(<Harness />);
    expect(await screen.findByText(/not on the rate card/i)).toBeInTheDocument();
    expect(screen.queryByText(/priced as/i)).toBeNull();
  });
});

describe('UninvoicedVisitsPicker do not invoice', () => {
  it('marks the selection, with a reason, and says what happened', async () => {
    render(<Harness />);
    await screen.findByRole('checkbox');

    await userEvent.click(screen.getByRole('button', { name: /do not invoice this visit/i }));
    await userEvent.type(screen.getByLabelText(/why this work is not being invoiced/i), 'Comped');
    // The same verb on the confirm step, never a new one.
    await userEvent.click(screen.getByRole('button', { name: /do not invoice this visit/i }));

    await waitFor(() => expect(setSessionDoNotInvoice).toHaveBeenCalledWith(['s1'], true, 'Comped'));
    expect(await screen.findByText(/1 visit is marked do not invoice/i)).toBeInTheDocument();
    // The list is re-read, so the row leaves rather than lingering as a lie.
    expect(listUninvoicedSessions).toHaveBeenCalledTimes(2);
  });

  it('cannot exclude nothing: the button is disabled and the reason sits beside it', async () => {
    render(<Harness />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /^do not invoice$/i })).toBeDisabled();
    expect(screen.getByText(/tick the visits nobody will ever be billed for/i)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: /do not invoice this visit/i }));
    await userEvent.click(screen.getAllByRole('button', { name: /do not invoice this visit/i })[0]!);
    expect(
      await screen.findByText(/Could not save:.*already billed on invoice INV-9/i),
    ).toBeInTheDocument();
  });
});

describe('carriedSelection and leftUntickedAfter (pure, #2089)', () => {
  it('ticks everything when nothing has been left unticked', () => {
    expect([...carriedSelection(['a', 'b'], new Set())]).toEqual(['a', 'b']);
  });

  it('keeps a visit the admin left unticked unticked, and drops one that left the list', () => {
    const left = leftUntickedAfter(new Set(), ['a', 'b', 'c'], new Set(['a', 'c']));
    expect([...left]).toEqual(['b']);
    // `c` was excluded and is gone; `b` stays off; `a` stays on.
    expect([...carriedSelection(['a', 'b'], left)]).toEqual(['a']);
  });

  it('remembers a visit the current list does not show, so wider dates do not re-tick it', () => {
    const left = leftUntickedAfter(new Set(['b']), ['a'], new Set());
    expect([...left].sort()).toEqual(['a', 'b']);
  });
});

describe("UninvoicedVisitsPicker re-reads keep the admin's ticks (#2089)", () => {
  const THREE = [
    session({ sessionId: 'v1', startTime: '2026-07-10T14:00:00.000Z' }),
    session({ sessionId: 'v2', startTime: '2026-07-11T14:00:00.000Z' }),
    session({ sessionId: 'v3', startTime: '2026-07-12T14:00:00.000Z' }),
  ];
  const box = (day: string) => screen.getByRole('checkbox', { name: new RegExp(day) });

  it('ticks every visit on first open', async () => {
    listUninvoicedSessions.mockResolvedValue(result({ sessions: THREE }));
    render(<Harness />);
    await screen.findAllByRole('checkbox');
    expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText(/3 of 3 un-invoiced visits selected/i)).toBeInTheDocument();
  });

  it('after Select none and Do not invoice on one visit, the others stay unticked and that visit leaves', async () => {
    listUninvoicedSessions
      .mockResolvedValueOnce(result({ sessions: THREE }))
      .mockResolvedValueOnce(result({ sessions: THREE.filter((s) => s.sessionId !== 'v2') }));
    setSessionDoNotInvoice.mockResolvedValue({ ok: true, doNotInvoice: true, changed: ['v2'], unchanged: [] });
    render(<Harness />);
    await screen.findAllByRole('checkbox');

    await userEvent.click(screen.getByRole('button', { name: /select none/i }));
    await userEvent.click(box('2026-07-11'));
    await userEvent.click(screen.getByRole('button', { name: /do not invoice this visit/i }));
    // One visit, so the way out is singular too.
    expect(screen.getByRole('button', { name: /^keep it billable$/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /do not invoice this visit/i }));

    await waitFor(() => expect(setSessionDoNotInvoice).toHaveBeenCalledWith(['v2'], true, ''));
    expect(await screen.findByText(/0 of 2 un-invoiced visits selected/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /2026-07-11/ })).toBeNull();
    expect(box('2026-07-10')).not.toBeChecked();
    expect(box('2026-07-12')).not.toBeChecked();
    // The trap the walk found: one more press would have excluded everything.
    expect(screen.getByRole('button', { name: /^do not invoice$/i })).toBeDisabled();
  });

  it('a visit put back arrives ticked, like any other unbilled work, and the rest keep their state', async () => {
    const gone = {
      sessionId: 'v9',
      kinfolkId: 'kf1',
      serviceType: 'Dog walk',
      startTime: '2026-07-02T14:00:00.000Z',
      reason: '',
    };
    listUninvoicedSessions
      .mockResolvedValueOnce(result({ sessions: THREE, excluded: [gone] }))
      .mockResolvedValueOnce(
        result({ sessions: [...THREE, session({ sessionId: 'v9', startTime: '2026-07-02T14:00:00.000Z' })] }),
      );
    setSessionDoNotInvoice.mockResolvedValue({ ok: true, doNotInvoice: false, changed: ['v9'], unchanged: [] });
    render(<Harness />);
    await screen.findAllByRole('checkbox');

    await userEvent.click(box('2026-07-10'));
    await userEvent.click(screen.getByRole('button', { name: /put it back/i }));

    expect(await screen.findByText(/3 of 4 un-invoiced visits selected/i)).toBeInTheDocument();
    expect(box('2026-07-02')).toBeChecked();
    expect(box('2026-07-10')).not.toBeChecked();
  });

  it('narrowing the dates and widening them again does not re-tick a visit the admin unticked', async () => {
    listUninvoicedSessions
      .mockResolvedValueOnce(result({ sessions: THREE, truncated: true }))
      .mockResolvedValueOnce(result({ sessions: [THREE[2]!] }))
      .mockResolvedValueOnce(result({ sessions: THREE, truncated: true }));
    render(<Harness />);
    await screen.findAllByRole('checkbox');

    await userEvent.click(box('2026-07-10'));
    await userEvent.click(screen.getByRole('button', { name: /narrow the dates/i }));
    expect(await screen.findByText(/1 of 1 un-invoiced visit selected/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show everything again/i }));

    expect(await screen.findByText(/2 of 3 un-invoiced visits selected/i)).toBeInTheDocument();
    expect(box('2026-07-10')).not.toBeChecked();
    expect(box('2026-07-11')).toBeChecked();
  });

  it('a different household starts fresh, with every visit ticked again', async () => {
    listUninvoicedSessions.mockResolvedValue(result({ sessions: THREE }));
    const { rerender } = render(<Harness kinfolkId="kf1" />);
    await screen.findAllByRole('checkbox');
    await userEvent.click(screen.getByRole('button', { name: /select none/i }));
    expect(screen.getByText(/0 of 3/i)).toBeInTheDocument();

    rerender(<Harness kinfolkId="kf2" />);
    expect(await screen.findByText(/3 of 3 un-invoiced visits selected/i)).toBeInTheDocument();
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
