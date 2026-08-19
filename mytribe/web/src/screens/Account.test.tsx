// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Account } from './Account';
import type { AccountDto, PaymentMethodDto } from '../api/accountApi';
import type { GetMyHomeResult, GetMyKinResult } from '../api/types';

/**
 * Covers the one thing this session changed: Account.tsx's avatar upload,
 * now delegated to the shared <SignedImageUpload> component instead of an
 * inline useMutation + hidden <input>. These assertions pin the
 * user-observable contract (same validation message, same signKinfolkAvatar
 * wiring, same "no confirm step — Cloudinary's secure_url IS the photoUrl
 * until Save Changes persists it") so a future SignedImageUpload change
 * can't silently break this screen.
 */

vi.mock('../components/PortalNav', () => ({
  PortalNav: () => null,
}));

// `to` is carried into href, because a test that cannot see a link's
// destination cannot tell a working link from the inert span it replaced.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'kin-fam-1',
}));

const signKinfolkAvatar = vi.fn();

vi.mock('../api/accountApi', async () => {
  const actual = await vi.importActual<typeof import('../api/accountApi')>('../api/accountApi');
  return {
    ...actual,
    getMyAccount: vi.fn(),
    saveMyAccount: vi.fn(),
    getFormSchema: vi.fn().mockRejectedValue(new Error('not-found')),
    addSecondaryContact: vi.fn(),
    signKinfolkAvatar: () => signKinfolkAvatar(),
    getMyPaymentMethod: vi.fn(),
    createBillingSetupSession: vi.fn(),
    syncMyPaymentMethod: vi.fn(),
    removeMyPaymentMethod: vi.fn(),
  };
});

vi.mock('../api/portal', () => ({
  getMyHome: vi.fn(),
  getMyKin: vi.fn(),
}));

class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 200;
  responseText = '';
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open() {
    /* no-op */
  }

  send() {
    FakeXHR.instances.push(this);
  }

  respondSuccess(secureUrl: string) {
    this.status = 200;
    this.responseText = JSON.stringify({ secure_url: secureUrl });
    this.onload?.();
  }
}

const ACCOUNT: AccountDto = {
  uid: 'uid-1',
  email: 'kinfolk@example.com',
  displayName: 'Riley Kinfolk',
  phone: null,
  photoUrl: null,
  backupEmail: null,
  backupPhone: null,
  kinfolkIds: ['kin-fam-1'],
  hasPaymentMethod: false,
  updatedAtMs: null,
  impersonated: false,
};

const HOME: GetMyHomeResult = {
  kinfolkId: 'kin-fam-1',
  displayName: 'Riley Kinfolk',
  businessLogoUrl: '',
  businessName: 'Tribe Tails Pet Care',
  portal: {
    logoUrl: '',
    themeId: 'default',
    banner: { enabled: false, message: '', tone: 'info', dismissMode: 'session', id: 'banner' },
    home: [],
    chat: { enabled: false, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 500, rateLimitPerHour: 5 },
  },
  bannerDismissedByUser: false,
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

const KIN: GetMyKinResult = { kin: [] };

async function renderAccount() {
  const accountApi = await import('../api/accountApi');
  const portalApi = await import('../api/portal');
  vi.mocked(accountApi.getMyAccount).mockResolvedValue(ACCOUNT);
  vi.mocked(portalApi.getMyHome).mockResolvedValue(HOME);
  vi.mocked(portalApi.getMyKin).mockResolvedValue(KIN);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <Account />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(result.getByText('Add your name to save.')).toBeTruthy());
  return result;
}
/**
 * Renders with the billing callables stubbed. Kept separate from
 * `renderAccount` so the avatar suite above keeps its untouched fixtures, and
 * so each billing test states the card state it is about.
 */
async function renderAccountWithBilling(overrides: {
  account?: Partial<AccountDto>;
  paymentMethod?: PaymentMethodDto | Error;
} = {}) {
  const accountApi = await import('../api/accountApi');
  const portalApi = await import('../api/portal');
  vi.mocked(accountApi.getMyAccount).mockResolvedValue({ ...ACCOUNT, ...overrides.account });
  vi.mocked(portalApi.getMyHome).mockResolvedValue(HOME);
  vi.mocked(portalApi.getMyKin).mockResolvedValue(KIN);
  const pm = overrides.paymentMethod ?? { hasPaymentMethod: false, card: null, updatedAtMs: null };
  if (pm instanceof Error) {
    vi.mocked(accountApi.getMyPaymentMethod).mockRejectedValue(pm);
  } else {
    vi.mocked(accountApi.getMyPaymentMethod).mockResolvedValue(pm);
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <Account />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(result.getByText('Billing Details')).toBeTruthy());
  return result;
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

beforeEach(() => {
  FakeXHR.instances = [];
  signKinfolkAvatar.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
});

describe('Account avatar upload', () => {
  it('rejects an oversized photo with the same validateAvatarFile message, and never calls signKinfolkAvatar', async () => {
    const { container, findByText } = await renderAccount();
    const oversized = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' });

    await userEvent.upload(getFileInput(container), oversized);

    await findByText('Photos need to be 2MB or smaller.');
    expect(signKinfolkAvatar).not.toHaveBeenCalled();
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('rejects a disallowed file type with the same validateAvatarFile message', async () => {
    const { container, findByText } = await renderAccount();
    const badType = new File(['hi'], 'notes.pdf', { type: 'application/pdf' });

    // The native file picker's `accept` attribute would normally keep a
    // .pdf out of the selection dialog in the first place — this test
    // targets the defense-in-depth validate() check itself (the same path
    // a drag-drop, which ignores `accept` entirely, would hit), so it opts
    // out of user-event's default accept-filtering.
    await userEvent.setup({ applyAccept: false }).upload(getFileInput(container), badType);

    await findByText('Use a JPG, PNG, WebP, or GIF image.');
    expect(signKinfolkAvatar).not.toHaveBeenCalled();
  });

  it('uploads via signKinfolkAvatar and previews the returned secure_url directly (no confirm step)', async () => {
    signKinfolkAvatar.mockResolvedValue({
      cloudName: 'demo',
      apiKey: 'key',
      timestamp: 1700000000,
      signature: 'sig',
      folder: 'tribetails/kinfolks/uid-1/avatars',
      allowedFormats: 'jpg,png,webp,gif',
    });
    const { container } = await renderAccount();
    const file = new File(['bytes'], 'avatar.jpg', { type: 'image/jpeg' });

    await userEvent.upload(getFileInput(container), file);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]?.respondSuccess('https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg');

    await waitFor(() => {
      const img = container.querySelector('img.siu-img') as HTMLImageElement | null;
      expect(img?.src).toBe('https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg');
    });
  });

  it('surfaces "not available right now" when signKinfolkAvatar returns no cloudName', async () => {
    signKinfolkAvatar.mockResolvedValue({
      cloudName: '',
      apiKey: '',
      timestamp: 0,
      signature: '',
      folder: '',
      allowedFormats: '',
    });
    const { container, findByText } = await renderAccount();
    const file = new File(['bytes'], 'avatar.jpg', { type: 'image/jpeg' });

    await userEvent.upload(getFileInput(container), file);

    await findByText("Photo uploads aren't available right now. Try again later.");
    expect(FakeXHR.instances).toHaveLength(0);
  });
});
/**
 * Issue #401's sibling: "Message your Auntie" on Account was a
 * `<span class="btn ghost block navlink-inert" title="Coming soon">`, styled
 * as a button and doing nothing, while `/messages` was a live route this same
 * app already linked from Home.tsx:222. A tooltip is not a label; it never
 * appears on touch.
 */
describe('Account: Message your Auntie', () => {
  it('is a real link to /messages, not a coming-soon span', async () => {
    const { getByRole, queryByTitle } = await renderAccount();
    expect(getByRole('link', { name: /message your auntie/i })).toHaveAttribute('href', '/messages');
    // It is not still a span wearing a tooltip.
    expect(queryByTitle('Coming soon')?.textContent ?? '').not.toMatch(/message your auntie/i);
  });
});
/**
 * Billing Details card management (#399 item 3).
 *
 * The bug this replaces: "Manage" was a <span class="navlink-inert"> with a
 * "Coming soon" title, so a household could never add or change a card. Each
 * test below names the state it asserts by its state carrier (the panel's
 * testid, the button label), not by `toBeVisible`, which passes on collapsed
 * content in jsdom.
 */
describe('Account billing management', () => {
  beforeEach(async () => {
    window.history.replaceState({}, '', '/account');
    // Call counts, not stubs: each test sets its own resolved values inside
    // renderAccountWithBilling, which runs after this hook.
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.getMyPaymentMethod).mockClear();
    vi.mocked(accountApi.createBillingSetupSession).mockClear();
    vi.mocked(accountApi.syncMyPaymentMethod).mockClear();
    vi.mocked(accountApi.removeMyPaymentMethod).mockClear();
  });
  it('opens the manage panel and offers to add a card when none is on file', async () => {
    const { getByRole, queryByTestId, findByTestId } = await renderAccountWithBilling();
    expect(queryByTestId('billing-manage')).toBeNull();
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    await findByTestId('billing-manage');
    expect(getByRole('button', { name: 'Add a card' })).toBeTruthy();
    expect(queryByTestId('billing-manage')?.textContent).toContain('Nothing is charged when you save it.');
  });
  it('shows the card on file and offers to replace or remove it', async () => {
    const { getByRole, findByText } = await renderAccountWithBilling({
      account: { hasPaymentMethod: true },
      paymentMethod: {
        hasPaymentMethod: true,
        card: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
        updatedAtMs: 1_700_000_000_000,
      },
    });
    await findByText('Visa •••• 4242 · exp 04/2030');
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    expect(getByRole('button', { name: 'Replace card' })).toBeTruthy();
    expect(getByRole('button', { name: 'Remove card' })).toBeTruthy();
  });
  it('asks the server for a Checkout link that returns to this screen', async () => {
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.createBillingSetupSession).mockResolvedValue({
      checkoutUrl: 'https://checkout.stripe.com/setup',
      sessionId: 'cs_setup_1',
    });
    const { getByRole, findByTestId } = await renderAccountWithBilling();
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    await findByTestId('billing-manage');
    await userEvent.click(getByRole('button', { name: 'Add a card' }));
    await waitFor(() => expect(accountApi.createBillingSetupSession).toHaveBeenCalled());
    const call = vi.mocked(accountApi.createBillingSetupSession).mock.calls[0];
    if (!call) throw new Error('createBillingSetupSession was not called');
    const [successUrl, cancelUrl, kinfolkId] = call;
    expect(successUrl).toContain('?billing=saved');
    expect(cancelUrl).not.toContain('billing=saved');
    expect(kinfolkId).toBe('kin-fam-1');
  });
  it('reports a Checkout failure in words the household can act on', async () => {
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.createBillingSetupSession).mockRejectedValue(
      Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' }),
    );
    const { getByRole, findByText, findByTestId } = await renderAccountWithBilling();
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    await findByTestId('billing-manage');
    await userEvent.click(getByRole('button', { name: 'Add a card' }));
    await findByText('Only the primary kinfolk on this tribe can manage billing.');
  });
  it('takes two clicks to remove a card, and says what removal does not do', async () => {
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.removeMyPaymentMethod).mockResolvedValue({ ok: true, alreadyEmpty: false });
    const { getByRole, findByText } = await renderAccountWithBilling({
      account: { hasPaymentMethod: true },
      paymentMethod: {
        hasPaymentMethod: true,
        card: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
        updatedAtMs: null,
      },
    });
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    await userEvent.click(getByRole('button', { name: 'Remove card' }));
    expect(accountApi.removeMyPaymentMethod).not.toHaveBeenCalled();
    await findByText(/leaves any unpaid invoices exactly as they are/);
    await userEvent.click(getByRole('button', { name: 'Yes, take it off' }));
    await waitFor(() => expect(accountApi.removeMyPaymentMethod).toHaveBeenCalledWith('kin-fam-1'));
    await findByText('Card removed.');
  });
  it('names the permission wall rather than a generic failure when the read is denied', async () => {
    const { getByRole, findByText } = await renderAccountWithBilling({
      paymentMethod: Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' }),
    });
    await userEvent.click(getByRole('button', { name: 'Manage' }));
    await findByText('Only the primary kinfolk on this tribe can manage billing.');
  });
  it('syncs the card when the browser comes back from Stripe', async () => {
    window.history.replaceState({}, '', '/account?billing=saved');
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.syncMyPaymentMethod).mockResolvedValue({
      hasPaymentMethod: true,
      card: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
      updatedAtMs: 1_700_000_000_000,
      changed: true,
    });
    const { findByText } = await renderAccountWithBilling();
    await waitFor(() => expect(accountApi.syncMyPaymentMethod).toHaveBeenCalledWith('kin-fam-1'));
    await findByText('Card saved.');
    // The marker is cleared so a refresh does not re-run the sync.
    expect(window.location.search).toBe('');
  });
  it('says so when Stripe reports no card after the return trip', async () => {
    window.history.replaceState({}, '', '/account?billing=saved');
    const accountApi = await import('../api/accountApi');
    vi.mocked(accountApi.syncMyPaymentMethod).mockResolvedValue({
      hasPaymentMethod: false,
      card: null,
      updatedAtMs: null,
      changed: false,
    });
    const { findByText } = await renderAccountWithBilling();
    await findByText('Stripe did not report a card. Try adding it again.');
  });
  it('keeps Manage inert for an operator viewing another household', async () => {
    const accountApi = await import('../api/accountApi');
    const { getByText, queryByRole } = await renderAccountWithBilling({ account: { impersonated: true } });
    expect(queryByRole('button', { name: 'Manage' })).toBeNull();
    expect(getByText('Manage').className).toContain('navlink-inert');
    expect(accountApi.getMyPaymentMethod).not.toHaveBeenCalled();
  });
});
