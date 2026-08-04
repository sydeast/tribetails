import { logEvent } from '../lib/logger';
import { enrichTemplateData } from './enrichTemplateData';
import type { NotificationDetail } from './types';

/**
 * Resolves the entity detail a notification CARD renders, and stamps it on the
 * notification document so no client ever has to go and find it.
 *
 * THE BUG THIS CLOSES (operator ruling R5, 2026-08-03). Verbatim: "I see the A
 * KinCare visit was assigned and the CTAs for the workflow but I do not see the
 * KinCare/Booking details. Who requested, For which kinfolk, what date, what
 * time, wheres the notes." Every one of those values was already being computed.
 * `enrichTemplateData` resolves the household, the pets, the service, the date
 * and the time from the booking and family documents, at channel fan-out time,
 * to substitute `{{tokens}}` into an outbound email. Then the enriched context
 * was handed to the sender and discarded. The card, which reads the notification
 * document and not the channel subdoc, never saw any of it and fell back to the
 * catalog label plus whatever household name the client could re-derive.
 *
 * So this asks the SAME enricher for the SAME fields and writes the answer down.
 *
 * WHY NOT REUSE THE CHANNEL-TIME RESULT. Two reasons. The card must exist for
 * notifications with no channels at all (a broadcast, or a recipient who has
 * turned every channel off, both of which still land in the inbox), and the
 * enricher must keep running at SEND time for the outbound copy: a scheduled
 * reminder enqueued on Monday and sent on Friday should quote Friday's booking
 * in the email. The card, by contrast, describes the event as it was when it
 * happened. Those are genuinely two resolutions of two different moments, so
 * they are two calls, not one cached value threaded through the pipeline.
 *
 * NEVER THROWS. A detail block is an enrichment of a notification, not a
 * precondition for one. If every entity read fails, the caller gets `undefined`
 * and the notification still dispatches with its catalog title and its CTAs
 * intact, exactly as it did before this existed.
 */

/**
 * The tokens a card wants, over and above whatever the key's own templates
 * reference. Passed to `enrichTemplateData` as `extraFields`, so a key whose
 * email happens to already use one of these pays for no extra read.
 *
 * `amount` / `dueDate` / `invoiceNumber` are in the list even though most
 * booking keys will resolve none of them: the enricher only fetches the entity
 * a wanted token actually needs (the invoice loader never fires without an
 * `invoiceId` in the merge bag), so naming the union here costs nothing and
 * means one code path serves invoice cards and booking cards alike.
 */
export const CARD_DETAIL_FIELDS: readonly string[] = [
  'kinfolkName',
  'kinName',
  'serviceType',
  'bookingDate',
  'bookingTime',
  'notes',
  'invoiceNumber',
  'amount',
  'dueDate',
];

/** A resolved, non-blank string, or undefined. Blank is never a value here. */
function present(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds the card detail for one notification copy.
 *
 * Returns `undefined` rather than an empty object when nothing resolved, so the
 * dispatcher can omit the field entirely: an absent `detail` and a `detail` full
 * of blanks read the same to a human but not to a client, and only one of them
 * lets a renderer say "there is nothing to show here" without inspecting every
 * key.
 *
 * @param key           catalog key, decides which entities are reachable
 * @param recipientUid  the copy's recipient, for recipient-scoped fallbacks
 * @param data          the emitter's merge bag (ids, mostly)
 * @param actorName     the already-resolved actor, threaded in rather than
 *                      re-resolved: `enqueueNotification` resolves the actor
 *                      ONCE for the whole dispatch, and re-reading them per
 *                      recipient here would undo that. `null` for a
 *                      system-emitted notification with no human behind it.
 */
export async function buildNotificationDetail(
  key: string,
  recipientUid: string,
  data: Record<string, unknown>,
  actorName: string | null,
): Promise<NotificationDetail | undefined> {
  let ctx: Record<string, unknown>;
  try {
    ctx = await enrichTemplateData(key, recipientUid, data, CARD_DETAIL_FIELDS);
  } catch (err) {
    // enrichTemplateData documents itself as never-throwing, but it is a large
    // surface over live Firestore reads and this is the one caller that must
    // not take a notification down with it. Log and degrade to the actor alone.
    logEvent({
      severity: 'warn',
      function: 'buildNotificationDetail',
      event: 'detail.enrich.failed',
      extra: { key, err: (err as Error)?.message ?? String(err) },
    });
    ctx = {};
  }

  const detail: NotificationDetail = {};
  const assign = (field: keyof NotificationDetail, value: string | undefined): void => {
    if (value !== undefined) detail[field] = value;
  };

  assign('kinfolkName', present(ctx.kinfolkName));
  assign('kinName', present(ctx.kinName));
  assign('serviceType', present(ctx.serviceType));
  assign('bookingDate', present(ctx.bookingDate));
  assign('bookingTime', present(ctx.bookingTime));
  assign('notes', present(ctx.notes));
  assign('invoiceNumber', present(ctx.invoiceNumber));
  assign('amount', present(ctx.amount));
  assign('dueDate', present(ctx.dueDate));
  // "Who requested" in the operator's words. A system-emitted notification has
  // no actor, and then the card shows no requester rather than "System", which
  // would be a claim about a person nobody made.
  assign('requestedBy', present(actorName));

  return Object.keys(detail).length > 0 ? detail : undefined;
}
