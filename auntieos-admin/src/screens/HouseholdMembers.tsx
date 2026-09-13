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
  type MemberStatus,
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
import {
  CONTACT_LABEL_MAX,
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  contactMetaLine,
  listHouseholdContacts,
  removeHouseholdContact,
  saveHouseholdContact,
  type HouseholdContact,
} from '../api/householdContacts';
import { linkOptions } from '@tanstack/react-router';
import { type Async } from '../lib/async';
import {
  DenPanel,
  DenScreenHeading,
  EmptyHint,
  ErrorHint,
  StatusPill,
} from '../components/DenScreenKit';
import { AsyncLoading, AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { Banner } from '../components/Banner';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useHistoryBack } from '../lib/useHistoryBack';
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
 * do it for them. The one admin invite, "Invite to portal", mails the primary
 * claim link to the address on the kinfolk record.
 *
 * A CONTACT IS NOT AN INVITE (ruling, 2026-09-12): "a secondary contact does
 * not have to be a portal user. primary kinfolk user will invite a second
 * kinfolk to the household to manage and receive notifications." Two actions,
 * two outcomes, and the hero carries both:
 *
 *   - "Add secondary contact" records a person on the household: a name, what
 *     they are to the household, a phone, an email if there is one. No account,
 *     no invite, no permission set. It is `saveHouseholdContact`, and it is the
 *     mock's own primary action, restored to the slot the mock draws it in.
 *   - "Invite to portal" is still `inviteKinfolkToPortal`: the claim link, and
 *     whoever opens it manages the household and receives its notifications.
 *
 * The #755 Members sweep read the 2026-08-04 ruling as meaning the mock's "Add
 * secondary contact" button SHOULD BE the invite, and replaced it. That took
 * away the only way to record somebody who will never hold an account, which is
 * most of the people a household is actually reached through. The two live side
 * by side now, and neither is the other's label.
 *
 * The admin still mints no SECONDARY invite. A contact is not a member: it has
 * no uid, no role and no `MemberPermissions`, the callable's argument schema is
 * `.strict()` and refuses `permissions`, `invitedEmail` and `role` outright, and
 * the 2026-08-04 wall stands where it stood.
 *
 * "Invite a primary by email" sent the same claim link to an address the
 * operator typed, for a household with the wrong email on file or none
 * (issue #684). The operator rejected that case: the portal invite button
 * already covers it. The form and its `submitInvite` handler are gone;
 * `mintInvite` stays a registered callable with no caller in `src/`, because
 * it is PRIMARY-only per this same ruling and the server side of it is not
 * dead code.
 *
 * WHAT A PRIMARY MAY LOSE: nothing. A primary's entitlements are inherent to
 * the role, because `requirePerm` in memberGate.ts answers for PRIMARY before
 * it reads the flags. Their card therefore carries one "all permissions
 * granted by role" capsule, the mock's own footnote, rather than switches.
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
 * THE SHAPE IS THE MOCK'S (#755). `ui-ideas/auntieos-members-2026-05-27.html`
 * draws a hero band with the household's crest, its name, a mono line with the
 * family id and the member counts, and the actions on the right; then a
 * Primary contact panel and a Secondary contacts panel, each member a block
 * with a 58px circle, the name, a role capsule and a status capsule. The
 * invites half follows `auntieos-invites-2026-05-27.html` the way the
 * admin-wide Invites screen draws it: a tone stripe, a 42px circle, the
 * address, the provenance line, the pills. The mocks' "new admin surface / no
 * UI today" banners are not rendered, because after this change that is no
 * longer true, and their sample emails, family ids and dates are placeholder
 * by their own admission: every value here is bound to a callable response.
 *
 * Two of the members mock's controls are PRIMARY-only on the server and so
 * cannot be offered to an admin: the editable `secondaryLabel` input
 * (`updateMemberLabel` calls `requirePrimary`) and "Swap contact info"
 * (`swapPrimaryContact` edits the CALLER's own client record). The label is
 * shown read-only in the mock's shape; the admin's way to move a household is
 * "Swap primary", which is `executePrimaryRecovery`.
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
  /**
   * Where Back goes on a COLD arrival only (#689): this screen has its own
   * `/household-members/{id}` route, so an operator who walked here has an
   * entry behind them and Back returns to that instead, whatever it was.
   */
  onBack: () => void;
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

/**
 * The mock's crest letter: "W" for "the Wrens". A leading article is skipped
 * so a household named "the Walls" reads W rather than T; an id-only fallback
 * name ("fam1") keeps its first letter, which is honest if not pretty.
 */
export function householdInitial(name: string): string {
  const trimmed = name.trim().replace(/^the\s+/i, '');
  return (trimmed === '' ? name.trim() : trimmed).charAt(0).toUpperCase();
}

/**
 * The mock's `.where` line under the household name: `familyId: fam_7Qk2 · 3
 * members · 1 PRIMARY, 2 SECONDARY`. Counts are by ROLE, which is what the
 * two panels below are split by, and they are only written once the roster
 * has been read: before that the line is the id alone, never "0 members".
 */
export function whereLine(kinfolkId: string, members: Async<HouseholdMember[]>): string {
  const head = `familyId: ${kinfolkId}`;
  if (members.status !== 'ready') return head;
  const rows = members.data;
  const primary = rows.filter((m) => m.role === 'PRIMARY').length;
  const secondary = rows.length - primary;
  const noun = rows.length === 1 ? 'member' : 'members';
  return `${head} · ${rows.length} ${noun} · ${primary} PRIMARY, ${secondary} SECONDARY`;
}

/** "Active" from ACTIVE. The mock's LED text is title case. */
function statusWord(status: MemberStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function roleWord(role: MemberRole): string {
  return role === 'PRIMARY' ? 'Primary' : 'Secondary';
}

export function HouseholdMembers({ kinfolkId, kinfolkName, onBack }: HouseholdMembersProps) {
  const { showToast } = useToast();
  const householdName = (kinfolkName ?? '').trim() === '' ? kinfolkId : (kinfolkName as string);
  // #689. Named after the household rather than "household" so the fallback
  // wording still points at something the operator can picture; the cold-arrival
  // route has no name to use, so it falls back to the id it does have.
  const back = useHistoryBack({ fallbackLabel: householdName, onFallback: onBack });

  const [members, setMembers] = useState<Async<HouseholdMember[]>>({ status: 'loading' });
  const [invites, setInvites] = useState<Async<HouseholdInvite[]>>({ status: 'loading' });
  const [contacts, setContacts] = useState<Async<HouseholdContact[]>>({ status: 'loading' });

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
  // Secondary contacts. The form mounts with the dialog and unmounts with it,
  // like the recovery dialog above: this screen carries no input at rest, which
  // is what the #684 negative asserts and what the operator asked for.
  const [contactOpen, setContactOpen] = useState(false);
  /** The contact being edited, or null while adding a new one. */
  const [contactEditing, setContactEditing] = useState<HouseholdContact | null>(null);
  const [contactForm, setContactForm] = useState({ name: '', label: '', phone: '', email: '' });
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactRemoveTarget, setContactRemoveTarget] = useState<HouseholdContact | null>(null);
  const [contactRemoveError, setContactRemoveError] = useState<string | null>(null);
  const [contactRemoving, setContactRemoving] = useState(false);

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

  const loadContacts = useCallback(() => {
    let live = true;
    setContacts({ status: 'loading' });
    listHouseholdContacts(kinfolkId)
      .then((data) => {
        if (live) setContacts({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) {
          setContacts({
            status: 'error',
            message: `listHouseholdContacts failed: ${errText(err, 'Load failed')}`,
            retry: loadContacts,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => loadMembers(), [loadMembers]);
  useEffect(() => loadInvites(), [loadInvites]);
  useEffect(() => loadContacts(), [loadContacts]);

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

  function startRemove(member: HouseholdMember) {
    setRemoveError(null);
    setRemoveTarget(member);
  }

  /** Opens the contact form: empty to add, filled to edit the one passed. */
  function openContact(contact: HouseholdContact | null) {
    setContactEditing(contact);
    setContactForm({
      name: contact?.name ?? '',
      label: contact?.label ?? '',
      phone: contact?.phone ?? '',
      email: contact?.email ?? '',
    });
    setContactError(null);
    setContactOpen(true);
  }

  /**
   * Saves the contact. A DIFF, not a rebuild: the form holds a control for every
   * field the server stores except `createdAt` / `createdBy` / `updatedAt` /
   * `updatedBy`, which are the server's own and are never sent from here. Every
   * editable field goes in the payload including the emptied ones, so clearing a
   * phone number actually clears it.
   */
  async function saveContact() {
    if (contactSaving) return;
    if (contactForm.name.trim() === '') {
      setContactError('A contact needs a name.');
      return;
    }
    setContactSaving(true);
    setContactError(null);
    try {
      const { created } = await saveHouseholdContact(kinfolkId, {
        ...(contactEditing !== null ? { contactId: contactEditing.contactId } : {}),
        name: contactForm.name,
        label: contactForm.label,
        phone: contactForm.phone,
        email: contactForm.email,
      });
      showToast(
        created
          ? `${contactForm.name.trim()} is a contact on ${householdName}. No portal account was created.`
          : `Saved ${contactForm.name.trim()}.`,
      );
      setContactOpen(false);
      loadContacts();
    } catch (err: unknown) {
      setContactError(
        `saveHouseholdContact failed: ${errText(err, 'The contact was not saved.')}`,
      );
    } finally {
      setContactSaving(false);
    }
  }

  async function confirmRemoveContact() {
    if (contactRemoveTarget === null || contactRemoving) return;
    const target = contactRemoveTarget;
    setContactRemoving(true);
    setContactRemoveError(null);
    try {
      await removeHouseholdContact(kinfolkId, target.contactId);
      showToast(`${target.name} is off ${householdName}.`);
      setContactRemoveTarget(null);
      loadContacts();
    } catch (err: unknown) {
      setContactRemoveError(
        `removeHouseholdContact failed: ${errText(err, 'The contact was not removed.')}`,
      );
    } finally {
      setContactRemoving(false);
    }
  }

  // The mock's `.ct` on the Secondary contacts panel: "2 of role: SECONDARY".
  // Written only from a read roster; a count is a claim.
  const secondaryCount =
    members.status === 'ready' ? members.data.filter((m) => m.role === 'SECONDARY').length : null;
  const inviteCount = invites.status === 'ready' ? invites.data.length : null;
  const contactCount = contacts.status === 'ready' ? contacts.data.length : null;
  /**
   * The mock's `.ct` note, now counting both kinds the panel holds: members of
   * role SECONDARY, and contacts with no account at all. Each half is written
   * only once its own read has landed, so a failing roster cannot make the
   * contacts read as zero or the other way round.
   */
  const secondaryMeta = [
    secondaryCount === null ? null : `${secondaryCount} of role: SECONDARY`,
    contactCount === null
      ? null
      : `${contactCount} ${contactCount === 1 ? 'contact' : 'contacts'}, no portal account`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <div className="screen hmembers">
      <div className="d1">
        <DenScreenHeading
          // Both walkable steps are real ROUTE LINKS: this screen has exactly
          // one mount, its own `/household-members/{id}` route, so `/directory`
          // and the household profile are both somewhere else and both can be
          // middle-clicked, copied and opened in a new tab (#689). The
          // household step used to be `onBack`, which was the same destination
          // by a worse road: a button that only one kind of click reaches.
          crumbs={[
            { label: 'Directory', link: linkOptions({ to: '/directory' }) },
            {
              label: householdName,
              link: linkOptions({ to: '/directory/$kinfolkId', params: { kinfolkId } }),
            },
            { label: 'Members and invites' },
          ]}
          // The mock's hero names the HOUSEHOLD, not the screen: the trail
          // above already says Members. The crest is the mock's 72px tile.
          title={householdName}
          subtitle={`Who can reach ${householdName}, and what each of them may do. Add secondary contact records a person on the household: no portal account, no invite, nothing to sign in to. Invite to portal mails a primary claim link that expires in ${INVITE_TTL_DAYS} days, and whoever opens it manages the household and receives its notifications; a household that already has an active primary is left alone rather than emailed again.`}
          leading={
            <Avatar
              label={householdName}
              initials={householdInitial(householdName)}
              gradientSeed={kinfolkId}
              size={72}
              shape="rounded"
              ring={false}
              className="hmembers__crest"
            />
          }
          trailing={
            <div className="hmembers__actions">
              <GhostButton label={back.label} onClick={back.goBack} />
              {/* The mock's "Swap primary". Present only while there is a
                  primary to swap out: `executePrimaryRecovery` suspends
                  `oldUid`, and with nobody sitting there is nothing to do. */}
              {sittingPrimary !== null && <GhostButton label="Swap primary" onClick={openRecovery} />}
              {/* Two actions, two outcomes (ruling, 2026-09-12). The invite
                  hands somebody the household; the contact records somebody who
                  will never sign in. The mock's primary slot is the contact,
                  and the sweep that gave the slot to the invite lost the other
                  gesture entirely. */}
              <GhostButton
                label={portalBusy ? 'Sending…' : 'Invite to portal'}
                onClick={() => void invitePortal()}
                disabled={portalBusy}
              />
              <PrimaryButton
                label="Add secondary contact"
                onClick={() => openContact(null)}
                disabled={contactSaving}
              />
            </div>
          }
        >
          <p className="hmembers__where">{whereLine(kinfolkId, members)}</p>
        </DenScreenHeading>
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

      <DenPanel
        className="d1"
        title="Primary contact"
        meta="role: PRIMARY"
        subtitle="The household account owner. Held by role, not by setting: full billing, home access, kin edits and messaging come with being the primary, and the server reads the role rather than these flags, so there is nothing here to switch off. Swap primary suspends them and mails a claim link to a verified member you pick."
      >
        <AsyncRegion
          state={members}
          what="members"
          isEmpty={(rows) => !rows.some((m) => m.role === 'PRIMARY')}
          empty={
            members.status === 'ready' && members.data.length === 0 ? (
              <EmptyHint>
                Nobody has claimed this household yet. Invite to portal sends the claim link, and
                this fills in once it is accepted.
              </EmptyHint>
            ) : (
              <EmptyHint>
                There is no active primary to recover. Invite to portal sends the claim link, and
                whoever accepts becomes the primary.
              </EmptyHint>
            )
          }
        >
          {(rows) => (
            <ul className="hmembers__list">
              {rows
                .filter((m) => m.role === 'PRIMARY')
                .map((member) => (
                  <MemberBlock
                    key={member.uid}
                    member={member}
                    savingPerm={savingPerm}
                    onToggle={(key, next) => void togglePermission(member, key, next)}
                    onRemove={() => startRemove(member)}
                  />
                ))}
            </ul>
          )}
        </AsyncRegion>
      </DenPanel>

      <DenPanel
        className="d2"
        title="Secondary contacts"
        meta={secondaryMeta}
        subtitle="Two kinds of people, both reachable for this household. A member was invited to the portal by their primary from MyTribe: they sign in, they carry a label and a permission set you can edit here, and KinTales access is locked on by the server for everyone. A contact holds no portal account at all: a name, a phone, sometimes an email, and nothing to sign in to."
      >
        {members.status === 'loading' && <AsyncLoading what="secondary contacts" />}
        {/* One named failure on the page, in the panel above. This one only
            says it is unknown, so the same message is not read out twice. */}
        {members.status === 'error' && (
          <ErrorHint>Secondary contacts unavailable while the member list is failing.</ErrorHint>
        )}
        {members.status === 'ready' &&
          (members.data.some((m) => m.role === 'SECONDARY') ? (
            <ul className="hmembers__list">
              {members.data
                .filter((m) => m.role === 'SECONDARY')
                .map((member) => (
                  <MemberBlock
                    key={member.uid}
                    member={member}
                    savingPerm={savingPerm}
                    onToggle={(key, next) => void togglePermission(member, key, next)}
                    onRemove={() => startRemove(member)}
                  />
                ))}
            </ul>
          ) : (
            <EmptyHint>
              Nobody on this household has been invited to the portal as a secondary. Their primary
              does that from MyTribe.
            </EmptyHint>
          ))}

        {/* The contacts half of the same panel. Separately loaded and
            separately failed: an unreadable roster must not decide what the
            contact list says, and neither must read as empty on the other's
            behalf. */}
        <div className="hmembers__contacts">
          <div className="hmembers__group-head">
            <h3 className="hmembers__group-title">No portal account</h3>
            {contactCount !== null && (
              <span className="hmembers__group-note">
                {contactCount} {contactCount === 1 ? 'contact' : 'contacts'}
              </span>
            )}
          </div>
          <AsyncRegion
            state={contacts}
            what="contacts"
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyHint>
                No contact has been recorded for this household yet.
              </EmptyHint>
            }
          >
            {(rows) => (
              <ul className="hmembers__list">
                {rows.map((contact) => (
                  <ContactRow
                    key={contact.contactId}
                    contact={contact}
                    onEdit={() => openContact(contact)}
                    onRemove={() => {
                      setContactRemoveError(null);
                      setContactRemoveTarget(contact);
                    }}
                  />
                ))}
              </ul>
            )}
          </AsyncRegion>
          {/* The mock's dashed row under the list. It went with the sweep;
              the 2026-09-12 ruling puts it back. */}
          <button
            type="button"
            className="hmembers__addrow"
            onClick={() => openContact(null)}
            disabled={contactSaving}
          >
            Add secondary contact
          </button>
        </div>
      </DenPanel>

      <DenPanel
        className="d3"
        title="Invites"
        meta={inviteCount === null ? '' : `${inviteCount} total`}
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
                    {/* The note is a sibling of the heading, never inside it,
                        so the section's accessible name stays the one word. */}
                    <div className="hmembers__group-head">
                      <h3 className="hmembers__group-title">{group.heading}</h3>
                      <span className="hmembers__group-note">
                        {group.statuses.join(' / ')} · {inGroup.length}
                      </span>
                    </div>
                    <ul className="hmembers__list">
                      {inGroup.map((invite) => (
                        <InviteRow
                          key={invite.inviteId}
                          invite={invite}
                          revoking={revokingId === invite.inviteId}
                          revokeBusy={revokingId !== null}
                          onRevoke={() => void revoke(invite)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </AsyncRegion>
      </DenPanel>

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
                          {roleWord(candidate.role)} · verified
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

      {contactOpen && (
        <Dialog
          title={contactEditing === null ? 'Add a secondary contact' : 'Edit this contact'}
          onClose={() => {
            if (!contactSaving) setContactOpen(false);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setContactOpen(false)}
                disabled={contactSaving}
              />
              <PrimaryButton
                label={contactSaving ? 'Saving…' : 'Save contact'}
                onClick={() => void saveContact()}
                disabled={contactSaving || contactForm.name.trim() === ''}
                busy={contactSaving}
              />
            </>
          }
        >
          <p>
            Somebody this household can be reached through. Saving this creates no portal account
            and sends nothing: to give a person a sign-in, their primary invites them from MyTribe,
            or use Invite to portal for the primary claim itself.
          </p>
          <fieldset className="hmembers__fieldset" disabled={contactSaving}>
            <legend className="hmembers__legend">Contact details</legend>
            {/* Label, control and hint are SIBLINGS. A <label> that wraps its
                own hint takes the hint into the control's accessible name, so
                the field announces a sentence instead of a field. */}
            <div className="hmembers__field">
              <label className="hmembers__field-label" htmlFor="hmcontact-name">
                Name
              </label>
              <input
                id="hmcontact-name"
                type="text"
                maxLength={CONTACT_NAME_MAX}
                value={contactForm.name}
                onChange={(e) => {
                  setContactForm({ ...contactForm, name: e.target.value });
                  setContactError(null);
                }}
              />
            </div>
            <div className="hmembers__field">
              <label className="hmembers__field-label" htmlFor="hmcontact-label">
                What they are to the household
              </label>
              <input
                id="hmcontact-label"
                type="text"
                maxLength={CONTACT_LABEL_MAX}
                placeholder="Folk"
                aria-describedby="hmcontact-label-hint"
                value={contactForm.label}
                onChange={(e) => setContactForm({ ...contactForm, label: e.target.value })}
              />
              <span id="hmcontact-label-hint" className="hmembers__field-hint">
                Sister, Co-parent, Neighbour. Left empty it reads Folk.
              </span>
            </div>
            <div className="hmembers__field">
              <label className="hmembers__field-label" htmlFor="hmcontact-phone">
                Phone
              </label>
              <input
                id="hmcontact-phone"
                type="tel"
                maxLength={CONTACT_PHONE_MAX}
                value={contactForm.phone}
                onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
              />
            </div>
            <div className="hmembers__field">
              <label className="hmembers__field-label" htmlFor="hmcontact-email">
                Email
              </label>
              <input
                id="hmcontact-email"
                type="email"
                aria-describedby="hmcontact-email-hint"
                value={contactForm.email}
                onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
              />
              <span id="hmcontact-email-hint" className="hmembers__field-hint">
                Optional, and it invites nobody. An address here is somewhere to reach this person.
              </span>
            </div>
          </fieldset>
          {contactError !== null && (
            <Banner tone="error" title="The contact was not saved">
              {contactError}
            </Banner>
          )}
        </Dialog>
      )}

      {contactRemoveTarget !== null && (
        <Dialog
          title="Remove this contact?"
          onClose={() => {
            if (!contactRemoving) setContactRemoveTarget(null);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setContactRemoveTarget(null)}
                disabled={contactRemoving}
              />
              <PrimaryButton
                label={contactRemoving ? 'Removing…' : 'Remove'}
                onClick={() => void confirmRemoveContact()}
                disabled={contactRemoving}
                busy={contactRemoving}
              />
            </>
          }
        >
          <p>
            {contactRemoveTarget.name} is deleted from {householdName}. There is no account to
            suspend and no sign-in to revoke, so unlike removing a member this leaves no row behind.
          </p>
          {contactRemoveError !== null && (
            <Banner tone="error" title="That did not work">
              {contactRemoveError}
            </Banner>
          )}
        </Dialog>
      )}
    </div>
  );
}

/**
 * One contact: the mock's `.member` block without the halves a contact does not
 * have. A 58px circle, the name, a capsule saying there is no portal account,
 * the label and reachable details under it. No uid, no role capsule and no
 * permission list, because a person with nothing to sign in to has no
 * entitlements to draw.
 */
function ContactRow({
  contact,
  onEdit,
  onRemove,
}: {
  contact: HouseholdContact;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="hmembers__member" data-role="contact">
      <div className="hmembers__member-top">
        <Avatar
          label={contact.name}
          initials={contact.name.charAt(0)}
          gradientSeed={contact.contactId}
          size={58}
          className="hmembers__photo"
        />
        <div className="hmembers__member-who">
          <div className="hmembers__member-nameline">
            <span className="hmembers__member-name">{contact.name}</span>
            {/* Muted, not teal: this capsule is the absence of a thing, and it
                must not read as a state a member could also be in. */}
            <StatusPill label="No portal account" tone="muted" size="compact" />
          </div>
          <span className="hmembers__member-contact">{contactMetaLine(contact)}</span>
        </div>
        <div className="hmembers__member-actions">
          <GhostButton label="Edit" onClick={onEdit} />
          <GhostButton label="Remove" onClick={onRemove} className="hmembers__danger" />
        </div>
      </div>
    </li>
  );
}

/**
 * The mock's `.member` block (and its `.primecard`, which is the same identity
 * row without the permission list): a 58px circle, the name in Fraunces, the
 * role capsule and the status capsule beside it, the uid in mono under it, the
 * secondary's label in the mock's `.labelwrap` shape, and the actions on the
 * right. A secondary then gets the permission list under a hairline; a primary
 * gets the mock's footnote capsule, "all permissions granted by role".
 */
function MemberBlock({
  member,
  savingPerm,
  onToggle,
  onRemove,
}: {
  member: HouseholdMember;
  savingPerm: string | null;
  onToggle: (key: PermissionKey, next: boolean) => void;
  onRemove: () => void;
}) {
  const label = memberLabel(member);
  const byRole = permissionsFollowRole(member.role);
  return (
    <li className="hmembers__member" data-role={member.role.toLowerCase()}>
      <div className="hmembers__member-top">
        <Avatar
          label={label}
          initials={label.charAt(0)}
          gradientSeed={member.uid}
          size={58}
          className="hmembers__photo"
        />
        <div className="hmembers__member-who">
          <div className="hmembers__member-nameline">
            <span className="hmembers__member-name">{label}</span>
            <StatusPill
              label={roleWord(member.role)}
              tone={member.role === 'PRIMARY' ? 'purple' : 'teal'}
              size="compact"
            />
            <StatusPill
              label={statusWord(member.status)}
              tone={memberStatusTone(member.status)}
              size="compact"
            />
          </div>
          <span className="hmembers__member-contact">{member.uid}</span>
          {member.role === 'SECONDARY' && member.secondaryLabel !== null && (
            // Read-only. `updateMemberLabel` is PRIMARY-only on the server, so
            // the mock's input would be a control the admin cannot use.
            <span className="hmembers__labelwrap">
              <span className="hmembers__labeled">secondaryLabel</span>
              <span className="hmembers__labelval">{member.secondaryLabel}</span>
            </span>
          )}
        </div>
        <div className="hmembers__member-actions">
          <GhostButton label="Remove" onClick={onRemove} className="hmembers__danger" />
        </div>
      </div>

      {byRole ? (
        <div className="hmembers__cbar">
          <StatusPill label="All permissions granted by role" tone="success" size="compact" />
        </div>
      ) : (
        <div className="hmembers__perms">
          <p className="hmembers__permhdr">permissions</p>
          <ul className="hmembers__permlist">
            {PERMISSION_META.map((perm) => {
              const busy = savingPerm === `${member.uid}:${perm.key}`;
              const locked = perm.serverLocked === true;
              return (
                <li key={perm.key} className="hmembers__perm">
                  <div className="hmembers__perm-text">
                    <span className="hmembers__perm-name">{perm.label}</span>
                    <span className="hmembers__perm-desc">{perm.description}</span>
                  </div>
                  {busy && (
                    <span role="status" className="hmembers__saving">
                      Saving…
                    </span>
                  )}
                  {locked && <StatusPill label="Locked on" tone="teal" size="compact" />}
                  <Toggle
                    checked={member.permissions[perm.key]}
                    label={`${perm.label} for ${label}`}
                    disabled={locked || savingPerm !== null}
                    onChange={(next) => onToggle(perm.key, next)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * The invites mock's `.iv`, as the admin-wide Invites screen draws it: a 4px
 * stripe in the status tone, a 42px circle, the address, the provenance line,
 * then the pills. Revoke sits at the right, and only while the server says
 * the invite is still redeemable: a Revoke on a dead invite is a button that
 * fails when clicked.
 */
function InviteRow({
  invite,
  revoking,
  revokeBusy,
  onRevoke,
}: {
  invite: HouseholdInvite;
  revoking: boolean;
  revokeBusy: boolean;
  onRevoke: () => void;
}) {
  const tone = inviteStatusTone(invite.effectiveStatus);
  return (
    <li className="hmembers__invite">
      <span className="hmembers__invite-accent" data-tone={tone} aria-hidden="true" />
      <Avatar
        label={invite.invitedEmail}
        initials={invite.invitedEmail.charAt(0)}
        gradientSeed={invite.invitedEmail}
        size={42}
        className="hmembers__invite-pic"
      />
      <div className="hmembers__invite-main">
        <span className="hmembers__invite-email">{invite.invitedEmail}</span>
        <span className="hmembers__invite-meta">{inviteMetaLine(invite)}</span>
        <div className="hmembers__invite-pills">
          <StatusPill label={inviteStatusLabel(invite.effectiveStatus)} tone={tone} size="compact" />
          <StatusPill label={roleWord(invite.proposedRole)} tone="purple" size="compact" />
          {invite.secondaryLabel !== null && (
            <StatusPill label={invite.secondaryLabel} tone="neutral" size="compact" />
          )}
        </div>
      </div>
      {invite.redeemable && (
        <GhostButton
          label={revoking ? 'Revoking…' : 'Revoke'}
          onClick={onRevoke}
          disabled={revokeBusy}
          className="hmembers__danger"
        />
      )}
    </li>
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
