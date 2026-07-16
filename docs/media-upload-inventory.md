# AuntieOS — Media Upload Inventory

Work-list for Stage 1 item 1A (Kin photo pipeline) + Phase 17.2 (branding). Generated 2026-06-03.

## Plumbing reality
- Cloudinary upload + Firestore `MediaFile` metadata work on **web-wasm** (`platformUploadMedia`, `jsPickAndUpload`) and **android** (`MediaUploadManager`).
- **Desktop (JVM) is stubbed for ALL media** (`platformUploadMedia` + picker return "mobile-only"). Every surface is dark on desktop until a JVM picker + Cloudinary upload lands.
- Backend target enum already exists: `MediaEntityType = KINFOLK, KIN, HOUSEHOLD, VISIT_LOG, INVOICE, TRAINING, USER`.

## Surfaces

| # | Surface | web-wasm | desktop | android | Spec / note |
|---|---------|----------|---------|---------|-------------|
| 1 | Login-screen logo | none | none | none | static; editable-logo = Phase 17.2 |
| 2 | Shell upper-left logo (`BrandHeader`/`ShellTopBar`) | hard-coded paw | hard-coded | hard-coded | Decision 6 / 17.2 |
| 3 | Admin/operator profile photo | STUB (badge not clickable, flag `settingsProfilePicUpload`) | STUB | REAL (`uploadAvatar`, USER) | web is the gap |
| 4 | Kinfolk (primary) profile photo | no affordance | no affordance | no affordance | `Kinfolk.profilePictureUrl` exists both sides, no upload UI anywhere |
| 5 | Secondary kinfolk photo | none | none | none | household member = MyTribe (Decision 8) |
| 6 | Kin (pet) photo | NO field | NO field | NO field | Kin model has no `profilePictureUrl` — needs model add + UI |
| 7 | KinTale media (visit photos) | REAL | STUB | REAL | desktop gap |
| 8 | Media Gallery | REAL | STUB | REAL | desktop gap |
| 9 | Communicate message attachments | not wired | not wired | not wired | no plumbing on composer |
| 10 | Template Bank rich editor (images/links) | none | none | none | Phase 13.3/13.4 |
| 11 | Tribal Intel doc upload (was Training Docs) | none | none | none | Phase 12 / Decision 3; entityType=TRAINING infra ready |
| 12 | FormSchema FILE_UPLOAD field type | not rendered | not rendered | enum only, no UI | Phase 14.5 |
| 13 | Invoice attachments / receipts | none | none | none | entityType=INVOICE infra ready; 16.2 is PDF generate not upload |

## Stage 1 (1A) scope — THIS effort
- **#6 Kin photo:** add `profilePictureUrl` to Kin model (web `FirestoreClient.kt` + android `Models.kt`); upload UI in Kin edit.
- **#4 Kinfolk photo:** wire upload UI in Kinfolk edit (field already exists).
- **Desktop picker:** real JVM `platformUploadMedia` (JFileChooser + Cloudinary + Firestore write), un-stubbing desktop for #4/#6/#7/#8/#3 at once.

## Deferred (own efforts)
- #1/#2/#10/#11/#12/#13 + #3-web + #5 — sequenced under Phase 17.2 (branding), Phase 12 (Tribal Intel), Phase 13 (templates), Phase 14 (formSchema), MyTribe (secondary kinfolk).
