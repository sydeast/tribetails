// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingWizardBody } from './BookingWizard';
import type {
  GetBookingPolicyResult,
  GetBusinessClosuresRequest,
  GetBusinessClosuresResult,
  GetServiceCatalogResult,
  TimeBlockDto,
} from '../api/bookingApi';
import type { RequestBookingArgs, RequestBookingResult } from '../contracts/bookingContracts.generated';
import type { GetMyKinResult, KinDto } from '../api/types';
import { dateKey, MAX_RECURRING_VISITS, startOfDay } from '../lib/bookingWizardLogic';

/**
 * #544: the picker's lower bound is today, so a date fixture may never be
 * pinned to "the 1st of the month" -- that is a past date on 30 days out of
 * 31 and its cell is disabled. Everything below is derived from today
 * instead. `TOMORROW` can land in the next month; `pickDay` pages forward
 * when it does, so these hold on the last day of a month too.
 */
const TODAY = startOfDay(new Date());
const TOMORROW = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 1);
/**
 * Time-block booking added `pastPlannedVisits`: a plan whose visit has already
 * STARTED now blocks the wizard, because `requestBooking` refuses every one of
 * those anyway and a household should hear it while they can still fix it.
 * That makes a fixture pinned to TODAY pass or fail by the hour the suite runs
 * at, so anywhere a test only needed "a pickable date" it uses a future one.
 */
const DAY_AFTER = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 2);

/** Time-block booking fixtures. */
const MIDDAY: TimeBlockDto = { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', durationMinutes: 240 };
const EVENING: TimeBlockDto = { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', durationMinutes: 240 };
/** The pre-time-block world, and what `getBookingPolicy` itself falls back to. */
const CLOCK_ONLY_POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeBlocks: [],
};
const BLOCK_ONLY_POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: false,
  defaultBookingMode: 'TIME_BLOCK',
  timeBlocks: [MIDDAY, EVENING],
};
const BOTH_MODES_POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'TIME_BLOCK',
  timeBlocks: [MIDDAY, EVENING],
};

/** A day cell, addressed by its printed day-of-month (unique within a month). */
function dayCell(d: Date) {
  return screen.getByRole('button', { name: String(d.getDate()) });
}

/** Clicks `d`'s cell, paging to the next month first when `d` lives there. */
async function pickDay(user: ReturnType<typeof userEvent.setup>, d: Date) {
  if (d.getMonth() !== TODAY.getMonth()) {
    await user.click(screen.getByRole('button', { name: 'Next month' }));
  }
  await user.click(dayCell(d));
}

function visitMs(d: Date, hour: number, minute: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

const getMyKin = vi.fn<() => Promise<GetMyKinResult>>();
const getServiceCatalog = vi.fn<() => Promise<GetServiceCatalogResult>>();
const requestBooking = vi.fn<(req: RequestBookingArgs) => Promise<RequestBookingResult>>();
const getBusinessClosures = vi.fn<(req: GetBusinessClosuresRequest) => Promise<GetBusinessClosuresResult>>();
const getBookingPolicy = vi.fn<() => Promise<GetBookingPolicyResult>>();

vi.mock('../api/portal', () => ({
  getMyKin: () => getMyKin(),
}));
vi.mock('../api/bookingApi', async () => {
  const actual = await vi.importActual<typeof import('../api/bookingApi')>('../api/bookingApi');
  return {
    ...actual,
    getServiceCatalog: () => getServiceCatalog(),
    requestBooking: (req: RequestBookingArgs) => requestBooking(req),
    getBusinessClosures: (req: GetBusinessClosuresRequest) => getBusinessClosures(req),
    getBookingPolicy: () => getBookingPolicy(),
  };
});
vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'fam1',
}));

function kin(overrides: Partial<KinDto>): KinDto {
  return {
    id: 'k1',
    name: 'Buddy',
    species: 'dog',
    breed: null,
    ageYears: 3,
    photoUrl: null,
    status: 'active',
    feedingInstructions: null,
    walkingInstructions: null,
    medications: null,
    allergies: null,
    emergencyNotes: null,
    sitterNotes: null,
    ...overrides,
  };
}

const SERVICE_A = {
  id: 's1',
  name: 'Daily Visit',
  category: 'Held Down at Home',
  description: 'A full daily routine.',
  priceCents: 4200,
  priceMinCents: null,
  priceMaxCents: null,
  durationMinutes: null,
  isOvernight: false,
  iconKey: 'sun',
};
const SERVICE_B = {
  id: 's2',
  name: 'Overnight Stays',
  category: 'Held Down at Home',
  description: null,
  priceCents: 15000,
  priceMinCents: null,
  priceMaxCents: null,
  durationMinutes: null,
  isOvernight: true,
  iconKey: 'moon',
};

function renderWizard(onComplete = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSignOut = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <BookingWizardBody onClose={onClose} onComplete={onComplete} onSignOut={onSignOut} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onSignOut };
}

async function goToStep2(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Select Kin');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Choose KinCare Duration');
}

/** #541/#543: a duration card ADDS a KinCare; tapping it twice asks for two. */
async function addKinCare(user: ReturnType<typeof userEvent.setup>, serviceName: string) {
  await user.click(screen.getByRole('button', { name: `Add ${serviceName}` }));
}

async function selectServiceAndGoToStep3(user: ReturnType<typeof userEvent.setup>, serviceName: string) {
  await goToStep2(user);
  await addKinCare(user, serviceName);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Schedule Dates' });
}

/** Sets the time of the `n`-th KinCare (1-based), which is how step 3 labels them. */
async function setKinCareTime(
  user: ReturnType<typeof userEvent.setup>,
  n: number,
  serviceName: string,
  time: string,
) {
  const input = screen.getByLabelText(`${n}. ${serviceName}`);
  await user.clear(input);
  await user.type(input, time);
}

/**
 * Step 3 -> Review. #545: step 4 is Extra Love & Context; the Invoice Options
 * card that used to sit here is deleted, and `hasInvoiceOptions` below is the
 * assertion that keeps it deleted.
 */
async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 4
  await screen.findByRole('heading', { name: 'Extra Love & Context' });
  await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 5
  await screen.findByRole('heading', { name: 'Review & Confirm' });
}

beforeEach(() => {
  getMyKin.mockReset();
  getServiceCatalog.mockReset();
  requestBooking.mockReset();
  getBusinessClosures.mockReset();
  getBookingPolicy.mockReset();
  // Default: the pre-time-block world. Every existing test picks clock times
  // exactly as it did before, and the tests that care set their own policy.
  getBookingPolicy.mockResolvedValue(CLOCK_ONLY_POLICY);
  getMyKin.mockResolvedValue({ kin: [kin({ id: 'k1', name: 'Buddy' }), kin({ id: 'k2', name: 'Willow', species: 'cat' })] });
  getServiceCatalog.mockResolvedValue({ services: [SERVICE_A, SERVICE_B] });
  requestBooking.mockResolvedValue({ batchId: 'batch-1', bookingIds: ['batch-1'], bookingId: 'batch-1' });
  // Default: nothing closed, so every pre-existing test's dates stay pickable
  // exactly as before C1. Tests that care about a closure set their own fixture.
  getBusinessClosures.mockResolvedValue({ closures: [] });
});

describe('BookingWizard: service catalog', () => {
  it('renders every catalog service, grouped by category, with a price label', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);

    expect(screen.getByText('Daily Visit')).toBeInTheDocument();
    expect(screen.getByText('Overnight Stays')).toBeInTheDocument();
    expect(screen.getByText('Held Down at Home')).toBeInTheDocument();
    expect(screen.getByText('$150.00 / NIGHT')).toBeInTheDocument();
  });

  it('requires a KinCare before Next is enabled on step 2', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await addKinCare(user, 'Daily Visit');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});

/**
 * #541 + #543. The grid used to be a radiogroup, so a second duration silently
 * replaced the first, and two KinCares in one day were unreachable entirely.
 */
describe('BookingWizard: #541/#543 more than one KinCare', () => {
  it('keeps both durations when two different ones are added', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Overnight Stays');
    expect(screen.getByRole('button', { name: 'Remove Daily Visit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Overnight Stays' })).toBeInTheDocument();
  });

  it('adds a second KinCare of the same duration when its card is tapped twice', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Daily Visit');
    expect(screen.getAllByRole('button', { name: 'Remove Daily Visit' })).toHaveLength(2);
    expect(screen.getByText('1. Daily Visit')).toBeInTheDocument();
    expect(screen.getByText('2. Daily Visit')).toBeInTheDocument();
  });

  it('removes only the KinCare that was removed, leaving its twin behind', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Daily Visit');
    await user.click(screen.getAllByRole('button', { name: 'Remove Daily Visit' })[0]!);
    expect(screen.getAllByRole('button', { name: 'Remove Daily Visit' })).toHaveLength(1);
  });

  /** #543: two KinCares on ONE day, submitted as two visits at two times. */
  it('submits two visits on a single date, one per KinCare, at their own times', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Daily Visit');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });

    await pickDay(user, TOMORROW);
    await setKinCareTime(user, 1, 'Daily Visit', '08:00');
    await setKinCareTime(user, 2, 'Daily Visit', '17:30');

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits).toHaveLength(2);
    expect(req.visits!.map((v) => v.startTimeMs)).toEqual([visitMs(TOMORROW, 8, 0), visitMs(TOMORROW, 17, 30)]);
    expect(req.visits!.every((v) => v.serviceId === 's1')).toBe(true);
  });

  /** #541: two DIFFERENT durations, both submitted, on every chosen date. */
  it('submits one visit per date per duration when two durations are chosen', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Overnight Stays');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });

    await pickDay(user, TOMORROW);
    await setKinCareTime(user, 1, 'Daily Visit', '09:00');
    await setKinCareTime(user, 2, 'Overnight Stays', '20:00');

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits).toHaveLength(2);
    expect(req.visits!.map((v) => v.serviceId)).toEqual(['s1', 's2']);
  });

  it('refuses to advance when two KinCares share a duration AND a time, saying which fix is needed', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Daily Visit');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });

    await pickDay(user, TOMORROW);
    // Both default to 09:00, which is one KinCare asked for twice.
    expect(
      await screen.findByText('Two KinCares have the same duration at the same time. Change one of the times.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await setKinCareTime(user, 2, 'Daily Visit', '17:00');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  });
});

/**
 * #545: kinfolk should never see the invoice options screen.
 *
 * Deleted, not hidden: no step renders it, and the route exposes no step
 * parameter for a URL to reach it with (see router.test.tsx).
 */
describe('BookingWizard: #545 no invoice options', () => {
  it('never shows Invoice Options on any step of a full run', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TOMORROW);
    expect(screen.queryByText('Invoice Options')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Extra Love & Context' })).toBeInTheDocument();
    expect(screen.queryByText('Invoice Options')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review & Confirm' });
    expect(screen.queryByText('Invoice Options')).not.toBeInTheDocument();
  });

  it('takes the note on step 4 and submits it, so nothing was lost with the invoice card', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TOMORROW);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Extra Love & Context' });
    await user.type(screen.getByLabelText('Extra Love & Context'), 'Gate sticks.');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review & Confirm' });
    // Review reads the note back rather than offering a second place to type it.
    expect(screen.getByText('Gate sticks.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    expect(requestBooking.mock.calls[0]![0].notes).toBe('Gate sticks.');
  });
});

/**
 * #546 + #547: the estimate is derived from the plan, so it moves when the
 * plan moves. On the walk that filed #546 it read $25.00 next to three visits.
 */
describe('BookingWizard: #546/#547 the estimate follows the plan', () => {
  it('multiplies by the dates: 3 visits of a $42.00 KinCare estimate at $126.00', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const day2 = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 2);
    const day3 = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 3);
    await pickDay(user, TOMORROW);
    expect(await screen.findByText('$42.00')).toBeInTheDocument();
    await pickDay(user, day2);
    expect(await screen.findByText('$84.00')).toBeInTheDocument();
    await pickDay(user, day3);
    expect(await screen.findByText('$126.00')).toBeInTheDocument();
    // ...and back down when a date is taken away again.
    await pickDay(user, day3);
    expect(await screen.findByText('$84.00')).toBeInTheDocument();
  });

  it('counts both KinCares of a two-KinCare day', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Overnight Stays');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });

    await pickDay(user, TOMORROW);
    await setKinCareTime(user, 2, 'Overnight Stays', '20:00');
    // $42.00 + $150.00 on one day.
    expect(await screen.findByText('$192.00')).toBeInTheDocument();
  });

  it('shows an em dash, not a price, before any date is chosen', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$42.00')).not.toBeInTheDocument();
  });

  /** #547: "Pattern = Dates. Actually display those dates." */
  it('enumerates the chosen dates on Review, in the spec spelling, and prices them', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TOMORROW);
    await setKinCareTime(user, 1, 'Daily Visit', '09:00');
    await goToReview(user);

    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(TOMORROW);
    const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(TOMORROW);
    expect(screen.getByText(`${weekday}, ${date} at 9:00 AM`)).toBeInTheDocument();
    expect(screen.getByText('$42.00')).toBeInTheDocument();
  });

  /**
   * #547's third complaint: Review & Confirm and the Booking Summary rail were
   * on screen together, saying the same things twice.
   */
  it('stands the summary rail down on Review, and shows it on every earlier step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    expect(screen.getByText('Booking summary')).toBeInTheDocument();
    await pickDay(user, TOMORROW);
    await goToReview(user);
    expect(screen.queryByText('Booking summary')).not.toBeInTheDocument();
  });
});

/**
 * #540: step 1 used to sit next to a read-only "Booking for" card in the
 * rail that listed the same Kin -- two boxes, one choice. The card is gone;
 * these pin that it is gone AND that what only it used to show (each Kin's
 * breed/species and age) survived the move into step 1.
 */
describe('BookingWizard: #540 one Kin box', () => {
  it('has no second read-only Kin panel beside Select Kin', async () => {
    renderWizard();
    await screen.findByText('Select Kin');
    expect(screen.queryByText('Booking for')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick which Kin to include in step 1.')).not.toBeInTheDocument();
  });

  it('still names every Kin with its breed and age, once', async () => {
    getMyKin.mockResolvedValue({
      kin: [kin({ id: 'k1', name: 'Buddy', breed: 'Labrador Retriever', ageYears: 4 })],
    });
    renderWizard();
    await screen.findByText('Select Kin');
    expect(screen.getAllByText('Buddy')).toHaveLength(1);
    expect(screen.getByText('LABRADOR RETRIEVER • 4 YRS')).toBeInTheDocument();
  });

  it('shows the same detail on the pickable rows once specific Kin are being chosen', async () => {
    getMyKin.mockResolvedValue({
      kin: [kin({ id: 'k1', name: 'Buddy', breed: 'Labrador Retriever', ageYears: 4 })],
    });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText('Select Kin');
    await user.click(screen.getByRole('button', { name: /Choose specific Kin/ }));
    // Exactly one detail row per Kin: the read-only roster is not printed
    // alongside the pickable list, which would rebuild the duplication #540
    // is about.
    expect(screen.getAllByText('LABRADOR RETRIEVER • 4 YRS')).toHaveLength(1);
  });
});

/**
 * #542: "my services are by time not activity". The kinfolk-facing word for
 * step 2 is KinCare Duration everywhere it is printed. Backend field names
 * (`serviceId`, `serviceName`, the `services` catalog) are untouched, and
 * the payload assertions elsewhere in this file are what hold that line.
 */
describe('BookingWizard: #542 KinCare Duration wording', () => {
  it('labels the step and the heading as KinCare Duration', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText('Select Kin');
    // Stepper label, before anything is chosen. (The summary rail's own row is
    // "KinCare" since #541/#543 made it a list rather than one duration.)
    expect(screen.getByText('KinCare Duration')).toBeInTheDocument();
    expect(screen.queryByText('Service')).not.toBeInTheDocument();

    await goToStep2(user);
    // A group, not a radiogroup: #541 made this a multi-add control.
    expect(screen.getByRole('group', { name: 'KinCare Duration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose KinCare Duration' })).toBeInTheDocument();
    expect(screen.queryByText('Choose Service')).not.toBeInTheDocument();
  });

  it('carries the wording through step 3 and the review summary', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    expect(screen.getByText('1. Daily Visit')).toBeInTheDocument();

    await pickDay(user, TOMORROW);
    await goToReview(user);
    expect(screen.queryByText('Service')).not.toBeInTheDocument();
    expect(screen.getAllByText('KinCare').length).toBeGreaterThanOrEqual(1);
  });
});

describe('BookingWizard: individual pattern', () => {
  /**
   * #544: the picker was frozen on the current month with no way out, so
   * "book ahead" was impossible -- late in a month a household had a handful
   * of days left in the entire portal.
   */
  it('books a date in a future month', async () => {
    const nextMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 10);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    await user.click(dayCell(nextMonth));

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits).toHaveLength(1);
    expect(dateKey(new Date(req.visits![0]!.startTimeMs))).toBe(dateKey(nextMonth));
  });

  it('will not offer a date before today', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    if (TODAY.getDate() > 1) {
      const yesterday = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 1);
      expect(dayCell(yesterday)).toBeDisabled();
    }
    expect(dayCell(TODAY)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  });


  it('submits exactly the tapped dates as visits, at the chosen time, for the chosen service', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    // Individual is the default pattern; tap two future days.
    await pickDay(user, TOMORROW);
    await pickDay(user, DAY_AFTER);

    await setKinCareTime(user, 1, 'Daily Visit', '10:15');

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.pattern).toBe('individual');
    expect(req.weeklyDays).toBeUndefined();
    expect(req.visits).toHaveLength(2);

    const expected = [visitMs(TOMORROW, 10, 15), visitMs(DAY_AFTER, 10, 15)];
    expect(req.visits!.map((v) => v.startTimeMs).sort()).toEqual(expected.sort());
    expect(req.visits!.every((v) => v.serviceId === 's1')).toBe(true);
  });
});

/**
 * C1: company holidays were stored (PR #150) but read by nothing anywhere in
 * this codebase, including here -- the portal's month picker offered every
 * date with no notion of "closed" at all. `getBusinessClosures` is the new
 * seam (portal cannot read `business_settings` directly), and
 * `requestBooking` itself refuses a closed date server-side regardless of
 * what this UI does; these pin the CLIENT half, that a household is not
 * OFFERED a doomed date in the first place.
 */
describe('BookingWizard: C1 company holidays', () => {
  it('a bookable date is disabled and cannot be selected when it is a closure', async () => {
    getBusinessClosures.mockResolvedValue({ closures: [{ date: dateKey(TODAY), name: 'Owner away' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const closedButton = dayCell(TODAY);
    await vi.waitFor(() => expect(closedButton).toBeDisabled());

    await user.click(closedButton).catch(() => undefined); // userEvent refuses a disabled target; ignore
    expect(closedButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('an open date next to a closed one is still selectable', async () => {
    getBusinessClosures.mockResolvedValue({ closures: [{ date: dateKey(TODAY), name: 'Owner away' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await vi.waitFor(() => expect(dayCell(TODAY)).toBeDisabled());
    await pickDay(user, TOMORROW);
    expect(dayCell(TOMORROW)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  /**
   * #544 + C1 together: the single closure window the wizard resolves spans
   * the whole horizon, so a closure three months out is already marked the
   * moment that month is paged to -- no second read, no unmarked month.
   */
  it('marks a closure in a month reached by paging forward', async () => {
    const twoMonthsOut = new Date(TODAY.getFullYear(), TODAY.getMonth() + 2, 15);
    getBusinessClosures.mockResolvedValue({ closures: [{ date: dateKey(twoMonthsOut), name: 'Staff retreat' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    await vi.waitFor(() => expect(dayCell(twoMonthsOut)).toBeDisabled());
    expect(dayCell(twoMonthsOut)).toHaveAttribute('title', 'Closed: Staff retreat');
  });

  it('asks the server for a window wide enough to answer every reachable month', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await vi.waitFor(() => expect(getBusinessClosures).toHaveBeenCalled());
    const { fromDate, toDate } = getBusinessClosures.mock.calls[0]![0];
    expect(fromDate).toBe(dateKey(TODAY));
    expect(toDate).toBe(dateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 120)));
  });

  it('a weekly-generated visit landing on a closure is refused, naming the date, before Next is allowed', async () => {
    // PICK THE CLOSURE RELATIVE TO TODAY, NOT TO THE FIRST OF THE MONTH.
    // `monthPickerDays` counts 28 days from the 1st, so `days[1]` is always the
    // 2nd of the month. That is a future date only while today IS the 1st: on
    // 2026-08-02 it resolved to today, the weekly pattern never generated it
    // (generation starts after today), and the assertion below looked for a
    // date the screen had no reason to print. Main went red at midnight for
    // that reason and for no other. The old comment reasoned carefully about
    // WEEKDAY coverage and not at all about day-of-month.
    //
    // Seven days out is generated by any weekday selection over a 4 week span,
    // and is always in the future whatever today is.
    const today = new Date();
    const closure = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
    const closedDate = dateKey(closure);
    getBusinessClosures.mockResolvedValue({ closures: [{ date: closedDate, name: 'Staff retreat' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await user.click(screen.getByRole('radio', { name: 'Repeating Schedule' }));
    // Every weekday, so the closure date is guaranteed to be hit regardless
    // of which weekday the closure itself falls on.
    for (const label of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      await user.click(screen.getByRole('button', { name: label }));
    }
    await user.click(screen.getByRole('button', { name: '4' })); // 4 weeks

    await screen.findByText(new RegExp(closedDate));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('BookingWizard: weekly pattern (F35/F36 regression)', () => {
  async function switchToWeeklyAndConfigure(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: 'Repeating Schedule' }));
    await user.click(screen.getByRole('button', { name: 'Mon' }));
    await user.click(screen.getByRole('button', { name: 'Wed' }));
    await user.click(screen.getByRole('button', { name: '4' }));
  }

  it('submits exactly the count shown in the Step 3 preview, so preview and submit never drift', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await switchToWeeklyAndConfigure(user);

    const previewText = (await screen.findByText(/visit\(s\) over 4 weeks/)).textContent ?? '';
    const shownCount = Number(/^(\d+) visit/.exec(previewText)?.[1]);
    expect(Number.isNaN(shownCount)).toBe(false);
    expect(shownCount).toBeGreaterThan(0);

    await goToReview(user);

    // Review must show the SAME count as Step 3's preview.
    const reviewVisitsRow = (await screen.findAllByText(/visits?$/)).find((el) => /^\d+ visits?$/.test(el.textContent ?? ''));
    expect(reviewVisitsRow?.textContent).toBe(shownCount === 1 ? '1 visit' : `${shownCount} visits`);

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));

    const req = requestBooking.mock.calls[0]![0];
    expect(req.pattern).toBe('weekly');
    expect(req.weeklyDays).toEqual([1, 3]);
    // This is the actual regression check: the submitted visit count must
    // equal the count the kinfolk was shown on Step 3, not a separately
    // re-derived number.
    expect(req.visits).toHaveLength(shownCount);
  });

  it('caps at MAX_RECURRING_VISITS with a visible warning instead of silently truncating', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await user.click(screen.getByRole('radio', { name: 'Repeating Schedule' }));
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      await user.click(screen.getByRole('button', { name: day }));
    }
    await user.click(screen.getByRole('button', { name: '8' })); // 7 days x 8 weeks = 56 potential, way over the cap.

    const warning = await screen.findByText(/more than we can book at once/);
    expect(warning.textContent).toContain(String(MAX_RECURRING_VISITS));

    await goToReview(user);
    expect(screen.getByText(new RegExp(`Capped at ${MAX_RECURRING_VISITS} visits`))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    // Never silently drop past the cap: exactly MAX_RECURRING_VISITS, not the
    // 56 potentially-requested occurrences.
    expect(req.visits).toHaveLength(MAX_RECURRING_VISITS);
  });
});

describe('BookingWizard: submit error handling', () => {
  it('surfaces a failed submit on the Review step instead of swallowing it', async () => {
    requestBooking.mockRejectedValue(new Error('Could not create booking. Try again.'));
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWizard(onComplete);
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    await pickDay(user, TOMORROW);

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await screen.findByText('Could not create booking. Try again.');
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/**
 * Time-block booking in the wizard. Operator requirement 2026-08-24: "kinfolk
 * book within time blocks, not at a specific set time. I need to be able to
 * create these time blocks and those are what the kinfolk should be able to
 * select from when booking."
 *
 * The three switches on `business_settings` decide what step 3 offers, and
 * every one of the four combinations is pinned here — including the one where
 * a household must never see a free time field at all.
 */
describe('BookingWizard: time-block booking', () => {
  it('block only: the KinCare gets a block picker and no time field anywhere', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const control = await screen.findByLabelText('1. Daily Visit');
    expect(control.tagName).toBe('SELECT');
    // No free time picker survives anywhere on the step.
    expect(document.querySelectorAll('input[type="time"]')).toHaveLength(0);
    // And no mode toggle: there is nothing to choose between.
    expect(screen.queryByRole('radio', { name: 'A Specific Time' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Time Blocks' })).toBeInTheDocument();
  });

  it('offers the business blocks by name and hours, and defaults to the first', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const select = (await screen.findByLabelText('1. Daily Visit')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Midday (11:00 – 15:00)',
      'Evening (17:00 – 21:00)',
    ]);
    // A fresh KinCare lands in the first window rather than on "choose one".
    expect(select.value).toBe('midday');
  });

  it('sends the chosen block and its start time to requestBooking', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TOMORROW);
    await user.selectOptions(await screen.findByLabelText('1. Daily Visit'), 'evening');

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits).toHaveLength(1);
    expect(req.visits![0]!.timeBlockId).toBe('evening');
    expect(req.visits![0]!.startTimeMs).toBe(visitMs(TOMORROW, 17, 0));
    // The block says WHEN. The KinCare still says what it costs.
    expect(req.visits![0]!.serviceId).toBe('s1');
    expect(req.visits![0]!.priceCents).toBe(4200);
  });

  it('names the block on Review instead of a clock time the household never gave', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TOMORROW);
    await goToReview(user);

    expect(screen.getByText(/· Midday \(11:00 – 15:00\)/)).toBeInTheDocument();
  });

  it('two KinCares in one block are two visits, not a duplicate', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Overnight Stays');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });
    await pickDay(user, TOMORROW);

    // Both default into Midday, and both are sendable.
    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits).toHaveLength(2);
    expect(req.visits!.every((v) => v.timeBlockId === 'midday')).toBe(true);
  });

  it('refuses the SAME KinCare in the same block twice, in block words', async () => {
    getBookingPolicy.mockResolvedValue(BLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    await addKinCare(user, 'Daily Visit');
    await addKinCare(user, 'Daily Visit');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Schedule Dates' });
    await pickDay(user, TOMORROW);

    expect(
      await screen.findByText(
        'Two KinCares are the same duration in the same time block. Remove one, or move it to another block.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    // Moving one to the other window is what unblocks it.
    await user.selectOptions(screen.getByLabelText('2. Daily Visit'), 'evening');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  });

  it('both modes: opens on defaultBookingMode and the household can switch', async () => {
    getBookingPolicy.mockResolvedValue(BOTH_MODES_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    // defaultBookingMode is TIME_BLOCK.
    expect(((await screen.findByLabelText('1. Daily Visit')) as HTMLElement).tagName).toBe('SELECT');
    await user.click(screen.getByRole('radio', { name: 'A Specific Time' }));
    await vi.waitFor(() => expect(screen.getByLabelText('1. Daily Visit')).toHaveAttribute('type', 'time'));
    await user.click(screen.getByRole('radio', { name: 'Time Blocks' }));
    await vi.waitFor(() => expect(screen.getByLabelText('1. Daily Visit').tagName).toBe('SELECT'));
  });

  it('both modes: switching back to specific time sends a clock visit with no block', async () => {
    getBookingPolicy.mockResolvedValue(BOTH_MODES_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await user.click(screen.getByRole('radio', { name: 'A Specific Time' }));
    await pickDay(user, TOMORROW);
    await setKinCareTime(user, 1, 'Daily Visit', '10:15');

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.visits![0]!.timeBlockId).toBeNull();
    expect(req.visits![0]!.startTimeMs).toBe(visitMs(TOMORROW, 10, 15));
  });

  it('specific only: today’s behaviour, no block picker and no mode toggle', async () => {
    getBookingPolicy.mockResolvedValue(CLOCK_ONLY_POLICY);
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    expect(await screen.findByLabelText('1. Daily Visit')).toHaveAttribute('type', 'time');
    expect(screen.queryByRole('radio', { name: 'Time Blocks' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Visit Times' })).toBeInTheDocument();
  });

  it('a failed policy read leaves the wizard usable on clock times', async () => {
    getBookingPolicy.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    expect(await screen.findByLabelText('1. Daily Visit')).toHaveAttribute('type', 'time');
    await pickDay(user, TOMORROW);
    await goToReview(user);
    expect(screen.getByRole('button', { name: 'Create Booking' })).toBeEnabled();
  });

  /**
   * A block offers ONE start time, so once today's window has opened there is
   * no control left for the household to nudge — the wizard has to say so
   * rather than let the whole request come back refused.
   */
  it('blocks a plan whose visit has already started, and says which control to use', async () => {
    getBookingPolicy.mockResolvedValue({
      ...BLOCK_ONLY_POLICY,
      // A window that opened at the very start of today, so this holds at any
      // hour the suite runs at.
      timeBlocks: [{ id: 'early', label: 'Early', startTime: '00:00', endTime: '23:59', durationMinutes: 1439 }],
    });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');
    await pickDay(user, TODAY);

    expect(await screen.findByText(/has\s+already\s+started/)).toBeInTheDocument();
    expect(screen.getByText(/Pick a later block/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
