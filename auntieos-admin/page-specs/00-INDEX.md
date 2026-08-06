> STATUS 2026-06-09 (de-stale pass): broadcast + external send are LIVE, not dark (`broadcastMessage` + audience segments + engagement tracking shipped). Treat any "gated dark behind FF_*" note here as stale. OPEN code-hygiene: a `FirestoreClient.kt` KDoc still points to a nonexistent `DynamicFieldsManagerScreen.kt`; the `dynamic_fields` collection has no CRUD screen (decision pending: migrate into FormSchema or keep as a read-only catalog).

# AuntieOS Page Specs — Index

29 per-screen "current → desired" deltas, each grounded in the real mock HTML (`ui-ideas/auntieos-*-2026-05-27.html`) and the actual Compose code (`web/composeApp/.../screens/`). Built for Claude Code to work from directly.

## How to read a spec
Every file follows the same shape (defined in `01-home.md`):
- **Header** — the source-of-truth mock, the current web + Android code paths, shared components.
- **‼️ TWO NON-NEGOTIABLE RULES** (verbatim in every file):
  1. **Mock values are placeholder — never hardcode them.** Bind to real data or gate dark behind a "Not wired" banner. (You caught this; it's now law.)
  2. **Every fix is full-stack + tri-platform parity + fully tested** — backend → API → wiring → frontend, brought to parity across web (Wasm), desktop (JVM), Android, with all test types.
- **Numbered elements** — each with **Current** (real code, cited to file + lines), **Desired** (mock structure), **Fix** (named to real components), **Dependency** (data/backend path to build).
- **Out of scope** + a **Dependency / full-stack work list**.

The master, deduplicated blocker list across all screens is in **`00-DEPENDENCIES.md`**.

## Reading / build order
Foundational shared work first (see `00-DEPENDENCIES.md` §A), then screens. Suggested screen order mirrors the nav and the `AuntieOS_Fix_Backlog_2026-06-02.md` phases.

| # | Spec | Mock | Primary current code |
|---|------|------|----------------------|
| 01 | `01-home.md` | auntieos-**redesign** (not -home) | screens/home/HomeScreen.kt |
| 02 | `02-sign-in.md` | auntieos-sign-in | screens/auth/SignInScreen.kt |
| 03 | `03-directory.md` | auntieos-directory | screens/directory/DirectoryScreen.kt |
| 04 | `04-kinfolk-profile.md` | auntieos-kinfolk-profile | screens/directory/KinfolkProfileScreen.kt |
| 05 | `05-kinfolk-edit.md` | auntieos-kinfolk-edit | screens/directory/KinfolkEditScreen.kt |
| 06 | `06-kin-detail.md` | auntieos-kin-detail | screens/directory/KinEditScreen.kt |
| 07 | `07-household-data.md` | auntieos-household-data | screens/directory/HouseholdDataScreen.kt |
| 08 | `08-kincare-detail.md` | auntieos-kincare-detail | screens/sessions/KinCareDetailScreen.kt |
| 09 | `09-kintale-logs.md` | auntieos-kintale-logs | screens/kintales/KinTaleLogsScreen.kt |
| 10 | `10-kintale-composer.md` | auntieos-kintale-composer | screens/kintales/KinTaleComposeScreen.kt |
| 11 | `11-kintale-report.md` | auntieos-kintale-report | screens/kintales/KinTaleReportScreen.kt |
| 12 | `12-kintale-template-editor.md` | auntieos-kintale-template-editor | screens/kintales/KinTaleTemplateEditorScreen.kt |
| 13 | `13-schedule.md` | auntieos-schedule | screens/schedule/ScheduleScreen.kt |
| 14 | `14-auntie-time.md` | auntieos-auntie-time | screens/sessions/KinCareSessionsScreen.kt |
| 15 | `15-bookings.md` | auntieos-manage-bookings + auntieos-create-booking | screens/booking/BookingScreen.kt |
| 16 | `16-invoices.md` | auntieos-invoices | screens/invoices/InvoicesScreen.kt |
| 17 | `17-invoice-detail.md` | auntieos-invoice-detail | screens/invoices/InvoiceDetailScreen.kt |
| 18 | `18-payments.md` | auntieos-payments | screens/payments/PaymentsScreen.kt |
| 19 | `19-communicate.md` | auntieos-communicate (+ email-creation, marketing-blasts) | screens/communicate/CommunicateScreen.kt |
| 20 | `20-inbox.md` | auntieos-inbox | screens/inbox/InboxScreen.kt |
| 21 | `21-notifications.md` | auntieos-notifications | screens/notifications/NotificationsScreen.kt |
| 22 | `22-activity-log.md` | auntieos-activity-log | screens/activity/ActivityLogScreen.kt |
| 23 | `23-training-documents.md` | auntieos-training-documents | screens/trainingdocs/TrainingDocumentsScreen.kt |
| 24 | `24-template-bank.md` | auntieos-template-bank | screens/admin/TemplateBankScreen.kt |
| 25 | `25-template-assignment.md` | auntieos-template-assignment | screens/admin/TemplateAssignmentScreen.kt |
| 26 | `26-formschema-list.md` | auntieos-formschema-list | screens/admin/formschemas/FormSchemaListScreen.kt |
| 27 | `27-formschema-editor.md` | auntieos-formschema-editor | screens/admin/formschemas/FormSchemaEditorScreen.kt |
| 28 | `28-media-gallery.md` | auntieos-media-gallery | screens/media/MediaGalleryScreen.kt |
| 29 | `29-settings.md` | auntieos-settings (+ business-hours, user-profile, kincare-types, vet-clinics, members, invites) | screens/settings/SettingsScreen.kt |

## Cross-cutting decision (applies to all)
**Global search + notification bell live shell-level in `web/.../ui/shell/AppShell.kt`** (which today has a side rail + bottom dock but no top bar), not per-screen. Specs 01, 20, 21 converge on this one placement. Adding it once gives web/desktop/Android parity for free.

## ⚠️ Reality-check notes (grounded corrections found while reading the code)
Several walkthrough complaints describe a **stale build**, not the current code. Verify the deployed artifact before rebuilding these:
- **KinTale Logs (09):** already renders the mock's organized buckets (Failed / Drafts / Sent + orphan triage), not the "raw table list" complaint.
- **Communicate (19):** templates **do** pull (`templatesStream` + `applyTemplate`); Broadcast/external-send are correctly **gated dark** behind `FF_BROADCAST`/`FF_EXTERNAL_SEND` because the `broadcastMessage` callable doesn't exist yet.
- **Invoice/Payments (16-18):** `Payment` **already has `invoiceId`** and `recordPayment` already exists; the gap is IA (Payments is a standalone destination) + the detail screen joining by kinfolk instead of the existing `invoiceId`.
- **Template Assignment (25):** "New binding does nothing" is stale — it's already wired to `assignTemplate`. **Template Bank (24):** live preview already exists.
- **Settings (29):** the personal/business split is mostly done already.
- **Activity Log (22):** Sentry is only the **Android crash reporter**; it is **not** tied to the `activity_log` audit collection. Recommendation: keep them separate (❓confirm).

### Two real Rule-1 violations already in the code (fix these)
- `KinTaleComposeScreen.kt` hardcodes **"Send to the Wrens"** (ll.524, 960) and **"Kinfolk + shared link"** visibility (ll.880-884, no backing field).
- `MediaGalleryScreen` hardcodes **`uploadedBy = "auntie"`** instead of the real signed-in user.

### Stale code reference found
- A KDoc in `FirestoreClient.kt` (~l.1155) points to `screens/admin/DynamicFieldsManagerScreen.kt`, which **does not exist**. The real dynamic-fields CRUD UI is `screens/settings/DynamicFieldsCard.kt` — and it duplicates the FormSchema system (see specs 26/27).
