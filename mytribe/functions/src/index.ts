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
// cpu 1: the fleet default, restored 2026-08-18 under ADR-0004 decision 2
//   (docs/adr/0004-functions-runtime-shape.md). That ADR sequenced the flip
//   behind the lazy-import work and behind a remeasurement of the module graph;
//   the lazy-import work landed on 2026-08-04 and the remeasurement is in the
//   PR for issue #395, which is this change.
//
//   IT WAS 0.25 FROM 2026-08-01, FOR A REASON THAT WAS NOT TRUE. The setting
//   was chosen because 240 Cloud Run services at 1 vCPU appeared to sit above
//   the 200 vCPU `CpuAllocPerProjectRegion` ceiling for us-central1, and that
//   appeared to be what broke five consecutive full deploys. Both halves were
//   wrong, and docs/RUNBOOK.md has said so since 2026-08-03:
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
//   WHAT 0.25 COST, AND WHY IT IS WORTH A COMMENT THIS LONG. Below a full vCPU
//   Cloud Run refuses concurrency above 1, and firebase-tools enforces that for
//   us (`resolveCpuAndConcurrency`: `concurrency = cpu >= 1 ? 80 : 1`). So the
//   choice was never a dial, it was two regimes: at 0.25 every concurrent
//   request started its own container, and every one of those containers loaded
//   the whole of this file before it could serve anything.
//
//   Issue #395 is what that looked like from a browser. The 2026-08-17 walk
//   captured markInvoicePaid at 10,324 ms, recordPayment at 9,047 ms,
//   listTemplateBindings at 8,936 ms, getInvoiceLedger at 8,740 ms, and
//   transitionBookingStatus at 7,942 ms followed by 703 ms for the same
//   callable seconds later. Not one of those five carried a cpu override, so
//   all five ran at the 0.25 set on this line, and the 7,942/703 pair is a cold
//   start rather than a slow query.
//
//   Quartering the CPU does not quarter the cost of an import. It quadruples
//   the wall clock and bills the same vCPU-seconds, because a fixed amount of
//   CPU work costs a fixed number of CPU-seconds however thinly it is sliced.
//   0.25 vCPU is cheaper only for the part of a request that waits on
//   Firestore; on the part that computes it converts CPU into latency at no
//   saving. Measured for #395 on the built lib/, node v24.14.0, three runs:
//
//     require('lib/index.js')   1,873 modules, 13.4 MiB of JavaScript parsed,
//                               0.80-1.02 s of CPU warm (1.45 s on the first
//                               run of a session), 191-196 MiB RSS
//
//   At 0.25 vCPU a 1.45 s import is roughly 5.8 s of wall clock before the
//   handler is entered. Add node's own bootstrap and the container start and it
//   accounts for the 7.2 s between that 7,942 ms call and the 703 ms one. At
//   cpu 1 the same import is ~1.45 s, and 80-way concurrency means a warm
//   instance absorbs the rest of a burst instead of cold-starting per request.
//
//   WHAT cpu 1 COSTS: well under a dollar a month, and ADR-0004 does the
//   arithmetic. The 13 `minInstances: 1` functions are ~98% of the compute bill
//   and they already run at cpu 1 (ADR-0004 counted twelve; `twilioVoice` has
//   joined them since), so this flip only touches request-driven time on the 192
//   functions with no override, at 1,850 to 7,000 requests a day. It does not
//   raise the standing minimum, so it does not put `--force` on the operator's
//   next deploy.
//
//   WHAT cpu 1 COSTS AT THE CPU QUOTA, since this project has a history with it
//   and the answer is "nothing at rest". `CpuAllocPerProjectRegion` meters
//   RUNNING INSTANCES. A deployed service with no instance up holds no standing
//   draw, so raising the default costs nothing at rest. A deploy is not quite
//   free: each new revision starts one container to pass its startup probe, so
//   there is a brief transient of one instance per function being deployed. It
//   is bounded by the batch size that the 60/min mutation rate limit already
//   forces, which is tens of vCPU for seconds rather than the 232 below.
//   Counted from
//   source on 2026-08-18: 235 endpoints are exported from this file, of which
//   192 inherit the option below, 27 carry FULL_CPU (cpu 1, maxInstances 10),
//   12 carry FULL_CPU_SERIAL (cpu 1, maxInstances 2) and 4 carry SERIAL
//   (cpu 0.25, maxInstances 2). All 13 functions holding `minInstances: 1`
//   already carried cpu 1, so the standing draw is 13 vCPU before this change
//   and 13 vCPU after it.
//
//   Two hypotheticals bound the transient. One live instance of every function
//   at once goes from 88 vCPU to 232, and every function saturating its
//   maxInstances goes from 1,256 to 4,136. The second was never a bound at
//   either setting, which is ADR-0004's point that maxInstances caps one
//   runaway function rather than the fleet. The first is the number to watch if
//   the regional limit is ever back at 200; it was raised to 400 on 2026-08-03
//   and the console read 16 vCPU in use, so confirm the live limit before a
//   deploy rather than trusting this comment.
//
//   Concurrency pushes the other way and is measured, not assumed. Per function,
//   N concurrent requests draw min(N, 20) x 0.25 at concurrency 1 and
//   ceil(N/80) x 1 at concurrency 80. The crossover is four. ADR-0004 caught
//   getInvoiceLedger at eleven concurrent instances in a 10-second bucket, which
//   is 2.75 vCPU under the old shape and 1 vCPU under this one, so the busiest
//   function in the logs draws LESS after this change, not more.
//
//   WHAT cpu 1 TRADES AWAY: concurrency 1 was an accidental guarantee that no
//   two requests ever shared process state. At concurrency 80 a module-scope
//   mutable holding per-request or per-tenant data stops being a style question
//   and becomes a cross-tenant data leak. Audited for ADR-0004 and re-checked
//   for #395: every module-scope `let` in `src/` is an idempotent lazy client
//   singleton (lib/twilio.ts, lib/stripe.ts, lib/aiCopy.ts, lib/firestoreAdmin.ts,
//   lib/sentry.ts, public/addGuestKinTaleComment.ts) and every module-scope
//   collection is a frozen constant. Keep it that way.
//
//   Functions that need a different shape carry an explicit override at their
//   own definition; see lib/runtimeOptions.ts. `SERIAL` now pins 0.25 back for
//   the four nightly sweep crons, which wait on Firestore rather than compute
//   and have nobody watching them.
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
// maxInstances 20: the runaway-billing cap. Nothing capped instances before, so
//   a runaway trigger loop or a traffic spike could scale to Cloud Run's default
//   of 100 and bill unbounded. At cpu 1 that ceiling bounds one runaway function
//   to 20 vCPU rather than the 5 it bounded at 0.25, and the same twenty
//   instances now serve up to 1,600 concurrent requests rather than 20. The
//   crossover is four concurrent requests per function, and getInvoiceLedger has
//   already been observed at eleven; see ADR-0004.
setGlobalOptions({ cpu: 1, memory: '256MiB', maxInstances: 20 });

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
// Time-block booking (operator requirement 2026-08-24): the narrow projection
// of `business_settings` a booking wizard needs to offer NAMED windows instead
// of a clock. Sits beside getBusinessClosures because it is the same seam onto
// the same admin-only document.
export { getBookingPolicy } from './portal/getBookingPolicy';
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
export { acceptQuote, denyQuote } from './portal/quoteDecision';
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
// Sends a DECLINED quote back out once the office has revised it (issue #448).
// The decline is a step in a conversation, not a dead end; this is the step
// that answers it.
export { resendQuote } from './admin/resendQuote';
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
// #408: the other thing an operator can do with un-invoiced work, which is
// decide never to bill it. Reversible, so the queue above stays a queue rather
// than an accumulation nobody can trust a count from.
export { setSessionDoNotInvoice } from './admin/setSessionDoNotInvoice';
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
export { importSeedTemplates } from './admin/importSeedTemplates';
export { deleteTemplate } from './admin/deleteTemplate';
export { assignTemplate } from './admin/assignTemplate';
export { assignTemplatesToCategory } from './admin/assignTemplatesToCategory';
export { unassignTemplate } from './admin/unassignTemplate';
export { createMultiDateBookingRequest } from './admin/createMultiDateBookingRequest';
export { listTemplates, listTemplateBindings } from './admin/listTemplates';
export { listCategories } from './admin/listCategories';
export { listCatalogKeys } from './admin/listCatalogKeys';
export { createBlockedTimeSlot } from './admin/createBlockedTimeSlot';
export { deleteBlockedTimeSlot } from './admin/deleteBlockedTimeSlot';
export { assignAuntie } from './admin/assignAuntie';
export { listStaff } from './admin/listStaff';
export {
  provisionBusinessAdmins,
  setBusinessAdmins,
  removeBusinessAdmins,
  checkBusinessAdmins,
  listBusinessAdmins,
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
// The office's end of the kinfolk cancellation ask (#438), the other half of
// the same queue. The ask has been written to the visit since July with no
// admin surface reading it; these two are that surface. Accepting cancels the
// kinCares doc AND the flat kin_care_sessions row, for the same reason the
// reschedule pair above writes both.
export { listCancelRequests, resolveBookingCancellationRequest } from './admin/cancelRequests';
export { listPendingBookingRequests } from './admin/pendingBookingRequests';
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
export { saveMediaTags } from './admin/saveMediaTags';
export { deleteMediaFile } from './admin/deleteMediaFile';
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
export { onBookingEnvelopeCreate } from './triggers/onBookingEnvelopeCreate';
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
// #593: strips location metadata from every uploaded video, asynchronously.
export { onMediaFileVideoStrip } from './triggers/onMediaFileVideoStrip';

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
// ISSUE #519: the two retention windows the settings screen has claimed for as
// long as the fields existed, now actually applied. Both delete records, so both
// refuse to run on an unreadable, zero or negative window (`lib/retentionWindow.ts`).
export { purgeOldVisitRoutes } from './scheduled/purgeOldVisitRoutes';
export { purgeOldDrafts } from './scheduled/purgeOldDrafts';
export { scheduleDigestCron } from './scheduled/scheduleDigestCron';
// #593: retry / catch-up for the asynchronous video location strip.
export { videoGpsStripSweep } from './scheduled/videoGpsStripSweep';
