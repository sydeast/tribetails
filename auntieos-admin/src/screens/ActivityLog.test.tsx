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

const OK: VerifyResult = { ok: true, scanned: 40, firstSeq: 1, lastSeq: 40, unchainedCount: 3 };

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<ActivityLogEntry[]>);
  verifyActivityLogChain.mockReset().mockResolvedValue(OK);
});

describe('ActivityLog', () => {
  it('renders streamed rows with seq · hash, actor context, grouped by day', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    expect(screen.getByText('2026-07-16')).toBeInTheDocument();
    expect(screen.getByText('#12 · deadbeef')).toBeInTheDocument();
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(screen.getByText(/by u1/)).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'insufficient permissions' });
    render(<ActivityLog />);
    expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument();
  });

  it('auto-verifies on mount and shows a VERIFIED verdict with the seq range', async () => {
    render(<ActivityLog />);
    expect(await screen.findByText(/chain verified/i)).toBeInTheDocument();
    expect(screen.getByText(/seq 1\.\.40/)).toBeInTheDocument();
    expect(verifyActivityLogChain).toHaveBeenCalledOnce();
  });

  it('renders a seq_gap anomaly with the expected/entry detail', async () => {
    verifyActivityLogChain.mockResolvedValue({
      ok: false, scanned: 10, anomaly: { code: 'seq_gap', entryId: 'bad1', seq: 7, expectedSeq: 6 },
    } satisfies VerifyResult);
    render(<ActivityLog />);
    expect(await screen.findByText(/chain broken/i)).toBeInTheDocument();
    expect(screen.getByText(/gap at #7 \(expected 6\).*bad1/)).toBeInTheDocument();
  });

  it('renders a head_mismatch anomaly (no entryId/seq) without printing undefined', async () => {
    verifyActivityLogChain.mockResolvedValue({
      ok: false, scanned: 88,
      anomaly: { code: 'head_mismatch', headLastHash: 'aaa', observedLastHash: 'bbb', headSeq: 88, observedSeq: 87 },
    } satisfies VerifyResult);
    render(<ActivityLog />);
    expect(await screen.findByText(/head mismatch/i)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('fails loud if the verify call rejects', async () => {
    verifyActivityLogChain.mockRejectedValue(new Error('deadline-exceeded'));
    render(<ActivityLog />);
    await waitFor(() => expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument());
  });

  it('re-verifies on demand', async () => {
    render(<ActivityLog />);
    await screen.findByText(/chain verified/i);
    await userEvent.click(screen.getByRole('button', { name: /re-verify/i }));
    await waitFor(() => expect(verifyActivityLogChain).toHaveBeenCalledTimes(2));
  });
});
