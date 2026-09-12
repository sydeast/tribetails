// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ listAllInvites: vi.fn() }));

vi.mock('../api/members', async (orig) => ({
  ...(await orig<typeof import('../api/members')>()),
  listAllInvites: api.listAllInvites,
}));

// The card's household link is a real TanStack `Link`. Rendering the screen
// bare has no RouterProvider, so the Link is stubbed to the anchor it becomes,
// which is also what the href assertion below wants to read.
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
    const href = Object.entries(params ?? {}).reduce(
      (acc, [k, v]) => acc.replace(`$${k}`, v),
      to,
    );
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

import {
  Invites,
  INVITE_FILTERS,
  filterInvites,
  groupInvitesByStatus,
  inviteDateParts,
  invitePillTone,
} from './Invites';
import type { AdminInvite } from '../api/members';

function invite(over: Partial<AdminInvite> = {}): AdminInvite {
  const status = over.effectiveStatus ?? over.status ?? 'PENDING';
  return {
    inviteId: 'rq_8fk29abc',
    tribeId: 'f1',
    householdName: 'the Demos',
    invitedEmail: 'jane@example.com',
    secondaryLabel: null,
    proposedRole: 'PRIMARY',
    proposedPermissions: {
      billing_full: true,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: true,
      kintales_only: true,
      home_access: true,
    },
    status,
    effectiveStatus: status,
    redeemable: status === 'PENDING' || status === 'EMAIL_SENT',
    createdAt: '2026-08-01T00:00:00.000Z',
    sentToInviteeAt: '2026-08-01T00:01:00.000Z',
    expiresAt: '2026-08-15T00:00:00.000Z',
    revokedAt: null,
    acceptedUid: null,
    ...over,
  };
}

beforeEach(() => {
  api.listAllInvites.mockReset();
});

describe('Invites', () => {
  it('groups by status and defaults to the ones still outstanding', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'i1', tribeId: 'f1', householdName: 'the Demos', status: 'PENDING' }),
      invite({ inviteId: 'i2', tribeId: 'f2', householdName: 'the Marlowes', status: 'EXPIRED' }),
      invite({ inviteId: 'i3', tribeId: 'f3', householdName: 'the Sparrows', status: 'ACCEPTED' }),
    ]);

    render(<Invites />);

    expect(await screen.findByRole('button', { name: 'Outstanding 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('the Demos')).toBeInTheDocument();
    expect(screen.getByText('the Marlowes')).toBeInTheDocument();
    expect(screen.queryByText('the Sparrows')).not.toBeInTheDocument();
    // Grouped, not one flat list: the two outstanding rows sit under different
    // headings because they need different things done about them.
    expect(screen.getByRole('heading', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Expired' })).toBeInTheDocument();
  });

  it('shows the accepted ones when that filter is chosen', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'i1', householdName: 'the Demos', status: 'PENDING' }),
      invite({ inviteId: 'i3', householdName: 'the Sparrows', status: 'ACCEPTED' }),
    ]);

    render(<Invites />);
    await userEvent.click(await screen.findByRole('button', { name: 'Accepted 1' }));

    expect(screen.getByText('the Sparrows')).toBeInTheDocument();
    expect(screen.queryByText('the Demos')).not.toBeInTheDocument();
  });

  it('links each card to that household’s members and invites screen', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'i1', tribeId: 'fam_77', householdName: 'the Demos' }),
    ]);

    render(<Invites />);

    expect(await screen.findByRole('link', { name: 'the Demos' })).toHaveAttribute(
      'href',
      '/household-members/fam_77',
    );
  });

  it('shows sent and expiry dates, and says so when the server had no date', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({
        inviteId: 'i1',
        householdName: 'the Demos',
        sentToInviteeAt: '2026-08-01T00:01:00.000Z',
        expiresAt: null,
      }),
    ]);

    render(<Invites />);
    const card = (await screen.findByRole('link', { name: 'the Demos' })).closest('li')!;

    expect(within(card).getByText(/Sent 2026-08-01/)).toBeInTheDocument();
    // Not a blank, and not today's date: a missing expiry reads as missing.
    expect(within(card).getByText(/expires unknown/)).toBeInTheDocument();
  });
  /**
   * The mock's shape (#755): no panel around the sections, a serif heading
   * with the mono status note beside it (never inside it, so the section's
   * accessible name stays the one word), and every invite one row with a tone
   * stripe, a framed circle, the address, the provenance line and the pills.
   */
  it('draws the mock: hero, bare sections with a status note, and one row per invite', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({
        inviteId: 'i1',
        householdName: 'the Demos',
        status: 'EMAIL_SENT',
        proposedRole: 'SECONDARY',
        secondaryLabel: 'Sister',
      }),
      invite({
        inviteId: 'i2',
        householdName: 'the Marlowes',
        invitedEmail: 'marcus@example.com',
        status: 'PENDING',
      }),
    ]);
    const { container } = render(<Invites />);
    await screen.findByText('the Demos');
    // The hero is the kit's, with the mock's kicker and plain title.
    expect(screen.getByRole('heading', { level: 1, name: 'Invites' })).toBeInTheDocument();
    expect(container.querySelector('.den-heading-kicker')).toHaveTextContent('The Den · Invites');
    // No wrapping panel: the sections sit on the ground, as the mock draws them.
    expect(container.querySelector('.den-panel')).toBeNull();
    const section = screen.getByRole('heading', { level: 2, name: 'Pending' }).closest('section')!;
    expect(within(section).getByText('status: PENDING / EMAIL_SENT · 2')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    const row = within(section).getByText('jane@example.com').closest('li')!;
    expect(row).toHaveClass('invites__card');
    expect(row.querySelector('.invites__accent')).toHaveAttribute('data-tone', 'orange');
    expect(within(row).getByRole('img', { name: 'Invite for jane@example.com' })).toBeInTheDocument();
    // The kit's pill, in the mock's tint, then the role and the label pills.
    const pills = [...row.querySelectorAll('.den-statuspill')];
    expect(pills.map((p) => [p.textContent, p.getAttribute('data-tone')])).toEqual([
      ['Email sent', 'orange'],
      ['Secondary', 'purple'],
      ['Sister', 'neutral'],
    ]);
    // Nothing screen-local stands in for the kit pill any more.
    expect(container.querySelector('.invites__pill')).toBeNull();
  });
  it('tints each status the way the mock does', () => {
    expect(invitePillTone('PENDING')).toBe('orange');
    expect(invitePillTone('EMAIL_SENT')).toBe('orange');
    expect(invitePillTone('ACCEPTED')).toBe('teal');
    expect(invitePillTone('REVOKED')).toBe('error');
    expect(invitePillTone('EXPIRED')).toBe('muted');
  });
  it('shows no label pill when the invite carries no label', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'i1', householdName: 'the Demos', secondaryLabel: null }),
    ]);
    const { container } = render(<Invites />);
    await screen.findByText('the Demos');
    expect([...container.querySelectorAll('.den-statuspill')].map((p) => p.textContent)).toEqual([
      'Pending',
      'Primary',
    ]);
  });

  it('surfaces a failed read instead of an empty list', async () => {
    api.listAllInvites.mockRejectedValue(new Error('permission-denied'));

    render(<Invites />);

    expect(await screen.findByRole('alert')).toHaveTextContent('permission-denied');
    expect(screen.queryByText(/No invites/)).not.toBeInTheDocument();
  });

  it('says the shelf is empty only when the read really succeeded with nothing', async () => {
    api.listAllInvites.mockResolvedValue([]);

    render(<Invites />);

    expect(await screen.findByText(/No invites have been sent/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * RULING: the admin never mints a SECONDARY invite, and a primary's
   * entitlements cannot be toggled by anybody. An admin-WIDE screen has no
   * household context to mint into either. This asserts the screen never grows
   * a control that pretends otherwise, however plausible a mock makes it look.
   */
  it('offers no invite-sending control and no permission switches', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'i1', householdName: 'the Demos', proposedRole: 'PRIMARY' }),
    ]);

    render(<Invites />);
    await screen.findByText('the Demos');

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    // The ONLY things you can act on here are the four status filters. Naming
    // them exhaustively is the assertion: any control added later (Send,
    // Resend, Revoke, a permission toggle) fails here rather than shipping
    // quietly. The two info buttons are excluded by name rather than listed,
    // because they act on nothing: since #752 a heading or panel that carries
    // an explanation shows it in a tooltip instead of a line of copy, so every
    // explained section on every screen grows one and counting them here would
    // turn this guard into a tally of how many sentences the screen has.
    const actions = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label') !== 'About this section');
    expect(actions.map((b) => b.textContent?.trim())).toEqual([
      'Outstanding 1',
      'Accepted 0',
      'Revoked 0',
      'All 1',
    ]);
  });

  /** The invite id is the claim-link bearer token. */
  it('shows a truncated handle and never the full id or a claim URL', async () => {
    api.listAllInvites.mockResolvedValue([
      invite({ inviteId: 'rq_8fk29aLONGTAIL', householdName: 'the Demos' }),
    ]);

    render(<Invites />);
    await screen.findByText('the Demos');

    expect(screen.getByText(/rq_8fk29…/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('rq_8fk29aLONGTAIL');
    expect(document.body.innerHTML).not.toContain('?invite=');
  });
});

describe('inviteDateParts', () => {
  /**
   * The mock's provenance line: sent (or created), then the one date that
   * matters for the row's state. Only dates the server returned; a missing one
   * reads "unknown", never today.
   */
  it('names the date that matters for the state, and no other', () => {
    const base = {
      sentToInviteeAt: '2026-05-26T00:00:00.000Z',
      expiresAt: '2026-06-09T00:00:00.000Z',
      revokedAt: '2026-05-19T00:00:00.000Z',
    };
    expect(inviteDateParts(invite({ ...base, status: 'EMAIL_SENT' }))).toEqual([
      'Sent 2026-05-26',
      'expires 2026-06-09',
    ]);
    expect(inviteDateParts(invite({ ...base, status: 'EXPIRED' }))).toEqual([
      'Sent 2026-05-26',
      'expired 2026-06-09',
    ]);
    expect(inviteDateParts(invite({ ...base, status: 'REVOKED' }))).toEqual([
      'Sent 2026-05-26',
      'revoked 2026-05-19',
    ]);
    // No acceptance timestamp comes back from the server, so nothing is shown
    // for one: an expiry on an accepted invite is a date nobody acts on.
    expect(inviteDateParts(invite({ ...base, status: 'ACCEPTED' }))).toEqual(['Sent 2026-05-26']);
  });
  it('falls back to the creation date when the mail never went, and says unknown when it has nothing', () => {
    expect(
      inviteDateParts(
        invite({ sentToInviteeAt: null, createdAt: '2026-05-27T00:00:00.000Z', expiresAt: null }),
      ),
    ).toEqual(['Created 2026-05-27', 'expires unknown']);
    expect(
      inviteDateParts(invite({ status: 'REVOKED', revokedAt: null })),
    ).toEqual(['Sent 2026-08-01', 'revoked unknown']);
  });
});
describe('filterInvites', () => {
  const rows = [
    invite({ inviteId: 'p', status: 'PENDING' }),
    invite({ inviteId: 's', status: 'EMAIL_SENT' }),
    invite({ inviteId: 'x', status: 'EXPIRED' }),
    invite({ inviteId: 'a', status: 'ACCEPTED' }),
    invite({ inviteId: 'r', status: 'REVOKED' }),
  ];

  /**
   * "Outstanding" answers the operator's actual question, "who never accepted".
   * An EXPIRED invite belongs there and a REVOKED one does not: expiry happened
   * TO the invite, revocation was a decision already taken about it.
   */
  it('counts pending, sent and expired as outstanding, and not revoked', () => {
    expect(filterInvites(rows, 'outstanding').map((r) => r.inviteId)).toEqual(['p', 's', 'x']);
    expect(filterInvites(rows, 'accepted').map((r) => r.inviteId)).toEqual(['a']);
    expect(filterInvites(rows, 'revoked').map((r) => r.inviteId)).toEqual(['r']);
    expect(filterInvites(rows, 'all')).toHaveLength(5);
  });

  /**
   * `effectiveStatus`, not `status`. `expireStaleInvites` runs at 02:00, so a
   * lapsed invite still READS as EMAIL_SENT for up to a day; filtering on the
   * raw status would file it under Pending and invite a chase that is over.
   */
  it('files a lapsed invite by its effective status, not its stored one', () => {
    const lapsed = invite({ inviteId: 'l', status: 'EMAIL_SENT', effectiveStatus: 'EXPIRED' });
    const [row] = filterInvites([lapsed], 'outstanding');
    expect(row?.inviteId).toBe('l');
    expect(groupInvitesByStatus([lapsed]).find((s) => s.rows.length > 0)?.heading).toBe('Expired');
  });

  /** The mock's order, which is also the order HouseholdMembers stacks them. */
  it('returns every section in the mock order, empty ones included', () => {
    expect(groupInvitesByStatus([]).map((s) => s.heading)).toEqual([
      'Pending',
      'Accepted',
      'Expired',
      'Revoked',
    ]);
    expect(groupInvitesByStatus([]).map((s) => s.statusNote)).toEqual([
      'status: PENDING / EMAIL_SENT',
      'status: ACCEPTED',
      'status: EXPIRED',
      'status: REVOKED',
    ]);
  });

  it('offers exactly the four filters, outstanding first', () => {
    expect(INVITE_FILTERS.map((f) => f.key)).toEqual([
      'outstanding',
      'accepted',
      'revoked',
      'all',
    ]);
  });
});
