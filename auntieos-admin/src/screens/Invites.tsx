import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  formatInviteDate,
  inviteHandle,
  inviteStatusLabel,
  inviteStatusTone,
  listAllInvites,
  type AdminInvite,
  type InviteStatus,
  type PillTone,
} from '../api/members';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { DenPanel, DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
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
 * IT IS A READ, AND IT STAYS ONE. Per the invite ruling the admin's only
 * invite is inviting a PRIMARY to the portal, and both callables that do it
 * (`mintInvite`, `inviteKinfolkToPortal`) are household-scoped; the PRIMARY
 * invites the secondary, from MyTribe. An admin-WIDE list has no household to
 * mint into and no member to edit, so it offers no Send, no Revoke, and no
 * permission switches. Every action lives one click away on the household's
 * own Members and invites screen, which is what each card links to. If a
 * future mock shows a "Send invite" button here, the mock is wrong.
 *
 * OUTSTANDING IS THE DEFAULT because it is the question. It means PENDING,
 * EMAIL_SENT and EXPIRED: an expired invite is still somebody who never
 * accepted, and it is the row most likely to need a second send. REVOKED is
 * not outstanding — that one was a decision already taken.
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
  readonly rows: AdminInvite[];
}

/**
 * Sections in a FIXED order, empty ones included, so a section that empties out
 * between renders does not shuffle the ones below it. The order is the order
 * `HouseholdMembers` already stacks these, with Expired promoted above Accepted
 * because on this screen the expired rows are the ones needing a decision.
 */
const SECTION_ORDER: ReadonlyArray<{ heading: string; statuses: readonly InviteStatus[] }> = [
  { heading: 'Pending', statuses: ['PENDING', 'EMAIL_SENT'] },
  { heading: 'Expired', statuses: ['EXPIRED'] },
  { heading: 'Accepted', statuses: ['ACCEPTED'] },
  { heading: 'Revoked', statuses: ['REVOKED'] },
];

export function groupInvitesByStatus(rows: readonly AdminInvite[]): InviteSection[] {
  return SECTION_ORDER.map((s) => ({
    heading: s.heading,
    rows: rows.filter((r) => s.statuses.includes(r.effectiveStatus)),
  }));
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/** A date, or the word for not having one. Never today's date standing in. */
function dateOr(iso: string | null, unknownLabel: string): string {
  return formatInviteDate(iso) ?? unknownLabel;
}

function StatusPill({ status }: { status: InviteStatus }) {
  const tone: PillTone = inviteStatusTone(status);
  return (
    <span className="invites__pill" data-tone={tone}>
      {inviteStatusLabel(status)}
    </span>
  );
}

function InviteCard({ invite }: { invite: AdminInvite }) {
  return (
    <li className="invites__card">
      <div className="invites__card-top">
        {/* The household name IS the link: the whole point of this screen is
            getting from a stray invite back to the household that owns it. */}
        <Link
          to="/household-members/$kinfolkId"
          params={{ kinfolkId: invite.tribeId }}
          className="invites__household"
        >
          {invite.householdName}
        </Link>
        <StatusPill status={invite.effectiveStatus} />
      </div>
      <p className="invites__email">{invite.invitedEmail}</p>
      <p className="invites__meta">
        {/* "unknown", not a dash and not today: the server had no timestamp,
            and a fabricated date here is a date somebody would act on. */}
        <span>Sent {dateOr(invite.sentToInviteeAt ?? invite.createdAt, 'unknown')}</span>
        <span>Expires {dateOr(invite.expiresAt, 'unknown')}</span>
        {/* Truncated on purpose. The full id is the claim token. */}
        <span className="invites__handle">{inviteHandle(invite.inviteId)}</span>
      </p>
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
        kicker="The Den"
        title="Every household's"
        accentTail="invites."
        subtitle="Who was invited, and who never came in. Sending and revoking live on the household's own screen."
      />

      <DenPanel
        title="Invites"
        subtitle="Expired is accurate to the minute here: an invite reads Expired as soon as it lapses."
      >
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
                      <h3 className="invites__section-heading">{section.heading}</h3>
                      <ul className="invites__grid">
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
      </DenPanel>
    </section>
  );
}
