import { useMemo } from 'react';
import { useCollection } from '../../lib/firestore';
import { localDateIso } from '../../lib/invoiceFormat';
import { SESSIONS_QUERY, type SessionEntry } from '../../api/sessions';
import { KIN_QUERY, type Kin } from '../../api/directory';
import { INVOICES_QUERY, type InvoiceEntry } from '../../api/invoices';
import { GENERATED_DRAFTS_QUERY, type GeneratedDraftRow } from '../../api/drafts';
import type { Async } from '../../lib/async';

/**
 * The four streams Home's widgets share, and the one date they all agree on.
 *
 * WHY THIS EXISTS, and it is a network-cost decision rather than a tidiness
 * one. Eleven of the nineteen cards read visits, three read the pet roster,
 * two read invoices and two read drafts. Each hook here hands back the SAME
 * `CollectionSpec` object every caller uses, which matters because
 * `useCollection` keys its subscription on the spec's JSON and the Firestore
 * SDK keys its Watch target on the query: N widgets listening to one identical
 * spec cost ONE target on the one WebChannel, not N. A widget that quietly
 * varied the cap or the order would break that and open a second stream of the
 * same collection for one card.
 *
 * It also keeps the truncation caveats in one place. Every spec below is
 * bounded (AO-29), so each is a PAGE of a collection rather than the whole of
 * it, and each widget's own docs say what its numbers therefore describe.
 *
 * These are streams, not fetches: they arrive with the initial snapshot and
 * then update in place, so a visit completed on the phone moves the counts here
 * without a reload and without another request.
 */

/**
 * Today, as the operator's LOCAL calendar day. The AO-18 fix: a UTC date flips
 * the dashboard's idea of "today" hours early for anyone west of Greenwich, and
 * every widget on this board would flip with it.
 *
 * Computed once per mount on purpose. A value recreated each render churns
 * every memo downstream, and a dashboard that silently re-derives "today" mid
 * session is a different bug from one that is stale until the next visit.
 */
export function useTodayIso(): string {
  return useMemo(() => localDateIso(new Date()), []);
}

/**
 * The bounded visit stream: `kin_care_sessions`, newest 300 by `startTime`.
 *
 * THE 300-ROW CAP IS LOAD-BEARING for the widgets that count history. Frequent
 * flyers looks back 90 days and Gatekeeper looks back indefinitely, so on a
 * very large book either could be measuring the page rather than the period.
 * Both say so on the card rather than presenting a truncated count as a fact.
 */
export function useSessionsStream(): Async<SessionEntry[]> {
  return useCollection<SessionEntry>(SESSIONS_QUERY);
}

/**
 * The bounded pet roster: `kin`, 500 by document id.
 *
 * Ordered by document id rather than by a data field for the reason
 * `api/directory.ts#KIN_QUERY` spells out at length: Firestore's `orderBy`
 * silently drops every doc missing the sort field, and no `kin` writer sets any
 * one field on every document. Sorting by id is what makes the roster complete.
 */
export function useKinStream(): Async<Kin[]> {
  return useCollection<Kin>(KIN_QUERY);
}

/** The bounded invoice stream, newest 200 by `createdAt`. */
export function useInvoicesStream(): Async<InvoiceEntry[]> {
  return useCollection<InvoiceEntry>(INVOICES_QUERY);
}

/** The bounded generated-draft stream, newest 50 by `createdOn`. */
export function useDraftsStream(): Async<GeneratedDraftRow[]> {
  return useCollection<GeneratedDraftRow>(GENERATED_DRAFTS_QUERY);
}
