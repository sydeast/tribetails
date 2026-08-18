// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STREAM_BUSINESS, STREAM_STAFF, type NotificationCatalogEntry, type NotificationMatrix } from '../api/myNotifications';

const { getNotificationMatrix, getMyNotificationPrefs } = vi.hoisted(() => ({
  getNotificationMatrix: vi.fn(),
  getMyNotificationPrefs: vi.fn(),
}));
vi.mock('../api/myNotifications', async (orig) => ({
  ...(await orig<typeof import('../api/myNotifications')>()),
  getNotificationMatrix,
  getMyNotificationPrefs,
}));

const { saveMyAdminNotificationPrefs } = vi.hoisted(() => ({ saveMyAdminNotificationPrefs: vi.fn() }));
vi.mock('../api/myNotificationsWrite', () => ({ saveMyAdminNotificationPrefs }));

import { MyNotificationsEdit } from './MyNotificationsEdit';

function entry(over: Partial<NotificationCatalogEntry> = {}): NotificationCatalogEntry {
  return {
    key: 'kincare.booking.confirm',
    label: 'Booking confirmed',
    category: 'visit',
    audience: 'business',
    audiences: new Set([STREAM_BUSINESS]),
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    alwaysEnabledStreams: new Set(),
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    description: '',
    ...over,
  };
}

function matrix(over: Partial<NotificationMatrix> = {}): NotificationMatrix {
  return { catalog: [], overrides: {}, updatedAtMs: null, ...over };
}

const EMPTY_PREFS = { byKey: {}, byCategory: {}, marketingOptIn: {} };

beforeEach(() => {
  getNotificationMatrix.mockReset();
  getMyNotificationPrefs.mockReset().mockResolvedValue({ prefs: EMPTY_PREFS, updatedAtMs: null });
  saveMyAdminNotificationPrefs.mockReset().mockResolvedValue(undefined);
});

describe('MyNotificationsEdit screen', () => {
  it('renders the same two hat sections as the read screen', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({}),
          entry({ key: 'kintale.comment', category: 'kintale', audiences: new Set([STREAM_STAFF]) }),
        ],
      }),
    );
    render(<MyNotificationsEdit />);
    expect(await screen.findByText('As the owner')).toBeInTheDocument();
    expect(await screen.findByText('As the Auntie')).toBeInTheDocument();
  });

  it('a forced (catalog-required) channel stays disabled and pinned on', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ required: { email: true } })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Email')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(row).getByText('Required')).toBeInTheDocument();
  });

  it('a non-forced channel is a live, enabled toggle', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');
    expect(toggle).not.toBeDisabled();
  });

  it('Save starts disabled; clicking a non-forced toggle flips it and enables Save', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');

    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    expect(saveBtn).toBeDisabled();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(saveBtn).not.toBeDisabled();
  });

  it('a forced toggle click is a no-op: role=switch disabled buttons do not fire onChange', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ required: { email: true } })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Email')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('Discard resets a changed toggle back to the loaded value and disables Save again', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('Save sends the edited draft through saveMyAdminNotificationPrefs and confirms success', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');
    await userEvent.click(toggle);

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        byKey: { k: { sms: true } },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    expect(await screen.findByRole('button', { name: /^saved$/i })).toBeInTheDocument();
    // Dirty is cleared once the save lands, so Save is disabled again.
    expect(screen.getByRole('button', { name: /^saved$/i })).toBeDisabled();
  });

  it('Save is disabled while a save is in flight', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    let release: () => void = () => {};
    saveMyAdminNotificationPrefs.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('switch'));

    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    await userEvent.click(saveBtn);
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getByRole('button', { name: /^saved$/i })).toBeInTheDocument());
  });

  it('a save failure is fail-loud (names the callable) and keeps the draft, letting the operator retry', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    saveMyAdminNotificationPrefs.mockRejectedValue(new Error('permission-denied'));
    render(<MyNotificationsEdit />);
    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const toggle = within(row).getByRole('switch');
    await userEvent.click(toggle);

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/saveMyAdminNotificationPrefs failed/i)).toBeInTheDocument();
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    // draft preserved, not reverted
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Save button re-enabled (still dirty) so the operator can retry
    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
  });

  it('section All on is named for its own section, flips only that section, and commits in ONE save', async () => {
    // #390 regression fixture: TWO sections (visit -> "Bookings and visits",
    // invoice -> "Billing and payments"), not the one-entry catalog that used
    // to make the bug invisible. A bare `/^all on$/i` query would throw here
    // on multiple matches unless the section buttons are named for their
    // scope, which is exactly what this test is pinning down.
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ key: 'k1', category: 'visit' }), entry({ key: 'k2', category: 'invoice' })] }),
    );
    render(<MyNotificationsEdit />);

    const [firstSmsLabel] = await screen.findAllByText('Text (SMS)');
    const smsRow = firstSmsLabel!.closest('.mynotif__channel-row') as HTMLElement;
    const smsToggle = within(smsRow).getByRole('switch');
    expect(smsToggle).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(screen.getByRole('button', { name: /^all on: bookings and visits$/i }));
    // The section's editable toggles are now on (default-off sms visibly flipped).
    expect(smsToggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        // Only k1 (Bookings and visits) moved. k2 (Billing and payments) is
        // untouched by this section's button, the whole point of the scope fix.
        byKey: { k1: { email: true, sms: true, push: true } },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    // One save writes the whole section, not one call per channel.
    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('section All off is named for its own section, does not fake a forced channel off, and still saves once', async () => {
    // email is catalog-required (forced); only sms/push are editable.
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ key: 'k', required: { email: true } })] }),
    );
    render(<MyNotificationsEdit />);
    await screen.findByText('As the owner');

    await userEvent.click(screen.getByRole('button', { name: /^all off: bookings and visits$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        byKey: { k: { sms: false, push: false } },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('page All on resolves uniquely and covers every section on the page, both hats included (#390)', async () => {
    // A multi-section, multi-hat catalog: k1 and k2 land in two different
    // "As the owner" sections, k3 lands in "As the Auntie". Before the fix,
    // every section rendered its own bare "All on" button, so
    // `getByRole('button', { name: /^all on$/i })` would throw on multiple
    // matches here (the regression signal from #390). After the fix, the
    // section buttons are named for their scope and this query resolves to
    // the one page-level button.
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({ key: 'k1', category: 'visit' }), // "Bookings and visits" (owner)
          entry({ key: 'k2', category: 'invoice' }), // "Billing and payments" (owner)
          entry({ key: 'k3', category: 'kintale', audiences: new Set([STREAM_STAFF]) }), // "KinTales and comments" (auntie)
        ],
      }),
    );
    render(<MyNotificationsEdit />);
    await screen.findByText('As the owner');
    await screen.findByText('As the Auntie');

    const allOnButton = screen.getByRole('button', { name: /^all on$/i });
    await userEvent.click(allOnButton);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        // Every notification on the page moved, not just the biggest section.
        byKey: {
          k1: { email: true, sms: true, push: true },
          k2: { email: true, sms: true, push: true },
          k3: { email: true, sms: true, push: true },
        },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('page All off covers every section on the page and does not fake a forced channel off', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({ key: 'k1', category: 'visit' }),
          entry({ key: 'k2', category: 'invoice', required: { email: true } }),
          entry({ key: 'k3', category: 'kintale', audiences: new Set([STREAM_STAFF]) }),
        ],
      }),
    );
    render(<MyNotificationsEdit />);
    await screen.findByText('As the owner');
    await screen.findByText('As the Auntie');

    await userEvent.click(screen.getByRole('button', { name: /^all off$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        byKey: {
          k1: { email: false, sms: false, push: false },
          // k2's email is forced on; the bulk flip must skip it, not fake it off.
          k2: { sms: false, push: false },
          k3: { email: false, sms: false, push: false },
        },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('surfaces a load failure fail-loud, same as the read screen', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('permission-denied'));
    render(<MyNotificationsEdit />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('shows the proven-empty state only once genuinely nothing is visible on either stream', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [] }));
    render(<MyNotificationsEdit />);
    expect(await screen.findByText(/nothing to set just yet/i)).toBeInTheDocument();
  });
});
