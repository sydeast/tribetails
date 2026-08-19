// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationSettings, SET_BY_BUSINESS_NOTE } from './NotificationSettings';
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
    lockedChannelValues: {},
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
  // The operator switched this one on, so the lock is a lock ON.
  lockedChannelValues: { sms: true },
  lockReason: 'SMS billing alerts are required by Tribe Tails.',
});
/**
 * #491: locked, and locked OFF. `lockedEnabled` pins every channel of the row,
 * but the operator never switched sms on, so the dispatcher resolves it off.
 * The screen has to say off — it used to draw this pinned on and read-only,
 * which told a household a channel was on and beyond their control while
 * nothing was ever sent on it.
 */
const RECEIPT_READY = key({
  key: 'kincare.invoice.receipt',
  title: 'Receipt Ready',
  description: 'When a payment receipt is ready.',
  allowedChannels: ['email', 'sms'],
  lockedChannels: ['email', 'sms'],
  lockedChannelValues: { email: true, sms: false },
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
  keys: [AUNTIE_ON_THE_WAY, INVOICE_POSTED, LIVE_CHECKIN, RECEIPT_READY],
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
  // #491. Read-only and OFF is a real state, and it is the one every client got
  // wrong: what the screen shows for a locked channel has to be what the
  // dispatcher will do with it, not a flat "on".
  it('shows a locked channel the dispatcher resolves off as read-only and OFF', async () => {
    await renderLoaded();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for Receipt Ready' }) as HTMLInputElement;
    expect(smsBox.disabled).toBe(true);
    expect(smsBox.checked).toBe(false);
    // Its sibling on the same locked row IS on, so this is not the whole row
    // reading off.
    const emailBox = screen.getByRole('checkbox', { name: 'Email for Receipt Ready' }) as HTMLInputElement;
    expect(emailBox.disabled).toBe(true);
    expect(emailBox.checked).toBe(true);
  });

  it('shows an untouched key as following the category, not overridden', async () => {
    await renderLoaded();
    const pushBox = screen.getByRole('checkbox', { name: 'Push for Auntie On The Way' });
    const row = pushBox.closest('.nf-key-crow');
    expect(row?.textContent).toContain('Following category');
    expect(row?.textContent).not.toContain('Overridden');
  });
});

/**
 * #451. The category channel row used to read "Always on. Required by Tribe
 * Tails." whenever no key in the category could toggle that channel. That is a
 * promise this screen has no standing to make: the catalog's `alwaysEnabled`
 * flag is advisory (ruling #7, 2026-06-08, warn-but-allow-off — `resolveChannels`
 * has no alwaysEnabled check), so Tribe Tails can switch the notification off
 * and it genuinely stops sending. What is true, and all the line now says, is
 * that the household is not the one who decides and this is not where it
 * changes. Asserted on the rendered text, not on a class name, and the cards
 * default to expanded so nothing here is hidden behind a fold.
 */
describe('a channel the household cannot change', () => {
  const LOCKED_ONLY = key({
    key: 'auth.password.reset',
    title: 'Password Reset Link',
    description: 'The link that gets you back into your account.',
    allowedChannels: ['email'],
    lockedChannels: ['email'],
  });
  const ACCOUNT_CATEGORY: CategoryDto = {
    id: 'account',
    title: 'Account',
    description: 'Account changes and recovery messages.',
    keys: [LOCKED_ONLY],
  };
  async function renderLockedCategory() {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [ACCOUNT_CATEGORY],
      schemaVersion: 1,
    } satisfies GetNotificationCatalogResult);
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: BASE_PREFS, updatedAtMs: null });
    const result = renderScreen();
    await waitFor(() => expect(screen.getByText('Password Reset Link')).toBeTruthy());
    return result;
  }
  it('names who decides on the category row, on both the row and the key line', async () => {
    await renderLockedCategory();
    // One on the category channel row, one on the per-key channel row.
    expect(screen.getAllByText(SET_BY_BUSINESS_NOTE)).toHaveLength(2);
  });
  it('never tells the household the notification is always on', async () => {
    await renderLockedCategory();
    expect(screen.queryByText(/always on/i)).toBeNull();
    expect(screen.queryByText('Always on. Required by Tribe Tails.')).toBeNull();
    const emailBox = screen.getByRole('checkbox', {
      name: 'Email for Password Reset Link',
    }) as HTMLInputElement;
    expect(emailBox.disabled).toBe(true);
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

  // Task 27b: web used to OMIT `byKey` when there was nothing in it, while
  // Compose sent `{}`. That was the one cell where the two clients put
  // different bytes on the wire, and it sat on exactly the path this work is
  // about. Both send an empty map now, so a reader does not have to re-derive
  // that the two are equivalent under the handler's mergeFields write.
  it('an untouched session still sends byKey, as an empty map', async () => {
    await renderLoaded();
    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byKey).toEqual({});
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

describe('reverting an override', () => {
  // Task 27a: byKey is an override, absence means inherit. Toggling a key
  // channel back to the value it would have inherited anyway must clear the
  // override, not pin an explicit duplicate of it — otherwise the key
  // silently stops following future category changes forever.
  it('toggling a key channel back to its inherited value clears the override entirely', async () => {
    await renderLoaded();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for Auntie On The Way' }) as HTMLInputElement;
    expect(smsBox.checked).toBe(false); // inherits category default (sms: false)

    await userEvent.click(smsBox); // create an override: sms true
    expect(smsBox.checked).toBe(true);
    await userEvent.click(smsBox); // undo: back to the inherited value (false)
    expect(smsBox.checked).toBe(false);

    const row = smsBox.closest('.nf-key-crow');
    expect(row?.textContent).toContain('Following category');
    expect(row?.textContent).not.toContain('Overridden');

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byKey).toEqual({});
  });

  it('leaves other overridden channels on the same key alone when one channel reverts', async () => {
    await renderLoaded();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for Auntie On The Way' }) as HTMLInputElement;
    const pushBox = screen.getByRole('checkbox', { name: 'Push for Auntie On The Way' }) as HTMLInputElement;

    await userEvent.click(smsBox); // override sms: true
    await userEvent.click(pushBox); // override push: false
    await userEvent.click(smsBox); // undo sms back to inherited (false)

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byKey).toEqual({ 'kincare.auntie.on_my_way': { push: false } });
  });
});

describe('category control and existing overrides', () => {
  // Task 27a defect #2 (Compose side): a category control must not silently
  // destroy deliberate per-key choices. The model this task adopts is that
  // byKey always wins over byCategory (already true both server-side and in
  // keyChannelChecked), so the category control simply changes what
  // unoverridden keys inherit — it must never touch byKey itself.
  it('does not clear an existing per-key override when the category master switch is flipped', async () => {
    await renderLoaded();
    const smsBox = screen.getByRole('checkbox', { name: 'SMS for Auntie On The Way' }) as HTMLInputElement;
    await userEvent.click(smsBox); // create an override: sms true

    const masterBox = screen.getByRole('checkbox', { name: 'All in category: Visit Updates' });
    await userEvent.click(masterBox);

    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Save Notification Preferences/ }));

    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const saved = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(saved.byKey).toEqual({ 'kincare.auntie.on_my_way': { sms: true } });
  });

  it('explains that per-key overrides survive the category control', async () => {
    await renderLoaded();
    expect(screen.getByText(/won.t change when you flip this/i)).toBeTruthy();
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
