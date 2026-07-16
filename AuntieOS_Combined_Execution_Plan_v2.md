# AuntieOS — Remaining Work (canonical) — Stages -> Phases

ONE vocabulary: **Stages** = build-order buckets; **Phases** = numbered feature
areas inside them (from the backlog). No "Waves" (that term is retired).
This is the authoritative remaining-work order. The original
`AuntieOS_Combined_Execution_Plan.md` is the full reference (Stages/Phases defs +
resolved decisions, still binding); `docs/2026-06-05-incomplete-features-execution-plan.md`
is SUPERSEDED by this file.

Stages 0 (foundations) and 1 (shared pipelines) are COMPLETE. Stage 2 (screens)
is mostly complete; what remains is its tail plus Stage 3 (MyTribe-flagged) and
Stage 4 (customization).

## DEFINITION OF DONE (the gate — nothing is "Done" until ALL hold)
1. Backend callable (if needed) exists + exported in `functions/src/index.ts` + **DEPLOYED** (written != deployed).
2. Input validation (zod/args) on the callable.
3. Client method + screen **reachable via a nav route** on web, desktop, android.
4. Real UI bound to **real data** on web + desktop + android. No placeholder, no hardcoded value, no "not wired" banner standing in for the feature. Gated-dark / "not wired" is NOT a done state AND NOT an allowed resting state for our own code: a missing callable = BUILD it. Gate-dark is only a transient scaffold while a build is in flight, never an end state. The ONLY deferral is an EXTERNAL SECRET, and only by stopping to name the exact secret.
5. Fail-loud error paths.
6. Tests on each platform: unit + integration + UI; happy/sad/negative/error. (Extract logic into pure helpers so it is testable; inline-untested lambdas are a DoD miss.)
7. Verified green (web jvmTest+wasm, android testDebugUnitTest, MyTribe tsc+vitest) + shipped (web hosting live, APK built, functions deployed).
Mock/test data is allowed ONLY in tests + the test-admin sandbox (below). Track partials honestly; never mark half-stack as Done.

---

# REMAINING BUILD ORDER

## STAGE 0 tail — testing infrastructure (do early; it makes everything else safe to verify)
- **0I Test-admin sandbox** [CODE DONE 2026-06-05; rules-deploy+seed OPERATOR-GATED]. Hard rules-enforced isolation via testTribeId claim; client test-mode + banner + scoped queries web/desktop/android. Residual: media_files needs a kinfolkId field for explicit hard filter (0I.2). See project_test_admin_sandbox.
- **0C-finish Global search** (Phase 2) [DONE + SHIPPED 2026-06-05]: real search across kinfolk/kin/KinTale, web/desktop/android, flag removed, deployed.

## STAGE 2 tail — screen delivery (quick -> heavy)

### Step 1 - Money + admin quick wins [DONE + SHIPPED 2026-06-05] (4 new callables deployed: sendInvoiceReminder, batchUpdateBookings, bulkMarkNotificationsRead, listCatalogKeys; all 6 features wired real web/desktop/android; flags removed, registry 17; web live + APK 15:20). clientPaymentsHeuristic (android invoice<->payment link) still pending: needs Payment.invoiceId/model touch, tracked in Step 2.
- Phase 7 `invoices.headerActions` — wire existing generateReceipt + the reminder button.
- Phase 7 `invoices.sendReminder` — new `sendInvoiceReminder` onCall + per-row + header.
- Phase 7 `invoices.reviewAndSendDraft` — draft->sent via postInvoiceEvent + UI.
- Phase 6 `bookings.bulkSelect` — new batch approve/reject/cancel onCall + multi-select.
- Phase 10 `inbox.bulkMarkRead` — new bulkMarkNotificationsRead onCall + multi-select.
- Phase 13 `templateAssignment.unboundCatalogHint` — new listCatalogKeys onCall + hint.

### Step 2 - Derivations / data joins (mostly client over loaded data)
- Phase 3 `directory.lastVisit` — last completed session per kinfolk.
- Phase 3 `directory.newBadge` — isNew rule + badge.
- Phase 6 `auntieTime.multiPetAvatars` — stacked kin avatars per stop.
- Phase 2 `home.weeklyRevenueStat` — weekly paid-invoice aggregation + tile.
- Phase 6 `schedule.dragReschedule` — drag gesture -> existing rescheduleBooking.
- Phase 7 `invoices.clientPaymentsHeuristic` — build android invoice-detail screen (web has it) -> parity -> ungate.

### Step 3 - Shared renderer
- Phase 14 `formschemas.livePreview` — shared runtime form renderer reused by editor preview AND precare/kinfolk forms.

### Step 4 - Notifications actions + Quotes (decided)
- Phase 10 `notifications.quickActions` — read/unread model + open-linked + dismiss/archive + quick approve/deny.
- Phase 7 (NEW) **Quotes** — quote model + compose-a-quote from a notification + optional send-to-kinfolk on creation.

### Step 5 - External send (decided: email + SMS)
- Phase 9 `communicate.externalSend` — SendGrid + Twilio + consent/opt-out + audit + confirm.

### Step 6 - Audience segments + Broadcast (decided: saved segments + multichannel)
- Phase 9 (NEW rail) **Audience-segment model** + resolver (also reusable by notifications targeting).
- Phase 9 `communicate.broadcast` — compose -> segment -> in-app/email/sms/push fan-out; new broadcastMessage onCall.

### Step 7 - Inbox conversations (largest in Stage 2; ties to 16.4)
- Phase 10 conversations/messages model + AuntieOS Inbox two-way threads (Decision 1).

### Verify-first within Stage 2 (may be stale vs live, complete if missing)
- Phase 15 `15.2` notification-type x channel matrix on BusinessSettings (HIGH priority).
- Phase 13 Template Bank rich editor / HTML-images-links (13.3/13.4), readable view (13.6), drag-drop category assign (13.8).
- Phase 13 KinTaleTemplateEditor condition-editor (currently web-only "TBD" affordance, android lacks it).
- Phase 8 KinTale composer hardcoded strings.

## STAGE 3 — MyTribe flagged (Phase 16; spans both apps)
- 16.4 Message Auntie -> shares the conversations model from Stage 2 Step 7 (largest, both apps).
- 16.2 Invoice PDF download (client print-to-PDF).
- 16.3 Recurring visit + createRecurringBooking (builds on the shipped 1G parent-booking doc).
- 16.5 mytribe.booking.envelope finish.

## STAGE 4 — Customization (Phase 17; after core screens stable)
- 17.1 Theme basics (accent / density / scaling; persist users/{uid} prefs).
- 17.2 Branding (editable logo + home title/greeting).
- 17.3 Dashboard drag-drop + resizable cards.
- 17.4 Nav editor (rename/reorder/move nav links; fail-loud on disabled target).

## Phase 15 `settings.integrationManage` — mostly BUILDABLE (not parked wholesale)
The Integrations screen lists Firestore / n8n / FCM / Twilio - all configured via
secrets we ALREADY hold. So "Manage" for owned integrations (view/edit config,
health, the calendar id we already did) is BUILDABLE, no external secret - build it
to DoD. Calendar is already solved via the service-account model (no OAuth).
PARKED sliver (only if adopted): a brand-new OAuth-connect provider that needs
external creds we do not have - concretely **Stripe Connect** (`client_id` +
restricted secret key). Name it + stop ONLY when Stripe (or another new OAuth
provider) is actually in scope; otherwise nothing here is deferred.

---

## STAGE 5 — Screen-to-mock fidelity pass (NEW 2026-06-09)
The Den redesign baselined goldens via Roborazzi capture-only, which photographs
whatever the app already renders and therefore proves NOTHING about mock-match.
Several screens ship "honest but not to mock": real data bindings + fail-loud
NOT-WIRED banners, but NOT the mock's layout/structure. Per-screen deltas are
already written in `page-specs/NN-*.md` (current -> desired, each item named to
real code, mock literals flagged PLACEHOLDER per their Rule 1). Those specs are
the canonical delta list for this stage.

CAVEAT before building any item: the page-specs were authored ~2026-06-02 and
several now OVERSTATE the gap. They predate Steps 6 to 18 and call shipped
features "missing" (e.g. broadcast in spec 19, theme/branding/vet-clinics in
spec 29, gallery filters in spec 28, drag-category in spec 24). Re-validate each
spec item against current code before building. `page-specs/18-payments.md` is
moot (the Payments screen was archived to `archive/removed-payments-screen/`).

Confirmed code-behind-mock gaps (re-verified 2026-06-09):
- **Phase 4 `kinfolkProfile.toMock` (FLAGSHIP)** [`page-specs/04-kinfolk-profile.md`].
  web + android `KinfolkProfileScreen` is still a single Column of panels with
  Spacer separators, NOT the tabbed / two-column mock. Spec lists a 9-item
  full-stack delta, each to DoD: tabbed profile structure (web+desktop+android);
  vet single-source moved to `HouseholdData` (primaryVet regular + emergencyVet)
  per operator 2026-06-09, canonical decision in spec 04 item 3: repoint profile
  + Kin read-only vet + the vet-bank picker + KinCare-detail off
  `Kinfolk.vetClinic*` onto HouseholdData, deprecate/migrate that field, android
  Add-Kin drop per-kin vet, retire `Kin.vetInfo`, remove `vetInfo` from the
  KinTale condition catalog; per-kin MEDICAL stays (cross-cuts spec 06); `tel:`/`sms:` platform launcher (expect/actual) so the
  hero Call/Text quit being dead no-ops; New KinTale CTA into the composer
  pre-scoped to the kinfolk; KinTales-by-kinfolk feed; upcoming-visits-by-kinfolk
  feed; invoices-by-kinfolk feed (reuse `outstandingBalance`); Kin
  `profilePictureUrl` + upload (shared with Directory + spec 06); batch the
  per-row `kin411Stream` (perf).
- **Phase 4 `kinDetail.toMock`** [`page-specs/06-kin-detail.md`]. Remove the
  editable per-kin vet box (becomes read-only inherited from household vet); Kin
  photo. Cross-cuts the kinfolk-profile vet consolidation; do them together.
- **(audit) the remaining ~26 specs**. Run a fidelity audit per screen against
  its `ui-ideas/*.html` mock, discard the stale "missing" items, build the
  genuine code-behind-mock deltas to DoD. Emit a short per-screen verdict so this
  stage has a real checklist instead of self-baselined goldens.

DoD reminder: this stage does NOT get to lean on Roborazzi goldens for proof. A
fidelity item is Done when the structure matches the mock on web + desktop +
android, data stays real (no hardcoded mock literals, Rule 1), and per-platform
tests pass.

---

## Standing rules (unchanged, every item)
Fullstack + tri-platform parity + tested per piece. Fail loud, never fake. Follow
the mocks. No em/en dashes. Auntie* components only. Operator authors customer-facing
copy. Per piece: meet the DoD above, remove the flag (web==android registry parity),
verify green, batch-redeploy at end of each Step (web hosting + APK + changed
functions, `functions:mytribe:<name>`).

*v2 2026-06-05. Stages/Phases canonical; Waves retired. DoD gate added after an
adversarial completeness audit found web filter-test debt + an android busy-overlay
fidelity gap (both now fixed) and confirmed zero silent fakes.*
