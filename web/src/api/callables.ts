/**
 * Full callable inventory from the Kotlin client
 * (src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt).
 *
 * Phase 1 implements: getMyAccess, getMyHome, getInvitePreview,
 * claimInviteSignup, acceptInvite. Phase 2A adds: getMyBookings,
 * getMyVisits, getMyKin, archiveKin, getMyKinTales (see ./portal.ts).
 *
 * TODO(phase 2b/3): type and wrap the rest. Names below are the exact
 * deployed function names (region us-central1).
 */
export const PENDING_CALLABLES = [
  // home / config
  'dismissBanner',
  'getFeatureFlags',
  'getBusinessContact',
  'getFormSchema',
  'getBreeds',
  'getServiceCatalog',
  'getVetClinics',
  'submitVetClinic',
  // bookings / visits
  'requestBooking',
  'requestBookingCancellation',
  'addBookingNote',
  // kin
  'addKin',
  'updateKin',
  'uploadKinPhoto',
  // kintales
  'getMyKinTaleMedia',
  'addKinTaleComment',
  'getKinTaleComments',
  'createShareLink',
  'revokeShareLink',
  // invoices / billing
  'getMyInvoices',
  'getMyInvoicePdf',
  'payInvoice',
  'redeemCredit',
  // tribe profile / members
  'getMyTribeProfile',
  'saveTribeProfile',
  'saveHomeAccess',
  'listMembers',
  'addSecondaryContact',
  'updateSecondaryPermissions',
  // account / notifications
  'getMyAccount',
  'saveMyAccount',
  'getMyNotificationPrefs',
  'saveMyNotificationPrefs',
  'registerFcmToken',
  'unregisterFcmToken',
  // messaging
  'sendKinfolkMessage',
  'getMyConversation',
  'generate',
  // media / search
  'signKinfolkAvatar',
  'mapboxSearch',
  'mapboxRetrieve',
] as const;

export type PendingCallableName = (typeof PENDING_CALLABLES)[number];
