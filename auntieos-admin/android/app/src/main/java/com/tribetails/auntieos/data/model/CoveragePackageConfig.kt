package com.tribetails.auntieos.data.model

import androidx.annotation.Keep
import com.google.firebase.firestore.DocumentId
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.Duration
import com.tribetails.auntieos.domain.withKind

/**
 * Firestore doc `coverage_package_config/config`: the operator-global config for
 * the Coverage Package Builder — ONLY the visit menu. Wire parity with the web
 * `CoveragePackageConfig` (fields `durations`, `updatedAt`, `updatedBy`).
 *
 * Coverage rules (day window, max gap, pinned visits) are PER-CLIENT and are held
 * as session UI state on the screen, never in this global doc — so switching
 * clients can't inherit stale rules. Any legacy `rules` field on an old doc is
 * ignored on read, and `SetOptions.merge()` on write is what leaves it there. A
 * never-created doc, or one with an empty menu, resolves to the shipped defaults
 * via [withDefaults].
 *
 * SAVED AS A DIFF, never as this model: see `CoveragePackageConfigDiff.kt`, which
 * also holds the drift guard that must be updated before this class gains a field.
 */
@Keep
data class CoveragePackageConfig(
    @DocumentId var id: String = "config",
    var durations: List<Duration> = emptyList(),
    var updatedAt: String = "",
    var updatedBy: String = "",
) {
    /** Fill an empty menu with the shipped defaults; keep a non-empty one, and the
     *  stored rules, as-is. `withKind` migrates a menu saved before the visit/overnight
     *  `kind` existed (only the legacy d7 → overnight). Missing doc → defaulted in repo. */
    fun withDefaults(): CoveragePackageConfig = copy(durations = withKind(durations.ifEmpty { DEFAULT_DURATIONS }))
}
