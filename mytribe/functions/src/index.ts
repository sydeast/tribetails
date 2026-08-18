import { setGlobalOptions } from 'firebase-functions/v2';

// This call MUST stay the first executable statement in this file, above every
// `export ... from`. `setGlobalOptions` only reaches functions defined AFTER it
// runs, and `onCall` / `onSchedule` / `onDocument*` all run at module-import
// time. This file still emits CommonJS: tsconfig.json is `"module": "nodenext"`
// as of 2026-08-07, and with no `"type": "module"` in package.json that means
// tsc emits `export ... from` as a `require()` at its own source position, so
// source order is execution order here. Verified against the
// emitted `lib/index.js` and against the generated endpoint manifest rather
// than assumed; see the PR body for the proof.
//
// cpu 0.25: THE REASON THIS WAS SET IS NOT TRUE. It was chosen on 2026-08-01
//   because 240 Cloud Run services x 1 vCPU appeared to sit above the 200 vCPU
//   `CpuAllocPerProjectRegion` ceiling for us-central1, and that appeared to be
//   what broke five consecutive full deploys. Both halves were wrong, and
//   docs/RUNBOOK.md has said so since 2026-08-03:
//
//     - The deploys were refused by a RATE limit, not a capacity one:
//       'Per project mutation requests per minute per region' on
//       cloudfunctions.googleapis.com, 60/min, a System limit that cannot be
//       raised. Batching is what fixed them. cpu does not appear in it.
//     - `CpuAllocPerProjectRegion` meters RUNNING INSTANCES, not deployed
//       services, so "240 services x 1 vCPU" was never a quantity Google
//       counts. Read off the console 2026-08-03: 16,000 of 400,000 milli vCPU
//       in use. Four percent.
//
//   The setting is left in place here because changing it is a real decision
//   with real trade-offs, not a revert. See docs/adr/0004-functions-runtime-shape.md,
//   which recommends returning the default to cpu 1 after the lazy-import work
//   lands, and gives the measurements. What matters at this line is that nobody
//   reads the old justification and treats the shape as settled.
//
//   Functions that need more carry an explicit override at their own
//   definition; see lib/runtimeOptions.ts, including why below 1 vCPU Cloud Run
//   pins concurrency to 1.
// memory 256MiB: RAISED to 512MiB on 2026-08-04 because the fleet outgrew
//   256MiB, then RETURNED to 256MiB later the same day once the reason was
//   removed rather than accommodated. Both halves of that are below, in order,
//   because the first half is the outage this number exists to prevent.
//
//   THE OUTAGE (why it went up). Every callable in this codebase went down
//   intermittently on 2026-08-03.
//
//   The Functions runtime loads all of `index.js` on every cold start whatever
//   the target is (see lib/runtimeOptions.ts, which measures the same graph at
//   ~1.44s of CPU). So the import cost is the WHOLE codebase's, not the called
//   function's, and it grows with every export added here. On 2026-08-03 it
//   crossed 256MiB. Cloud Run logs for that evening, across
//   getBusinessNotificationOverrides, getGoogleCalendarConnection,
//   getFeatureFlags and listMembers:
//
//     'Memory limit of 256 MiB exceeded with 257 MiB used'
//     Default STARTUP TCP probe failed 1 time consecutively for container
//       "worker" on port 8080. The instance was not started.
//     The request failed because the instance failed the readiness check.
//
//   Readings ranged 256 to 271 MiB, which is why it presented as flaky rather
//   than broken: a cold start that happened to fit came up and served, and one
//   that did not died before the probe. A container killed at startup returns
//   503 at the edge with no CORS headers on it, so every one of these arrived in
//   the browser as "blocked by CORS policy" and in the client as
//   `functions/internal`, because lib/fns.ts maps any transport failure to
//   internal. Nothing reached a handler; auth and permissions were never
//   involved.
//
//   512MiB was the next step up and needed no CPU change: Cloud Run requires
//   0.5 vCPU only above 512MiB, so 0.25 vCPU still held and the
//   CpuAllocPerProjectRegion ceiling that drove the cpu 0.25 decision was
//   untouched. Memory has its own separate quota. That raise was written up at
//   the time as buying headroom rather than fixing the shape, and said so: every
//   function paying the import cost of all 227 was the actual defect.
//
//   THE FIX (why it came back down, 2026-08-04). The shape was fixed. Six heavy
//   SDKs moved out of the import graph and into the handlers that use them, and
//   the last of them, `googleapis`, was narrowed to the one API this codebase
//   calls. Measured on the built lib/ with an RSS probe, three runs each:
//
//     import of lib/index.js       290 -> 192.6-193.1 MiB  (3512 -> 1851 modules)
//     peak when Calendar is used   288.5-290.8 -> 193.5-194.3 MiB
//
//   (RSS from `process.memoryUsage()`, in MiB, which is the unit the limit is
//   in. The repo's older notes write these numbers as "MB"; they are the same
//   readings.)
//
//   The second line is the one that decides this number. Lazy loading alone
//   left `require('googleapis')` costing +95.4-97.7 MiB at the moment an
//   operator pressed a Calendar button, which took the process 32-35 MiB PAST
//   the 256MiB limit and would have reproduced the outage on the five Calendar
//   functions. `@googleapis/calendar` is the same generated client for the same
//   API and costs +0.9-1.0 MiB, so the peak now sits ~62 MiB under the limit
//   with nothing needing an override. See lib/googleOAuth.ts.
//
//   THE BILL IS WHY THIS IS WORTH DOING RATHER THAN LEAVING AT 512MiB.
//   `firebase deploy` refuses any deploy that raises the minimum bill and needs
//   `--force` to proceed, which is what the raise cost. Twelve functions carry
//   `minInstances: 1` and pay their memory floor standing, around the clock;
//   none of them touch Calendar. Coming back to 256MiB halves that floor.
//
//   THE 256MiB CEILING IS STILL REAL, AND IT IS NOW ~62 MiB AWAY. Adding a
//   file-scope import of a heavy SDK, or enough new exports here, puts it back.
//   Load heavy dependencies inside the handler that uses them, and prefer the
//   one-API package over a bundle. lib/runtimeOptions.ts has the same warning
//   next to the same graph.
// maxInstances 20: nothing capped instances before, so a runaway trigger loop
//   or a traffic spike could scale to Cloud Run's default of 100 and bill
//   unbounded. 20 instances at 0.25 vCPU bounds one runaway function to 5 vCPU.
setGlobalOptions({ cpu: 0.25, memory: '256MiB', maxInstances: 20 });

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
// #399 item 2. Sits beside the cancellation ask because it is the same kind of
// thing: a proposal recorded on the visit, ruled on by the office. The visit
// itself is still only ever moved by an admin callable.
export { requestBookingReschedule } from './portal/requestBookingReschedule';
export { getServiceCatalog } from './portal/getServiceCatalog';
export { getVetClinics } from './portal/getVetClinics';
export { getBreeds } from './portal/getBreeds';
export { submitVetClinic } from './portal/submitVetClinic';
export { getMyVisits } from './portal/getMyVisits';
export { getBusinessContact } from './portal/getBusinessContact';
export { getBusinessClosures } from './portal/getBusinessClosures';
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
// Card management for the portal's Billing Details card (#399 item 3). Sits
// beside payInvoice because it owns the other half of the household's Stripe
// relationship: payInvoice charges a card, these four put one on file, read it
// back, and take it off again.
export {
  getMyPaymentMethod,
  createBillingSetupSession,
  syncMyPaymentMethod,
  removeMyPaymentMethod,
} from './portal/billing';
export { redeemCredit } from './portal/redeemCredit';
export { addKin, updateKin, archiveKin } from './portal/kinWrites';
export { setActiveTribe } from './portal/setActiveTribe';
export { signKinPhotoUpload, confirmKinPhotoUpload } from './portal/signKinPhotoUpload';
export { addSecondaryContact } from './portal/addSecondaryContact';
export { getMyKinTaleMedia } from './portal/getMyKinTaleMedia';
// #399 item 1: the whole household's photo archive, for the Tribe hub gallery.
// getMyKinTaleMedia resolves ONE tale the caller already has the id of; this
// answers "all of it", which nothing could before.
export { getMyKinPhotos } from './portal/getMyKinPhotos';
export { registerFcmToken, unregisterFcmToken } from './portal/registerFcmToken';
export { addKinTaleComment, getKinTaleReaction, toggleKinTaleLove } from './portal/kinTaleEngagement';
export { getKinTaleComments } from './portal/getKinTaleComments';
export { markNotificationRead, markNotificationUnread } from './portal/markNotificationRead';
export { bulkMarkNotificationsRead } from './portal/bulkMarkNotificationsRead';
export {
  archiveNotification,
  bulkArchiveNotifications,
  unarchiveNotification,
  bulkUnarchiveNotifications,
} from './portal/archiveNotification';
export { addBookingNote } from './portal/addBookingNote';
export { submitRating } from './portal/submitRating';

// admin-callables
export { provisionTribe } from './admin/provisionTribe';
export { mintInvite } from './admin/mintInvite';
export { inviteKinfolkToPortal } from './admin/inviteKinfolkToPortal';
export { revokeInvite } from './admin/revokeInvite';
// B1: the READ side of the invite surface. mintInvite / revokeInvite /
// inviteKinfolkToPortal all wrote `inviteRequests` and expireStaleInvites swept
// it nightly, but nothing could ever read it back, so an operator could send an
// invite and never learn what became of it. See listInvites.ts for why it is a
// callable rather than a client query (the tribeId+createdAt composite index
// does not exist) and why it reconciles expiry at read time (the sweep is
// nightly, so a lapsed invite reads live for up to a day).
export { listInvites } from './admin/listInvites';
// The admin-WIDE half of the same read. `listInvites` is scoped to one
// household, so "who never accepted" meant opening every household by hand and
// comparing four lists. Same projection and the same expiry reconciliation (it
// imports both), plus the household name a row needs to be readable out of its
// household's context.
export { listAllInvites } from './admin/listAllInvites';
export { setMemberPermissions } from './admin/setMemberPermissions';
export { removeMember } from './admin/removeMember';
export { setTribePin } from './admin/setTribePin';
export { approveTribePinChange } from './admin/approveTribePinChange';
export { setBrandTokens } from './admin/setBrandTokens';
export { executePrimaryRecovery } from './admin/executePrimaryRecovery';
// The addresses `executePrimaryRecovery` will accept for a household, so the
// recovery dialog can offer them as a choice instead of a free-text box.
// Eligibility turns on the Auth account's `emailVerified`, which no client can
// read for anybody but itself, so it has to be a callable.
export { listRecoveryCandidates } from './admin/listRecoveryCandidates';
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
// Auto-apply: the on-demand half of "apply any Unapplied amount to future
// invoices". The trigger below is the automatic half; this is the same pass
// for an operator whose invoice was already sent when she ticked the box.
export { runAutoApply } from './admin/runAutoApply';
export { archiveInvoice } from './admin/archiveInvoice';
export { unarchiveInvoice } from './admin/unarchiveInvoice';
// Detection + repair for invoices wrecked by the pre-2026-07-25 partial-payment
// write. `detect` mode reports and writes nothing; see the file header.
export { repairInvoicePayments } from './admin/repairInvoicePayments';
// Task 5.1 (#18): the read half of turning completed visits into an invoice.
export { listUninvoicedSessions } from './admin/listUninvoicedSessions';
// A1: the read half of an invoice's money. `invoices/{id}/payments` is the
// settlement authority and `firestore.rules` grants no client any access to it,
// so this callable is the only way a detail screen can show what was paid.
export { getInvoiceLedger } from './admin/getInvoiceLedger';
// The staff payment browser's read. `getInvoiceLedger` above answers "what was
// paid against THIS invoice"; this answers "what has been paid, across
// households", which that callable refuses to degenerate into. Cursored by
// document id, and it reports its own truncation.
export { listPayments } from './admin/listPayments';
// Settings > Integrations. The one source both clients render for Stripe,
// Twilio, SMTP2GO, Cloudinary, Mapbox, Google Calendar and Sentry. It binds
// every secret it reports on (that binding is why its answer is trustworthy;
// see its header) and it returns no secret value under any key.
export { getIntegrationsHealth } from './admin/getIntegrationsHealth';
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
// The office's end of the kinfolk reschedule ask (#399 item 2): the queue, and
// the accept/decline that either moves the visit or explains why not. Sits here
// because accepting writes the same kin_care_sessions row rescheduleBooking
// does, plus the kinCares doc the portal reads, which that callable never did.
export { listRescheduleRequests, resolveBookingRescheduleRequest } from './admin/rescheduleRequests';
// A3: the four operator status transitions on a flat kin_care_sessions row.
// Sits beside rescheduleBooking because it owns the other half of the writes to
// that document; both replaced a direct client patch.
export { transitionBookingStatus } from './admin/transitionBookingStatus';
// Punchlist B4: the write half of the shared vet catalog. `submitVetClinic`
// (portal, create) had no update or delete counterpart on the server, so both
// Kotlin trees wrote `vet_clinics` directly and the React admin could not edit a
// clinic at all. These two replace those direct writes; `updateVetClinic` also
// fans the correction out to the households holding a denormalized copy.
export { updateVetClinic } from './admin/updateVetClinic';
export { archiveVetClinic } from './admin/archiveVetClinic';
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
export { markAllThreadsRead } from './admin/markAllThreadsRead';
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
// B2: the "Needs triage" read side. Web has no Firestore path to this list
// that stays correct as the collection grows past KINTALES_QUERY's 200-row
// cap; see listOrphanReports.ts for why a dedicated callable, not a filter.
export { listOrphanReports } from './admin/listOrphanReports';
export { verifyActivityLogChain } from './admin/verifyActivityLogChain';
export { setFeatureFlags } from './admin/setFeatureFlags';
// Replaces the PUBLIC get-token endpoint on the Twilio Serverless service, which
// let anyone who knew the URL mint a token and answer the business's calls.
export { mintVoiceAccessToken } from './admin/mintVoiceAccessToken';
// Accept/reject for a screened inbound call. Replaces an unauthenticated GET
// that returned plain text to a caller parsing JSON, so every success read as
// a network error.
export { screenCallAction } from './admin/screenCallAction';
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
// #396: the read path for the delivery pipeline. `notificationDispatch` and its
// per-channel subdocs had no reader anywhere until this callable.
export { listNotificationDeliveries } from './admin/listNotificationDeliveries';

// HTTPS
export { getShareLink } from './share/getShareLink';
export { getSharedKinTalePage } from './share/getSharedKinTalePage';
export { stripeWebhook } from './billing/stripeWebhook';
// WARNING-8: Twilio-signature-verified inbound comms webhooks. Server-authoritative
// writes of calls_log / voicemails / sms_messages (replaces the spoofable
// client-from-FCM-push writer). Inert until the operator points Twilio at them.
export { twilioInboundSms, twilioInboundVoicemail, twilioInboundCall } from './twilio/twilioInbound';
// The business phone line itself, as TwiML. Replaces the Twilio Studio Flow that
// had been routing every caller to the after-hours greeting at every hour.
// Inert until the operator points the number's Voice webhook at it.
export { twilioVoice } from './twilio/twilioVoice';
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
// A SECOND trigger on the same collection, deliberately: onInvoicesWrite
// decides who to tell about a state change and writes nothing, this one moves
// a household's unapplied credit onto a bill that has just become collectable.
export { onInvoiceAutoApply } from './triggers/onInvoiceAutoApply';
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
