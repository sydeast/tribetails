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
