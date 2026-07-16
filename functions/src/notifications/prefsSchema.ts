import { z } from 'zod';

/**
 * Shared zod schema for user notification preferences (the hybrid
 * byCategory / byKey / marketingOptIn shape in notifications/types.ts
 * UserNotificationPrefs). Used by BOTH the kinfolk portal callables
 * (clients/{uid}.notificationPrefs) and the admin callables
 * (staff/{uid}.notificationPrefs) so the two cannot drift.
 */
const Channel = z.enum(['email', 'sms', 'push']);
const Category = z.enum([
  'visit',
  'kintale',
  'invoice',
  'schedule',
  'home',
  'account',
  'ratings',
  'marketing',
  // Bug fix (audience revamp 2026-07): types.ts Category always included
  // 'security' but this enum omitted it, rejecting valid security-row prefs.
  'security',
  // Vendor-parity (2026-07-02): inbox message notifications.
  'messages',
]);
const MarketingCategory = z.enum(['newsletter', 'survey', 'marketing']);

const ChannelMap = z.record(Channel, z.boolean()).optional();

export const PrefsShape = z.object({
  byCategory: z.record(Category, ChannelMap).optional(),
  byKey: z.record(z.string(), ChannelMap).optional(),
  marketingOptIn: z.record(MarketingCategory, z.boolean()).optional(),
});

export const SaveArgs = z.object({ prefs: PrefsShape });
