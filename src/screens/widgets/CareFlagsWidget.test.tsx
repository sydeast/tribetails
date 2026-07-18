// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Async } from '../../lib/async';
import type { SessionEntry } from '../../api/sessions';
import type { KinCareRow } from '../../api/kinCare';
import { localDateIso } from '../../lib/invoiceFormat';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../../lib/firestore', () => ({ useCollection }));

import { CareFlagsWidget } from './CareFlagsWidget';

// A no-offset local noon today, so its LOCAL day-key equals today's local date
// regardless of the test machine's timezone.
const TODAY_START = `${localDateIso(new Date())}T12:00:00`;

function sess(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 's1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    kinIds: ['p1'],
    serviceType: 'Drop-in',
    startTime: TODAY_START,
    arrivedAt: '',
    endTime: '',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

function kinRow(over: Partial<KinCareRow> = {}): KinCareRow {
  return { _id: 'p1', kinfolkId: 'k1', name: 'Biscuit', ...over };
}

/** Route the two useCollection calls by collection path. */
function wire(kin: Async<KinCareRow[]>, sessions: Async<SessionEntry[]>): void {
  useCollection.mockImplementation((spec: { path: string }) =>
    spec.path === 'kin' ? kin : sessions,
  );
}

beforeEach(() => {
  useCollection.mockReset();
});

describe('CareFlagsWidget', () => {
  it('surfaces the care flags for today, joining sessions to kin', async () => {
    wire(
      { status: 'ready', data: [kinRow({ reactive: true, medicationHealthNotes: 'Insulin 2x' })] },
      { status: 'ready', data: [sess()] },
    );
    render(<CareFlagsWidget />);

    expect(await screen.findByText('Reactive, handle with care')).toBeInTheDocument();
    expect(screen.getByText('Insulin 2x')).toBeInTheDocument();
    // One "Biscuit" per flag row (reactive + medication here).
    expect(screen.getAllByText('Biscuit').length).toBeGreaterThan(0);
  });

  it('shows the calm empty state when nothing needs minding today', () => {
    wire({ status: 'ready', data: [kinRow()] }, { status: 'ready', data: [sess()] });
    render(<CareFlagsWidget />);
    expect(screen.getByText(/no special care notes/i)).toBeInTheDocument();
  });

  it('fails loud (never a false all-clear) when the kin stream errors', () => {
    wire({ status: 'error', message: 'permission-denied' }, { status: 'ready', data: [sess()] });
    render(<CareFlagsWidget />);
    expect(screen.queryByText(/no special care notes/i)).not.toBeInTheDocument();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('fails loud when the sessions stream errors', () => {
    wire({ status: 'ready', data: [kinRow({ reactive: true })] }, { status: 'error', message: 'deadline-exceeded' });
    render(<CareFlagsWidget />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
  });
});
