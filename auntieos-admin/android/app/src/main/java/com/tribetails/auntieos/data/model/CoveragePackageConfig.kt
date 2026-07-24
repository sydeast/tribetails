package com.tribetails.auntieos.data.model

import androidx.annotation.Keep
import com.google.firebase.firestore.DocumentId
import com.tribetails.auntieos.domain.CoverageRules
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.Duration

/**
 * Firestore doc `coverage_package_config/config`: the operator-global config for
 * the Coverage Package Builder (the visit menu + coverage rules). Wire parity
 * with the web `CoveragePackageConfig` (fields `durations`, `rules`,
 * `updatedAt`, `updatedBy`).
 *
 * Only this CONFIG persists; the per-stay pricing inputs (client, dates,
 * approved schedule) are UI state and are never written. Saved with
 * SetOptions.merge() so a save never clobbers a sibling field. A never-created
 * doc, or one with an empty menu, resolves to the shipped defaults via
 * [withDefaults] rather than leaving the operator with no visit menu.
 */
@Keep
data class CoveragePackageConfig(
    @DocumentId var id: String = "config",
    var durations: List<Duration> = emptyList(),
    var rules: CoverageRules = CoverageRules(),
    var updatedAt: String = "",
    var updatedBy: String = "",
) {
    /** Fill an empty menu with the shipped defaults; keep a non-empty one, and the
     *  stored rules, as-is. A totally missing doc is defaulted in the repository. */
    fun withDefaults(): CoveragePackageConfig = copy(durations = durations.ifEmpty { DEFAULT_DURATIONS })
}
