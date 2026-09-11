import { Link } from '@tanstack/react-router';
import { AsyncRegion } from './AsyncRegion';
import { DenPanel, EmptyHint, ServicePill, type DenTone } from './DenScreenKit';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import {
  kinTalesForKinfolkQuery,
  KINTALES_PROFILE_MAX,
  type KinTaleEntry,
} from '../api/kinTales';
import { sessionsForKinfolkQuery, type SessionEntry } from '../api/sessions';
import {
  invoicesForKinfolkQuery,
  invoiceStamp,
  INVOICES_PROFILE_MAX,
  type InvoiceEntry,
  type InvoiceState,
} from '../api/invoices';
import {
  recentTalesFor,
  upcomingVisitsFor,
  invoicesForKinfolk,
  kinfolkInvoiceFeedLabel,
  invoiceRowAmount,
  outstandingTotal,
  feedCountMeta,
  horizonIso,
  coversKin,
  UPCOMING_HORIZON_DAYS,
} from '../lib/kinfolkProfileFeeds';
import { kinTaleHeadline, bodyPreview, kinTaleWhen } from '../lib/kinTaleFormat';
import { sessionClock, sessionDayKey, sessionDayLabel } from '../lib/sessionFormat';
import { formatUsd, localDateIso, invoiceStateInfo, unstampedStateInfo } from '../lib/invoiceFormat';
import './KinfolkProfileFeeds.css';

/**
 * Three of the household profile's right-column cards: Upcoming KinCare,
 * Recent KinTales, Invoices. `KinfolkProfile.tsx` orders them behind its own
 * Kin panel (#678/#682: Kin, Upcoming KinCare, Recent KinTales, Invoices); this
 * module does not fix an order itself, just the three cards.
 *
 * They started as the right-hand column of
 * `ui-ideas/auntieos-kinfolk-profile-2026-05-27.html`, and the React admin had
 * none of them (issue #407). Android has shipped all three for a while, so the
 * joins behind these are a straight port of its `domain/KinfolkProfileFeeds.kt`
 * (see `lib/kinfolkProfileFeeds.ts`) rather than a second interpretation of the
 * same question.
 *
 * Each card owns its own read, the way the Home dashboard's widgets do: one
 * household-scoped, indexed, capped query per card, so a card that fails says so
 * on its own and the rest of the profile still renders.
 *
 * EVERY ROW IS A REAL ANCHOR into the record it names, not a dead card. The mock
 * draws these as clickable tiles and the operator's standing directive on the
 * bookings mock ("cards should open displaying fuller details") is the same
 * instruction; a link also means middle-click, copy and back all work.
 */

/**
 * The narrowing the kin detail screen applies to a household feed: the same
 * household-scoped read, kept to the rows that cover ONE pet (`coversKin`), and
 * headed with the pet's name the way its mock heads them ("Biscuit's KinTales").
 * The read stays household-scoped because that is the indexed query; a pet is a
 * filter over it, never a second index.
 */
export interface KinScope {
  kinId: string;
  kinName: string;
}

/** Recent KinTales sent to this household, newest first, or about one of its pets when [kin] is given. */
export function RecentKinTalesPanel({ kinfolkId, kin }: { kinfolkId: string; kin?: KinScope }) {
  const state = useCollection<KinTaleEntry>(kinTalesForKinfolkQuery(kinfolkId));
  const inScope = (r: KinTaleEntry) => kin === undefined || coversKin(r.kinIds, kin.kinId);
  const loaded =
    state.status === 'ready' ? state.data.filter(isSent).filter(inScope).length : null;
  // Cappedness is a fact about the RAW read, not about the sent subset counted
  // above: 150 sent rows out of a read that came back holding all 200 it was
  // allowed is still a truncated collection. See `feedCountMeta`.
  const capped = state.status === 'ready' && state.data.length >= KINTALES_PROFILE_MAX;
  const rows =
    state.status === 'ready' ? recentTalesFor(state.data.filter(inScope), kinfolkId) : [];
  const who = kin === undefined ? 'this household' : kin.kinName;

  return (
    <DenPanel
      title={kin === undefined ? 'Recent KinTales' : `${kin.kinName}'s KinTales`}
      {...(loaded !== null ? { meta: feedCountMeta(rows.length, loaded, capped) } : {})}
    >
      <AsyncRegion
        state={state}
        what={`${who}'s KinTales`}
        isEmpty={() => rows.length === 0}
        empty={
          <EmptyHint>
            {kin === undefined
              ? 'No KinTales sent to this household yet.'
              : `No KinTales about ${kin.kinName} yet.`}
          </EmptyHint>
        }
      >
        {() => (
          <ul className="kfeed">
            {rows.map((r) => (
              <li key={r._id}>
                <Link to="/kintales" search={{ kinTaleId: r._id }} className="kfeed__row">
                  <span className="kfeed__main">
                    <span className="kfeed__title">
                      {kinTaleHeadline(str(r.title), str(r.bodyCopy))}
                    </span>
                    <span className="kfeed__sub">{bodyPreview(str(r.bodyCopy))}</span>
                    <span className="kfeed__when">
                      Sent · {kinTaleWhen(whenInput(r))}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}

function isSent(r: KinTaleEntry): boolean {
  return str(r.status).toUpperCase() === 'SENT';
}

/** `kinTaleWhen` takes four plain strings; these fields are all optional on the row. */
function whenInput(r: KinTaleEntry): {
  visitDate: string;
  arrivedAt: string;
  sentAt: string;
  createdAt: string;
} {
  return {
    visitDate: str(r.visitDate),
    arrivedAt: str(r.arrivedAt),
    sentAt: str(r.sentAt),
    createdAt: str(r.createdAt),
  };
}

/**
 * This household's next visits, within the mock's own "next 7 days" window.
 *
 * [now] is injectable so a test can pin the window instead of racing the clock.
 */
export function UpcomingVisitsPanel({
  kinfolkId,
  kin,
  now,
}: {
  kinfolkId: string;
  kin?: KinScope;
  now?: Date;
}) {
  const state = useCollection<SessionEntry>(sessionsForKinfolkQuery(kinfolkId));
  const clock = now ?? new Date();
  const nowIso = clock.toISOString();
  const through = horizonIso(clock, UPCOMING_HORIZON_DAYS);
  const today = localDateIso(clock);
  const inScope = (s: SessionEntry) => kin === undefined || coversKin(s.kinIds, kin.kinId);
  const rows =
    state.status === 'ready'
      ? upcomingVisitsFor(state.data.filter(inScope), kinfolkId, nowIso, through)
      : [];
  const who = kin === undefined ? 'this household' : kin.kinName;

  return (
    <DenPanel title="Upcoming KinCare" meta={`next ${UPCOMING_HORIZON_DAYS} days`}>
      <AsyncRegion
        state={state}
        what={`${who}'s visits`}
        isEmpty={() => rows.length === 0}
        empty={
          <EmptyHint>
            {kin === undefined
              ? `No visits booked in the next ${UPCOMING_HORIZON_DAYS} days.`
              : `No visits booked for ${kin.kinName} in the next ${UPCOMING_HORIZON_DAYS} days.`}
          </EmptyHint>
        }
      >
        {() => (
          <ul className="kfeed">
            {rows.map((s) => (
              <li key={s._id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: s._id }}
                  className="kfeed__row kfeed__row--visit"
                >
                  <span className="kfeed__when kfeed__when--lead">
                    {sessionDayLabel(sessionDayKey(str(s.startTime)), today)}{' '}
                    {sessionClock(str(s.startTime))}
                  </span>
                  <ServicePill serviceType={str(s.serviceType)} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}

/** This household's invoices, newest first, headed by what is still owed. */
export function HouseholdInvoicesPanel({ kinfolkId }: { kinfolkId: string }) {
  const state = useCollection<InvoiceEntry>(invoicesForKinfolkQuery(kinfolkId));
  const all = state.status === 'ready' ? state.data : null;
  const rows = all !== null ? invoicesForKinfolk(all, kinfolkId) : [];
  // The mock heads this card "$0 outstanding". It is a real sum over the rows
  // actually read, and it says so at the cap rather than claiming a total the
  // read cannot prove.
  const meta =
    all === null
      ? undefined
      : all.length >= INVOICES_PROFILE_MAX
        ? `${formatUsd(outstandingTotal(all))} outstanding of ${all.length}+ loaded`
        : `${formatUsd(outstandingTotal(all))} outstanding`;

  return (
    <DenPanel title="Invoices" {...(meta !== undefined ? { meta } : {})}>
      <AsyncRegion
        state={state}
        what="this household's invoices"
        isEmpty={() => rows.length === 0}
        empty={<EmptyHint>No invoices for this household yet.</EmptyHint>}
      >
        {() => (
          <ul className="kfeed">
            {rows.map((inv) => {
              // The MOCK shows a two-value Paid/Unpaid pill. This app's invoices
              // have eight stamped states, and collapsing them to two would
              // print "Paid" on a cancelled bill and on a quote nobody has
              // answered. The pill therefore carries the state the server
              // actually stamped, through the same reader the Invoices list
              // uses; an unstamped legacy doc reads as what it says rather than
              // being re-classified here (ADR-0002).
              const stamp = invoiceStamp(inv);
              const info = stamp.state === null ? unstampedStateInfo(inv.status) : invoiceStateInfo(stamp.state);
              return (
                <li key={inv._id}>
                  <Link
                    to="/invoices"
                    search={{ invoiceId: inv._id }}
                    className="kfeed__row kfeed__row--invoice"
                  >
                    <span className="kfeed__no">{kinfolkInvoiceFeedLabel(inv)}</span>
                    <span className="kfeed__money">
                      {formatUsd(invoiceRowAmount(inv))}
                      <span className="den-pill" data-tone={invoicePillTone(stamp.state)}>
                        {info.label}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}
/** The Den tone for one stamped invoice state. An unstamped doc gets the quiet tone. */
function invoicePillTone(state: InvoiceState | null): DenTone {
  switch (state) {
    case 'open':
      return 'orange';
    case 'paid':
    case 'zero':
      return 'teal';
    case 'credit':
    case 'redeemed':
      return 'purple';
    case 'cancelled':
      return 'muted';
    case 'quote':
    case 'draft':
      return 'neutral';
    default:
      return 'muted';
  }
}
