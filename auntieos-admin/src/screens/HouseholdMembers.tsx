import { useCallback, useEffect, useState } from 'react';
import {
  PERMISSION_META,
  formatInviteDate,
  inviteHandle,
  inviteStatusLabel,
  inviteStatusTone,
  listHouseholdInvites,
  listHouseholdMembers,
  listRecoveryCandidates,
  memberLabel,
  memberStatusTone,
  permissionsFollowRole,
  type HouseholdInvite,
  type HouseholdMember,
  type InviteStatus,
  type MemberRole,
  type PermissionKey,
  type RecoveryCandidate,
} from '../api/members';
import {
  INVITE_TTL_DAYS,
  describePortalInviteOutcome,
  executePrimaryRecovery,
  inviteKinfolkToPortal,
  removeMember,
  revokeInvite,
  setMemberPermissions,
} from '../api/membersWrite';
import { linkOptions } from '@tanstack/react-router';
import { type Async } from '../lib/async';
import { DenPanel, DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import './HouseholdMembers.css';

/**
 * Household members and invites. (B1)
 *
 * The first surface for `revokeInvite`, `setMemberPermissions`, `removeMember`
 * and `inviteKinfolkToPortal`, all of which have been registered callables
 * with no caller anywhere in `src/`. Without this screen a household cannot be
 * let into the portal at all, which is why it blocks onboarding.
 *
 * WHO INVITES WHOM (ruling, 2026-08-04). The admin invites the PRIMARY. The
 * PRIMARY invites the secondary, from MyTribe, and this screen offers no way to
 * do it for them. The one admin invite, "Portal access", mails the primary
 * claim link to the address on the kinfolk record.
 *
 * "Invite a primary by email" sent the same claim link to an address the
 * operator typed, for a household with the wrong email on file or none
 * (issue #684). The operator rejected that case: the Portal access button
 * already covers it. The form and its `submitInvite` handler are gone;
 * `mintInvite` stays a registered callable with no caller in `src/`, because
 * it is PRIMARY-only per this same ruling and the server side of it is not
 * dead code.
 *
 * WHAT A PRIMARY MAY LOSE: nothing. A primary's entitlements are inherent to
 * the role, because `requirePerm` in memberGate.ts answers for PRIMARY before
 * it reads the flags. Their rows therefore render as granted-by-role rather
 * than as switches.
 * This screen once drew five live toggles on a primary, which made billing,
 * home access and kin edit look revocable when the writes behind them changed
 * nothing any enforcement path reads. `setMemberPermissions` now refuses a
 * primary target too; `permissionsFollowRole` is the check.
 *
 * PLACEMENT follows page-specs Decision 8 (LOCKED), which re-homed both mocks
 * out of Settings: household members live under Directory / Households /
 * {household} / Members, and the Auntie "invite to app" action is a kinfolk
 * action in the Directory. So this is one household-scoped screen carrying both
 * halves, reached from the household profile and from
 * `/household-members/{kinfolkId}`, not two global Settings panels. The mocks'
 * standalone `familyId` text input is gone with it: the household is context
 * here, and a free-text tenant id is a way to invite a stranger into the wrong
 * family.
 *
 * The two mocks it follows are `ui-ideas/auntieos-members-2026-05-27.html` and
 * `auntieos-invites-2026-05-27.html`. Their "new admin surface / no UI today"
 * banners are dropped, because after this change that is no longer true, and
 * their sample emails, family ids and dates are placeholder by their own
 * admission: every value here is bound to a callable response.
 *
 * FAIL LOUD. Each of the five writes has its own error channel and its own
 * in-flight flag, so one failure cannot be mistaken for another and no control
 * reports a success the server did not confirm. Permission toggles are
 * optimistic and REVERT on failure. `inviteKinfolkToPortal`'s `already_active`
 * and `no_email` answers are successes that emailed nobody, so they render as a
 * warning that says nothing was sent, never as a sent-invite toast.
 */

export interface HouseholdMembersProps {
  kinfolkId: string;
  /** For the heading and the confirm copy. The id is used when it is blank. */
  kinfolkName?: string;
  onBack: () => void;
}

type PillTone = 'success' | 'warning' | 'error' | 'muted' | 'neutral';

function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <span className="hmembers__pill" data-tone={tone}>
      {label}
    </span>
  );
}

function RolePill({ role }: { role: MemberRole }) {
  return (
    <span className="hmembers__pill" data-role={role.toLowerCase()}>
      {role === 'PRIMARY' ? 'Primary' : 'Secondary'}
    </span>
  );
}

/** Invite groups, in the order the invites mock stacks them. */
const INVITE_GROUPS: ReadonlyArray<{ heading: string; statuses: readonly InviteStatus[] }> = [
  { heading: 'Pending', statuses: ['PENDING', 'EMAIL_SENT'] },
  { heading: 'Accepted', statuses: ['ACCEPTED'] },
  { heading: 'Expired', statuses: ['EXPIRED'] },
  { heading: 'Revoked', statuses: ['REVOKED'] },
];

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

export function HouseholdMembers({ kinfolkId, kinfolkName, onBack }: HouseholdMembersProps) {
  const { showToast } = useToast();
  const householdName = (kinfolkName ?? '').trim() === '' ? kinfolkId : (kinfolkName as string);

  const [members, setMembers] = useState<Async<HouseholdMember[]>>({ status: 'loading' });
  const [invites, setInvites] = useState<Async<HouseholdInvite[]>>({ status: 'loading' });

  // One error channel and one in-flight flag per write. Sharing them would make
  // a failed revoke look like a failed mint.
  const [permError, setPermError] = useState<string | null>(null);
  const [savingPerm, setSavingPerm] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [portalNotice, setPortalNotice] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HouseholdMember | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // Primary recovery. The choice list is loaded when the dialog opens, never on
  // first paint: it costs an Auth lookup per member and nobody recovers a
  // household by accident.
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCandidates, setRecoveryCandidates] = useState<Async<RecoveryCandidate[]>>({
    status: 'loading',
  });
  const [recoveryChoice, setRecoveryChoice] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  const loadMembers = useCallback(() => {
    let live = true;
    setMembers({ status: 'loading' });
    listHouseholdMembers(kinfolkId)
      .then((data) => {
        if (live) setMembers({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) {
          setMembers({
            status: 'error',
            message: `listMembers failed: ${errText(err, 'Load failed')}`,
            retry: loadMembers,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  const loadInvites = useCallback(() => {
    let live = true;
    setInvites({ status: 'loading' });
    listHouseholdInvites(kinfolkId)
      .then((data) => {
        if (live) setInvites({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) {
          setInvites({
            status: 'error',
            message: `listInvites failed: ${errText(err, 'Load failed')}`,
            retry: loadInvites,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => loadMembers(), [loadMembers]);
  useEffect(() => loadInvites(), [loadInvites]);

  async function togglePermission(member: HouseholdMember, key: PermissionKey, next: boolean) {
    if (members.status !== 'ready' || savingPerm !== null) return;
    // No toggle is rendered for a primary, and the server refuses the write
    // anyway. Belt and braces, so a future row layout cannot reintroduce it
    // quietly.
    if (permissionsFollowRole(member.role)) return;
    const busyKey = `${member.uid}:${key}`;
    const prev = members.data;
    // Optimistic, then reverted on failure. A toggle that snaps back with a
    // named error is honest; one that stays flipped after a rejected write is
    // not.
    setMembers({
      status: 'ready',
      data: prev.map((m) =>
        m.uid === member.uid ? { ...m, permissions: { ...m.permissions, [key]: next } } : m,
      ),
    });
    setSavingPerm(busyKey);
    setPermError(null);
    try {
      await setMemberPermissions(kinfolkId, member.uid, { [key]: next });
      showToast(`${next ? 'Granted' : 'Revoked'} ${key} for ${memberLabel(member)}.`);
    } catch (err: unknown) {
      setMembers({ status: 'ready', data: prev });
      setPermError(
        `setMemberPermissions failed for ${memberLabel(member)}: ${errText(err, 'Save failed')}`,
      );
    } finally {
      setSavingPerm(null);
    }
  }

  async function revoke(invite: HouseholdInvite) {
    if (revokingId !== null) return;
    setRevokingId(invite.inviteId);
    setRevokeError(null);
    try {
      await revokeInvite(invite.inviteId);
      showToast(`Revoked the invite to ${invite.invitedEmail}.`);
      loadInvites();
    } catch (err: unknown) {
      setRevokeError(
        `revokeInvite failed for ${invite.invitedEmail}: ${errText(err, 'The invite is still live.')}`,
      );
    } finally {
      setRevokingId(null);
    }
  }

  async function invitePortal() {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError(null);
    setPortalNotice(null);
    try {
      const result = await inviteKinfolkToPortal(kinfolkId);
      const outcome = describePortalInviteOutcome(result, householdName);
      if (outcome.sent) {
        showToast(outcome.message);
        loadInvites();
        loadMembers();
      } else {
        // A success response that emailed nobody. It gets a banner, not a
        // toast: "already active" and "no email" are things the operator has to
        // read and act on, not things to celebrate for three seconds.
        setPortalNotice(outcome.message);
      }
    } catch (err: unknown) {
      setPortalError(
        `inviteKinfolkToPortal failed: ${errText(err, 'The portal invite was not sent.')}`,
      );
    } finally {
      setPortalBusy(false);
    }
  }

  async function confirmRemove() {
    if (removeTarget === null || removing) return;
    const target = removeTarget;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeMember(kinfolkId, target.uid);
      showToast(`${memberLabel(target)} is suspended and signed out.`);
      setRemoveTarget(null);
      loadMembers();
    } catch (err: unknown) {
      setRemoveError(`removeMember failed: ${errText(err, 'The member was not removed.')}`);
    } finally {
      setRemoving(false);
    }
  }

  // The primary this recovery would take the household away from. A suspended
  // one does not count: there is nothing left to suspend, and `oldUid` is what
  // the server suspends.
  const sittingPrimary =
    members.status === 'ready'
      ? (members.data.find((m) => m.role === 'PRIMARY' && m.status !== 'SUSPENDED') ?? null)
      : null;

  function loadRecoveryCandidates(oldUid: string) {
    setRecoveryCandidates({ status: 'loading' });
    listRecoveryCandidates(kinfolkId, oldUid)
      .then((data) => setRecoveryCandidates({ status: 'ready', data }))
      .catch((err: unknown) => {
        setRecoveryCandidates({
          status: 'error',
          message: `listRecoveryCandidates failed: ${errText(err, 'Load failed')}`,
          retry: () => loadRecoveryCandidates(oldUid),
        });
      });
  }

  function openRecovery() {
    if (sittingPrimary === null) return;
    setRecoveryChoice('');
    setRecoveryError(null);
    setRecoveryOpen(true);
    loadRecoveryCandidates(sittingPrimary.uid);
  }

  async function confirmRecovery() {
    if (sittingPrimary === null || recovering || recoveryChoice === '') return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      const { inviteId } = await executePrimaryRecovery({
        familyId: kinfolkId,
        newEmail: recoveryChoice,
        oldUid: sittingPrimary.uid,
      });
      showToast(
        `Claim link sent to ${recoveryChoice}. ${memberLabel(sittingPrimary)} is suspended (${inviteHandle(inviteId)}).`,
      );
      setRecoveryOpen(false);
      loadMembers();
      loadInvites();
    } catch (err: unknown) {
      // The server's own message, verbatim. It names the eligible addresses and
      // the way out when there are none, and a generic "recovery failed" would
      // leave an operator with a locked-out household and no next move.
      setRecoveryError(errText(err, 'The claim link was not sent, and nothing was changed.'));
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div className="screen">
      <div className="d1">
        <DenScreenHeading
          // Both walkable steps are real: this screen has exactly one mount,
          // its own `/household-members/{id}` route, so `/directory` is an
          // anchor and the household is `onBack`, which the route resolves to
          // `/directory/{id}`.
          crumbs={[
            { label: 'Directory', link: linkOptions({ to: '/directory' }) },
            { label: householdName, onSelect: onBack },
            { label: 'Members and invites' },
          ]}
          title="Members and"
          accentTail="invites."
          subtitle={`Who can reach ${householdName} in MyTribe, and what each of them may do.`}
          trailing={<GhostButton label="Back to household" onClick={onBack} />}
        />
      </div>

      {permError !== null && (
        <Banner
          tone="error"
          title="That permission did not save"
          onDismiss={() => setPermError(null)}
        >
          {permError}
        </Banner>
      )}
      {revokeError !== null && (
        <Banner tone="error" title="The invite was not revoked" onDismiss={() => setRevokeError(null)}>
          {revokeError}
        </Banner>
      )}
      {portalError !== null && (
        <Banner tone="error" title="Portal invite failed" onDismiss={() => setPortalError(null)}>
          {portalError}
        </Banner>
      )}
      {portalNotice !== null && (
        <Banner tone="warning" title="Nothing was sent" onDismiss={() => setPortalNotice(null)}>
          {portalNotice}
        </Banner>
      )}

      <div className="d2">
        <DenPanel
          title="Portal access"
          subtitle={`Sends this household a primary claim link for MyTribe. It expires in ${INVITE_TTL_DAYS} days. A household that already has an active primary is left alone rather than emailed again.`}
        >
          <PrimaryButton
            label={portalBusy ? 'Sending…' : 'Invite this household to the portal'}
            onClick={() => void invitePortal()}
            disabled={portalBusy}
            busy={portalBusy}
          />
        </DenPanel>
      </div>

      <div className="d2">
        <DenPanel
          title="Members"
          subtitle="Everyone with a MyTribe account on this household. A secondary's permissions are yours to set; a primary's come with the role and are shown here rather than offered as switches. KinTales access is locked on by the server for everyone."
        >
          <AsyncRegion
            state={members}
            what="members"
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyHint>
                Nobody has claimed this household yet. Send a portal invite above, and this list
                fills in once it is accepted.
              </EmptyHint>
            }
          >
            {(rows) => (
              <ul className="hmembers__list">
                {rows.map((member) => (
                  <li key={member.uid} className="hmembers__member">
                    <div className="hmembers__member-head">
                      <div className="hmembers__member-who">
                        <span className="hmembers__member-name">{memberLabel(member)}</span>
                        <span className="hmembers__member-meta">
                          {member.secondaryLabel !== null && member.role === 'SECONDARY'
                            ? `${member.secondaryLabel} · `
                            : ''}
                          {member.uid}
                        </span>
                      </div>
                      <RolePill role={member.role} />
                      <StatusPill
                        label={member.status.charAt(0) + member.status.slice(1).toLowerCase()}
                        tone={memberStatusTone(member.status)}
                      />
                      <GhostButton
                        label="Remove"
                        onClick={() => {
                          setRemoveError(null);
                          setRemoveTarget(member);
                        }}
                      />
                    </div>

                    {permissionsFollowRole(member.role) ? (
                      <>
                        <p className="hmembers__inherent">
                          Held by role, not by setting. The primary of a household has full
                          billing, home access, kin edits and messaging because they are the
                          primary, and the server reads the role rather than these flags. There
                          is nothing here to switch off.
                        </p>
                        <ul className="hmembers__perms">
                          {PERMISSION_META.map((perm) => (
                            <li key={perm.key} className="hmembers__perm">
                              <div className="hmembers__perm-text">
                                <span className="hmembers__perm-name">{perm.label}</span>
                                <span className="hmembers__perm-desc">{perm.description}</span>
                              </div>
                              <span className="hmembers__perm-state">Granted</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <ul className="hmembers__perms">
                        {PERMISSION_META.map((perm) => {
                          const busy = savingPerm === `${member.uid}:${perm.key}`;
                          const locked = perm.serverLocked === true;
                          return (
                            <li key={perm.key} className="hmembers__perm">
                              <div className="hmembers__perm-text">
                                <span className="hmembers__perm-name">
                                  {perm.label}
                                  {locked && <span className="hmembers__perm-flag">locked on</span>}
                                </span>
                                <span className="hmembers__perm-desc">{perm.description}</span>
                              </div>
                              {busy && (
                                <span role="status" className="hmembers__saving">
                                  Saving…
                                </span>
                              )}
                              <Toggle
                                checked={member.permissions[perm.key]}
                                label={`${perm.label} for ${memberLabel(member)}`}
                                disabled={locked || savingPerm !== null}
                                onChange={(next) => void togglePermission(member, perm.key, next)}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AsyncRegion>
        </DenPanel>
      </div>

      <div className="d2">
        <DenPanel
          title="Hand the primary role to another member"
          subtitle="For a household whose primary has lost their account. The member you pick is mailed a claim link that makes them the primary, and the current primary is suspended in the same step. The link can only go to a member of this household whose email address is verified."
        >
          {sittingPrimary === null ? (
            <EmptyHint>
              There is no active primary to recover. Send this household a portal invite instead,
              and whoever accepts becomes the primary.
            </EmptyHint>
          ) : (
            <>
              <p className="hmembers__inherent">
                {memberLabel(sittingPrimary)} holds this household today. Recovery suspends them
                and mails the claim link to the member you choose; the recovering member has to
                open it before anything changes on their side.
              </p>
              <GhostButton label="Start primary recovery" onClick={openRecovery} />
            </>
          )}
        </DenPanel>
      </div>

      <div className="d2">
        <DenPanel
          title="Invites"
          subtitle="Every invite this household has been sent. An invite past its expiry reads Expired here from the moment it lapses, even though the nightly sweep has not stamped it yet."
        >
          <AsyncRegion
            state={invites}
            what="invites"
            isEmpty={(rows) => rows.length === 0}
            empty={<EmptyHint>No invite has ever been sent to this household.</EmptyHint>}
          >
            {(rows) => (
              <div className="hmembers__groups">
                {INVITE_GROUPS.map((group) => {
                  const inGroup = rows.filter((i) => group.statuses.includes(i.effectiveStatus));
                  if (inGroup.length === 0) return null;
                  return (
                    <section key={group.heading} className="hmembers__group">
                      <h3 className="hmembers__group-title">
                        {group.heading}
                        <span className="hmembers__group-count">{inGroup.length}</span>
                      </h3>
                      <ul className="hmembers__list">
                        {inGroup.map((invite) => (
                          <li key={invite.inviteId} className="hmembers__invite">
                            <div className="hmembers__invite-main">
                              <span className="hmembers__invite-email">{invite.invitedEmail}</span>
                              <span className="hmembers__invite-meta">
                                {inviteMetaLine(invite)}
                              </span>
                              <div className="hmembers__invite-pills">
                                <StatusPill
                                  label={inviteStatusLabel(invite.effectiveStatus)}
                                  tone={inviteStatusTone(invite.effectiveStatus)}
                                />
                                <RolePill role={invite.proposedRole} />
                                {invite.secondaryLabel !== null && (
                                  <StatusPill label={invite.secondaryLabel} tone="neutral" />
                                )}
                              </div>
                            </div>
                            {invite.redeemable && (
                              <GhostButton
                                label={revokingId === invite.inviteId ? 'Revoking…' : 'Revoke'}
                                onClick={() => void revoke(invite)}
                                disabled={revokingId !== null}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </AsyncRegion>
        </DenPanel>
      </div>

      {recoveryOpen && sittingPrimary !== null && (
        <Dialog
          title="Who should the household go to?"
          onClose={() => {
            if (!recovering) setRecoveryOpen(false);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setRecoveryOpen(false)}
                disabled={recovering}
              />
              <PrimaryButton
                label={recovering ? 'Sending…' : 'Send the claim link'}
                onClick={() => void confirmRecovery()}
                disabled={recovering || recoveryChoice === ''}
                busy={recovering}
              />
            </>
          }
        >
          <p>
            {memberLabel(sittingPrimary)} will be suspended and signed out. The member you pick is
            mailed a claim link that expires in {INVITE_TTL_DAYS} days, and holds every entitlement
            on this household once they open it, billing included.
          </p>
          <AsyncRegion
            state={recoveryCandidates}
            what="eligible members"
            isEmpty={(rows) => rows.length === 0}
            empty={
              // Not an input, and not a "try a different address" prompt. When
              // nobody qualifies there is no address that would work, so the
              // only honest thing to show is the step that makes one exist.
              <EmptyHint>
                Nobody else on this household has a verified email address, so there is no one the
                claim link can safely go to. Invite the right person to this household, have them
                verify their email, then start recovery again.
              </EmptyHint>
            }
          >
            {(rows) => (
              <fieldset className="hmembers__fieldset" disabled={recovering}>
                <legend className="hmembers__legend">Send the claim link to</legend>
                <div role="radiogroup" aria-label="Send the claim link to">
                  {rows.map((candidate) => (
                    <label key={candidate.uid} className="hmembers__choice">
                      <input
                        type="radio"
                        name="recoveryCandidate"
                        value={candidate.email}
                        checked={recoveryChoice === candidate.email}
                        onChange={() => {
                          setRecoveryChoice(candidate.email);
                          setRecoveryError(null);
                        }}
                      />
                      <span className="hmembers__choice-text">
                        <span className="hmembers__choice-email">{candidate.email}</span>
                        <span className="hmembers__choice-meta">
                          {candidate.secondaryLabel !== null ? `${candidate.secondaryLabel} · ` : ''}
                          {candidate.role === 'PRIMARY' ? 'Primary' : 'Secondary'} · verified
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </AsyncRegion>
          {recoveryError !== null && (
            <Banner tone="error" title="Nothing was sent, and nothing changed">
              {recoveryError}
            </Banner>
          )}
        </Dialog>
      )}

      {removeTarget !== null && (
        <Dialog
          title="Remove this member?"
          onClose={() => {
            if (!removing) setRemoveTarget(null);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
              />
              <PrimaryButton
                label={removing ? 'Removing…' : 'Remove'}
                onClick={() => void confirmRemove()}
                disabled={removing}
                busy={removing}
              />
            </>
          }
        >
          <p>
            {memberLabel(removeTarget)} will be suspended on {householdName} and signed out of every
            device. This does not delete their record: the row stays in the list marked Suspended,
            and any invite they already accepted stays accepted.
          </p>
          {removeError !== null && (
            <Banner tone="error" title="That did not work">
              {removeError}
            </Banner>
          )}
        </Dialog>
      )}
    </div>
  );
}

/**
 * The one-line invite provenance. Only dates the server actually returned are
 * shown; a missing timestamp is omitted rather than filled with today.
 */
export function inviteMetaLine(invite: HouseholdInvite): string {
  const parts: string[] = [];
  const sent = formatInviteDate(invite.sentToInviteeAt);
  const created = formatInviteDate(invite.createdAt);
  if (sent !== null) parts.push(`Sent ${sent}`);
  else if (created !== null) parts.push(`Created ${created}`);

  if (invite.effectiveStatus === 'REVOKED') {
    const revoked = formatInviteDate(invite.revokedAt);
    if (revoked !== null) parts.push(`revoked ${revoked}`);
  } else {
    const expires = formatInviteDate(invite.expiresAt);
    if (expires !== null) {
      parts.push(invite.effectiveStatus === 'EXPIRED' ? `expired ${expires}` : `expires ${expires}`);
    }
  }
  parts.push(inviteHandle(invite.inviteId));
  return parts.join(' · ');
}
