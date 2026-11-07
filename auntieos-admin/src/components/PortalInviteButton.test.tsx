// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  listHouseholdMembers: vi.fn(),
  inviteKinfolkToPortal: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../api/members', async (orig) => ({
  ...(await orig<typeof import('../api/members')>()),
  listHouseholdMembers: api.listHouseholdMembers,
}));
vi.mock('../api/membersWrite', async (orig) => ({
  ...(await orig<typeof import('../api/membersWrite')>()),
  inviteKinfolkToPortal: api.inviteKinfolkToPortal,
}));
vi.mock('./Toast', () => ({ useToast: () => ({ showToast: api.showToast }) }));

import { PortalInviteButton, portalInviteBlocker } from './PortalInviteButton';

const primary = (status: string) => ({
  uid: 'u1',
  displayName: 'Dre East',
  secondaryLabel: null,
  role: 'PRIMARY',
  status,
  permissions: {},
  invitedEmail: 'catch@hanasamku.com',
});

beforeEach(() => {
  api.listHouseholdMembers.mockReset().mockResolvedValue([]);
  api.inviteKinfolkToPortal.mockReset();
  api.showToast.mockReset();
});

/**
 * #1603. Operator ruling, 2026-11-05 docket: "no button on the Invites screen.
 * Invite from the kinfolk profile." The profile's invite asks first, names the
 * address, and is off when it cannot succeed.
 */
describe('PortalInviteButton (#1603)', () => {
  it('asks first and names the address before anything is sent', async () => {
    api.inviteKinfolkToPortal.mockResolvedValue({ kinfolkId: 'k1', status: 'sent', inviteId: 'inv1' });
    render(<PortalInviteButton kinfolkId="k1" householdName="Dre East" email="catch@hanasamku.com" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Invite to portal' }));
    expect(api.inviteKinfolkToPortal).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Invite to portal' });
    expect(dialog).toHaveTextContent('catch@hanasamku.com');

    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(api.inviteKinfolkToPortal).toHaveBeenCalledWith('k1'));
    expect(api.showToast).toHaveBeenCalledWith(expect.stringContaining('Portal invite sent to Dre East'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is off, and says why, when the household has no email', async () => {
    render(<PortalInviteButton kinfolkId="k1" householdName="Dre East" email="  " />);
    expect(await screen.findByRole('button', { name: 'Invite to portal' })).toBeDisabled();
    expect(screen.getByTestId('portal-invite-blocker')).toHaveTextContent('No email on file');
  });

  it('is off, and says why, when a primary is already on the portal', async () => {
    api.listHouseholdMembers.mockResolvedValue([primary('ACTIVE')]);
    render(<PortalInviteButton kinfolkId="k1" householdName="Dre East" email="catch@hanasamku.com" />);
    expect(await screen.findByText('Already on the portal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite to portal' })).toBeDisabled();
  });

  it('stays on when the members read fails, and shows the server answer in the dialog', async () => {
    api.listHouseholdMembers.mockRejectedValue(new Error('permission-denied'));
    api.inviteKinfolkToPortal.mockResolvedValue({ kinfolkId: 'k1', status: 'already_active' });
    render(<PortalInviteButton kinfolkId="k1" householdName="Dre East" email="catch@hanasamku.com" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Invite to portal' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has an active portal account');
    expect(api.showToast).not.toHaveBeenCalled();
  });

  it('names a failed send in the dialog', async () => {
    api.inviteKinfolkToPortal.mockRejectedValue(new Error('internal'));
    render(<PortalInviteButton kinfolkId="k1" householdName="Dre East" email="catch@hanasamku.com" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Invite to portal' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The portal invite was not sent: internal');
  });

  it('portalInviteBlocker: email first, then an active primary, else nothing', () => {
    expect(portalInviteBlocker('', null)).toMatch(/No email/);
    expect(portalInviteBlocker('catch@hanasamku.com', true)).toBe('Already on the portal.');
    expect(portalInviteBlocker('catch@hanasamku.com', false)).toBeNull();
    expect(portalInviteBlocker('catch@hanasamku.com', null)).toBeNull();
  });
});
