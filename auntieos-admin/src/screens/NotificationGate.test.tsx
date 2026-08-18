// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  STREAM_STAFF,
  type NotificationCatalogEntry,
  type NotificationMatrix,
} from '../api/myNotifications';

const { getNotificationMatrix } = vi.hoisted(() => ({ getNotificationMatrix: vi.fn() }));
vi.mock('../api/myNotifications', async (orig) => ({
  ...(await orig<typeof import('../api/myNotifications')>()),
  getNotificationMatrix,
}));

const { saveBusinessNotificationOverride } = vi.hoisted(() => ({
  saveBusinessNotificationOverride: vi.fn(),
}));
vi.mock('../api/notificationOverridesWrite', () => ({
  saveBusinessNotificationOverride,
  deleteBusinessNotificationOverride: vi.fn(),
}));

import { NotificationGate } from './NotificationGate';

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

beforeEach(() => {
  getNotificationMatrix.mockReset();
  saveBusinessNotificationOverride.mockReset().mockResolvedValue(undefined);
});

describe('NotificationGate screen', () => {
  it('renders the three audience tabs', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({}),
          entry({ key: 'k2', category: 'kintale', audiences: new Set([STREAM_STAFF]) }),
          entry({ key: 'k3', audiences: new Set([STREAM_KINFOLK]) }),
        ],
      }),
    );
    render(<NotificationGate />);
    expect(await screen.findByRole('tab', { name: /Business/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Staff/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Kinfolk/ })).toBeInTheDocument();
  });

  it('shows a catalog-empty message when nothing is in the catalog', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [] }));
    render(<NotificationGate />);
    expect(await screen.findByText(/no notification types in the catalog yet/i)).toBeInTheDocument();
  });

  it('turning a channel off persists a per-stream overlay through the write callable', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<NotificationGate />);

    const sms = await screen.findByRole('switch', { name: /via SMS for Business/i });
    expect(sms).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sms);

    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    // Edited under the Business tab -> a business stream overlay, not the flat field.
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({
        streams: expect.objectContaining({
          business: expect.objectContaining({ channels: expect.objectContaining({ sms: false }) }),
        }),
      }),
    );
    // Optimistic update flips the visible toggle immediately.
    expect(sms).toHaveAttribute('aria-checked', 'false');
  });

  it('locking the whole notification writes a stream lockedEnabled overlay', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<NotificationGate />);

    const lock = await screen.findByRole('button', { name: /^Lock on for Business$/i });
    await userEvent.click(lock);

    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({
        streams: expect.objectContaining({
          business: expect.objectContaining({ lockedEnabled: true }),
        }),
      }),
    );
  });

  it('switches audiences: a kinfolk-only row appears only under the Kinfolk tab', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({ key: 'kb', label: 'Booking confirmed' }),
          entry({ key: 'kk', label: 'Visit report', audiences: new Set([STREAM_KINFOLK]) }),
        ],
      }),
    );
    render(<NotificationGate />);

    expect(await screen.findByText('Booking confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Visit report')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Kinfolk/ }));
    expect(await screen.findByText('Visit report')).toBeInTheDocument();
    expect(screen.queryByText('Booking confirmed')).not.toBeInTheDocument();
  });

  /**
   * #386: broadcasts used to be stamped with a key that was in no catalog, so
   * this screen never offered the operator a row for them and there was nothing
   * to switch off. The row itself is server-side (MyTribe/functions/src/
   * notifications/catalog.ts) and reaches this screen through
   * `getNotificationMatrix`; what is asserted here is that a row shaped like
   * that one is GOVERNABLE from the Kinfolk tab: it renders, and its channel
   * toggles persist under its own key.
   */
  it('governs the broadcast row from the Kinfolk tab', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({
            key: 'broadcast.message',
            label: 'Announcements from the office',
            category: 'messages',
            audience: 'kinfolk',
            audiences: new Set([STREAM_KINFOLK]),
            kinfolkFacing: true,
            description: 'One-off announcements the office sends to a group of households.',
          }),
        ],
      }),
    );
    render(<NotificationGate />);

    await userEvent.click(await screen.findByRole('tab', { name: /Kinfolk/ }));
    expect(await screen.findByText('Announcements from the office')).toBeInTheDocument();

    const sms = screen.getByRole('switch', { name: /via SMS for Kinfolk/i });
    await userEvent.click(sms);
    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'broadcast.message',
      expect.objectContaining({
        streams: expect.objectContaining({
          kinfolk: expect.objectContaining({ channels: expect.objectContaining({ sms: false }) }),
        }),
      }),
    );
  });

  it('surfaces a load failure fail-loud', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('permission-denied'));
    render(<NotificationGate />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('a save failure is fail-loud (names the callable) and reloads to server truth', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    saveBusinessNotificationOverride.mockRejectedValueOnce(new Error('nope'));
    render(<NotificationGate />);

    const sms = await screen.findByRole('switch', { name: /via SMS for Business/i });
    await userEvent.click(sms);

    expect(await screen.findByText(/saveBusinessNotificationOverride failed/i)).toBeInTheDocument();
    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
    // initial load + reload-on-failure
    await waitFor(() => expect(getNotificationMatrix).toHaveBeenCalledTimes(2));
  });
});
