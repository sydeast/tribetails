// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ActivityLogEntry, type VerifyResult } from '../api/activityLog';

const { useCollection, verifyActivityLogChain, getBusinessSettings } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  verifyActivityLogChain: vi.fn(),
  getBusinessSettings: vi.fn(),
}));
vi.mock('../api/settings', () => ({ getBusinessSettings }));
vi.mock('../lib/firestore', () => ({ useCollection }));
vi.mock('../api/activityLog', async (orig) => ({
  ...(await orig<typeof import('../api/activityLog')>()),
  verifyActivityLogChain,
}));
// #1592: the shared staff-name read (`listStaff`), stubbed so no test dials it.
const { staffNames, staffRoles } = vi.hoisted(() => ({
  staffNames: { current: new Map<string, string>() as ReadonlyMap<string, string> },
  staffRoles: { current: new Map<string, 'owner' | 'auntie'>() as ReadonlyMap<string, 'owner' | 'auntie'> },
}));
vi.mock('../lib/useStaffNames', () => ({
  useStaffNames: () => staffNames.current,
  useStaffRoles: () => staffRoles.current,
}));

import { ActivityLog } from './ActivityLog';
import { businessTodayIso } from '../lib/businessZoneTime';

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
  getBusinessSettings.mockReset().mockResolvedValue({ timeZone: '' });
  staffNames.current = new Map();
  staffRoles.current = new Map();
});

describe('ActivityLog actor names (#1592)', () => {
  it('names the actor instead of printing the uid, and finds them by that name', async () => {
    staffNames.current = new Map([['u1', 'Syd East']]);
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    expect(screen.getByText(/signed in · Syd East/)).toBeInTheDocument();
    expect(screen.queryByText(/signed in · u1/)).toBeNull();
    await userEvent.type(screen.getByPlaceholderText(/Search actor/), 'syd');
    expect(screen.getByText(/signed in · Syd East/)).toBeInTheDocument();
  });

  it('keeps a uid nobody on staff answers to, rather than showing nothing', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ actorId: 'gone-uid' })] });
    render(<ActivityLog />);
    expect(screen.getByText(/signed in · gone-uid/)).toBeInTheDocument();
  });
});

describe('ActivityLog', () => {
  it('renders streamed rows with seq and hash, actor context, grouped by day', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    // The mock's day separator: "Jul 16", not the raw ISO key (Today and
    // Yesterday are pinned separately below).
    expect(screen.getByRole('heading', { level: 3, name: 'Jul 16' })).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(screen.getByText(/signed in · u1/)).toBeInTheDocument();
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

describe('ActivityLog stored draft paths (#1747)', () => {
  it('shows a stored generated_drafts path as words on the row, without rewriting the entry', () => {
    const stored = entry({
      _id: 'e9',
      actionType: 'DRAFT_APPROVED',
      description: 'Approved generated_drafts/aB3dE9 (kf-robyn)',
    });
    useCollection.mockReturnValue({ status: 'ready', data: [stored] });
    render(<ActivityLog />);
    expect(screen.getByText(/Approved an Auntie AI draft/)).toBeInTheDocument();
    expect(screen.queryByText(/Approved generated_drafts/)).toBeNull();
    expect(stored.description).toBe('Approved generated_drafts/aB3dE9 (kf-robyn)');
  });
});

describe('ActivityLog stored ids and keys (#1752)', () => {
  it('shows a stored credit and a stored delivery as words, and finds them by those words', async () => {
    const credit = entry({
      _id: 'e10',
      actionType: 'BILLING_ACCOUNT_CREDIT_GIVEN',
      description: 'Account credit of 2500 cents given to household kf_rivera',
    });
    const delivered = entry({
      _id: 'e11',
      actionType: 'NOTIFICATION_RECEIVED',
      description: 'Notification kincare.booking.confirm delivered via email',
    });
    useCollection.mockReturnValue({ status: 'ready', data: [credit, delivered] });
    render(<ActivityLog />);
    expect(screen.getByText(/Gave \$25\.00 account credit/)).toBeInTheDocument();
    expect(screen.getByText(/Delivered "Kincare booking confirm" by email/)).toBeInTheDocument();
    expect(screen.queryByText(/given to household kf_rivera/)).toBeNull();
    expect(screen.queryByText(/kincare\.booking\.confirm delivered/)).toBeNull();
    await userEvent.type(screen.getByPlaceholderText(/Search actor/), 'account credit');
    expect(screen.getByText(/Gave \$25\.00 account credit/)).toBeInTheDocument();
    expect(screen.queryByText(/Delivered "Kincare booking confirm"/)).toBeNull();
    expect(credit.description).toBe('Account credit of 2500 cents given to household kf_rivera');
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
    expect(screen.getByText(/3 of 3 loaded/i)).toBeInTheDocument();
  });
  it('narrows to problems, folding FAILURE and the legacy ERROR spelling together', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.getByText('ERROR_FUNCTION_FAILURE')).toBeInTheDocument();
    expect(screen.getByText('OLD_THING')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).toBeNull();
    expect(screen.getByText(/2 of 3 loaded/i)).toBeInTheDocument();
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
    expect(screen.getByRole('tab', { name: 'Any status' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Problems' })).toHaveAttribute('tabindex', '-1');
  });
  /**
   * The mock's six chips (issue #755), the same taxonomy Android has drawn
   * since its Den port. They sit in their own tablist beside the status facet,
   * so each row answers one question.
   */
  it('offers the mock category chips in their own tablist, All selected', () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    const list = screen.getByRole('tablist', { name: 'Filter activity by category' });
    expect(within(list).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All',
      'Auth',
      'Bookings',
      'KinTales',
      'Notifications',
      'Billing',
      'Admin',
    ]);
    expect(within(list).getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('tab', { name: 'All' })).toHaveClass('activity__chip');
  });
  it('narrows by category, and a category and a status compose', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'b1', actionType: 'BOOKING_SUBMITTED', status: 'SUCCESS' }),
        entry({ _id: 'b2', actionType: 'KINCARE_ARRIVED', status: 'FAILURE' }),
        entry({ _id: 'n1', actionType: 'NOTIFICATION_VIEWED', status: 'FAILURE' }),
      ],
    });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('tab', { name: 'Bookings' }));
    expect(screen.getByText('BOOKING_SUBMITTED')).toBeInTheDocument();
    expect(screen.getByText('KINCARE_ARRIVED')).toBeInTheDocument();
    expect(screen.queryByText('NOTIFICATION_VIEWED')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.queryByText('BOOKING_SUBMITTED')).toBeNull();
    expect(screen.getByText('KINCARE_ARRIVED')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 loaded/i)).toBeInTheDocument();
  });
  it('has a Billing chip that holds the billing events and an Admin chip that is not empty (#1613)', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'p1', actionType: 'BILLING_DRAFT_INVOICE_SENT' }),
        entry({ _id: 'p2', actionType: 'BILLING_PAYMENT_RECORDED' }),
        entry({ _id: 'a1', actionType: 'THEME_BRAND_TOKENS_UPDATED' }),
        entry({ _id: 'a2', actionType: 'MEMBERSHIP_INVITE_SENT' }),
        entry({ _id: 'k1', actionType: 'CONTENT_KINTALE_NOTE_ADDED' }),
      ],
    });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.getByText('BILLING_DRAFT_INVOICE_SENT')).toBeInTheDocument();
    expect(screen.getByText('BILLING_PAYMENT_RECORDED')).toBeInTheDocument();
    expect(screen.queryByText('THEME_BRAND_TOKENS_UPDATED')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'KinTales' }));
    expect(screen.queryByText('BILLING_DRAFT_INVOICE_SENT')).toBeNull();
    expect(screen.getByText('CONTENT_KINTALE_NOTE_ADDED')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Admin' }));
    expect(screen.getByText('THEME_BRAND_TOKENS_UPDATED')).toBeInTheDocument();
    expect(screen.getByText('MEMBERSHIP_INVITE_SENT')).toBeInTheDocument();
  });
});

/**
 * Issue #755: the screen drawn to `ui-ideas/auntieos-activity-log-2026-05-27.html`.
 * These pin the structure the mock draws: the hero band and its chain badge,
 * the row's four columns, the day separators, the untitled log panel.
 */
describe('ActivityLog against its mock', () => {
  it('puts the chain verdict in the hero band as a badge, with the numbers in one mono line', async () => {
    render(<ActivityLog />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Every move, sealed.');
    const badge = document.querySelector('.den-heading-trailing .activity__chain');
    expect(badge).not.toBeNull();
    expect(await screen.findByText('Chain verified')).toHaveClass('activity__chain-verdict');
    expect(screen.getByText('40 entries · seq 1..40 · 0 anomalies · 3 legacy outside the chain')).toHaveClass(
      'activity__chain-line',
    );
    expect(badge).toHaveAttribute('data-state', 'verified');
    expect(within(badge as HTMLElement).getByRole('button', { name: 'Re-verify' })).toBeInTheDocument();
    // No chain panel of its own any more: the badge is the whole surface.
    expect(screen.queryByRole('heading', { name: /chain integrity/i })).toBeNull();
  });
  it('turns the badge red and announces when the chain is broken', async () => {
    verifyActivityLogChain.mockResolvedValue({
      ok: false, scanned: 10, anomaly: { code: 'seq_gap', entryId: 'bad1', seq: 7, expectedSeq: 6 },
    } satisfies VerifyResult);
    render(<ActivityLog />);
    await screen.findByText('Chain broken');
    expect(document.querySelector('.activity__chain')).toHaveAttribute('data-state', 'broken');
    expect(screen.getByRole('alert')).toHaveTextContent(/chain broken/i);
  });
  it('draws the row as time, category tile, title with the raw code, and the seq column', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ actionType: 'KINCARE_ARRIVED', description: '', timestamp: '2026-07-16T14:14:00Z' })],
    });
    render(<ActivityLog />);
    const row = screen.getByRole('button', { name: /KINCARE_ARRIVED/ });
    expect(within(row).getByText('9:14a')).toHaveClass('activity__time');
    expect(within(row).getByText('Kincare arrived')).toHaveClass('activity__title');
    expect(within(row).getByText('KINCARE_ARRIVED')).toHaveClass('activity__code');
    const tile = row.querySelector('.icon-tile');
    expect(tile).toHaveAttribute('data-tone', 'orange');
    expect(tile).toHaveTextContent('◷');
    expect(within(row).getByText('#12')).toHaveClass('activity__seq-n');
    expect(within(row).getByText('deadbeef')).toHaveClass('activity__hash');
    // No status pill on the collapsed row: the mock draws none, and the tone
    // of the tile carries the failure case (next test).
    expect(row.querySelector('.log__status, .den-statuspill')).toBeNull();
  });
  it('marks a failure row with the warning glyph in the error tone, whatever its category', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ actionType: 'NOTIFICATION_DISPATCHED', status: 'FAILURE' })],
    });
    render(<ActivityLog />);
    const tile = screen.getByRole('button', { name: /NOTIFICATION_DISPATCHED/ }).querySelector('.icon-tile');
    expect(tile).toHaveAttribute('data-tone', 'error');
    expect(tile).toHaveTextContent('⚠');
  });
  it('says legacy in the seq column for a pre-chain row, never a fabricated seal', () => {
    const { seq: _dropped, ...legacy } = entry({ _id: 'e3' });
    useCollection.mockReturnValue({ status: 'ready', data: [legacy] });
    render(<ActivityLog />);
    const row = screen.getByRole('button', { name: /LOGIN/ });
    expect(within(row).getByText('legacy')).toHaveClass('activity__seq-n');
    expect(row.querySelector('.activity__hash')).toBeNull();
  });
  it('labels today and yesterday by name, the way the mock separates its days', () => {
    // The business's days (#1585), not the device's.
    const todayKey = businessTodayIso('America/Chicago');
    const yesterdayKey = new Date(Date.parse(`${todayKey}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 't', timestamp: `${todayKey}T09:00:00`, seq: 3 }),
        entry({ _id: 'y', timestamp: `${yesterdayKey}T09:00:00`, seq: 2 }),
      ],
    });
    render(<ActivityLog />);
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(labels[0]).toMatch(/^Today · [A-Z][a-z]{2} \d{1,2}$/);
    expect(labels[1]).toMatch(/^Yesterday · [A-Z][a-z]{2} \d{1,2}$/);
  });
  it('prints a UTC stamp on the business clock and files it under the business day (#1585)', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        // 21:34 UTC on Nov 4 is 3:34 pm in Chicago (CST).
        entry({ _id: 'a', timestamp: '2026-11-04T21:34:00Z', seq: 5 }),
        // 02:34 UTC on Nov 5 is still Nov 4, 8:34 pm, in Chicago.
        entry({ _id: 'b', timestamp: '2026-11-05T02:34:00Z', seq: 4 }),
      ],
    });
    render(<ActivityLog />);
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/Nov 4$/);
    const times = Array.from(document.querySelectorAll('time.activity__time')).map((t) => t.textContent);
    expect(times).toEqual(['3:34p', '8:34p']);
  });
  it('reads the stored business zone once the settings land (#1585)', async () => {
    getBusinessSettings.mockResolvedValue({ timeZone: 'America/Denver' });
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'a', timestamp: '2026-11-04T21:34:00Z', seq: 5 })],
    });
    render(<ActivityLog />);
    await waitFor(() => {
      expect(document.querySelector('time.activity__time')?.textContent).toBe('2:34p');
    });
  });
  it('draws the log as one untitled kit panel with the count as its meta', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    const panel = document.querySelector('.den-panel.activity__log');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.den-panel-meta')).toHaveTextContent('1 of 1 loaded');
    expect(panel!.querySelector('h2')).toBeNull();
  });
  it('puts the search box in the filters row with the glyph, outside the panel', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    const search = screen.getByRole('searchbox', { name: 'Search activity' });
    expect(search.closest('.activity__filters')).not.toBeNull();
    expect(search.closest('.den-panel')).toBeNull();
    expect(search.closest('.activity__search')!.querySelector('svg')).not.toBeNull();
  });
  it('uses the kit hint for the empty and no-match states', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    const { unmount } = render(<ActivityLog />);
    expect(screen.getByText('No chained activity yet.')).toHaveClass('den-hint');
    unmount();
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<ActivityLog />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText(/no entries match this filter/i)).toHaveClass('den-hint');
  });
});

/**
 * #1820. The owner's own clock taps opened to ACTOR ROLE "Primary kinfolk",
 * while the lines the server wrote for the same account in the same minute
 * read "Staff" and the page header read "Operator".
 */
describe('ActivityLog actor role (#1820)', () => {
  async function openedRole(e: ActivityLogEntry): Promise<string | null> {
    useCollection.mockReturnValue({ status: 'ready', data: [e] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(e.actionType ?? '') }));
    const label = screen.getByText('Actor role');
    return label.parentElement?.textContent?.replace('Actor role', '').trim() ?? null;
  }

  it('a tap line already stored as a household role reads Operator for the owner', async () => {
    staffRoles.current = new Map([['u1', 'owner']]);
    expect(await openedRole(entry({ actionType: 'VISIT_ARRIVED', actorRole: 'PRIMARY' }))).toBe('Operator');
    expect(screen.queryByText('Primary kinfolk')).toBeNull();
  });

  it('the server line for the same account reads Operator too, not Staff', async () => {
    staffRoles.current = new Map([['u1', 'owner']]);
    expect(await openedRole(entry({ actionType: 'NOTIFICATION_DISPATCHED', actorRole: 'AUNTIE' }))).toBe('Operator');
  });

  it('an Auntie reads Auntie', async () => {
    staffRoles.current = new Map([['u1', 'auntie']]);
    expect(await openedRole(entry({ actionType: 'VISIT_ARRIVED', actorRole: 'PRIMARY' }))).toBe('Auntie');
  });

  it('a Kinfolk keeps the household role', async () => {
    staffRoles.current = new Map([['owner-uid', 'owner']]);
    expect(await openedRole(entry({ actionType: 'AUTH_LOGIN_SUCCESS', actorId: 'kf-uid', actorRole: 'PRIMARY' }))).toBe(
      'Primary kinfolk',
    );
  });

  it('a new line says who wrote it without the roster', async () => {
    expect(
      await openedRole(
        entry({ actionType: 'VISIT_ARRIVED', actorRole: 'AUNTIE', payload: { admin: true, staffRole: null, visitId: 's1' } }),
      ),
    ).toBe('Operator');
  });
});
