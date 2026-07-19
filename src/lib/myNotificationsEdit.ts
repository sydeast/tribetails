import type {
  AdminNotificationPrefs,
  NotificationCatalogEntry,
  NotificationChannel,
  NotificationMatrix,
  NotifStream,
} from '../api/myNotifications';
import { adminChannelForced, adminGateEnabledChannels } from './myNotificationsFormat';

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
