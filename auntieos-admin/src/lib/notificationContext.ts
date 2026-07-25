import { rec, str } from './coerce';
import { type NotificationEntry } from '../api/notifications';

/**
 * The CONTEXT half of a notification row: which household it concerns and what
 * entity it points at.
 *
 * Operator issue #20 was that the feed read like an audit log, bare event lines
 * with no household, no date sense, and nothing to click. The date was already
 * there; the household was not, and the reason is worth writing down, because
 * it constrains what this module is allowed to claim.
 *
 * WHAT THE DOC ACTUALLY CARRIES. `dispatcher.ts` (routeByDeliveryMode) writes:
 * `key`, `category`, `recipientUid`, `actorUid`, `title` (catalog label),
 * `description` (catalog description), `actorName`, `actorPhotoUrl`, `data`,
 * `channels`, `targetType`, `targetId`, `createdAt`, `status`, `mode`. There is
 * NO `kinfolkId` and NO `kinfolkName` column. The household lives in one of two
 * places, and only sometimes:
 *
 *   1. inside `data`, the free-form merge bag the emitter passed to
 *      `enqueueNotification`. `enrichTemplateData.ts` says outright that "most
 *      emitters call enqueueNotification with only IDs (kinfolkId/invoiceId/
 *      bookingId)", so `data.kinfolkId` is common and `data.kinfolkName` is not.
 *      The name-filling enrichment runs on the CHANNEL doc
 *      (`onNotificationChannelCreate.ts`), never back onto the notification, so
 *      a resolved `kinfolkName` on the feed row is the exception, not the rule.
 *   2. as `targetId`, when `resolveTargetRef` fell through to the kinfolk
 *      catch-all and set `targetType: 'kinfolk'`.
 *
 * So the id is DERIVED here, and the display name is resolved by the screen
 * against the `kinfolk` collection it already streams. Nothing is fabricated:
 * an unresolvable household renders no name rather than a placeholder.
 */

/** The four target types `resolveTargetRef` can write (plus '' for none). */
export const NOTIFICATION_TARGET_TYPES = ['booking', 'invoice', 'kintale', 'kinfolk'] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

/**
 * Normalize a raw `targetType` to one of the four known types, or null.
 *
 * Trims and lowercases (the archive's `NotificationActions.kt` does the same),
 * and takes `unknown` rather than `string` because `NotificationEntry` is a cast
 * over raw Firestore data, so a hand-seeded doc can put a number here.
 */
export function normalizedTargetType(raw: unknown): NotificationTargetType | null {
  const value = str(raw).trim().toLowerCase();
  return (NOTIFICATION_TARGET_TYPES as readonly string[]).includes(value)
    ? (value as NotificationTargetType)
    : null;
}

/**
 * The household this notification concerns, or '' when none can be identified.
 * Order matches `dispatcher.resolveTargetRef`'s own precedence: the explicit
 * `data` ids first, then the kinfolk-typed target.
 */
export function notificationKinfolkId(entry: NotificationEntry): string {
  const data = rec(entry.data);
  const fromData = str(data['kinfolkId']).trim() || str(data['familyId']).trim();
  if (fromData !== '') return fromData;
  if (normalizedTargetType(entry.targetType) === 'kinfolk') return str(entry.targetId).trim();
  return '';
}

/**
 * The household's display name. Prefers a name the emitter already put on the
 * doc, then the id resolved against `namesById` (the screen builds that from the
 * `kinfolk` stream it already holds). Returns '' when neither is available, so
 * the caller renders nothing rather than "Unknown household".
 */
export function notificationKinfolkName(
  entry: NotificationEntry,
  namesById: ReadonlyMap<string, string>,
): string {
  const fromData = str(rec(entry.data)['kinfolkName']).trim();
  if (fromData !== '') return fromData;
  const id = notificationKinfolkId(entry);
  return id === '' ? '' : (namesById.get(id) ?? '');
}

/** Operator-language name for the linked entity, or '' when there is no target. */
export function notificationTargetLabel(entry: NotificationEntry): string {
  if (str(entry.targetId).trim() === '') return '';
  switch (normalizedTargetType(entry.targetType)) {
    case 'invoice':
      return 'Invoice';
    case 'kintale':
      return 'KinTale';
    case 'kinfolk':
      return 'Household';
    case 'booking':
      return 'Booking';
    default:
      return '';
  }
}
