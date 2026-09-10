import type {
  AdminNotificationPrefs,
  NotificationCatalogEntry,
  NotificationChannel,
  NotificationMatrix,
  NotifStream,
} from '../api/myNotifications';
import {
  adminChannelForced,
  adminGateEnabledChannels,
  userChannelChoice,
} from './myNotificationsFormat';

/**
 * Pure draft-editing helpers for the My Notifications EDITOR
 * (`screens/MyNotificationsEdit.tsx`). `myNotificationsFormat.ts` stays
 * read-only (it backs both the read screen and this one); the write-side
 * logic lives here so neither file has to know about the other's concern.
 *
 * One rule drives `setUserChannelChoice`: a toggle the operator clicks is
 * always a per-notification choice (`byKey`), never a category-wide one.
 * The screen renders one row per (notification, channel), never a
 * category-level control, so there is no UI gesture that should write
 * `byCategory` here; that field stays whatever the operator already had
 * saved there (untouched, not cleared) and keeps applying to any OTHER key
 * in the same category that has no more-specific `byKey` entry, exactly as
 * `userChannelChoice`'s byKey-then-byCategory-then-default precedence
 * already documents.
 */

/** Immutably sets the operator's own `byKey[key][channel]` choice; nothing else moves. */
export function setUserChannelChoice(
  prefs: AdminNotificationPrefs,
  key: string,
  channel: NotificationChannel,
  value: boolean,
): AdminNotificationPrefs {
  return {
    ...prefs,
    byKey: {
      ...prefs.byKey,
      [key]: { ...prefs.byKey[key], [channel]: value },
    },
  };
}

/**
 * Select-all for one section: flips every EDITABLE channel of every visible
 * notification in `entries` to `on`, in a single new prefs object. "Editable"
 * is exactly the set the row-level toggles let the operator change: a channel
 * the business gate currently OFFERS on this stream
 * (`adminGateEnabledChannels`) that is NOT forced on
 * (`adminChannelForced` = catalog-required or business-locked). Forced channels
 * are pinned on by the gate and their `Toggle` is `disabled`, so a bulk flip
 * must skip them too, never writing a `byKey` entry that the gate would just
 * override, and never pretending to turn a required channel off.
 *
 * Writes only `byKey` (per-notification), the same field a single-row toggle
 * writes via `setUserChannelChoice`; `byCategory` and `marketingOptIn` are left
 * exactly as they were. The result feeds the normal draft/Save flow, so the
 * whole section commits in ONE `saveMyAdminNotificationPrefs` write, not one
 * per channel.
 */
export function applyBulkToggle(
  prefs: AdminNotificationPrefs,
  matrix: NotificationMatrix,
  entries: readonly NotificationCatalogEntry[],
  stream: NotifStream,
  on: boolean,
): AdminNotificationPrefs {
  let next = prefs;
  for (const entry of entries) {
    for (const channel of adminGateEnabledChannels(matrix, entry, stream)) {
      if (adminChannelForced(matrix, entry, stream, channel)) continue;
      next = setUserChannelChoice(next, entry.key, channel, on);
    }
  }
  return next;
}

/** One stream's visible rows, paired with the stream that scopes their gate lookup. */
export interface BulkToggleScope {
  entries: readonly NotificationCatalogEntry[];
  stream: NotifStream;
}

/**
 * Select-all for the WHOLE PAGE (#390): flips every editable channel of every
 * visible notification across every hat (business + staff) into a single new
 * prefs object. "Editable" is per-stream (`adminGateEnabledChannels` reads the
 * gate for that stream), so this cannot just flatten both hats' entries into
 * one `applyBulkToggle` call — it chains one `applyBulkToggle` per stream,
 * threading the accumulating prefs through so nothing an earlier stream set
 * is lost. The whole page still commits in ONE `saveMyAdminNotificationPrefs`
 * write, same as the section-level bulk.
 *
 * Before this, the page's "All on" was nine per-section buttons, none of
 * which came close to covering the page (the largest section reached 8 of 29
 * notifications). This is the one control that actually means "all on" for
 * the page; the per-section buttons remain as a narrower, explicitly-labeled
 * convenience alongside it.
 */
export function applyBulkToggleAll(
  prefs: AdminNotificationPrefs,
  matrix: NotificationMatrix,
  scopes: readonly BulkToggleScope[],
  on: boolean,
): AdminNotificationPrefs {
  let next = prefs;
  for (const { entries, stream } of scopes) {
    next = applyBulkToggle(next, matrix, entries, stream, on);
  }
  return next;
}

/**
 * Every (notification, stream) pair whose `channel` the operator may actually
 * decide: the gate offers that channel on that stream and it is not forced on.
 * Exactly the pairs a row toggle on the full My Notifications page would let
 * them click, narrowed to one channel.
 *
 * Shared by the two functions below so the Account screen's channel switch can
 * never claim to control a pair that its own flip would skip.
 */
function editablePairs(
  matrix: NotificationMatrix,
  scopes: readonly BulkToggleScope[],
  channel: NotificationChannel,
): Array<{ entry: NotificationCatalogEntry; stream: NotifStream }> {
  const pairs: Array<{ entry: NotificationCatalogEntry; stream: NotifStream }> = [];
  for (const { entries, stream } of scopes) {
    for (const entry of entries) {
      if (!adminGateEnabledChannels(matrix, entry, stream).includes(channel)) continue;
      if (adminChannelForced(matrix, entry, stream, channel)) continue;
      pairs.push({ entry, stream });
    }
  }
  return pairs;
}

/** How many notifications one channel switch on the Account screen governs. */
export function channelMasterCount(
  matrix: NotificationMatrix,
  scopes: readonly BulkToggleScope[],
  channel: NotificationChannel,
): number {
  return editablePairs(matrix, scopes, channel).length;
}

/**
 * Where the Account screen's single per-channel switch sits (issue #719).
 *
 * There is no global "email on" bit in the store: `staff/{uid}.notificationPrefs`
 * is per notification (`byKey`), with a `byCategory` fallback and a catalog
 * default. So one switch has to stand for many rows, and this is the reading
 * that does not lie to the operator: ON when at least one notification would
 * currently reach them on this channel. Turning it off silences the channel
 * (every editable row goes off); turning it back on restores every editable
 * row. Anything narrower ("all of them are on") would report OFF while mail
 * kept arriving.
 *
 * Forced channels are excluded on purpose. The business gate decides those and
 * the full page renders them read-only, so counting them here would pin the
 * switch on and make it look broken when clicked.
 */
export function channelMasterOn(
  prefs: AdminNotificationPrefs,
  matrix: NotificationMatrix,
  scopes: readonly BulkToggleScope[],
  channel: NotificationChannel,
): boolean {
  return editablePairs(matrix, scopes, channel).some(({ entry }) =>
    userChannelChoice(prefs, entry.key, entry.category, channel),
  );
}

/**
 * The write half of `channelMasterOn`: flips ONE channel on every editable
 * (notification, stream) pair, leaving the other two channels exactly where the
 * operator left them. `applyBulkToggle` cannot be reused here because it flips
 * every offered channel at once, which would turn an "SMS off" click into a
 * silent wipe of the email choices beside it.
 */
export function applyChannelToggle(
  prefs: AdminNotificationPrefs,
  matrix: NotificationMatrix,
  scopes: readonly BulkToggleScope[],
  channel: NotificationChannel,
  on: boolean,
): AdminNotificationPrefs {
  let next = prefs;
  for (const { entry } of editablePairs(matrix, scopes, channel)) {
    next = setUserChannelChoice(next, entry.key, channel, on);
  }
  return next;
}

/**
 * Structural equality over the plain JSON-like prefs shape (booleans and
 * string-keyed records only), independent of key insertion order. Drives the
 * editor's dirty check: `!prefsEqual(draft, baseline)` gates the Save button,
 * so a load-then-immediately-render never reads as dirty just because the
 * draft object is a fresh clone of the baseline.
 */
export function prefsEqual(a: AdminNotificationPrefs, b: AdminNotificationPrefs): boolean {
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bRec, k) && deepEqual(aRec[k], bRec[k]),
  );
}
