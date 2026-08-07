> STATUS 2026-08-01 (de-stale pass, corrections to the 2026-06-09 line below).
> The 06-09 line is left intact underneath because it is what agents have been
> reading all day; these are the places it is now WRONG.
>
> - **`deleteVetClinic` does not exist and will not.** PR #206 shipped the vet
>   clinics manager with `updateVetClinic` and `archiveVetClinic` instead. There
>   is deliberately no hard delete: kinfolk and household records point at a
>   clinic by id with no referential integrity and no orphan sweep, so deleting
>   would strand those households and destroy the record of what they were told
>   to dial. The 06-09 line claiming both shipped was false when written; the
>   manager itself only shipped 2026-08-01.
> - **§A item 3 is REVERSED.** Operator ruling 2026-08-01: "vet info lives on
>   household data, it can be seen on the kin profile". The canonical vet record
>   is `household_data.primaryVetClinicId` / `emergencyVetClinicId`, holding a
>   `vet_clinics` id rather than copied strings, so a correction in the manager
>   reaches every household. `kinfolk`'s eight vet fields are removed and the
>   kin profile is a READER. Do not consolidate onto Kinfolk.
> - **Members and Invites SHIPPED** (PR #203), so it is no longer a genuine gap:
>   `mintInvite`, `revokeInvite`, `setMemberPermissions`, `expireStaleInvites`,
>   plus a new `listInvites` (nothing could read invites back, so an operator
>   could send one and never learn what became of it). React and Android both.
> - **Vet selection is a search-and-select, never a text box** (operator ruling
>   2026-08-01). Create sits LAST in the results, and a near match asks the user
>   to choose rather than silently substituting. Spec 07's "phone validation on
>   vet/provider fields" is moot for the clinic itself: those fields now come
>   from the catalog row.
> - Still genuinely open from the 06-09 list: the invoice kin/pet sub-line,
>   "paid this month" (still no `Invoice.paidDate` aggregation), and the
>   `dynamic_fields` to FormSchema consolidation.
>
> STATUS 2026-06-09 (de-stale pass): the §B dependency list is largely SHIPPED. Confirmed live (web+desktop+android, deployed by 2026-06-08): `createInvoice`/`generateReceipt`/`sendInvoiceReminder`; `broadcastMessage` + audience segments; engagement tracking (`listRecentSends`); `tel:`/`sms:` launcher; time-block resolver; `rescheduleBooking`; `createKinCareSession` (now on android too); `listCategories`; `listCatalogKeys`; training-docs CRUD; markdown template editor + drag-to-category; gallery filters + kin-tagging; Phase 17 (theme/branding/dashboard/nav); `specialHours`; vet-clinics manager + `deleteVetClinic`; `inviteKinfolkToPortal`; `AuthClient.updateEmail`/`updatePassword`; Sentry web+desktop; recurring booking + `manageBookingSeries`. Parity debt (createKinCareSession web-only, Payments invoiceId split) RESOLVED. GENUINE GAPS: invoice kin/pet sub-line + kinfolk facet filter; "paid this month" aggregation (no `Invoice.paidDate`); `dynamic_fields`->FormSchema consolidation; `mintInvite`/`revokeInvite`/`setMemberPermissions`/`expireStaleInvites`; wiring the shared-form a11y/blur primitive into screens.

# AuntieOS — Master Full-Stack Dependency List

Every backend/data/wiring blocker surfaced across the 29 page specs, deduplicated and grouped. Per CLAUDE Rule 2, each item is **backend → API/data layer → routes/wiring → frontend**, brought to **web + desktop + Android parity** with **all test types**. Per Rule 1, nothing here gets a hardcoded placeholder; until the real path exists, the UI ships dark behind a fail-loud "Not wired" banner.

Order: **§A shared/high-leverage first** (fix once, many screens benefit), then **§B per-screen**, then **§C open product decisions**.

---

## §A — Shared / cross-cutting (highest leverage)

1. **Kin photo pipeline — `Kin.profilePictureUrl` + real image upload (bytes/picker).**
   Blocks: 03 directory chips, 04 profile rows, 06 kin hero, 08 kincare hero, 28 media avatars, 29 settings profile pic (`FF_PROFILE_PIC_UPLOAD`). Note the existing `uploadMedia` path passes an empty `ByteArray` on web; the wasmJs actual short-circuits to a real Cloudinary signed upload — desktop/Android actuals must be verified or gated. (Specs 03,04,06,08,28,29)

2. **Shared form primitive overhaul — `BottomBorderField`/`MultilineField`.**
   (a) a11y/visibility: resting line weight, optional fill, WCAG contrast, screen-reader label/required/error semantics. (b) **on-blur validation**: per-field touched state + field-specific error messages (this is Phase 0.3 in the backlog). Benefits every form. (Specs 05,07; backlog 0.3, 4.x)

3. ~~**Vet consolidation onto Kinfolk (single source) + read-only inheritance on Kin.**~~
   **REVERSED AND SHIPPED 2026-08-01 (PR #206).** The operator ruled the other
   way: "vet info lives on household data, it can be seen on the kin profile".
   Canonical is `household_data.primaryVetClinicId` / `emergencyVetClinicId`,
   holding a `vet_clinics` id, so one correction in the manager reaches every
   linked household. `kinfolk`'s eight vet fields are removed by
   `mytribe/scripts/backfillKinfolkVetToHousehold.ts`, which deletes them
   explicitly rather than by omission (Android's `updateKinfolk` merges, so an
   unmodelled field survives untouched). The kin profile, Household Data and the
   portal are all readers. Do not consolidate onto Kinfolk.
   (Specs 04,06,07,08; backlog 5.4)

4. **Real category list (`template_categories` collection or `listCategories` callable, server-deduped).**
   Replaces free-text/optional categories + hardcoded `FILTER_OPTIONS`. Blocks: 24 template bank, 23 training docs, 19 communicate. (Specs 19,23,24)

5. **Dynamic-fields consolidation — unify `form_schemas`/`FormSchema` with `dynamic_fields`/`DynamicField`.**
   Pick one survivor, migrate (fail loud on unmappable), repoint consumer screens (Kinfolk/Kin/KinTales/pet profile + the precare checklist 5.5), retire the loser's UI, fix the stale `DynamicFieldsManagerScreen.kt` KDoc, dedupe the `NEW_SCHEMA_ID`/`FORM_SCHEMA_NEW_SENTINEL` constants. (Specs 26,27; backlog 5.5, Phase 14)

6. **Shell-level top bar — global search + notification bell + unread-count source.**
   One placement in `AppShell.kt`; bell routes to Notifications, ping reflects a real unread count. Blocks: 01,20,21 and the home notification badge (backlog 2.7, Phase 10).

7. **`StatCard` `trendTone` param** — tint a computed positive delta teal / negative coral (driven by sign, never a literal). (Spec 01; reusable on any stat surface)

8. **Time-block field/resolver on `KinCareSession` (or Business-Settings block resolver).**
   "Evening block" descriptors on Auntie Time, Bookings cards, create chips. (Specs 14,15)

9. **Reschedule-session callable** — shared by Schedule drag-to-reschedule and Bookings bulk/per-card Reschedule. (Specs 13,15)

10. **GPS/route read keyed by session/`visitRouteId` + render the existing `RouteMap`.**
    Real route distance/time + the "today's route" map. Blocks: 10 composer, 11 report, 14 auntie-time. (Specs 10,11,14)

11. **`tel:`/`sms:` platform launcher (expect/actual).** So Call/Text actions stop being dead no-ops. (Spec 04; reusable)

12. **Central feature-flag registry promotion.** Move the local dark `FF_` consts into `FeatureFlags.kt` (+ MyTribe shared doc): listSearch, scheduleNewVisit, scheduleGoogleCalBusy, scheduleDragReschedule, bookings.bulkSelect, time-block labels, multi-pet avatars, view-as-kinfolk, pet-mood, comment-thread, formschema live-preview, invoice header/create/reminder/receipt, payments search/invoice-link, training-doc create/comm-filter, template search/echo/unbound-hint, schema search/count/row-delete. (All specs)

13. **Tri-platform parity reconciliation (Rule 2).** Every screen's web changes mirrored to desktop (JVM) + Android, with unit/component/integration/e2e tests per component.

---

## §B — Per-screen backend/data work

**01 Home:** weekly-revenue aggregation (current + prior week % delta); `GeneratedDraft` title + timestamp; breed/species + household join on sessions.

**02 Sign-in:** Compose-Wasm **autofill bridge** (DOM `<input autocomplete>`/`<form>` overlay vs. dark banner) + save-credential-on-submit; explicit **focus-traversal chain** + `keyboardActions(onNext)`.

**03 Directory:** surname-sort comparator (`lastName`, tiebreak `firstName`); last-visit-per-kinfolk source (max `completedAt` or denormalized `lastVisitAt`); onboarding/"New" flag + KinTale-count per kinfolk; `Kin.createdAt/updatedAt`; optional `neighborhood`/`serviceArea`; optional pet-name search on the Kinfolk tab.

**04 Kinfolk profile:** tabbed structure (new `AuntieTabBar`); KinTales-by-kinfolk feed; Upcoming-visits-by-kinfolk feed; Invoices-by-kinfolk feed; batch the per-row `kin411Stream`.

**05 Kinfolk edit:** required + relocate Service address & Emergency contact under Identity (validators, `canSave`, `*`, legacy-blank handling); remove Preferred-contact + Best-time AND resolve their downstream reads (`contactOverride` reconcile); Android phone-validation parity (port `isValidPhone`, regression-test "6-digit rejected").

**06 Kin detail:** species/breed catalog (curated set or Firestore `breeds`, species-filtered, "Other" escape) + migrate free-text; gender requiredness + "Gender" label (+ optional `sex`→`gender` rename/migration); structured per-pet `ChecklistItem` via FormSchema (replaces free-text `Kin.checklist`) with "renders in tale" linkage.

**07 Household data:** convergence decision (household-data dossier vs single-source Kinfolk address/access — avoid double-authoring); phone validation on vet/provider fields.

**08 KinCare detail:** per-visit Rate source (service-type price or invoice line); `sourceBookingId` → booker name + date; linked/draft KinTale resolution; `invoiceId` → invoice number + route.

**10/11 KinTale composer/report:** `KinCareReport.title`/headline; `KinCareReport.visibility`; `KinCareReport.coverImageId`; persisted last-saved timestamp ("autosaved {relative}"); real recipient/household-name join (kills the hardcoded "Send to the Wrens"); kin name/species join by `kinIds`; **Comment model + reply callable + stream** (net-new); send pipeline writes `deliveryReceiptId`.

**12 KinTale template editor:** `FieldCondition` editor + write path (the one genuinely unbuilt template feature); reconcile web/Android parity for pet-mood/review-booster/mood-options.

**13 Schedule:** Google Calendar busy-sync source + stream (the core "full event calendar" backend); `createKinCareSession`/scheduleNewVisit callable; move "today's route / active visits / upcoming care windows" copy off Schedule onto Auntie Time; week grid fill-width (not fixed 132.dp + scroll).

**14 Auntie Time:** today's-stops ordering + per-stop coordinates/geocode source; render `RouteMap` here (currently never rendered on this screen); per-kin avatar join.

**15 Bookings:** batch booking-action callable (bulk Approve/Reject/Cancel); wire `requestBooking` `visits[]`+`pattern` (multi-date + recurring); specific-start-time field on the request; distinct `cancelBooking` vs `rejectBooking`; organize History (sorted/capped/grouped, not raw rows).

**16 Invoices:** monthly paid-total aggregation; kin/pet sub-line join onto the invoice's kinfolk; kinfolk facet-filter source; action callables `createInvoice`/`sendInvoiceReminder`/`generateReceipt`/`reviewAndSendDraftInvoice`.

**17 Invoice detail:** `paymentsForInvoice(payments, invoiceId)` filter (use the **existing** link instead of the kinfolk heuristic); write `invoiceId`/`invoiceNumber` at record time via existing `recordPayment`; header-action callables (`generateReceipt`, `sendInvoiceReminder`) + Record-Payment entry point.

**18 Payments:** re-home under Invoices (keep `#/payments` resolvable); shared invoiceId-at-record write.

**19 Communicate:** wire `CommunicationType` selector to `generate` (enum exists — confirm each type honored downstream); blog/social recipient-less rule + publish target; real about/subject field or template title/category picker; template channel/type binding from `templatesStream`; **`broadcastMessage` callable (does not exist)**; bless `N8nClient.sendMessage` as a screen-level external send; engagement-metrics source for open/read rates.

**20 Inbox:** Inbox/Notifications vocabulary + placement decision; `markAllInboxRead` callable + cross-channel read model; per-channel unread-count source.

**21 Notifications:** shell-bell ping + home entry-point; real per-recipient read flag + `markRead`/`markAllRead`; body text + action target on `NotificationEntry`; per-action callables (accept/open/send-reminder); current-time source for relative timestamps.

**22 Activity Log:** activity-detail surface + `targetCollection`→`Destination` resolver (clickable rows); `seq`/`prevHash`/`entryHash` on the web `ActivityLogEntry` + bridge deserialize (real hash-chain rail; currently honest "no hash" pill); server-side ordered + paginated `activity_log` listener (removes the 500-cap truncation).

**23 Training Documents:** `createTrainingDocument`/`update`/`delete` callables (none exist; screen is read-only, Save correctly disabled); attachment/screenshot storage (Cloud Storage ref); Kinfolk + Kin target picker (replace free-text `kinfolkRef`); reconcile-pipeline wiring so saved entries feed `Dossier`/`Kin411` `rawSummary` + AI blurbs.

**24 Template Bank:** rich HTML/rich-text editor component + image-upload storage; reusable drag-and-drop primitive (category assignment incl. seeded); category editable in edit mode incl. seeded (flows through existing `saveTemplate`).

**25 Template Assignment:** `listCatalogKeys` callable (unblocks "unbound catalog keys" hint); server `assignTemplate` change to stop defaulting blank `triggerKey` to `catalogKey`; delete/unassign-binding callable.

**26 FormSchema List:** (covered by §A.5) + consumer-screen audit & repoint to the survivor.

**27 FormSchema Editor:** server-side snake_case key/id derivation in `saveFormSchema` (stop the admin typing keys); placement target on the unified model + placement-anchor registry on consumer pages + render wiring ("applies to where"); shared runtime form-preview renderer (unblocks `FF_FORMSCHEMA_LIVE_PREVIEW`).

**28 Media Gallery:** upload contract/parity (resolve empty `byteArrayOf()`; verify desktop/Android `platformUploadMedia` or gate dark); real `uploadedBy` from `AuthClient` (replace hardcoded "auntie"); render `isProfilePhoto` badge + hover caption (description/uploadedAt/uploadedBy).

**29 Settings:** notification-type **matrix** on `BusinessSettings` driven by the real notification types Cloud Functions emit, with legacy-boolean migration + the client-choice surface; theme/appearance persistence field + hydrate/write (and theme-token wiring for extra axes); per-panel Save / unsaved-changes guard (Business hours + Notifications); `AuthClient.updateEmail` + `updatePassword` (re-auth) + optional revoke-sessions; personal time-off storage distinct from business closures + `specialHours` editor; KinCare-types editor over `serviceRates` (ordered storage if reorder must persist — a `Map` can't); Vet-clinics editor over existing CRUD (+ `deleteVetClinic`); integrations OAuth/connect + Google Calendar sync backend; Members + Invites callables (`mintInvite`/`revokeInvite`/`setMemberPermissions`/`expireStaleInvites` — **not found in repo; verify or build**, likely route under Directory/Household); admin-count source for "Sole admin".

---

## §C — Product decisions (RESOLVED 2026-06-02; full text in AuntieOS_Combined_Execution_Plan_v2.md)
1. Inbox/Notifications → **separate** (Inbox = conversations, Notifications = alerts/bell). (20,21)
2. Templates → **merge, two tabs**; binding = template↔trigger event. (24,25)
3. Training Documents → **rename "Tribal Intel."** (23)
4. Activity Log ↔ Sentry → **separate + failure→Sentry bridge + add Sentry to web/desktop.** (22)
5. Record Payment → **invoice detail + row quick action.** (17)
6. Appearance → **full Customization system** (Phase 17): theme + dashboard layout + branding + nav editor. (29,01,shell)
7. Household vs Kinfolk address → **one source, read-through (Kinfolk owns).** (07)
8. Members/Invites → **re-home to Directory/Household + MyTribe + KinTale share; out of Settings.** (29→Directory/MyTribe/11)
9. Kin detail → **separate page, already built; kin FK-tied to Kinfolk** (correct 06 wording). (06)
10. Search/bell → **shell-level.** (01,20,21)
11. MyTribe grouped/recurring → **parent booking doc** (resolves D1 16.5, backs 16.3). (15,MyTribe)

## §D — New work items created by the decisions
- **Sentry web (Wasm) + desktop (JVM) coverage** + the failure→Sentry link on Activity Log entries (`status != SUCCESS`). (D4; spec 22)
- **Parent booking doc** model + series-level approve/cancel + recurring expansion (`createRecurringBooking`). (D11; spec 15, MyTribe 16.3/16.5)
- **Invite/share callables (net-new):** `inviteKinfolk` (Auntie→kinfolk), `inviteSecondaryKinfolk` + permission model (primary→secondary, MyTribe), `shareKinTaleExternal` (primary shares a KinTale via link; ties `FF_VIEW_AS_KINFOLK`). (D8; specs 29→Directory/MyTribe/11)
- **Customization/personalization layer (Phase 17):** per-user prefs doc (accent, density, text-scale), editable branding (logo + home title), saved **dashboard layout** model (drag-drop + resizable cards), saved **nav config** (rename/reorder sections, move links). Persisted (ties §A foundations) + tri-platform. (D6; specs 01,29,shell)
- **Templates merge:** one screen w/ Bank+Assignment tabs; `triggerKey` binding model (pairs with §B 25's `assignTemplate` fix + `listCatalogKeys`). (D2; specs 24,25)
- **Record Payment wiring:** write `invoiceId`/`invoiceNumber` at record time via existing `recordPayment`, entry points on invoice detail + row. (D5; spec 17)

## §E — Build-log: deferred & parity-debt (live; from CLI runs)
Items surfaced during building that are **honestly gated/deferred, never faked**. These are NOT "done" — each has a named backend/data blocker and stays open until closed.

**Parity debt (web-only today; Rule 2 not yet met — needs a backend data-model change to reach web+desktop+Android parity):**
- **`createKinCareSession`** — gated/web-only; the data model can't honestly back the session-create path on both platforms yet. Close = backend session-create contract that web AND Android share. (ties §A.9, §B 13)
- **Payments `invoiceId`** — web-vs-Android data-architecture split on the payment↔invoice link. Close = a single shared write path that stamps `invoiceId`/`invoiceNumber` at record time on both platforms. (ties §D Record Payment, §B 17/18)

**Phase 7 / Invoices — still-gated backend blockers (correctly dark):**
- Invoice-list **kin/pet sub-line join** + **kinfolk facet filter** (spec 16 items). (ties §B 16)
- **Re-home Payments under Invoices** (IA change). (ties §B 18, Decision 5)
- Gated callables: **`createInvoice`**, **send-reminder**, **generate-receipt**, **paid-this-month aggregation** (the Home revenue stat too). Each is a real backend blocker; UI stays dark behind a Not-wired banner until they land. (ties §B 16, §B 01)

**Deferred (dependency-ordered, not blocked-forever):**
- **5.4 KinTale "renders in tale" linkage** — per-pet `ChecklistItem` → KinTale link deferred; depends on the FormSchema/ChecklistItem consolidation (1C) landing first. (spec 06 item 5)

> Status legend: a feature is **complete** only when its data path is real AND web+desktop+Android match AND tests pass. Anything above is **deferred** (named blocker) — track to closure, don't check off.
