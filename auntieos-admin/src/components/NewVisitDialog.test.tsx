// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createKinCareSession } = vi.hoisted(() => ({ createKinCareSession: vi.fn() }));
vi.mock('../api/scheduleWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/scheduleWrite')>('../api/scheduleWrite');
  return { ...actual, createKinCareSession };
});

import { NewVisitDialog } from './NewVisitDialog';

const onClose = vi.fn();
const onCreated = vi.fn();
const user = userEvent.setup();

/** The operator's real catalog shape: a name -> dollars-as-string map. */
const SERVICE_RATES = { '30Minute': '25', 'Half-Day 6Hrs': '100', Consultation: '' };

beforeEach(() => {
  createKinCareSession.mockReset().mockResolvedValue({ ok: true, sessionId: 'sess-9' });
  onClose.mockReset();
  onCreated.mockReset();
});

function open(over: Partial<Parameters<typeof NewVisitDialog>[0]> = {}) {
  render(
    <NewVisitDialog
      households={[
        { id: 'kf1', label: 'Ada Lovelace' },
        { id: 'kf2', label: 'Grace Hopper' },
      ]}
      serviceRates={SERVICE_RATES}
      serviceDurations={{}}
      initialDate="2026-07-16"
      onClose={onClose}
      onCreated={onCreated}
      {...over}
    />,
  );
}

function refusal(code: string, message: string) {
  return Object.assign(new Error(message), { code: 'functions/failed-precondition', details: { code } });
}

async function fillHouseholdAndService(service = '30Minute · $25') {
  await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
  await user.selectOptions(screen.getByLabelText('Service'), screen.getByRole('option', { name: service }));
}

describe('NewVisitDialog', () => {
  /**
   * The service picker is the whole billing chain: a session carries no price,
   * so `listUninvoicedSessions` looks this exact string up in
   * `business_settings.serviceRates`. Free text would come back unpriceable.
   */
  it('offers the operator’s configured KinCare types, shortest first, with their rates', () => {
    open();
    const labels = Array.from(screen.getByLabelText('Service').querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual([
      'Pick a service…',
      '30Minute · $25',
      'Half-Day 6Hrs · $100',
      // A type whose name states no duration sorts last, and a blank rate still
      // lists: an unpriced service must not vanish from the picker.
      'Consultation',
    ]);
  });

  it('says so out loud when nothing is configured, rather than offering a made-up list', () => {
    open({ serviceRates: {} });
    expect(screen.getByText(/No KinCare types are configured yet/)).toBeInTheDocument();
  });

  it('prefills the duration from the picked service, and sends the canonical name', async () => {
    open();
    await fillHouseholdAndService();
    expect(screen.getByLabelText('Minutes')).toHaveValue(30);

    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));
    expect(createKinCareSession.mock.calls[0]![0]).toMatchObject({
      kinfolkId: 'kf1',
      serviceType: '30Minute',
      serviceDurationMinutes: 30,
      // R1: no per-kin picker; the server materializes the whole household.
      kinIds: [],
    });
  });

  it('an operator-stated duration wins over the one parsed out of the name', async () => {
    open({ serviceDurations: { '30Minute': '45' } });
    await fillHouseholdAndService('30Minute · $25');
    expect(screen.getByLabelText('Minutes')).toHaveValue(45);
  });

  /** A move never resizes a visit, and neither does a create: end = start + duration. */
  it('computes the end from the duration, as UTC-suffixed ISO', async () => {
    open();
    await fillHouseholdAndService('Half-Day 6Hrs · $100');
    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));

    const args = createKinCareSession.mock.calls[0]![0];
    expect(args.startTime).toBe(new Date(2026, 6, 16, 9, 0, 0, 0).toISOString());
    expect(args.endTime).toBe(new Date(2026, 6, 16, 15, 0, 0, 0).toISOString());
    expect(args.serviceDurationMinutes).toBe(360);
    expect(onCreated).toHaveBeenCalledWith('sess-9');
  });

  it('will not submit without a household and a service', async () => {
    open();
    expect(screen.getByRole('button', { name: 'Schedule visit' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.getByRole('button', { name: 'Schedule visit' })).toBeDisabled();
    expect(createKinCareSession).not.toHaveBeenCalled();
  });

  // ── the refusal path ───────────────────────────────────────────────────────

  it('surfaces the server’s sentence when the slot is already occupied', async () => {
    createKinCareSession.mockRejectedValueOnce(
      refusal('visit_overlap_conflict', 'That time is already taken: visit 1 overlaps a visit already booked.'),
    );
    open();
    await fillHouseholdAndService();
    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));

    expect(screen.getByText('Couldn’t schedule the visit')).toBeInTheDocument();
    expect(screen.getByText(/overlaps a visit already booked/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('the override retry carries the flag that matches the refusal, not the other one', async () => {
    createKinCareSession
      .mockRejectedValueOnce(refusal('booking_busy_conflict', 'This time is not available: … busy block …'))
      .mockResolvedValueOnce({ ok: true, sessionId: 'sess-9' });
    open();
    await fillHouseholdAndService();
    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));
    expect(screen.getByText(/imported Google Calendar busy block/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Schedule anyway' }));
    const retry = createKinCareSession.mock.calls[1]![0];
    expect(retry).toMatchObject({ overrideBusyConflict: true });
    expect(retry).not.toHaveProperty('overrideVisitConflict');
  });

  it('a company closure is final: no override is offered', async () => {
    createKinCareSession.mockRejectedValueOnce(
      refusal('company_holiday_conflict', 'This date is not available. The business is closed.'),
    );
    open();
    await fillHouseholdAndService();
    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));

    expect(screen.getByText(/The business is closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule anyway' })).toBeNull();
  });
});
