// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ActivityLogEntry, type VerifyResult } from '../api/activityLog';

const { useCollection, verifyActivityLogChain } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  verifyActivityLogChain: vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useCollection }));
vi.mock('../api/activityLog', async (orig) => ({
  ...(await orig<typeof import('../api/activityLog')>()),
  verifyActivityLogChain,
}));

import { ActivityLog } from './ActivityLog';

function entry(over: Partial<ActivityLogEntry>): ActivityLogEntry {
  return {
    _id: 'e1', timestamp: '2026-07-16T09:30:00Z', actionType: 'LOGIN', description: 'signed in',
    status: 'SUCCESS', actorId: 'u1', targetId: '', targetCollection: '', seq: 12,
    prevHash: '', entryHash: 'deadbeefcafe', ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset();
  verifyActivityLogChain.mockReset();
});

describe('ActivityLog', () => {
  it('renders streamed rows with seq · hash and groups by day', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] } satisfies Async<ActivityLogEntry[]>);
    render(<ActivityLog />);
    expect(screen.getByText('2026-07-16')).toBeInTheDocument();
    expect(screen.getByText('#12 · deadbeef')).toBeInTheDocument();
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'insufficient permissions' });
    render(<ActivityLog />);
    expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument();
  });

  it('shows a VERIFIED verdict with the seq range on a good chain', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    verifyActivityLogChain.mockResolvedValue({
      ok: true, scanned: 40, firstSeq: 1, lastSeq: 40, unchainedCount: 3,
    } satisfies VerifyResult);
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /verify chain/i }));
    expect(await screen.findByText(/chain verified/i)).toBeInTheDocument();
    expect(screen.getByText(/seq 1\.\.40/)).toBeInTheDocument();
  });

  it('shows the first break on a broken chain', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    verifyActivityLogChain.mockResolvedValue({
      ok: false, scanned: 10, anomaly: { code: 'seq_gap', entryId: 'bad1', seq: 7, expectedSeq: 6 },
    } satisfies VerifyResult);
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /verify chain/i }));
    expect(await screen.findByText(/chain broken/i)).toBeInTheDocument();
    expect(screen.getByText(/seq_gap/)).toBeInTheDocument();
  });

  it('fails loud if the verify call rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    verifyActivityLogChain.mockRejectedValue(new Error('deadline-exceeded'));
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /verify chain/i }));
    await waitFor(() => expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument());
  });
});
