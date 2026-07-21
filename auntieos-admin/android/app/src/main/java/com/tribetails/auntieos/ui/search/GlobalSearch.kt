package com.tribetails.auntieos.ui.search

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.KinCareReport

/**
 * Pure global-search matcher for the shell top bar (Stage 0C / Phase 2).
 *
 * Searches across the admin's already-loaded data:
 *   - Kinfolk: [Kinfolk.displayName] + [Kinfolk.phoneNumber]
 *   - Kin:     [Kin.name] + [Kin.species] + [Kin.breed]
 *   - KinTale: [KinCareReport.title]
 *
 * Matching is substring + case-insensitive on a trimmed query. A blank query
 * yields an empty result (the UI shows nothing). Results keep their input
 * (first-seen) order within each group. Mirrors web `globalSearch`.
 *
 * This is a top-level pure function with no Compose / Android / Firebase
 * dependency so it can be unit tested on the JVM.
 */
fun globalSearch(
    query: String,
    kinfolk: List<Kinfolk>,
    kin: List<Kin>,
    tales: List<KinCareReport>,
    limitPerGroup: Int = 8,
): GlobalSearchResults {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return GlobalSearchResults.EMPTY

    fun String.hit(): Boolean = q in lowercase()

    val kinfolkHits = kinfolk
        .asSequence()
        .filter { it.displayName.hit() || it.phoneNumber.hit() }
        .map { SearchHit.KinfolkHit(it.id, it.displayName, it.phoneNumber) }
        .take(limitPerGroup)
        .toList()

    val kinHits = kin
        .asSequence()
        .filter { it.name.hit() || it.species.hit() || it.breed.hit() }
        .map { SearchHit.KinHit(it.id, it.name, speciesBreed(it.species, it.breed)) }
        .take(limitPerGroup)
        .toList()

    val taleHits = tales
        .asSequence()
        .filter { it.title.hit() }
        .map { SearchHit.TaleHit(it.id, it.sessionId, it.title, it.kinfolkName) }
        .take(limitPerGroup)
        .toList()

    return GlobalSearchResults(
        kinfolk = kinfolkHits,
        kin = kinHits,
        tales = taleHits,
    )
}

/** Functional secondary line for a kin hit: "Species · Breed" (omits empty parts). */
internal fun speciesBreed(species: String, breed: String): String =
    listOf(species.trim(), breed.trim()).filter { it.isNotBlank() }.joinToString(" · ")

/** Grouped, immutable result set. [isEmpty] short-circuits the dropdown. */
data class GlobalSearchResults(
    val kinfolk: List<SearchHit.KinfolkHit> = emptyList(),
    val kin: List<SearchHit.KinHit> = emptyList(),
    val tales: List<SearchHit.TaleHit> = emptyList(),
) {
    val isEmpty: Boolean get() = kinfolk.isEmpty() && kin.isEmpty() && tales.isEmpty()
    val total: Int get() = kinfolk.size + kin.size + tales.size

    companion object {
        val EMPTY = GlobalSearchResults()
    }
}

/** One matched entity, carrying just enough to render a row and route to it. */
sealed interface SearchHit {
    val id: String
    val primary: String
    val secondary: String

    data class KinfolkHit(
        override val id: String,
        override val primary: String,
        override val secondary: String,
    ) : SearchHit

    data class KinHit(
        override val id: String,
        override val primary: String,
        override val secondary: String,
    ) : SearchHit

    data class TaleHit(
        override val id: String,
        val sessionId: String,
        override val primary: String,
        override val secondary: String,
    ) : SearchHit
}

/**
 * Pure result -> nav route mapping (parity with the web router target). Returns
 * the route string the nav controller should navigate to for a given hit, or
 * null when the hit cannot be routed (e.g. a KinTale with no session id).
 *
 *   - KinfolkHit -> kinfolk_profile/{id}     (KinfolkProfile)
 *   - KinHit     -> edit_kin/{id}            (EditKin = the kin detail screen)
 *   - TaleHit    -> kintale/{sessionId}?reportId={id} (KinTaleReport)
 */
fun searchHitRoute(hit: SearchHit): String? = when (hit) {
    is SearchHit.KinfolkHit -> "kinfolk_profile/${hit.id}"
    is SearchHit.KinHit -> "edit_kin/${hit.id}"
    is SearchHit.TaleHit ->
        if (hit.sessionId.isBlank()) null
        else "kintale/${hit.sessionId}?reportId=${hit.id}"
}
