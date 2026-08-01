// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KIN_ROSTER_MAX, type Kin, type Kinfolk } from '../api/directory';
import { BOOKING_BUSY_CONFLICT_CODE, COMPANY_HOLIDAY_CONFLICT_CODE } from '../lib/bookingWizard';
import type { CollectionSpec } from '../lib/firestore';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createMultiDateBookingRequest } = vi.hoisted(() => ({ createMultiDateBookingRequest: vi.fn() }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  createMultiDateBookingRequest,
}));

// The service list and the business hours both come from business_settings.
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

function kin(over: Partial<Kin> = {}): Kin {
  return { _id: 'k1', kinfolkId: 'kf1', name: 'Biscuit', status: 'active', ...over };
}

/**
 * A callable rejection shaped the way the Functions SDK delivers one: the human
 * sentence on `message`, the branchable reason on `details.code`. Nothing in
 * this app reads the sentence to decide anything.
 */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { details: { code } });
}

/**
 * The wizard opens FOUR listeners: households, the Kin roster,
 * `booking_time_slots` and `kin_care_sessions`. Dispatching on the spec's path
 * rather than answering all four with one canned value is what lets a test fail
 * exactly one of them.
 */
interface Feeds {
  households?: unknown;
  kin?: unknown;
  busySlots?: unknown;
  sessions?: unknown;
}
function feed(feeds: Feeds = {}) {
  useCollection.mockReset().mockImplementation((spec: CollectionSpec) => {
    if (spec.path === 'booking_time_slots') return feeds.busySlots ?? { status: 'ready', data: [] };
    if (spec.path === 'kin_care_sessions') return feeds.sessions ?? { status: 'ready', data: [] };
    if (spec.path === 'kin') return feeds.kin ?? { status: 'ready', data: [] };
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

function serviceNames(): string[] {
  return within(screen.getByRole('group', { name: 'Services' }))
    .queryAllByRole('button')
    .map((b) => (b.textContent ?? '').trim());
}

/** Clicks a day in the visible month by its accessible name. */
async function pickDay(name: RegExp) {
  await userEvent.click(screen.getByRole('gridcell', { name }));
}

async function next() {
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
}

/** Steps 1 and 2 done, parked on Schedule Dates. `service` is a typed-in name by default. */
async function toDates(service = 'Dog Walk') {
  await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
  await next();
  const field = screen.queryByPlaceholderText('e.g. Dog Walk');
  if (field) await userEvent.type(field, service);
  else await userEvent.click(await screen.findByRole('button', { name: new RegExp(service) }));
  await next();
}

/** From Schedule Dates through Invoice Options to Review. */
async function toReview() {
  await next();
  await next();
}

describe('NewBookingDialog wizard shell', () => {
  it('walks the five steps the PNGs name, in order', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const rail = screen.getByRole('list', { name: 'Booking steps' });
    expect(within(rail).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1Select Kinfolk & Kin',
      '2Choose Service',
      '3Schedule Dates',
      '4Invoice Options',
      '5Review & Confirm',
    ]);
    expect(screen.getByRole('heading', { name: 'Select Kinfolk & Kin' })).toBeInTheDocument();
  });

  it('lists households from the live stream', () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Jamie Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Amy Adams' })).toBeInTheDocument();
  });

  it('Next SAYS what is missing rather than sitting greyed out', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await next();
    expect(screen.getByText('Pick a household first.')).toBeInTheDocument();
    // Still on step 1: a blocked Next moves nothing.
    expect(screen.getByRole('heading', { name: 'Select Kinfolk & Kin' })).toBeInTheDocument();
  });

  it('advances once the step is satisfied, and Back returns without losing the answer', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    expect(screen.getByRole('heading', { name: 'Select a Service' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Household')).toHaveValue('kf1');
  });

  it('keeps every earlier answer across a full round trip to Review and back', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Dog Walk');
    await pickDay(/Mon, Aug 23/);
    await toReview();
    expect(screen.getByRole('heading', { name: 'Review & Confirm' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected Aug 23. 1 visit will be requested.');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByDisplayValue('Dog Walk')).toBeInTheDocument();
  });

  it('a completed step in the rail jumps straight back to it', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await userEvent.click(screen.getByRole('button', { name: /Select Kinfolk & Kin/ }));
    expect(screen.getByRole('heading', { name: 'Select Kinfolk & Kin' })).toBeInTheDocument();
  });

  it('a step not yet reached is static text, never a dead button', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Review & Confirm/ })).toBeNull();
  });
});

describe('NewBookingDialog step 1: client and pets', () => {
  it('offers the household\'s active Kin and sends the picked ids', async () => {
    feed({
      kin: {
        status: 'ready',
        data: [kin(), kin({ _id: 'k2', name: 'Gravy' }), kin({ _id: 'k3', name: 'Elsewhere', kinfolkId: 'kf2' })],
      },
    });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    // kf2's Kin is not offered here.
    expect(screen.queryByRole('checkbox', { name: 'Elsewhere' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Biscuit' }));
    await next();
    await userEvent.type(screen.getByPlaceholderText('e.g. Dog Walk'), 'Walk');
    await next();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    expect(createMultiDateBookingRequest.mock.calls[0]![0].kinIds).toEqual(['k1']);
  });

  it('says the booking covers the household when no Kin is picked, and sends no kinIds', async () => {
    feed({ kin: { status: 'ready', data: [kin()] } });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.getByText(/covers the whole household/i)).toBeInTheDocument();
    await next();
    await userEvent.type(screen.getByPlaceholderText('e.g. Dog Walk'), 'Walk');
    await next();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    expect(createMultiDateBookingRequest.mock.calls[0]![0]).not.toHaveProperty('kinIds');
  });

  it('changing household clears the Kin picked from the previous one', async () => {
    feed({
      kin: { status: 'ready', data: [kin(), kin({ _id: 'k3', name: 'Elsewhere', kinfolkId: 'kf2' })] },
    });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Biscuit' }));
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf2');
    expect(screen.getByRole('checkbox', { name: 'Elsewhere' })).not.toBeChecked();
  });

  it('fails loud, and keeps going, when the Kin roster read is denied', async () => {
    feed({ kin: { status: 'error', message: 'permission-denied', retry: vi.fn() } });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.getByText(/Kin roster could not be read \(permission-denied\)/)).toBeInTheDocument();
    await next();
    expect(screen.getByRole('heading', { name: 'Select a Service' })).toBeInTheDocument();
  });

  // DEFECT 5. The wizard used to stream the WHOLE `kin` collection behind one
  // shared cap ordered by document id, so a household whose kin sit past that
  // boundary read back as an empty roster and this step said "No Kin on this
  // household yet" with total confidence.
  it("asks for ONE household's roster, not the whole capped collection", async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    const kinSpecs = useCollection.mock.calls
      .map((call: unknown[]) => call[0] as CollectionSpec)
      .filter((spec: CollectionSpec) => spec.path === 'kin');
    expect(kinSpecs.length).toBeGreaterThan(0);
    expect(kinSpecs[kinSpecs.length - 1]!.filters).toEqual([['kinfolkId', '==', 'kf1']]);
  });

  it('says so when the roster came back AT the cap, rather than passing a page off as the whole list', async () => {
    feed({
      kin: {
        status: 'ready',
        data: Array.from({ length: KIN_ROSTER_MAX }, (_, i) =>
          kin({ _id: `k${i}`, name: `Kin ${i}` }),
        ),
      },
    });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.getByText(/roster hit the 500-row read limit/)).toBeInTheDocument();
  });

  it('says nothing about a cap for a roster that fits', async () => {
    feed({ kin: { status: 'ready', data: [kin(), kin({ _id: 'k2', name: 'Gravy' })] } });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.queryByText(/read limit/)).toBeNull();
  });
});

describe('NewBookingDialog step 2: service', () => {
  it('lists one row per KinCare type, ordered by parsed duration, priced from the rate', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();

    await screen.findByRole('button', { name: /30Minute/ });
    // Ascending duration; the rate-less "Consultation" has no parseable
    // duration, so it sorts last and says it has no price rather than $0.
    expect(serviceNames()).toEqual([
      '30Minute$25',
      '60Minute$40',
      '90Minute$55',
      'Half-Day 6Hrs$100',
      'ConsultationNo price set',
    ]);
    expect(screen.queryByPlaceholderText('e.g. Dog Walk')).not.toBeInTheDocument();
  });

  it('narrows the list by the search box, and says when nothing matches', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await screen.findByRole('button', { name: /30Minute/ });

    await userEvent.type(screen.getByLabelText('Search services'), 'half');
    expect(serviceNames()).toEqual(['Half-Day 6Hrs$100']);
    await userEvent.clear(screen.getByLabelText('Search services'));
    await userEvent.type(screen.getByLabelText('Search services'), 'zzz');
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('sends the MAP KEY on every visit, not the priced label', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v1', 'v2'], visitCount: 2 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.click(await screen.findByRole('button', { name: /Half-Day 6Hrs/ }));
    await next();
    await pickDay(/Tue, Aug 17/);
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.visits.map((v: { serviceName: string }) => v.serviceName)).toEqual([
      'Half-Day 6Hrs',
      'Half-Day 6Hrs',
    ]);
  });

  it('picking a second service replaces the first', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    const first = await screen.findByRole('button', { name: /30Minute/ });
    await userEvent.click(first);
    const second = screen.getByRole('button', { name: /90Minute/ });
    await userEvent.click(second);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(second).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to a text input plus a Settings hint when no KinCare types exist', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    expect(await screen.findByText(/no kincare types yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Service')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Services' })).not.toBeInTheDocument();
  });

  it('fails loud and keeps the text input when the settings read blows up', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    expect(
      await screen.findByText(/couldn.t load your kincare types.*permission-denied/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Service')).toBeInTheDocument();
  });
});

describe('NewBookingDialog step 3: dates, times, services and places per visit', () => {
  it('creates a request from several non-consecutive days', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 });
    const onCreated = vi.fn();
    render(<NewBookingDialog onClose={vi.fn()} onCreated={onCreated} />);

    await toDates('Dog Walk');
    await pickDay(/Mon, Aug 23/);
    await pickDay(/Tue, Aug 17/);
    await toReview();
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
    expect(new Date(arg.visits[0].startTimeMs).getHours()).toBe(9);
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ batchId: 'req_1', visitIds: ['v1', 'v2'], visitCount: 2 }),
    );
  });

  it('announces what is selected, not just how many', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    expect(screen.getByRole('status')).toHaveTextContent('No dates picked yet.');
    await pickDay(/Mon, Aug 23/);
    expect(screen.getByRole('status')).toHaveTextContent('Selected Aug 23. 1 visit will be requested.');
    await pickDay(/Tue, Aug 17/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Selected Aug 17, Aug 23. 2 visits will be requested.',
    );
  });

  it('unpicking a day drops it from the plan and from the calendar', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Tue, Aug 17/);
    await pickDay(/Tue, Aug 17/);
    expect(screen.getByRole('status')).toHaveTextContent('No dates picked yet.');
    expect(screen.getByRole('gridcell', { name: /Tue, Aug 17/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('sends a SECOND visit on the same day, at its own time and its own service', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v1', 'v2'], visitCount: 2 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.click(await screen.findByRole('button', { name: /30Minute/ }));
    await next();
    await pickDay(/Mon, Aug 23/);

    // Open the day and give it a second visit. This is the whole reason the
    // wizard exists: the single-page form sent one time and one service for
    // every date it had.
    await userEvent.click(screen.getByRole('button', { name: /Aug 23/ }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Add another visit' })[1]!);
    await userEvent.clear(screen.getByLabelText('Aug 23 visit 2 time'));
    await userEvent.type(screen.getByLabelText('Aug 23 visit 2 time'), '16:30');
    await userEvent.selectOptions(screen.getByLabelText('Aug 23 visit 2 service'), '90Minute');
    await userEvent.type(screen.getByLabelText('Aug 23 visit 2 place'), 'Back gate');

    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const visits = createMultiDateBookingRequest.mock.calls[0]![0].visits;
    expect(visits).toHaveLength(2);
    expect(visits[0].serviceName).toBe('30Minute');
    expect(visits[1].serviceName).toBe('90Minute');
    expect(new Date(visits[0].startTimeMs).getHours()).toBe(9);
    expect(new Date(visits[1].startTimeMs).getHours()).toBe(16);
    expect(new Date(visits[1].startTimeMs).getMinutes()).toBe(30);
    // A place on one visit and none on the other, which is the point of it
    // being per-visit. Blank is null on the wire, never ''.
    expect(visits[0].location).toBeNull();
    expect(visits[1].location).toBe('Back gate');
  });

  it('the Daily Visit Schedule seeds NEW days only, never rewrites a day already tuned', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v1', 'v2'], visitCount: 2 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Tue, Aug 17/);

    await userEvent.clear(screen.getByLabelText('Daily visit 1 time'));
    await userEvent.type(screen.getByLabelText('Daily visit 1 time'), '14:00');
    await pickDay(/Mon, Aug 23/);

    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 2 visits/i }));
    const visits = createMultiDateBookingRequest.mock.calls[0]![0].visits;
    // Aug 17 keeps the 09:00 it was picked with; only Aug 23 takes the new 14:00.
    expect(new Date(visits[0].startTimeMs).getHours()).toBe(9);
    expect(new Date(visits[1].startTimeMs).getHours()).toBe(14);
  });

  it('creates a weekly recurrence, sending pattern:weekly + weeklyDays', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'req_2', visitIds: ['v1'], visitCount: 4 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await userEvent.click(screen.getByRole('tab', { name: /Repeating Schedule/ }));

    await pickDay(/Tomorrow/); // 2027-08-16, a Monday
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));

    expect(screen.getByRole('tab', { name: '4' })).toHaveAttribute('aria-selected', 'true');
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 4 visits/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.pattern).toBe('weekly');
    expect(arg.weeklyDays).toEqual([1]);
    expect(arg.visits).toHaveLength(4);
  });

  it('takes the weekly length from the 1 to 12 chip row', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await userEvent.click(screen.getByRole('tab', { name: /Repeating Schedule/ }));
    await pickDay(/Tomorrow/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    await userEvent.click(screen.getByRole('tab', { name: '12' }));
    expect(screen.getByRole('status')).toHaveTextContent('12 visits will be requested.');
  });

  it('repeats EVERY template visit, so two visits a day become two per repeat', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await userEvent.click(screen.getByRole('tab', { name: /Repeating Schedule/ }));
    await pickDay(/Tomorrow/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add another visit' }));
    expect(screen.getByRole('status')).toHaveTextContent('8 visits will be requested.');
  });

  it('will not leave the step with no dates, and says which mode is missing what', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await next();
    expect(screen.getByText('Pick at least one date.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Repeating Schedule/ }));
    await next();
    expect(screen.getByText('Pick a start date and at least one weekday.')).toBeInTheDocument();
    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();
  });
});

describe('NewBookingDialog availability (carried over intact)', () => {
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
    await toDates();
    await screen.findByRole('gridcell', { name: /Sat, Aug 21, business closed/ });
    expect(
      screen.getByRole('gridcell', { name: /Mon, Aug 23, open 9:00 AM to 5:00 PM/ }),
    ).toBeInTheDocument();
  });

  it('warns about a closed day but still lets the request go out', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await screen.findByRole('gridcell', { name: /Sat, Aug 21, business closed/ });
    await pickDay(/Sat, Aug 21/);

    expect(screen.getByText('Aug 21: the business is closed that day.')).toBeInTheDocument();
    // Warned, not blocked. The operator IS the business.
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
  });

  it('C1: refuses a company holiday outright -- unlike a plain closed-hours day, it cannot even be selected', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceRates: {},
      businessHours: HOURS,
      timeZone: '',
      companyHolidays: ['2027-08-23|Founders Day'],
    });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    const cell = await screen.findByRole('gridcell', { name: /Mon, Aug 23, closed for Founders Day, not available/ });
    expect(cell.textContent).toContain('Closed');

    await userEvent.click(cell);
    expect(cell).toHaveAttribute('aria-selected', 'false');
    // Nothing was added to the plan, so Next on this step still blocks.
    await next();
    expect(screen.getByText('Pick at least one date.')).toBeInTheDocument();
  });

  it('warns when a visit time falls outside the open window', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await screen.findByRole('gridcell', { name: /Mon, Aug 23, open 9:00 AM to 5:00 PM/ });
    await pickDay(/Mon, Aug 23/);
    expect(screen.queryByText(/outside business hours/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Aug 23/ }));
    await userEvent.clear(screen.getByLabelText('Aug 23 visit 1 time'));
    await userEvent.type(screen.getByLabelText('Aug 23 visit 1 time'), '19:00');
    expect(
      screen.getByText('Aug 23: 19:00 is outside business hours (9:00 AM to 5:00 PM).'),
    ).toBeInTheDocument();
  });

  // DEFECT 3. The warnings were a day-by-time CROSS PRODUCT: every selected day
  // was checked against every time used anywhere in the plan, so a 19:00 visit
  // on one day produced a 19:00 warning on every other day too.
  it('warns about the visits the request will contain, and no others', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await screen.findByRole('gridcell', { name: /Mon, Aug 23, open 9:00 AM to 5:00 PM/ });
    await pickDay(/Tue, Aug 17/);
    await pickDay(/Mon, Aug 23/);

    // Aug 23 moves to 19:00. Aug 17 stays at 09:00 and is inside hours.
    await userEvent.click(screen.getByRole('button', { name: /Aug 23/ }));
    await userEvent.clear(screen.getByLabelText('Aug 23 visit 1 time'));
    await userEvent.type(screen.getByLabelText('Aug 23 visit 1 time'), '19:00');

    expect(
      screen.getByText('Aug 23: 19:00 is outside business hours (9:00 AM to 5:00 PM).'),
    ).toBeInTheDocument();
    // There is no 19:00 visit on Aug 17, so there is nothing to warn about.
    expect(
      screen.queryByText('Aug 17: 19:00 is outside business hours (9:00 AM to 5:00 PM).'),
    ).toBeNull();
  });

  // DEFECT 2. Weekly mode only ever reasoned about the START date, so a closure
  // in week 3 was invisible until submit refused the whole batch.
  it('refuses a recurrence whose THIRD week lands on a company closure, on the Dates step', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceRates: {},
      businessHours: HOURS,
      timeZone: '',
      // Mondays from 2027-08-16: Aug 16, Aug 23, Aug 30, Sep 6.
      companyHolidays: ['2027-08-30|Founders Day'],
    });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await userEvent.click(screen.getByRole('tab', { name: /Repeating Schedule/ }));
    await pickDay(/Tomorrow/); // 2027-08-16, a Monday
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    expect(screen.getByRole('status')).toHaveTextContent('4 visits will be requested.');

    await next();
    expect(
      screen.getByText(
        'Aug 30 is closed for Founders Day. The business will refuse that date, so pick another.',
      ),
    ).toBeInTheDocument();
    // Still on the Dates step: the batch is not carried to Review to be lost there.
    expect(screen.getByRole('heading', { name: 'Set the repeating schedule' })).toBeInTheDocument();
    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();

    // Shortening the recurrence to two weeks clears the closure and the gate.
    await userEvent.click(screen.getByRole('tab', { name: '2' }));
    await next();
    expect(screen.getByRole('heading', { name: 'Invoice Options' })).toBeInTheDocument();
  });

  it('warns once per distinct time, not once per visit', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: {}, businessHours: HOURS, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Sat, Aug 21/);
    await userEvent.click(screen.getByRole('button', { name: /Aug 21/ }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Add another visit' })[1]!);
    // Two visits, one closed day: one line, not two.
    expect(screen.getAllByText('Aug 21: the business is closed that day.')).toHaveLength(1);
  });

  it('marks a day with blocked time and warns when a visit lands inside it', async () => {
    feed({
      busySlots: {
        status: 'ready',
        data: [
          { _id: 'b1', date: '2027-08-23', startTime: '08:00', endTime: '12:00', slotType: 'BLOCKED' },
        ],
      },
    });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23, .*blocked 8:00 AM to 12:00 PM/);
    expect(screen.getByText('Aug 23: blocked time at 8:00 AM to 12:00 PM.')).toBeInTheDocument();
  });

  it('counts the visits already scheduled on a day', async () => {
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
    await toDates();
    expect(
      screen.getByRole('gridcell', { name: /Mon, Aug 23, .*2 visits already scheduled/ }),
    ).toBeInTheDocument();
  });

  it('fails loud and stays usable when the blocked-time read is denied', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    feed({ busySlots: { status: 'error', message: 'permission-denied', retry: vi.fn() } });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');

    expect(screen.getByText(/Availability unknown/)).toBeInTheDocument();
    expect(screen.getByText(/blocked time \(permission-denied\)/)).toBeInTheDocument();
    // The calendar claims nothing it can no longer justify.
    expect(
      screen.getByRole('gridcell', { name: /Mon, Aug 23, availability unknown/ }),
    ).toBeInTheDocument();

    // And the booking still goes out. A secondary read must never gate this.
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
  });

  it('fails loud when the business-hours read is denied', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
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
    await toDates();
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
    await toDates();
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
    expect(screen.queryByText(/Settings has this business in/)).not.toBeInTheDocument();
  });
});

describe('NewBookingDialog steps 4 and 5: invoice options and review', () => {
  it('states the billing arrangement, and what it does NOT do', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await next();
    expect(screen.getByRole('heading', { name: 'Invoice Options' })).toBeInTheDocument();
    // Not "an invoice will be created": nothing here raises one.
    expect(screen.getByText(/raised from Invoices once the visits are complete/i)).toBeInTheDocument();
  });

  it('totals the plan from the rate card', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.click(await screen.findByRole('button', { name: /30Minute/ }));
    await next();
    await pickDay(/Mon, Aug 23/);
    await pickDay(/Tue, Aug 17/);
    await toReview();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('2 visits across 2 days')).toBeInTheDocument();
  });

  it('NAMES an unpriced service instead of counting it as zero', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.click(await screen.findByRole('button', { name: /Consultation/ }));
    await next();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Consultation has no price on the rate card/,
    );
  });

  it('sends both communication toggles off by default, as the mock has them', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    expect(screen.getByRole('checkbox', { name: /Email confirmation/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Exact times/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.communication).toEqual({ emailConfirmation: false, timeVisibility: false });
    expect(arg.billing).toEqual({ mode: 'new-invoice' });
  });

  it('sends the toggles the operator turned on, and the private notes', async () => {
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('checkbox', { name: /Email confirmation/ }));
    await userEvent.type(screen.getByLabelText(/Private notes/), 'Gate code 1234');
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    const arg = createMultiDateBookingRequest.mock.calls[0]![0];
    expect(arg.communication).toEqual({ emailConfirmation: true, timeVisibility: false });
    expect(arg.notes).toBe('Gate code 1234');
  });

  it('an Edit link on Review goes back to the step that owns that answer', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: 'Edit dates' }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected Aug 23.');
  });

  it('the rail stops offering a step that a later edit made unreachable', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await toReview();
    expect(screen.getByRole('button', { name: /Schedule Dates/ })).toBeInTheDocument();

    // Emptying the household three steps back invalidates everything after it,
    // so those circles go back to being static text rather than staying live
    // shortcuts into a state the operator can no longer submit from.
    await userEvent.click(screen.getByRole('button', { name: /Select Kinfolk & Kin/ }));
    await userEvent.selectOptions(screen.getByLabelText('Household'), '');
    expect(screen.queryByRole('button', { name: /Schedule Dates/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Review & Confirm/ })).toBeNull();
  });

  it('refuses to submit a plan that went stale while it sat on Review, and lands ON the step that broke', async () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates();
    await pickDay(/Mon, Aug 23/);
    await toReview();

    // The one way a valid plan goes bad without a click: time passes. The
    // operator leaves the wizard open, the visit slips into the past, and the
    // callable would reject it. This is what the from-the-first-step re-check
    // on submit is for.
    vi.setSystemTime(new Date(2027, 8, 1, 12, 0, 0));
    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();
    expect(screen.getByText('Every visit has to be in the future.')).toBeInTheDocument();
    // Back on the step that owns the problem, not left on Review with a warning.
    expect(screen.getByRole('status')).toHaveTextContent('Selected Aug 23.');
    vi.setSystemTime(new Date(2027, 7, 15, 12, 0, 0));
  });

  // DEFECT 4. Review rendered `state.serviceName`, the step-2 DEFAULT, while a
  // day already picked keeps the service it was snapshotted with. The header
  // could therefore name a service no submitted visit carries.
  it('Review names the service the VISITS carry, not the last one picked on step 2', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: RATES, businessHours: {}, timeZone: '' });
    createMultiDateBookingRequest.mockResolvedValue({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.click(await screen.findByRole('button', { name: /30Minute/ }));
    await next();
    await pickDay(/Mon, Aug 23/);

    // Back to step 2 and pick something else. The already-picked day keeps its
    // own service ("changes apply only to dates you pick after this").
    await userEvent.click(screen.getByRole('button', { name: /Choose Service/ }));
    await userEvent.click(await screen.findByRole('button', { name: /90Minute/ }));
    await userEvent.click(screen.getByRole('button', { name: /Review & Confirm/ }));

    const review = screen.getByRole('heading', { name: 'Review & Confirm' }).parentElement!;
    expect(within(review).getByText('30Minute')).toBeInTheDocument();
    expect(within(review).queryByText('90Minute')).toBeNull();

    // And what it says is what goes out.
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(1));
    expect(createMultiDateBookingRequest.mock.calls[0]![0].visits[0].serviceName).toBe('30Minute');
  });

  // DEFECT 1. `overrideBusyConflict` had ZERO occurrences under src/ outside the
  // generated contract, so the warning banner's "you can still send the request"
  // was a promise the wizard could not keep: the server refused a real busy
  // clash and there was no way past it.
  it('offers Create anyway on a busy-block refusal, and the retry carries the audited override', async () => {
    createMultiDateBookingRequest
      .mockRejectedValueOnce(refusal(BOOKING_BUSY_CONFLICT_CODE, 'That time is already busy.'))
      .mockResolvedValueOnce({ batchId: 'r', visitIds: ['v'], visitCount: 1 });
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    await screen.findByText(/That time is already busy/);
    expect(
      screen.getByText(/imported Google Calendar busy block. You can book over it/),
    ).toBeInTheDocument();
    // The first attempt never sets the flag.
    expect(createMultiDateBookingRequest.mock.calls[0]![0]).not.toHaveProperty(
      'overrideBusyConflict',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(2));
    // The whole point: the flag the server has always honored now reaches it.
    expect(createMultiDateBookingRequest.mock.calls[1]![0].overrideBusyConflict).toBe(true);
    expect(createMultiDateBookingRequest.mock.calls[1]![0].visits).toHaveLength(1);
  });

  it('never offers Create anyway for a company closure, which has no override server-side', async () => {
    createMultiDateBookingRequest.mockRejectedValue(
      refusal(COMPANY_HOLIDAY_CONFLICT_CODE, 'Aug 23 is closed for Founders Day.'),
    );
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));

    await screen.findByText(/closed for Founders Day/);
    expect(screen.queryByRole('button', { name: 'Create anyway' })).toBeNull();
  });

  it('does not re-offer Create anyway once the override has already been refused', async () => {
    createMultiDateBookingRequest.mockRejectedValue(
      refusal(BOOKING_BUSY_CONFLICT_CODE, 'That time is already busy.'),
    );
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create anyway' }));

    await waitFor(() => expect(createMultiDateBookingRequest).toHaveBeenCalledTimes(2));
    // Offering the same losing move twice is worse than saying nothing.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create anyway' })).toBeNull(),
    );
  });

  it('fails loud (names the callable) when the create rejects', async () => {
    createMultiDateBookingRequest.mockRejectedValue(new Error('not-found: Kinfolk not found'));
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await toDates('Walk');
    await pickDay(/Mon, Aug 23/);
    await toReview();
    await userEvent.click(screen.getByRole('button', { name: /create 1 visit/i }));
    expect(
      await screen.findByText(/createMultiDateBookingRequest failed:.*not found/i),
    ).toBeInTheDocument();
  });
});
