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
  useCollection.mockReset().mockReturnValue({
    status: 'ready',
    data: [kinfolk(), kinfolk({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' })],
  });
});

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
