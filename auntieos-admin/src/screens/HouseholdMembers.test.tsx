// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

const api = vi.hoisted(() => ({
  listHouseholdMembers: vi.fn(),
  listHouseholdInvites: vi.fn(),
  mintInvite: vi.fn(),
  revokeInvite: vi.fn(),
  setMemberPermissions: vi.fn(),
  removeMember: vi.fn(),
  inviteKinfolkToPortal: vi.fn(),
}));

vi.mock('../api/members', async (orig) => ({
  ...(await orig<typeof import('../api/members')>()),
  listHouseholdMembers: api.listHouseholdMembers,
  listHouseholdInvites: api.listHouseholdInvites,
}));
vi.mock('../api/membersWrite', async (orig) => ({
  ...(await orig<typeof import('../api/membersWrite')>()),
  mintInvite: api.mintInvite,
  revokeInvite: api.revokeInvite,
  setMemberPermissions: api.setMemberPermissions,
  removeMember: api.removeMember,
  inviteKinfolkToPortal: api.inviteKinfolkToPortal,
}));

import { ToastProvider } from '../components/Toast';
import { HouseholdMembers, inviteMetaLine } from './HouseholdMembers';
import type { HouseholdInvite, HouseholdMember } from '../api/members';

function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

function member(over: Partial<HouseholdMember> = {}): HouseholdMember {
  return {
    uid: 'u1',
    secondaryLabel: 'Spouse',
    role: 'SECONDARY',
    status: 'ACTIVE',
    permissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    },
    invitedEmail: 'marcus@example.com',
    ...over,
  };
}

function invite(over: Partial<HouseholdInvite> = {}): HouseholdInvite {
  return {
    inviteId: 'rq_8fk29abc',
    tribeId: 'fam1',
    invitedEmail: 'jane@example.com',
    secondaryLabel: 'Sister',
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    },
    status: 'EMAIL_SENT',
    effectiveStatus: 'EMAIL_SENT',
    redeemable: true,
    createdAt: '2026-05-26T00:00:00.000Z',
    sentToInviteeAt: '2026-05-26T00:00:00.000Z',
    expiresAt: '2026-06-09T00:00:00.000Z',
    revokedAt: null,
    acceptedUid: null,
    ...over,
  };
}

function mount(over: { members?: HouseholdMember[]; invites?: HouseholdInvite[] } = {}) {
  api.listHouseholdMembers.mockResolvedValue(over.members ?? [member()]);
  api.listHouseholdInvites.mockResolvedValue(over.invites ?? [invite()]);
  return render(
    <HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={() => {}} />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('HouseholdMembers HAPPY', () => {
  it('lists members with their permissions and lists invites by status', async () => {
    mount();

    const memberRow = (await screen.findByText('marcus@example.com')).closest('li');
    expect(memberRow).not.toBeNull();
    expect(within(memberRow as HTMLElement).getByText('Secondary')).toBeInTheDocument();
    expect(within(memberRow as HTMLElement).getByText('Active')).toBeInTheDocument();

    // Every permission the server understands is rendered, granted or not.
    expect(
      screen.getByRole('switch', { name: 'Direct messaging for marcus@example.com' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('switch', { name: 'Full billing for marcus@example.com' }),
    ).toHaveAttribute('aria-checked', 'false');

    expect(await screen.findByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    expect(api.listHouseholdMembers).toHaveBeenCalledWith('fam1');
    expect(api.listHouseholdInvites).toHaveBeenCalledWith('fam1');
  });

  it('sends only the flag that moved when a permission is toggled', async () => {
    const user = userEvent.setup();
    api.setMemberPermissions.mockResolvedValue(undefined);
    mount();

    await user.click(
      await screen.findByRole('switch', { name: 'Full billing for marcus@example.com' }),
    );

    await waitFor(() => {
      expect(api.setMemberPermissions).toHaveBeenCalledWith('fam1', 'u1', { billing_full: true });
    });
  });

  it('mints a primary invite from the one field it offers, and reloads the invite list', async () => {
    const user = userEvent.setup();
    api.mintInvite.mockResolvedValue({ inviteId: 'rq_new' });
    mount();

    await user.type(await screen.findByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send primary invite' }));

    await waitFor(() => {
      expect(api.mintInvite).toHaveBeenCalledWith({
        familyId: 'fam1',
        invitedEmail: 'new@example.com',
      });
    });
    // Reloaded, so the new invite appears without a manual refresh.
    await waitFor(() => expect(api.listHouseholdInvites).toHaveBeenCalledTimes(2));
  });

  it('revokes a live invite and reloads', async () => {
    const user = userEvent.setup();
    api.revokeInvite.mockResolvedValue(undefined);
    mount();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith('rq_8fk29abc'));
    await waitFor(() => expect(api.listHouseholdInvites).toHaveBeenCalledTimes(2));
  });

  it('sends the portal invite when the household has never been claimed', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockResolvedValue({
      kinfolkId: 'fam1',
      status: 'sent',
      inviteId: 'rq_p',
    });
    mount({ members: [] });

    await user.click(
      await screen.findByRole('button', { name: 'Invite this household to the portal' }),
    );

    await waitFor(() => expect(api.inviteKinfolkToPortal).toHaveBeenCalledWith('fam1'));
    expect(await screen.findByText(/Portal invite sent to the Walls/)).toBeInTheDocument();
  });
});

/**
 * RULING (2026-08-04): "admin can edit permissions but not like primary's
 * access to full billing, home access, kin edit, etc. The screen makes it seem
 * like these account must needs can be turned off."
 *
 * The screen drew five live switches on the primary's row. Every write behind
 * them was inert (`requirePerm` answers for a PRIMARY before it reads the
 * flags), so the toggles claimed a power over the household's owner that
 * nothing had. These are the cases that stop that coming back.
 */
describe('HouseholdMembers PRIMARY entitlements are not switches', () => {
  const primary = () =>
    member({
      uid: 'u-primary',
      role: 'PRIMARY',
      secondaryLabel: null,
      invitedEmail: 'loretta@example.com',
      permissions: {
        billing_full: true,
        messaging_direct: true,
        messaging_group: true,
        kin_edit: true,
        kintales_only: true,
        home_access: true,
      },
    });

  it('offers a primary no toggle at all, for billing, home access or anything else', async () => {
    mount({ members: [primary()] });

    await screen.findByText('loretta@example.com');
    for (const label of ['Full billing', 'Home access', 'Edit kin', 'Direct messaging']) {
      expect(
        screen.queryByRole('switch', { name: `${label} for loretta@example.com` }),
      ).not.toBeInTheDocument();
    }
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('says the entitlements are held by role, and shows each one as granted', async () => {
    mount({ members: [primary()] });

    expect(await screen.findByText(/Held by role, not by setting/)).toBeInTheDocument();
    // Every permission still appears; it reads as state rather than as control.
    const row = (await screen.findByText('loretta@example.com')).closest('li');
    expect(within(row as HTMLElement).getAllByText('Granted')).toHaveLength(6);
  });

  it('keeps the secondary rows fully editable in the same list', async () => {
    const user = userEvent.setup();
    api.setMemberPermissions.mockResolvedValue(undefined);
    mount({ members: [primary(), member()] });

    await user.click(
      await screen.findByRole('switch', { name: 'Full billing for marcus@example.com' }),
    );
    await waitFor(() => {
      expect(api.setMemberPermissions).toHaveBeenCalledWith('fam1', 'u1', { billing_full: true });
    });
    // Only the secondary's five editable flags are switches on this screen.
    expect(screen.getAllByRole('switch')).toHaveLength(6);
  });

  it('offers no way for an admin to invite a secondary, and says who does', async () => {
    mount({ members: [primary()] });

    await screen.findByText('loretta@example.com');
    expect(screen.getByRole('button', { name: 'Send primary invite' })).toBeInTheDocument();
    // The role radiogroup defaulted to Secondary, which is the one invite an
    // admin does not send.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Secondary' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
    expect(screen.getByText(/the primary invites them from MyTribe/)).toBeInTheDocument();
  });
});

describe('HouseholdMembers REVOKED and EXPIRED invites (the case that matters most)', () => {
  it('shows a lapsed invite as Expired and offers no Revoke, even though Firestore still says EMAIL_SENT', async () => {
    // What listInvites returns when the 02:00 sweep has not run yet.
    mount({
      invites: [
        invite({
          status: 'EMAIL_SENT',
          effectiveStatus: 'EXPIRED',
          redeemable: false,
          expiresAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
    });

    const row = (await screen.findByText('jane@example.com')).closest('li');
    expect(within(row as HTMLElement).getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    // Offering Revoke here would be a button that fails when clicked.
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('shows a revoked invite as Revoked with no Revoke button and its revoked date', async () => {
    mount({
      invites: [
        invite({
          status: 'REVOKED',
          effectiveStatus: 'REVOKED',
          redeemable: false,
          revokedAt: '2026-05-19T00:00:00.000Z',
        }),
      ],
    });

    const row = (await screen.findByText('jane@example.com')).closest('li');
    expect(within(row as HTMLElement).getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/revoked 2026-05-19/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('surfaces a revoke that the server refuses, rather than showing the invite as revoked', async () => {
    const user = userEvent.setup();
    api.revokeInvite.mockRejectedValue(new Error('not-found: invite not found'));
    mount();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText(/revokeInvite failed for jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/invite not found/)).toBeInTheDocument();
    // The row is untouched: still Pending, still revocable.
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });
});

describe('HouseholdMembers NEGATIVE', () => {
  it('renders kintales_only as locked on and refuses to let it be turned off', async () => {
    mount();
    const locked = await screen.findByRole('switch', {
      name: 'KinTales feed for marcus@example.com',
    });
    expect(locked).toHaveAttribute('aria-checked', 'true');
    expect(locked).toBeDisabled();
  });

  it('keeps the primary invite disabled until the email looks like an address', async () => {
    const user = userEvent.setup();
    mount();

    const send = await screen.findByRole('button', { name: 'Send primary invite' });
    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText('Email address'), 'jane');
    expect(screen.getByRole('button', { name: 'Send primary invite' })).toBeDisabled();

    await user.type(screen.getByLabelText('Email address'), '@example.com');
    expect(screen.getByRole('button', { name: 'Send primary invite' })).toBeEnabled();
    expect(api.mintInvite).not.toHaveBeenCalled();
  });

  it('says nothing was sent when the household already has an active portal account', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockResolvedValue({ kinfolkId: 'fam1', status: 'already_active' });
    mount();

    await user.click(
      await screen.findByRole('button', { name: 'Invite this household to the portal' }),
    );

    // A success response that emailed nobody must never read as an invite sent.
    expect(await screen.findByText(/No invite sent/)).toBeInTheDocument();
    expect(screen.getByText(/already has an active portal account/)).toBeInTheDocument();
    expect(screen.queryByText(/Portal invite sent/)).not.toBeInTheDocument();
  });

  it('says nothing was sent when the household record carries no email', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockResolvedValue({ kinfolkId: 'fam1', status: 'no_email' });
    mount();

    await user.click(
      await screen.findByRole('button', { name: 'Invite this household to the portal' }),
    );

    expect(await screen.findByText(/no email address on file/)).toBeInTheDocument();
    expect(screen.queryByText(/Portal invite sent/)).not.toBeInTheDocument();
  });
});

describe('HouseholdMembers ERROR', () => {
  it('reverts an optimistic permission toggle and names the failure', async () => {
    const user = userEvent.setup();
    api.setMemberPermissions.mockRejectedValue(new Error('permission-denied'));
    mount();

    const toggle = await screen.findByRole('switch', {
      name: 'Full billing for marcus@example.com',
    });
    await user.click(toggle);

    expect(
      await screen.findByText(/setMemberPermissions failed for marcus@example.com/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Full billing for marcus@example.com' }),
      ).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('reports a failed mint instead of clearing the form as if it sent', async () => {
    const user = userEvent.setup();
    api.mintInvite.mockRejectedValue(new Error('SMTP2GO rejected the send'));
    mount();

    await user.type(await screen.findByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send primary invite' }));

    expect(await screen.findByText(/mintInvite failed/)).toBeInTheDocument();
    expect(screen.getByText(/SMTP2GO rejected the send/)).toBeInTheDocument();
    // The typed address survives so the operator can retry rather than retype.
    expect(screen.getByLabelText('Email address')).toHaveValue('new@example.com');
  });

  it('reports a failed portal invite as a failure, not as an outcome', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockRejectedValue(new Error('internal'));
    mount();

    await user.click(
      await screen.findByRole('button', { name: 'Invite this household to the portal' }),
    );

    expect(await screen.findByText(/inviteKinfolkToPortal failed/)).toBeInTheDocument();
  });

  it('reports a failed removal and keeps the confirm dialog open', async () => {
    const user = userEvent.setup();
    api.removeMember.mockRejectedValue(new Error('not-found: member not found'));
    mount();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    // Two "Remove" buttons exist once the dialog opens: the row's and the
    // dialog's confirm. Scoping is the point of the confirm step.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText(/removeMember failed/)).toBeInTheDocument();
    // Still open, so the operator sees the failure attached to what they asked
    // for rather than a dialog that closed as though it worked.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.listHouseholdMembers).toHaveBeenCalledTimes(1);
  });
});

describe('HouseholdMembers UNAUTHORIZED and unreadable', () => {
  it('says the member list could not be loaded, and does not claim the household is empty', async () => {
    api.listHouseholdMembers.mockRejectedValue(new Error('permission-denied: Admin claim required.'));
    api.listHouseholdInvites.mockResolvedValue([]);
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={() => {}} />);

    expect(await screen.findByText(/listMembers failed/)).toBeInTheDocument();
    expect(screen.getByText(/Admin claim required/)).toBeInTheDocument();
    expect(screen.queryByText(/Nobody has claimed this household yet/)).not.toBeInTheDocument();
  });

  it('fails the invite list on its own without taking the member list down with it', async () => {
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockRejectedValue(new Error('not-found: kinfolkId not found.'));
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={() => {}} />);

    expect(await screen.findByText(/listInvites failed/)).toBeInTheDocument();
    expect(screen.getByText('marcus@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/No invite has ever been sent/)).not.toBeInTheDocument();
  });

  it('shows a proven-empty roster as empty, which an unreadable one never gets', async () => {
    mount({ members: [], invites: [] });
    expect(await screen.findByText(/Nobody has claimed this household yet/)).toBeInTheDocument();
    expect(await screen.findByText(/No invite has ever been sent/)).toBeInTheDocument();
  });
});

describe('inviteMetaLine', () => {
  it('shows sent and expiry dates plus a truncated handle, never the claim link', () => {
    const line = inviteMetaLine(invite());
    expect(line).toContain('Sent 2026-05-26');
    expect(line).toContain('expires 2026-06-09');
    expect(line).toContain('rq_8fk29…');
    expect(line).not.toContain('rq_8fk29abc');
    expect(line).not.toContain('?invite=');
  });

  it('falls back to the created date when the invite was never emailed', () => {
    expect(inviteMetaLine(invite({ sentToInviteeAt: null, createdAt: '2026-05-27T00:00:00.000Z' })))
      .toContain('Created 2026-05-27');
  });

  it('reads expired rather than expires once the invite has lapsed', () => {
    expect(inviteMetaLine(invite({ effectiveStatus: 'EXPIRED' }))).toContain('expired 2026-06-09');
  });

  it('omits a date the server did not return instead of substituting today', () => {
    const line = inviteMetaLine(
      invite({ sentToInviteeAt: null, createdAt: null, expiresAt: null }),
    );
    expect(line).toBe('rq_8fk29…');
  });
});
