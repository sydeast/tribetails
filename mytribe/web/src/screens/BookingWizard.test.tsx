// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingWizardBody } from './BookingWizard';
import type { GetServiceCatalogResult, RequestBookingRequest, RequestBookingResult } from '../api/bookingApi';
import type { GetMyKinResult, KinDto } from '../api/types';
import { MAX_RECURRING_VISITS, monthPickerDays } from '../lib/bookingWizardLogic';

const getMyKin = vi.fn<() => Promise<GetMyKinResult>>();
const getServiceCatalog = vi.fn<() => Promise<GetServiceCatalogResult>>();
const requestBooking = vi.fn<(req: RequestBookingRequest) => Promise<RequestBookingResult>>();

vi.mock('../api/portal', () => ({
  getMyKin: () => getMyKin(),
}));
vi.mock('../api/bookingApi', async () => {
  const actual = await vi.importActual<typeof import('../api/bookingApi')>('../api/bookingApi');
  return {
    ...actual,
    getServiceCatalog: () => getServiceCatalog(),
    requestBooking: (req: RequestBookingRequest) => requestBooking(req),
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
  getMyKin.mockResolvedValue({ kin: [kin({ id: 'k1', name: 'Buddy' }), kin({ id: 'k2', name: 'Willow', species: 'cat' })] });
  getServiceCatalog.mockResolvedValue({ services: [SERVICE_A, SERVICE_B] });
  requestBooking.mockResolvedValue({ batchId: 'batch-1', bookingIds: ['batch-1'], bookingId: 'batch-1' });
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
    expect(req.visits.map((v) => v.startTimeMs).sort()).toEqual(expected.sort());
    expect(req.visits.every((v) => v.serviceId === 's1')).toBe(true);
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
