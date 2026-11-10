// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTIFICATION_FOLD_STORAGE_KEY, NotificationSettings, setByBusinessNote } from './NotificationSettings';
import type {
  CategoryDto,
  GetMyNotificationPrefsResult,
  GetNotificationCatalogResult,
  NotificationKeyDto,
  NotificationPrefsPatch,
  SaveMyNotificationPrefsResult,
  UserNotificationPrefs,
} from '../api/notificationsApi';
import { warmSave } from '../lib/warmSave';

/**
 * P7: per-key notification toggles. Covers the expand-to-key-level behavior
 * NotificationSettings.tsx grew; see notificationsApi.test.ts for the pure
 * keyChannelChecked/keyChannelOverridden/keyLockedChannels helpers these
 * assertions build on.
 */

const mocks = vi.hoisted(() => ({
  getNotificationCatalog: vi.fn<() => Promise<GetNotificationCatalogResult>>(),
  getMyNotificationPrefs: vi.fn<() => Promise<GetMyNotificationPrefsResult>>(),
  saveMyNotificationPrefs: vi.fn<(patch: NotificationPrefsPatch) => Promise<SaveMyNotificationPrefsResult>>(),
}));

vi.mock('../api/notificationsApi', async () => {
  const actual = await vi.importActual<typeof import('../api/notificationsApi')>('../api/notificationsApi');
  return {
    ...actual,
    getNotificationCatalog: () => mocks.getNotificationCatalog(),
    getMyNotificationPrefs: () => mocks.getMyNotificationPrefs(),
    saveMyNotificationPrefs: (patch: NotificationPrefsPatch) => mocks.saveMyNotificationPrefs(patch),
  };
});

vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/PushPrompt', () => ({
  PushPrompt: (props: { ignoreDismissal?: boolean }) => (
    <span data-testid="push-prompt" data-ignore-dismissal={String(Boolean(props.ignoreDismissal))} />
  ),
}));
// #1369: the footnote reads the business name from getMyHome; no network in a unit test.
vi.mock('../api/portal', () => ({ getMyHome: vi.fn().mockResolvedValue({ businessName: '' }) }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));

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
  // #1545: a fold is remembered in this browser; no test inherits another's.
  localStorage.clear();
});

describe('this device notifications card (#1787)', () => {
  it('shows the same card as Home, and ignores the Home dismissal so Retry is never hidden here', async () => {
    await renderLoaded();
    const card = screen.getByTestId('push-prompt');
    expect(card.getAttribute('data-ignore-dismissal')).toBe('true');
  });
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
    expect(screen.getAllByText(setByBusinessNote(''))).toHaveLength(2);
    expect(screen.getAllByText('Set by your Auntie. Can’t be changed here.')).toHaveLength(2);
  });
  it('names the business from settings when it is set (#1381)', async () => {
    const { getMyHome } = await import('../api/portal');
    vi.mocked(getMyHome).mockResolvedValue({ businessName: 'Test Business' } as never);
    try {
      await renderLockedCategory();
      await waitFor(() => expect(screen.getAllByText('Set by Test Business. Can’t be changed here.')).toHaveLength(2));
      expect(screen.queryByText(/your Auntie/)).toBeNull();
    } finally {
      vi.mocked(getMyHome).mockResolvedValue({ businessName: '' } as never);
    }
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
/**
 * A stand-in for the server: the save mock merges the patch into `stored`, and
 * the prefs read returns `stored`. The screen shows what the server holds after
 * a save, so the tests need a server that remembers.
 */
let stored: UserNotificationPrefs;
function installFakeServer() {
  stored = structuredClone(BASE_PREFS);
  mocks.getMyNotificationPrefs.mockImplementation(async () => ({ prefs: structuredClone(stored), updatedAtMs: 1 }));
  mocks.saveMyNotificationPrefs.mockImplementation(async (patch) => {
    const byCategory = { ...(stored.byCategory ?? {}) };
    for (const [cat, ch] of Object.entries(patch.byCategory ?? {})) byCategory[cat] = { ...(byCategory[cat] ?? {}), ...ch };
    const byKey = { ...(stored.byKey ?? {}) };
    for (const [k, chans] of Object.entries(patch.byKey ?? {})) {
      if (chans === null) {
        delete byKey[k];
        continue;
      }
      const next = { ...(byKey[k] ?? {}) } as Record<string, boolean>;
      for (const [c, v] of Object.entries(chans)) {
        if (v === null) delete next[c];
        else if (v !== undefined) next[c] = v;
      }
      if (Object.keys(next).length === 0) delete byKey[k];
      else byKey[k] = next;
    }
    stored = { ...stored, byCategory, byKey, marketingOptIn: { ...(stored.marketingOptIn ?? {}), ...(patch.marketingOptIn ?? {}) } };
    return { ok: true };
  });
}
async function renderWithServer() {
  mocks.getNotificationCatalog.mockResolvedValue(CATALOG);
  installFakeServer();
  const result = renderScreen();
  await waitFor(() => expect(screen.getByText('Auntie On The Way')).toBeTruthy());
  return result;
}
const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
describe('save on change (#1292)', () => {
  it('has no Save button; each toggle saves itself', async () => {
    await renderWithServer();
    expect(screen.queryByRole('button', { name: /Save Notification Preferences/ })).toBeNull();
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
  });
  it('a key toggle sends a patch naming only that key and channel', async () => {
    await renderWithServer();
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    expect(mocks.saveMyNotificationPrefs.mock.calls[0]![0]).toEqual({
      byKey: { 'kincare.auntie.on_my_way': { sms: true } },
    });
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(true));
    await waitFor(() => expect(screen.getByText(/Saved\./).closest('.savedchip')?.className).toContain('show'));
  });
  it('a category channel row sends only that channel', async () => {
    await renderWithServer();
    const rows = screen.getAllByRole('checkbox').filter((c) => !c.getAttribute('aria-label'));
    // The category SMS row is the unlabeled sms switch whose key rows are labeled; find it by its row text.
    const smsRow = rows.find((c) => c.closest('.crow')?.textContent?.startsWith('\u{1F4AC}SMS'));
    expect(smsRow).toBeTruthy();
    await userEvent.click(smsRow!);
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    expect(mocks.saveMyNotificationPrefs.mock.calls[0]![0]).toEqual({ byCategory: { visit: { sms: true } } });
  });
  it('creates no byKey entry for keys the user never touched', async () => {
    await renderWithServer();
    await userEvent.click(box('Push for Auntie On The Way'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    const patch = mocks.saveMyNotificationPrefs.mock.calls[0]![0];
    expect(Object.keys(patch.byKey ?? {})).toEqual(['kincare.auntie.on_my_way']);
  });
  it('pessimistic: every switch is disabled and a Saving cue shows until the server answers', async () => {
    await renderWithServer();
    let release!: () => void;
    mocks.saveMyNotificationPrefs.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    );
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(screen.getByText('Saving your change…')).toBeTruthy());
    expect(box('SMS for Auntie On The Way').checked).toBe(false); // nothing moves before confirmation
    expect(box('Push for Auntie On The Way').disabled).toBe(true);
    expect(box('All in category: Visit Updates').disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.queryByText('Saving your change…')).toBeNull());
  });
  it('on failure the switch stays where it was and a message says so', async () => {
    const { container } = await renderWithServer();
    mocks.saveMyNotificationPrefs.mockRejectedValueOnce(new Error('network down'));
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));
    expect(screen.getByRole('alert').textContent).toContain('back where it was');
    expect(box('SMS for Auntie On The Way').checked).toBe(false);
    expect(box('SMS for Auntie On The Way').disabled).toBe(false); // the household can try again
    expect(container.querySelector('.savedchip.show')).toBeNull();
  });
  it('the saved choice is what a reload shows (SMS stays on)', async () => {
    const first = await renderWithServer();
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    first.unmount();
    renderScreen();
    await waitFor(() => expect(screen.getByText('Auntie On The Way')).toBeTruthy());
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(true));
  });
});
describe('reverting an override', () => {
  // Task 27a: byKey is an override, absence means inherit. Toggling a key
  // channel back to the value it would have inherited anyway must clear the
  // override (sent as null), not pin an explicit duplicate of it.
  it('toggling a key channel back to its inherited value sends null to clear the override', async () => {
    await renderWithServer();
    await userEvent.click(box('SMS for Auntie On The Way')); // override: true
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(true));
    const row = box('SMS for Auntie On The Way').closest('.nf-key-crow');
    expect(row?.textContent).toContain('Overridden');
    await userEvent.click(box('SMS for Auntie On The Way')); // back to inherited (false)
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(2));
    expect(mocks.saveMyNotificationPrefs.mock.calls[1]![0]).toEqual({
      byKey: { 'kincare.auntie.on_my_way': { sms: null } },
    });
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(false));
    expect(box('SMS for Auntie On The Way').closest('.nf-key-crow')?.textContent).toContain('Following category');
  });
  it('leaves other overridden channels on the same key alone when one channel reverts', async () => {
    await renderWithServer();
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(true));
    await userEvent.click(box('Push for Auntie On The Way')); // push: false
    await waitFor(() => expect(box('Push for Auntie On The Way').checked).toBe(false));
    await userEvent.click(box('SMS for Auntie On The Way')); // undo sms
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(stored.byKey).toEqual({ 'kincare.auntie.on_my_way': { push: false } }));
  });
});
describe('category control and existing overrides', () => {
  it('flipping the category master never names byKey, so overrides survive', async () => {
    await renderWithServer();
    await userEvent.click(box('SMS for Auntie On The Way'));
    await waitFor(() => expect(box('SMS for Auntie On The Way').checked).toBe(true));
    await userEvent.click(box('All in category: Visit Updates'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(2));
    const patch = mocks.saveMyNotificationPrefs.mock.calls[1]![0];
    expect(patch.byKey).toBeUndefined();
    expect(stored.byKey).toEqual({ 'kincare.auntie.on_my_way': { sms: true } });
  });
  it('says that per-key overrides survive the category control in a tooltip, not a line under the panel (#1359)', async () => {
    const { container } = await renderLoaded();
    const tip = screen.getAllByRole('tooltip', { hidden: true })[0]!;
    expect(tip.textContent).toMatch(/won.t change when you flip this/i);
    const trigger = screen.getAllByRole('button', { name: 'About this switch' })[0]!;
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
    expect(container.querySelector('p.nf-helper')).toBeNull();
  });
});
/**
 * #1545 (walk 2026-11-04): the screen is a long scroll. A shortcut row at the
 * top lists the catalog's sections and each section head folds its body, with
 * the fold remembered in this browser. jsdom cannot see the fold itself (the
 * body is drawn at zero height by CSS), so these assert the state carriers:
 * aria-expanded, aria-controls, the body's class and `inert`, and storage.
 */
describe('section shortcuts and folds (#1545)', () => {
  const SCHEDULE: CategoryDto = {
    id: 'schedule',
    title: 'Upcoming Care',
    description: 'x',
    keys: [key({ key: 'sched.reminder', title: 'Visit tomorrow', description: 'The day before.', allowedChannels: ['push', 'email'] })],
  };
  const ACCOUNT: CategoryDto = {
    id: 'account',
    title: 'Account',
    description: 'Account notices.',
    keys: [key({ key: 'auth.signin', title: 'New sign in', description: 'A new device signed in.', allowedChannels: ['email'] })],
  };
  const scrolled: Element[] = [];
  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollIntoView;
  });
  async function renderThree() {
    mocks.getNotificationCatalog.mockResolvedValue({ categories: [VISIT_CATEGORY, SCHEDULE, ACCOUNT], schemaVersion: 1 });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: BASE_PREFS, updatedAtMs: 1 });
    const result = renderScreen();
    await waitFor(() => expect(screen.getByText('New sign in')).toBeTruthy());
    return result;
  }
  const nav = () => screen.getByRole('navigation', { name: 'Notification sections' });
  const chips = () => within(nav()).getAllByRole('button');
  const head = (id: string) => document.getElementById(`nf-head-${id}`) as HTMLButtonElement;
  const section = (id: string) => document.getElementById(`nf-section-${id}`) as HTMLElement;

  it('lists exactly the catalog sections, in catalog order, with the title each card shows', async () => {
    await renderThree();
    // The two columns draw schedule last (the aside); the row keeps catalog order.
    expect(chips().map((b) => b.textContent)).toEqual(['Visit Updates', 'Schedule Reminders', 'Account']);
    expect(chips()[0]).toHaveAttribute('aria-current', 'true');
    expect(chips()[1]).not.toHaveAttribute('aria-current');
    expect(chips()[2]).not.toHaveAttribute('aria-current');
  });
  it('a chip tap marks it current, focuses the section head and scrolls that section into view', async () => {
    await renderThree();
    await userEvent.click(chips()[2]!);
    expect(chips()[2]).toHaveAttribute('aria-current', 'true');
    expect(chips()[0]).not.toHaveAttribute('aria-current');
    expect(scrolled).toEqual([section('account')]);
    expect(document.activeElement).toBe(head('account'));
  });
  it('the section head folds its body, flips aria-expanded, and this browser remembers it', async () => {
    const first = await renderThree();
    expect(head('visit')).toHaveAttribute('aria-expanded', 'true');
    expect(head('visit')).toHaveAttribute('aria-controls', 'nf-body-visit');
    expect(document.getElementById('nf-body-visit')).toBeTruthy();
    await userEvent.click(head('visit'));
    expect(head('visit')).toHaveAttribute('aria-expanded', 'false');
    const body = document.getElementById('nf-body-visit')!;
    expect(body.className).toContain('collapsed');
    expect(body.hasAttribute('inert')).toBe(true);
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_FOLD_STORAGE_KEY)!)).toEqual(['visit']);
    // The master switch sits above the fold and stays reachable.
    expect(box('All in category: Visit Updates').disabled).toBe(false);
    // Only the folded section is remembered; the others open as before.
    first.unmount();
    await renderThree();
    expect(head('visit')).toHaveAttribute('aria-expanded', 'false');
    expect(head('account')).toHaveAttribute('aria-expanded', 'true');
    expect(head('schedule')).toHaveAttribute('aria-expanded', 'true');
  });
  it('a chip tap on a folded section opens it', async () => {
    localStorage.setItem(NOTIFICATION_FOLD_STORAGE_KEY, JSON.stringify(['account']));
    await renderThree();
    expect(head('account')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(chips()[2]!);
    expect(head('account')).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('nf-body-account')!.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem(NOTIFICATION_FOLD_STORAGE_KEY)).toBe('[]');
  });
  it('opens every section when the stored value is not a list of ids', async () => {
    localStorage.setItem(NOTIFICATION_FOLD_STORAGE_KEY, '{not json');
    await renderThree();
    expect(head('visit')).toHaveAttribute('aria-expanded', 'true');
    expect(head('account')).toHaveAttribute('aria-expanded', 'true');
  });
  it('the Expand and Collapse buttons drive the same fold as the head', async () => {
    await renderThree();
    await userEvent.click(within(section('visit')).getByRole('button', { name: 'Collapse' }));
    expect(head('visit')).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_FOLD_STORAGE_KEY)!)).toEqual(['visit']);
    await userEvent.click(within(section('visit')).getByRole('button', { name: 'Expand' }));
    expect(head('visit')).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem(NOTIFICATION_FOLD_STORAGE_KEY)).toBe('[]');
  });
});
describe('mixed master state (#1317)', () => {
  it('reads mixed, not off, when Email is on and Push and SMS are off', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [
        {
          id: 'invoice',
          title: 'Invoices & Payments',
          description: 'Invoice updates.',
          keys: [key({ key: 'invoice.new', title: 'New invoice', description: 'Invoice sent.', allowedChannels: ['push', 'email', 'sms'] })],
        },
      ],
      schemaVersion: 1,
    });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: { byCategory: { invoice: { email: true } } }, updatedAtMs: 1 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('New invoice')).toBeTruthy());
    const master = box('All in category: Invoices & Payments');
    // #1769: `indeterminate` is a DOM property set from a passive effect, so it
    // can trail the commit the text above waited for. Wait for it too.
    await waitFor(() => expect(master.indeterminate).toBe(true));
    expect(master.getAttribute('aria-checked')).toBe('mixed');
    expect(master.checked).toBe(false);
  });
  it('clicking a mixed master turns every channel on', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [
        {
          id: 'invoice',
          title: 'Invoices & Payments',
          description: 'Invoice updates.',
          keys: [key({ key: 'invoice.new', title: 'New invoice', description: 'Invoice sent.', allowedChannels: ['push', 'email', 'sms'] })],
        },
      ],
      schemaVersion: 1,
    });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: { byCategory: { invoice: { email: true } } }, updatedAtMs: 1 });
    mocks.saveMyNotificationPrefs.mockResolvedValue({ ok: true });
    renderScreen();
    await waitFor(() => expect(screen.getByText('New invoice')).toBeTruthy());
    await userEvent.click(box('All in category: Invoices & Payments'));
    await waitFor(() => expect(mocks.saveMyNotificationPrefs).toHaveBeenCalledTimes(1));
    expect(mocks.saveMyNotificationPrefs.mock.calls[0]![0]).toEqual({
      byCategory: { invoice: { push: true, email: true, sms: true } },
    });
  });
});
describe('household-facing copy (#1317)', () => {
  const MARKETING: CategoryDto = {
    id: 'marketing',
    title: 'Newsletters & Community',
    description: 'Opt-in announcements.',
    keys: [
      key({ key: 'newsletter.announcement', title: 'Newsletters', description: 'Newsletters.', allowedChannels: ['push', 'email', 'sms'], marketingCategory: 'newsletter' }),
    ],
  };
  async function renderMarketing() {
    mocks.getNotificationCatalog.mockResolvedValue({ categories: [MARKETING], schemaVersion: 1 });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: {}, updatedAtMs: 1 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Marketing push')).toBeTruthy());
  }
  it('lists one row per channel under Newsletters & Community, with push labeled push', async () => {
    await renderMarketing();
    expect(screen.getAllByText('Marketing SMS')).toHaveLength(1);
    expect(screen.getAllByText('Marketing email')).toHaveLength(1);
    expect(screen.getAllByText('Marketing push')).toHaveLength(1);
  });
  it('prints the household wording, not the operator text, when the catalog sends both (#1359)', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [
        {
          id: 'visit',
          title: 'Visit Updates',
          description: 'x',
          keys: [
            key({
              key: 'kincare.changed',
              title: 'KinCare updated or change requested',
              description: 'Kinfolk/Auntie updated, deleted, or requested changes to KinCare.',
              householdDescription: 'When a KinCare visit on your schedule is changed.',
              householdTitle: 'A visit on your schedule changed',
              allowedChannels: ['email'],
            }),
            key({ key: 'old', title: 'Old callable', description: 'Sent by an older server.', allowedChannels: ['email'] }),
          ],
        },
      ],
      schemaVersion: 1,
    });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: {}, updatedAtMs: 1 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Old callable')).toBeTruthy());
    expect(screen.getByText('When a KinCare visit on your schedule is changed.')).toBeTruthy();
    expect(screen.queryByText(/Kinfolk\/Auntie updated/)).toBeNull();
    // #1372: the title is the household's wording too; the aria-label follows it.
    expect(screen.getByText('A visit on your schedule changed')).toBeTruthy();
    expect(screen.queryByText('KinCare updated or change requested')).toBeNull();
    // A callable that predates the field still renders; the screen falls back.
    expect(screen.getByText('Sent by an older server.')).toBeTruthy();
  });
  it('does not repeat the title as its own subtitle', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [
        {
          id: 'visit',
          title: 'Visit Updates',
          description: 'x',
          keys: [
            key({ key: 'a', title: 'KinCare booking confirmed', description: 'KinCare booking confirmed.', allowedChannels: ['email'] }),
            key({ key: 'b', title: 'Auntie arrived', description: 'When your Auntie gets there.', allowedChannels: ['email'] }),
          ],
        },
      ],
      schemaVersion: 1,
    });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: {}, updatedAtMs: 1 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Auntie arrived')).toBeTruthy());
    expect(screen.queryByText('KinCare booking confirmed.')).toBeNull();
    expect(screen.getByText('KinCare booking confirmed')).toBeTruthy();
    expect(screen.getByText('When your Auntie gets there.')).toBeTruthy();
  });
  it('explains the Suggestion badge in a tooltip', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({
      categories: [{ id: 'schedule', title: 'Upcoming Care', description: 'x', keys: [AUNTIE_ON_THE_WAY] }],
      schemaVersion: 1,
    });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: {}, updatedAtMs: 1 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Suggestion')).toBeTruthy());
    expect(screen.getByText('Suggestion').getAttribute('title')).toMatch(/suggested/i);
  });
});
/**
 * #1553: the shortcut row is pinned under the sticky top nav, so it is still
 * there after a jump. jsdom loads no stylesheet and computes no layout, so the
 * rendered row is checked for the class that carries the rule, and the rule
 * itself is read from the sheet: sticky at the nav height, one line at a fixed
 * height, and a section scroll margin that clears both.
 */
describe('pinned section shortcuts (#1553)', () => {
  const stylesDir = resolve(__dirname, '../styles');
  const sheet = (name: string) => readFileSync(resolve(stylesDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (css: string, selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`(^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    if (!m) throw new Error(`no ${selector} rule`);
    return m[2]!.replace(/\s+/g, ' ');
  };
  it('draws the row with the class that pins it', async () => {
    mocks.getNotificationCatalog.mockResolvedValue({ categories: [VISIT_CATEGORY], schemaVersion: 1 });
    mocks.getMyNotificationPrefs.mockResolvedValue({ prefs: BASE_PREFS, updatedAtMs: 1 });
    renderScreen();
    const row = await screen.findByRole('navigation', { name: 'Notification sections' });
    expect(row).toHaveClass('nf-jump');
  });
  it('sticks the row under the top nav, one line at a fixed height, over a glass wash', () => {
    const css = sheet('notifications.css');
    const jump = rule(css, '.nf-jump');
    expect(jump).toMatch(/position: sticky;/);
    expect(jump).toMatch(/top: var\(--nav-h\);/);
    expect(jump).toMatch(/height: var\(--nf-jump-h\);/);
    expect(jump).toMatch(/flex-wrap: nowrap;/);
    expect(jump).toMatch(/background: var\(--glass\);/);
    expect(jump).toMatch(/backdrop-filter: blur\(/);
    // Above the cards, under the nav (20) and the save notice (19).
    const z = Number(jump.match(/z-index: (\d+);/)?.[1]);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(19);
    expect(css).toMatch(/--nf-jump-h: \d+px;/);
  });
  it('keeps the section scroll margin in step with the nav and the row', () => {
    expect(sheet('tokens.css')).toMatch(/--nav-h: \d+px;/);
    expect(rule(sheet('notifications.css'), '.nf-section')).toMatch(
      /scroll-margin-top: calc\(var\(--nav-h\) \+ var\(--nf-jump-h\) \+ \d+px\);/,
    );
  });
});
// #1554: the 2026-09-11 ruling allows no explanatory copy under a panel title.
// The category description is the title's tooltip and its accessible description.
describe('category description', () => {
  it('is a tooltip on the title, not a line under it', async () => {
    const { container } = await renderLoaded();
    const desc = VISIT_CATEGORY.description;
    const sub = Array.from(container.querySelectorAll('.sub')).find((n) => n.textContent === desc);
    expect(sub).toBeUndefined();
    const only = screen.getByText(desc);
    expect(only.className).toBe('nf-visually-hidden');

    const fold = container.querySelector('#nf-head-visit') as HTMLElement;
    expect(fold).toHaveAccessibleDescription(desc);
    const tip = screen.getByRole('button', { name: 'About Visit Updates' });
    expect(tip).toHaveAttribute('title', desc);
    const holder = tip.parentElement as HTMLElement;
    expect(within(holder).queryByRole('tooltip')).toBeNull();
    await userEvent.click(tip);
    expect(within(holder).getByRole('tooltip')).toHaveTextContent(desc);
  });
});

describe('NotificationSettings: warm on open (#1504)', () => {
  it('wakes saveMyNotificationPrefs once the toggles are seeded', async () => {
    await renderLoaded();
    await waitFor(() => expect(vi.mocked(warmSave).mock.calls).toEqual([['saveMyNotificationPrefs']]));
  });
  it('wakes nothing while the prefs have not loaded', async () => {
    mocks.getNotificationCatalog.mockResolvedValue(CATALOG);
    mocks.getMyNotificationPrefs.mockReturnValue(new Promise(() => {}));
    renderScreen();
    await screen.findByText(/Loading/i);
    expect(warmSave).not.toHaveBeenCalled();
  });
});
