// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mergeBusinessSettings } from '../api/settings';
import { STREAM_BUSINESS, type NotificationCatalogEntry } from '../api/myNotifications';

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { useRouteContext, useNavigate, navigate } = vi.hoisted(() => {
  const navigate = vi.fn();
  return { useRouteContext: vi.fn(), useNavigate: vi.fn(() => navigate), navigate };
});
const { getUserProfile } = vi.hoisted(() => ({ getUserProfile: vi.fn() }));
const { saveUserProfile } = vi.hoisted(() => ({ saveUserProfile: vi.fn() }));
const { changeEmail, sendReset, signOut, AccountSecurityError } = vi.hoisted(() => {
  class AccountSecurityError extends Error {}
  return {
    changeEmail: vi.fn(),
    sendReset: vi.fn(),
    signOut: vi.fn(),
    AccountSecurityError,
  };
});
const { listBusinessAdmins } = vi.hoisted(() => ({ listBusinessAdmins: vi.fn() }));
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
const { saveBusinessSettings } = vi.hoisted(() => ({ saveBusinessSettings: vi.fn() }));
const { getNotificationMatrix, getMyNotificationPrefs, saveMyAdminNotificationPrefs } = vi.hoisted(
  () => ({
    getNotificationMatrix: vi.fn(),
    getMyNotificationPrefs: vi.fn(),
    saveMyAdminNotificationPrefs: vi.fn(),
  }),
);

vi.mock('../lib/auth', () => ({ useAuth, changeEmail, sendReset, signOut, AccountSecurityError }));
vi.mock('@tanstack/react-router', () => ({ useRouteContext, useNavigate }));
vi.mock('../api/account', () => ({ getUserProfile }));
vi.mock('../api/accountWrite', () => ({ saveUserProfile }));
vi.mock('../api/businessAdmins', () => ({ listBusinessAdmins }));
// Spread the real module: the Business profile panel imports its field list and
// its fee-schedule helpers from `screens/settings/sections`, which reads them
// from here. Only the network read is replaced.
vi.mock('../api/settings', async (orig) => ({
  ...(await orig<typeof import('../api/settings')>()),
  getBusinessSettings,
}));
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings }));
vi.mock('../api/myNotifications', async (orig) => ({
  ...(await orig<typeof import('../api/myNotifications')>()),
  getNotificationMatrix,
  getMyNotificationPrefs,
}));
vi.mock('../api/myNotificationsWrite', () => ({ saveMyAdminNotificationPrefs }));
const { uploadUserPhoto } = vi.hoisted(() => ({ uploadUserPhoto: vi.fn() }));
vi.mock('../api/accountPhoto', () => ({ uploadUserPhoto }));

import { Account, AccountRouteView } from './Account';

function signedIn(userOver: Record<string, unknown> = {}) {
  return {
    status: 'signedIn',
    user: {
      uid: 'op-1-abcdefghij',
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
    uid: 'op-1-abcdefghij',
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

function admin(uid: string) {
  return { uid, displayName: null, email: null, hasStaffRecord: true, defaultAssignee: false };
}

function roster(members: ReturnType<typeof admin>[]) {
  return { members, source: 'roster', rosterPath: 'businessSettings/admins.uids', reason: null };
}

function catalogEntry(key: string): NotificationCatalogEntry {
  return {
    key,
    label: key,
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
    whoReceives: [],
    recipientResolver: '',
    emitters: [],
    neverFires: false,
    templates: {},
    mergeFields: [],
    external: false,
  };
}

function matrix() {
  return {
    catalog: [catalogEntry('booking.confirmed')],
    overrides: {},
    ungated: [],
    businessAdminCount: 1,
    businessAdminRosterPath: 'businessSettings/admins.uids',
    updatedAtMs: null,
  };
}

/** The hero name element. The Avatar's accessible label carries the name too. */
function heroName() {
  return screen.findByText('Auntie Nora', { selector: '.account__heroName' });
}
/** Scoped to the personal Profile panel: "Phone" is a label in two panels. */
function profilePanel() {
  const panel = screen
    .getByText('What kinfolk see on your KinTales and replies.')
    .closest('section') as HTMLElement;
  return within(panel);
}

beforeEach(() => {
  useAuth.mockReturnValue(signedIn());
  useRouteContext.mockReturnValue({ access: { status: 'admin' } });
  getUserProfile.mockReset().mockResolvedValue(profile());
  saveUserProfile.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  uploadUserPhoto.mockReset();
  listBusinessAdmins.mockReset().mockResolvedValue(roster([admin('op-1-abcdefghij')]));
  getBusinessSettings.mockReset().mockResolvedValue(
    mergeBusinessSettings({
      businessName: 'Tribe Tails Pet Care',
      businessEmail: 'hello@tribetails.com',
      businessPhone: '555-0199',
      businessAddress: '100 Creekside Ln',
    }),
  );
  saveBusinessSettings
    .mockReset()
    .mockResolvedValue({ updatedAt: '2026-09-10T00:00:00.000Z', updatedBy: 'auntie' });
  getNotificationMatrix.mockReset().mockResolvedValue(matrix());
  getMyNotificationPrefs.mockReset().mockResolvedValue({
    prefs: { byKey: {}, byCategory: {}, marketingOptIn: {} },
    updatedAtMs: null,
  });
  saveMyAdminNotificationPrefs.mockReset().mockResolvedValue(undefined);
});

describe('Account hero', () => {
  it('carries the name, role line, email and the badges the mock draws', async () => {
    render(<Account />);
    expect(await heroName()).toBeInTheDocument();
    expect(screen.getByText('Head of Care · Operator (full admin)')).toBeInTheDocument();
    expect(screen.getByText('auntie@tribetails.com')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('uid: op-1-abcde…')).toBeInTheDocument();
  });

  it('badges the operator Sole admin when the admin list holds exactly one', async () => {
    render(<Account />);
    expect(await screen.findByText('Sole admin')).toBeInTheDocument();
    expect(listBusinessAdmins).toHaveBeenCalledTimes(1);
  });

  it('shows no Sole admin badge when a second admin is on the roster', async () => {
    listBusinessAdmins.mockResolvedValue(roster([admin('op-1-abcdefghij'), admin('op-2')]));
    render(<Account />);
    await heroName();
    expect(screen.queryByText('Sole admin')).toBeNull();
  });

  it('claims nothing about sole admin when the roster cannot be read', async () => {
    listBusinessAdmins.mockRejectedValue(new Error('permission-denied'));
    render(<Account />);
    await heroName();
    expect(screen.queryByText('Sole admin')).toBeNull();
    // The rest of the hero is unaffected: an unread roster is not a dead screen.
    expect(screen.getByText('auntie@tribetails.com')).toBeInTheDocument();
  });
});

describe('Account profile: inline editing', () => {
  it('renders First name and Last name as separate editable fields', async () => {
    render(<Account />);
    await heroName();
    expect(screen.getByLabelText('First name')).toHaveValue('Nora');
    expect(screen.getByLabelText('Last name')).toHaveValue('Brooks');
    // The old combined read-only "Full name" row is gone.
    expect(screen.queryByText('Full name')).toBeNull();
  });

  it('keeps Save profile disabled until something actually changes', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('Last name'));
    await user.type(screen.getByLabelText('Last name'), 'Brooks-Hale');
    expect(save).toBeEnabled();
  });

  it('writes the edited fields on Save, then re-reads the document', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.clear(screen.getByLabelText('First name'));
    await user.type(screen.getByLabelText('First name'), 'Nora Jean');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Owner');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(saveUserProfile).toHaveBeenCalledWith('op-1-abcdefghij', {
      displayName: 'Auntie Nora',
      firstName: 'Nora Jean',
      lastName: 'Brooks',
      phone: '555-0100',
      title: 'Owner',
      bio: 'Loves dogs.',
    });
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    // The screen reports the document, so it re-reads rather than trusting the form.
    expect(getUserProfile).toHaveBeenCalledTimes(2);
  });

  it('refuses a blank display name and says so beside the field', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText("Display name can't be blank.")).toBeInTheDocument();
    expect(saveUserProfile).not.toHaveBeenCalled();
  });

  it('keeps the typed edits and says why when the save is rejected', async () => {
    saveUserProfile.mockRejectedValueOnce(new Error('permission-denied'));
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.clear(profilePanel().getByLabelText('Phone'));
    await user.type(profilePanel().getByLabelText('Phone'), '555-0111');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText(/saveUserProfile failed: permission-denied/)).toBeInTheDocument();
    expect(profilePanel().getByLabelText('Phone')).toHaveValue('555-0111');
  });

  it('surfaces a profile read error fail-loud (never a blank/fabricated card)', async () => {
    getUserProfile.mockRejectedValueOnce(new Error('permission-denied'));
    render(<Account />);
    expect(await screen.findByText(/couldn.t read your profile/i)).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('warns rather than crashing when no operator is signed in', () => {
    useAuth.mockReturnValue({ status: 'signedOut' });
    render(<Account />);
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument();
  });
});

describe('Account business profile', () => {
  it('renders the same field list the Settings business profile uses, and saves it', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    const panel = (await screen.findByText('Business profile')).closest('section');
    expect(panel).not.toBeNull();
    const g = within(panel as HTMLElement);
    expect(g.getByLabelText('Business name')).toHaveValue('Tribe Tails Pet Care');
    expect(g.getByLabelText('Address')).toHaveValue('100 Creekside Ln');
    // Its own Save, separate from the hero's (the mock draws both).
    await user.clear(g.getByLabelText('Phone'));
    await user.type(g.getByLabelText('Phone'), '555-0122');
    await user.click(g.getByRole('button', { name: 'Save' }));

    expect(saveBusinessSettings).toHaveBeenCalledWith(
      expect.objectContaining({ businessPhone: '555-0122' }),
    );
    expect(saveUserProfile).not.toHaveBeenCalled();
  });

  it('keeps an in-progress business edit through a hero profile save', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    const panel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
    const g = within(panel);
    await user.clear(g.getByLabelText('Phone'));
    await user.type(g.getByLabelText('Phone'), '555-0133');
    // The hero Save re-reads the profile. That must not unmount the sibling
    // panels and throw away what the operator typed in this one.
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Auntie N');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');
    expect(g.getByLabelText('Phone')).toHaveValue('555-0133');
    expect(saveBusinessSettings).not.toHaveBeenCalled();
    // And the sibling loads did not run again.
    expect(listBusinessAdmins).toHaveBeenCalledTimes(1);
    expect(getBusinessSettings).toHaveBeenCalledTimes(1);
    expect(getNotificationMatrix).toHaveBeenCalledTimes(1);
  });
  it('leaves the hero and the profile column working when business settings fail to load', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<Account />);
    await heroName();
    expect(await screen.findByText(/couldn.t load business settings/i)).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Nora');
  });
});

describe('Account notifications', () => {
  it('shows one switch per channel, off where the operator receives nothing', async () => {
    render(<Account />);
    await heroName();
    // The catalog default: email on, sms and push off.
    expect(await screen.findByRole('switch', { name: 'Email notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'SMS notifications' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).not.toBeChecked();
  });

  it('writes the flipped channel to the same prefs store /my-notifications edits', async () => {
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.click(await screen.findByRole('switch', { name: 'SMS notifications' }));

    expect(saveMyAdminNotificationPrefs).toHaveBeenCalledWith({
      byKey: { 'booking.confirmed': { sms: true } },
      byCategory: {},
      marketingOptIn: {},
    });
    expect(screen.getByRole('switch', { name: 'SMS notifications' })).toBeChecked();
  });

  it('leaves the switch where it was and says why when the save fails', async () => {
    saveMyAdminNotificationPrefs.mockRejectedValueOnce(new Error('callable unavailable'));
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.click(await screen.findByRole('switch', { name: 'Push notifications' }));

    expect(await screen.findByText('callable unavailable')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).not.toBeChecked();
  });

  it('keeps the link to the full notification settings page', async () => {
    render(<Account />);
    await heroName();
    expect(screen.getByText('Open my notification settings')).toBeInTheDocument();
    // Unwired (a bare <Account />) it stays a static span, never a dead button.
    expect(screen.queryByRole('button', { name: /open my notification settings/i })).toBeNull();
  });
});

describe('Account security and meta block', () => {
  it('carries the Security panel: the operator can reach a password reset from here', async () => {
    render(<Account />);
    await heroName();
    expect(screen.getByRole('button', { name: 'Send reset email' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /login email/i })).toBeInTheDocument();
  });

  it('keeps the Access and Activity facts the mock did not draw', async () => {
    render(<Account />);
    await heroName();
    expect(screen.getByText('Operator (full admin)')).toBeInTheDocument();
    expect(screen.getByText('Email and password')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('op-1-abcdefghij')).toBeInTheDocument();
    // authDateLabel renders in the operator's own wall-clock zone, so assert
    // the day rather than a fixed hour.
    expect(screen.getByText(/^Jul 16, 2026,/)).toBeInTheDocument();
  });

  it('shows the sandbox tribe for a test admin', async () => {
    useRouteContext.mockReturnValue({ access: { status: 'testAdmin', testTribeId: '0I' } });
    render(<Account />);
    await heroName();
    expect(screen.getByText('Test admin (sandbox)')).toBeInTheDocument();
    expect(screen.getByText('0I')).toBeInTheDocument();
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
    await heroName();
    expect(
      screen.getByRole('button', { name: /open my notification settings/i }),
    ).toBeInTheDocument();
  });

  it('navigates to /my-notifications when that button is clicked', async () => {
    const user = userEvent.setup();
    render(<AccountRouteView />);
    await heroName();
    await user.click(screen.getByRole('button', { name: /open my notification settings/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/my-notifications' });
  });
});

describe('Account screen: profile photo', () => {
  function pngFile(): File {
    return new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });
  }
  it('offers a Change photo control that opens an image-only file picker', async () => {
    render(<Account />);
    await heroName();
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
    await heroName();
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(uploadUserPhoto).toHaveBeenCalledWith(
      'op-1-abcdefghij',
      expect.any(File),
      expect.any(Function),
    );
    // The screen shows what Firestore now holds, not what the upload returned.
    expect(getUserProfile).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('img', { name: 'Auntie Nora' })).toHaveAttribute(
      'src',
      'https://res.cloudinary.com/demo/new.jpg',
    );
  });
  it('keeps a half-typed edit through the re-read a photo upload triggers', async () => {
    uploadUserPhoto.mockResolvedValue('https://res.cloudinary.com/demo/new.jpg');
    const user = userEvent.setup();
    render(<Account />);
    await heroName();
    await user.clear(screen.getByLabelText('Bio'));
    await user.type(screen.getByLabelText('Bio'), 'Half a sentence');
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(await screen.findByLabelText('Bio')).toHaveValue('Half a sentence');
  });
  it('keeps the old photo and says why when the upload fails', async () => {
    uploadUserPhoto.mockRejectedValue(new Error('Cloudinary upload failed (HTTP 500)'));
    getUserProfile.mockResolvedValue(
      profile({ photoUrl: 'https://res.cloudinary.com/demo/old.jpg' }),
    );
    render(<Account />);
    await screen.findByRole('img', { name: 'Auntie Nora' });
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(await screen.findByText('Cloudinary upload failed (HTTP 500)')).toBeInTheDocument();
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
    await heroName();
    await userEvent.upload(screen.getByLabelText('Change photo'), pngFile());
    expect(screen.getByLabelText('Change photo')).toBeDisabled();
    expect(screen.getByText(/uploading/i)).toBeInTheDocument();
    finish('https://res.cloudinary.com/demo/new.jpg');
    expect(await screen.findByLabelText('Change photo')).toBeEnabled();
  });
});
