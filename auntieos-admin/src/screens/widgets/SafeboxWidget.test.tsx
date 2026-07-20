// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    expect(await screen.findByText('4417')).toBeInTheDocument();
    expect(screen.getByText('Side door')).toBeInTheDocument();
    expect(screen.getByText('Gate / door code')).toBeInTheDocument();
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
