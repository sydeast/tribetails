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

  it('shows the spinner while verifyActivityLogChain cold-starts (issue #714)', async () => {
    let resolveVerify: (value: VerifyResult) => void = () => {};
    verifyActivityLogChain.mockReset().mockImplementation(
      () => new Promise((resolve) => { resolveVerify = resolve; }),
    );
    render(<ActivityLog />);

    expect(await screen.findByRole('img', { name: 'Verifying…' })).toBeInTheDocument();
    expect(screen.queryByText(/chain verified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/chain broken/i)).not.toBeInTheDocument();

    resolveVerify(OK);

    expect(await screen.findByText(/chain verified/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Verifying…' })).not.toBeInTheDocument();
  });
});
/**
 * R5 on the Activity Log, verbatim: "the Activity Log is seriously lacking, cant
 * see shit or what the fuck actually happened."
 *
 * Every field these tests assert has been on the document since 2026-05-19.
 * `writeAuditEntry` describes them as "retained for forensic value ... surfaced
 * in detail views", and no detail view was ever built, so `payload`, the field
 * where each event type records its specifics, was rendered nowhere in the
 * product at all. Page-spec 22 item 1 has carried "rows aren't clickable / no
 * detail view" as the core complaint since 2026-05-27.
 */
describe('ActivityLog entry detail', () => {
  const delivered = entry({
    _id: 'e2',
    actionType: 'NOTIFICATION_RECEIVED',
    description: 'Notification kincare.booking.confirm delivered via email',
    timestamp: '2026-08-03T14:02:11.482Z',
    targetCollection: 'notifications',
    targetId: 'n1',
    severity: 'info',
    actorRole: 'SYSTEM',
    entryHash: 'a'.repeat(64),
    prevHash: 'b'.repeat(64),
    payload: { notificationId: 'n1', channel: 'email', providerMessageId: 'sg-88' },
  });
  it('rows are closed by default, so the feed still scans', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    expect(screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('What happened')).toBeNull();
  });
  it('opens to show the payload, which is the field that says what happened', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ }));
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('providerMessageId')).toBeInTheDocument();
    expect(screen.getByText('sg-88')).toBeInTheDocument();
    expect(screen.getByText('channel')).toBeInTheDocument();
  });
  it('opens to the FULL timestamp and the provenance the row truncates', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ }));
    expect(screen.getByText('2026-08-03T14:02:11.482Z')).toBeInTheDocument();
    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByText('Actor role')).toBeInTheDocument();
    expect(screen.getByText('notifications/n1')).toBeInTheDocument();
  });
  it('shows the FULL chain hashes, because a truncated hash verifies nothing', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ }));
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
  });
  /**
   * An audit entry with no payload is itself a finding. A section that vanished
   * would read as "this screen has nothing more to show", which is a different
   * and false claim.
   */
  it('says so out loud when an entry was written with no payload', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /LOGIN/ }));
    expect(screen.getByText(/written with no payload/i)).toBeInTheDocument();
  });
  it('names a legacy pre-chain entry as outside verification, rather than faking a seal', async () => {
    const { seq: _dropped, ...legacy } = entry({ _id: 'e3' });
    useCollection.mockReturnValue({ status: 'ready', data: [legacy] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /LOGIN/ }));
    expect(screen.getByText(/before the hash chain/i)).toBeInTheDocument();
  });
  it('keeps two entries open at once, because comparing them is the point', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [delivered, entry({ _id: 'e4', actionType: 'NOTIFICATION_DISPATCHED' })],
    });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ }));
    await userEvent.click(screen.getByRole('button', { name: /NOTIFICATION_DISPATCHED/ }));
    expect(screen.getAllByText('What happened')).toHaveLength(2);
  });
  it('closes again', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    const opener = screen.getByRole('button', { name: /NOTIFICATION_RECEIVED/ });
    await userEvent.click(opener);
    expect(screen.getByText('What happened')).toBeInTheDocument();
    await userEvent.click(opener);
    expect(screen.queryByText('What happened')).toBeNull();
  });
});
describe('ActivityLog filtering', () => {
  const rows = [
    entry({ _id: 'ok', actionType: 'LOGIN', status: 'SUCCESS' }),
    entry({ _id: 'bad', actionType: 'ERROR_FUNCTION_FAILURE', status: 'FAILURE' }),
    entry({ _id: 'legacyfail', actionType: 'OLD_THING', status: 'ERROR' }),
  ];
  it('states how many of how many are shown, rather than leaving the cap to be discovered', () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    expect(screen.getByText(/showing 3 of 3 loaded/i)).toBeInTheDocument();
  });
  it('narrows to problems, folding FAILURE and the legacy ERROR spelling together', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.getByText('ERROR_FUNCTION_FAILURE')).toBeInTheDocument();
    expect(screen.getByText('OLD_THING')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).toBeNull();
    expect(screen.getByText(/showing 2 of 3 loaded/i)).toBeInTheDocument();
  });
  /**
   * The reason the search box is worth having: an operator hunts for an id, and
   * the id lives in the payload, not in the description.
   */
  it('searches inside the payload, where the ids actually are', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'hit', actionType: 'BOOKING_SUBMITTED', payload: { batchId: 'req_991' } }),
        entry({ _id: 'miss', actionType: 'LOGIN' }),
      ],
    });
    render(<ActivityLog />);
    await userEvent.type(screen.getByRole('searchbox'), 'req_991');
    expect(screen.getByText('BOOKING_SUBMITTED')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).toBeNull();
  });
  it('says nothing matches rather than silently falling back to everything', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText(/no entries match this filter/i)).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).toBeNull();
  });
  it('keeps only the active status tab in the tab order, per the roving convention', () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Problems' })).toHaveAttribute('tabindex', '-1');
  });
});
