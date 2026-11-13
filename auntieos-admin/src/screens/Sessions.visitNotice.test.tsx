// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act as reactAct, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type SessionEntry } from '../api/sessions';
import { type Kinfolk } from '../api/directory';
import { type PagedCollection } from '../lib/usePagedCollection';
import { type CollectionSpec } from '../lib/firestore';

/**
 * #1794 on the Auntie Time board: the Nov 10 walk, replayed.
 *
 * OMW, Arrived and Departed on Dre East, a household with no portal account,
 * while the household-notices switch was off. The confirms promised "Dre East
 * will be told", and the card never said the household was not notified,
 * because the card unmounted (the reload swaps the board for its loading row,
 * and the card moves from Upcoming to Active) before the push settled.
 *
 * Kept apart from `Sessions.test.tsx` because these cases need the switch and
 * the notification promise under their own control.
 */
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
// #2123: a DEPARTED card watches its own document; nothing here reaches DEPARTED.
vi.mock('../lib/firestore', () => ({ useCollection, useDocById: () => ({ status: 'loading' }) }));
vi.mock('../lib/kinTaleTask', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/kinTaleTask')>()),
  useKinTaleRequired: () => false,
}));
const { patchVisitLifecycle } = vi.hoisted(() => ({ patchVisitLifecycle: vi.fn() }));
vi.mock('../api/sessionsWrite', () => ({ patchVisitLifecycle, updateKinCareSession: vi.fn() }));
vi.mock('../api/bookingsWrite', () => ({ transitionBookingStatus: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/breadcrumbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/breadcrumbs')>();
  return { ...actual, useBreadcrumbs: () => ({ points: [], error: null, ready: true }) };
});
vi.mock('../lib/visitTracking', () => ({
  useVisitTracking: () => ({ phase: 'idle' }),
  beginVisitTracking: vi.fn(),
  endVisitTracking: vi.fn(),
  stopVisitTracking: vi.fn(),
}));
vi.mock('../lib/useArrivalRule', () => ({ useArrivalRule: () => null }));
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: {}, serviceDurations: {}, timeBlocks: [] }),
}));
// #1840: the server's answer to "can a notice reach this household?".
const { previewVisitNotification } = vi.hoisted(() => ({ previewVisitNotification: vi.fn() }));
vi.mock('../api/visitNoticePreview', () => ({ previewVisitNotification }));

import { Sessions } from './Sessions';

function at(offset: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 'dre1',
    kinfolkId: 'kfDre',
    kinfolkName: 'Dre East',
    kinCareBatchId: 'b1',
    kinCareVisitId: 'v1',
    kinIds: [],
    serviceType: 'Dog Walk',
    startTime: at(1, 14),
    endTime: at(1, 15),
    arrivedAt: '',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  } as SessionEntry;
}

function paged(rows: SessionEntry[] | null): PagedCollection<SessionEntry> {
  return {
    state: rows === null ? { status: 'loading' } : { status: 'ready', data: rows },
    hasMore: false,
    more: { status: 'ready', data: null },
    loadMore: vi.fn(),
    reload: vi.fn(),
  } as PagedCollection<SessionEntry>;
}

/** The roster the board joins. `null` leaves it loading. */
function roster(households: Kinfolk[] | null) {
  useCollection.mockImplementation((spec: CollectionSpec) =>
    spec.path === 'kinfolk'
      ? households === null
        ? { status: 'loading' }
        : { status: 'ready', data: households }
      : { status: 'ready', data: [] },
  );
}

const user = userEvent.setup();

beforeEach(() => {
  previewVisitNotification.mockReset().mockResolvedValue({ willNotify: true, reason: null });
  patchVisitLifecycle.mockReset();
  usePagedCollection.mockReset().mockReturnValue(paged([entry()]));
  roster([{ _id: 'kfDre', firstName: 'Dre', lastName: 'East', uid: 'uidDre' }]);
});

async function openOmwConfirm() {
  render(<Sessions onSelect={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /^OMW$/ }));
  return screen.getByRole('dialog');
}

describe('the clock confirm promises a notice only when the server says one can be sent', () => {
  it('promises it when the household has a portal sign-in and the switch is on', async () => {
    const dialog = await openOmwConfirm();
    expect(
      await within(dialog).findByText('Dre East will be told their Auntie is on the way.'),
    ).toBeInTheDocument();
    expect(previewVisitNotification).toHaveBeenCalledWith('kfDre');
  });

  it('says the switch is off in Settings, and promises nothing', async () => {
    previewVisitNotification.mockResolvedValue({ willNotify: false, reason: 'household_notices_off' });
    const dialog = await openOmwConfirm();
    expect(
      await within(dialog).findByText('Dre East will not be told, because notices to households are off in Settings.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/will be told/)).toBeNull();
  });

  it('says a household with no portal sign-in will not be told', async () => {
    previewVisitNotification.mockResolvedValue({ willNotify: false, reason: 'household_has_no_portal_account' });
    const dialog = await openOmwConfirm();
    expect(
      await within(dialog).findByText('Dre East will not be told, because they have no portal account.'),
    ).toBeInTheDocument();
  });

  it("#1840: a login stored on the household record is not the answer; the server's is", async () => {
    // The Nov 10 walk: the roster row carries a uid (the Admin's own login),
    // and nobody has claimed the household.
    roster([{ _id: 'kfDre', firstName: 'Dre', lastName: 'East', uid: 'uidAdmin' }]);
    previewVisitNotification.mockResolvedValue({ willNotify: false, reason: 'household_has_no_portal_account' });
    const dialog = await openOmwConfirm();
    expect(
      await within(dialog).findByText('Dre East will not be told, because they have no portal account.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/will be told/)).toBeNull();
  });

  it('says it is checking while the answer is on its way, and promises nothing', async () => {
    let answer: (v: { willNotify: boolean; reason: string | null }) => void = () => {};
    previewVisitNotification.mockReturnValue(new Promise((r) => (answer = r)));
    const dialog = await openOmwConfirm();
    expect(within(dialog).getByText('The visit moves to On the way.')).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking whether Dre East will be told.');
    expect(within(dialog).queryByText(/will be told their/)).toBeNull();

    await reactAct(async () => {
      answer({ willNotify: true, reason: null });
    });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Dre East will be told their Auntie is on the way.');
  });

  it('says nothing about the household when the server cannot be asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    previewVisitNotification.mockRejectedValue(new Error('functions/not-found'));
    const dialog = await openOmwConfirm();
    await reactAct(async () => {
      await Promise.resolve();
    });
    expect(within(dialog).getByText('The visit moves to On the way.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/told/)).toBeNull();
    warn.mockRestore();
  });

  it('does not ask the server about a visit that cannot be routed to a household', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ kinCareBatchId: '', kinCareVisitId: '' })]));
    const dialog = await openOmwConfirm();
    expect(within(dialog).getByText(/not linked to a booking/)).toBeInTheDocument();
    expect(previewVisitNotification).not.toHaveBeenCalled();
  });
});

describe('the outcome survives the card moving to Active', () => {
  it('remounts first, settles after, and the Active card still says why the household was not told', async () => {
    let settle: (v: { notified: boolean; notifySkipped: string | null }) => void = () => {};
    patchVisitLifecycle.mockResolvedValue({
      sessionId: 'dre1',
      action: 'ON_MY_WAY',
      from: 'SCHEDULED',
      status: 'ON_MY_WAY',
      changed: true,
      notification: new Promise((r) => (settle = r)),
    });
    const view = render(<Sessions onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^OMW$/ }));
    await user.click(screen.getByRole('button', { name: /yes, mark it on the way/i }));
    expect(await screen.findByText('SCHEDULED → ON_MY_WAY.')).toBeInTheDocument();

    // The reload the write asks for: the board goes to its loading row, which
    // unmounts every card...
    usePagedCollection.mockReturnValue(paged(null));
    view.rerender(<Sessions onSelect={vi.fn()} />);
    expect(screen.queryByText('Dre East')).toBeNull();
    // ...and comes back with the visit under Active, a different parent.
    usePagedCollection.mockReturnValue(paged([entry({ status: 'ON_MY_WAY', startTime: at(0, 14) })]));
    view.rerender(<Sessions onSelect={vi.fn()} />);

    // Only now does the push settle, into a card that is not the one that sent it.
    await reactAct(async () => {
      settle({ notified: false, notifySkipped: 'household_has_no_portal_account' });
    });

    const active = screen.getByRole('heading', { level: 3, name: /^Active/ }).closest('li') as HTMLElement;
    expect(
      await within(active).findByText(
        'SCHEDULED → ON_MY_WAY. Dre East was not notified, because they have no portal account.',
      ),
    ).toBeInTheDocument();
  });
});
