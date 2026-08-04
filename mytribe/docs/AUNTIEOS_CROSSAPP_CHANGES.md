# AuntieOS cross-app changes (lockstep with MyTribe), 2026-06-01

> **HISTORICAL, written 2026-06-01. Do not execute this as a task list.**
> Read it for the data model and the reasoning. Three of its premises have since
> stopped being true:
>
> - **The booking envelope is not flag-gated.** `mytribe.booking.envelope` is
>   gone along with every other `mytribe.*` flag.
>   `mytribe/src/commonMain/kotlin/com/kinfolk/portal/config/FeatureFlags.kt:23`
>   reads `val KEYS: List<String> = emptyList()`, and the envelope ships
>   always-on. Step E5, "flip the flag ON", has nothing left to flip.
> - **The two repos are one.** They merged on 2026-07-21. AuntieOS is the
>   `auntieos-admin/` prefix of this repository, and the absolute path this doc
>   gave for it does not exist on any machine.
> - **The delivery target moved.** This spec targets the `web/composeApp` wasm
>   admin, which was superseded on 2026-07-20 by `auntieos-admin/src` (React).
>   Much of the work below has since landed there, in
>   `auntieos-admin/src/api/bookingsWrite.ts` and `bookingNotes.ts`.

The MyTribe side of the booking envelope and the pet sync bridge is implemented and
verified. These were the matching AuntieOS changes needed to turn it on. They touch
the AuntieOS tree (`web/composeApp` wasm + `android` + shared rules) and required the
AuntieOS build plus a coordinated deploy, so they were written here as a
ready-to-apply spec rather than applied from the MyTribe repo.

## A. Booking envelope write-back

New MyTribe model: parent `families/{fid}/bookings/{batchId}` + `kinCares/{visitId}`
subcollection. AuntieOS today ignores MyTribe bookings and runs its own pipeline
(`enhanced_bookings` to `kin_care_sessions`, FK `sourceBookingId`). To make staff
status flow back so kinfolk see live state, AuntieOS must:

1. Ingest incoming kinCares.
   - Android `BookingRepository.kt`: add a `collectionGroup('kinCares').whereEqualTo('status','requested')` listener and surface them in the scheduling queue alongside `enhanced_bookings`.
   - Web `FirestoreInterop.wasmJs.kt`: add `platformIncomingKinCaresStream()` (collectionGroup kinCares where status == requested).
2. On approve, write status back onto the kinCare doc.
   - `EnhancedSchedulingViewModel.approveBooking` already creates the `EnhancedBooking` + `KinCareSession` (sourceBookingId = enhanced booking id). Add a third write patching the originating kinCare: `status='confirmed'`, `auntieDisplayName`, `auntieAvatarUrl`, `sourceBookingId` (the enhanced booking id), `sessionId` (the kin_care_sessions id), `updatedAt`.
   - Add `AuntieRepository.patchKinCareDoc(familyId, batchId, visitId, patch)` that does `firestore.doc("families/$familyId/bookings/$batchId/kinCares/$visitId").update(patch)` (mirrors the existing `patchKinCareSession`). Web: same via `jsUpdateDoc`.
   - Add `kinCareBatchId` / `kinCareVisitId` (or a structured `sourceBookingId = "$batchId/$visitId"`) to `KinCareSession` in `Models.kt` so the session knows which kinCare to patch. Do NOT repurpose the existing `KinCareSession.sourceBookingId` (it points at `enhanced_bookings`).
3. Mirror lifecycle onto the kinCare so MyTribe live state resolves:
   - ON_MY_WAY to kinCare.status `enRoute`, visitProgress `enRoute`
   - ARRIVED to `active` / `active`
   - DEPARTED or COMPLETED to `completed` / `ended`
   - CANCELLED to `cancelled`
   Hook these into the existing `kin_care_sessions` lifecycle writes (`onMyWayAt`/`arrivedAt`/`departedAt` and web `platformApproveBooking`).
4. Note paths moved under kinCares.
   - The callable names (`addBookingNote`, `addInternalBookingNote`) are unchanged but the payloads now carry `batchId` + `visitId`. MyTribe sends them (with a back-compat resolver for legacy `bookingId`). Update AuntieOS `BookingNotesRepository.kt` (android) and `platformBookingNotesStream`/`platformAddBookingNote` (web) to read/write `families/{fid}/bookings/{batchId}/kinCares/{visitId}/{notes|internalNotes}` and accept `batchId` + `visitId`. Deploy this on both sides together (otherwise staff note reads break).

## B. Pet/Kin bidirectional bridge

MyTribe added `onFamilyKinWrite` (mirrors `families/{fid}/kin` to flat `kin/` and
stamps symmetric `familyKinPath` + `legacyKinId`) and `onFlatKinWrite` (mirrors staff
edits back), with an `_mirrorOrigin` loop guard. For staff-created pets to get mirrored
into the family record, AuntieOS must write the FK on create/update:

- `AuntieRepository.kt` createKin/updateKin and web `jsAddDoc`/`jsSetDoc('kin')`: when a
  pet is created or edited for a known kinfolk, set `kinfolkId` and `familyKinPath`
  (`families/{kinfolkId}/kin/{kinId}`). New staff pets then mirror into the family tree.
- Reconcile the photo shape: AuntieOS flat `kin` stores `photos: List<BaserowFile>`,
  MyTribe uses scalar `photoUrl`. Decide a single mapping (e.g. mirror writes
  `photoUrl` = first photo url) and align both mirror directions.
- Reconcile care-field names: MyTribe writes `feedingInstructions`/`walkingInstructions`
  /etc; AuntieOS-native fields are `routine`/`medications`/etc. Pick the canonical set
  in `kinMirror.ts` PARENT_OWNED_FIELDS and the AuntieOS model so neither side clobbers.

## C. Firestore rules

Rules are the single source of truth in `sotu-hosting/` and synced into both apps.
The MyTribe copy already has the new `bookings/{batchId}` + `kinCares/{visitId}` block
and the `clients/{uid}` tenant-boundary tamper fix. Deploy from `sotu-hosting/` and sync
`AuntieOS/web/firestore.rules` to match (additive: old flat booking docs still read).
Both must allow `isAuntie()` update on `kinCares` (the write-back path in A).

## D. Backfill

Run `MyTribe/scripts/backfillBookingEnvelopes.ts` (dry-run default) to wrap existing
flat `families/.../bookings` docs into single-visit envelopes (co-batched docs collapse
by `requestBatchId`). Verify, then re-run with `--allow-prod`. Run BEFORE flipping the
read flag so no kinfolk sees a half-migrated list.

## E. Deploy order (safe sequence)

1. Deploy rules from `sotu-hosting/` (additive) + add the `kinCares` composite index.
2. Deploy MyTribe functions (envelope write + rollup + note paths + invoice fix + pet
   mirror triggers). New requests now create envelopes; reads still return the same
   buckets, flag still OFF, UI unchanged.
3. Run the backfill (dry-run, verify, allow-prod).
4. Deploy AuntieOS (ingestion + write-back + note-path + pet FK). This is the lockstep
   step: until it ships, kinfolk see `requested` forever and no Auntie name.
5. Flip `mytribe.booking.envelope` ON (global `business_settings/feature_flags`, or
   per-QA `clients/{uid}.featureFlags` first). Instant rollback by flipping it back.

Highest-risk window: between steps 2 and 4, new requests are invisible to staff. Keep
the manual `enhanced_bookings` entry path live, or ship 2 and 4 close together.

## Source specs

Full file-level detail is in the blueprints captured this session:
`docs/ROUTING_MIGRATION_BLUEPRINT.md` (routing, already implemented) and the booking
envelope blueprint (sections 5 to 7) plus the pet bridge risks in
`~/.claude/.../memory/auntieos-canonical-paths.md`.
