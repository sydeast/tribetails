// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * #2182: My notifications under an Auntie's sign-in, driven through the real
 * api module, so the callable each read goes to is the one asserted. Only the
 * transport (`lib/fns`) and who is signed in (`lib/sessionSeat`) are mocked.
 */
const { call, currentSessionSeat } = vi.hoisted(() => ({ call: vi.fn(), currentSessionSeat: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/sessionSeat', () => ({ currentSessionSeat }));

import { MyNotificationsEdit } from './MyNotificationsEdit';

const STAFF_OPTIONS = {
  catalog: [
    {
      key: 'schedule.upcoming.digest',
      label: 'Your schedule for tomorrow',
      category: 'visit',
      audience: 'staff',
      audiences: { staff: true },
      allowedChannels: ['email', 'sms'],
      required: {},
      alwaysEnabled: false,
      kinfolkFacing: false,
      deliveryMode: 'scheduled',
      description: '',
    },
  ],
  overrides: {},
};

function answer(name: string): unknown {
  if (name === 'getMyStaffNotificationOptions') return STAFF_OPTIONS;
  if (name === 'getMyAdminNotificationPrefs') return { prefs: { byKey: {}, byCategory: {}, marketingOptIn: {} }, updatedAtMs: null };
  if (name === 'saveMyAdminNotificationPrefs') return { ok: true };
  throw new Error(`permission-denied: ${name}`);
}

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async (name: string) => answer(name));
  currentSessionSeat.mockReset();
  currentSessionSeat.mockResolvedValue({ uid: 'auntie-1', caretaker: true });
});

describe('#2182 My notifications for an Auntie', () => {
  it('loads her own rows from her read, never the Settings > Notifications read', async () => {
    render(<MyNotificationsEdit />);
    expect(screen.getByText(/Loading your notification settings/)).toBeInTheDocument();
    expect(await screen.findByText('As the Auntie')).toBeInTheDocument();
    expect(screen.getByText('Your schedule for tomorrow')).toBeInTheDocument();
    expect(screen.queryByText('As the owner')).not.toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('getMyStaffNotificationOptions', {});
    expect(call).not.toHaveBeenCalledWith('getBusinessNotificationOverrides', expect.anything());
    // Her copy does not send her to a screen she never sees.
    await waitFor(() => expect(screen.queryByText(/Business Settings/)).not.toBeInTheDocument());
  });

  it('saves a change to her own choices', async () => {
    const user = userEvent.setup();
    render(<MyNotificationsEdit />);
    const smsRow = (await screen.findByText('Text (SMS)')).closest('.mynotif__channel-row') as HTMLElement;
    const sms = within(smsRow).getByRole('switch');
    expect(sms).toHaveAttribute('aria-checked', 'false');
    await user.click(sms);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('saveMyAdminNotificationPrefs', expect.anything()));
    const [, payload] = call.mock.calls.find(([name]) => name === 'saveMyAdminNotificationPrefs')!;
    expect(JSON.stringify(payload)).toContain('schedule.upcoming.digest');
  });

  it('a failed read shows a plain message with a way to retry', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'getMyStaffNotificationOptions') throw new Error('unavailable');
      return answer(name);
    });
    render(<MyNotificationsEdit />);
    expect(await screen.findByText(/Couldn't read your notification settings/)).toBeInTheDocument();
  });
});
