// Sentry is lazy-initialised by each handler at first invocation. Eager
// init at module-load logged a spurious "SENTRY_DSN unset" on cold-start
// of any Function whose `secrets:` array didn't include SENTRY_DSN, even
// though those Functions don't capture to Sentry anyway.
export { health } from './health/health';

// callables
export { acceptInvite } from './membership/acceptInvite';
export { mintInviteFromPrimary } from './membership/mintInviteFromPrimary';
export { updateSecondaryPermissions } from './membership/updateSecondaryPermissions';
export { listMembers } from './portal/listMembers';
export { updateMemberLabel } from './membership/updateMemberLabel';
export { setKinfolkOverrides } from './theme/setKinfolkOverrides';
export { swapPrimaryContact } from './recovery/swapPrimaryContact';
export { signOutAllDevices } from './auth/signOutAllDevices';
export { requestPasswordReset } from './auth/requestPasswordReset';
export {
  recordFailedLogin,
  beforeSignIn,
  unlockKinfolkAccount,
} from './auth/loginSecurity';
export { createShareLink } from './share/createShareLink';
export { revokeShareLink } from './share/revokeShareLink';
export { requestPrimaryRecovery } from './recovery/requestPrimaryRecovery';

// portal-callables (kinfolk-facing read translation layer)
export { getMyHome } from './portal/getMyHome';
export { getMyAccess } from './portal/getMyAccess';
export { getMyInvoices } from './portal/getMyInvoices';
export { getMyKin } from './portal/getMyKin';
export { getMyKinTales } from './portal/getMyKinTales';
export { getMyBookings } from './portal/getMyBookings';
export { requestBooking } from './portal/requestBooking';
export { requestBookingCancellation } from './portal/requestBookingCancellation';
export { getServiceCatalog } from './portal/getServiceCatalog';
export { getVetClinics } from './portal/getVetClinics';
export { getBreeds } from './portal/getBreeds';
export { submitVetClinic } from './portal/submitVetClinic';
export { getMyVisits } from './portal/getMyVisits';
export { getBusinessContact } from './portal/getBusinessContact';
export { getFeatureFlags } from './portal/getFeatureFlags';
export { getInvitePreview } from './portal/getInvitePreview';
export { claimInviteSignup } from './membership/claimInviteSignup';
export { signKinfolkAvatar } from './portal/signKinfolkAvatar';
export { dismissBanner } from './portal/dismissBanner';
export { mapboxSearch, mapboxRetrieve } from './portal/mapboxSearch';
export { getFormSchema } from './portal/getFormSchema';
export { getMyTribeProfile } from './portal/getMyTribeProfile';
export { saveTribeProfile } from './portal/saveTribeProfile';
export { saveHomeAccess } from './portal/saveHomeAccess';
export { getMyNotificationPrefs, saveMyNotificationPrefs } from './portal/notificationPrefs';
export { getMyAccount, saveMyAccount } from './portal/account';
export { payInvoice } from './portal/payInvoice';
export { redeemCredit } from './portal/redeemCredit';
export { addKin, updateKin, archiveKin } from './portal/kinWrites';
export { setActiveTribe } from './portal/setActiveTribe';
export { signKinPhotoUpload, confirmKinPhotoUpload } from './portal/signKinPhotoUpload';
export { addSecondaryContact } from './portal/addSecondaryContact';
export { getMyKinTaleMedia } from './portal/getMyKinTaleMedia';
export { registerFcmToken, unregisterFcmToken } from './portal/registerFcmToken';
export { addKinTaleComment, getKinTaleReaction, toggleKinTaleLove } from './portal/kinTaleEngagement';
export { getKinTaleComments } from './portal/getKinTaleComments';
export { markNotificationRead, markNotificationUnread } from './portal/markNotificationRead';
export { bulkMarkNotificationsRead } from './portal/bulkMarkNotificationsRead';
export { archiveNotification, bulkArchiveNotifications } from './portal/archiveNotification';
export { addBookingNote } from './portal/addBookingNote';
export { submitRating } from './portal/submitRating';

// admin-callables
export { provisionTribe } from './admin/provisionTribe';
export { mintInvite } from './admin/mintInvite';
export { inviteKinfolkToPortal } from './admin/inviteKinfolkToPortal';
export { revokeInvite } from './admin/revokeInvite';
export { setMemberPermissions } from './admin/setMemberPermissions';
export { removeMember } from './admin/removeMember';
export { setTribePin } from './admin/setTribePin';
export { approveTribePinChange } from './admin/approveTribePinChange';
export { setBrandTokens } from './admin/setBrandTokens';
export { executePrimaryRecovery } from './admin/executePrimaryRecovery';
export { postInvoiceEvent } from './admin/postInvoiceEvent';
export { createInvoice } from './admin/createInvoice';
export { createQuote } from './admin/createQuote';
export { sendInvoiceReminder } from './admin/sendInvoiceReminder';
export { generateReceipt } from './admin/generateReceipt';
export { markInvoicePaid } from './admin/markInvoicePaid';
export { reviewAndSendDraftInvoice } from './admin/reviewAndSendDraftInvoice';
export { updateInvoice } from './admin/updateInvoice';
// W2-1 (ADR-0002 callable-only invoice writes): the callables that absorb
// Android's four remaining direct Firestore money writes. Additive; nothing
// calls them until Android re-points (W2-2), and rules are revoked after that.
export { linkInvoiceSessions } from './admin/linkInvoiceSessions';
export { recordPayment } from './admin/recordPayment';
export { archiveInvoice } from './admin/archiveInvoice';
export { unarchiveInvoice } from './admin/unarchiveInvoice';
// Detection + repair for invoices wrecked by the pre-2026-07-25 partial-payment
// write. `detect` mode reports and writes nothing; see the file header.
export { repairInvoicePayments } from './admin/repairInvoicePayments';
// Task 5.1 (#18): the read half of turning completed visits into an invoice.
export { listUninvoicedSessions } from './admin/listUninvoicedSessions';
export { setKinfolkClaim } from './admin/setKinfolkClaim';
export { revokeKinfolkClaim } from './admin/revokeKinfolkClaim';
// `signCloudinaryUpload` is deliberately NOT exported here. AuntieOS owns that
// function name in the shared `auntieos-ttpc` project (web/functions/index.js,
// behind the `/api/cloudinary/sign-upload` hosting rewrite in web/firebase.json).
// MyTribe once exported its own implementation under the same name, so whichever
// codebase deployed last won. MyTribe's version folded `allowed_formats` into the
// signature base, which no AuntieOS client sends, so every upload it signed came
// back "Invalid Signature" (Sentry AUNTIEOS-ADMIN-1D, verified bit-exactly).
// Portal uploads use `signKinPhotoUpload` / `signKinfolkAvatar`, which keep
// sharing `lib/cloudinary.ts`.
//
// Brand logos obey the same rule and go further: they add NO signer at all.
// Both admin clients already upload the workspace logo through AuntieOS's
// deployed `/api/cloudinary/sign-upload`, so `confirmBrandAssetUpload` only
// validates and persists the URL that upload produced. See `lib/brandAsset.ts`.
export { confirmBrandAssetUpload } from './admin/confirmBrandAssetUpload';
export { dispatchVisitNotification } from './admin/dispatchVisitNotification';
export { scheduleMarketingBlast } from './admin/scheduleMarketingBlast';
export { addInternalBookingNote } from './admin/addInternalBookingNote';
export { saveTemplate } from './admin/saveTemplate';
export { deleteTemplate } from './admin/deleteTemplate';
export { assignTemplate } from './admin/assignTemplate';
export { assignTemplatesToCategory } from './admin/assignTemplatesToCategory';
export { unassignTemplate } from './admin/unassignTemplate';
export { createMultiDateBookingRequest } from './admin/createMultiDateBookingRequest';
export { listTemplates, listTemplateBindings } from './admin/listTemplates';
export { listCategories } from './admin/listCategories';
export { listCatalogKeys } from './admin/listCatalogKeys';
export { createBlockedTimeSlot } from './admin/createBlockedTimeSlot';
export { assignAuntie } from './admin/assignAuntie';
export { listStaff } from './admin/listStaff';
export {
  provisionBusinessAdmins,
  setBusinessAdmins,
  removeBusinessAdmins,
  checkBusinessAdmins,
} from './admin/provisionBusinessAdmins';
export {
  getMyAdminNotificationPrefs,
  saveMyAdminNotificationPrefs,
} from './admin/myAdminNotificationPrefs';
export { getLocalWeather } from './admin/getLocalWeather';
export { createKinCareSession } from './admin/createKinCareSession';
export { createTrainingDocument } from './admin/createTrainingDocument';
export { updateTrainingDocument } from './admin/updateTrainingDocument';
export { deleteTrainingDocument } from './admin/deleteTrainingDocument';
export { rescheduleBooking } from './admin/rescheduleBooking';
export { syncGoogleCalendarBusyEvents } from './admin/syncGoogleCalendarBusyEvents';
// Task 7.2, editable calendars over OAuth. `googleOAuthCallback` is the HTTP
// redirect target and is exported with the callables it belongs to rather than
// down in the HTTPS block, because the flow is meaningless split in two: the
// callable mints the one-time state the callback redeems. Both halves declare
// GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET and both read them.
export {
  startGoogleCalendarConnect,
  googleOAuthCallback,
} from './admin/googleCalendar/googleCalendarConnect';
export {
  getGoogleCalendarConnection,
  disconnectGoogleCalendar,
} from './admin/googleCalendar/googleCalendarAccount';
export {
  listGoogleCalendars,
  setGoogleCalendarTargets,
} from './admin/googleCalendar/googleCalendarSelection';
export { pushVisitsToGoogleCalendar } from './admin/googleCalendar/pushVisitsToGoogleCalendar';
export { sendExternalMessage, suppressExternalRecipient } from './admin/sendExternalMessage';
export { smtp2goEventWebhook, twilioStatusCallback } from './admin/engagementWebhooks';
export { listRecentSends } from './admin/listRecentSends';
export {
  saveAudienceSegment,
  listAudienceSegments,
  deleteAudienceSegment,
} from './admin/audienceSegments';
export { broadcastMessage } from './admin/broadcastMessage';
export {
  listConversations,
  getConversationThread,
  replyToConversation,
  markConversationRead,
} from './admin/conversations';
export { sendKinfolkMessage, getMyConversation, markThreadRead } from './portal/sendKinfolkMessage';
export { generate } from './portal/generate';
export { generateInvoicePdf } from './admin/generateInvoicePdf';
export { getMyInvoicePdf } from './portal/getMyInvoicePdf';
export { setMediaProfilePhoto } from './admin/setMediaProfilePhoto';
export { manageBookingSeries } from './admin/manageBookingSeries';
export { batchUpdateBookings } from './admin/batchUpdateBookings';
export { aiBackfillTaleTitles } from './admin/aiBackfillTaleTitles';
export { saveFormSchema } from './admin/saveFormSchema';
// LEGACY/ARCHIVED, see src/admin/ingestKinTale.ts header. Kept deployed in
// reserved state per operator direction 2026-05-19; superseded by canonical
// `kin_care_reports` writes. Re-add to active rotation only if backfill needs.
export { ingestKinTale } from './admin/ingestKinTale';
export { listFormSchemas } from './admin/listFormSchemas';
export { deleteFormSchema } from './admin/deleteFormSchema';
// Run-4 #7b: shared bank of common KinTale checklist items (list + save-to-bank).
export { listChecklistBank, saveChecklistBankItem } from './admin/checklistBank';
export { triageOrphanReport } from './admin/triageOrphanReport';
export { verifyActivityLogChain } from './admin/verifyActivityLogChain';
export { setFeatureFlags } from './admin/setFeatureFlags';
export { logActivity } from './admin/logActivity';
export { getNotificationCatalog } from './notifications/getNotificationCatalog';
// Dashboard-widget callables (AO-35/39/40/41): all admin-gated.
export { optimizeRoute } from './admin/optimizeRoute';
export { logExpense, listExpenses } from './admin/expenses';
export { listSupplies, adjustSupply, upsertSupply } from './admin/supplies';
export { listExpirations, upsertExpiration } from './admin/expirations';
// 17.3 Home dashboard layout: the operator's own widget order/sizes.
export { saveDashboardLayout } from './admin/saveDashboardLayout';
export {
  getBusinessNotificationOverrides,
  saveBusinessNotificationOverride,
  deleteBusinessNotificationOverride,
} from './admin/notificationOverrides';

// HTTPS
export { getShareLink } from './share/getShareLink';
export { getSharedKinTalePage } from './share/getSharedKinTalePage';
export { stripeWebhook } from './billing/stripeWebhook';
// WARNING-8: Twilio-signature-verified inbound comms webhooks. Server-authoritative
// writes of calls_log / voicemails / sms_messages (replaces the spoofable
// client-from-FCM-push writer). Inert until the operator points Twilio at them.
export { twilioInboundSms, twilioInboundVoicemail, twilioInboundCall } from './twilio/twilioInbound';
export { addGuestKinTaleComment } from './public/addGuestKinTaleComment';
export { confirmSecureReset } from './security/confirmSecureReset';

// triggers
export { onAuthUserCreate } from './triggers/onAuthUserCreate';
export { onMembersWrite } from './triggers/onMembersWrite';
export { onKinTaleCreate } from './triggers/onKinTaleCreate';
export { onKinTaleUpdate } from './triggers/onKinTaleUpdate';
export { onInviteRequestCreate } from './triggers/onInviteRequestCreate';
export { onClientsWrite } from './triggers/onClientsWrite';
export { onBookingsWrite } from './triggers/onBookingsWrite';
export { onKinCareRollup } from './triggers/onKinCareRollup';
export { onFamilyKinWrite } from './triggers/onFamilyKinWrite';
export { onFlatKinWrite } from './triggers/onFlatKinWrite';
export { onFamilyProfileWrite } from './triggers/onFamilyProfileWrite';
export { onInvoicesWrite } from './triggers/onInvoicesWrite';
export { onKinTaleCommentCreate } from './triggers/onKinTaleCommentCreate';
export { onBookingNoteCreate } from './triggers/onBookingNoteCreate';
export { onRatingCreate } from './triggers/onRatingCreate';
export { onKinfolkCreate } from './triggers/onKinfolkCreate';

// notifications
export {
  onNotificationCreate,
  onNotificationChannelCreate,
} from './notifications';

// migration
export { migrateFoundationV1 } from './migration/migrateFoundationV1';
export { migrateFoundationV1Rollback } from './migration/migrateFoundationV1Rollback';

// scheduled
export { cleanupExpiredShareLinks } from './scheduled/cleanupExpiredShareLinks';
export { rotateOldFcmTokens } from './scheduled/rotateOldFcmTokens';
export { errorDailyDigest } from './scheduled/errorDailyDigest';
export { expireStaleInvites } from './scheduled/expireStaleInvites';
export { notificationDebounceSweep } from './scheduled/notificationDebounceSweep';
export { notificationScheduledSweep } from './scheduled/notificationScheduledSweep';
export { notificationBatchSweep } from './scheduled/notificationBatchSweep';
export { invoiceRemindersCron, invoiceOverdueCron } from './scheduled/invoiceRemindersCron';
export { aiBatchPollCron } from './scheduled/aiBatchPollCron';
export { kincareReminderCron } from './scheduled/kincareReminderCron';
export { scheduleDigestCron } from './scheduled/scheduleDigestCron';
