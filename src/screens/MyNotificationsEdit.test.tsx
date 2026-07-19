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

  it('section All on flips every editable channel and commits them in ONE save', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<MyNotificationsEdit />);

    // Wait for the section to render, then flip the whole section on.
    const smsRow = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const smsToggle = within(smsRow).getByRole('switch');
    expect(smsToggle).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(screen.getByRole('button', { name: /^all on$/i }));
    // The section's editable toggles are now on (default-off sms visibly flipped).
    expect(smsToggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
        byKey: { k: { email: true, sms: true, push: true } },
        byCategory: {},
        marketingOptIn: {},
      }),
    );
    // One save writes the whole section, not one call per channel.
    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('section All off does not fake a forced channel off, and still saves once', async () => {
    // email is catalog-required (forced); only sms/push are editable.
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ key: 'k', required: { email: true } })] }),
    );
    render(<MyNotificationsEdit />);
    await screen.findByText('As the owner');

    await userEvent.click(screen.getByRole('button', { name: /^all off$/i }));
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
