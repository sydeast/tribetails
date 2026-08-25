# Settings model unification (business_settings + admin_settings) — 2026-06-05

## Problem

AuntieOS settings are forked across two prod Firestore docs and two divergent
per-platform schemas. Concretely:

- `business_settings/business_settings` (prod, real data): GPS/tracking, eta,
  draft retention, notifications, holiday lists, `calendarSyncId`, AND
  businessName/email/phone (legacy). Web models a DIFFERENT subset of this doc
  than android does.
- `admin_settings/admin_settings` (prod, real data): booking config
  (defaultBookingMode, allowTimeBlockBooking, enableConflictDetection,
  travelBufferMinutes, defaultTimeBlockDurationHours, defaultCalendarView,
  enableAutoReminder24h, observeUsHolidays), `timeBlocks`, timeZone, and its own
  businessName/email/phone. Only android reads/writes this doc; web does not
  model it at all.

Active bugs caused by the fork:
1. Web writes `business_settings` to doc id `singleton` (never read back: web
   read picks `firstOrNull()` = doc `business_settings`, which sorts before
   `feature_flags`). Web settings edits are lost on reload. No `singleton` doc
   exists in prod, confirming web has never persisted here.
2. Non-merge writers overwrite cross-schema: web-jvm (PATCH no updateMask) and
   android (`.set()` no merge) delete fields the other platform owns.
3. `timeBlocks` is stored in two different docs depending on platform
   (web: business_settings; android: admin_settings), and even the element key
   diverges: prod stores `active`, web kotlinx serializes `isActive`.

## Decision (operator-approved 2026-06-05: "Full unification now")

ONE canonical settings doc: `business_settings/business_settings`. Collapse
`admin_settings` into it. Both platforms share ONE `BusinessSettings` model =
the union below. `admin_settings` is migrated in, then left read-only for
rollback (not deleted by code).

Read-modify-write everywhere + merge writes. A save always starts from the
loaded doc and writes via merge, so no field (including fields a given screen
does not edit) is ever clobbered or reset to a default.

## Canonical unified `BusinessSettings` schema

Field names are the Firestore wire names (must match byte-for-byte on web
kotlinx `@SerialName` and android POJO `@PropertyName`). Defaults shown.

Business profile:
- businessName: String = ""
- businessEmail: String = ""
- businessPhone: String = ""
- businessAddress: String = ""
- timeZone: String = "America/New_York"
- serviceRates: Map<String,String> = {}
- businessHours: Map<String,String> = {}   // day -> "HH:MM-HH:MM" or ""

Notifications:
- RETIRED by issue #519. `notificationEmail` / `notificationSms` /
  `notificationPush` were declared, defaulted and decoded by the web models and
  read by nothing: zero occurrences in `mytribe/functions`, and never present on
  the Android model at all. Every channel decision is made by
  `notifications/prefs.ts#resolveChannels` off the per-notification gate matrix
  on a DIFFERENT document, `businessSettings/notifications`. The three keys were
  removed from the models, not from any stored document.

Time off / holidays:
- observedUsHolidays: List<String> = []     // which holiday ids are observed
- companyHolidays: List<String> = []        // "YYYY-MM-DD|Name"
- specialHours: List<String> = []           // "YYYY-MM-DD|hours"
- observeUsHolidays: Boolean = false        // android toggle, distinct from the list above

Booking / scheduling config (migrated from admin_settings):
- defaultBookingMode: String = "SPECIFIC_TIME"
- defaultCalendarView: String = "MONTH"
- allowTimeBlockBooking: Boolean = true
- allowSpecificTimeBooking: Boolean = true
- enableConflictDetection: Boolean = true
- enableAutoReminder24h: Boolean = true   // #519: was `false`, while
  //   `kincareReminderCron` sent the reminder unconditionally. The cron reads
  //   the field now and treats an absent key as ON, so the default states what
  //   the product has always done.
- defaultTimeBlockDurationHours: Int = 4
- travelBufferMinutes: Int = 30
- timeBlocks: List<TimeBlockDefinition> = [ midday 11:00-15:00 active ]

GPS / tracking:
- enableGPSTrackingForAllVisits: Boolean = true
- enablePhotoLocationTagging: Boolean = true
- requireArrivalDepartureVerification: Boolean = true
- autoStartTrackingOnVisitStart: Boolean = true
- trackingAccuracy: String = "HIGH"         // LOW|MEDIUM|HIGH
- saveRoutesForDays: Int = 90
- allowClientLocationSharing: Boolean = true

Visit ETA / drafts:
- defaultEtaMinutes: Int = 15
- etaMinuteOptions: List<Int> = [5,10,15,20,30,45,60]
- draftRetentionDays: Int = 30
- draftRetentionOptions: List<Int> = [30,60,90]

Calendar:
- calendarSyncId: String = ""

Meta:
- updatedAt: String = ""
- updatedBy: String = ""

TimeBlockDefinition (canonical wire shape, key is `active` to match prod):
- id: String = ""
- label: String = ""
- startTime: String = ""   // "HH:mm"
- endTime: String = ""     // "HH:mm"
- active: Boolean = true    // web: @SerialName("active") on isActive; android: isActive maps to "active"

trackingAccuracy is wire String; android keeps its enum but maps to/from the
exact strings LOW|MEDIUM|HIGH.

## Conflict resolution for the one-time migration

Merge `admin_settings/admin_settings` INTO `business_settings/business_settings`:
- booking-config + timeBlocks + timeZone: take from admin_settings (its home).
- businessName/email/phone: business_settings wins if non-empty, else admin_settings.
- everything else: keep business_settings value.
- never delete: union of keys. Idempotent (re-run = no-op once merged).

## Work breakdown

1. Web (commonMain, ships web Wasm + desktop JVM):
   - Extend `BusinessSettings` to the full union; add `@SerialName("active")` on
     TimeBlockDefinition.
   - Save: always doc id `business_settings` (drop `singleton`). wasm already
     merge:true; jvm `setDoc` add an updateMask = body keys (merge), or a new
     mergeDoc path.
   - Read: read the specific doc `business_settings/business_settings`
     (add `jsListenDoc` bridge + extern for wasm; jvm read getDoc by id) instead
     of `firstOrNull()`/`first()` of the collection.
   - Model booking-config (no new UI required this pass beyond what exists; the
     fields must round-trip). Time-block resolver already reads
     BusinessSettings.timeBlocks: OK.
   - Tests: full-union JSON round-trip; doc-id is business_settings; read targets
     the specific doc; merge does not drop sibling fields.

2. Android:
   - Extend `BusinessSettings` (LocationModels.kt) to the full union.
   - Repoint every `AdminSettings` consumer (28 refs / 13 files) to the unified
     `BusinessSettings` on `business_settings` doc, INCLUDING the booking-core
     time-block readers (BookingRepository, EnhancedSchedulingViewModel,
     AdminDataViewModel, ScheduleViewScreen, KinCareSessionsScreen). Keep the
     `AdminSettings` class only if still referenced by a read-only fallback;
     otherwise delete.
   - `saveBusinessSettings`: `SetOptions.merge()`, read-modify-write.
   - Tests: model round-trip; resolver reads timeBlocks from BusinessSettings;
     existing booking/scheduling tests stay green.

3. Migration script (idempotent, dry-run default, fail-loud, with backup):
   - Back up both docs first (copy to `backups/settings_pre_unify_<runId>` or a
     local JSON dump) BEFORE any write.
   - Merge per the conflict rules above into business_settings.
   - `--apply` flag to write; without it, dry-run prints the diff.
   - OPERATOR-GATED: Claude does not run the prod write. Operator backs up,
     dry-runs, then applies.

4. Backend: `syncGoogleCalendarBusyEvents` already scans `business_settings` for
   `calendarSyncId`; no change needed (canonical doc still satisfies it).

## Rollback

admin_settings doc is left intact (read-only) post-migration. If a regression
appears, revert app builds and the data still exists in both docs. The backup
copy is the authoritative restore source for business_settings.

## Verification gate (must be green before operator deploy)

- web: `:composeApp:jvmTest :composeApp:compileKotlinWasmJs`
- android: `:app:testDebugUnitTest`
- MyTribe: `tsc --noEmit && vitest run` (unchanged, regression check)
- migration script: dry-run against an emulator/seed + unit test on the pure merge fn
- no em/en dashes
