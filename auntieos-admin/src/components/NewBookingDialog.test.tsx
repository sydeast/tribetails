// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Kinfolk } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createMultiDateBookingRequest } = vi.hoisted(() => ({ createMultiDateBookingRequest: vi.fn() }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  createMultiDateBookingRequest,
}));

// The service chips read the operator's KinCare types from business_settings.
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

import { NewBookingDialog } from './NewBookingDialog';

const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

function kinfolk(over: Partial<Kinfolk> = {}): Kinfolk {
  return {
    _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', phoneNumber: '', email: '',
    profilePictureUrl: '', status: 'active', joinDate: '', ...over,
  };
}

beforeEach(() => {
  createMultiDateBookingRequest.mockReset();
  // Default: a never-configured install, so the fallback text input is in play.
  // Tests that care about chips set their own rates fixture.
  getBusinessSettings.mockReset().mockResolvedValue({ serviceRates: {} });
  useCollection.mockReset().mockReturnValue({
    status: 'ready',
    data: [kinfolk(), kinfolk({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' })],
  });
});

/** The operator's real KinCare types, deliberately in scrambled map order. */
const RATES = {
  '60Minute': '40',
  'Half-Day 6Hrs': '100',
  '90Minute': '55',
  '30Minute': '25',
  Consultation: '',
};

function serviceChipNames(): string[] {
  return Array.from(
    screen.getByRole('group', { name: 'Service' }).querySelectorAll('button'),
  ).map((b) => b.textContent ?? '');
}

describe('NewBookingDialog', () => {
  it('lists households from the live stream', () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Jamie Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Amy Adams' })).toBeInTheDocument();
  });

  it('creates a request from one or more specific (non-consecutive) dates', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 });
    const onCreated = vi.fn();
    render(<NewBookingDialog onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Service'), 'Dog Walk');
    fireEvent.change(screen.getByLabelText(/visit 1 date and time/i), { target: { value: '2027-08-03T09:00' } });
    await userEvent.click(screen.getByRole('button', { name: /add another date/i }));
    fireEvent.change(screen.getByLabelText(/visit 2 date and time/i), { target: { value: '2027-08-17T09:00' } });

    await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.kinfolkId).toBe('kf1');
    expect(arg.pattern).toBe('individual');
    expect(arg.visits).toHaveLength(2);
    expect(arg.visits.every((v: { serviceName: string }) => v.serviceName === 'Dog Walk')).toBe(true);
    // ascending, non-consecutive
    expect(arg.visits[0].startTimeMs).toBeLessThan(arg.visits[1].startTimeMs);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 }));
  });

  it('creates a weekly recurrence, sending pattern:weekly + weeklyDays', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_2', visitIds: ['v1'], visitCount: 4 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Service'), 'Walk');
    await userEvent.click(screen.getByRole('tab', { name: /weekly/i }));

    fireEvent.change(screen.getByLabelText('Start on'), { target: { value: '2027-08-02' } }); // Monday
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));

    // 4 weeks, Mondays only -> 4 visits; the submit label reflects the count.
    await userEvent.click(screen.getByRole('button', { name: /create 4 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.pattern).toBe('weekly');
    expect(arg.weeklyDays).toEqual([1]);
    expect(arg.visits.length).toBeGreaterThan(0);
  });

  it('blocks submit and shows errors when required fields are missing', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    // No household, no service, no date. The button is disabled, and touching reveals errors.
    await userEvent.click(screen.getByLabelText('Household')); // focus
    await userEvent.tab(); // blur -> touched
    expect(await screen.findByText(/pick a household/i)).toBeInTheDocument();
    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();
  });

  describe('service chips (business_settings.serviceRates)', () => {
    it('renders one chip per KinCare type, ordered by parsed duration, priced from the rate', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      await screen.findByRole('button', { name: '30Minute · $25' });
      // Ascending duration; the rate-less "Consultation" has no parseable
      // duration, so it sorts last and shows no price.
      expect(serviceChipNames()).toEqual([
        '30Minute · $25',
        '60Minute · $40',
        '90Minute · $55',
        'Half-Day 6Hrs · $100',
        'Consultation',
      ]);
      // The free-text fallback is gone once real services exist.
      expect(screen.queryByPlaceholderText('e.g. Dog Walk')).not.toBeInTheDocument();
    });

    it('selecting a chip sends the canonical service name on every visit', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES });
      createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_3', visitIds: ['v1', 'v2'], visitCount: 2 });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
      const chip = await screen.findByRole('button', { name: 'Half-Day 6Hrs · $100' });
      await userEvent.click(chip);
      expect(chip).toHaveAttribute('aria-pressed', 'true');

      fireEvent.change(screen.getByLabelText(/visit 1 date and time/i), { target: { value: '2027-08-03T09:00' } });
      await userEvent.click(screen.getByRole('button', { name: /add another date/i }));
      fireEvent.change(screen.getByLabelText(/visit 2 date and time/i), { target: { value: '2027-08-17T09:00' } });
      await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

      await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
      const arg = createMultiDateBookingRequest.mock.calls[0]![0];
      // The MAP KEY goes on the wire, not the "· $100" chip label.
      expect(arg.visits.map((v: { serviceName: string }) => v.serviceName)).toEqual([
        'Half-Day 6Hrs',
        'Half-Day 6Hrs',
      ]);
      // The callable contract is untouched: same keys, same shapes as before.
      expect(Object.keys(arg).sort()).toEqual(['kinfolkId', 'pattern', 'visits']);
      expect(Object.keys(arg.visits[0]).sort()).toEqual(['serviceName', 'startTimeMs']);
      expect(typeof arg.visits[0].startTimeMs).toBe('number');
    });

    it('picking a second chip replaces the first (single select)', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      const first = await screen.findByRole('button', { name: '30Minute · $25' });
      await userEvent.click(first);
      const second = screen.getByRole('button', { name: '90Minute · $55' });
      await userEvent.click(second);

      expect(first).toHaveAttribute('aria-pressed', 'false');
      expect(second).toHaveAttribute('aria-pressed', 'true');
    });

    it('falls back to a text input plus a Settings hint when no KinCare types exist', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: {} });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      expect(await screen.findByText(/no kincare types yet/i)).toBeInTheDocument();
      expect(screen.getByText(/settings/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Service')).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Service' })).not.toBeInTheDocument();
    });

    it('fails loud and keeps the text input when the settings read blows up', async () => {
      getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      expect(await screen.findByText(/couldn.t load your kincare types.*permission-denied/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Service')).toBeInTheDocument();
    });
  });

  it('fails loud (names the callable) when the create rejects', async () => {
    createMultiDateBookingRequest.mockRejectedValue(new Error('not-found: Kinfolk not found'));
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Service'), 'Walk');
    fireEvent.change(screen.getByLabelText(/visit 1 date and time/i), { target: { value: '2027-08-03T09:00' } });
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    expect(await screen.findByText(/createMultiDateBookingRequest failed:.*not found/i)).toBeInTheDocument();
  });
});
