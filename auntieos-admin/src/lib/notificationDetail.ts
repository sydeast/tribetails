import { rec, str } from './coerce';
import { type NotificationEntry } from '../api/notifications';

/**
 * Turns a notification's server-resolved `detail` into the labelled rows a card
 * shows when it is opened.
 *
 * WHAT THIS EXISTS TO FIX (operator ruling R5, 2026-08-03), verbatim: "CTAs on
 * the Notifications have nothing to do with the actual notification nor am I
 * able to open card to view more details. I see the A KinCare visit was
 * assigned and the CTAs for the workflow but I do not see the KinCare/Booking
 * details. Who requested, For which kinfolk, what date, what time, wheres the
 * notes."
 *
 * PURE, AND DELIBERATELY DUMB. It resolves nothing and fetches nothing: every
 * value is already on the document, put there by
 * `mytribe/functions/src/notifications/buildNotificationDetail.ts` at dispatch
 * time. That is not laziness, it is the correctness argument. Resolving a
 * booking in the client would need read access to `families/{id}/bookings/**`,
 * which an admin has and a recipient kinfolk does not, so the admin card and the
 * portal card would show different things about the same notification. One
 * server-side resolution, two identical renderings.
 *
 * ORDER IS THE OPERATOR'S ORDER. Requested by, then household, then kin, then
 * service, then date, then time, then the invoice figures, and notes last
 * because they are the only free-text field and the only one that wraps.
 */

/** One labelled line on an opened card. */
export interface NotificationDetailRow {
  /** Stable key for React, also the `detail` field name. */
  field: string;
  label: string;
  value: string;
  /**
   * True for free-text that may run to several lines, so the renderer can give
   * it a block rather than an inline definition-list cell.
   */
  multiline?: true;
}

/** Field to operator-language label, in render order. */
const DETAIL_LABELS: readonly (readonly [string, string])[] = [
  ['requestedBy', 'Requested by'],
  ['kinfolkName', 'Household'],
  ['kinName', 'Kin'],
  ['serviceType', 'Service'],
  ['bookingDate', 'Date'],
  ['bookingTime', 'Time'],
  ['invoiceNumber', 'Invoice'],
  ['amount', 'Amount'],
  ['dueDate', 'Due'],
  ['notes', 'Notes'],
];

/**
 * The rows to render, absent and blank fields dropped.
 *
 * An empty array means the server resolved nothing for this notification, which
 * a caller must present as "no further details" rather than as an empty box: a
 * card that opens onto nothing is a worse answer than a card that says there is
 * nothing to open.
 */
export function notificationDetailRows(entry: NotificationEntry): NotificationDetailRow[] {
  // Read through `rec` rather than `entry.detail` directly: this interface is a
  // cast over raw Firestore data, so a hand-seeded doc can put a string here and
  // property access on it would silently yield undefined for every field.
  const detail = rec(entry.detail);
  const rows: NotificationDetailRow[] = [];
  for (const [field, label] of DETAIL_LABELS) {
    const value = str(detail[field]).trim();
    if (value === '') continue;
    rows.push(field === 'notes' ? { field, label, value, multiline: true } : { field, label, value });
  }
  return rows;
}

/** True when opening this card would show something. */
export function hasNotificationDetail(entry: NotificationEntry): boolean {
  return notificationDetailRows(entry).length > 0;
}

/**
 * The one-line summary shown on the COLLAPSED row, so an operator triaging a
 * feed can see what a notification is about without opening every card.
 *
 * Kin, then date, then time: the three answers that distinguish one KinCare
 * notification from the next. The household is deliberately NOT in here because
 * the row already prints it as its own context chip, and repeating it would push
 * the distinguishing values off the end of the line.
 *
 * '' when there is nothing worth summarising, and the renderer then shows no
 * summary line at all rather than an empty one.
 */
export function notificationDetailSummary(entry: NotificationEntry): string {
  const detail = rec(entry.detail);
  return ['kinName', 'bookingDate', 'bookingTime']
    .map((f) => str(detail[f]).trim())
    .filter((v) => v !== '')
    .join(' · ');
}
