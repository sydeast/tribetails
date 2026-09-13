// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';

// The breadcrumb's "Directory" step is a real route link on the standalone
// mount (the `/household-members/{id}` route, from which `/directory` is
// somewhere else), and a real `Link` wants a RouterProvider no suite in this
// tree mounts. Stood in for by the anchor it renders, the AppShell.test.tsx
// convention.
// `useRouter` is here for the Back control, which reads `history.canGoBack()`
// to choose between stepping back and the `onBack` fallback (#689). The default
// is a cold arrival, nothing behind us, which is what most of this file mounts.
const routerHistory = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  useRouter: () => ({ history: routerHistory }),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={Object.entries(params ?? {}).reduce((p, [k, v]) => p.replace(`$${k}`, v), to)} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({
  listHouseholdMembers: vi.fn(),
  listHouseholdInvites: vi.fn(),
  revokeInvite: vi.fn(),
  setMemberPermissions: vi.fn(),
  removeMember: vi.fn(),
  inviteKinfolkToPortal: vi.fn(),
  listRecoveryCandidates: vi.fn(),
  executePrimaryRecovery: vi.fn(),
}));

vi.mock('../api/members', async (orig) => ({
  ...(await orig<typeof import('../api/members')>()),
  listHouseholdMembers: api.listHouseholdMembers,
  listHouseholdInvites: api.listHouseholdInvites,
  listRecoveryCandidates: api.listRecoveryCandidates,
}));
vi.mock('../api/membersWrite', async (orig) => ({
  ...(await orig<typeof import('../api/membersWrite')>()),
  revokeInvite: api.revokeInvite,
  setMemberPermissions: api.setMemberPermissions,
  removeMember: api.removeMember,
  inviteKinfolkToPortal: api.inviteKinfolkToPortal,
  executePrimaryRecovery: api.executePrimaryRecovery,
}));

import { ToastProvider } from '../components/Toast';
import { HouseholdMembers, householdInitial, inviteMetaLine, whereLine } from './HouseholdMembers';
import type { HouseholdInvite, HouseholdMember, RecoveryCandidate } from '../api/members';

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

function candidate(over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    uid: 'u1',
    email: 'marcus@example.com',
    secondaryLabel: 'Spouse',
    role: 'SECONDARY',
    status: 'ACTIVE',
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
  routerHistory.canGoBack.mockReset();
  routerHistory.canGoBack.mockReturnValue(false);
  routerHistory.back.mockReset();
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
      await screen.findByRole('button', { name: 'Invite to portal' }),
    );

    await waitFor(() => expect(api.inviteKinfolkToPortal).toHaveBeenCalledWith('fam1'));
    expect(await screen.findByText(/Portal invite sent to the Walls/)).toBeInTheDocument();
  });
});

/**
 * RULING (issue #684): "Invite a primary by email is unnecessary. We already
 * have the Portal Access button." That button, "Invite to portal" in the hero
 * since #755, already sends the same primary claim link, so the typed-address
 * form and its `submitInvite` handler are gone. `mintInvite` stays registered
 * (PRIMARY-only, per the 2026-08-04 invite ruling) with no caller left in this
 * screen.
 */
describe('HouseholdMembers invite by email is gone', () => {
  it('renders no typed-email invite form, only the portal invite button', async () => {
    mount();

    await screen.findByText('marcus@example.com');
    expect(screen.queryByRole('button', { name: 'Send primary invite' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByText('Invite a primary by email')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Invite to portal' }),
    ).toBeInTheDocument();
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

  it('says the entitlements are held by role, as the mock footnote and the panel tooltip', async () => {
    mount({ members: [primary()] });

    // The sentence moved into the Primary contact panel's tooltip (#758): it
    // is in the DOM for the accessible description, hidden until hovered.
    expect(await screen.findByText(/Held by role, not by setting/)).toBeInTheDocument();
    // The mock's `.cbar` chip stands where the six "Granted" rows stood: one
    // capsule that reads as state rather than as six controls.
    const row = (await screen.findByText('loretta@example.com')).closest('li');
    const chip = within(row as HTMLElement).getByText('All permissions granted by role');
    expect(chip).toHaveClass('den-statuspill', 'den-statuspill--compact');
    expect(chip).toHaveAttribute('data-tone', 'success');
    expect(within(row as HTMLElement).queryByText('Granted')).toBeNull();
    expect(within(row as HTMLElement).queryByText('permissions')).toBeNull();
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

  it('offers no way for an admin to invite a secondary', async () => {
    mount({ members: [primary()] });

    await screen.findByText('loretta@example.com');
    // No invite form of any kind lives on this screen now (issue #684): the
    // secondary-role picker that used to sit inside it is gone with it.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Secondary' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send primary invite' })).not.toBeInTheDocument();
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

  it('says nothing was sent when the household already has an active portal account', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockResolvedValue({ kinfolkId: 'fam1', status: 'already_active' });
    mount();

    await user.click(
      await screen.findByRole('button', { name: 'Invite to portal' }),
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
      await screen.findByRole('button', { name: 'Invite to portal' }),
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

  it('reports a failed portal invite as a failure, not as an outcome', async () => {
    const user = userEvent.setup();
    api.inviteKinfolkToPortal.mockRejectedValue(new Error('internal'));
    mount();

    await user.click(
      await screen.findByRole('button', { name: 'Invite to portal' }),
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

/**
 * Primary recovery (issue #378). The claim link this sends grants the
 * household, so the destination is a closed set the server owns, never a box
 * the operator types into, and a refusal has to arrive as the server's own
 * words rather than as "something went wrong".
 */
describe('HouseholdMembers PRIMARY RECOVERY', () => {
  const roster = [
    member({ uid: 'p1', role: 'PRIMARY', status: 'ACTIVE', invitedEmail: 'lost@example.com' }),
    member({ uid: 'u1', role: 'SECONDARY', status: 'ACTIVE', invitedEmail: 'marcus@example.com' }),
  ];

  async function openDialog(candidates: RecoveryCandidate[] = [candidate()]) {
    const user = userEvent.setup();
    api.listRecoveryCandidates.mockResolvedValue(candidates);
    mount({ members: roster });
    await user.click(await screen.findByRole('button', { name: 'Swap primary' }));
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('offers the eligible verified addresses as a choice, and no free-text field', async () => {
    const { dialog } = await openDialog([
      candidate(),
      candidate({ uid: 'u2', email: 'nina@example.com', secondaryLabel: 'Sister' }),
    ]);

    const choices = await within(dialog).findAllByRole('radio');
    expect(choices.map((c) => (c as HTMLInputElement).value)).toEqual([
      'marcus@example.com',
      'nina@example.com',
    ]);
    // The defect was an operator-typed address. There is no textbox to type one
    // into, and this assertion is the whole point of the dialog.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(api.listRecoveryCandidates).toHaveBeenCalledWith('fam1', 'p1');
  });

  it('sends the claim link to the picked address and reloads the roster', async () => {
    api.executePrimaryRecovery.mockResolvedValue({ inviteId: 'rq_1234abcd' });
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: /marcus@example\.com/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Send the claim link' }));

    await waitFor(() =>
      expect(api.executePrimaryRecovery).toHaveBeenCalledWith({
        familyId: 'fam1',
        newEmail: 'marcus@example.com',
        oldUid: 'p1',
      }),
    );
    await waitFor(() => expect(api.listHouseholdMembers).toHaveBeenCalledTimes(2));
  });

  it('will not send until an address is picked', async () => {
    const { dialog } = await openDialog();
    await within(dialog).findAllByRole('radio');
    expect(within(dialog).getByRole('button', { name: 'Send the claim link' })).toBeDisabled();
    expect(api.executePrimaryRecovery).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in full, instead of a generic failure", async () => {
    const refusal =
      'Recovery cannot send a claim link to typo@example.com. It must go to a household ' +
      'member with a verified email address. Eligible addresses: marcus@example.com.';
    api.executePrimaryRecovery.mockRejectedValue(new Error(refusal));
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: /marcus@example\.com/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Send the claim link' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    // Open, and the roster untouched: a refused recovery suspended nobody, so
    // the screen must not reload as though something moved.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.listHouseholdMembers).toHaveBeenCalledTimes(1);
  });

  it('says what to do instead when nobody on the household is verified', async () => {
    const { dialog } = await openDialog([]);
    expect(
      await within(dialog).findByText(/no one the claim link can safely go to/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Send the claim link' })).toBeDisabled();
  });

  it('names the failing read rather than showing an empty choice list', async () => {
    api.listRecoveryCandidates.mockRejectedValue(new Error('permission-denied: Admin claim required.'));
    const user = userEvent.setup();
    mount({ members: roster });
    await user.click(await screen.findByRole('button', { name: 'Swap primary' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/listRecoveryCandidates failed/)).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
  });

  it('offers no recovery at all on a household with no active primary', async () => {
    mount({ members: [member()] });
    expect(await screen.findByText('marcus@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap primary' })).toBeNull();
    expect(screen.getByText(/no active primary to recover/i)).toBeInTheDocument();
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

/**
 * Item 7b. `auntieos-members-2026-05-27.html` heads this screen
 * `Directory / Households / the Wrens / Members`, and this screen is reachable
 * two ways: as a sub-view of the household profile, and as its own
 * `/household-members/{id}` route. Since #689 the screen has ONE mount, that
 * route, so both walkable steps are route links rather than one link and one
 * button that only a plain left click can reach.
 */
describe('HouseholdMembers breadcrumbs', () => {
  it('trails Directory / household / this page, with only the last as current', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3);
    expect(within(nav).getByText('Members and invites')).toHaveAttribute('aria-current', 'page');
  });
  it('links Directory as a route, because this screen IS a route', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    // An anchor, not a button: standing at /household-members/{id}, /directory
    // is somewhere else, so it can be middle-clicked and copied like any link.
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute(
      'href',
      '/directory',
    );
  });
  it('links the household step at its own profile route', async () => {
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockResolvedValue([invite()]);
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={vi.fn()} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'the Walls' })).toHaveAttribute(
      'href',
      '/directory/fam1',
    );
  });

  // Pre-existing: the /household-members/{id} route passes no name, so a cold
  // deep link genuinely has only the id to show. Showing it is honest; showing
  // a placeholder household name would not be.
  it('falls back to the id when the household name has not been passed down', async () => {
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockResolvedValue([invite()]);
    render(<HouseholdMembers kinfolkId="fam1" onBack={() => {}} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'fam1' })).toBeInTheDocument();
  });
});

/**
 * #755, checklist line Members. The screen is laid out as
 * `ui-ideas/auntieos-members-2026-05-27.html` draws it: the hero names the
 * household with its crest and a mono line of counts, the actions sit in the
 * band, and the members are split by role into two panels, each member a
 * block wearing the kit's compact capsules. The invites half is the invites
 * mock's row. These pin the structure so a later pass cannot undo it quietly.
 */
describe('HouseholdMembers mock structure', () => {
  const primary = () =>
    member({ uid: 'p1', role: 'PRIMARY', secondaryLabel: null, invitedEmail: 'lost@example.com' });

  it('heads the page with the household crest, its name, the where line and the band actions', async () => {
    mount({ members: [primary(), member()] });
    await screen.findByText('marcus@example.com');
    const hero = document.querySelector('.den-heading') as HTMLElement;
    expect(within(hero).getByRole('heading', { level: 1 })).toHaveTextContent('the Walls');
    // The crest: the mock's letter tile, "W" for the Walls, in the leading slot.
    expect(hero.querySelector('.den-heading-leading .avatar')).not.toBeNull();
    expect(within(hero).getByRole('img', { name: 'the Walls' })).toHaveTextContent('W');
    expect(
      within(hero).getByText('familyId: fam1 · 2 members · 1 PRIMARY, 1 SECONDARY'),
    ).toHaveClass('hmembers__where');
    // The actions live in the band, in the mock's order: Back, Swap primary,
    // then the admin's one invite where the mock's primary action sat.
    const actions = hero.querySelector('.hmembers__actions') as HTMLElement;
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Back to the Walls',
      'Swap primary',
      'Invite to portal',
    ]);
  });

  it('writes the id alone while the roster is unread, never a zero count', () => {
    expect(whereLine('fam1', { status: 'loading' })).toBe('familyId: fam1');
    expect(whereLine('fam1', { status: 'error', message: 'x' })).toBe('familyId: fam1');
    expect(whereLine('fam1', { status: 'ready', data: [primary()] })).toBe(
      'familyId: fam1 · 1 member · 1 PRIMARY, 0 SECONDARY',
    );
  });

  it('takes the crest letter after a leading article', () => {
    expect(householdInitial('the Wrens')).toBe('W');
    expect(householdInitial('Pruitt')).toBe('P');
    expect(householdInitial('fam1')).toBe('F');
  });

  it('splits the roster by role into Primary contact and Secondary contacts, then Invites, with the mock meta', async () => {
    mount({ members: [primary(), member()] });
    await screen.findByText('marcus@example.com');
    const titles = Array.from(document.querySelectorAll('.den-panel-title')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['Primary contact', 'Secondary contacts', 'Invites']);
    const metas = Array.from(document.querySelectorAll('.den-panel-meta')).map(
      (el) => el.textContent,
    );
    expect(metas).toEqual(['role: PRIMARY', '1 of role: SECONDARY', '1 total']);
    const panels = document.querySelectorAll('.den-panel');
    expect(within(panels[0] as HTMLElement).getByText('lost@example.com')).toBeInTheDocument();
    expect(within(panels[0] as HTMLElement).queryByText('marcus@example.com')).toBeNull();
    expect(within(panels[1] as HTMLElement).getByText('marcus@example.com')).toBeInTheDocument();
    // No Portal access panel and no recovery panel: both are band actions now.
    expect(screen.queryByText('Portal access')).toBeNull();
    expect(screen.queryByText(/Hand the primary role/)).toBeNull();
  });

  it('draws each member as the mock block: circle, name, compact capsules, the uid in mono', async () => {
    mount({ members: [primary(), member()] });
    const row = (await screen.findByText('marcus@example.com')).closest('li') as HTMLElement;
    expect(row).toHaveClass('hmembers__member');
    expect(row).toHaveAttribute('data-role', 'secondary');
    expect(within(row).getByRole('img', { name: 'marcus@example.com' })).toHaveTextContent('M');
    const role = within(row).getByText('Secondary');
    expect(role).toHaveClass('den-statuspill', 'den-statuspill--compact');
    expect(role).toHaveAttribute('data-tone', 'teal');
    expect(within(row).getByText('Active')).toHaveAttribute('data-tone', 'teal');
    expect(within(row).getByText('u1')).toHaveClass('hmembers__member-contact');
    // The label, read-only: `updateMemberLabel` is PRIMARY-only on the server.
    expect(within(row).getByText('secondaryLabel')).toHaveClass('hmembers__labeled');
    expect(within(row).getByText('Spouse')).toHaveClass('hmembers__labelval');
    expect(within(row).queryByRole('textbox')).toBeNull();

    const prow = (await screen.findByText('lost@example.com')).closest('li') as HTMLElement;
    expect(within(prow).getByText('Primary')).toHaveAttribute('data-tone', 'purple');
    expect(within(prow).queryByText('secondaryLabel')).toBeNull();
  });

  it('paints an invited member orange and a suspended one coral', async () => {
    mount({
      members: [
        member({ uid: 'a', status: 'INVITED', invitedEmail: 'a@example.com' }),
        member({ uid: 'b', status: 'SUSPENDED', invitedEmail: 'b@example.com' }),
      ],
    });
    expect(await screen.findByText('Invited')).toHaveAttribute('data-tone', 'orange');
    expect(screen.getByText('Suspended')).toHaveAttribute('data-tone', 'error');
  });

  it('heads the permission list with the mock kicker and sets Locked on beside the kintales switch', async () => {
    mount();
    const row = (await screen.findByText('marcus@example.com')).closest('li') as HTMLElement;
    expect(within(row).getByText('permissions')).toHaveClass('hmembers__permhdr');
    const locked = within(row).getByText('Locked on');
    expect(locked).toHaveClass('den-statuspill--compact');
    expect(locked).toHaveAttribute('data-tone', 'teal');
    // On the last row, beside its switch, as the mock's lock chip sits.
    const lastRow = locked.closest('li') as HTMLElement;
    expect(within(lastRow).getByText('KinTales feed')).toBeInTheDocument();
    expect(within(lastRow).getByRole('switch')).toBeDisabled();
    expect(within(row).getAllByText('Locked on')).toHaveLength(1);
  });

  it('offers none of the mock controls the admin cannot use', async () => {
    mount();
    await screen.findByText('marcus@example.com');
    // Add secondary contact: the admin does not invite the secondary.
    expect(screen.queryByRole('button', { name: /add secondary/i })).toBeNull();
    // Save label and Swap contact info: PRIMARY-only callables.
    expect(screen.queryByRole('button', { name: /save label/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /swap contact/i })).toBeNull();
  });

  it('draws an invite as the invites mock row: stripe, circle, address, provenance, compact pills', async () => {
    mount();
    const row = (await screen.findByText('jane@example.com')).closest('li') as HTMLElement;
    expect(row).toHaveClass('hmembers__invite');
    expect(row.querySelector('.hmembers__invite-accent')).toHaveAttribute('data-tone', 'orange');
    expect(within(row).getByRole('img', { name: 'jane@example.com' })).toHaveTextContent('J');
    expect(within(row).getByText(/Sent 2026-05-26/)).toHaveClass('hmembers__invite-meta');
    const pills = Array.from(row.querySelectorAll('.den-statuspill--compact')).map((p) => [
      p.textContent,
      p.getAttribute('data-tone'),
    ]);
    expect(pills).toEqual([
      ['Email sent', 'orange'],
      ['Secondary', 'purple'],
      ['Sister', 'neutral'],
    ]);
    // The group heading and its mono note, the note a sibling of the h3 so the
    // section's accessible name stays the one word.
    expect(screen.getByRole('heading', { level: 3, name: 'Pending' })).toBeInTheDocument();
    expect(screen.getByText('PENDING / EMAIL_SENT · 1')).toHaveClass('hmembers__group-note');
  });

  it('says the secondaries are unknown, once, while the member read is failing', async () => {
    api.listHouseholdMembers.mockRejectedValue(new Error('permission-denied'));
    api.listHouseholdInvites.mockResolvedValue([]);
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={() => {}} />);
    expect(await screen.findByText(/listMembers failed/)).toBeInTheDocument();
    expect(screen.getByText(/Secondary contacts unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No secondary contacts yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Swap primary' })).toBeNull();
  });

  it('draws every capsule with the kit pill; the local pill class is gone', async () => {
    mount({ members: [primary(), member()] });
    await screen.findByText('marcus@example.com');
    expect(document.querySelector('.hmembers__pill')).toBeNull();
    expect(document.querySelectorAll('.den-statuspill').length).toBeGreaterThan(0);
  });
});

/**
 * #689. The Back control here used to say "Back to household" and always go to
 * the household profile, whichever of the two doors the operator came through
 * (the profile's own action, or a card in the admin-wide Invites list).
 */
describe('HouseholdMembers Back', () => {
  it('names the household, and goes there, when nothing is behind this page', async () => {
    const onBack = vi.fn();
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockResolvedValue([invite()]);
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to the Walls' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(routerHistory.back).not.toHaveBeenCalled();
  });

  // The `/household-members/{id}` route passes no name, so a cold deep link has
  // only the id. The button shows it, matching the trail step directly above it
  // under the same ruling: the id is honest and a stand-in household name is not.
  it('shows the id in the fallback label when no name was passed down', async () => {
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockResolvedValue([invite()]);
    render(<HouseholdMembers kinfolkId="fam1" onBack={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Back to fam1' })).toBeInTheDocument();
  });

  it('steps back through history, under a plain label, when the operator walked here', async () => {
    routerHistory.canGoBack.mockReturnValue(true);
    const onBack = vi.fn();
    api.listHouseholdMembers.mockResolvedValue([member()]);
    api.listHouseholdInvites.mockResolvedValue([invite()]);
    render(<HouseholdMembers kinfolkId="fam1" kinfolkName="the Walls" onBack={onBack} />);
    // The Invites list is one of the doors in, and it is not the profile.
    expect(screen.queryByRole('button', { name: /back to/i })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(routerHistory.back).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });
});
