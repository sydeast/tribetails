// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ getInvite: vi.fn() }));

vi.mock('../api/members', async (orig) => ({
  ...(await orig<typeof import('../api/members')>()),
  getInvite: api.getInvite,
}));

// Rendered bare, with no RouterProvider: Link becomes the anchor it renders as.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => {
    const href = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  linkOptions: (o: unknown) => o,
}));

import { InviteDetail, claimedLabel, grantedPermissions, invitedByLabel } from './InviteDetail';
import type { AdminInviteDetail } from '../api/members';

function detail(over: Partial<AdminInviteDetail> = {}): AdminInviteDetail {
  return {
    inviteId: 'rq_8fk29abcdef',
    tribeId: 'fam_77',
    householdName: 'the Demos',
    invitedEmail: 'jane@example.com',
    secondaryLabel: 'Sister',
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: false,
      kin_edit: false,
      kintales_only: false,
      home_access: false,
    },
    status: 'EMAIL_SENT',
    effectiveStatus: 'EMAIL_SENT',
    redeemable: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    sentToInviteeAt: '2026-10-01T10:00:05.000Z',
    expiresAt: '2026-10-08T10:00:00.000Z',
    revokedAt: null,
    acceptedUid: null,
    invitedByRole: 'PRIMARY',
    invitedBy: { uid: 'p1', displayName: 'Dora Demo', email: 'dora@example.com' },
    acceptedBy: null,
    acceptedAt: null,
    source: 'mytribe-portal',
    ...over,
  };
}

/** The value beside one label in the facts list. */
function fact(label: string): string | null {
  const dt = screen.getAllByRole('term').find((el) => el.textContent === label);
  return dt?.nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  api.getInvite.mockReset();
});

describe('InviteDetail screen', () => {
  it('reads the invite by the id in the URL and shows who invited whom, the household, role, status and dates', async () => {
    api.getInvite.mockResolvedValue(detail());

    render(<InviteDetail inviteId="rq_8fk29abcdef" />);

    expect(api.getInvite).toHaveBeenCalledWith('rq_8fk29abcdef');
    expect(await screen.findByRole('heading', { level: 1, name: 'jane@example.com' })).toBeInTheDocument();
    expect(screen.getByText('Dora Demo (dora@example.com), household primary')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'the Demos' })[0]).toHaveAttribute(
      'href',
      '/household-members/fam_77',
    );
    expect(fact('Invited')).toBe('jane@example.com');
    expect(fact('Role')).toBe('Secondary');
    expect(fact('Status')).toBe('Email sent');
    expect(fact('Created')).toBe('2026-10-01');
    expect(fact('Sent')).toBe('2026-10-01');
    expect(fact('Expires')).toBe('2026-10-08');
    expect(fact('Claimed')).toBe('Not claimed');
    // The invite id is the claim token: the page shows only the handle.
    expect(fact('Invite')).toBe('inviteId rq_8fk29…');
    expect(document.body.textContent).not.toContain('rq_8fk29abcdef');
  });

  it('shows a loading cue while the read is in flight', () => {
    api.getInvite.mockReturnValue(new Promise(() => {}));
    render(<InviteDetail inviteId="rq_1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading this invite/);
  });

  it('a failed read says so and offers a retry, never an empty page', async () => {
    api.getInvite.mockRejectedValueOnce(new Error('No invite with that id.'));
    api.getInvite.mockResolvedValueOnce(detail());

    render(<InviteDetail inviteId="rq_1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('getInvite failed: No invite with that id.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'jane@example.com' })).toBeInTheDocument();
    expect(api.getInvite).toHaveBeenCalledTimes(2);
  });

  it('offers the household’s members and invites screen as its action, where Revoke lives', async () => {
    api.getInvite.mockResolvedValue(detail());
    render(<InviteDetail inviteId="rq_1" />);
    expect(
      await screen.findByRole('link', { name: 'Open the Demos’s members and invites' }),
    ).toHaveAttribute('href', '/household-members/fam_77');
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  it('breadcrumbs back to the Invites list', async () => {
    api.getInvite.mockResolvedValue(detail());
    render(<InviteDetail inviteId="rq_1" />);
    expect(await screen.findByRole('link', { name: 'Invites' })).toBeInTheDocument();
  });
});

describe('InviteDetail labels', () => {
  it('names a business-minted invite as the admin’s', () => {
    expect(invitedByLabel(detail({ invitedByRole: 'AUNTIE', invitedBy: null }))).toBe('TribeTails (admin invite)');
  });

  it('keeps an inviter Auth could not read visible', () => {
    expect(invitedByLabel(detail({ invitedBy: { uid: 'p1', displayName: null, email: null } }))).toBe(
      'Account not found, household primary',
    );
  });

  it('says when and by whom an accepted invite was claimed, and admits a missing date', () => {
    expect(
      claimedLabel(
        detail({
          effectiveStatus: 'ACCEPTED',
          acceptedAt: '2026-10-03T08:30:00.000Z',
          acceptedBy: { uid: 'u7', displayName: null, email: 'jane@example.com' },
        }),
      ),
    ).toBe('2026-10-03, by jane@example.com');
    expect(claimedLabel(detail({ effectiveStatus: 'ACCEPTED', acceptedAt: null, acceptedBy: null }))).toBe(
      'Claimed, date not recorded',
    );
  });

  it('lists only the permissions the invite grants', () => {
    expect(grantedPermissions(detail())).toHaveLength(1);
  });
});
