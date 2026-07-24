export { enqueueNotification } from './dispatcher';
export {
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEY_ALIASES,
  canonicalNotificationKey,
  getNotificationDef,
  legacyCategoriesFor,
  legacyKeysFor,
  listNotificationKeys,
} from './catalog';
export type { NotificationKeyAlias } from './catalog';
export {
  loadUserPrefs,
  loadBusinessOverride,
  resolveOverrideForKey,
  overrideForStream,
  streamForRecipient,
  resolveChannels,
  computeEffectiveChannels,
} from './prefs';
export { resolveRecipients } from './recipientResolver';
export type {
  Channel,
  Category,
  DeliveryMode,
  Audience,
  AudienceStream,
  MarketingCategory,
  RecipientResolver,
  NotificationDef,
  ResolvedChannels,
  EnqueueArgs,
  UserNotificationPrefs,
  BusinessNotificationOverride,
} from './types';
export { onNotificationCreate } from './triggers/onNotificationCreate';
export { onNotificationChannelCreate } from './triggers/onNotificationChannelCreate';
