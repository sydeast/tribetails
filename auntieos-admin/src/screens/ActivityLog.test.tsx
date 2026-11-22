// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ActivityLogEntry, type VerifyResult } from '../api/activityLog';

const { useCollection, verifyActivityLogChain, getBusinessSettings, fetchOlderActivity } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  verifyActivityLogChain: vi.fn(),
  getBusinessSettings: vi.fn(),
  fetchOlderActivity: vi.fn(),
}));
vi.mock('../api/settings', async (orig) => ({
  ...(await orig<typeof import('../api/settings')>()),
  getBusinessSettings,
}));
vi.mock('../lib/firestore', () => ({ useCollection }));
// #2192: who is signed in, and the transport an Auntie's staff read goes over.
const { currentSessionSeat, call } = vi.hoisted(() => ({ currentSessionSeat: vi.fn(), call: vi.fn() }));
vi.mock('../lib/sessionSeat', async (orig) => ({
  ...(await orig<typeof import('../lib/sessionSeat')>()),
  currentSessionSeat,
}));
vi.mock('../lib/fns', async (orig) => ({ ...(await orig<typeof import('../lib/fns')>()), call }));
vi.mock('../api/activityLog', async (orig) => ({
  ...(await orig<typeof import('../api/activityLog')>()),
  verifyActivityLogChain,
  fetchOlderActivity,
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

import {
  ActivityLog,
  BUSINESS_CLOCK_FAILED,
  BUSINESS_CLOCK_LOADING,
  LOAD_OLDER_LABEL,
  LOADING_OLDER_LABEL,
  OLDER_FAILED,
} from './ActivityLog';
import { businessTodayIso } from '../lib/businessZoneTime';
import { AUNTIE_SEAT, OWNER_SEAT, staffOnlyCall } from '../testing/staffWorkSettings';

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
  fetchOlderActivity.mockReset().mockResolvedValue([]);
  getBusinessSettings.mockReset().mockResolvedValue({ timeZone: '' });
  currentSessionSeat.mockReset().mockResolvedValue(OWNER_SEAT);
  call.mockReset().mockImplementation(staffOnlyCall);
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
    await userEvent.type(screen.getByPlaceholderText(/Search activity/), 'syd');
    expect(screen.getByText(/signed in · Syd East/)).toBeInTheDocument();
  });

  it('never prints a uid nobody on staff answers to, or a sign-in email (#1818)', () => {
    staffNames.current = new Map([['u2', 'e2e-admin@tribetails.com']]);
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', actorId: 'gone-uid', actorRole: 'PRIMARY' }),
        entry({ _id: 'b', actorId: 'u2', actorRole: 'AUNTIE', description: 'signed in again' }),
      ],
    });
    render(<ActivityLog />);
    expect(screen.getByText('signed in · Primary kinfolk')).toBeInTheDocument();
    expect(screen.getByText('signed in again · Staff')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/gone-uid|@tribetails\.com/);
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
    expect(screen.getByText('Login')).toBeInTheDocument();
    // #1818: before the roster answers, no uid stands in for the actor.
    expect(screen.getByText('signed in')).toBeInTheDocument();
    expect(screen.queryByText(/u1/)).toBeNull();
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
    expect(screen.getByText(/Delivered "KinCare booking confirm" by email/)).toBeInTheDocument();
    expect(screen.queryByText(/given to household kf_rivera/)).toBeNull();
    expect(screen.queryByText(/kincare\.booking\.confirm delivered/)).toBeNull();
    await userEvent.type(screen.getByPlaceholderText(/Search activity/), 'account credit');
    expect(screen.getByText(/Gave \$25\.00 account credit/)).toBeInTheDocument();
    expect(screen.queryByText(/Delivered "KinCare booking confirm"/)).toBeNull();
    expect(credit.description).toBe('Account credit of 2500 cents given to household kf_rivera');
  });
});

/**
 * #1819, #1905: what the walk read on this screen, row by row.
 *
 *   #1819  "Notification dispatched", `NOTIFICATION_DISPATCHED uid=<id>`, and
 *          STATUS "SUCCESS" on the opened row, for a notice that was held back.
 *   #1905  "Sent ... by email" ending in a database path, with nothing to say
 *          whose copy it was.
 */
describe('ActivityLog notices that did not go out (#1819, #1905)', () => {
  const heldAsStored = (): ActivityLogEntry =>
    entry({
      _id: 'held1',
      actionType: 'NOTIFICATION_DISPATCHED',
      description: 'NOTIFICATION_DISPATCHED uid=AbCdEfGhIjKlMnOpQrStUvWxYz12',
      status: 'SUCCESS',
      actorId: '',
      payload: { key: 'kincare.auntie.on_my_way', event: 'on_my_way', dispatchIds: [], reason: 'household_notices_off' },
    });

  it('a held notice stored as "dispatched" reads as not sent, with the reason in words', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [heldAsStored()] });
    render(<ActivityLog />);
    const row = screen.getByRole('button', { name: /Notification not sent/ });
    expect(within(row).getByText('Notification not sent')).toHaveClass('activity__title');
    expect(
      within(row).getByText('Held back "KinCare Auntie on my way": notices to households are turned off'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Notification dispatched')).toBeNull();
    expect(screen.queryByText(/uid=/)).toBeNull();
    // No stored key beside a title that says the opposite.
    expect(row.querySelector('.activity__code')).toBeNull();
  });

  it('opened, its status reads "Not sent" and never SUCCESS; the payload is still there as stored', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [heldAsStored()] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Notification not sent/ }));
    const detail = document.getElementById('log-detail-held1') as HTMLElement;
    expect(within(detail).getByText('Not sent')).toBeInTheDocument();
    expect(within(detail).queryByText('SUCCESS')).toBeNull();
    // #1818: the stored reason reads as words, never as its key.
    expect(within(detail).getByText('Household notices off')).toBeInTheDocument();
    expect(within(detail).queryByText('household_notices_off')).toBeNull();
  });

  it('is not listed under Success, and is not a Problem', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [heldAsStored(), entry({ _id: 'ok1' })] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('tab', { name: 'Success' }));
    expect(screen.queryByText('Notification not sent')).toBeNull();
    expect(screen.getByText('Login')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.queryByText('Notification not sent')).toBeNull();
  });

  it('the line the server writes now shows its sentence as written, and no path after it', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({
          _id: 'n1',
          actionType: 'NOTIFICATION_NOT_SENT',
          description:
            'Did not send "Payment or credit applied to an invoice" to Dre East by email: they turned that off in their notification settings',
          status: 'NOT_SENT',
          actorId: '',
          targetId: 'notif9',
          targetCollection: 'notifications',
        }),
        entry({
          _id: 'n2',
          actionType: 'NOTIFICATION_DISPATCHED',
          description: 'Sending "Payment or credit applied to an invoice" to the office by email',
          actorId: '',
          targetId: 'notif8',
          targetCollection: 'notifications',
        }),
      ],
    });
    render(<ActivityLog />);
    expect(
      screen.getByText(
        'Did not send "Payment or credit applied to an invoice" to Dre East by email: they turned that off in their notification settings',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sending "Payment or credit applied to an invoice" to the office by email'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/notifications\/notif/)).toBeNull();
  });

  it('a send that failed wears the warning tile and is listed under Problems', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({
          _id: 'f1',
          actionType: 'NOTIFICATION_NOT_SENT',
          description: 'Could not send "Invoice sent" to Dre East by email: the send failed',
          status: 'FAILURE',
          actorId: '',
        }),
      ],
    });
    render(<ActivityLog />);
    const tile = screen.getByRole('button', { name: /Notification not sent/ }).querySelector('.icon-tile');
    expect(tile).toHaveAttribute('data-tone', 'error');
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.getByText(/the send failed/)).toBeInTheDocument();
  });

  it('#1818: a row of another kind no longer ends with its target either', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'v1', actionType: 'VISIT_ARRIVED', targetId: 's1', targetCollection: 'kin_care_sessions' })],
    });
    render(<ActivityLog />);
    expect(screen.queryByText(/kin_care_sessions/)).toBeNull();
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
    expect(screen.getByRole('button', { name: /Notification received/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('What happened')).toBeNull();
  });
  it('opens to show the payload, which is the field that says what happened', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Notification received/ }));
    expect(screen.getByText('What happened')).toBeInTheDocument();
    // #1818: labels in words, and no id or stored key among the values.
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.queryByText('providerMessageId')).toBeNull();
    expect(screen.queryByText('sg-88')).toBeNull();
  });
  it('opens to one readable time and the provenance, with no path, id or stored key (#1818)', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Notification received/ }));
    const detail = document.getElementById('log-detail-e2') as HTMLElement;
    expect(within(detail).getByText('Aug 3, 2026, 9:02a')).toBeInTheDocument();
    expect(within(detail).getByText('Severity')).toBeInTheDocument();
    expect(within(detail).getByText('Actor role')).toBeInTheDocument();
    expect(detail.textContent).not.toMatch(/2026-08-03T|notifications\/n1|NOTIFICATION_RECEIVED|Actor id|Business time/);
  });
  it('shows the FULL chain hashes, because a truncated hash verifies nothing', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Notification received/ }));
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
    await userEvent.click(screen.getByRole('button', { name: /Login/ }));
    expect(screen.getByText('Nothing more was recorded.')).toBeInTheDocument();
  });
  it('names a legacy pre-chain entry as outside verification, rather than faking a seal', async () => {
    const { seq: _dropped, ...legacy } = entry({ _id: 'e3' });
    useCollection.mockReturnValue({ status: 'ready', data: [legacy] });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Login/ }));
    expect(screen.getByText(/before the hash chain/i)).toBeInTheDocument();
  });
  it('keeps two entries open at once, because comparing them is the point', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [delivered, entry({ _id: 'e4', actionType: 'NOTIFICATION_DISPATCHED' })],
    });
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: /Notification received/ }));
    await userEvent.click(screen.getByRole('button', { name: /Notification dispatched/ }));
    expect(screen.getAllByText('What happened')).toHaveLength(2);
  });
  it('closes again', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [delivered] });
    render(<ActivityLog />);
    const opener = screen.getByRole('button', { name: /Notification received/ });
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
    expect(screen.getByText('Error function failure')).toBeInTheDocument();
    expect(screen.getByText('Old thing')).toBeInTheDocument();
    expect(screen.queryByText('Login')).toBeNull();
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
    expect(screen.getByText('Booking submitted')).toBeInTheDocument();
    expect(screen.queryByText('Login')).toBeNull();
  });
  it('says nothing matches rather than silently falling back to everything', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: rows });
    render(<ActivityLog />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText(/no entries match this filter/i)).toBeInTheDocument();
    expect(screen.queryByText('Login')).toBeNull();
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
    expect(screen.getByText('Booking submitted')).toBeInTheDocument();
    expect(screen.getByText('KinCare arrived')).toBeInTheDocument();
    expect(screen.queryByText('Notification viewed')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.queryByText('Booking submitted')).toBeNull();
    expect(screen.getByText('KinCare arrived')).toBeInTheDocument();
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
    expect(screen.getByText('Billing draft invoice sent')).toBeInTheDocument();
    expect(screen.getByText('Billing payment recorded')).toBeInTheDocument();
    expect(screen.queryByText('Theme brand tokens updated')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'KinTales' }));
    expect(screen.queryByText('Billing draft invoice sent')).toBeNull();
    expect(screen.getByText('Content KinTale note added')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Admin' }));
    expect(screen.getByText('Theme brand tokens updated')).toBeInTheDocument();
    expect(screen.getByText('Membership invite sent')).toBeInTheDocument();
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
  it('draws the row as time, category tile, title in words with no stored key, and the seq column', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ actionType: 'KINCARE_ARRIVED', description: '', timestamp: '2026-07-16T14:14:00Z' })],
    });
    render(<ActivityLog />);
    const row = screen.getByRole('button', { name: /KinCare arrived/ });
    expect(within(row).getByText('9:14a')).toHaveClass('activity__time');
    // #1881: the brand word keeps its casing. #1818: no stored key beside it.
    expect(within(row).getByText('KinCare arrived')).toHaveClass('activity__title');
    expect(row.textContent).not.toContain('KINCARE_ARRIVED');
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
    const tile = screen.getByRole('button', { name: /Notification dispatched/ }).querySelector('.icon-tile');
    expect(tile).toHaveAttribute('data-tone', 'error');
    expect(tile).toHaveTextContent('⚠');
  });
  it('says legacy in the seq column for a pre-chain row, never a fabricated seal', () => {
    const { seq: _dropped, ...legacy } = entry({ _id: 'e3' });
    useCollection.mockReturnValue({ status: 'ready', data: [legacy] });
    render(<ActivityLog />);
    const row = screen.getByRole('button', { name: /Login/ });
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
    // #1818: the row is named by its title in words, so open the one row there is.
    const row = screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;
    await userEvent.click(row);
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

/**
 * #1839. A look at a household read as "Operator crosstenant access", its key
 * in capitals, a red flag and a line of ids. Since operator ruling 2026-11-12
 * only an Auntie's looks write it, in words; the rows stored before then still
 * show, in plain words and without the warning.
 */
describe('ActivityLog household looks (#1839)', () => {
  const AUNTIE_LOOK = entry({
    _id: 'look-new',
    actionType: 'OPERATOR_CROSSTENANT_ACCESS',
    description: 'Jane Rivers looked at Kinfolk Dre East',
    actorId: 'aunt-uid',
    actorRole: 'AUNTIE',
    targetId: 'Xk29fLq0aBcD3eFgH1jK',
    familyId: 'Xk29fLq0aBcD3eFgH1jK',
    payload: { function: 'listMembers', kinfolkId: 'Xk29fLq0aBcD3eFgH1jK', admin: false, staffRole: 'auntie' },
  });
  const STORED_LOOK = entry({
    _id: 'look-old',
    seq: 11,
    actionType: 'OPERATOR_CROSSTENANT_ACCESS',
    description: 'OPERATOR_CROSSTENANT_ACCESS uid=owner-uid target=Xk29fLq0aBcD3eFgH1jK',
    actorId: 'owner-uid',
    actorRole: 'AUNTIE',
    targetId: 'Xk29fLq0aBcD3eFgH1jK',
    payload: { function: 'listInvites', kinfolkId: 'Xk29fLq0aBcD3eFgH1jK' },
  });
  const rowOf = (title: RegExp) =>
    screen.getAllByRole('button').find((b) => title.test(b.textContent ?? '')) as HTMLElement;

  it("an Auntie's look reads in plain words with her name, no key, no id, no red", () => {
    staffNames.current = new Map([['aunt-uid', 'Jane Rivers']]);
    useCollection.mockReturnValue({ status: 'ready', data: [AUNTIE_LOOK] });
    render(<ActivityLog />);
    const row = rowOf(/Household opened/);
    expect(within(row).getByText('Household opened')).toHaveClass('activity__title');
    expect(row.querySelector('.activity__code')).toBeNull();
    expect(within(row).getByText('Jane Rivers looked at Kinfolk Dre East')).toHaveClass('activity__ctx');
    expect(row.textContent).not.toMatch(/OPERATOR|CROSSTENANT|crosstenant|Xk29fLq0aBcD3eFgH1jK|uid=|target=/);
    const tile = row.querySelector('.icon-tile');
    expect(tile).toHaveAttribute('data-tone', 'neutral');
    expect(tile).not.toHaveTextContent('⚑');
  });

  it("a look stored before the ruling reads as words with the person's name, no ids", () => {
    staffNames.current = new Map([['owner-uid', 'Syd East']]);
    useCollection.mockReturnValue({ status: 'ready', data: [STORED_LOOK] });
    render(<ActivityLog />);
    const row = rowOf(/Household opened/);
    expect(within(row).getByText('Opened a household · Syd East')).toHaveClass('activity__ctx');
    expect(row.querySelector('.activity__code')).toBeNull();
    expect(row.textContent).not.toMatch(/OPERATOR|CROSSTENANT|Xk29fLq0aBcD3eFgH1jK|uid=|target=/);
    expect(row.querySelector('.icon-tile')).toHaveAttribute('data-tone', 'neutral');
  });

  it('a stored look never names the person by a sign-in email or a uid', () => {
    // The roster labels a staff member with no name by her sign-in email.
    staffNames.current = new Map([['owner-uid', 'e2e-admin@tribetails.com']]);
    useCollection.mockReturnValue({ status: 'ready', data: [STORED_LOOK] });
    const { unmount } = render(<ActivityLog />);
    let row = rowOf(/Household opened/);
    expect(row.querySelector('.activity__ctx')).toHaveTextContent(/^Opened a household$/);
    expect(row.textContent).not.toContain('@');
    unmount();
    // Before the roster answers, the row would otherwise print the uid.
    staffNames.current = new Map();
    render(<ActivityLog />);
    row = rowOf(/Household opened/);
    expect(row.querySelector('.activity__ctx')).toHaveTextContent(/^Opened a household$/);
    expect(row.textContent).not.toContain('owner-uid');
  });

  it('a stored look is shown, not hidden, and the stored entry is not rewritten', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [AUNTIE_LOOK, STORED_LOOK] });
    render(<ActivityLog />);
    expect(screen.getAllByText('Household opened')).toHaveLength(2);
    expect(STORED_LOOK.description).toBe('OPERATOR_CROSSTENANT_ACCESS uid=owner-uid target=Xk29fLq0aBcD3eFgH1jK');
  });

  it('opened, it names her Auntie and shows no stored key or household id (#1818)', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [AUNTIE_LOOK] });
    render(<ActivityLog />);
    await userEvent.click(rowOf(/Household opened/));
    const actorRole = screen.getByText('Actor role').parentElement?.textContent?.replace('Actor role', '').trim();
    expect(actorRole).toBe('Auntie');
    const detail = document.getElementById('log-detail-look-new') as HTMLElement;
    expect(detail.textContent).not.toMatch(/OPERATOR_CROSSTENANT_ACCESS|Operator crosstenant access|Xk29fLq0aBcD3eFgH1jK/);
  });

  it('a failed look still wears the warning, as every failure does', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ ...AUNTIE_LOOK, status: 'FAILURE' })] });
    render(<ActivityLog />);
    expect(rowOf(/Household opened/).querySelector('.icon-tile')).toHaveAttribute('data-tone', 'error');
  });

  it('is found by its plain title', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [AUNTIE_LOOK, entry({ _id: 'other', actionType: 'LOGIN', description: 'signed in' })],
    });
    render(<ActivityLog />);
    await userEvent.type(screen.getByPlaceholderText(/Search activity/), 'household opened');
    expect(screen.getAllByText('Household opened')).toHaveLength(1);
    expect(screen.queryByText(/signed in/)).toBeNull();
  });
});

/**
 * #2192. The log read the business clock straight from `business_settings`,
 * which an Auntie's sign-in may not read, so for her it failed without a word
 * and counted days on Central time. It now goes through the work-settings read.
 */
describe('ActivityLog business clock (#2192)', () => {
  // 21:34 UTC on Nov 4: 3:34 pm in Chicago, 2:34 pm in Denver.
  const ROW = entry({ _id: 'a', timestamp: '2026-11-04T21:34:00Z', seq: 5 });
  const shownTime = () => document.querySelector('time.activity__time')?.textContent;

  it('owner: shows a loading row until her own settings read lands, then the business clock', async () => {
    let land: (v: unknown) => void = () => undefined;
    getBusinessSettings.mockReturnValue(new Promise((resolve) => (land = resolve)));
    useCollection.mockReturnValue({ status: 'ready', data: [ROW] });
    render(<ActivityLog />);
    expect(await screen.findByText(BUSINESS_CLOCK_LOADING)).toBeInTheDocument();
    // The log still draws while it waits.
    expect(shownTime()).toBe('3:34p');

    land({ timeZone: 'America/Denver' });
    await waitFor(() => expect(shownTime()).toBe('2:34p'));
    expect(screen.queryByText(BUSINESS_CLOCK_LOADING)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('owner: a failed read says so, keeps the log on Central time, and Try again reads again', async () => {
    getBusinessSettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ timeZone: 'America/Denver' });
    useCollection.mockReturnValue({ status: 'ready', data: [ROW] });
    render(<ActivityLog />);
    expect(await screen.findByText(BUSINESS_CLOCK_FAILED)).toBeInTheDocument();
    expect(screen.getByText('Until it loads, days are counted on Central time.')).toBeInTheDocument();
    expect(shownTime()).toBe('3:34p');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(shownTime()).toBe('2:34p'));
    expect(screen.queryByText(BUSINESS_CLOCK_FAILED)).toBeNull();
  });

  it('Auntie: counts days on the business clock from the staff read, and never reads the settings record', async () => {
    currentSessionSeat.mockResolvedValue(AUNTIE_SEAT);
    useCollection.mockReturnValue({ status: 'ready', data: [ROW] });
    render(<ActivityLog />);
    // STAFF_WORK_REPLY carries America/Denver.
    await waitFor(() => expect(shownTime()).toBe('2:34p'));
    expect(call).toHaveBeenCalledWith('getStaffWorkSettings', {});
    expect(getBusinessSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(BUSINESS_CLOCK_LOADING)).toBeNull();
    expect(screen.queryByText(BUSINESS_CLOCK_FAILED)).toBeNull();
  });

  it('Auntie: a failed staff read says so instead of failing silently, and Try again recovers', async () => {
    currentSessionSeat.mockResolvedValue(AUNTIE_SEAT);
    call.mockRejectedValueOnce(new Error('unavailable'));
    useCollection.mockReturnValue({ status: 'ready', data: [ROW] });
    render(<ActivityLog />);
    expect(await screen.findByText(BUSINESS_CLOCK_FAILED)).toBeInTheDocument();
    expect(shownTime()).toBe('3:34p');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(shownTime()).toBe('2:34p'));
    expect(getBusinessSettings).not.toHaveBeenCalled();
  });
});
/**
 * #1880: the list ended at the newest 200 ("200 of 200 loaded") with no way to
 * reach the other 859 entries of the chain.
 */
describe('ActivityLog older entries (#1880)', () => {
  const page = (from: number, n: number): ActivityLogEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({ _id: `e${from - i}`, seq: from - i, description: `line ${from - i}` }),
    );
  it('offers older entries under a full live list, reads them below the oldest one, and lists them', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(1059, 200) });
    let resolvePage: (rows: ActivityLogEntry[]) => void = () => {};
    fetchOlderActivity.mockImplementation(() => new Promise((r) => (resolvePage = r)));
    render(<ActivityLog />);
    expect(screen.getByText('200 of 200 loaded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    // The wait has its cue, and the press cannot be repeated while it runs.
    expect(screen.getByText(LOADING_OLDER_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: LOAD_OLDER_LABEL })).toBeNull();
    expect(fetchOlderActivity).toHaveBeenCalledWith(860, 200);
    resolvePage(page(859, 200));
    expect(await screen.findByText('400 of 400 loaded')).toBeInTheDocument();
    expect(screen.getByText(/line 660/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LOAD_OLDER_LABEL })).toBeInTheDocument();
  });
  it('keeps the rows new entries push out of the newest 200, so no entry falls between the pages', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(1059, 200) });
    fetchOlderActivity.mockResolvedValueOnce(page(859, 200)).mockResolvedValueOnce(page(659, 200));
    const { rerender } = render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    await screen.findByText('400 of 400 loaded');
    // Five new entries arrive: the live newest 200 now starts at 865.
    useCollection.mockReturnValue({ status: 'ready', data: page(1064, 200) });
    rerender(<ActivityLog />);
    expect(await screen.findByText('405 of 405 loaded')).toBeInTheDocument();
    for (const seq of [860, 862, 864]) expect(screen.getByText(new RegExp(`line ${seq}\\b`))).toBeInTheDocument();
    // The next press still starts below the oldest entry on screen.
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    expect(fetchOlderActivity).toHaveBeenLastCalledWith(660, 200);
    expect(await screen.findByText('605 of 605 loaded')).toBeInTheDocument();
  });
  it('stops offering once a page comes back short, because nothing older is left', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(250, 200) });
    fetchOlderActivity.mockResolvedValue(page(50, 50));
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    expect(await screen.findByText('250 of 250 loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: LOAD_OLDER_LABEL })).toBeNull();
  });
  it('says so when the read fails, keeps the rows on screen, and tries again', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(500, 200) });
    fetchOlderActivity.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(page(300, 10));
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    expect(await screen.findByText(OLDER_FAILED)).toBeInTheDocument();
    expect(screen.getByText('200 of 200 loaded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('210 of 210 loaded')).toBeInTheDocument();
  });
  it('offers nothing under a list that is not full', () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(12, 12) });
    render(<ActivityLog />);
    expect(screen.queryByRole('button', { name: LOAD_OLDER_LABEL })).toBeNull();
    expect(fetchOlderActivity).not.toHaveBeenCalled();
  });
  it('filters and searches the older entries with the rest', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: page(1000, 200) });
    fetchOlderActivity.mockResolvedValue([
      entry({ _id: 'old', seq: 5, actionType: 'BILLING_INVOICE_PAID', description: 'Invoice 1001 paid by card' }),
    ]);
    render(<ActivityLog />);
    await userEvent.click(screen.getByRole('button', { name: LOAD_OLDER_LABEL }));
    await screen.findByText('201 of 201 loaded');
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.getByText(/Invoice 1001 paid by card/)).toBeInTheDocument();
    expect(screen.getByText('1 of 201 loaded')).toBeInTheDocument();
  });
});
