package com.tribetails.auntieos.web.data

/**
 * Stage 0I test-admin sandbox scoping for `media_files`.
 *
 * The deployed Firestore rules gate media for a test admin on
 * `request.resource.data.kinfolkId == testTribeId` (testOwnsIncoming) and
 * `resource.data.kinfolkId == testTribeId` (testOwnsExisting). A test admin must
 * therefore stamp every media doc it writes with `kinfolkId == its testTribeId`
 * claim, or the create/read is DENIED. The real operator (isAuntie, no claim)
 * writes no kinfolkId and is unaffected (the isAuntie() OR-branch passes; media
 * stays keyed by entityId/entityType for the operator).
 *
 * Mirror of android `domain/MediaScope.kt`; the two are kept in lockstep by
 * `MediaScopeTest` on each platform.
 */
fun mediaScopeKinfolkId(testTribeId: String?): String = testTribeId?.trim().orEmpty()

/**
 * Stamp the sandbox kinfolkId when (and only when) a non-blank testTribeId is
 * present. A null/blank claim is a no-op (returns the same instance) so the
 * operator never writes a meaningless blank scope via a copy.
 */
fun MediaFile.withSandboxScope(testTribeId: String?): MediaFile {
    val scope = mediaScopeKinfolkId(testTribeId)
    return if (scope.isBlank()) this else copy(kinfolkId = scope)
}
