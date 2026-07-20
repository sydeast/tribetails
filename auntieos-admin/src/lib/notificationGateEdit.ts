import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  STREAM_STAFF,
  type NotificationCatalogEntry,
  type NotificationChannel,
  type NotificationMatrix,
  type NotificationOverride,
  type NotifStream,
  type StreamGate,
} from '../api/myNotifications';
import {
  flatEffectiveChannel,
  flatEffectiveEnabled,
  streamEffectiveChannelLocked,
  streamEffectiveLockedEnabled,
} from './myNotificationsFormat';

/**
 * Pure edit logic for the BUSINESS notification gate matrix
 * (`screens/NotificationGate.tsx`), ported field-for-field from the wasm
 * `NotificationOverridesRepository.kt` write helpers. This is the gate the
 * operator sets ("for each notification, which channels does it OFFER, and are
 * any locked on"), the mirror of what `myNotificationsEdit.ts` is for the
 * operator's own receive prefs.
 *
 * It deliberately REUSES the read-side effective-state helpers already ported in
 * `myNotificationsFormat.ts` (`flatEffective*`, `streamEffective*`), so the one
 * subtle rule (a stream overlay wins field-by-field, else the flat legacy value,
 * else the catalog default) is defined in exactly one place for both screens.
 * What lives here is only the gate's own concern: the audience-tab taxonomy, the
 * write-side override transforms, and the wire encoder that matches the backend
 * `saveBusinessNotificationOverride` zod schema byte-for-byte.
 */

type ChannelMap = Partial<Record<NotificationChannel, boolean>>;

// ─────────────────────────────────────────────────────────────────────────────
// Audience taxonomy (the gate's three tabs: Business / Staff / Kinfolk)
// ─────────────────────────────────────────────────────────────────────────────

/** One audience tab in the gate matrix, in display order. */
export interface NotifAudienceTab {
  readonly stream: NotifStream;
  readonly title: string;
  readonly order: number;
}

/**
 * The three recipient audiences the gate is organized around, in tab order.
 * Mirrors `NotifAudience` in NotificationOverridesRepository.kt (Business /
 * Staff (Auntie) / Kinfolk); a notification can appear under more than one.
 */
export const NOTIF_AUDIENCES: readonly NotifAudienceTab[] = [
  { stream: STREAM_BUSINESS, title: 'Business', order: 0 },
  { stream: STREAM_STAFF, title: 'Staff (Auntie)', order: 1 },
  { stream: STREAM_KINFOLK, title: 'Kinfolk', order: 2 },
];

/** Plain-language explainer of what each audience tab governs (operator clarity). */
export function audienceBlurb(stream: NotifStream): string {
  switch (stream) {
    case STREAM_BUSINESS:
      return 'Your owner hat: bookings, invoices, payments, security, and ratings. What the business hears.';
    case STREAM_STAFF:
      return 'What your Aunties see day to day: visit notes, KinTale comments, pet updates, the schedule digest.';
    default:
      return 'What families receive: their own confirmations, arrivals, visit reports, and receipts.';
  }
}

/** The catalog entries shown under one audience tab: exactly the ones it serves. */
export function catalogForStream(
  catalog: readonly NotificationCatalogEntry[],
  stream: NotifStream,
): NotificationCatalogEntry[] {
  return catalog.filter((e) => e.audiences.has(stream));
}

/**
 * One short line for a shared key, naming the OTHER audience's copy (e.g. under
 * the Business tab a booking key families also receive reads "Kinfolk get their
 * own copy of this one"). Null when the entry serves only the current audience.
 * The backend never pairs business with staff, so there is at most one other.
 */
export function sharedCopyCaption(
  entry: NotificationCatalogEntry,
  currentStream: NotifStream,
): string | null {
  if (!entry.audiences.has(currentStream)) return null;
  const other = NOTIF_AUDIENCES.map((a) => a.stream).find(
    (s) => s !== currentStream && entry.audiences.has(s),
  );
  switch (other) {
    case STREAM_KINFOLK:
      return 'Kinfolk get their own copy of this one';
    case STREAM_BUSINESS:
      return 'The owner gets their own copy of this one';
    case STREAM_STAFF:
      return 'Your Aunties get their own copy of this one';
    default:
      return null;
  }
}

/**
 * Whether the catalog's `alwaysEnabled` applies to THIS stream's copy: an empty
 * `alwaysEnabledStreams` scopes it to every stream the key serves (legacy flat
 * behavior), else only the listed streams. Mirrors `alwaysEnabledFor` in Kotlin.
 */
export function alwaysEnabledFor(entry: NotificationCatalogEntry, stream: NotifStream): boolean {
  return (
    entry.alwaysEnabled && (entry.alwaysEnabledStreams.size === 0 || entry.alwaysEnabledStreams.has(stream))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-side override transforms (what the gate persists when a row is edited)
// ─────────────────────────────────────────────────────────────────────────────

/** The empty override (Kotlin `NotificationOverride()`): on, nothing pinned, no overlays. */
export function defaultOverride(): NotificationOverride {
  return { enabled: true, channels: {}, lockedEnabled: false, locked: {}, streams: {} };
}

/**
 * The full current override for an entry, so a single-field edit preserves the
 * rest. An untouched entry seeds `enabled` + per-allowed-channel `channels` from
 * the effective flat values (mirrors `currentOverride` in SettingsScreen.kt).
 */
export function currentOverride(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
): NotificationOverride {
  const existing = matrix.overrides[entry.key];
  if (existing) return existing;
  const channels: ChannelMap = {};
  for (const c of entry.allowedChannels) channels[c] = flatEffectiveChannel(matrix, entry.key, c);
  return { enabled: flatEffectiveEnabled(matrix, entry.key), channels, lockedEnabled: false, locked: {}, streams: {} };
}

/** A copy with `stream`'s gate transformed (created empty when absent). */
export function withStreamGate(
  override: NotificationOverride,
  stream: NotifStream,
  transform: (gate: StreamGate) => StreamGate,
): NotificationOverride {
  const current: StreamGate = override.streams[stream] ?? { channels: {}, locked: {} };
  return { ...override, streams: { ...override.streams, [stream]: transform(current) } };
}

/** Set `stream`'s whole-notification on/off overlay. */
export function setStreamEnabled(
  override: NotificationOverride,
  stream: NotifStream,
  enabled: boolean,
): NotificationOverride {
  return withStreamGate(override, stream, (g) => ({ ...g, enabled }));
}

/** Set one channel's on/off overlay under `stream`. */
export function setStreamChannel(
  override: NotificationOverride,
  stream: NotifStream,
  channel: NotificationChannel,
  value: boolean,
): NotificationOverride {
  return withStreamGate(override, stream, (g) => ({ ...g, channels: { ...g.channels, [channel]: value } }));
}

/**
 * The lock reason is always FLAT (one reason per key, not per stream). `text`
 * goes on verbatim; "" is the explicit wire signal to clear it. Mirrors the
 * `copy(lockReason = text)` edit in SettingsScreen.kt.
 */
export function setLockReason(override: NotificationOverride, text: string): NotificationOverride {
  return { ...override, lockReason: text };
}

function withoutChannel(map: ChannelMap, channel: NotificationChannel): ChannelMap {
  const next = { ...map };
  delete next[channel];
  return next;
}

/**
 * The next full override after toggling `channel`'s lock under `stream`'s tab.
 * Locking is a plain per-stream write. UNLOCKING is trickier: the wire only
 * accepts literal-true lock-map values, so a flat (legacy) lock cannot be
 * overridden with false. Instead the flat lock is cleared and first materialized
 * as an explicit stream lock on every OTHER stream the entry serves, so their
 * effective state never changes. Ported verbatim from `toggledStreamChannelLock`.
 */
export function toggledStreamChannelLock(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
  stream: NotifStream,
  channel: NotificationChannel,
): NotificationOverride {
  const base = matrix.overrides[entry.key] ?? defaultOverride();
  const currentlyLocked = streamEffectiveChannelLocked(matrix, entry.key, stream, channel);
  if (!currentlyLocked) {
    return withStreamGate(base, stream, (g) => ({ ...g, locked: { ...g.locked, [channel]: true } }));
  }
  let next = base;
  if (base.locked[channel] === true) {
    for (const other of entry.audiences) {
      if (other === stream) continue;
      if (streamEffectiveChannelLocked(matrix, entry.key, other, channel)) {
        next = withStreamGate(next, other, (g) => ({ ...g, locked: { ...g.locked, [channel]: true } }));
      }
    }
    next = { ...next, locked: withoutChannel(next.locked, channel) };
  }
  return withStreamGate(next, stream, (g) => ({ ...g, locked: withoutChannel(g.locked, channel) }));
}

/**
 * The next full override after toggling the whole-notification lock under
 * `stream`'s tab. `lockedEnabled` is tri-state on the wire, so an explicit
 * stream-level false is enough to unlock one stream while a flat lock keeps the
 * others locked. Ported verbatim from `toggledStreamEnabledLock`.
 */
export function toggledStreamEnabledLock(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
  stream: NotifStream,
): NotificationOverride {
  const base = matrix.overrides[entry.key] ?? defaultOverride();
  const currentlyLocked = streamEffectiveLockedEnabled(matrix, entry.key, stream);
  return withStreamGate(base, stream, (g) => ({ ...g, lockedEnabled: !currentlyLocked }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire encoder (matches the `saveBusinessNotificationOverride` zod schema)
// ─────────────────────────────────────────────────────────────────────────────

/** One stream overlay on the wire. `locked` carries literal-true only. */
export interface WireStreamGate {
  enabled?: boolean;
  channels?: Record<string, boolean>;
  lockedEnabled?: boolean;
  locked?: Record<string, true>;
}

/** The `override` payload of a `saveBusinessNotificationOverride` call. */
export interface WireOverride {
  enabled: boolean;
  channels?: Record<string, boolean>;
  lockedEnabled?: boolean;
  locked?: Record<string, true>;
  lockReason?: string;
  streams?: Record<string, WireStreamGate>;
}

/** The subset of a lock map that is literal `true` (the only value the schema accepts). */
function onlyTrueLocks(map: ChannelMap): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(map)) if (v === true) out[k] = true;
  return out;
}

/** Channel on/off map verbatim (both true and false are meaningful gate values). */
function channelBooleans(map: ChannelMap): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
  return out;
}

function encodeStreamGate(gate: StreamGate): WireStreamGate {
  const out: WireStreamGate = {};
  if (gate.enabled !== undefined) out.enabled = gate.enabled;
  const channels = channelBooleans(gate.channels);
  if (Object.keys(channels).length > 0) out.channels = channels;
  // Tri-state: an explicit false unlocks just this stream, so send it when set.
  if (gate.lockedEnabled !== undefined) out.lockedEnabled = gate.lockedEnabled;
  const locked = onlyTrueLocks(gate.locked);
  if (Object.keys(locked).length > 0) out.locked = locked;
  return out;
}

/**
 * Encode an override to the exact wire shape the backend zod validates:
 *  - `enabled` always present.
 *  - flat `channels` sent whenever non-empty (values verbatim).
 *  - flat `lockedEnabled` sent only when true (false is the default; the schema
 *    would accept false but the Kotlin client omits it, and we match it).
 *  - `locked` maps carry literal-true entries only (false would fail
 *    `z.literal(true)`).
 *  - `lockReason` sent when defined; "" is the explicit "clear it" signal.
 *  - `streams` sent only for non-empty gates.
 * Mirrors `encodeOverride` / `encodeStreamGate` in NotificationOverridesRepository.kt.
 */
export function encodeOverridePayload(override: NotificationOverride): WireOverride {
  const out: WireOverride = { enabled: override.enabled };
  const channels = channelBooleans(override.channels);
  if (Object.keys(channels).length > 0) out.channels = channels;
  if (override.lockedEnabled) out.lockedEnabled = true;
  const locked = onlyTrueLocks(override.locked);
  if (Object.keys(locked).length > 0) out.locked = locked;
  if (override.lockReason !== undefined) out.lockReason = override.lockReason;
  const streams: Record<string, WireStreamGate> = {};
  for (const [stream, gate] of Object.entries(override.streams)) {
    const encoded = encodeStreamGate(gate);
    if (Object.keys(encoded).length > 0) streams[stream] = encoded;
  }
  if (Object.keys(streams).length > 0) out.streams = streams;
  return out;
}
