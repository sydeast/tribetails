// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

import { MyNotifications } from './MyNotifications';

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
});

describe('MyNotifications screen', () => {
  it('renders a business-stream row under "As the owner" with its offered channels', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({})] }));
    render(<MyNotifications />);

    const panel = (await screen.findByText('As the owner')).closest('section') as HTMLElement;
    expect(within(panel).getByText('Booking confirmed')).toBeInTheDocument();
    expect(within(panel).getByText('Email')).toBeInTheDocument();
    expect(within(panel).getByText('Text (SMS)')).toBeInTheDocument();
    expect(within(panel).getByText('Push')).toBeInTheDocument();
    expect(screen.queryByText('As the Auntie')).toBeNull();
  });

  it('renders a staff-stream row under "As the Auntie" only', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [entry({ key: 'kintale.comment', category: 'kintale', audiences: new Set([STREAM_STAFF]) })],
      }),
    );
    render(<MyNotifications />);

    const panel = (await screen.findByText('As the Auntie')).closest('section') as HTMLElement;
    expect(within(panel).getByText('Booking confirmed')).toBeInTheDocument();
    expect(screen.queryByText('As the owner')).toBeNull();
  });

  it('marks a catalog-required channel Required and read-only, with the stock reason', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ required: { email: true } })] }),
    );
    render(<MyNotifications />);

    const row = (await screen.findByText('Email')).closest('.mynotif__channel-row') as HTMLElement;
    expect(within(row).getByText('Required')).toBeInTheDocument();
    expect(within(row).getByText('Always on for this notification.')).toBeInTheDocument();
    const toggle = within(row).getByRole('switch');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('prefers the business-authored lock reason over the stock line when one is saved', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [entry({ key: 'k', required: { email: true } })],
        overrides: {
          k: { enabled: true, channels: {}, lockedEnabled: false, locked: {}, lockReason: 'Legal hold.', streams: {} },
        },
      }),
    );
    render(<MyNotifications />);
    const row = (await screen.findByText('Email')).closest('.mynotif__channel-row') as HTMLElement;
    expect(within(row).getByText('Legal hold.')).toBeInTheDocument();
    expect(within(row).queryByText('Always on for this notification.')).toBeNull();
  });

  it('shows a non-forced channel as an editable-looking but disabled toggle reflecting the saved preference', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    getMyNotificationPrefs.mockResolvedValue({
      prefs: { byKey: { k: { sms: true } }, byCategory: {}, marketingOptIn: {} },
      updatedAtMs: null,
    });
    render(<MyNotifications />);

    const row = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    expect(within(row).queryByText('Required')).toBeNull();
    const toggle = within(row).getByRole('switch');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('every toggle on the screen is disabled: this is a read view, editing is deferred', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({})] }));
    render(<MyNotifications />);
    await screen.findByText('As the owner');
    for (const toggle of screen.getAllByRole('switch')) {
      expect(toggle).toBeDisabled();
    }
  });

  it('shows a read-only banner (editing is not wired yet)', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({})] }));
    render(<MyNotifications />);
    await screen.findByText('As the owner');
    expect(screen.getByText('READ-ONLY')).toBeInTheDocument();
  });

  it('shows the proven-empty state only once genuinely nothing is visible on either stream', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [] }));
    render(<MyNotifications />);
    expect(await screen.findByText(/nothing to set just yet/i)).toBeInTheDocument();
    expect(screen.queryByText('As the owner')).toBeNull();
    expect(screen.queryByText('As the Auntie')).toBeNull();
  });

  it('surfaces a matrix load failure fail-loud, never a false empty', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('permission-denied'));
    render(<MyNotifications />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to set just yet/i)).toBeNull();
  });

  it('surfaces a prefs load failure fail-loud too', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({})] }));
    getMyNotificationPrefs.mockRejectedValue(new Error('deadline-exceeded'));
    render(<MyNotifications />);
    expect(await screen.findByText(/deadline-exceeded/i)).toBeInTheDocument();
  });

  it('offers Retry on a failed load', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('boom'));
    render(<MyNotifications />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
