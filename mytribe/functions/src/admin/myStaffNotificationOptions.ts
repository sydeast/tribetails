import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { NOTIFICATION_CATALOG } from '../notifications/catalog';
import { resolveOverrideForKey } from '../notifications/prefs';
import type { BusinessNotificationOverride, Channel } from '../notifications/types';

/**
 * #2182: the notification types an Auntie can receive, with what the business
 * has set for each, so her Account Notifications panel and My notifications
 * screen can draw her rows and her channel switches.
 *
 * `getBusinessNotificationOverrides` is the owner's Settings > Notifications
 * read and stays owner-only: it returns every notification the business sends,
 * who each one reaches, what fires it, which template renders it, the mail the
 * gate does not govern and the business admin roster. None of that is hers.
 * This callable answers the narrower question her own choices need.
 *
 * ── EXACTLY WHAT CROSSES THE BOUNDARY ────────────────────────────────────────
 *
 * Only catalog rows that serve the STAFF stream, and per row only how it is
 * drawn (key, label, category, description, delivery mode), which channels it
 * may use, which the catalog requires, and whether it is always on for staff.
 * Its `audiences` is always `{ staff: true }`, so neither client draws an
 * "As the owner" section from it.
 *
 * The business's choices for those rows come back as ONE flat gate per key:
 * the staff stream's own value where the owner set one, otherwise the flat
 * value, field by field. That is the order the dispatcher reads them in
 * (`resolveChannels`), so what her screen shows locked is what is locked for
 * her. The owner's own reason for a lock rides along, because it is written to
 * be read by whoever the lock binds. Choices for the business and household
 * streams never leave the server.
 *
 * The shape is the subset of `getBusinessNotificationOverrides`'s reply that
 * the clients' existing decoders read, so the same row and switch code draws
 * both.
 */

const CHANNELS: readonly Channel[] = ['email', 'sms', 'push'];

export interface StaffNotificationCatalogRow {
  key: string;
  label: string;
  category: string;
  audience: 'staff';
  audiences: { staff: true };
  allowedChannels: string[];
  required: Record<string, boolean>;
  alwaysEnabled: boolean;
  alwaysEnabledStreams?: { staff: true };
  kinfolkFacing: false;
  deliveryMode: string;
  description: string;
}

export interface StaffNotificationGate {
  enabled?: boolean;
  channels: Partial<Record<Channel, boolean>>;
  lockedEnabled?: boolean;
  locked: Partial<Record<Channel, true>>;
  lockReason?: string;
}

export interface StaffNotificationOptions {
  catalog: StaffNotificationCatalogRow[];
  overrides: Record<string, StaffNotificationGate>;
}

/** The staff stream's effective gate for one stored override: stream value, else flat value. */
export function staffGateFrom(override: BusinessNotificationOverride): StaffNotificationGate {
  const stream = override.streams?.staff;
  const channels: Partial<Record<Channel, boolean>> = {};
  const locked: Partial<Record<Channel, true>> = {};
  for (const channel of CHANNELS) {
    const value = stream?.channels?.[channel] ?? override.channels?.[channel];
    if (typeof value === 'boolean') channels[channel] = value;
    if ((stream?.locked?.[channel] ?? override.locked?.[channel]) === true) locked[channel] = true;
  }
  const enabled = stream?.enabled ?? override.enabled;
  const lockedEnabled = stream?.lockedEnabled ?? override.lockedEnabled;
  const reason = typeof override.lockReason === 'string' ? override.lockReason.trim() : '';
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    channels,
    ...(typeof lockedEnabled === 'boolean' ? { lockedEnabled } : {}),
    locked,
    ...(reason !== '' ? { lockReason: reason } : {}),
  };
}

/** Pure: the catalog and the stored overrides onto the staff-only projection. */
export function buildStaffNotificationOptions(
  stored: Record<string, BusinessNotificationOverride>,
): StaffNotificationOptions {
  const catalog: StaffNotificationCatalogRow[] = [];
  const overrides: Record<string, StaffNotificationGate> = {};
  for (const def of Object.values(NOTIFICATION_CATALOG)) {
    if (def.audiences.staff !== true) continue;
    // `alwaysEnabledStreams` absent means every stream the key serves, staff
    // included. Present without staff means it is NOT always on for her.
    const alwaysForStaff =
      def.alwaysEnabled && (def.alwaysEnabledStreams === undefined || def.alwaysEnabledStreams.staff === true);
    catalog.push({
      key: def.key,
      label: def.label,
      category: def.category,
      audience: 'staff',
      audiences: { staff: true },
      allowedChannels: [...def.allowedChannels],
      required: Object.fromEntries(Object.entries(def.required).map(([k, v]) => [k, v === true])),
      alwaysEnabled: alwaysForStaff,
      ...(alwaysForStaff ? { alwaysEnabledStreams: { staff: true as const } } : {}),
      kinfolkFacing: false,
      deliveryMode: def.deliveryMode,
      description: def.description,
    });
    const override = resolveOverrideForKey(stored, def.key);
    if (override) overrides[def.key] = staffGateFrom(override);
  }
  return { catalog, overrides };
}

export async function getMyStaffNotificationOptionsHandler(
  _req: CallableRequest<unknown>,
): Promise<StaffNotificationOptions> {
  const snap = await db().collection('businessSettings').doc('notifications').get();
  const data = snap.data() as { byKey?: Record<string, BusinessNotificationOverride> } | undefined;
  return buildStaffNotificationOptions(data?.byKey ?? {});
}

export const getMyStaffNotificationOptions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getMyStaffNotificationOptions', getMyStaffNotificationOptionsHandler),
);
