# React Port Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every feature lost in the wasm-to-React port of the AuntieOS admin, plus the net-new invoice/list/calendar functionality the operator asked for, as full vertical slices on web AND Android.

**Architecture:** The React admin (`auntieos-admin/src`) calls MyTribe Cloud Functions (`mytribe/functions/src`, codebase `mytribe`) for all writes; Firestore rules keep sensitive collections callable-only. The archived wasm app (`AuntieOS_ARCHIVED_2026-07-21.../web/composeApp`) is the behavioral reference for restored features. The Android app (`auntieos-admin/android`) already implements most of the missing surfaces and serves as the second port target or parity check per slice.

**Tech Stack:** React 19 + Vite 6 + TanStack Router 1.95 + Firebase 11 + Zod 4 + Vitest 2.1.8 (web); Jetpack Compose + Kotlin (Android); Firebase Functions v2 TypeScript with zod validation (backend); Cloudinary (media), Mapbox (address), Twilio (SMS/voice), SMTP2GO (email).

## Definition of DONE (applies to every task)

A feature/bug is DONE only as a full vertical slice:
Cloud Function (in `mytribe/functions`) + validation + frontend wiring + routes + component + error handling + tests (unit, integration, e2e; happy + sad + negative + error) on web AND Android.
A missing callable means BUILD the callable. Never ship frontend-only. No "gate dark" or "Not wired" banner for our own code.

## Global Constraints

- **Git workflow (operator rule): NEVER commit on `main`.** Before starting any task: `git checkout main && git pull origin main`, then `git checkout -b <type>/<task-slug>` (e.g. `fix/tag-suggest-dismiss`, `feat/invoice-line-items`). All commits land on the branch; integrate via PR. Every "Commit" step in every task below implies this. One branch per task.
- Deploy command: `firebase deploy --only functions:mytribe:<name>` (codebase prefix mandatory, per `mytribe/CLAUDE.md`).
- Every new or changed callable gets an entry in `mytribe/functions/CALLABLE_CONTRACT.md` and a shape assertion in `functions/test/callableContract.test.ts`.
- NEVER export a function named `signCloudinaryUpload` from the MyTribe codebase (documented name-collision incident, `mytribe/functions/src/index.ts:89-97`). New upload signers get distinct names.
- Admin-gated callables use `wrapAdminCallable`; every write path validates with zod before touching Firestore.
- Web test suite (1,955 cases) and Android suite (179 test files) must stay green on every task. Checks per slice: `npx tsc --noEmit && npx vitest run && npx vite build` (web), `./gradlew :app:compileDebugKotlin :app:testDebugUnitTest` (Android).
- Firestore rules: collections written by new callables stay `allow write: if false` client-side unless the archive pattern was a rules-backed direct write (tags, kintale_templates).
- Design references, in priority order: `auntieos-admin/page-specs/*.md`, `auntieos-admin/ui-ideas/*.html` (2026-05-27 concepts), `auntieos-admin/visual/mockups/*`, then the archive Compose source.
- No em dashes in any user-facing copy. Follow existing DenScreenKit voice ("The Den · X" kickers, fail-loud error banners).
- **External-secret stops (the only permitted deferrals):** Task 7.2 (Google OAuth editable calendars) needs `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` from the operator's Google Cloud console. Nothing else in this plan is blocked on anything.
- **Operator config action (not a code blocker):** Task 6.3 requires pointing three Twilio webhooks at already-deployed function URLs. Code ships and is testable via emulator + signed test requests regardless.

## Reality corrections discovered during audit (read before executing)

These change the shape of several numbered issues:

1. **KinTale templates (#8) are NOT "coming soon" on web.** `src/screens/KinTaleTemplates.tsx` (756 lines) is live at `/kintale-templates`. The gaps are checklist-bank quick-add and default-flag exclusivity. If a "coming soon" label was observed, it was the AppShell fallback for a nav slug missing from `LIVE_LINKS`; Task 1.6 verifies and closes.
2. **The archive never had invoice line items, an un-invoiced-visits picker, or invoice archive** (grep-verified zero hits). Items #18/#19 are new builds, not restorations. The archive DID have: record-payment dialog, link-sessions dialog, quote mode, PDF download, state-gated row actions.
3. **"Google calendar ready for production" (#7) = the service-account free/busy sync.** `syncGoogleCalendarBusyEvents` is deployed, the SA (`auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com`) exists, and the archive panel was a Calendar ID field + Run Sync button. That restore needs NO secret. OAuth-based *editable* calendars never existed anywhere; that is new build (Task 7.2) and is the plan's only secret-gated item.
4. **"Auntie voice generator" (#4) = the archive's Personalize composer**: message-type chips (Visit report / Text / Email / Blog), Tone chips (Warm / Cheerful / Professional / Playful), Length chips (Short / Medium / Long), calling `generateAuntieCopy` (`POST /api/generate`, deployed, admin-token gated). Not TTS.
5. **MapBox needs no new secret**: `mapboxSearch` + `mapboxRetrieve` callables exist in MyTribe with `MAPBOX_ACCESS_TOKEN` configured. Web just never wired them.
6. **Notification settings (#10):** labels live in `mytribe/functions/src/notifications/catalog.ts`, not the web app. `kincare.report.sent` ("Visit report sent") and `kintale.published` ("New KinTale published") are separate catalog keys describing the same event. "Auntie commented" maps to `kintale.comment.added` (the comment box thread) which is distinct from `kintale.note.added` (a note attached to the KinTale body). Task 0.5 merges/renames.
7. **Vet clinics (#13) need no new callables.** The `vet_clinics` collection exists, is seeded, is admin-readable per `firestore.rules:131`, and `getVetClinics` + `submitVetClinic` are deployed. The web kinfolk form just never pulls from it. Task 1.8 builds the search dropdown with a pinned create-clinic button at the bottom (operator-specified UX) and extends `submitVetClinic` additively (staff submissions verified, optional emergency flag).
8. **Incidental live bug. CORRECTION: this audit item was stale when written.** The claim that `scheduled/rotateOldFcmTokens.ts` reads `fcmTokens` while writers use `fcm_tokens` was already false: commit `84c6607` (2026-07-23) fixed the collection name a day before this audit snapshot was taken. That fix is NOT this plan's contribution. What remained genuinely broken is that the sweep took a single `.limit(500)` page with no pagination, so on a collection that has never once been pruned it could not drain the backlog. Task 0.4 was rescoped accordingly.

## Phase map

| Phase | Theme | Issues covered | New callables |
|---|---|---|---|
| 0 | Small fixes, same-day shippable | #3, #10, #11(services), #14, #19(gating), fcm bug | 0 |
| 1 | Wire existing backend, no new callables | #2, #8, #12, #13, #16, #17, #20, #21 | 0 |
| 2 | Communicate + Inbox restoration | #4, #5 | 0 to 1 |
| 3 | Home widgets edit mode + layout | #9 | 0 to 1 |
| 4 | Lists: search, filters, pagination | #15 | 0 (indexes only) |
| 5 | New-callable slices: invoices, branding | #6, #18, #19 | 6 |
| 6 | Inbox external channels + booking picker UX | #5(channels), #11(picker) | 0 |
| 7 | Calendar: restore sync, then OAuth | #7 | 5 (7.2 only) |
| 8 | E2E harness + regression sweep | #1 umbrella | 0 |

Each task below is execution-ready at the epic level: exact files, contracts, and test names. Per the writing-plans scope check, phases 2, 5, and 7 are large enough that the executing agent MUST expand each into its own micro-stepped TDD plan (same directory, suffix `-taskNN.md`) before writing code. Phases 0 and 1 tasks are small enough to execute directly from this document.

---

## Phase 0: Small fixes

### Task 0.1: Tag suggestion dropdown dismisses on click-away/blur (#3)

**Files:**
- Modify: `auntieos-admin/src/components/TagAssignField.tsx`
- Test: `auntieos-admin/src/components/TagAssignField.test.tsx`

**Behavior:** Suggestion dropdown currently persists when focus leaves the field. Add: (a) `blur` handler on the input that closes the dropdown after a 150 ms timeout (so click-to-select on a suggestion still lands), (b) a document-level `pointerdown` listener while open that closes when the event target is outside the component root ref, (c) Escape already clears; keep it.

- [ ] Write failing tests: `dismisses suggestions on outside pointerdown`, `dismisses on blur without swallowing suggestion click`, `keeps existing Escape behavior`
- [ ] Implement ref-based outside-click + delayed blur close
- [ ] `npx vitest run src/components/TagAssignField.test.tsx` green; full suite green
- [ ] Android parity check: `AuntieChipGroup.kt` tag surfaces; Compose dropdowns dismiss natively; add a UI test only if a repro exists
- [ ] Commit

### Task 0.2: Join date becomes a real date picker with local display (#14)

**Files:**
- Modify: `auntieos-admin/src/screens/KinfolkEdit.tsx:373-380` (joinDate field to `<input type="date">`)
- Modify: `auntieos-admin/src/lib/kinfolkEditSchema.ts:106` (`joinDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal(''))`)
- Modify: `auntieos-admin/src/screens/KinfolkProfile.tsx:162` (render via `Intl.DateTimeFormat(undefined, {dateStyle:'medium'})`; raw string fallback for legacy non-ISO values, never crash)
- Tests: `kinfolkEditSchema.test.ts`, `KinfolkProfile.test.tsx`

- [ ] Failing tests: schema rejects `07/24/2026` and raw UTC timestamps, accepts `2026-07-24` and empty; profile renders "Jul 24, 2026" for ISO and passes through legacy junk unformatted with no throw
- [ ] Implement; migration note: existing docs keep legacy strings, display layer tolerates both
- [ ] Android parity: verify join date uses a Material date picker in `KinfolkProfileScreen.kt` edit path; port if free-text
- [ ] Commit

### Task 0.3: Invoice actions gated by state (#19, gating half)

**Files:**
- Modify: `auntieos-admin/src/components/InvoiceDetail.tsx:24-50, 213-219`
- Test: `auntieos-admin/src/components/InvoiceDetail.test.tsx`

**Behavior:** Replace the unconditional `ACTIONS.map` with a state filter reusing the list screen's classifiers (`invoiceIsPaid`, `invoiceIsOutstanding`, `invoiceIsDraft`, `invoiceIsQuote` in `src/lib/invoiceFormat.ts`; add any missing classifier there so list and detail can never disagree, mirroring the archive design):
- PAID: Generate receipt only. No Mark paid, no Send reminder.
- OUTSTANDING/OVERDUE: Mark paid, Send reminder.
- DRAFT: Review and send (wire `reviewAndSendDraftInvoice`, already deployed).
- QUOTE: no payment actions.

- [ ] Failing tests: one per state asserting the exact button set
- [ ] Implement filter + wire `reviewAndSendDraftInvoice` into `src/api/invoicesWrite.ts`
- [ ] Android parity: apply same gating in `InvoiceDetailScreen.kt`
- [ ] Commit

### Task 0.4: Make the rotateOldFcmTokens sweep actually drain

**Not the collection name.** `fcmTokens` to `fcm_tokens` was already fixed in `84c6607` on 2026-07-23; verified before starting. The remaining defect was that the sweep read a single `.limit(500)` page with no `startAfter` pagination, no batching, and no fail-loud cap log, so on a collection that has never been pruned it drained at most 500 docs per week, silently. That violated the WARNING-25 convention `test/cronPagination.test.ts` enforces for the other three crons.

**Files:**
- Modify: `mytribe/functions/src/scheduled/rotateOldFcmTokens.ts` (extract `runFcmTokenPruneScan`, paginate, batch the deletes)
- Test: `mytribe/functions/test/rotateOldFcmTokens.test.ts`

- [x] Failing tests first, house mock idiom (`vi.mock` of `firestoreAdmin`), not the emulator (the emulator is used only under `test/rules/`)
- [x] Extract a testable runner matching the `runInvoiceRemindersScan` / `runKincareReminderScan` / `runScheduleDigestScan` convention
- [x] `paginateQuery` drain with the CRITICAL `cron.pagination.cap-hit` log; cutoff filtered in-memory because `paginateQuery` orders by `documentId()` and Firestore rejects an inequality on a different field
- [x] Batch deletes at the 500 cap, with a final flush so the last partial batch is never left staged
- [ ] Deploy (operator's call): `./scripts/safe-deploy.sh` (see the functions `package.json` `deploy` script)
- [x] Commit

### Task 0.5: Notification catalog: merge duplicate keys, disambiguate comment labels (#10)

**Files:**
- Modify: `mytribe/functions/src/notifications/catalog.ts`
- Modify (if key aliasing needed): `mytribe/functions/src/notifications/dispatcher.ts`, `prefs.ts`
- Tests: `mytribe/functions/test/notificationCatalog.test.ts`

**Behavior:** A KinTale IS the visit report. Collapse `kincare.report.sent` and `kintale.published` into one canonical key (`kintale.published`), with `kincare.report.sent` retained as an alias so stored prefs and overrides keep working (alias resolves at dispatch and at catalog read; catalog returns only the canonical entry). Relabel for clarity:
- `kintale.published` label: "KinTale (visit report) published"
- `kintale.comment.added` label: "New comment on a KinTale (comment box)"
- `kintale.note.added` label: "Auntie added a note inside a KinTale"

- [ ] Failing tests: catalog exposes one publish key; dispatching legacy key routes to canonical prefs; prefs saved under either key are honored
- [ ] Implement alias map; deploy catalog + dispatcher functions
- [ ] Web/Android: no code change (labels are server-driven); snapshot tests updated where labels are asserted
- [ ] Commit

### Task 0.6: Booking dialog services come from Services data (#11, source half)

**Files:**
- Modify: `auntieos-admin/src/components/NewBookingDialog.tsx` (free-text service input to chip row)
- Modify: `auntieos-admin/src/lib/newBooking.ts`
- Test: `NewBookingDialog.test.tsx`, `newBooking.test.ts`

**Behavior:** Replace the free-text service `<input>` with chips sourced from `business_settings.serviceRates` (the same data `KinCareRatesEditor` edits), each chip labeled `{name} · ${rate}`, ordered by parsed duration (port `sortServiceTypesByDuration` logic from the archive `BookingViewModel`). Fallback to a plain text input ONLY when serviceRates is empty, with a hint linking to Settings.

- [ ] Failing tests: chips render from rates fixture in duration order; selection writes the canonical service name; empty-rates fallback shows input + settings hint
- [ ] Implement
- [ ] Android parity: `NewBookingRequestDialog.kt` already sources from serviceRates per archive lineage; verify with a test
- [ ] Commit

---

## Phase 1: Wire existing backend

### Task 1.1: Admin profile button + full account settings (#2)

**Files:**
- Modify: `auntieos-admin/src/components/AppShell.tsx` (topbar account chip: avatar monogram + name, links to `/account`; replaces bare role label)
- Modify: `auntieos-admin/src/router.tsx` (pass `onOpenNotifications` to Account so the dead button works; route to `/my-notifications`)
- Modify: `auntieos-admin/src/screens/Account.tsx` (add Security panel)
- Create: `auntieos-admin/src/components/SecurityPanel.tsx`
- Modify: `auntieos-admin/src/lib/auth.ts` (add `reauthenticate(currentPassword)`, `changeEmail(newEmail)` via `verifyBeforeUpdateEmail`, `changePassword(current, next)` via `reauthenticateWithCredential` + `updatePassword`; delete or wire the dead `sendReset` export)
- Tests: `AppShell.test.tsx`, `Account.test.tsx`, `SecurityPanel.test.tsx`, `auth.test.ts`

**Interfaces:**
- Produces: `changePassword(current: string, next: string): Promise<void>` throwing typed errors `{code: 'wrong-password' | 'weak-password' | 'requires-recent-login'}`; `changeEmail(current: string, newEmail: string): Promise<void>` (sends verification first, per Firebase `verifyBeforeUpdateEmail`).

**Behavior (archive reference `AccountSettingsScreen.kt` + Android `changeLoginPassword`):** Security panel = current password field, then either new email or new password + confirm. Reauth failure surfaces "Current password is incorrect." Success shows a confirmation banner; email change explains the verification email step. All error paths fail loud in a banner, never silent.

- [ ] Failing tests: chip renders and navigates; notifications button navigates (no longer a static span); password change happy path calls Firebase in order (reauth then update); wrong current password error path; weak password error path; email change sends verification
- [ ] Implement
- [ ] Android: `AccountSettingsScreen.kt` already has both flows; add missing e-mail-change test if absent
- [ ] Commit

### Task 1.2: Tribal Intel full CRUD (#21)

**Files:**
- Modify: `auntieos-admin/src/screens/TribalIntel.tsx` (row select opens detail; Add button opens form; edit + delete)
- Create: `auntieos-admin/src/components/TribalIntelForm.tsx`
- Create: `auntieos-admin/src/api/tribalIntelWrite.ts` (wraps existing callables `createTrainingDocument`, `updateTrainingDocument`, `deleteTrainingDocument`)
- Modify: `auntieos-admin/src/router.tsx` (pass `onSelect`)
- Tests: `TribalIntelForm.test.tsx`, `tribalIntelWrite.test.ts`, extend `TribalIntel.test.tsx`

**Design reference:** `page-specs/23-training-documents.md` + `ui-ideas/auntieos-training-documents-2026-05-27.html` (newest committed references; no newer mock exists in the repo). Fields per the deployed callable contract: title ≤200, content ≤20000, notes ≤4000, targetType KINFOLK|KIN with dependent kinfolk/kin pickers, attachments ≤25 via the existing media pipeline. Save gated on hasContent && hasTarget (mirror the server `.refine`s client-side with zod). Delete confirm dialog carries the honest caveat: already-reconciled text is not unmerged. Success copy states the dossier fold happens on the next nightly reconcile pass, never "immediately".

- [ ] Failing tests: create happy path invokes callable with exact payload; client zod mirrors server refinements (no-content+no-attachment rejected; KIN without targetKinId rejected); update prefills; delete confirm + caveat copy; callable error surfaces in banner
- [ ] Implement form + wiring
- [ ] Backend: no changes (callables deployed); add one emulator integration test file `mytribe/functions/test/trainingDocuments.integration.test.ts` if not present
- [ ] Android: `TrainingDocumentsScreen.kt` already has AddDocumentForm; verify edit + delete paths exist, port gaps
- [ ] Commit

### Task 1.3: MapBox address autocomplete on web (#12)

**Files:**
- Create: `auntieos-admin/src/api/mapbox.ts` (callables `mapboxSearch`, `mapboxRetrieve`)
- Create: `auntieos-admin/src/components/AddressAutofillField.tsx`
- Modify: `auntieos-admin/src/screens/KinfolkEdit.tsx:387` (serviceAddress), vetClinicAddress field, `src/components/AddKinfolkDialog.tsx:195`
- Tests: `mapbox.test.ts`, `AddressAutofillField.test.tsx`

**Behavior (port of archive `AddressAutofillField`, KinfolkEditScreen.kt L678-825):** 250 ms debounce, min 3 chars, suggestion dropdown (name + full_address), pick calls retrieve and writes back the resolved address, then rotates the session token. One random 32-hex session token reused across keystrokes so suggest+retrieve bill as a single Mapbox session. Errors: red inline banner "Address lookup failed: {message}. Type the full street address manually." Field remains a plain editable input throughout (lookup is additive, never blocking).

**Interfaces:**
- Produces: `<AddressAutofillField value onChange label required error>`, drop-in replacement for the plain TextField.

- [ ] Failing tests: debounce (no call under 250 ms/3 chars), suggestion render, retrieve-on-pick + token rotation, error banner + manual entry still works, session token stable across keystrokes
- [ ] Implement
- [ ] Note: callables are `wrapCallable` (any signed-in user) and admin sessions qualify; verify with one emulator test
- [ ] Android: `AddressAutocompleteField.kt` calls Mapbox directly with a client key; migrate it to the `mapboxSearch`/`mapboxRetrieve` callables so the key ships in zero clients (delete the key from `local.properties` usage)
- [ ] Commit

### Task 1.4: Schedule entry info cards (#16)

**Files:**
- Modify: `auntieos-admin/src/router.tsx:250` (pass `onSelect` to Schedule)
- Modify: `auntieos-admin/src/screens/Schedule.tsx` (AgendaRow becomes a button; BusyRow stays static)
- Create: `auntieos-admin/src/components/BookingDetailModal.tsx`
- Create: `auntieos-admin/src/api/bookingNotes.ts` (streams `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes`, internal + kinfolk-facing)
- Modify: `auntieos-admin/src/api/bookingsWrite.ts` (add `rescheduleBooking`, `assignAuntie`, `addBookingNote`, `addInternalBookingNote` wrappers; all callables deployed)
- Create: `auntieos-admin/src/api/staff.ts` (`listStaff` wrapper, lazy)
- Tests: `BookingDetailModal.test.tsx`, `bookingNotes.test.ts`, extend `Schedule.test.tsx`

**Behavior (port of archive `BookingDetailModal.kt`, 556 lines):** Right-side 480 px sheet over a scrim. Fact rows: kinfolk (linked to `/directory/{id}`), address, requested services, duration, date/time. Kinfolk-facing notes and internal notes lists, each with add-note composer, both locked 3 h before start (`NOTE_CUTOFF_MS = 3 * 3600 * 1000`, shared const). Inline reschedule form (date + time; end recomputed from service duration). Assigned Auntie row: lazy `listStaff` picker, optimistic swap with revert-on-error, canonical re-read after success; only envelope visits carrying `kinCareBatchId`/`kinCareVisitId` are assignable, others show why not.

- [ ] Failing tests: row click opens modal with fact rows; kinfolk link navigates; note composer disabled inside cutoff with reason; reschedule invokes callable with recomputed end; assign optimistic + revert on error; non-envelope visit shows disabled assign with explanation
- [ ] Implement modal + wiring
- [ ] Android parity: schedule tap already opens detail per `ScheduleViewScreen.kt`; verify note cutoff + assign paths match, port gaps
- [ ] Commit

### Task 1.5: Notifications feed gets context + actions (#20)

**Files:**
- Modify: `auntieos-admin/src/screens/Notifications.tsx`
- Create: `auntieos-admin/src/components/NotificationQuickActions.tsx`
- Modify: `auntieos-admin/src/api/notifications.ts` (surface `targetType`, `targetId`, `kinfolkId`, `kinfolkName` fields already present on the docs)
- Modify: `auntieos-admin/src/api/notificationsWrite.ts` or create (wire deployed `archiveNotification`, `bulkArchiveNotifications`, plus existing read/unread)
- Tests: `NotificationQuickActions.test.tsx`, extend `Notifications.test.tsx`

**Behavior (port of archive `NotificationsScreen.kt` QuickActionBar):** each row shows kinfolk name, event time, and a target chip. Actions per row: read/unread toggle; "Open" routing by `targetType` (invoice → `/invoices` detail, kintale → `/kintales` detail, kinfolk → `/directory/{id}`, booking → `/bookings`); archive; for `targetType === 'booking'`: Approve / Deny via deployed `batchUpdateBookings`; "Create quote" jumps to the Invoices quote composer seeded with `composeQuoteForKinfolkId` (thread the seed through router state like the archive threaded it through App.kt). Category filter chips. Every action fail-loud. This separates true notifications (actionable, recipient-scoped) from the Activity Log (immutable hash-chained audit), which stays untouched.

- [ ] Failing tests: routing per targetType (4 cases); approve/deny invoke batchUpdateBookings with booking ids; create-quote seeds the composer; archive removes row; unknown targetType renders no Open button (negative)
- [ ] Implement
- [ ] Android parity: `NotificationsScreen.kt` action bar check, port gaps
- [ ] Commit

### Task 1.6: KinTale templates: kill any "coming soon", close disclosed gaps (#8)

**Files:**
- Verify: `auntieos-admin/src/lib/nav.ts` + `AppShell.tsx` `LIVE_LINKS` contain `kintale-templates` (explorer says yes; assert with a test so it cannot regress)
- Modify: `auntieos-admin/src/screens/KinTaleTemplates.tsx` (add checklist-bank quick-add; default-flag exclusivity)
- Modify: `auntieos-admin/src/api/kinTaleTemplatesWrite.ts` (bank callables `listChecklistBank`, `saveChecklistBankItem`, both deployed)
- Tests: extend `KinTaleTemplates.test.tsx`, `nav.test.ts`
- Android: `KinTaleTemplatesScreen.kt` / `ChecklistEditorScreen.kt`: locate any literal "coming soon" (user report suggests Android surface); replace with the real screen wiring

**Behavior:** "Add from bank" row on each checklist editor (pulls from and saves to the shared bank, archive `ChecklistBank.kt` behavior). Setting `isDefault` on one template unsets it on others in the same service scope, in one batched write.

- [x] Failing tests: nav renders live link (no "(coming soon)" text for this slug); quick-add inserts bank item; saving default unsets prior default (batched)
- [x] Grep both apps for `coming soon` and enumerate remaining instances; any hit on our own features becomes a follow-up task in this plan, not a banner
- [x] Implement; commit

**FOUND (2026-07-25), and it was not where the audit guessed.** The literal was
`AppShell.tsx:77`'s fallback, exactly as reality-correction 1 predicted, but the
cause was not a stale nav entry: `kintale-templates` was the ONE rail slug missing
from `LIVE_LINKS`, while `router.tsx:234` had registered the route and the
756-line screen had shipped. So the rail advertised a finished screen as
"KinTale templates (coming soon)". Fixed by adding the link; `AppShell.test.tsx`
now asserts `railPendingSlugs()` is empty, which guards every entry, not just this one.

Android was clean: `KinTaleTemplatesScreen.kt` and `ChecklistEditorScreen.kt`
carry no such literal (the only Android hits are the Settings add-on rows below).

**Full inventory of every remaining `coming soon` in both apps, with disposition:**

| Where | Reachable by | Disposition |
|---|---|---|
| `auntieos-admin/src/components/AppShell.tsx:77` | operator, rail | FIXED. The fallback stays for a rail entry added ahead of its route; the test proves no shipped screen hits it. |
| `web/.../settings/SettingsScreen.kt:2449-2451`, `android/.../AdminSettingsScreen.kt:1626-1628` | operator, Settings → Add-ons | LEAVE. Third-party integrations, none built. Zapier, Make and Google Tasks each need an external credential the operator does not have yet (a Zapier/Make app registration plus its API key, and `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` for Google Tasks, the same pair Task 7.2 is blocked on). Shown honestly as unbuilt, never faked as connected. |
| `mytribe/web/src/screens/Kin.tsx:35,47,77` | kinfolk portal | FOLLOW-UP 1.6a. Add-kin from the portal. |
| `mytribe/web/src/screens/TribeHub.tsx:102,116` | kinfolk portal | FOLLOW-UP 1.6b. "All photos" / "All tales" index links. |
| `mytribe/web/src/screens/Account.tsx:284` | kinfolk portal | Already backlogged: card payments, `AuntieOS_Fix_Backlog_2026-06-02.md`. |
| `mytribe/web/src/screens/Account.tsx:322` | kinfolk portal | Already backlogged as 16.4 (Message Auntie). |
| `mytribe/web/src/screens/KinTales.tsx:254,257` | kinfolk portal | FOLLOW-UP 1.6c. Share a tale; reply to Auntie (the reply half is 16.4). |
| `mytribe/web/src/components/PortalNav.tsx:65` | nobody | DEAD BRANCH. Every entry in `NAV_LINKS` has a non-null `to`, so the inert span never renders. Left as the same "entry ahead of its route" affordance AppShell keeps. |
| `mytribe/src/.../AccountSettingsScreen.kt:263` | kinfolk portal (Compose) | Same card-payments item as `Account.tsx:284`. |
| `mytribe/seeds/notificationTemplates/kincare.auntie.departed/sms.txt:1` | kinfolk, SMS | NOT A GATE. "KinTale coming soon!" is Auntie telling a client their recap is on its way. Copy, not a stub. |
| test assertions in `Inbox.test.tsx:318`, `ScheduleScreenTest.kt:151`, `InvoiceDetailScreenTest.kt:91` | nobody | These assert the stub is GONE. Keep. |

The MyTribe portal follow-ups are listed below rather than folded into Task 1.6:
they are the kinfolk app, not the admin restoration this plan scopes, and each is
a vertical slice of its own.

### Task 1.6a: MyTribe portal, add a Kin from the roster (follow-up)

`mytribe/web/src/screens/Kin.tsx:35,47,77` render three inert "+ Add New" affordances.
AuntieOS already has `AddKinDialog.tsx`; the portal needs the kinfolk-side equivalent
plus a callable that lets a kinfolk create a kin on their own household (rules keep
`kin` callable-only for non-admins).

### Task 1.6b: MyTribe portal, "All photos" and "All tales" index screens (follow-up)

`mytribe/web/src/screens/TribeHub.tsx:102,116`. The hub shows a truncated strip of each
with an inert link to the full list. Both indexes need a bounded, paginated screen
(reuses Task 4.1's pagination hook once it lands).

### Task 1.6c: MyTribe portal, share a KinTale (follow-up)

`mytribe/web/src/screens/KinTales.tsx:254`. A share affordance needs a decision first:
a public share link is a new unauthenticated read path on `kin_care_reports` and wants
a signed, expiring token, not a rules loosening. The "Reply to Auntie" button beside it
(`:257`) is item 16.4, already backlogged.

### Task 1.7: Auntie Time scope, year display, sorting, filtering (#17)

**Files:**
- Modify: `auntieos-admin/src/screens/Sessions.tsx`
- Modify: `auntieos-admin/src/lib/sessionFormat.ts` (`groupSessionsByPhase`: Active / Upcoming / Recent(≤7 days done); day headers include year when ≠ current year)
- Modify: `auntieos-admin/src/api/sessions.ts` (two bounded queries replacing the flat 300: upcoming `startTime >= now-24h` asc, recent `startTime in [now-7d, now)` desc filtered to terminal states)
- Tests: `sessionFormat.test.ts`, `Sessions.test.tsx`

**Behavior (archive `KinCareSessionsScreen.kt` grouping):** sub-header already promises "today and coming up, plus what wrapped recently"; make the data match: phase groups Active / Upcoming / Recent only. Older history lives behind an "Archive" toggle that swaps in a date-range query (reuses Phase 4 pagination hook once it lands; until then a 30-day range picker). Sort control: Soonest first / Latest first. Filter chips stay (All/Active/Scheduled/Completed/Cancelled) and now operate within the scoped window.

- [ ] Failing tests: grouping fixture (active now, tomorrow, 3 days ago, 30 days ago → 30-day item excluded); year shown for cross-year fixture; sort toggle reverses order within groups
- [ ] Implement queries + grouping
- [ ] Android parity: `KinCareSessionsScreen.kt` already phase-groups; verify year display + sort, port gaps
- [ ] Commit

### Task 1.8: Vet clinic search dropdown + create-from-dropdown, incl. emergency vet (#13)

**UX (operator-specified):** the vet clinic field is a search box. Typing opens a dropdown of matches from the curated `vet_clinics` database. Pinned at the very bottom of the dropdown, always visible, is a **"Create '{query}' as a new vet clinic"** button that opens an inline create form (name prefilled from the query; phone, address, website, emergency toggle). Saving creates the clinic and selects it. No free-text passthrough: the field's value is always a clinic from the database.

**Backend:** no new callables. One small extension to the deployed `submitVetClinic` (`mytribe/functions/src/portal/submitVetClinic.ts`):
- staff callers (`isStaff(uid)`) land `verified: true` with `submittedBy` stamped; kinfolk submissions keep landing `verified: false` (unchanged)
- optional `isEmergency: z.boolean()` added to the schema (additive; legacy payloads still validate; contract test updated to the superset)
- existing name-normalized dedupe already returns the existing id, which the picker uses to select instead of duplicating

**Files:**
- Modify: `mytribe/functions/src/portal/submitVetClinic.ts` (staff-verified branch + `isEmergency`)
- Test: `mytribe/functions/test/submitVetClinic.test.ts` (staff → verified true; kinfolk → verified false unchanged; isEmergency persisted; legacy payload still valid; dedupe returns existing id)
- Create: `auntieos-admin/src/api/vetClinics.ts` (bounded `useCollection` stream on `vet_clinics`; admin sees verified + own pending)
- Create: `auntieos-admin/src/api/vetClinicsWrite.ts` (`submitVetClinic` wrapper)
- Create: `auntieos-admin/src/components/VetClinicPicker.tsx` (search box + dropdown + pinned create button + inline create form)
- Modify: `auntieos-admin/src/screens/KinfolkEdit.tsx:137,460-481` (replace the three plain VET_FIELDS with the picker; phone/address render read-only from the selected clinic with a "wrong info? edit the clinic" affordance deferred to the clinic record itself; add an emergency-vet picker instance filtered to `isEmergency`)
- Modify: `auntieos-admin/src/lib/kinfolkEditSchema.ts` (store `vetClinicId` + denormalized name/phone/address for display; keep legacy string fields readable for existing docs)
- Tests: `vetClinics.test.ts`, `vetClinicsWrite.test.ts`, `VetClinicPicker.test.tsx`, extend `KinfolkEdit.test.tsx`

**Search behavior (archive `VetClinicPicker` ranking):** prefix matches rank first, then substring, capped at 8 rows above the pinned create button; placeholder "Type to search N clinics"; picking autofills; Escape/click-away dismisses (same pattern as Task 0.1).

- [ ] Failing functions tests (staff-verified branch, isEmergency, legacy shape); implement; deploy `firebase deploy --only functions:mytribe:submitVetClinic`; update `CALLABLE_CONTRACT.md`
- [ ] Failing web tests: rank order, cap 8, create button always pinned at bottom (even with 0 matches), create form prefill + select-on-save, dedupe path selects existing, emergency filter, dismiss on click-away
- [ ] Implement picker + KinfolkEdit wiring; legacy kinfolk docs with string-only vet fields render without crash (negative test)
- [ ] Android parity: `VetClinicSearch.kt` gets the same pinned create button + emergency instance if absent
- [ ] Commit

---

## Phase 2: Communicate + Inbox core (#4, #5-chat)

### Task 2.1: Communicate defaults to the Auntie voice generator, restores channels (#4)

Executing agent expands this into `2026-07-24-react-port-restoration-task21.md` (micro-steps) before coding.

**Files:**
- Modify: `auntieos-admin/src/screens/Communicate.tsx` (top-level `SegmentedPicker`: **Personalize (default) / Broadcast / Recent**; recent list becomes third tab, keeping its channel filter)
- Rewrite: `auntieos-admin/src/screens/CommunicatePersonalize.tsx` (message-type chips **KinTale report / Text / Email / Blog**; recipient typeahead resolving a real kinfolkId, never fuzzy; Tone chips Warm/Cheerful/Professional/Playful; Length chips Short/Medium/Long; editable draft area; Approve promotes the draft and writes an audit entry, Firestore write first, downstream ping second, per archive ordering)
- Modify: `auntieos-admin/src/api/communicateGenerate.ts` (call `POST /api/generate` with Bearer admin ID token, payload `{messageType, tone, length, subject, notes, kinfolkId}`; hosting rewrite exists)
- Verify/modify: `auntieos-admin/web/functions/generate.js` accepts `tone`/`length`/`messageType` params (archive sent them; confirm and extend if the deployed shape only takes `tone_hint`)
- Modify: `auntieos-admin/src/screens/CommunicateCompose.tsx` (Broadcast: keep channels in-app/email/sms/push; add saved-segment picker + criteria builder against the deployed `listAudienceSegments`/`saveAudienceSegment`/`deleteAudienceSegment`/`broadcastMessage` contract; per-channel sent/skipped/failed tally rendering)
- Create: `auntieos-admin/src/components/ExternalSendPanel.tsx` ("Send outside the tribe": Email/Text picker, E.164/email client pre-flight mirroring the server, opt-out action with dedicated `recipient_opted_out` copy, `transactional` flag for 1:1 replies; callables `sendExternalMessage`, `suppressExternalRecipient` deployed)
- Create: `auntieos-admin/src/components/RecipientContextPanel.tsx` (dossier summary + Kin411 cards + last-communication box; callables `recap_recent_comms`, `synthesize_kinfolk_profile` deployed in the Python codebase)
- Tests: one spec per new/rewritten module; generator payload contract test; opt-out error-copy test; tally rendering test; segment CRUD tests

**Note on KinTale as a channel:** in the archive, KinTale participation = the "Visit report" message type in Personalize (generated copy lands in the KinTale composer flow), not a broadcast channel. Restore exactly that; do not add a fake broadcast channel the dispatcher does not support.

- [ ] Expand to micro-plan; execute; both suites green; commit per sub-task

### Task 2.2: Inbox chat keeps parity while channels land (#5, chat half)

**Files:**
- Modify: `auntieos-admin/src/screens/Inbox.tsx` (three stacked sections per archive: Notifications digest strip, Messages (existing conversations), Channels placeholder region that Task 6.x fills; unread badge totals)
- Tests: extend `Inbox.test.tsx`

- [ ] Failing tests: section order, unread totals sum conversations + notifications
- [ ] Implement; commit

---

## Phase 3: Home widgets edit mode (#9)

### Task 3.1: Dashboard layout model + persistence

**Files:**
- Create: `auntieos-admin/src/lib/dashboardLayout.ts` (pure port of Android `DashboardLayout.kt`: `"key:size"` token list, parse/serialize, `moveUp/moveDown/resize/remove/add`, shipped default when empty, WIDE solo row / COMPACT pairs packing)
- Create: `auntieos-admin/src/api/userProfileWrite.ts`. **Callable check:** archive persisted via `saveUserProfile` to `users/{uid}`. If no deployed callable covers this write for admin users, BUILD `saveDashboardLayout` in `mytribe/functions/src/admin/saveDashboardLayout.ts` (A-gated; zod: `tokens: z.array(z.string().regex(/^[a-zA-Z]+:(compact|wide)$/)).max(30)`; writes `staff/{uid}.dashboardWidgets`). Do not fall back to a client Firestore write unless rules already allow exactly this field.
- Tests: `dashboardLayout.test.ts` (pure, exhaustive: packing, default equality, move at boundaries, resize STATS forced wide), `userProfileWrite.test.ts`, functions test if callable is built

- [ ] Port model with failing tests first (Android `DashboardLayoutTest.kt` cases translate 1:1)
- [ ] Resolve persistence path (callable check above); implement
- [ ] Commit

### Task 3.2: Edit mode UI + Supply Tracker layout fix

**Files:**
- Modify: `auntieos-admin/src/screens/Home.tsx` (Customize/Done header toggle; `WidgetEditBar` per widget: ↑ ↓ resize ✕; hidden-widget ghost strip; layout driven by `dashboardLayout.ts` order, not JSX order)
- Create: `auntieos-admin/src/components/WidgetEditBar.tsx`
- Modify: `auntieos-admin/src/screens/Home.css` (replace auto-fit grid with explicit row packing: wide = `grid-column: 1 / -1`; fix Supply Tracker misalignment: constrain `.widget` internals to the grid track, `min-width: 0` on grid children so long supply names cannot blow the track)
- Modify: `auntieos-admin/src/screens/widgets/SuppliesTracker.tsx` (truncation + count alignment per `ui-ideas/auntieos-home-2026-05-27.html`)
- Tests: `Home.test.tsx` (edit toggle, move/resize/remove call model + persist, hidden strip adds), visual check against `visual/mockups/home`

**Behavior:** saves mutex-serialized onto the live profile (never clobber theme fields saved concurrently); save failure raises fail-loud banner and reverts local order.

- [ ] Failing tests; implement; run visual harness compare for `home`
- [ ] Android: already complete (`DashboardLayout.kt`); parity test only
- [ ] Commit

---

## Phase 4: Lists: search, filters, pagination, recency windows (#15)

### Task 4.1: Shared paged-collection hook

**Files:**
- Create: `auntieos-admin/src/lib/usePagedCollection.ts` (generalizes the proven `Templates.tsx` cursor pattern: server `limit` + `startAfter` doc-id/date cursor, "Load more", `hasMore`, resets on filter change)
- Create: `auntieos-admin/src/components/ListToolbar.tsx` (search input, date-range preset chips **Last 7 days (default) / 30 days / 90 days / All (archive)**, facet selects)
- Modify: `mytribe/firestore.indexes.json` (composite indexes: `kin_care_reports(createdAt desc, kinfolkId)`, `invoices(archivedAt, date desc)`, `invoices(kinfolkId, date desc)`, `kin_care_sessions(startTime desc, status)`)
- Tests: `usePagedCollection.test.ts` (cursor advance, filter reset, error surface), `ListToolbar.test.tsx`

- [ ] Failing tests; implement; deploy indexes (`firebase deploy --only firestore:indexes`)
- [ ] Commit

### Task 4.2: Apply to KinTales, Invoices, Auntie Time

**Files:**
- Modify: `src/screens/KinTalesView` (in `router.tsx`) + `src/api/kinTales.ts`: default window last 7 days, search over kinfolk name + title, kinfolk facet, Load more, "Showing N of window" honesty line (archive disclosed client-side search scope; ours becomes server-windowed so the line reads "Searching the selected date range")
- Modify: `src/screens/Invoices.tsx` + `src/api/invoices.ts`: date-range + household facet (exists) + status tabs (exist) now compose with pagination; archived excluded by default (depends on Task 5.1 field)
- Modify: `src/screens/Sessions.tsx`: archive toggle from Task 1.7 switches to the paged hook
- Tests: per-screen specs: default window, facet composition, pagination across a 250-doc fixture (cap regression guard), empty-window state

- [ ] Failing tests; implement each screen; both suites green
- [ ] Android: mirror windows + Load more in `InvoicesScreen.kt`, KinTale list, `KinCareSessionsScreen.kt` (Paging or manual cursor, match existing repo pattern)
- [ ] Commit per screen

---

## Phase 5: New-callable slices

Executing agent expands each task into its own micro-stepped TDD plan before coding. All new callables: `wrapAdminCallable`, zod schema exported for contract tests, entries in `CALLABLE_CONTRACT.md`, emulator integration tests covering happy + invalid-arg + unauthenticated + non-admin.

### Task 5.1: Invoice line items, editing, archive, un-invoiced visits (#18, #19)

**New callables (`mytribe/functions/src/admin/`):**

```ts
// updateInvoice.ts
const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
});
const UpdateInvoiceArgs = z.object({
  invoiceId: z.string().min(1),
  patch: z.object({
    invoiceNumber: z.string().min(1).max(60).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    terms: z.string().max(2000).optional(),
    lineItems: z.array(LineItem).max(100).optional(),
    invoiceDiscountCents: z.number().int().min(0).optional(),
  }).strict(),
});
// Server recomputes total and amountDue from lineItems minus payments;
// client-sent totals are ignored. failed-precondition when status is PAID.
```

```ts
// archiveInvoice.ts / unarchiveInvoice.ts
const Args = z.object({ invoiceId: z.string().min(1) });
// stamps archivedAt/archivedBy; failed-precondition on archive of unpaid non-draft with amountDue > 0 unless force: true supplied and audited
```

```ts
// listUninvoicedSessions.ts
const Args = z.object({
  kinfolkId: z.string().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
// returns COMPLETED kin_care_sessions with no invoiceId, with serviceType,
// duration, and rate-card price prefill from business_settings.serviceRates
```

Also: extend `createInvoice` schema with optional `lineItems` (same LineItem shape) while keeping the frozen legacy keys valid (additive change; contract test updated to the new superset).

**Web:**
- Rewrite `src/screens/InvoiceCreate.tsx`: two entry paths per the booking-envelope workflow: **Blank invoice** and **From KinCare** (un-invoiced session picker via `listUninvoicedSessions`, checked rows become prefilled line items). Line-item editor rows (description/qty/unit/discount, add/remove, live total from a pure `computeInvoiceTotals` in `src/lib/invoiceMath.ts`). Real `<input type="date">` fields.
- `src/components/InvoiceDetail.tsx`: Edit mode (line items + fields via `updateInvoice`), Archive/Unarchive with confirm, linked visit list rendered from `sessionIds` with each row linking to session detail (fixes "view visit list/details missing").
- `src/api/invoicesWrite.ts`: wrappers + zod mirrors.

**Design references:** `ui-ideas/auntieos-invoices-2026-05-27.html`, `auntieos-invoice-detail-2026-05-27.html`, `page-specs/16-invoices.md`, `17-invoice-detail.md`.

**Android:** same slice in `InvoicesScreen.kt`, `NewInvoiceDialog.kt`, `InvoiceDetailScreen.kt` (line-item rows, from-KinCare picker, archive action).

**Tests:** functions: recompute correctness (line items minus payments; paid-edit refusal; archive precondition), listUninvoiced excludes invoiced + non-completed; web: totals math pure tests, picker-to-line-items prefill, edit round-trip, archive confirm; Android: ViewModel math + decode tests. E2E (Phase 8 harness): create-from-KinCare happy path.

- [ ] Expand micro-plan; build callables + tests; deploy; freeze contracts
- [ ] Web slice; Android slice; commit per layer

### Task 5.2: Branding: real logo upload + MyTribe portal settings (#6)

**New callable (`mytribe/functions/src/admin/signBrandAssetUpload.ts`):** distinct name (constraint above). Zod: `{ kind: z.enum(['businessLogo','portalLogo']), contentType: z.enum(['image/png','image/jpeg','image/webp','image/svg+xml']), fileSize: z.number().int().positive().max(5_000_000) }`. Returns Cloudinary signed-upload params targeting folder `tribetails/branding/{kind}/`. Companion `confirmBrandAssetUpload` stamps the resulting URL into `business_settings` (`logoUrl` or `mytribePortal.logoUrl`) server-side, so a half-finished upload never leaves a dangling URL (two-step fail-loud, same pattern as `setMediaProfilePhoto`).

**Web (`src/screens/settings/sections.tsx:75,260`):**
- Branding section: logo preview (PawPrint glyph fallback) + Upload/Replace/Remove buttons driving a file input → signed Cloudinary upload → confirm callable. Keep wordmark/tagline/greeting/accent fields.
- MyTribe portal section grows to the full archive `MyTribeSettingsPanel` scope: portal logo upload (same pipeline), theme picker as swatch cards (enumerate known theme ids from `mytribe` theme source; replace the free-text `themeId`), banner (enabled, message, tone segmented picker, dismissMode picker), Home layout editor (per-section enabled toggle + item limit + up/down reorder; replaces the "isn't built here yet" hint), chat config (enabled, away message, hours rows with format-validation pill, max message length, messages-per-hour). All staged locally, committed together by the existing save bar via `saveBusinessSettings` nested merge.

**Android:** `Branding.kt` + `AdminSettingsScreen.kt`: same upload pipeline (re-point at the new signer), portal section parity.

**Tests:** functions: signature params shape, confirm writes correct field per kind, oversize/wrong-type rejected; web: upload happy path (mock Cloudinary POST), abort leaves settings untouched, remove clears field, Home-layout reorder serialization, chat-hours validation pill; Android: decode + upload flow tests.

- [ ] Expand micro-plan; callable pair; web; Android; commit per layer

---

## Phase 6: Inbox external channels + booking picker UX

### Task 6.1: Inbox channel streams + unified list (#5)

**Files:**
- Create: `src/api/inboxChannels.ts` (streams: `voicemails`, `calls_log`, `sms_messages`, plus email; verify email source collection against Android `InboxScreen.kt` Channel enum and the Twilio inbound writers; bounded queries, newest first, cap 200 each)
- Verify/modify: `mytribe/firestore.rules`: admin (`isAuntie`) read on those collections; writes stay server-only (the Twilio HTTPS functions are the writers)
- Modify: `src/screens/Inbox.tsx` (Channels panel: filter chips All / Voicemails / Calls / SMS / Emails; unified `InboxEntry` rows: channel icon tile, kinfolk name, counterpart number/address, preview, direction, missed/unread hint, media count; per-stream error surfaces individually; shimmer until all resolve)
- Create: `src/components/ThreadActionsCard.tsx` (native `tel:`/`sms:`/`mailto:` launchers; Play voicemail audio element; inline "Reply via SMS" composer → `sendExternalMessage` with `transactional: true`; mark voicemail read/replied writes)
- Tests: `inboxChannels.test.ts` (merge order, per-stream error isolation), `ThreadActionsCard.test.tsx` (launcher hrefs, reply payload, voicemail playback element, mark-read)

- [ ] Failing tests; rules diff + `firebase deploy --only firestore:rules` after review; implement
- [ ] Android: already complete; parity test pass
- [ ] Commit

### Task 6.2: Booking date picker rebuild (#11, picker half)

**Files:**
- Create: `src/components/AuntieDatePicker.tsx` (custom calendar grid: month nav, day cells, disabled past days; multi-select mode renders selected set as removable "Also on:" chips; design per `ui-ideas/both-booking-date-selection.png` + archive `AuntieDatePickerDialog`)
- Modify: `src/components/NewBookingDialog.tsx` (replace N datetime-local rows: single picker + time field + multi-date chips; Weekly mode keeps weekday chips + weeks 1-12 chip row per archive; live preview line "N visit(s) will be requested for approval.")
- Modify: `src/lib/newBooking.ts` (selection-set model + `expandWeekly` untouched)
- Tests: `AuntieDatePicker.test.tsx` (select/deselect, past-disabled, month nav, keyboard), `NewBookingDialog.test.tsx` (multi-date chips, weekly preview count, submit payload identical shape to today's `createMultiDateBookingRequest` contract)

- [ ] Failing tests; implement; payload contract unchanged (no backend work)
- [ ] Android: M3 date pickers already in `NewBookingRequestDialog.kt`; verify multi-date chips parity
- [ ] Commit

### Task 6.3: Twilio full setup + inbound cutover runbook (operator config, code-complete)

Deliverable: `docs/runbooks/twilio-setup-and-inbound-cutover.md`, a complete zero-assumed-knowledge document covering the ENTIRE Twilio estate this product uses, not just the three webhook fields. The executing agent loads the `twilio-developer-kit` skills (`twilio-webhook-architecture`, `twilio-studio-flows`, `twilio-messaging-webhooks`, `twilio-voice-twiml`, `twilio-cli-reference`) before writing it, and verifies every URL and SID reference against the live account via Twilio CLI (read-only) rather than guessing.

**Scope note:** this codebase integrates Twilio Serverless + Studio + Programmable Voice/SMS + the Voice SDK (Android client via `get-token`). There is NO Flex integration in the code. The runbook's audit step below inventories the live account; if Flex (or anything else) is active there, it gets documented as-found and explicitly marked in-scope or out-of-scope before any repointing, so nothing live is silently orphaned.

**Required runbook sections:**

1. **Account audit (read-only, do first):** `twilio api` / console inventory of phone numbers, Studio Flows, Serverless services + environments, TwiML Apps, Messaging Services, API keys, and any Flex instance. Record SIDs and current webhook targets in a table. This is the rollback map.
2. **Serverless service deploy:** `auntieos-admin/twilio-service/` is canonical; `twilio-functions/` is DEPRECATED (its README documents the deploy footgun; runbook restates it and says never deploy from there). Exact `twilio serverless:deploy` commands, environment variables the 14 functions need, and the resulting function URLs (`accept-call`, `check-hours`, `conference-timeout`, `conference-wait`, `get-token`, `incoming-call-client`, `notify-recording`, `notify-voicemail`, `play-recording`, `reject-call`, `screen-action`, `screen-notify`, `screen-ui`, `voicemail-choice`).
3. **Studio Flow wiring:** the inbound-call flow (screening → accept/reject → conference hold with `conference-wait`/`conference-timeout` → voicemail branch via `voicemail-choice` → recording notify). Document the current flow's widget-by-widget configuration (exported Flow JSON committed next to the runbook as `twilio-flow-inbound-call.json`), which Serverless URLs each widget calls, and how to re-import/publish it into a fresh account.
4. **TwiML App + Voice SDK client:** the TwiML App SID that `get-token` mints access tokens against, voice grant configuration, and how the Android `CallScreenActivity` client registers. Include the API Key/Secret creation step (operator does this in console; names only, values never leave the console).
5. **Phone number configuration:** for `TWILIO_FROM_NUMBER`: Voice "A call comes in" → the Studio Flow; Messaging "A message comes in" → the deployed `twilioInboundSms` URL; fallback URLs; exact console paths and equivalent `twilio phone-numbers:update` commands.
6. **MyTribe inbound cutover (the original three fields):** exact deployed URLs for `twilioInboundSms`, `twilioInboundVoicemail`, `twilioInboundCall`; where each is set (number config vs Studio widget callbacks vs recording status callbacks); reminder that all three verify the `X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`, so URL changes and auth-token rotations must be coordinated.
7. **Status callbacks:** `twilioStatusCallback` (engagement webhook) target and `TWILIO_STATUS_CALLBACK_URL` env alignment.
8. **Verification script:** after cutover, a test call and test SMS to the number; expected observable results (row appears in `calls_log` / `sms_messages` / `voicemails`, Inbox channel row renders, signature-rejection log line when replaying an unsigned request).
9. **Rollback:** repoint each field to the audited as-found value from section 1's table. One table, one column per field, before/after.

- [ ] Emulator tests with signed requests pass for all three MyTribe inbound functions (already required by 6.1; re-verify here)
- [ ] Export current Studio Flow JSON; commit alongside runbook
- [ ] Write runbook per the nine sections; every URL/SID verified against the live account, none invented
- [ ] Operator executes cutover; verification script results pasted into the runbook's sign-off block

---

## Phase 7: Calendar (#7)

### Task 7.1: Restore service-account sync panel (no secret needed)

**Files:**
- Rewrite: `src/screens/settings/sections.tsx:399` `CalendarSyncSection` (archive `GcalSyncPanel` port): editable Calendar ID field (`business_settings.calendarSyncId`, placeholder `name@group.calendar.google.com`) with dirty save bar; instruction block naming the SA email and the "See only free/busy (hide details)" share level; **Run Sync** button → `syncGoogleCalendarBusyEvents({lookAheadDays: 30})`, rendering "Imported N busy blocks." or the raw server error; "Server sync" pill; collapsed by default
- Modify: `src/api/settingsWrite.ts` (calendarSyncId save), create `src/api/calendarSync.ts` (callable wrapper)
- Tests: section spec (save, run-sync result render, error render), callable wrapper test
- Schedule already renders `booking_time_slots` busy overlays; add the archive's suppression rule (busy-load error banner hidden unless `calendarSyncId` set)

- [ ] Failing tests; implement; deploy nothing (callable exists); commit
- [ ] Android parity: locate/port the same panel in `AdminSettingsScreen.kt`

### Task 7.2: Editable calendars via Google OAuth (NEW build; SECRET-GATED)

**STOP CONDITION: requires the operator to create an OAuth 2.0 Client (web application) in Google Cloud console for project `auntieos-ttpc` and provide `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (as Firebase function secrets). Redirect URI will be the deployed `googleOAuthCallback` URL. This is the plan's only deferral.**

Once secrets exist, the slice (expand to micro-plan first):
- New functions (`mytribe/functions/src/admin/googleCalendar/`): `googleOAuthStart` (HTTP: state nonce in Firestore, scope `calendar.events` + `calendar.readonly`, offline access), `googleOAuthCallback` (HTTP: code exchange, refresh token encrypted at rest in `integrations_config/googleCalendar`, never readable client-side: rules deny), `listGoogleCalendars` (A), `disconnectGoogleCalendar` (A: token revoke + doc delete), `upsertCalendarEventForSession` (A + trigger option on session write, two-way guarded by a `source` field to prevent echo loops)
- Web: Connect Google Calendar button (opens OAuth window, polls connection doc), calendar multi-select with per-calendar sync toggles, connected-account row with Disconnect
- Android: same via Custom Tabs flow against the same endpoints
- Tests: functions (state nonce mismatch rejected, token never returned to client, echo-loop guard), web (connect/disconnect flows, poll timeout error), Android ViewModel tests

- [x] Name the two secrets to the operator
- [x] Functions, all seven entry points, built and tested WITHOUT the secret
      values: `startGoogleCalendarConnect`, `googleOAuthCallback`,
      `getGoogleCalendarConnection`, `listGoogleCalendars`,
      `setGoogleCalendarTargets`, `disconnectGoogleCalendar`,
      `pushVisitsToGoogleCalendar`
- [x] Both secret names declared in every `secrets: [...]` that needs them AND
      read in `lib/googleOAuth.ts`; a test asserts the declaration per function
- [x] `firestore.rules` denies `integrations_config` and `google_oauth_states`
      to every client, read and write; mirror re-checked
- [x] Web: connect / poll / pick calendar / push / disconnect, with tests
- [x] Contract entries + freezes (`CALLABLE_CONTRACT.md`, `callableContract.test.ts`)
- [ ] OPERATOR: create the OAuth client in Google Cloud Console, set both
      secrets, redeploy. Nothing works until then, and until then the panel says
      exactly which piece is missing.

Three deliberate departures from the sketch above, each recorded in the code:

- `googleOAuthStart` is a CALLABLE (`startGoogleCalendarConnect`), not HTTP. A
  browser navigation carries no ID token, so an HTTP start endpoint could not
  tell an Auntie from a stranger. Both clients want a URL to open anyway.
- `upsertCalendarEventForSession` is not a callable and there is no trigger. A
  per-session callable with no surface to press would be gate-dark; a trigger
  would write to a real person's calendar on the next edit of any visit, once
  per field change. What ships is `pushVisitsToGoogleCalendar`, the bulk action
  the panel exposes, following Task 7.1's callable-only precedent exactly.
- The echo loop is REFUSED, not marked. A `source` field cannot break it:
  `freebusy.query` returns start and end and nothing else, so an imported busy
  block cannot be traced back to the event that produced it. The write target is
  refused when it resolves to the free/busy calendar, `primary` included.
- The refresh token is stored in `integrations_config/googleCalendar` with rules
  denying all client access, NOT encrypted under a key of our own. That would
  need a third operator-managed secret whose loss would strand a connection no
  code path could then revoke, and it defends against nothing that can already
  run inside these functions.

---

## Phase 8: E2E harness + regression sweep (#1 umbrella)

### Task 8.1: Playwright e2e harness against the Firebase emulator

The repo has zero web e2e today; the DONE definition requires e2e per slice. Build once, then backfill the critical flows delivered above.

**Files:**
- Create: `auntieos-admin/e2e/playwright.config.ts`, `e2e/fixtures/seed.ts` (emulator seed: one admin user with claim, two kinfolk, sessions, invoices, vet clinics, notifications), `e2e/auth.setup.ts`
- Create specs: `e2e/account.spec.ts` (profile chip → password change happy + wrong-password), `e2e/tribalIntel.spec.ts` (create/edit/delete), `e2e/invoices.spec.ts` (from-KinCare create → line items → mark paid gating → archive), `e2e/booking.spec.ts` (multi-date picker → submit → approve from notifications), `e2e/inbox.spec.ts` (channel filter + SMS reply mock), `e2e/widgets.spec.ts` (customize → move/resize/remove → reload persists)
- CI wiring in whatever runs `vitest` today (verify: repo scripts / any GitHub workflow), emulator boot script

- [ ] Harness boots + auth fixture green
- [ ] One spec per Phase 0-7 slice listed above; all green
- [ ] Commit

### Task 8.2: Visual regression + slop pass on restored surfaces

- [ ] Run the existing `visual/` harness for: home, invoices, invoice-detail, communicate, inbox, settings, training-documents, schedule; diff against `visual/mockups/`; fix drifts that are regressions (not intentional deltas)
- [ ] Copy pass over all new user-facing strings against the anti-ai-slop checklist (no em dashes, no hype adjectives, fail-loud copy names the actual consequence)
- [ ] Full checks: web `tsc + vitest + build`, Android `compileDebugKotlin + testDebugUnitTest`, functions test suite; deploy functions/hosting/rules; build Android APK

---

## Dependency order and parallelism

- Phase 0 tasks are independent: parallelizable, one branch/PR each.
- Phase 1 tasks are independent of each other; 1.4 and 1.5 share router plumbing (land 1.4 first).
- Task 4.1 blocks 4.2; 4.2's invoice work composes with 5.1 (land 5.1's `archivedAt` field first or feature-flag the archived filter on field presence: presence check, not a gate).
- Task 5.1 blocks the invoice e2e in 8.1. Task 3.1 blocks 3.2.
- Task 7.2 waits on secrets; everything else proceeds.

## Risk register

| Risk | Mitigation |
|---|---|
| Contract drift breaks Android/web mirrors (34 callables unfrozen, freeze misses value-type changes) | Every touched callable gets frozen in `callableContract.test.ts` as part of its task; new callables frozen at birth |
| `createInvoice` schema extension breaks the frozen legacy shape | Additive-only optional keys; contract test asserts legacy payload still validates |
| Notification key merge (0.5) strands stored prefs | Alias resolution tested against seeded legacy pref docs before deploy |
| Cloudinary signer name collision repeat | Constraint pinned in Global Constraints; grep gate in review |
| Firestore index deploys lag behind queries (Phase 4) | Deploy indexes first, wait for READY state, then ship querying code |
| Mapbox billing spike from web autocomplete | Session-token reuse (one session per lookup), 250 ms debounce, min 3 chars: same billing profile the wasm app had |

## Self-review notes (spec coverage)

All 21 numbered issues map to tasks: #1 → the whole plan + 8.2; #2 → 1.1; #3 → 0.1; #4 → 2.1; #5 → 2.2 + 6.1 + 6.3; #6 → 5.3; #7 → 7.1 + 7.2; #8 → 1.6; #9 → 3.1 + 3.2; #10 → 0.5; #11 → 0.6 + 6.2; #12 → 1.3; #13 → 1.8; #14 → 0.2; #15 → 4.1 + 4.2; #16 → 1.4; #17 → 1.7; #18 → 5.1; #19 → 0.3 + 5.1; #20 → 1.5; #21 → 1.2. Bonus: fcm prune bug → 0.4; dead `sendReset` → 1.1; stale read-only comment in `myNotifications.ts` → delete during 1.1's PR.
