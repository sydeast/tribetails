// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Async } from '../../lib/async';
import type { SessionEntry } from '../../api/sessions';
import { mergeKinfolkProfile } from '../../api/kinfolkProfile';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../../lib/firestore', () => ({ useCollection }));

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

import { SafeboxWidget } from './SafeboxWidget';

function sess(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 's1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    kinIds: [],
    serviceType: 'Drop-in',
    // Far future so it stays "upcoming" regardless of wall clock at test time.
    startTime: '2090-01-01T09:00:00.000Z',
    arrivedAt: '',
    endTime: '2090-01-01T09:30:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<SessionEntry[]>);
  getKinfolkProfile.mockReset();
});

describe('SafeboxWidget', () => {
  it('shows the next visit household and its access notes', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [sess()] });
    getKinfolkProfile.mockResolvedValue(
      mergeKinfolkProfile('k1', { gateCode: '4417', entryNotes: 'Side door' }),
    );
    render(<SafeboxWidget />);

    expect(await screen.findByText('Gate / door code')).toBeInTheDocument();
    expect(screen.getByText('Side door')).toBeInTheDocument();
  });

  it('masks the gate code and the wifi password until the operator reveals them', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [sess()] });
    getKinfolkProfile.mockResolvedValue(
      mergeKinfolkProfile('k1', { gateCode: '4417', wifiPassword: 'hunter2', entryNotes: 'Side door' }),
    );
    const { container } = render(<SafeboxWidget />);
    await screen.findByText('Gate / door code');

    // The dashboard renders with no household opened, so neither secret may be
    // on screen before a deliberate reveal.
    expect(container.textContent).not.toContain('4417');
    expect(container.textContent).not.toContain('hunter2');

    await userEvent.click(screen.getByRole('button', { name: /show gate \/ door code/i }));
    expect(screen.getByText('4417')).toBeInTheDocument();
    // Revealing one secret must not reveal the other.
    expect(container.textContent).not.toContain('hunter2');

    await userEvent.click(screen.getByRole('button', { name: /show wifi password/i }));
    expect(screen.getByText('hunter2')).toBeInTheDocument();
  });

  it('leaves the low-sensitivity access notes readable at a glance (no toggle)', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [sess()] });
    getKinfolkProfile.mockResolvedValue(
      mergeKinfolkProfile('k1', {
        serviceAddress: '12 Oak St',
        parkingInstructions: 'Driveway',
        // Not the household name, which the widget header already renders.
        wifiName: 'Oakhouse-5G',
      }),
    );
    render(<SafeboxWidget />);

    expect(await screen.findByText('12 Oak St')).toBeInTheDocument();
    expect(screen.getByText('Driveway')).toBeInTheDocument();
    expect(screen.getByText('Oakhouse-5G')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^show /i })).toBeNull();
  });

  it('says so when the next household has no access notes on file', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [sess()] });
    getKinfolkProfile.mockResolvedValue(mergeKinfolkProfile('k1', {}));
    render(<SafeboxWidget />);
    expect(await screen.findByText(/no access notes on file/i)).toBeInTheDocument();
  });

  it('shows the empty state when there are no upcoming visits', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<SafeboxWidget />);
    expect(screen.getByText(/no upcoming visits/i)).toBeInTheDocument();
    expect(getKinfolkProfile).not.toHaveBeenCalled();
  });

  it('fails loud (names the callable) when the household load rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [sess()] });
    getKinfolkProfile.mockRejectedValue(new Error('permission-denied'));
    render(<SafeboxWidget />);
    expect(
      await screen.findByText(/getKinfolkProfile:k1 failed:.*permission-denied/i),
    ).toBeInTheDocument();
  });

  it('fails loud when the visits stream errors (never a false empty)', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded' });
    render(<SafeboxWidget />);
    expect(screen.queryByText(/no upcoming visits/i)).not.toBeInTheDocument();
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
  });
});
