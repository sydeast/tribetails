import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, linkOptions } from '@tanstack/react-router';
import {
  PERMISSION_META,
  formatInviteDate,
  getInvite,
  inviteHandle,
  inviteStatusLabel,
  type AdminInviteDetail,
  type InviteParty,
} from '../api/members';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { DenPanel, DenScreenHeading, StatusPill } from '../components/DenScreenKit';
import { invitePillTone } from './Invites';
import './InviteDetail.css';

/**
 * ONE invite, at `/invites/$inviteId` (#1339).
 *
 * WHY IT EXISTS. The `invite.auntie-notify` email, the business's own copy of
 * every household invite, links to `${AUNTIE_OS_REVIEW_BASE_URL}/invites/<id>`.
 * The router had only the admin-wide list, so that link opened nothing.
 *
 * THE READ is `getInvite`, by id. Not a lookup in a page of `listAllInvites`:
 * that page holds 200 rows, and an older invite falling off it would read as
 * "not found" when it is not.
 *
 * ACTIONS. The list this opens from offers one: the household link, because
 * Revoke and the rest live on the household's own Members and invites screen
 * (the 2026-08-04 invite ruling; see `Invites.tsx`). This screen offers the
 * same one. It does not grow a second Revoke beside the one that already exists.
 *
 * THE INVITE ID IS A BEARER TOKEN. The URL carries it because the email link
 * does; the page shows only `inviteHandle`'s truncated form.
 */

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/** A date, or the words for not having one. Never today's date standing in. */
function dateOr(iso: string | null, missing: string): string {
  return formatInviteDate(iso) ?? missing;
}

function roleLabel(role: AdminInviteDetail['proposedRole']): string {
  return role === 'PRIMARY' ? 'Primary' : 'Secondary';
}

function partyLabel(party: InviteParty): string {
  if (party.displayName !== null && party.email !== null) return `${party.displayName} (${party.email})`;
  return party.displayName ?? party.email ?? 'Account not found';
}

/** Who sent it, in words. */
export function invitedByLabel(invite: AdminInviteDetail): string {
  if (invite.invitedByRole === 'AUNTIE') return 'TribeTails (admin invite)';
  if (invite.invitedBy === null) return 'Household primary (account not recorded)';
  return `${partyLabel(invite.invitedBy)}, household primary`;
}

/** When and by whom it was claimed, or why there is nothing to say. */
export function claimedLabel(invite: AdminInviteDetail): string {
  if (invite.effectiveStatus !== 'ACCEPTED') return 'Not claimed';
  const when = dateOr(invite.acceptedAt, 'date not recorded');
  if (invite.acceptedBy === null) return `Claimed, ${when}`;
  return `${when}, by ${partyLabel(invite.acceptedBy)}`;
}

/** The permission labels this invite grants, in the shared order. */
export function grantedPermissions(invite: AdminInviteDetail): string[] {
  return PERMISSION_META.filter((m) => invite.proposedPermissions[m.key]).map((m) => m.label);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="invite-detail__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function InviteFacts({ invite }: { invite: AdminInviteDetail }) {
  const perms = grantedPermissions(invite);
  const tone = invitePillTone(invite.effectiveStatus);
  const label = invite.secondaryLabel?.trim() ?? '';
  return (
    <>
      <div className="invite-detail__pills">
        <StatusPill label={inviteStatusLabel(invite.effectiveStatus)} tone={tone} />
        <StatusPill label={roleLabel(invite.proposedRole)} tone="purple" />
        {label !== '' && <StatusPill label={label} tone="neutral" />}
      </div>

      <DenPanel title="Invite">
        <dl className="invite-detail__facts">
          <Row label="Household">
            <Link
              to="/household-members/$kinfolkId"
              params={{ kinfolkId: invite.tribeId }}
              className="invite-detail__household"
            >
              {invite.householdName}
            </Link>
          </Row>
          <Row label="Invited by">{invitedByLabel(invite)}</Row>
          <Row label="Invited">{invite.invitedEmail}</Row>
          <Row label="Role">{roleLabel(invite.proposedRole)}</Row>
          <Row label="Status">{inviteStatusLabel(invite.effectiveStatus)}</Row>
          <Row label="Created">{dateOr(invite.createdAt, 'unknown')}</Row>
          <Row label="Sent">{dateOr(invite.sentToInviteeAt, 'not sent')}</Row>
          {invite.effectiveStatus !== 'ACCEPTED' && invite.effectiveStatus !== 'REVOKED' && (
            <Row label={invite.effectiveStatus === 'EXPIRED' ? 'Expired' : 'Expires'}>
              {dateOr(invite.expiresAt, 'unknown')}
            </Row>
          )}
          {invite.effectiveStatus === 'REVOKED' && (
            <Row label="Revoked">{dateOr(invite.revokedAt, 'unknown')}</Row>
          )}
          <Row label="Claimed">{claimedLabel(invite)}</Row>
          <Row label="Permissions">{perms.length === 0 ? 'None' : perms.join(', ')}</Row>
          {invite.source !== null && <Row label="Source">{invite.source}</Row>}
          <Row label="Invite">
            {/* Truncated on purpose. The full id is the claim token. */}
            <span className="invite-detail__handle">inviteId {inviteHandle(invite.inviteId)}</span>
          </Row>
        </dl>
      </DenPanel>

      <p className="invite-detail__actions">
        <Link
          to="/household-members/$kinfolkId"
          params={{ kinfolkId: invite.tribeId }}
          className="invite-detail__action"
        >
          Open {invite.householdName}&rsquo;s members and invites
        </Link>
      </p>
    </>
  );
}

export function InviteDetail({ inviteId }: { inviteId: string }) {
  const [state, setState] = useState<Async<AdminInviteDetail>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading', retry: load });
    getInvite(inviteId)
      .then((data) => {
        if (live) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) {
          setState({
            status: 'error',
            message: `getInvite failed: ${errText(err, 'Load failed')}`,
            retry: load,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [inviteId]);

  useEffect(() => load(), [load]);

  const title = state.status === 'ready' ? state.data.invitedEmail : 'Invite';

  return (
    <section className="invite-detail">
      <DenScreenHeading
        crumbs={[{ label: 'Invites', link: linkOptions({ to: '/invites' }) }, { label: title }]}
        title={title}
      />
      <AsyncRegion state={state} what="this invite" isEmpty={() => false} empty={null}>
        {(invite) => <InviteFacts invite={invite} />}
      </AsyncRegion>
    </section>
  );
}
