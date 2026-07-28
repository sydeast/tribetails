// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ListUninvoicedSessionsResult,
  ListUninvoicedSessionsResultSession,
} from '../contracts/invoiceContracts.generated';

const { listUninvoicedSessions } = vi.hoisted(() => ({ listUninvoicedSessions: vi.fn() }));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  listUninvoicedSessions,
}));

import { UninvoicedVisitsPicker, draftFromSession } from './UninvoicedVisitsPicker';

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
    rateCardLoaded: true,
    scanned: 12,
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  listUninvoicedSessions.mockReset().mockResolvedValue(result());
});

/**
 * The rule this component exists to enforce: `unitCents: null` means the rate
 * card could not price this visit, and NULL IS NOT ZERO. A silent 0 would bill
 * a household nothing for real work and look completely deliberate on the
 * finished invoice.
 */
describe('draftFromSession', () => {
  it('seeds the unit price from the rate card when there is one', () => {
    expect(draftFromSession(session({ unitCents: 2500 })).unitText).toBe('25.00');
  });

  it('leaves the unit price BLANK, never "0.00", when the visit could not be priced', () => {
    expect(draftFromSession(session({ unitCents: null })).unitText).toBe('');
  });

  it('bills ONE visit, not one unit per hour', () => {
    // The rate card is keyed by service name and priced per service, so
    // multiplying by duration would silently multiply the bill.
    expect(draftFromSession(session({ durationMinutes: 180 })).qtyText).toBe('1');
  });

  it('describes the line by service and date so the household can recognise it', () => {
    expect(draftFromSession(session()).description).toBe('Dog walk, 2026-07-10');
  });

  it('falls back to a generic label rather than an empty description', () => {
    expect(draftFromSession(session({ serviceType: '' })).description).toContain('Visit');
  });
});

describe('UninvoicedVisitsPicker', () => {
  it('will not search before a household is chosen', () => {
    render(<UninvoicedVisitsPicker kinfolkId="" onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /find visits/i })).toBeDisabled();
    expect(screen.getByText(/pick a household first/i)).toBeInTheDocument();
  });

  it('lists the household own visits and says how many rows were checked', async () => {
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText('Dog walk')).toBeInTheDocument();
    // An empty or short result is never mistaken for a complete one.
    expect(screen.getByText(/out of 12 checked in the window/i)).toBeInTheDocument();
  });

  it('excludes another household visits from the list', async () => {
    listUninvoicedSessions.mockResolvedValueOnce(
      result({ sessions: [session(), session({ sessionId: 's2', kinfolkId: 'OTHER', serviceType: 'Cat sit' })] }),
    );
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText('Dog walk')).toBeInTheDocument();
    expect(screen.queryByText('Cat sit')).toBeNull();
  });

  it('shows an unpriced visit as needing a price, NEVER as $0.00', async () => {
    listUninvoicedSessions.mockResolvedValueOnce(
      result({
        sessions: [session({ unitCents: null })],
        unpriceable: [{ sessionId: 's1', serviceType: 'Dog walk' }],
      }),
    );
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText(/not on the rate card/i)).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('separates "no rate card at all" from "this service is not on it"', async () => {
    // A settings problem to fix once, not a per-visit annoyance to work around.
    listUninvoicedSessions.mockResolvedValueOnce(
      result({ sessions: [session({ unitCents: null })], rateCardLoaded: false }),
    );
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText(/business settings has no service rates/i)).toBeInTheDocument();
    expect(screen.queryByText(/not on the rate card/i)).toBeNull();
  });

  it('warns before adding a visit that will need a price typed in', async () => {
    listUninvoicedSessions.mockResolvedValueOnce(result({ sessions: [session({ unitCents: null })] }));
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    await userEvent.click(await screen.findByRole('checkbox'));
    expect(screen.getByText(/has no rate on file/i)).toBeInTheDocument();
  });

  it('hands back the chosen lines and their session ids', async () => {
    const onAdd = vi.fn();
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={onAdd} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /add 1 visit/i }));
    expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({ unitText: '25.00' })], ['s1']);
  });

  it('says when the server hit its page cap, so a short list is not read as complete', async () => {
    listUninvoicedSessions.mockResolvedValueOnce(result({ truncated: true }));
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText(/hit the server's page limit/i)).toBeInTheDocument();
  });

  it('reports a failed load rather than showing an empty list', async () => {
    listUninvoicedSessions.mockRejectedValueOnce(new Error('permission denied'));
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
    // An empty list and a failed read are different facts and must not look alike.
    expect(screen.queryByText(/no un-invoiced completed visits/i)).toBeNull();
  });

  it('says plainly when the window really is empty', async () => {
    listUninvoicedSessions.mockResolvedValueOnce(result({ sessions: [], scanned: 40 }));
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    expect(await screen.findByText(/no un-invoiced completed visits/i)).toBeInTheDocument();
    expect(screen.getByText(/40 visits were checked/i)).toBeInTheDocument();
  });

  it('refuses a backwards window before spending a call on it', async () => {
    render(<UninvoicedVisitsPicker kinfolkId="kf1" onAdd={vi.fn()} onClose={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText('Window start date'));
    await userEvent.type(screen.getByLabelText('Window start date'), '2027-01-01');
    await userEvent.click(screen.getByRole('button', { name: /find visits/i }));
    await waitFor(() => expect(screen.getByText(/must not be after its end/i)).toBeInTheDocument());
    expect(listUninvoicedSessions).not.toHaveBeenCalled();
  });
});
