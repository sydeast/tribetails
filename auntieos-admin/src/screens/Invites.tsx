import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  formatInviteDate,
  inviteHandle,
  inviteStatusLabel,
  listAllInvites,
  type AdminInvite,
  type InviteStatus,
} from '../api/members';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { DenScreenHeading, EmptyHint, StatusPill, type DenTone } from '../components/DenScreenKit';
import './Invites.css';

/**
 * Invites, across every household. (Wave 1, item 3)
 *
 * WHAT WAS MISSING. Invites lived three levels down and only ever one
 * household at a time: `HouseholdMembers` is reached from a household profile
 * and `listInvites` takes a `familyId`. So the operator's real question, "who
 * did we invite who never came in", could only be answered by opening all
 * thirteen households by hand and comparing four lists each. This screen is
 * that question, answered in one read (`listAllInvites`).
 *
 * IT IS A READ, AND IT STAYS ONE. Per the invite ruling (CLAUDE.md, "WHO
 * INVITES WHOM", 2026-08-04) the admin's only invite is inviting a PRIMARY to
 * the portal, and both callables that do it (`mintInvite`,
 * `inviteKinfolkToPortal`) are household-scoped; the PRIMARY invites the
 * secondary, from MyTribe. An admin-WIDE list has no household to mint into
 * and no member to edit, so it offers no Send, no Revoke, and no permission
 * switches. Every action lives one click away on the household's own Members
 * and invites screen, which is what each card links to. The mock
 * (`ui-ideas/auntieos-invites-2026-05-27.html`) predates the ruling and is
 * amended to match it: its form column, Revoke buttons and permission toggles
 * are gone.
 *
 * THE SHAPE IS THE MOCK'S (#755). Sections sit on the ground, each a serif
 * heading with a mono status note, and every invite is one row: a tone accent
 * stripe, a framed circle, the address in bold, a dim provenance line, then
 * the pills. There is no panel around the sections because the mock draws
 * none.
 *
 * OUTSTANDING IS THE DEFAULT because it is the question. It means PENDING,
 * EMAIL_SENT and EXPIRED: an expired invite is still somebody who never
 * accepted, and it is the row most likely to need a second send. REVOKED is
 * not outstanding: that one was a decision already taken.
 *
 * `effectiveStatus`, NEVER `status`, decides which chip and which section a
 * row lands in. `expireStaleInvites` sweeps at 02:00 America/New_York, so a
 * lapsed invite still READS as EMAIL_SENT in Firestore for up to a day; the
 * server reconciles that at read time and this screen obeys it. Filing a dead
 * invite under Pending would send the operator chasing something that is over.
 *
 * THE INVITE ID IS A BEARER TOKEN. The claim link is `?invite=<inviteId>`, so
 * the document id doubles as the secret. Cards show `inviteHandle`'s truncated
 * form, for matching a row against the activity log, and never the full id or
 * anything resembling a claim URL.
 *
 * FAIL LOUD. A failed read renders `AsyncRegion`'s error, never an empty
 * shelf: "nobody has been invited" and "we could not find out" are different
 * facts and only one of them is good news.
 */

export type InviteFilterKey = 'outstanding' | 'accepted' | 'revoked' | 'all';

interface InviteFilter {
  readonly key: InviteFilterKey;
  readonly label: string;
  readonly statuses: readonly InviteStatus[] | 'all';
}

/** Order is the order rendered. Outstanding is first because it is the default. */
export const INVITE_FILTERS: readonly InviteFilter[] = [
  { key: 'outstanding', label: 'Outstanding', statuses: ['PENDING', 'EMAIL_SENT', 'EXPIRED'] },
  { key: 'accepted', label: 'Accepted', statuses: ['ACCEPTED'] },
  { key: 'revoked', label: 'Revoked', statuses: ['REVOKED'] },
  { key: 'all', label: 'All', statuses: 'all' },
];

/** Rows matching one filter, in the order the server sent them (newest first). */
export function filterInvites(
  rows: readonly AdminInvite[],
  key: InviteFilterKey,
): AdminInvite[] {
  const filter = INVITE_FILTERS.find((f) => f.key === key);
  if (filter === undefined || filter.statuses === 'all') return [...rows];
  const wanted = filter.statuses;
  return rows.filter((r) => wanted.includes(r.effectiveStatus));
}

export interface InviteSection {
  readonly heading: string;
  /** The mock's `.ct`: the raw status codes the section collects, joined with a slash. */
  readonly statusNote: string;
  readonly rows: AdminInvite[];
}

/**
 * Sections in a FIXED order, empty ones included, so a section that empties out
 * between renders does not shuffle the ones below it. The order is the mock's
 * (Pending, Accepted, Expired, Revoked), which is also the order
 * `HouseholdMembers` stacks the same four. An earlier version promoted Expired
 * above Accepted; the mock is the authority for order and it does not.
 */
const SECTION_ORDER: ReadonlyArray<{ heading: string; statuses: readonly InviteStatus[] }> = [
  { heading: 'Pending', statuses: ['PENDING', 'EMAIL_SENT'] },
  { heading: 'Accepted', statuses: ['ACCEPTED'] },
  { heading: 'Expired', statuses: ['EXPIRED'] },
  { heading: 'Revoked', statuses: ['REVOKED'] },
];

export function groupInvitesByStatus(rows: readonly AdminInvite[]): InviteSection[] {
  return SECTION_ORDER.map((s) => ({
    heading: s.heading,
    statusNote: `status: ${s.statuses.join(' / ')}`,
    rows: rows.filter((r) => s.statuses.includes(r.effectiveStatus)),
  }));
}

/**
 * The mock's own pill tints, one per status: pending and email sent in orange,
 * accepted in teal, revoked in coral, expired in the muted grey. Local to this
 * screen rather than the shared `inviteStatusTone`, which paints the
 * household's Members screen and is that screen's to change.
 */
export function invitePillTone(status: InviteStatus): DenTone {
  if (status === 'ACCEPTED') return 'teal';
  if (status === 'REVOKED') return 'error';
  if (status === 'EXPIRED') return 'muted';
  return 'orange';
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/** A date, or the word for not having one. Never today's date standing in. */
function dateOr(iso: string | null, unknownLabel: string): string {
  return formatInviteDate(iso) ?? unknownLabel;
}

/**
 * The provenance line's date words, in the mock's casing: "Sent" (or
 * "Created" when the mail never went), then the one date that matters for the
 * row's state. Accepted carries no second date because the server returns no
 * acceptance timestamp, and a date this line does not have is a date it does
 * not show.
 */
export function inviteDateParts(invite: AdminInvite): string[] {
  const parts: string[] = [];
  if (invite.sentToInviteeAt !== null) {
    parts.push(`Sent ${dateOr(invite.sentToInviteeAt, 'unknown')}`);
  } else {
    parts.push(`Created ${dateOr(invite.createdAt, 'unknown')}`);
  }
  const status = invite.effectiveStatus;
  if (status === 'REVOKED') {
    parts.push(`revoked ${dateOr(invite.revokedAt, 'unknown')}`);
  } else if (status === 'EXPIRED') {
    parts.push(`expired ${dateOr(invite.expiresAt, 'unknown')}`);
  } else if (status !== 'ACCEPTED') {
    // "unknown", not a dash and not today: the server had no timestamp, and a
    // fabricated date here is a date somebody would act on.
    parts.push(`expires ${dateOr(invite.expiresAt, 'unknown')}`);
  }
  return parts;
}

/** The mock's `.pill.role`: the proposed role, in purple. */
function roleLabel(role: AdminInvite['proposedRole']): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

function InviteCard({ invite }: { invite: AdminInvite }) {
  const tone = invitePillTone(invite.effectiveStatus);
  const label = invite.secondaryLabel?.trim() ?? '';
  return (
    <li className="invites__card">
      {/* The mock's `.accent`: a 4px stripe in the status tone down the left edge. */}
      <span className="invites__accent" data-tone={tone} aria-hidden="true" />
      {/* The mock draws a profile photo here. An invite is an address with no
          account yet, so there is no photo to draw; the Den avatar's own
          fallback, a letter on the seeded gradient, stands in. Never emoji. */}
      <Avatar
        label={`Invite for ${invite.invitedEmail}`}
        initials={invite.invitedEmail.charAt(0)}
        gradientSeed={invite.invitedEmail}
        size={42}
        className="invites__pic"
      />
      <div className="invites__info">
        <p className="invites__email">{invite.invitedEmail}</p>
        <p className="invites__meta">
          {/* The household leads the line and IS the link: the whole point of
              this screen is getting from a stray invite back to the household
              that owns it. The mock is one household deep and has no such
              line; this is the admin-wide screen's one addition. */}
          <Link
            to="/household-members/$kinfolkId"
            params={{ kinfolkId: invite.tribeId }}
            className="invites__household"
          >
            {invite.householdName}
          </Link>
          {inviteDateParts(invite).map((part) => (
            <span key={part}>{part}</span>
          ))}
          {/* Truncated on purpose. The full id is the claim token. */}
          <span className="invites__handle">inviteId {inviteHandle(invite.inviteId)}</span>
        </p>
        <div className="invites__pills">
          <StatusPill label={inviteStatusLabel(invite.effectiveStatus)} tone={tone} />
          <StatusPill label={roleLabel(invite.proposedRole)} tone="purple" />
          {label !== '' && <StatusPill label={label} tone="neutral" />}
        </div>
      </div>
    </li>
  );
}

export function Invites() {
  const [invites, setInvites] = useState<Async<AdminInvite[]>>({ status: 'loading' });
  const [filter, setFilter] = useState<InviteFilterKey>('outstanding');

  const load = useCallback(() => {
    let live = true;
    setInvites({ status: 'loading' });
    listAllInvites()
      .then((data) => {
        if (live) setInvites({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) {
          setInvites({
            status: 'error',
            message: `listAllInvites failed: ${errText(err, 'Load failed')}`,
            retry: load,
          });
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const rows = invites.status === 'ready' ? invites.data : [];
  // Counts come from the loaded rows only. A chip carrying a number while the
  // read is failing would be the `?? 0` bug in another costume.
  const counts = useMemo(
    () =>
      new Map<InviteFilterKey, number>(
        INVITE_FILTERS.map((f) => [f.key, filterInvites(rows, f.key).length]),
      ),
    [rows],
  );

  return (
    <section className="invites">
      <DenScreenHeading
        kicker="The Den · Invites"
        title="Invites"
        subtitle="Every invite across every household, and who never came in. Expired reads Expired the minute it lapses. Sending and revoking live on the household's own Members screen."
      />

      {invites.status === 'ready' && (
        <div className="invites__filters" role="group" aria-label="Filter invites by status">
          {INVITE_FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                className="invites__chip"
                data-active={active}
                aria-pressed={active}
                onClick={() => setFilter(f.key)}
              >
                {/* The count is part of the accessible name, deliberately: a
                    screen reader user hearing "Outstanding" while a sighted
                    one reads "Outstanding 2" is two different screens. */}
                {f.label} {counts.get(f.key) ?? 0}
              </button>
            );
          })}
        </div>
      )}

      <AsyncRegion
        state={invites}
        what="invites"
        isEmpty={(data) => data.length === 0}
        empty={<EmptyHint>No invites have been sent from any household yet.</EmptyHint>}
      >
        {(data) => {
          const shown = filterInvites(data, filter);
          if (shown.length === 0) {
            return (
              <EmptyHint>
                No invites match this filter. Every invite is still here under All.
              </EmptyHint>
            );
          }
          return (
            <div className="invites__sections">
              {groupInvitesByStatus(shown)
                // Empty sections are dropped from the RENDER but not from the
                // model: `groupInvitesByStatus` always returns all four, so
                // the order never depends on what happens to be populated.
                .filter((s) => s.rows.length > 0)
                .map((section) => (
                  <section key={section.heading} className="invites__section">
                    {/* The count sits BESIDE the heading, not inside it, so
                        the section's accessible name stays the one word. */}
                    <div className="invites__section-head">
                      <h2 className="invites__section-heading">{section.heading}</h2>
                      <span className="invites__section-note">
                        {section.statusNote} · {section.rows.length}
                      </span>
                    </div>
                    <ul className="invites__list">
                      {section.rows.map((invite) => (
                        <InviteCard key={invite.inviteId} invite={invite} />
                      ))}
                    </ul>
                  </section>
                ))}
            </div>
          );
        }}
      </AsyncRegion>
    </section>
  );
}
