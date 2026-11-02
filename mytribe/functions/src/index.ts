import { setGlobalOptions } from 'firebase-functions/v2';

// This call MUST stay the first executable statement in this file, above the
// loop at the bottom that loads the functions (it was above every
// `export ... from` until #1337). `setGlobalOptions` only reaches functions
// defined AFTER it runs, and `onCall` / `onSchedule` / `onDocument*` all run at
// module-import time. This file still emits CommonJS: tsconfig.json is
// `"module": "nodenext"` as of 2026-08-07, and with no `"type": "module"` in
// package.json that means tsc emits each import as a CommonJS require at its own
// source position, so source order is execution order here. Verified against the
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
//   wrong, and docs/runbooks/release-internals.md has said so since 2026-08-03:
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
//   The Functions runtime loaded all of `index.js` on every cold start whatever
//   the target was (see lib/runtimeOptions.ts, which measures the same graph at
//   ~1.44s of CPU; #1337 ended that, see FUNCTIONS below). So the import cost
//   was the WHOLE codebase's, not the called function's, and it grew with every
//   export added here. It is still the peak for discovery, the emulator and
//   getIntegrationsHealth, which load every function. On 2026-08-03 it
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

/* eslint-disable @typescript-eslint/no-require-imports -- the lazy loaders below are the point of this file; see FUNCTIONS. */

/** Loads the module that defines one deployed function. */
type FunctionModuleLoader = () => Record<string, unknown>;

/**
 * Every deployed function, by its export name, with a loader for the module
 * that defines it. THIS IS THE EXPORT LIST: adding a function means adding a
 * line here in the same arrow-and-require shape as every other entry, naming
 * the module that exports a function under that same name.
 *
 * WHY LOADERS AND NOT `export { name } from './module'` (#1337). A re-export
 * compiles to an eager `require` at file scope, so every cold start of every
 * function loaded all of them: 296 exports, ~1,900 modules, ~0.5 s of CPU and
 * ~197 MiB of RSS against a 256MiB limit, before the one function the instance
 * was started for could serve anything. A Cloud Functions instance only ever
 * serves one export, and the runtime names it in FUNCTION_TARGET, so the block
 * at the bottom of this file loads that one module and nothing else.
 *
 * Every specifier stays a STRING LITERAL inside the require call. Two readers
 * depend on that: tsc, which emits it unchanged, and scripts/function-targets.js,
 * which builds the release's module graph from the literal requires in lib/ and
 * deploys the whole fleet whenever it meets a computed one. A table of paths
 * handed to one shared require of a variable would work at run time and
 * quietly turn every release into a full deploy. (Since #1390 that scan
 * judges only calls in code, so a comment here that mentions a require no
 * longer forces a full deploy. A literal specifier inside a comment still
 * joins the graph, which can only widen a release.)
 *
 * Read statically by scripts/runtimeOptions/extractSource.ts (the runtime
 * options drift tool), test/auntieAccess.test.ts and
 * test/coldStartImportGraph.test.ts, so keep each entry to that one shape.
 * test/functionTargetLoading.test.ts pins the set of names.
 */
const FUNCTIONS: Record<string, FunctionModuleLoader> = {
  // Sentry is lazy-initialised by each handler at first invocation. Eager
  // init at module-load logged a spurious "SENTRY_DSN unset" on cold-start
  // of any Function whose `secrets:` array didn't include SENTRY_DSN, even
  // though those Functions don't capture to Sentry anyway.
  health: () => require('./health/health'),

  // callables
  acceptInvite: () => require('./membership/acceptInvite'),
  mintInviteFromPrimary: () => require('./membership/mintInviteFromPrimary'),
  updateSecondaryPermissions: () => require('./membership/updateSecondaryPermissions'),
  listMembers: () => require('./portal/listMembers'),
  updateMemberLabel: () => require('./membership/updateMemberLabel'),
  setKinfolkOverrides: () => require('./theme/setKinfolkOverrides'),
  swapPrimaryContact: () => require('./recovery/swapPrimaryContact'),
  signOutAllDevices: () => require('./auth/signOutAllDevices'),
  requestPasswordReset: () => require('./auth/requestPasswordReset'),
  onPasswordResetRequestCreate: () => require('./auth/requestPasswordReset'),
  recordFailedLogin: () => require('./auth/loginSecurity'),
  beforeSignIn: () => require('./auth/loginSecurity'),
  unlockKinfolkAccount: () => require('./auth/loginSecurity'),
  createShareLink: () => require('./share/createShareLink'),
  revokeShareLink: () => require('./share/revokeShareLink'),
  requestPrimaryRecovery: () => require('./recovery/requestPrimaryRecovery'),

  // portal-callables (kinfolk-facing read translation layer)
  getMyHome: () => require('./portal/getMyHome'),
  getMyAccess: () => require('./portal/getMyAccess'),
  getMyInvoices: () => require('./portal/getMyInvoices'),
  getMyKin: () => require('./portal/getMyKin'),
  getMyKinTales: () => require('./portal/getMyKinTales'),
  getMyBookings: () => require('./portal/getMyBookings'),
  requestBooking: () => require('./portal/requestBooking'),
  requestBookingCancellation: () => require('./portal/requestBookingCancellation'),
  // #399 item 2. Sits beside the cancellation ask because it is the same kind of
  // thing: a proposal recorded on the visit, ruled on by the office. The visit
  // itself is still only ever moved by an admin callable.
  requestBookingReschedule: () => require('./portal/requestBookingReschedule'),
  getServiceCatalog: () => require('./portal/getServiceCatalog'),
  getVetClinics: () => require('./portal/getVetClinics'),
  getBreeds: () => require('./portal/getBreeds'),
  submitVetClinic: () => require('./portal/submitVetClinic'),
  getMyVisits: () => require('./portal/getMyVisits'),
  getBusinessContact: () => require('./portal/getBusinessContact'),
  getBusinessClosures: () => require('./portal/getBusinessClosures'),
  // Time-block booking (operator requirement 2026-08-24): the narrow projection
  // of `business_settings` a booking wizard needs to offer NAMED windows instead
  // of a clock. Sits beside getBusinessClosures because it is the same seam onto
  // the same admin-only document.
  getBookingPolicy: () => require('./portal/getBookingPolicy'),
  getFeatureFlags: () => require('./portal/getFeatureFlags'),
  getInvitePreview: () => require('./portal/getInvitePreview'),
  claimInviteSignup: () => require('./membership/claimInviteSignup'),
  signKinfolkAvatar: () => require('./portal/signKinfolkAvatar'),
  dismissBanner: () => require('./portal/dismissBanner'),
  mapboxSearch: () => require('./portal/mapboxSearch'),
  mapboxRetrieve: () => require('./portal/mapboxSearch'),
  getFormSchema: () => require('./portal/getFormSchema'),
  getMyTribeProfile: () => require('./portal/getMyTribeProfile'),
  saveTribeProfile: () => require('./portal/saveTribeProfile'),
  saveHomeAccess: () => require('./portal/saveHomeAccess'),
  getMyNotificationPrefs: () => require('./portal/notificationPrefs'),
  saveMyNotificationPrefs: () => require('./portal/notificationPrefs'),
  getMyAccount: () => require('./portal/account'),
  saveMyAccount: () => require('./portal/account'),
  payInvoice: () => require('./portal/payInvoice'),
  // Card management for the portal's Billing Details card (#399 item 3). Sits
  // beside payInvoice because it owns the other half of the household's Stripe
  // relationship: payInvoice charges a card, these four put one on file, read it
  // back, and take it off again.
  getMyPaymentMethod: () => require('./portal/billing'),
  createBillingSetupSession: () => require('./portal/billing'),
  syncMyPaymentMethod: () => require('./portal/billing'),
  removeMyPaymentMethod: () => require('./portal/billing'),
  redeemCredit: () => require('./portal/redeemCredit'),
  getAccountCreditHistory: () => require('./portal/getAccountCreditHistory'),
  acceptQuote: () => require('./portal/quoteDecision'),
  denyQuote: () => require('./portal/quoteDecision'),
  addKin: () => require('./portal/kinWrites'),
  updateKin: () => require('./portal/kinWrites'),
  archiveKin: () => require('./portal/kinWrites'),
  setActiveTribe: () => require('./portal/setActiveTribe'),
  signKinPhotoUpload: () => require('./portal/signKinPhotoUpload'),
  confirmKinPhotoUpload: () => require('./portal/signKinPhotoUpload'),
  addSecondaryContact: () => require('./portal/addSecondaryContact'),
  // 2026-09-27 Q3: a secondary kinfolk added with no invite and no portal access.
  listSecondaryKinfolk: () => require('./portal/secondaryKinfolk'),
  saveSecondaryKinfolk: () => require('./portal/secondaryKinfolk'),
  removeSecondaryKinfolk: () => require('./portal/secondaryKinfolk'),
  // #829 section 1: the one store and the one write path for Emergency Contacts,
  // used by all five clients. Gated on home_access.
  saveEmergencyContacts: () => require('./portal/emergencyContacts'),
  listEmergencyContacts: () => require('./portal/emergencyContacts'),
  // #890: the one admin create path for a household. Hands back the household the
  // same operator added in the last 10 minutes with the same phone or email
  // (`duplicateOf`) instead of creating a second one.
  createKinfolk: () => require('./admin/createKinfolk'),
  getMyKinTaleMedia: () => require('./portal/getMyKinTaleMedia'),
  // #399 item 1: the whole household's photo archive, for the Tribe hub gallery.
  // getMyKinTaleMedia resolves ONE tale the caller already has the id of; this
  // answers "all of it", which nothing could before.
  getMyKinPhotos: () => require('./portal/getMyKinPhotos'),
  registerFcmToken: () => require('./portal/registerFcmToken'),
  unregisterFcmToken: () => require('./portal/registerFcmToken'),
  addKinTaleComment: () => require('./portal/kinTaleEngagement'),
  getKinTaleReaction: () => require('./portal/kinTaleEngagement'),
  toggleKinTaleLove: () => require('./portal/kinTaleEngagement'),
  getKinTaleComments: () => require('./portal/getKinTaleComments'),
  markNotificationRead: () => require('./portal/markNotificationRead'),
  markNotificationUnread: () => require('./portal/markNotificationRead'),
  bulkMarkNotificationsRead: () => require('./portal/bulkMarkNotificationsRead'),
  archiveNotification: () => require('./portal/archiveNotification'),
  bulkArchiveNotifications: () => require('./portal/archiveNotification'),
  unarchiveNotification: () => require('./portal/archiveNotification'),
  bulkUnarchiveNotifications: () => require('./portal/archiveNotification'),
  addBookingNote: () => require('./portal/addBookingNote'),
  getBookingNotes: () => require('./portal/getBookingNotes'),
  submitRating: () => require('./portal/submitRating'),

  // admin-callables
  provisionTribe: () => require('./admin/provisionTribe'),
  mintInvite: () => require('./admin/mintInvite'),
  inviteKinfolkToPortal: () => require('./admin/inviteKinfolkToPortal'),
  revokeInvite: () => require('./admin/revokeInvite'),
  // B1: the READ side of the invite surface. mintInvite / revokeInvite /
  // inviteKinfolkToPortal all wrote `inviteRequests` and expireStaleInvites swept
  // it nightly, but nothing could ever read it back, so an operator could send an
  // invite and never learn what became of it. See listInvites.ts for why it is a
  // callable rather than a client query (the tribeId+createdAt composite index
  // does not exist) and why it reconciles expiry at read time (the sweep is
  // nightly, so a lapsed invite reads live for up to a day).
  listInvites: () => require('./admin/listInvites'),
  // The admin-WIDE half of the same read. `listInvites` is scoped to one
  // household, so "who never accepted" meant opening every household by hand and
  // comparing four lists. Same projection and the same expiry reconciliation (it
  // imports both), plus the household name a row needs to be readable out of its
  // household's context.
  listAllInvites: () => require('./admin/listAllInvites'),
  // ONE invite by id, for the admin's invite detail screen (#1339): the
  // `invite.auntie-notify` email links to `/invites/<inviteId>`, and a page of
  // listAllInvites cannot promise to contain the row.
  getInvite: () => require('./admin/getInvite'),
  setMemberPermissions: () => require('./admin/setMemberPermissions'),
  removeMember: () => require('./admin/removeMember'),
  setTribePin: () => require('./admin/setTribePin'),
  approveTribePinChange: () => require('./admin/approveTribePinChange'),
  setBrandTokens: () => require('./admin/setBrandTokens'),
  executePrimaryRecovery: () => require('./admin/executePrimaryRecovery'),
  // The addresses `executePrimaryRecovery` will accept for a household, so the
  // recovery dialog can offer them as a choice instead of a free-text box.
  // Eligibility turns on the Auth account's `emailVerified`, which no client can
  // read for anybody but itself, so it has to be a callable.
  listRecoveryCandidates: () => require('./admin/listRecoveryCandidates'),
  postInvoiceEvent: () => require('./admin/postInvoiceEvent'),
  createInvoice: () => require('./admin/createInvoice'),
  createQuote: () => require('./admin/createQuote'),
  // Sends a DECLINED quote back out once the office has revised it (issue #448).
  // The decline is a step in a conversation, not a dead end; this is the step
  // that answers it.
  resendQuote: () => require('./admin/resendQuote'),
  sendInvoiceReminder: () => require('./admin/sendInvoiceReminder'),
  generateReceipt: () => require('./admin/generateReceipt'),
  markInvoicePaid: () => require('./admin/markInvoicePaid'),
  reviewAndSendDraftInvoice: () => require('./admin/reviewAndSendDraftInvoice'),
  updateInvoice: () => require('./admin/updateInvoice'),
  // W2-1 (ADR-0002 callable-only invoice writes): the callables that absorb
  // Android's four remaining direct Firestore money writes. Additive; nothing
  // calls them until Android re-points (W2-2), and rules are revoked after that.
  linkInvoiceSessions: () => require('./admin/linkInvoiceSessions'),
  recordPayment: () => require('./admin/recordPayment'),
  // Auto-apply: the on-demand half of "apply any Unapplied amount to future
  // invoices". The trigger below is the automatic half; this is the same pass
  // for an operator whose invoice was already sent when she ticked the box.
  runAutoApply: () => require('./admin/runAutoApply'),
  giveAccountCredit: () => require('./admin/giveAccountCredit'),
  // #1003: the admin decides what an unapplied card payment becomes.
  listUnappliedPayments: () => require('./admin/listUnappliedPayments'),
  resolveUnappliedPayment: () => require('./admin/resolveUnappliedPayment'),
  archiveInvoice: () => require('./admin/archiveInvoice'),
  unarchiveInvoice: () => require('./admin/unarchiveInvoice'),
  retryInvoiceCheckoutClose: () => require('./admin/retryInvoiceCheckoutClose'),
  // Detection + repair for invoices wrecked by the pre-2026-07-25 partial-payment
  // write. `detect` mode reports and writes nothing; see the file header.
  repairInvoicePayments: () => require('./admin/repairInvoicePayments'),
  // Task 5.1 (#18): the read half of turning completed visits into an invoice.
  listUninvoicedSessions: () => require('./admin/listUninvoicedSessions'),
  // #408: the other thing an operator can do with un-invoiced work, which is
  // decide never to bill it. Reversible, so the queue above stays a queue rather
  // than an accumulation nobody can trust a count from.
  setSessionDoNotInvoice: () => require('./admin/setSessionDoNotInvoice'),
  // A1: the read half of an invoice's money. `invoices/{id}/payments` is the
  // settlement authority and `firestore.rules` grants no client any access to it,
  // so this callable is the only way a detail screen can show what was paid.
  getInvoiceLedger: () => require('./admin/getInvoiceLedger'),
  // The staff payment browser's read. `getInvoiceLedger` above answers "what was
  // paid against THIS invoice"; this answers "what has been paid, across
  // households", which that callable refuses to degenerate into. Cursored by
  // document id, and it reports its own truncation.
  listPayments: () => require('./admin/listPayments'),
  // Settings > Integrations. The one source both clients render for Stripe,
  // Twilio, SMTP2GO, Cloudinary, Mapbox, Google Calendar and Sentry. It binds
  // every secret it reports on (that binding is why its answer is trustworthy;
  // see its header) and it returns no secret value under any key.
  getIntegrationsHealth: () => require('./admin/getIntegrationsHealth'),
  setKinfolkClaim: () => require('./admin/setKinfolkClaim'),
  revokeKinfolkClaim: () => require('./admin/revokeKinfolkClaim'),
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
  confirmBrandAssetUpload: () => require('./admin/confirmBrandAssetUpload'),
  dispatchVisitNotification: () => require('./admin/dispatchVisitNotification'),
  scheduleMarketingBlast: () => require('./admin/scheduleMarketingBlast'),
  // The read + cancel half of Marketing blasts. `scheduleMarketingBlast` was
  // deployed with nothing calling it; these three are what a screen needs to be
  // able to exist beside it (preview the audience, list the campaigns, call one
  // back before it fires).
  previewMarketingBlastAudience: () => require('./admin/marketingBlasts'),
  listMarketingBlasts: () => require('./admin/marketingBlasts'),
  cancelMarketingBlast: () => require('./admin/marketingBlasts'),
  addInternalBookingNote: () => require('./admin/addInternalBookingNote'),
  saveTemplate: () => require('./admin/saveTemplate'),
  previewEmailTemplate: () => require('./admin/previewEmailTemplate'),
  getEmailFrame: () => require('./admin/emailFrameSettings'),
  saveEmailFrame: () => require('./admin/emailFrameSettings'),
  previewEmailFrame: () => require('./admin/emailFrameSettings'),
  convertTemplateToVisual: () => require('./admin/convertTemplateToVisual'),
  importSeedTemplates: () => require('./admin/importSeedTemplates'),
  deleteTemplate: () => require('./admin/deleteTemplate'),
  assignTemplate: () => require('./admin/assignTemplate'),
  assignTemplatesToCategory: () => require('./admin/assignTemplatesToCategory'),
  unassignTemplate: () => require('./admin/unassignTemplate'),
  createMultiDateBookingRequest: () => require('./admin/createMultiDateBookingRequest'),
  listTemplates: () => require('./admin/listTemplates'),
  listTemplateBindings: () => require('./admin/listTemplates'),
  listCategories: () => require('./admin/listCategories'),
  listCatalogKeys: () => require('./admin/listCatalogKeys'),
  createBlockedTimeSlot: () => require('./admin/createBlockedTimeSlot'),
  deleteBlockedTimeSlot: () => require('./admin/deleteBlockedTimeSlot'),
  assignAuntie: () => require('./admin/assignAuntie'),
  listStaff: () => require('./admin/listStaff'),
  provisionBusinessAdmins: () => require('./admin/provisionBusinessAdmins'),
  setBusinessAdmins: () => require('./admin/provisionBusinessAdmins'),
  removeBusinessAdmins: () => require('./admin/provisionBusinessAdmins'),
  checkBusinessAdmins: () => require('./admin/provisionBusinessAdmins'),
  listBusinessAdmins: () => require('./admin/provisionBusinessAdmins'),
  getMyAdminNotificationPrefs: () => require('./admin/myAdminNotificationPrefs'),
  saveMyAdminNotificationPrefs: () => require('./admin/myAdminNotificationPrefs'),
  getLocalWeather: () => require('./admin/getLocalWeather'),
  createKinCareSession: () => require('./admin/createKinCareSession'),
  createTrainingDocument: () => require('./admin/createTrainingDocument'),
  updateTrainingDocument: () => require('./admin/updateTrainingDocument'),
  deleteTrainingDocument: () => require('./admin/deleteTrainingDocument'),
  rescheduleBooking: () => require('./admin/rescheduleBooking'),
  // The office's end of the kinfolk reschedule ask (#399 item 2): the queue, and
  // the accept/decline that either moves the visit or explains why not. Sits here
  // because accepting writes the same kin_care_sessions row rescheduleBooking
  // does, plus the kinCares doc the portal reads, which that callable never did.
  listRescheduleRequests: () => require('./admin/rescheduleRequests'),
  resolveBookingRescheduleRequest: () => require('./admin/rescheduleRequests'),
  // The office's end of the kinfolk cancellation ask (#438), the other half of
  // the same queue. The ask has been written to the visit since July with no
  // admin surface reading it; these two are that surface. Accepting cancels the
  // kinCares doc AND the flat kin_care_sessions row, for the same reason the
  // reschedule pair above writes both.
  listCancelRequests: () => require('./admin/cancelRequests'),
  resolveBookingCancellationRequest: () => require('./admin/cancelRequests'),
  listPendingBookingRequests: () => require('./admin/pendingBookingRequests'),
  // A3: the four operator status transitions on a flat kin_care_sessions row.
  // Sits beside rescheduleBooking because it owns the other half of the writes to
  // that document; both replaced a direct client patch.
  transitionBookingStatus: () => require('./admin/transitionBookingStatus'),
  // #397 L19: the last two writes to that same document that had no server owner.
  // `setVisitLifecycle` is the IN-VISIT clock (On my way / Arrived / Departed /
  // Undo arrival) the web admin had no path to at all; `updateKinCareSession` is
  // the descriptive edit (service, notes, duration, Kin roster). Between the four
  // callables now exported from this block, every field on a `kin_care_sessions`
  // row that a client may change has exactly one server-side owner.
  setVisitLifecycle: () => require('./admin/setVisitLifecycle'),
  updateKinCareSession: () => require('./admin/updateKinCareSession'),
  // #582: measures a recorded arrival against the household's stored coordinate
  // and stamps the DISTANCE on the visit. It owns no status, so it sits after the
  // three callables that do: `setVisitLifecycle` records THAT an arrival
  // happened, this one records how far from the household it was recorded, and
  // `transitionBookingStatus` is where that measurement is enforced at COMPLETE.
  verifyVisitArrival: () => require('./admin/verifyVisitArrival'),
  // Punchlist B4: the write half of the shared vet catalog. `submitVetClinic`
  // (portal, create) had no update or delete counterpart on the server, so both
  // Kotlin trees wrote `vet_clinics` directly and the React admin could not edit a
  // clinic at all. These two replace those direct writes; `updateVetClinic` also
  // fans the correction out to the households holding a denormalized copy.
  updateVetClinic: () => require('./admin/updateVetClinic'),
  archiveVetClinic: () => require('./admin/archiveVetClinic'),
  syncGoogleCalendarBusyEvents: () => require('./admin/syncGoogleCalendarBusyEvents'),
  // Task 7.2, editable calendars over OAuth. `googleOAuthCallback` is the HTTP
  // redirect target and is exported with the callables it belongs to rather than
  // down in the HTTPS block, because the flow is meaningless split in two: the
  // callable mints the one-time state the callback redeems. Both halves declare
  // GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET and both read them.
  startGoogleCalendarConnect: () => require('./admin/googleCalendar/googleCalendarConnect'),
  googleOAuthCallback: () => require('./admin/googleCalendar/googleCalendarConnect'),
  getGoogleCalendarConnection: () => require('./admin/googleCalendar/googleCalendarAccount'),
  disconnectGoogleCalendar: () => require('./admin/googleCalendar/googleCalendarAccount'),
  listGoogleCalendars: () => require('./admin/googleCalendar/googleCalendarSelection'),
  setGoogleCalendarTargets: () => require('./admin/googleCalendar/googleCalendarSelection'),
  pushVisitsToGoogleCalendar: () => require('./admin/googleCalendar/pushVisitsToGoogleCalendar'),
  // The per-visit half (issue #397): the retry path for a visit the automatic
  // lifecycle sync could not write, and the manual one for a visit the operator
  // wants on the calendar now. Idempotent, so a second press is safe. The trigger
  // that normally does this without being asked is `onKinCareSessionCalendarSync`,
  // in the triggers block below.
  syncVisitToGoogleCalendar: () => require('./admin/googleCalendar/syncVisitToGoogleCalendar'),
  sendExternalMessage: () => require('./admin/sendExternalMessage'),
  suppressExternalRecipient: () => require('./admin/sendExternalMessage'),
  listMessageSuppressions: () => require('./admin/messageSuppressions'),
  clearMessageSuppression: () => require('./admin/messageSuppressions'),
  smtp2goEventWebhook: () => require('./admin/engagementWebhooks'),
  twilioStatusCallback: () => require('./admin/engagementWebhooks'),
  listRecentSends: () => require('./admin/listRecentSends'),
  saveAudienceSegment: () => require('./admin/audienceSegments'),
  listAudienceSegments: () => require('./admin/audienceSegments'),
  deleteAudienceSegment: () => require('./admin/audienceSegments'),
  broadcastMessage: () => require('./admin/broadcastMessage'),
  // #823. Watching and stopping a broadcast whose fan-out outlived its callable.
  getBroadcastProgress: () => require('./admin/broadcastProgress'),
  stopBroadcast: () => require('./admin/broadcastProgress'),
  listConversations: () => require('./admin/conversations'),
  getConversationThread: () => require('./admin/conversations'),
  replyToConversation: () => require('./admin/conversations'),
  markConversationRead: () => require('./admin/conversations'),
  markAllThreadsRead: () => require('./admin/markAllThreadsRead'),
  sendKinfolkMessage: () => require('./portal/sendKinfolkMessage'),
  getMyConversation: () => require('./portal/sendKinfolkMessage'),
  markThreadRead: () => require('./portal/sendKinfolkMessage'),
  generate: () => require('./portal/generate'),
  generateInvoicePdf: () => require('./admin/generateInvoicePdf'),
  getMyInvoicePdf: () => require('./portal/getMyInvoicePdf'),
  setMediaProfilePhoto: () => require('./admin/setMediaProfilePhoto'),
  saveMediaTags: () => require('./admin/saveMediaTags'),
  removeBusinessTag: () => require('./admin/removeBusinessTag'),
  deleteMediaFile: () => require('./admin/deleteMediaFile'),
  manageBookingSeries: () => require('./admin/manageBookingSeries'),
  batchUpdateBookings: () => require('./admin/batchUpdateBookings'),
  aiBackfillTaleTitles: () => require('./admin/aiBackfillTaleTitles'),
  saveFormSchema: () => require('./admin/saveFormSchema'),
  // LEGACY/ARCHIVED, see src/admin/ingestKinTale.ts header. Kept deployed in
  // reserved state per operator direction 2026-05-19; superseded by canonical
  // `kin_care_reports` writes. Re-add to active rotation only if backfill needs.
  ingestKinTale: () => require('./admin/ingestKinTale'),
  listFormSchemas: () => require('./admin/listFormSchemas'),
  deleteFormSchema: () => require('./admin/deleteFormSchema'),
  // Run-4 #7b: shared bank of common KinTale checklist items (list + save-to-bank).
  listChecklistBank: () => require('./admin/checklistBank'),
  saveChecklistBankItem: () => require('./admin/checklistBank'),
  triageOrphanReport: () => require('./admin/triageOrphanReport'),
  // B2: the "Needs triage" read side. Web has no Firestore path to this list
  // that stays correct as the collection grows past KINTALES_QUERY's 200-row
  // cap; see listOrphanReports.ts for why a dedicated callable, not a filter.
  listOrphanReports: () => require('./admin/listOrphanReports'),
  verifyActivityLogChain: () => require('./admin/verifyActivityLogChain'),
  setFeatureFlags: () => require('./admin/setFeatureFlags'),
  // Replaces the PUBLIC get-token endpoint on the Twilio Serverless service, which
  // let anyone who knew the URL mint a token and answer the business's calls.
  mintVoiceAccessToken: () => require('./admin/mintVoiceAccessToken'),
  // Accept/reject for a screened inbound call. Replaces an unauthenticated GET
  // that returned plain text to a caller parsing JSON, so every success read as
  // a network error.
  screenCallAction: () => require('./admin/screenCallAction'),
  logActivity: () => require('./admin/logActivity'),
  getNotificationCatalog: () => require('./notifications/getNotificationCatalog'),
  // Dashboard-widget callables (AO-35/39/40/41): all admin-gated.
  optimizeRoute: () => require('./admin/optimizeRoute'),
  logExpense: () => require('./admin/expenses'),
  listExpenses: () => require('./admin/expenses'),
  listSupplies: () => require('./admin/supplies'),
  adjustSupply: () => require('./admin/supplies'),
  upsertSupply: () => require('./admin/supplies'),
  listExpirations: () => require('./admin/expirations'),
  upsertExpiration: () => require('./admin/expirations'),
  // 17.3 Home dashboard layout: the operator's own widget order/sizes.
  saveDashboardLayout: () => require('./admin/saveDashboardLayout'),
  getBusinessNotificationOverrides: () => require('./admin/notificationOverrides'),
  saveBusinessNotificationOverride: () => require('./admin/notificationOverrides'),
  deleteBusinessNotificationOverride: () => require('./admin/notificationOverrides'),
  // #396: the read path for the delivery pipeline. `notificationDispatch` and its
  // per-channel subdocs had no reader anywhere until this callable.
  listNotificationDeliveries: () => require('./admin/listNotificationDeliveries'),

  // HTTPS
  getShareLink: () => require('./share/getShareLink'),
  getSharedKinTalePage: () => require('./share/getSharedKinTalePage'),
  stripeWebhook: () => require('./billing/stripeWebhook'),
  // WARNING-8: Twilio-signature-verified inbound comms webhooks. Server-authoritative
  // writes of calls_log / voicemails / sms_messages (replaces the spoofable
  // client-from-FCM-push writer). Inert until the operator points Twilio at them.
  twilioInboundSms: () => require('./twilio/twilioInbound'),
  twilioInboundVoicemail: () => require('./twilio/twilioInbound'),
  twilioInboundCall: () => require('./twilio/twilioInbound'),
  // The business phone line itself, as TwiML. Replaces the Twilio Studio Flow that
  // had been routing every caller to the after-hours greeting at every hour.
  // Inert until the operator points the number's Voice webhook at it.
  twilioVoice: () => require('./twilio/twilioVoice'),
  addGuestKinTaleComment: () => require('./public/addGuestKinTaleComment'),
  confirmSecureReset: () => require('./security/confirmSecureReset'),

  // triggers
  onAuthUserCreate: () => require('./triggers/onAuthUserCreate'),
  onMembersWrite: () => require('./triggers/onMembersWrite'),
  onKinTaleCreate: () => require('./triggers/onKinTaleCreate'),
  onKinTaleUpdate: () => require('./triggers/onKinTaleUpdate'),
  onInviteRequestCreate: () => require('./triggers/onInviteRequestCreate'),
  onClientsWrite: () => require('./triggers/onClientsWrite'),
  onBookingsWrite: () => require('./triggers/onBookingsWrite'),
  onKinCareRollup: () => require('./triggers/onKinCareRollup'),
  // A SECOND trigger on `kin_care_sessions`, alongside `onKinCareRollup`, and for
  // the same reason `onInvoiceAutoApply` sits alongside `onInvoicesWrite`: they
  // watch the same documents to answer different questions. The rollup keeps our
  // own derived counts; this one writes to a third party's calendar and its
  // failure mode is an operator's day being wrong. Issue #397.
  onKinCareSessionCalendarSync: () => require('./triggers/onKinCareSessionCalendarSync'),
  onBookingEnvelopeCreate: () => require('./triggers/onBookingEnvelopeCreate'),
  onFamilyKinWrite: () => require('./triggers/onFamilyKinWrite'),
  onFlatKinWrite: () => require('./triggers/onFlatKinWrite'),
  onFamilyProfileWrite: () => require('./triggers/onFamilyProfileWrite'),
  // #1321: mirrors the public business card (name, phone, hours, privacy policy
  // URL) from the staff-only settings document to `business_public/card`, which
  // the sign-in screen reads before anyone is signed in.
  onBusinessSettingsWrite: () => require('./triggers/onBusinessSettingsWrite'),
  onInvoicesWrite: () => require('./triggers/onInvoicesWrite'),
  // A SECOND trigger on the same collection, deliberately: onInvoicesWrite
  // decides who to tell about a state change and writes nothing, this one moves
  // a household's unapplied credit onto a bill that has just become collectable.
  onInvoiceAutoApply: () => require('./triggers/onInvoiceAutoApply'),
  // A THIRD, and the only one holding the Stripe key: when an invoice becomes
  // paid it expires every Checkout Session still open for it, so a paid invoice
  // takes no payment (operator ruling 2026-09-27, docket Q5).
  onInvoicePaidExpireCheckouts: () => require('./triggers/onInvoicePaidExpireCheckouts'),
  onKinTaleCommentCreate: () => require('./triggers/onKinTaleCommentCreate'),
  onBookingNoteCreate: () => require('./triggers/onBookingNoteCreate'),
  onRatingCreate: () => require('./triggers/onRatingCreate'),
  onKinfolkCreate: () => require('./triggers/onKinfolkCreate'),
  // #582: geocodes a household's address into `serviceLocation` whenever the
  // address on the record changes. The only hook that sees every address write:
  // three client surfaces patch `kinfolk` directly, with no callable in front.
  onKinfolkAddressWrite: () => require('./triggers/onKinfolkAddressWrite'),
  // #593: strips location metadata from every uploaded video, asynchronously.
  onMediaFileVideoStrip: () => require('./triggers/onMediaFileVideoStrip'),

  // notifications
  onNotificationCreate: () => require('./notifications'),
  onNotificationChannelCreate: () => require('./notifications'),

  // migration
  migrateFoundationV1: () => require('./migration/migrateFoundationV1'),
  migrateFoundationV1Rollback: () => require('./migration/migrateFoundationV1Rollback'),

  // scheduled
  cleanupExpiredShareLinks: () => require('./scheduled/cleanupExpiredShareLinks'),
  rotateOldFcmTokens: () => require('./scheduled/rotateOldFcmTokens'),
  errorDailyDigest: () => require('./scheduled/errorDailyDigest'),
  expireStaleInvites: () => require('./scheduled/expireStaleInvites'),
  notificationDebounceSweep: () => require('./scheduled/notificationDebounceSweep'),
  notificationScheduledSweep: () => require('./scheduled/notificationScheduledSweep'),
  notificationBatchSweep: () => require('./scheduled/notificationBatchSweep'),
  // #823. Finishes a marketing blast or a broadcast whose fan-out did not fit in
  // one invocation. Declares the broadcast's email and SMS secrets, because
  // resuming one sends real mail.
  outboundFanoutSweep: () => require('./scheduled/outboundFanoutSweep'),
  invoiceRemindersCron: () => require('./scheduled/invoiceRemindersCron'),
  invoiceOverdueCron: () => require('./scheduled/invoiceRemindersCron'),
  aiBatchPollCron: () => require('./scheduled/aiBatchPollCron'),
  kincareReminderCron: () => require('./scheduled/kincareReminderCron'),
  // ISSUE #519: the two retention windows the settings screen has claimed for as
  // long as the fields existed, now actually applied. Both delete records, so both
  // refuse to run on an unreadable, zero or negative window (`lib/retentionWindow.ts`).
  purgeOldVisitRoutes: () => require('./scheduled/purgeOldVisitRoutes'),
  purgeOldDrafts: () => require('./scheduled/purgeOldDrafts'),
  scheduleDigestCron: () => require('./scheduled/scheduleDigestCron'),
  // #593: retry / catch-up for the asynchronous video location strip.
  videoGpsStripSweep: () => require('./scheduled/videoGpsStripSweep'),
};

/** The function `name`, read off the module that defines it. */
function loadFunction(name: string): unknown {
  const value = FUNCTIONS[name]()[name];
  if (value === undefined) {
    // tsc checked `export { name } from` for us; it cannot check a require.
    // Throwing here fails discovery at deploy time rather than deploying a
    // function that does not exist.
    throw new Error(`index.ts: ${name} is not exported by the module FUNCTIONS loads it from.`);
  }
  return value;
}

/** Every deployed function by name, loading all of their modules. */
function loadAllFunctions(): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  for (const name of Object.keys(FUNCTIONS)) all[name] = loadFunction(name);
  return all;
}

/**
 * Which functions this process exports.
 *
 * ONE, when FUNCTION_TARGET names one of them. The deployed runtime sets it to
 * the function's entry point, which firebase-tools sets to the export name
 * (gcp/cloudfunctionsv2.js, gcp/runv2.js), and the emulator sets the same per
 * trigger worker (emulator/functionsEmulator.js `getSystemEnvs`). K_SERVICE is
 * NOT used: it is the lowercased Cloud Run service name, not the export.
 *
 * ALL OF THEM otherwise: the same set as before #1337, loaded in the same source
 * order, for
 *   - deploy-time discovery: firebase-tools spawns the SDK with
 *     FUNCTIONS_CONTROL_API=true and no FUNCTION_TARGET, and lists every
 *     export carrying an `__endpoint`. The control flag is checked as well so
 *     a stray FUNCTION_TARGET in a deploy shell can never shrink a deploy;
 *   - the release tooling (scripts/function-targets.js,
 *     scripts/declared-secrets.js), the emulator's own discovery, tests;
 *   - a FUNCTION_TARGET this file does not know. That is the failure mode of a
 *     wrong guess about the runtime, so it costs the old cold start and a
 *     warning, never a missing function.
 *
 * `setGlobalOptions` above has already run either way, so every function still
 * sees the fleet defaults. Nothing else here is global: `initializeApp` lives
 * behind lib/firestoreAdmin.ts's lazy getter and Sentry is initialised by each
 * handler, so a lone module brings up exactly what it needs.
 */
function exportedNames(env: NodeJS.ProcessEnv): string[] {
  const target = env.FUNCTION_TARGET;
  if (!target || env.FUNCTIONS_CONTROL_API === 'true') return Object.keys(FUNCTIONS);
  if (Object.prototype.hasOwnProperty.call(FUNCTIONS, target)) return [target];
  console.warn(
    `FUNCTION_TARGET=${target} is not a function index.ts exports; loading all ` +
      `${Object.keys(FUNCTIONS).length} (#1337).`,
  );
  return Object.keys(FUNCTIONS);
}

for (const name of exportedNames(process.env)) {
  Object.defineProperty(module.exports, name, { enumerable: true, value: loadFunction(name) });
}

// For getIntegrationsHealth, which reports the secrets the whole fleet declares
// and so needs every function even on an instance started for just itself.
// Non-enumerable, so discovery, the release walks and the export set never see
// it.
Object.defineProperty(module.exports, '__loadAllFunctions', {
  enumerable: false,
  value: loadAllFunctions,
});
