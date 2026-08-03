// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingWizardBody } from './BookingWizard';
import type {
  GetBusinessClosuresRequest,
  GetBusinessClosuresResult,
  GetServiceCatalogResult,
} from '../api/bookingApi';
import type { RequestBookingArgs, RequestBookingResult } from '../contracts/bookingContracts.generated';
import type { GetMyKinResult, KinDto } from '../api/types';
import { dateKey, MAX_RECURRING_VISITS, monthPickerDays } from '../lib/bookingWizardLogic';

const getMyKin = vi.fn<() => Promise<GetMyKinResult>>();
const getServiceCatalog = vi.fn<() => Promise<GetServiceCatalogResult>>();
const requestBooking = vi.fn<(req: RequestBookingArgs) => Promise<RequestBookingResult>>();
const getBusinessClosures = vi.fn<(req: GetBusinessClosuresRequest) => Promise<GetBusinessClosuresResult>>();

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
    aiBlurb: null,
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
  await screen.findByText('Choose Service');
}

async function selectServiceAndGoToStep3(user: ReturnType<typeof userEvent.setup>, serviceName: string) {
  await goToStep2(user);
  await user.click(screen.getByText(serviceName));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Schedule Dates' });
}

beforeEach(() => {
  getMyKin.mockReset();
  getServiceCatalog.mockReset();
  requestBooking.mockReset();
  getBusinessClosures.mockReset();
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

  it('requires a service before Next is enabled on step 2', async () => {
    const user = userEvent.setup();
    renderWizard();
    await goToStep2(user);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByText('Daily Visit'));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});

describe('BookingWizard: individual pattern', () => {
  it('submits exactly the tapped dates as visits, at the chosen time, for the chosen service', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    // Individual is the default pattern; tap the 1st and 3rd offered days.
    const dayButtons = screen.getAllByRole('button', { name: /^\d+$/ });
    await user.click(dayButtons[0]!);
    await user.click(dayButtons[2]!);

    const timeInput = screen.getByLabelText(/Visit Time/i);
    await user.clear(timeInput);
    await user.type(timeInput, '10:15');

    await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 4
    await screen.findByText('Invoice Options');
    await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 5
    await screen.findByRole('heading', { name: 'Review & Confirm' });
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await vi.waitFor(() => expect(requestBooking).toHaveBeenCalledTimes(1));
    const req = requestBooking.mock.calls[0]![0];
    expect(req.pattern).toBe('individual');
    expect(req.weeklyDays).toBeUndefined();
    expect(req.visits).toHaveLength(2);

    const expectedDays = monthPickerDays(new Date());
    const expected = [expectedDays[0]!, expectedDays[2]!].map((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 15).getTime());
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
  it('the first offered date is disabled and cannot be selected when it is a closure', async () => {
    const closedDate = dateKey(monthPickerDays(new Date())[0]!);
    getBusinessClosures.mockResolvedValue({ closures: [{ date: closedDate, name: 'Owner away' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const dayButtons = await screen.findAllByRole('button', { name: /^\d+$/ });
    const closedButton = dayButtons[0]!;
    await vi.waitFor(() => expect(closedButton).toBeDisabled());

    await user.click(closedButton).catch(() => undefined); // userEvent refuses a disabled target; ignore
    expect(closedButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('an open date next to a closed one is still selectable', async () => {
    const days = monthPickerDays(new Date());
    getBusinessClosures.mockResolvedValue({ closures: [{ date: dateKey(days[0]!), name: 'Owner away' }] });
    const user = userEvent.setup();
    renderWizard();
    await selectServiceAndGoToStep3(user, 'Daily Visit');

    const dayButtons = await screen.findAllByRole('button', { name: /^\d+$/ });
    await vi.waitFor(() => expect(dayButtons[0]).toBeDisabled());
    await user.click(dayButtons[1]!);
    expect(dayButtons[1]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
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

    await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 4
    await screen.findByText('Invoice Options');
    await user.click(screen.getByRole('button', { name: 'Next' })); // -> step 5

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

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Invoice Options');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review & Confirm' });
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

    const dayButtons = screen.getAllByRole('button', { name: /^\d+$/ });
    await user.click(dayButtons[0]!);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Invoice Options');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review & Confirm' });
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await screen.findByText('Could not create booking. Try again.');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
