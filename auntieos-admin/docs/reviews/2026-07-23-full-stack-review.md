# Full-stack review of the live prod monorepo

**Date:** 2026-07-23
**Scope:** `tribetails/` at `ebc17fe`. AuntieOS React admin, AuntieOS Android,
Kinfolk portal, MyTribe Android, both function codebases, rules, and tests.
**Method:** 7 parallel reviewers, one per surface. Every finding below was then
re-read against the source by the orchestrating session. Findings that did not
survive that re-read are in "Cleared" at the bottom.
**Verdict:** BLOCK for the P0 list. Ten of the twelve P0s are silent: the code
catches, logs, and continues, so nothing surfaced them in three days of prod.
The other two are hard crashes in the AuntieOS Android app.

**One correction already applied.** A thirteenth P0 (Settings "Save" crashes the
app) was reported, and my own read of the code confirmed it. Running it proved
the confirmation wrong: Retrofit delegates to OkHttp `HttpUrl`, which normalizes
a bare host to path "/", so the shipped default never tripped it. It is a real
crash only for a URL carrying a path segment. Downgraded to P1 and moved below,
with the measured boundary recorded. Noted here rather than quietly edited,
because "read the code and reasoned about the library contract" is exactly the
verification standard this review says the codebase should stop trusting.

---

## P0

### 1. Operator 1:1 sends are dead

`auntieos-admin/src/screens/CommunicatePersonalize.tsx:388` calls
`confirmSend` to `api/communicateGenerate.ts:265`, which posts `/api/send-message`.
The hosting rewrite lands on `web/functions/index.js:680`, a bare proxy to
`N8N_SEND_URL = https://n8n.tribetails.com/webhook/auntie-send-message`
(`index.js:344`). n8n was removed. The Broadcast path in the same screen already
uses `sendExternalMessage` with Twilio and smtp2go, so one send path in
Communicate works and the other cannot.

**Fix:** repoint the client at MyTribe's `sendExternalMessage` (it already has
Twilio, smtp2go, and the consent gate) and delete `exports.sendMessage`.

### 2. A kinfolk cannot remove a compromised gate code

`mytribe/web/src/screens/TribeProfile.tsx:261-263`:

```ts
nextGateCode = (homeValues['gateCode'] ?? '').trim() || gateCode.trim() || null;
```

In schema mode the input writes `homeValues`, while `gateCode` still holds the
value loaded from the server. Emptying the field makes the first operand falsy,
so the fallback re-sends the original value, and line 278 prints "Saved. Auntie
will be notified." Same pattern on `keyLocation`, `wifiPassword`, and
`displayName` (`:240`). The non-schema path clears correctly, so behavior forks
on whether a schema exists.

**Fix:** in schema mode read the schema value only. `homeValues[k] !== undefined
? homeValues[k].trim() || null : ...`.

### 3. Impersonation gate split reintroduces the CWE-863 gap

`mytribe/functions/src/lib/staffGate.ts` exists to unify staff checks. Its own
header says the prior split into "env allowlist vs custom claim" was "exactly
the CWE-863 gap this closes." `portal/account.ts:69` bypasses it:

```ts
const isOperator = req.auth?.token?.admin === true;
```

An operator on `AUNTIE_OPERATOR_UIDS` without the `admin` claim passes every
other gate, picks a household, and gets `impersonated: false`. `Account.tsx:150`
derives `readOnly` from that flag, so the operator sees a fully editable form
holding their own name, phone, and backup contacts, headed "Signed in as
\<operator\>", with the client's Kin roster beside it and no operator banner.
Save writes to the operator's own account.

**Fix:** `isStaff(uid, req.auth?.token?.admin === true, 'getMyAccount')`.

### 4. Impersonation never re-mints the token claim, and the failure is swallowed

`portal/setActiveTribe.ts:38-41` checks `clients/{uid}.kinfolkIds` with no staff
bypass, so it always throws `permission-denied` when an operator picks a
household. `web/src/lib/activeTribe.ts:170-174` catches it into a
`console.warn`. The `kinfolkId` claim therefore never matches the impersonated
tribe, and `firestore.rules` gates the two direct client reads on that claim
(breadcrumbs `:216-224`, `conversations/{kinfolkId}` `:673-679`). The
impersonating operator's live GPS map and realtime Messages listener are both
denied with no UI signal, because `web/src/lib/breadcrumbs.ts:15` subscribes
with no `onSnapshot` error callback and renders "Waiting for the first GPS
ping..." forever. Its sibling `messagesListener.ts:42-47` does pass one.

**Fix:** staff bypass in `setActiveTribe`; surface the rejection in
`activeTribe.ts`; add the error callback to `breadcrumbs.ts`.

### 5. Android push registration is broken three ways

- The rules declare `match /fcmTokens/{id}` (`mytribe/firestore.rules:458`,
  camelCase). Every real producer and consumer uses `fcm_tokens`. There is no
  catch-all rule, so the collection is default-deny and
  `AuntieRepository.kt:2134` gets permission-denied on every call.
- The Android doc is `{token, platform, updatedAt}` keyed by uid, with **no
  `uid` field**. Both senders query `.where('uid','==',...)`
  (`pushChannel.ts:40`, `broadcastMessage.ts:257`), so the device stays
  invisible even once the rule exists.
- The two writers disagree on doc id: Android uses uid, `registerFcmToken.ts:26`
  uses the token.

Cloud Functions never hit the rule because the Admin SDK bypasses rules, which
is why this has been quiet. The rules test at
`mytribe/functions/test/rules/flatCollections.test.ts:80-93` exercises the
phantom camelCase name, so CI stays green.

### 6. Android direct booking create and list both fail

`enhanced_bookings` has no rule anywhere. `EnhancedSchedulingViewModel.kt`
targets it at four write sites (`:380`, `:431`, `:458`, `:481`), reachable from
`ScheduleViewScreen.kt:593`. `runCatching{}.onFailure{}` swallows the denial
into a failed `Result`, so it reads as a broken feature rather than a crash.

### 7. KinTale comment digests are never sent

`scheduled/notificationBatchSweep.ts:46` drains
`collectionGroup('items').orderBy('createdAtMs')`. The only writer,
`notifications/dispatcher.ts:230-234`, writes
`notificationBatch/{uid}/{def.batchKey}/{autoId}`, and the sole batched def uses
`batchKey: 'kintale-comments'` (`catalog.ts:261`). Two independent misses: the
collection group is never named `items`, and `baseDoc` stamps `createdAt`
(serverTimestamp) with no `createdAtMs`, which Firestore's `orderBy` would drop
anyway. `firestore.rules:527` confirms the writer's 4-segment path is canonical.
The every-5-minute sweep has matched zero documents since it shipped, and the
rows accumulate.

### 8. `businessSettings/admins` has readers and no writer

Read at `notifications/recipientResolver.ts:35` and `lib/defaultAssignee.ts:17`.
Nothing in the monorepo writes it. 16 catalog keys name `businessAdmins` as
their **primary** resolver, including `kincare.requested`,
`message.received`, and `rating.submitted.bad`. If the doc was never seeded by
hand in the console, a kinfolk booking request throws `no recipients resolved`
and the operator is never told. The same doc backs `resolveDefaultAssignee()`,
so every portal-created visit is written `assignedAuntieUid: null`.

**Operator check:** open `businessSettings/admins` in the Firestore console. If
`uids[]` is populated, this is P1 fragility. If the doc is absent, it is a live
P0 and booking notifications have never fired.

### 9. Kin with no `status` field vanish from the portal

`portal/getMyKin.ts:64` filters `.where('status','in',['active','noLongerWithUs'])`.
Firestore's `in` also excludes documents missing the field entirely. The mirror
trigger `triggers/onFlatKinWrite.ts` writes `pickDefined(after, STAFF_EDITABLE_FIELDS)`
with `merge: true`, and neither `STAFF_EDITABLE_FIELDS` nor
`PARENT_OWNED_FIELDS` (`triggers/kinMirror.ts:26,47`) includes `status`. A
family kin doc created by that path has no status and disappears from the portal
Kin list with no error.

Found because of the bad test in P0-10: `getMyKin.test.ts:51-62` seeds
`{name:'X', status:'random'}` and asserts the result is `'active'`, an outcome
production cannot produce, since real Firestore returns zero docs for that
fixture.

### 10. The Firestore test double cannot fail

`mytribe/functions/test/_helpers/mockDb.ts:85-88` and `:143-146` define `where`,
`orderBy`, `limit`, and `startAfter` as `vi.fn(() => chainable)`. `.get()`
returns the whole fixture regardless. **99 test files use it.** Every filter,
sort, and page size in every consumer is unverifiable: a wrong field name, an
inverted operator, a dropped tenant predicate, or a missing limit all pass.

Confirmed casualties:

- `getMyKinTales.test.ts:116-141` is named for `hasMore` behavior the double
  cannot enforce. Drop the `+ 1` at `getMyKinTales.ts:74` and the test stays
  green while kinfolk can never page past their first 20 tales.
- `expireStaleInvites.test.ts` erases the single `.where()` the function was
  extracted to make testable. Flip `<` to `>` and all three tests pass while the
  nightly cron mass-expires accepted invites and fires `invite.expired` at every
  affected household.
- `getMyVisits.test.ts:21-23` cannot enforce the tenant boundary at
  `getMyVisits.ts:70`, and no test asserts it.

### 11. One kinfolk submitting a vet clinic crashes every operator's app

`data/model/Models.kt:884,898-899` types `VetClinic.createdAt` and `updatedAt`
as `String`. `mytribe/functions/src/portal/submitVetClinic.ts:69-70` writes
`FieldValue.serverTimestamp()`. `AuntieRepository.kt:2537-2548` runs
`snap.toObjects(VetClinic::class.java)` inside the snapshot-listener callback on
the main thread, and the `err != null` guard above it does not catch decode
errors.

After any portal vet-clinic submission, both `ui/admin/VetClinicsViewModel.kt:25`
and `ui/directory/DirectoryViewModel.kt:624` crash for every operator,
permanently, until the document is fixed server-side. The codebase already
documents this exact hazard: `Kinfolk`, `Kin`, and `KinCareSession` all type
`updatedAt` as `Any?` (`Models.kt:117,247,484`) with a comment naming the
Timestamp-vs-String split. `VetClinic` was missed.

### 12. Setting an operator avatar poisons `users/{uid}` and crashes at launch

Same class. `Models.kt:909,935-936` types `UserProfile.createdAt`/`updatedAt` as
`String`; `mytribe/functions/src/admin/setMediaProfilePhoto.ts:109-114` merges
`updatedAt: FieldValue.serverTimestamp()` into `users/{entityId}` when
`entityType == 'USER'`, reachable from `ui/media/MediaGalleryViewModel.kt:66-72`.
`AuntieRepository.kt:2505-2519` decodes inside the snapshot listener, so
`MainActivity.kt:74` throws on the next emission and on every cold start
afterward, until `saveUserProfile` happens to rewrite `updatedAt` as an ISO
string. Nav config (`ui/Navigation.kt:418`), Home, and Admin Settings read the
same flow.

---

## P1

**Tests that green-pass failures.**
`loginSecurityOperatorLoop.test.ts:21-77` never imports `recordFailedLogin`. It
re-implements the fan-out inline (`// Simulate the loop logic in isolation`) and
asserts against its own mock. Delete the production block at
`loginSecurity.ts:263-275` and the suite stays green.
`web/functions/test/handlers.test.js:398-458` runs five `sendMessage` tests
against a stubbed `global.fetch`, reporting a working pipeline against the dead
n8n host; line 450 files `ECONNREFUSED -> 503` (today's live behavior) as a
passing case. `index.test.js:307-407` pins a field-projection contract whose
only consumer was the retired n8n workflow.
`auntieos-admin/visual/web/*.png`: all 20 pairs are md5-identical to their
goldens with identical mtimes, because `visual/web/baseline.mjs:39-51`
`copyFileSync`s captures over goldens with no diff and no review gate, and
`visual:all` never chains `visual:verify`. The desktop and android screenshot
suites have 0 and 1 assertions across 742 lines, so neither can reject a
degraded frame.

**Missing CRUD against live backends.**
`createTrainingDocument` / `updateTrainingDocument` / `deleteTrainingDocument`
are exported (`mytribe/functions/src/index.ts:119-121`) with zero real callers;
Tribal Intel is mounted bare at `router.tsx:239` with no `onSelect`, so it is
list-only. `addKin` is exported (`index.ts:55`) and allowlisted client-side
(`web/src/api/callables.ts:27`) but never called; `Kin.tsx` renders three inert
"Coming soon" affordances (`:35`, `:47`, `:77`) and `KinEdit.tsx:148` ships a
raw "Photo URL" text input because `kinPhotoApi.ts` has no importer. A kinfolk
cannot add a pet. `addInternalBookingNote` and `generateInvoicePdf` are likewise
exported and uncalled.

**Shipped screens nobody can reach.**
`AppShell.tsx` `LIVE_LINKS` has no `kintale-templates` key, so the rail renders
it disabled as "coming soon" while `router.tsx:233` registers the route and the
screen is complete. `/account`, `/my-notifications`, and `/media/$type/$id` have
zero `Link` or `navigate` targets. `Account.tsx:322` renders "Message your
Auntie" as an inert span even though `/messages` shipped and both Home and
Schedule link to it; Account is a bottom-tab item and Messages is desktop-nav
only. Android `TemplateBankScreen.kt` and `TemplateAssignmentScreen.kt` total
1,386 lines, appear in no navigation graph, and are referenced only by
`AndroidScreenshotTest.kt:399,418`, so the screenshot suite reports them as
covered.

**Silent data loss and silent failure.**
`Invoices.tsx:25-38` gives neither `payInvoice` nor `redeemCredit` an `onError`,
so "Pay now" and "Save to Account Balance" stop spinning on rejection with no
message. `InvoiceDetail.tsx:49-54` carries a comment saying this exact class was
already fixed there. `api/directory.ts:142` orders `KINFOLK_QUERY` by
`lastName`, dropping any household missing the field; the doc comment concedes
the exposure is "unmeasured, not proven zero" and declines the `__name__` fix
that already cured the identical `KIN_QUERY` bug. `api/gallery.ts:93`
(`uploadedAt`) and `api/sessions.ts:128` / `api/schedule.ts:42` (`startTime`)
carry the same class, and `backfill_session_starttime.py` proves sessions docs
have really lacked `startTime`.
`portal/requestBooking.ts:184,213` hardcodes `kinNames: []` on the envelope and
every child visit, with no backfill anywhere, so the portal live-visit card
renders "your kin" instead of the pet's name and the Android Schedule drops its
"Pets:" line.
`scheduled/errorDailyDigest.ts:11` queries `auditLog`; every entry is written to
`activity_log` (`lib/writeAuditEntry.ts:154`), and line 17 reads `x.event` where
the written field is `actionType`. The 08:00 digest has never sent.

**Write-side staff gates missing.**
`portal/saveTribeProfile.ts:42`, `saveHomeAccess.ts:41`, and `kinWrites.ts:56`
hard-gate on `clients/{uid}.kinfolkIds` with no `isStaff` path, while their read
counterparts go through `resolveKinfolkAccess`. An operator loads a household's
profile fine and gets `permission-denied` on save. Each then calls
`requireKinfolkPerm`, whose operator bypass is unreachable behind the earlier
throw, and each binds `AUNTIE_OPERATOR_UIDS` for a check that can never fire.
Same shape in `membership/updateSecondaryPermissions.ts:26-27` and
`portal/addSecondaryContact.ts:47-48`, both surfacing only "Save failed. Try
again."

**Secrets rendered in the clear.**
The portal shows `gateCode`, `keyLocation`, and `wifiPassword` as plain
`type="text"` inputs (`TribeProfile.tsx:384`, `:388`, `:392`, schema path
`:655-661`) while the admin has a purpose-built `SecretField`.
`entryNotes` prints plaintext at `lib/dashboardInsights.ts:131` with no `secret`
flag, on a dashboard widget visible without opening a household, directly
between the masked gate code and the masked Wi-Fi password. Entry notes
routinely hold lockbox prose.

**Confirm dialog missing.**
`KinEdit.tsx:314-325` archives a Kin on one click with no confirmation, beside
Cancel. `KinfolkEdit.tsx:510-533` does it correctly with a dialog that names the
entity.

**Contract drift.**
`callableContract.test.ts` freezes 13 shapes; 20 admin-mirrored callables are
unfrozen, including `reviewAndSendDraftInvoice`, `generateReceipt`, and
`sendInvoiceReminder`. The `broadcastMessage` freeze recurses into `ZodArray`
and returns the prefix for the `ZodEnum` leaf, so channel members are invisible
to it, and the admin mirror (`api/communicateWrite.ts:107`) is already one
member short of the backend list (`admin/broadcastMessage.ts:53`). The Compose
`MessageType` (`CommunicateScreen.kt:142-147`) is missing `social_post` and
`general`, and the ALLOWED_TYPES drift guard does not bind it.

**Dead code.**
19 root-level Python scripts in `auntieos-admin/` targeting Baserow and n8n,
roughly 5,200 lines, forming a closed cluster nothing outside imports. Note the
ordering constraint: `web/functions/test/generate.test.js:216-221` binds the
ALLOWED_TYPES guard to `create_n8n_workflows.py:160`, so re-point that bind at
the Android copy **before** deleting, or CI goes red. Also
`sotu-hosting/migrate-baserow-drafts.js`, the three n8n-only endpoints
(`web/functions/index.js:233,294,315`) with `N8N_SHARED_SECRET`, the
`n8nIpRateLimits` rule (`mytribe/firestore.rules:651`), and
`src/screens/MyNotifications.tsx` (superseded by `MyNotificationsEdit`, 12
passing tests asserting unreachable behavior).

**Android: Settings "Save" crashes the app for a URL with a path segment.**
`ui/settings/SettingsViewModel.kt:116-121` called
`rebuildRepository(url.trimEnd('/'))`, and Retrofit throws
`IllegalArgumentException: baseUrl must end in /` from `RetrofitClient.buildN8n`
inside a bare `viewModelScope.launch`, reaching the uncaught handler.
Measured boundary: `https://example.com` is accepted (OkHttp `HttpUrl`
normalizes a bare host to path "/"), `https://example.com/api` throws. The
shipped `DEFAULT_BASE_URL` is a bare host, so this never fired on defaults, and
the originally-reported "every Save, whatever you type" is wrong. The slash-less
value was persisted before the rebuild, so a bad entry also failed at startup,
swallowed at `AuntieOSApp.kt:98` into a silent fall back to the default client.
**FIXED on `fix/android-p0-crashes`:** `RetrofitClient.normalizeBaseUrl` at the
single point of consumption (so an already-poisoned DataStore value heals on
next launch), `saveBaseUrl` persists only after a successful build and surfaces
a genuinely bad URL in a new `baseUrlError` rather than crashing. A URL with no
scheme is deliberately not repaired, since guessing http vs https would be a
silent wrong answer. 11 tests, including a repro that fails against the old line.

**Android: the impersonation gap the portal fixed is still open.**
`mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt:696-697`
calls `fns.call("getMyAccount", null)`. The backend accepts `kinfolkId`
(`account.ts:63-111`) and the web portal passes it (`accountApi.ts:39`). The app
has the picker (`ui/KinfolkPortalAppGuarded.kt:157-180`) and
`nav/AppNavHost.kt:302-305` already hands `kinfolkId` to
`AccountSettingsScreen`, which forwards it to `addSecondaryContact` only
(`:173`) and ignores it for the account load (`:82`) and post-save refetch
(`:301`). The `impersonated` flag is not parsed into the Kotlin `Account` model
at all, so the screen cannot render read-only and a save writes to the
operator's own record. Every other household-scoped read in `PortalApi` threads
`kinfolkId` correctly; `getMyAccount` is the only gap.

**Android: `updateKinCareReport` whole-document `.set()` erases the reconcile
pipeline's fields.** `AuntieRepository.kt:1986-1992` writes
`.set(report.copy(updatedAt = ...))` with no `SetOptions.merge()`.
`KinCareReport` (`Models.kt:533-596`) declares no `reconcileStatus`,
`reconciledAt`, `reconcileNotes`, or `reconcileClaimedAt`, but
`web/functions-python/reconcile_comms.py:705` queries
`.where('reconcileStatus','==','pending')` and stamps those fields at
`:733-735,748-750`. An operator editing a KinTale draft
(`ui/kintales/KinTaleReportViewModel.kt:290`) erases `reconcileStatus`, the
report drops out of the nightly reconcile permanently, and its content never
reaches the kinfolk dossier. The sibling paths for kinfolk, kin, household_data,
and invoices were patched on 07-21 (`AuntieRepository.kt:307,437,1338,1662`);
`kin_care_reports` was not.

**Android: the KinTale send path swallows the save failure and notifies
anyway.** `KinTaleReportViewModel.kt:385` does
`repository.updateKinCareReport(report).getOrNull()` and drops the result, then
proceeds to `notifier.notify(REPORT_SENT, ...)` and `markReportSent`. The
autosave path 95 lines earlier (`:289-300`) handles the same call with `fold`
and surfaces "Couldn't save: ...", so this is an inconsistency rather than house
style. The kinfolk gets a push pointing at a KinTale whose stored body is the
previous revision, and the operator sees success.

**Android: inbound calls, voicemails, and SMS are written twice, from an
unauthenticated push.** `MainActivity.kt:188-196,219-227,245-253` writes
`calls_log`, `voicemails`, and `sms_messages` from FCM data extras, gated by
`FeatureFlags.shouldPersistInboundFromPush` (`config/FeatureFlags.kt:141-142`),
documented at `:130-140` as defaulting to the writing branch.
`mytribe/functions/src/twilio/twilioInbound.ts:210,254,298` already writes all
three authoritatively, keyed by Twilio SID with `{ merge: true }` and
`reconcileStatus: 'pending'`. The client uses a random document id
(`AuntieRepository.kt:2249,2268`), so every inbound message produces two pending
docs, each consuming a Claude call in `reconcile_comms.py` and each landing as a
dossier note. The duplicate's content is whatever the sender put in the data
message. The local-Intent variant of this vector is already closed by the
`INTERNAL_NAV` signature permission (`AndroidManifest.xml:101-105`), so the risk
was understood and the push path was left default-open. Related:
`upsertInboundCallLog` sets `recordingUrl = popupUrl` unconditionally
(`AuntieRepository.kt:2221`) while `showCallNotification` never puts
`EXTRA_POPUP_URL` on the intent, so the client write blanks the Twilio
`RecordingUrl` the server merged in.

---

## P2

- `rotateOldFcmTokens.ts:9` scans `fcmTokens` (the phantom name) every Monday at
  04:00 and has never deleted a document. `pushChannel` prunes hard-invalid
  tokens on send, so delivery still works.
- `engagementWebhooks.ts:114` reads `process.env.SMTP2GO_WEBHOOK_SECRET`, which
  is not in the function's `secrets:` array (`:271` declares only `SENTRY_DSN`).
  Following the documented activation note leaves it `undefined`. The Firestore
  fallback keeps a working path.
- `dispatcher.ts:96-110` catches any resolver exception at `severity: 'info'`
  and returns `[]`; the loud throw fires only when both primary and secondary
  produce nothing, so a genuine programmer fault in the primary is invisible.
- `onRatingCreate.ts:42` forwards `bookingId`, which `submitRating.ts:60-66`
  never writes, and forwards neither `batchId` nor `visitId`, so a bad-rating
  alert renders with no service name, date, or link.
- `createKinCareSession.ts:61,63` writes `createdAt`/`updatedAt` as
  serverTimestamps while `getMyBookings.ts:174-175` reads them through
  `isoMillis()`, which returns null for non-strings. Same drift in
  `approveBookingSeriesCore.ts:110,112`.
- `router.tsx:93` renders on a failed `getMyAccess`, and the failure resolves to
  `allowedIds[0]` rather than an error, so a two-household kinfolk whose access
  fetch blipped sees household 0's data with no indication.
- `/pick` has no in-app entry for a non-operator multi-tribe kinfolk
  (`PortalNav.tsx:72-75` gates the link on `isOperator`), though
  `TribePicker.tsx:92` tells them they can switch from their account.
- `api/portal.ts:57-68` fans out one `getMyHome` per household, which for an
  operator is the entire directory, each with a 20s ceiling and no paging.
- Home and Schedule disagree about whether a visit is live: `Home.tsx:64` reads
  `getMyBookings.liveVisit`, `Schedule.tsx:37` gates on `getMyVisits` with
  `retry: false` and an unsurfaced error.
- `match /activity_log/{id}` is declared twice (`firestore.rules:475`, `:555`).
  Harmless under union semantics, but tightening one copy would appear to do
  nothing.
- `auntieos-admin/.env.example` documents 13 keys with no live consumers.
  `mytribe/.env.example` and `.env.local` are read by nothing: there is no
  dotenv loader under `mytribe/`.
- React admin Sentry is inert: no `VITE_SENTRY_DSN` or `VITE_SENTRY_RELEASE` in
  `.env`.
- Vocabulary drift in shipped copy: "Select Client & Pets"
  (`BookingWizard.tsx:462`), "Owner contact" (`KinEdit.tsx:287`), "Sitter Notes",
  "Client" on a kinfolk's own invoice, plus the stale "Browse the email
  templates SendGrid delivers" (`Templates.tsx:276`).
- Android `stampFamilyKinPath` (`AuntieRepository.kt:452-463`) discards its
  `Result`, so a failed FK write leaves `onFlatKinWrite` nothing to mirror and
  the pet stays invisible in the portal while the operator sees "Update
  successful for kin".
- `NativeAndroidFunctionsClient.kt:43-50` catches a reflection failure and
  returns `emptyMap()`, so every MyTribe Android callable would degrade to blank
  defaults and every `Unit`-returning write to a fake success if R8 were ever
  turned on (currently off, `mytribe/build.gradle.kts:167-171`).
- Communicate renders pet avatars from the retired Baserow shape:
  `CommunicateScreen.kt:1152` reads `kin.photos.firstOrNull()?.url`, and
  `BaserowFile` (`Models.kt:9-15`) declares its fields as `val`, which Firestore
  cannot populate. Every pet falls back to initials. The live field is
  `Kin.profilePictureUrl`. `Kinfolk.media` and `Kin.gallery` are the same dead
  shape with no readers.
- `rebuildRepository` (`AuntieOSApp.kt:114-117`) swaps the singleton, but
  ViewModels capture the old instance at construction
  (`ui/Navigation.kt:382`), so a base-URL change appears to do nothing on
  already-composed screens.
- Android Settings still shows an editable "TUNNEL URL" seeded with the removed
  n8n host (`ui/settings/SettingsScreen.kt:122-138`), which is also the crash in
  P0-11.

---

## Cleared

Leads that did not survive verification. Recorded so they are not re-raised.

- **`clear_dossier_household_notes` is not missing.** `HANDOFF_2026-07-21.md`
  and `HANDOFF_2026-07-22.md` both list it as called by Android but absent from
  `mytribe/functions/src`. It is a deployed Python callable at
  `auntieos-admin/web/functions-python/main.py:157`, alongside
  `recap_recent_comms` (`:121`) and `synthesize_kinfolk_profile` (`:69`). A full
  diff of every callable-name literal across all five clients against the
  `index.ts` exports yields exactly those three names, all resolving to the
  Python codebase. **Correct the handoffs.**
- **n8n, Baserow, and SendGrid have no functional dependency inside
  `mytribe/functions/src`.** Only historical comments at `lib/email.ts:6`,
  `notifications/senders/emailChannel.ts:8`, `admin/broadcastMessage.ts:32`.
  The live dependency is confined to `auntieos-admin/web/functions`.
- **ToastTone has no error member and no error routes through a toast.**
  `components/Toast.tsx:26` enforces `'success' | 'info'` and all six call sites
  are success copy.
- **No UTC day-window bug in either React surface.** Admin uses
  `localDateIso(new Date())`; `portalFormat.ts:36-48` and `bookingWizardLogic.ts`
  are local-midnight anchored. AO-18 remains live only on the superseded wasm
  and desktop surfaces.
- **All 30 callable names invoked by the React admin exist backend-side.** A
  wider diff of all 73 AuntieOS Android callable literals and every MyTribe
  `fns.call` literal against the 197 `index.ts` exports plus the 20 in
  `web/functions/index.js` and the 7 in `main.py` also produced no misses.
- **The AuntieOS Android app has no reachable path to the dead n8n host.**
  Worth stating plainly because the surface looks alarming and is not.
  `RetrofitClient.kt:21` still sets `DEFAULT_BASE_URL` to the removed host, but
  the two relative-URL endpoints on that base (`N8nApi.kt:11,22`) have zero
  callers, and `AuntieRepository.sendMessage` (`:569-583`) also has zero
  callers: `MessagingViewModel.kt:66-93` uses the `sendExternalMessage` callable
  instead, and `repo.generate` uses the absolute-URL `generateViaFunction`
  (`:533`). The live n8n dependency is confined to the React admin (P0-1).
- **Neither FCM service persists anything on its own.**
  `AuntieFirebaseMessagingService` only posts notifications, `KinfolkFcmService`
  posts and registers tokens, and `MessageStore` / `VoicemailStore` /
  `CallEventStore` are in-memory. The duplicate-write path in P1 runs from
  `MainActivity`, not the services.

---

## Fix order

0. **DONE, on `fix/android-p0-crashes`, needs an APK.** P0-11 and P0-12 (the two
   decode crashes) plus the downgraded Settings crash. The four timestamp fields
   are now `Any?` matching `Kinfolk`/`Kin`/`KinCareSession`, with
   `createdAtIso()`/`updatedAtIso()` accessors and the two `.ifBlank {}` writers
   repointed. 1443 android tests green, 17 of them new. Not yet built into an
   APK or distributed.
1. **Same day, one deploy.** P0-1 (repoint the send path), P0-3 and P0-4
   (impersonation gates), P0-5 and P0-6 (the two rules gaps), P0-7 (the sweeper
   path). All are small and independently testable.
2. **Operator check, five minutes.** Open `businessSettings/admins` in the
   console. That single lookup decides whether P0-8 is a live outage or latent
   fragility.
3. **Next.** P0-2 (secret clearing), P0-9 (`status` on mirrored kin, which needs
   a backfill as well as a writer fix), and the Android `kin_care_reports`
   merge, which is silently dropping KinTales out of the reconcile pipeline.
4. **The expensive one.** P0-10, the `mockDb` rewrite. Give `where`, `orderBy`,
   and `limit` real semantics, then expect a wave of newly-red tests. That wave
   is the actual finding.
5. **Sweep.** Dead Python cluster (re-point the ALLOWED_TYPES guard first), the
   three n8n endpoints plus `N8N_SHARED_SECRET` and the `n8nIpRateLimits` rule,
   env cleanup, and the vocabulary and copy fixes.

Two patterns worth naming.

Ten of the thirteen P0s fail silently, and four have a passing test standing
over the failure. The suite is not measuring what it appears to measure, which
is why three days of green CI and a prod deploy did not surface any of this.

Six findings are cases where the correct fix already exists somewhere else in
the tree and one site was missed: `staffGate` bypassed in one handler, `Any?`
timestamps on three models but not two others, `SetOptions.merge()` on four
write paths but not the fifth, `onError` on the invoice detail screen but not
the list, an `onSnapshot` error callback on the messages listener but not
breadcrumbs, `kinfolkId` threaded through fifteen `PortalApi` calls but not
`getMyAccount`. These are cheap to fix and hard to find, and grepping for the
pattern's other instances at fix time is worth more than the individual fix.
