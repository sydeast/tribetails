// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationSettings } from './NotificationSettings';
import type {
  CategoryDto,
  GetMyNotificationPrefsResult,
  GetNotificationCatalogResult,
  NotificationKeyDto,
  SaveMyNotificationPrefsResult,
  UserNotificationPrefs,
} from '../api/notificationsApi';

/**
 * P7: per-key notification toggles. Covers the expand-to-key-level behavior
 * NotificationSettings.tsx grew; see notificationsApi.test.ts for the pure
 * keyChannelChecked/keyChannelOverridden/keyLockedChannels helpers these
 * assertions build on.
 */

const mocks = vi.hoisted(() => ({
  getNotificationCatalog: vi.fn<() => Promise<GetNotificationCatalogResult>>(),
  getMyNotificationPrefs: vi.fn<() => Promise<GetMyNotificationPrefsResult>>(),
  saveMyNotificationPrefs: vi.fn<(prefs: UserNotificationPrefs) => Promise<SaveMyNotificationPrefsResult>>(),
}));

vi.mock('../api/notificationsApi', async () => {
  const actual = await vi.importActual<typeof import('../api/notificationsApi')>('../api/notificationsApi');
  return {
    ...actual,
    getNotificationCatalog: () => mocks.getNotificationCatalog(),
    getMyNotificationPrefs: () => mocks.getMyNotificationPrefs(),
    saveMyNotificationPrefs: (prefs: UserNotificationPrefs) => mocks.saveMyNotificationPrefs(prefs),
  };
});

vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

function key(overrides: Partial<NotificationKeyDto>): NotificationKeyDto {
  return {
    key: 'test.key',
    title: 'Test key',
    description: 'A test key.',
    allowedChannels: ['email', 'push'],
    required: [],
    lockedChannels: [],
    marketingCategory: null,
    lockReason: null,
    ...overrides,
  };
}

const AUNTIE_ON_THE_WAY = key({
  key: 'kincare.auntie.on_my_way',
  title: 'Auntie On The Way',
  description: 'When your Auntie is en route.',
  allowedChannels: ['push', 'email', 'sms'],
  lockedChannels: [],
});

const INVOICE_POSTED = key({
  key: 'kincare.invoice.posted',
  title: 'New Invoice Posted',
  description: 'When a new invoice is ready.',
  allowedChannels: ['email', 'sms'],
  lockedChannels: ['sms'],
  lockReason: 'SMS billing alerts are required by Tribe Tails.',
});

const LIVE_CHECKIN = key({
  key: 'kincare.checkin.push_only',
  title: 'Live Check-In',
  description: 'A live ping the moment your Auntie checks in.',
  allowedChannels: ['push'],
  lockedChannels: [],
});

const VISIT_CATEGORY: CategoryDto = {
  id: 'visit',
  title: 'Visit Updates',
  description: 'Check ins and visit notices.',
  keys: [AUNTIE_ON_THE_WAY, INVOICE_POSTED, LIVE_CHECKIN],
};

const CATALOG: GetNotificationCatalogResult = { categories: [VISIT_CATEGORY], schemaVersion: 1 };

const BASE_PREFS: UserNotificationPrefs = {
  byCategory: { visit: { push: true, email: true, sms: false } },
  marketingOptIn: {},
};

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationSettings />
    </QueryClientProvider>,
  );
}

async function renderLoaded() {
  mocks.getNotificationCatalog.mockResolvedValue(CATALOG);
  mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: BASE_PREFS, updatedAtMs: 1_700_000_000_000 });
  const result = renderScreen();
  await waitFor(() => expect(screen.getByText('Auntie On The Way')).toBeTruthy());
  return result;
}

beforeEach(() => {
  mocks.getNotificationCatalog.mockReset();
  mocks.getMyNotificationPrefs.mockReset();
  mocks.saveMyNotificationPrefs.mockReset();
});

describe('per-key expansion', () => {
  it('lists every key in the category with its title', async () => {
    await renderLoaded();
    expect(screen.getByText('Auntie On The Way')).toBeTruthy();
    expect(screen.getByText('New Invoice Posted')).toBeTruthy();
    expect(screen.getByText('Live Check-In')).toBeTruthy();
  });

  it('only renders channels the key allows', async () => {
    await renderLoaded();
    // Live Check-In only allows push, so there's no Email/SMS row for it.
    expect(screen.queryByRole('checkbox', { name: 'Email for Live Check-In' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'SMS for Live Check-In' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Push for Live Check-In' })).toBeTruthy();
  });

  it('shows a locked channel as read-only with its lockReason, and it cannot be toggled', async () => {
    await renderLoaded();
    expect(screen.getByText('SMS billing alerts are required by Tribe Tails.')).toBeTruthy();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for New Invoice Posted' }) as HTMLInputElement;
    expect(smsBox.disabled).toBe(true);
    expect(smsBox.checked).toBe(true);
  });

  it('shows an untouched key as following the category, not overridden', async () => {
    await renderLoaded();
    const pushBox = screen.getByRole('checkbox', { name: 'Push for Auntie On The Way' });
    const row = pushBox.closest('.nf-key-crow');
    expect(row?.textContent).toContain('Following category');
    expect(row?.textContent).not.toContain('Overridden');
  });
});

describe('saving byKey', () => {
  it('toggling a key channel writes byKey[key][channel] and leaves byCategory untouched', async () => {
    await renderLoaded();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for Auntie On The Way' }) as HTMLInputElement;
    expect(smsBox.checked).toBe(false); // inherits category default (sms: false)

    await userEvent.click(smsBox);
    expect(smsBox.checked).toBe(true);

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byCategory).toEqual(BASE_PREFS.byCategory);
    expect(saved.byKey).toEqual({ 'kincare.auntie.on_my_way': { sms: true } });
  });

  it('creates no byKey entry for keys the user never touched', async () => {
    await renderLoaded();
    const pushBox = screen.getByRole('checkbox', { name: 'Push for Auntie On The Way' }) as HTMLInputElement;
    await userEvent.click(pushBox); // touch exactly one channel on exactly one key

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(Object.keys(saved.byKey ?? {})).toEqual(['kincare.auntie.on_my_way']);
    expect(saved.byKey?.['kincare.invoice.posted']).toBeUndefined();
    expect(saved.byKey?.['kincare.checkin.push_only']).toBeUndefined();
  });

  it('an untouched session omits byKey from the save payload entirely', async () => {
    await renderLoaded();
    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byKey).toBeUndefined();
  });

  it('sends byCategory, byKey and marketingOptIn together in one call', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Push for Auntie On The Way' }));

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved).toHaveProperty('byCategory');
    expect(saved).toHaveProperty('byKey');
    expect(saved).toHaveProperty('marketingOptIn');
  });
});

describe('failed save', () => {
  it('surfaces the error and does not claim the preferences were saved', async () => {
    const { container } = await renderLoaded();
    mocks.saveMyNotificationPrefs.mockRejectedValue(new Error('network down'));

    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(screen.getByText('Couldn’t save. Try again.')).toBeTruthy());
    expect(container.querySelector('.savedchip.show')).toBeNull();
  });
});
