package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.MediaFile

/**
 * Stage 0I test-admin sandbox scoping for `media_files`. Mirror of web
 * `data/MediaScope.kt` (see that file for the full rule contract). A test admin
 * must stamp `kinfolkId == its testTribeId` claim on every media doc or the
 * sandbox rules (testOwnsIncoming/testOwnsExisting) deny the write/read. The
 * operator (no claim) writes no scope and is unaffected.
 *
 * Kept in lockstep with the web helper by `MediaScopeTest` on each platform.
 */
fun mediaScopeKinfolkId(testTribeId: String?): String = testTribeId?.trim().orEmpty()

/**
 * Stamp the sandbox kinfolkId only when a non-blank testTribeId is present; a
 * null/blank claim is a no-op (returns the same instance).
 */
fun MediaFile.withSandboxScope(testTribeId: String?): MediaFile {
    val scope = mediaScopeKinfolkId(testTribeId)
    return if (scope.isBlank()) this else copy(kinfolkId = scope)
}

/**
 * True when this doc's `kinfolkId` must be DELETED from the persisted document
 * rather than written blank (operator ruling 2026-07-31: Kinfolk do not "own"
 * media, so a KIN/BUSINESS/... upload has none). `MediaFile.kinfolkId` is a
 * non-nullable `var kinfolkId: String = ""`, so `DocumentReference.set(pojo)`
 * always WRITES the key, even blank -- a data class field cannot omit itself
 * the way `mediaUpload.ts`'s conditional-field object literal can. Absent is
 * the correct end state anyway: a doc explicitly stamped `""` and one that
 * genuinely never had the field would otherwise read as two different things
 * to a future query, the exact equality-on-empty-string Firestore trap
 * HANDOFF_2026-07-25 documents for `invoiceId`.
 *
 * Only ever true for the real operator: `withSandboxScope` above always stamps
 * a non-blank `testTribeId` when the sandbox test-admin is active, so a
 * sandbox write's `kinfolkId` is never blank by the time [saveMediaFile]
 * checks this (see `AuntieRepository.kt`).
 */
fun MediaFile.hasBlankKinfolkId(): Boolean = kinfolkId.isBlank()
