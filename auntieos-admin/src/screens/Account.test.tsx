// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { useRouteContext, useNavigate, navigate } = vi.hoisted(() => {
  const navigate = vi.fn();
  return { useRouteContext: vi.fn(), useNavigate: vi.fn(() => navigate), navigate };
});
const { getUserProfile } = vi.hoisted(() => ({ getUserProfile: vi.fn() }));
const { changeEmail, changePassword, sendReset } = vi.hoisted(() => ({
  changeEmail: vi.fn(),
  changePassword: vi.fn(),
  sendReset: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth, changeEmail, changePassword, sendReset }));
vi.mock('@tanstack/react-router', () => ({ useRouteContext, useNavigate }));
vi.mock('../api/account', () => ({ getUserProfile }));
const { uploadUserPhoto } = vi.hoisted(() => ({ uploadUserPhoto: vi.fn() }));
vi.mock('../api/accountPhoto', () => ({ uploadUserPhoto }));

import { Account, AccountRouteView } from './Account';

function signedIn(userOver: Record<string, unknown> = {}) {
  return {
    status: 'signedIn',
    user: {
      uid: 'op-1',
      email: 'auntie@tribetails.com',
      displayName: '',
      emailVerified: true,
      providerData: [{ providerId: 'password' }],
      metadata: {
        creationTime: 'Wed, 01 Jan 2025 12:00:00 GMT',
        lastSignInTime: 'Thu, 16 Jul 2026 12:00:00 GMT',
      },
      ...userOver,
    },
  };
}

function profile(over: Record<string, unknown> = {}) {
  return {
    uid: 'op-1',
    email: 'auntie@tribetails.com',
    displayName: 'Auntie Nora',
    firstName: 'Nora',
    lastName: 'Brooks',
    phone: '555-0100',
    title: 'Head of Care',
    photoUrl: '',
    bio: 'Loves dogs.',
    ...over,
  };
}

beforeEach(() => {
  useAuth.mockReturnValue(signedIn());
  useRouteContext.mockReturnValue({ access: { status: 'admin' } });
  getUserProfile.mockResolvedValue(profile());
  navigate.mockReset();
  uploadUserPhoto.mockReset();
});

describe('Account screen', () => {
  it('renders the operator profile + sign-in facts + role once loaded', async () => {
    render(<Account />);
    // "Auntie Nora" appears twice (Avatar accessible label + the header name),
    // so scope the identity assertion to the header name element.
    expect(
      await screen.findByText('Auntie Nora', { selector: '.account__identity-name' }),
    ).toBeInTheDocument();
    // Title shows in both the header subtitle and the Title field; scope to the field.
    expect(screen.getByText('Head of Care', { selector: '.account__field-value' })).toBeInTheDocument();
    expect(screen.getByText('auntie@tribetails.com')).toBeInTheDocument();
    expect(screen.getByText('Email and password')).toBeInTheDocument();
    expect(screen.getByText('op-1')).toBeInTheDocument();
    expect(screen.getByText('Operator (full admin)')).toBeInTheDocument();
  });

  it('surfaces a profile read error fail-loud (never a blank/fabricated card)', async () => {
    getUserProfile.mockRejectedValueOnce(new Error('permission-denied'));
    render(<Account />);
    expect(await screen.findByText(/couldn.t read your profile/i)).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('renders "Open my notification settings" STATIC (not a button) when onOpenNotifications is unwired', async () => {
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    expect(screen.getByText('Open my notification settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open my notification settings/i })).toBeNull();
  });

  it('shows the sandbox tribe for a test admin', async () => {
    useRouteContext.mockReturnValue({ access: { status: 'testAdmin', testTribeId: '0I' } });
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    expect(screen.getByText('Test admin (sandbox)')).toBeInTheDocument();
    expect(screen.getByText('0I')).toBeInTheDocument();
  });

  it('warns rather than crashing when no operator is signed in', () => {
    useAuth.mockReturnValue({ status: 'signedOut' });
    render(<Account />);
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument();
  });

  it('carries a Security panel: the operator can reach their password from here', async () => {
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    expect(screen.getByRole('group', { name: /change password/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /login email/i })).toBeInTheDocument();
  });
});

/**
 * The routed wrapper. It exists so the notification control's navigation is a
 * plain unit test instead of a full router mount: router.tsx registers THIS as
 * the /account component, so a regression that unwires the prop fails here.
 */
describe('AccountRouteView', () => {
  it('renders the notifications control as a real button, not the dead static span', async () => {
    render(<AccountRouteView />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    expect(
      screen.getByRole('button', { name: /open my notification settings/i }),
    ).toBeInTheDocument();
  });

  it('navigates to /my-notifications when that button is clicked', async () => {
    const user = userEvent.setup();
    render(<AccountRouteView />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    await user.click(screen.getByRole('button', { name: /open my notification settings/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/my-notifications' });
  });
});

describe('Account screen: profile photo', () => {
  // The file-level beforeEach re-arms getUserProfile but never clears its
  // call log, and the assertions below count re-reads.
  beforeEach(() => getUserProfile.mockClear());
  function pngFile(): File {
    return new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });
  }
  it('offers a Change photo control that opens an image-only file picker', async () => {
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    const input = screen.getByLabelText('Change photo') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
  });
  it('uploads the picked file for the signed-in uid, then re-reads the profile', async () => {
    uploadUserPhoto.mockResolvedValue('https://res.cloudinary.com/demo/new.jpg');
    getUserProfile
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(profile({ photoUrl: 'https://res.cloudinary.com/demo/new.jpg' }));
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(uploadUserPhoto).toHaveBeenCalledWith('op-1', expect.any(File), expect.any(Function));
    // The screen shows what Firestore now holds, not what the upload returned.
    expect(getUserProfile).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('img', { name: 'Auntie Nora' })).toHaveAttribute(
      'src',
      'https://res.cloudinary.com/demo/new.jpg',
    );
  });
  it('keeps the old photo and says why when the upload fails', async () => {
    uploadUserPhoto.mockRejectedValue(new Error('Cloudinary upload failed (HTTP 500)'));
    getUserProfile.mockResolvedValue(profile({ photoUrl: 'https://res.cloudinary.com/demo/old.jpg' }));
    render(<Account />);
    await screen.findByRole('img', { name: 'Auntie Nora' });
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(await screen.findByRole('alert')).toHaveTextContent('Cloudinary upload failed (HTTP 500)');
    expect(screen.getByRole('img', { name: 'Auntie Nora' })).toHaveAttribute(
      'src',
      'https://res.cloudinary.com/demo/old.jpg',
    );
    expect(getUserProfile).toHaveBeenCalledTimes(1);
  });
  it('disables the picker and names the stage while an upload is in flight', async () => {
    let finish: (url: string) => void = () => {};
    uploadUserPhoto.mockImplementation(
      (_uid: string, _file: File, onStage: (s: string) => void) =>
        new Promise<string>((resolve) => {
          onStage('uploading');
          finish = resolve;
        }),
    );
    render(<Account />);
    await screen.findByText('Auntie Nora', { selector: '.account__identity-name' });
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(screen.getByLabelText('Change photo')).toBeDisabled();
    expect(screen.getByText(/uploading/i)).toBeInTheDocument();
    finish('https://res.cloudinary.com/demo/new.jpg');
    expect(await screen.findByLabelText('Change photo')).toBeEnabled();
  });
});
