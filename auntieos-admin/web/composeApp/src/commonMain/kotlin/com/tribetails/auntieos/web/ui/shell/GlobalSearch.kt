package com.tribetails.auntieos.web.ui.shell

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.Kinfolk

/**
 * Shell global search (Stage 0C / Phase 2).
 *
 * Pure, testable matcher over the data the app already streams at the shell
 * (kinfolkStream / allKinStream / reportsStream). No callable: every list is
 * client-available, so search runs entirely client-side.
 *
 * Matching is case-insensitive and substring-based:
 *  - Kinfolk:  displayName  OR phoneNumber (digits-only compare so "5551234"
 *              matches "(555) 123-4...")
 *  - Kin:      name  OR species  OR breed
 *  - KinTale:  title
 *
 * A blank/whitespace-only query yields an empty list. Results are grouped by
 * [SearchResultType] (Kinfolk, Kin, KinTale, in that fixed order) and, within a
 * group, name-matches rank ahead of secondary-field matches, then alphabetically.
 */

/** Which entity a [SearchResult] points at. Drives grouping + navigation. */
enum class SearchResultType(val label: String) {
    Kinfolk("Kinfolk"),
    Kin("Kin"),
    KinTale("KinTale"),
}

/**
 * One global-search hit.
 *
 * @param type      entity kind (controls the group header + the route mapping).
 * @param id        the entity's own id (kinfolk id, kin id, or KinTale sessionId).
 * @param kinfolkId owning household id; set for Kin hits so navigation can open
 *                  the kin under its kinfolk. Blank for Kinfolk/KinTale hits.
 * @param title     primary line shown in the dropdown (a name or report title).
 * @param subtitle  secondary line (species/breed, phone, or why it matched).
 */
data class SearchResult(
    val type: SearchResultType,
    val id: String,
    val kinfolkId: String,
    val title: String,
    val subtitle: String,
)

/** Cap on results returned per group so the dropdown stays readable. */
private const val PER_GROUP_LIMIT = 6

/** Keep only digits, for forgiving phone-number matching. */
private fun digitsOnly(s: String): String = s.filter { it.isDigit() }

/**
 * Runs the pure global-search match. See file header for the contract.
 *
 * @return grouped, ranked results (Kinfolk, then Kin, then KinTale), each group
 *         capped at [PER_GROUP_LIMIT]. Empty when [query] is blank or nothing matches.
 */
fun globalSearch(
    query: String,
    kinfolk: List<Kinfolk>,
    kin: List<Kin>,
    tales: List<KinCareReport>,
): List<SearchResult> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val qDigits = digitsOnly(q)

    // ----- Kinfolk: displayName or phone -----
    val kinfolkHits = kinfolk.mapNotNull { kf ->
        val nameMatch = kf.displayName.lowercase().contains(q)
        val phoneMatch = qDigits.isNotEmpty() &&
            digitsOnly(kf.phoneNumber).contains(qDigits)
        if (!nameMatch && !phoneMatch) return@mapNotNull null
        Ranked(
            // Name matches outrank phone-only matches within the group.
            primaryRank = if (nameMatch) 0 else 1,
            sortKey = kf.displayName.lowercase(),
            result = SearchResult(
                type = SearchResultType.Kinfolk,
                id = kf._id,
                kinfolkId = "",
                title = kf.displayName,
                subtitle = kf.phoneNumber.ifBlank { "Kinfolk" },
            ),
        )
    }

    // ----- Kin: name or species/breed -----
    val kinHits = kin.mapNotNull { k ->
        val nameMatch = k.name.lowercase().contains(q)
        val speciesMatch = k.species.lowercase().contains(q)
        val breedMatch = k.breed.lowercase().contains(q)
        if (!nameMatch && !speciesMatch && !breedMatch) return@mapNotNull null
        val speciesBreed = listOf(k.species, k.breed)
            .filter { it.isNotBlank() }
            .joinToString(" · ")
        Ranked(
            primaryRank = if (nameMatch) 0 else 1,
            sortKey = k.name.lowercase(),
            result = SearchResult(
                type = SearchResultType.Kin,
                id = k._id,
                kinfolkId = k.kinfolkId,
                title = k.name.ifBlank { "Unnamed Kin" },
                subtitle = speciesBreed.ifBlank { "Kin" },
            ),
        )
    }

    // ----- KinTale: title. Only reports that can actually be opened (have a
    // sessionId) are surfaced, mirroring the KinTales list's tap rule. -----
    val taleHits = tales.mapNotNull { r ->
        if (r.sessionId.isBlank()) return@mapNotNull null
        if (!r.title.lowercase().contains(q)) return@mapNotNull null
        Ranked(
            primaryRank = 0,
            sortKey = r.title.lowercase(),
            result = SearchResult(
                type = SearchResultType.KinTale,
                id = r.sessionId,
                kinfolkId = r.kinfolkId,
                title = r.title.ifBlank { "Untitled KinTale" },
                subtitle = r.kinfolkName.ifBlank { "KinTale" },
            ),
        )
    }

    fun List<Ranked>.finish(): List<SearchResult> =
        sortedWith(compareBy({ it.primaryRank }, { it.sortKey }))
            .take(PER_GROUP_LIMIT)
            .map { it.result }

    // Fixed group order: Kinfolk, then Kin, then KinTale.
    return kinfolkHits.finish() + kinHits.finish() + taleHits.finish()
}

/** Internal sort carrier so ranking stays out of [SearchResult]. */
private data class Ranked(
    val primaryRank: Int,
    val sortKey: String,
    val result: SearchResult,
)

/**
 * Maps a [SearchResult] to the [Route] that opens it. Pure, so the navigation
 * contract is unit-testable independent of Compose.
 *
 *  - Kinfolk  -> Directory deep-linked to that kinfolk's profile.
 *  - Kin      -> Directory deep-linked to that kin under its kinfolk.
 *  - KinTale  -> KinTales deep-linked to the report by sessionId.
 */
fun routeForSearchResult(result: SearchResult): Route = when (result.type) {
    SearchResultType.Kinfolk ->
        Route(Destination.Directory, detailId = result.id)
    SearchResultType.Kin ->
        Route(Destination.Directory, detailId = result.kinfolkId, detailType = result.id)
    SearchResultType.KinTale ->
        Route(Destination.KinTales, detailId = result.id)
}
