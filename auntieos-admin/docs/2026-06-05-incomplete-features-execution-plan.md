> SUPERSEDED by `AuntieOS_Combined_Execution_Plan_v2.md` (2026-06-05). Kept for
> history only. Do not plan from this file.

# Incomplete features execution plan (finish everything fullstack) — 2026-06-05

Directive: every still-gated/incomplete AuntieOS feature must be built as a full
vertical slice (MyTribe callable where needed + web Wasm + desktop JVM + android
+ tests), then its flag removed. No gate-dark for our own code. Only external
secrets may defer (named below).

Status legend: BUILD-NOW (no blocker, reuses/needs only our code) | DECISION
(needs a product call first, listed) | SECRET (blocked on an external secret).

## SECRET-BLOCKED (the only legitimate defer)
- **settings.integrationManage** (auntieos.settings.integrationManage). Manage/
  Connect on integration cards = per-provider OAuth connect flow. NEEDS EXTERNAL
  SECRET: third-party OAuth client id + secret per provider (Google Calendar
  OAuth client, Stripe Connect client, etc.). STOP until the operator provides
  these. Everything else is buildable.

## DECISIONS (operator-answered 2026-06-05)
- broadcast: SAVED SEGMENTS + multi-channel (in-app/email/sms/push). Build a reusable audience-segment model. (Largest; wave for it TBD.)
- externalSend: EMAIL + SMS (SendGrid + Twilio, secrets already set). Needs consent/opt-out + audit guardrails.
- notifications.quickActions: mark read/unread, open linked item, dismiss/archive, quick approve/deny, PLUS a new "create quote + send to kinfolk on creation" action (a quotes mini-feature: compose a quote from a notification and optionally send to the kinfolk on save).

## WAVE 1 - DONE 2026-06-05 (code + verified)
- formschemas.rowDelete: wired existing deleteFormSchema to the list row + confirm (web 606, android 698 green).
- kintale.viewAsKinfolk: read-only kinfolk preview + Share link via createShareLink (NOT getShareLink, which is the guest read endpoint). Backend fix: createShareLink now lets the AuntieOS operator (isAuntieOperator / AUNTIE_OPERATOR_UIDS, added to its secrets) bypass the family requirePrimary gate; redeployed. SHARE_LINK_BASE_URL already set.
- parity: scheduleGoogleCalBusy removed from android registry too. web==android = 24 keys.

## DECISION-FIRST (cannot build correctly without a product call)
- **communicate.broadcast** — free-form composed message to an AUDIENCE SEGMENT,
  multi-channel fan-out. Only backend today is scheduleMarketingBlast (fixed
  marketing template keys, explicit uid list, scheduled). Need: (1) audience
  model (all active kinfolk / manual multi-select / saved segments), (2) channels
  (in-app + email + sms + push?), (3) immediate vs scheduled, (4) reuse
  scheduleMarketingBlast vs new broadcastMessage callable.
- **communicate.externalSend** — send to a raw email/phone outside the tribe.
  N8nClient.sendMessage exists. Need: channels + guardrails/compliance (who can,
  consent, rate limit). SendGrid/Twilio secrets already set per memory.
- **notifications.quickActions** — per-notification actions + read/unread model.
  Need: which actions per notification type, and the read-model shape.

## BUILD-NOW waves (no external blocker)

### Wave 1 - reuse callables that already exist (smallest, highest confidence)
- **formschemas.rowDelete** - deleteFormSchema callable EXISTS (index.ts); just
  wire the list-row delete (web + android) + confirm dialog + tests.
- **schedule.dragReschedule** - rescheduleBooking callable EXISTS; add drag
  gesture -> rescheduleBooking on web + android schedule grids + tests.
- **invoices.headerActions + invoices.sendReminder** - generateReceipt EXISTS
  (wire the header receipt button); build sendReminder callable (or reuse
  invoiceRemindersCron logic as an onCall) + wire header reminder button, 3
  platforms + tests.
- **kintale.viewAsKinfolk** - getShareLink callable EXISTS; build the kinfolk-view
  render + share-link action, 3 platforms + tests.

### Wave 2 - new callable + tri-platform UI
- **invoices.reviewAndSendDraft** - draft review + send via postInvoiceEvent
  (exists) status transition; wire UI 3 platforms + tests.
- **bookings.bulkSelect** - new batch approve/cancel callable + multi-select UI
  3 platforms + tests.
- **templateAssignment.unboundCatalogHint** - new listCatalogKeys callable +
  unbound-keys hint 3 platforms + tests.
- **inbox.bulkMarkRead** - new bulk-mark-read callable (per-item markNotificationRead
  exists) + UI 3 platforms + tests.

### Wave 3 - derivations / data joins (client-heavy)
- **home.weeklyRevenueStat** - weekly paid-invoice aggregation (callable or client
  sum over loaded invoices; pick server agg for correctness) + tile 3 platforms.
- **directory.lastVisit** - derive last completed kin_care_session/visit_log per
  kinfolk + card timestamp 3 platforms.
- **directory.newBadge** - isNew rule (created < N days OR zero KinTales) + badge
  3 platforms.
- **home.globalSearch** - search across loaded kinfolk/kin/KinTale (client-side
  first; server search only if needed) 3 platforms.
- **auntieTime.multiPetAvatars** - render all kin avatars per session (kin join)
  3 platforms.

### Wave 4 - bigger surfaces
- **formschemas.livePreview** - shared runtime form renderer that both the editor
  preview and the kinfolk form consume; 3 platforms + tests.
- **invoices.clientPaymentsHeuristic** - currently web-only; build an android
  invoice-detail screen with the same disclosed client-side payment-match
  fallback, to reach tri-platform parity, then ungate.

## Process per feature (NON-NEGOTIABLE)
Backend callable (MyTribe/functions, if needed) + validation + web commonMain +
android + error handling (fail loud) + unit/integration/UI tests (happy/sad/
negative/error) + remove the flag from BOTH registries (keep web==android
parity) + verify green (web jvmTest+wasm, android testDebugUnitTest, MyTribe
tsc+vitest) + rebuild/redeploy web hosting + rebuild APK. No em/en dashes. Auntie*
components only. Never author customer-facing copy (operator authors it).

## Done already this session (for reference)
calendar UI + settings unification + 13 flags ungated (notificationBell,
kintale.listSearch, auntieTime.timeBlockLabels, activity.chainVerify,
settings.schedulingSync, payments.searchFilter, templateBank.search,
formschemas.search, formschemas.countChip, trainingDocs.commFilter,
templateAssignment.triggerOverrideEcho, schedule.newVisit[vestigial],
schedule.googleCalBusy[web render built]).
