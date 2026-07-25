// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Kinfolk } from '../api/directory';
import type { CollectionSpec } from '../lib/firestore';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createMultiDateBookingRequest } = vi.hoisted(() => ({ createMultiDateBookingRequest: vi.fn() }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  createMultiDateBookingRequest,
}));

// The service chips and the business hours both come from business_settings.
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

import { NewBookingDialog } from './NewBookingDialog';

// The date math is LOCAL (see lib/bookingAvailability.ts's header). Pin the zone
// so the weekday every assertion below depends on is stable.
const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

/**
 * The calendar opens on the CURRENT month, so a hardcoded day would eventually
 * fall into the past and start failing on its own. Pin the clock instead:
 * 2027-08-15 is a Sunday, mid-month, so both grid edges are reachable.
 */
beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2027, 7, 15, 12, 0, 0));
});
afterAll(() => {
  vi.useRealTimers();
});

function kinfolk(over: Partial<Kinfolk> = {}): Kinfolk {
  return {
    _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', phoneNumber: '', email: '',
    profilePictureUrl: '', status: 'active', joinDate: '', ...over,
  };
}

/**
 * The dialog now opens THREE listeners: households, `booking_time_slots` and
 * `kin_care_sessions`. Dispatching on the spec's path rather than answering all
 * three with one canned value is what lets a test fail exactly one of them.
 */
interface Feeds {
  households?: unknown;
  busySlots?: unknown;
  sessions?: unknown;
}
function feed(feeds: Feeds = {}) {
  useCollection.mockReset().mockImplementation((spec: CollectionSpec) => {
    if (spec.path === 'booking_time_slots') return feeds.busySlots ?? { status: 'ready', data: [] };
    if (spec.path === 'kin_care_sessions') return feeds.sessions ?? { status: 'ready', data: [] };
    return (
      feeds.households ?? {
        status: 'ready',
        data: [kinfolk(), kinfolk({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' })],
      }
    );
  });
}

beforeEach(() => {
  createMultiDateBookingRequest.mockReset();
  // Default: a never-configured install, so the fallback text input is in play
  // and no business hours are set. Tests that care set their own fixture.
  getBusinessSettings.mockReset().mockResolvedValue({ serviceRates: {}, businessHours: {}, timeZone: '' });
  feed();
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

/** Clicks a day in the visible month by its accessible name. */
async function pickDay(name: RegExp) {
  await userEvent.click(screen.getByRole('gridcell', { name }));
}

/** The removable chips under the calendar, in the order rendered. */
function dateChipLabels(): string[] {
  return within(screen.getByRole('group', { name: 'Selected dates' }))
    .queryAllByRole('button')
    .map((b) => (b.textContent ?? '').replace('×', '').trim());
}

describe('NewBookingDialog', () => {
  it('lists households from the live stream', () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Jamie Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Amy Adams' })).toBeInTheDocument();
  });

  it('creates a request from several non-consecutive days at one shared time', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 });
    const onCreated = vi.fn();
    render(<NewBookingDialog onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Service'), 'Dog Walk');
    await pickDay(/Mon, Aug 23/);
    await pickDay(/Tue, Aug 17/);

    await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.kinfolkId).toBe('kf1');
    expect(arg.pattern).toBe('individual');
    expect(arg.visits).toHaveLength(2);
    expect(arg.visits.every((v: { serviceName: string }) => v.serviceName === 'Dog Walk')).toBe(true);
    // Ascending and non-consecutive, whatever order the days were clicked in.
    expect(arg.visits[0].startTimeMs).toBeLessThan(arg.visits[1].startTimeMs);
    expect(new Date(arg.visits[0].startTimeMs).getDate()).toBe(17);
    // The one shared time field applies to every day, as LOCAL wall clock.
    expect(new Date(arg.visits[0].startTimeMs).getHours()).toBe(9);
    expect(new Date(arg.visits[1].startTimeMs).getHours()).toBe(9);
    // The callable contract is untouched: same keys, same shapes as before.
    expect(Object.keys(arg).sort()).toEqual(['kinfolkId', 'pattern', 'visits']);
    expect(Object.keys(arg.visits[0]).sort()).toEqual(['serviceName', 'startTimeMs']);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 }));
  });

  it('echoes the picked days as chips, in date order, and removes one on click', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickDay(/Mon, Aug 23/);
    await pickDay(/Tue, Aug 17/);
    expect(dateChipLabels()).toEqual(['Aug 17', 'Aug 23']);

    await userEvent.click(screen.getByRole('button', { name: 'Remove Aug 17' }));
    expect(dateChipLabels()).toEqual(['Aug 23']);
    expect(screen.getByRole('gridcell', { name: /Tue, Aug 17/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('announces what is selected, not just how many', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No dates picked yet.');
    await pickDay(/Mon, Aug 23/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Selected Aug 23. 1 visit will be requested.',
    );
    await pickDay(/Tue, Aug 17/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Selected Aug 17, Aug 23. 2 visits will be requested.',
    );
  });

  it('creates a weekly recurrence, sending pattern:weekly + weeklyDays', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_2', visitIds: ['v1'], visitCount: 4 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Service'), 'Walk');
    await userEvent.click(screen.getByRole('tab', { name: 'Weekly' }));

    await pickDay(/Tomorrow/); // 2027-08-16, a Monday
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));

    // 4 weeks (the default chip), Mondays only, so 4 visits.
    expect(screen.getByRole('tab', { name: '4' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: /create 4 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.pattern).toBe('weekly');
    expect(arg.weeklyDays).toEqual([1]);
    expect(arg.visits).toHaveLength(4);
  });

  it('takes the weekly length from the 1 to 12 chip row', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Weekly' }));
    await pickDay(/Tomorrow/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    await userEvent.click(screen.getByRole('tab', { name: '12' }));
    expect(screen.getByRole('status')).toHaveTextContent('12 visits will be requested.');
  });

  it('blocks submit and shows errors when required fields are missing', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    // No household, no service, no date. The button is disabled, and touching reveals errors.
    await userEvent.click(screen.getByLabelText('Household')); // focus
    await userEvent.tab(); // blur -> touched
    expect(await screen.findByText(/pick a household/i)).toBeInTheDocument();
    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();
  });

  describe('availability', () => {
    const HOURS = {
      Monday: '09:00-17:00',
      Tuesday: '09:00-17:00',
      Wednesday: '09:00-17:00',
      Thursday: '09:00-17:00',
      Friday: '09:00-17:00',
      Saturday: '',
      Sunday: '',
    };

    it('marks the days the business is closed', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      // Saturday is blank in the fixture, so it is closed; Monday is not.
      await screen.findByRole('gridcell', { name: /Sat, Aug 21, business closed/ });
      expect(
        screen.getByRole('gridcell', { name: /Mon, Aug 23, open 9:00 AM to 5:00 PM/ }),
      ).toBeInTheDocument();
    });

    it('warns about a closed day but still lets the request go out', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
      createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
      await userEvent.type(screen.getByLabelText('Service'), 'Walk');
      await screen.findByRole('gridcell', { name: /Sat, Aug 21, business closed/ });
      await pickDay(/Sat, Aug 21/);

      expect(screen.getByText('Aug 21: the business is closed that day.')).toBeInTheDocument();
      // Warned, not blocked. The operator IS the business.
      await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
      await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    });

    it('warns when the shared start time falls outside the open window', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      await screen.findByRole('gridcell', { name: /Mon, Aug 23, open 9:00 AM to 5:00 PM/ });
      await pickDay(/Mon, Aug 23/);
      expect(screen.queryByText(/outside business hours/)).not.toBeInTheDocument();

      await userEvent.clear(screen.getByLabelText('Start time'));
      await userEvent.type(screen.getByLabelText('Start time'), '19:00');
      expect(
        screen.getByText('Aug 23: 19:00 is outside business hours (9:00 AM to 5:00 PM).'),
      ).toBeInTheDocument();
    });

    it('marks a day with blocked time and warns when the start lands inside it', async () => {
      feed({
        busySlots: {
          status: 'ready',
          data: [
            { _id: 'b1', date: '2027-08-23', startTime: '08:00', endTime: '12:00', slotType: 'BLOCKED' },
          ],
        },
      });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      await pickDay(/Mon, Aug 23, .*blocked 8:00 AM to 12:00 PM/);
      expect(screen.getByText('Aug 23: blocked time at 8:00 AM to 12:00 PM.')).toBeInTheDocument();
    });

    it('counts the visits already scheduled on a day', () => {
      feed({
        sessions: {
          status: 'ready',
          data: [
            { _id: 's1', startTime: '2027-08-23T14:00:00-05:00' },
            { _id: 's2', startTime: '2027-08-23T16:00:00-05:00' },
          ],
        },
      });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      expect(
        screen.getByRole('gridcell', { name: /Mon, Aug 23, .*2 visits already scheduled/ }),
      ).toBeInTheDocument();
    });

    it('fails loud and stays usable when the blocked-time read is denied', async () => {
      createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
      feed({ busySlots: { status: 'error', message: 'permission-denied', retry: vi.fn() } });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      expect(screen.getByText(/Availability unknown/)).toBeInTheDocument();
      expect(screen.getByText(/blocked time \(permission-denied\)/)).toBeInTheDocument();
      // The calendar claims nothing it can no longer justify.
      expect(
        screen.getByRole('gridcell', { name: /Mon, Aug 23, availability unknown/ }),
      ).toBeInTheDocument();

      // And the booking still goes out. A secondary read must never gate this.
      await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
      await userEvent.type(screen.getByLabelText('Service'), 'Walk');
      await pickDay(/Mon, Aug 23/);
      await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
      await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    });

    it('fails loud when the business-hours read is denied', async () => {
      getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      expect(
        await screen.findByText(/Business hours couldn.t be read \(permission-denied\)/),
      ).toBeInTheDocument();
    });

    it('discloses a business timezone the device is not in, rather than converting silently', async () => {
      const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      getBusinessSettings.mockResolvedValue({
        serviceRates: {},
        businessHours: {},
        timeZone: 'Pacific/Auckland',
      });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      const note = await screen.findByText(/Settings has this business in/);
      expect(note.textContent).toContain('Pacific/Auckland');
      expect(note.textContent).toContain(deviceZone);
    });

    it('says nothing about zones when the business is set to the device zone', async () => {
      getBusinessSettings.mockResolvedValue({
        serviceRates: {},
        businessHours: {},
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
      await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
      expect(screen.queryByText(/Settings has this business in/)).not.toBeInTheDocument();
    });
  });

  describe('service chips (business_settings.serviceRates)', () => {
    it('renders one chip per KinCare type, ordered by parsed duration, priced from the rate', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
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
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
      createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_3', visitIds: ['v1', 'v2'], visitCount: 2 });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
      const chip = await screen.findByRole('button', { name: 'Half-Day 6Hrs · $100' });
      await userEvent.click(chip);
      expect(chip).toHaveAttribute('aria-pressed', 'true');

      await pickDay(/Tue, Aug 17/);
      await pickDay(/Mon, Aug 23/);
      await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

      await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
      const arg = createMultiDateBookingRequest.mock.calls[0]![0];
      // The MAP KEY goes on the wire, not the "· $100" chip label.
      expect(arg.visits.map((v: { serviceName: string }) => v.serviceName)).toEqual([
        'Half-Day 6Hrs',
        'Half-Day 6Hrs',
      ]);
      expect(typeof arg.visits[0].startTimeMs).toBe('number');
    });

    it('picking a second chip replaces the first (single select)', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      const first = await screen.findByRole('button', { name: '30Minute · $25' });
      await userEvent.click(first);
      const second = screen.getByRole('button', { name: '90Minute · $55' });
      await userEvent.click(second);

      expect(first).toHaveAttribute('aria-pressed', 'false');
      expect(second).toHaveAttribute('aria-pressed', 'true');
    });

    it('falls back to a text input plus a Settings hint when no KinCare types exist', async () => {
      getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: {}, timeZone: '' });
      render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

      expect(await screen.findByText(/no kincare types yet/i)).toBeInTheDocument();
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
    await pickDay(/Mon, Aug 23/);
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    expect(await screen.findByText(/createMultiDateBookingRequest failed:.*not found/i)).toBeInTheDocument();
  });
});
