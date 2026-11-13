// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { initialWizardState, newSlot, type WizardState } from '../lib/bookingWizard';

/**
 * #2185: the booking wizard's two Settings lines. An Auntie never sees
 * Settings (ruling 2026-11-13), so under her sign-in each one names the owner;
 * the owner keeps the Settings wording word for word.
 */
const { seat } = vi.hoisted(() => ({ seat: { caretaker: false } }));
vi.mock('../lib/sessionSeat', async (orig) => ({
  ...(await orig<typeof import('../lib/sessionSeat')>()),
  currentSessionSeat: async () => ({ uid: 'u1', caretaker: seat.caretaker }),
}));

import { ReviewStep, ServiceStep } from './NewBookingWizardSteps';

beforeEach(() => {
  seat.caretaker = false;
});

function unpricedPlan(): WizardState {
  return {
    ...initialWizardState(),
    plans: [{ dayIso: '2026-12-01', visits: [newSlot({ serviceName: 'Consultation' })] }],
  };
}

function renderReview() {
  render(
    <ReviewStep
      state={unpricedPlan()}
      onChange={vi.fn()}
      options={[]}
      householdLabel="Dre East"
      kinLabels={[]}
      onEditStep={vi.fn()}
    />,
  );
}

describe('#2185 ServiceStep with no KinCare types', () => {
  it('an Auntie is told to ask the owner, and no Settings screen is named', async () => {
    seat.caretaker = true;
    render(<ServiceStep state={initialWizardState()} onChange={vi.fn()} options={[]} optionsError={null} />);
    expect(
      await screen.findByText('No KinCare types yet. Ask the owner to add them, and they show up here.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Settings/)).toBeNull();
  });

  it('the owner keeps the Settings wording', async () => {
    render(<ServiceStep state={initialWizardState()} onChange={vi.fn()} options={[]} optionsError={null} />);
    expect(
      screen.getByText(
        'No KinCare types yet. Add them in Settings, under KinCare types, and they show up here with their prices.',
      ),
    ).toBeInTheDocument();
    // Still the owner's once the sign-in has been read.
    await waitFor(() =>
      expect(screen.getByText(/Add them in Settings, under KinCare types/)).toBeInTheDocument(),
    );
  });
});

describe('#2185 ServiceStep when the KinCare list could not be read', () => {
  const failed = "Couldn't load your KinCare types: Load failed. Type the service name instead.";

  it('an Auntie reads only the load failure, never "No KinCare types yet"', async () => {
    seat.caretaker = true;
    render(<ServiceStep state={initialWizardState()} onChange={vi.fn()} options={[]} optionsError={failed} />);
    // Let the sign-in read land first, so the Auntie branch is the one on screen.
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent(failed);
    expect(screen.queryByText(/No KinCare types yet/)).toBeNull();
    expect(screen.queryByText(/Ask the owner/)).toBeNull();
    expect(screen.getByLabelText('Service')).toBeInTheDocument();
  });

  it('the owner reads only the load failure, and can still type the service', async () => {
    render(<ServiceStep state={initialWizardState()} onChange={vi.fn()} options={[]} optionsError={failed} />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent(failed);
    expect(screen.queryByText(/No KinCare types yet/)).toBeNull();
    expect(screen.getByLabelText('Service')).toBeInTheDocument();
  });
});

describe('#2185 ReviewStep with an unpriced service', () => {
  it("an Auntie's line names the owner, not Settings", async () => {
    seat.caretaker = true;
    renderReview();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Consultation has no price on the rate card, so it is not in this total. Ask the owner to set it.',
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Settings/);
  });

  it("the owner's line keeps Settings", () => {
    renderReview();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Consultation has no price on the rate card, so it is not in this total. Set it in Settings, under KinCare types.',
    );
  });
});
