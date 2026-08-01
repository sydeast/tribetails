import { useCallback, useEffect, useState } from 'react';
import {
  PERMISSION_META,
  formatInviteDate,
  inviteHandle,
  inviteStatusLabel,
  inviteStatusTone,
  listHouseholdInvites,
  listHouseholdMembers,
  memberLabel,
  memberStatusTone,
  type HouseholdInvite,
  type HouseholdMember,
  type InviteStatus,
  type MemberRole,
  type PermissionKey,
} from '../api/members';
import {
  DEFAULT_INVITE_PERMISSIONS,
  INVITE_TTL_DAYS,
  SECONDARY_LABEL_MAX,
  describePortalInviteOutcome,
  inviteKinfolkToPortal,
  mintInvite,
  removeMember,
  revokeInvite,
  setMemberPermissions,
} from '../api/membersWrite';
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
 * The first surface for `mintInvite`, `revokeInvite`, `setMemberPermissions`,
 * `removeMember` and `inviteKinfolkToPortal`, all of which have been registered
 * callables with no caller anywhere in `src/`. Without this screen a second
 * co-parent cannot be added and a household cannot be let into the portal at
 * all, which is why it blocks onboarding.
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
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [portalNotice, setPortalNotice] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HouseholdMember | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Invite form.
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<MemberRole>('SECONDARY');
  const [invitePerms, setInvitePerms] = useState({ ...DEFAULT_INVITE_PERMISSIONS });

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

  async function submitInvite() {
    if (minting) return;
    setMinting(true);
    setInviteError(null);
    try {
      const { inviteId } = await mintInvite({
        familyId: kinfolkId,
        invitedEmail: email,
        secondaryLabel: label,
        proposedRole: role,
        proposedPermissions: invitePerms,
      });
      showToast(`Invite sent to ${email.trim()} (${inviteHandle(inviteId)}).`);
      setEmail('');
      setLabel('');
      setInvitePerms({ ...DEFAULT_INVITE_PERMISSIONS });
      loadInvites();
    } catch (err: unknown) {
      setInviteError(`mintInvite failed: ${errText(err, 'The invite was not sent.')}`);
    } finally {
      setMinting(false);
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

  const emailReady = email.trim() !== '' && email.includes('@');
  const labelTooLong = label.trim().length > SECONDARY_LABEL_MAX;

  return (
    <div className="screen">
      <div className="d1">
        <DenScreenHeading
          kicker="The Den · Directory"
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
      {inviteError !== null && (
        <Banner tone="error" title="The invite was not sent" onDismiss={() => setInviteError(null)}>
          {inviteError}
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
          subtitle="Everyone with a MyTribe account on this household. KinTales access is locked on by the server and cannot be turned off here or anywhere."
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

                    <ul className="hmembers__perms">
                      {PERMISSION_META.map((perm) => {
                        const busy = savingPerm === `${member.uid}:${perm.key}`;
                        const locked = perm.serverLocked === true;
                        return (
                          <li key={perm.key} className="hmembers__perm">
                            <div className="hmembers__perm-text">
                              <span className="hmembers__perm-name">
                                {perm.label}
                                {perm.adminOnly === true && (
                                  <span className="hmembers__perm-flag">admin only</span>
                                )}
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
                  </li>
                ))}
              </ul>
            )}
          </AsyncRegion>
        </DenPanel>
      </div>

      <div className="d2">
        <DenPanel
          title="Send an invite"
          subtitle={`Emails a claim link to one person and adds them to this household when they accept. The link expires in ${INVITE_TTL_DAYS} days.`}
        >
          <form
            className="hmembers__form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitInvite();
            }}
          >
            <fieldset className="hmembers__fieldset" disabled={minting}>
              <legend className="hmembers__legend">Invite details</legend>

              <div className="hmembers__field">
                <label htmlFor="hmembers-email">Email address</label>
                <input
                  id="hmembers-email"
                  type="email"
                  value={email}
                  autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)}
                />
                <span className="hmembers__hint">
                  Lowercased and matched against the accepting account. Someone signing in with a
                  different address cannot use this link.
                </span>
              </div>

              <div className="hmembers__field">
                <label htmlFor="hmembers-label">Label</label>
                <input
                  id="hmembers-label"
                  type="text"
                  value={label}
                  maxLength={SECONDARY_LABEL_MAX}
                  placeholder="Folk"
                  onChange={(e) => setLabel(e.target.value)}
                  aria-invalid={labelTooLong}
                />
                <span className="hmembers__hint">
                  {label.trim().length} / {SECONDARY_LABEL_MAX}. Optional, and the server strips
                  brackets and dashes, so the saved label can differ from what you type.
                </span>
              </div>

              <div className="hmembers__field">
                <span className="hmembers__field-label" id="hmembers-role-label">
                  Role
                </span>
                <div
                  className="hmembers__segmented"
                  role="radiogroup"
                  aria-labelledby="hmembers-role-label"
                >
                  {(['SECONDARY', 'PRIMARY'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={role === r}
                      data-selected={role === r}
                      className="hmembers__segment"
                      onClick={() => setRole(r)}
                    >
                      {r === 'SECONDARY' ? 'Secondary' : 'Primary'}
                    </button>
                  ))}
                </div>
                <span className="hmembers__hint">
                  Secondary is a co-parent on an existing household. Primary claims the household
                  account itself.
                </span>
              </div>

              <div className="hmembers__field">
                <span className="hmembers__field-label">Starting permissions</span>
                <ul className="hmembers__perms hmembers__perms--form">
                  {PERMISSION_META.map((perm) => {
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
                        <Toggle
                          checked={locked ? true : invitePerms[perm.key]}
                          label={`${perm.label} on this invite`}
                          disabled={locked}
                          onChange={(next) =>
                            setInvitePerms((prev) => ({ ...prev, [perm.key]: next }))
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>

              <PrimaryButton
                label={minting ? 'Sending…' : 'Send invite'}
                onClick={() => void submitInvite()}
                disabled={minting || !emailReady || labelTooLong}
                busy={minting}
              />
            </fieldset>
          </form>
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
                                {invite.requiresAuntieAck && (
                                  <StatusPill label="Auntie ack required" tone="warning" />
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
