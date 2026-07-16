// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Account } from './Account';
import type { AccountDto } from '../api/accountApi';
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
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
