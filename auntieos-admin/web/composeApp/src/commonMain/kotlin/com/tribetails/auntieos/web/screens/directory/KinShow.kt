package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Kin

/**
 * #1902: what the desktop Kin tab's Show picker lists, the same three choices
 * as admin web and admin Android. Before this the tab dropped archived Kin with
 * no way to list them, so an archived Kin's Restore could not be reached again.
 *
 *   All kin   every Kin that is not archived (what the tab always listed)
 *   In care   that, less the inactive ones (the rule Home's count uses)
 *   Archived  only the archived ones, each opening its edit screen and Restore
 */
internal enum class KinShow(val label: String) {
    All("All kin"),
    InCare("In care"),
    Archived("Archived"),
}

internal fun isKinArchivedStatus(status: String): Boolean = status.trim().equals("archived", ignoreCase = true)

internal fun kinMatchesShow(status: String, show: KinShow): Boolean {
    val s = status.trim().lowercase()
    return when (show) {
        KinShow.Archived -> s == "archived"
        KinShow.InCare -> s != "archived" && s != "inactive"
        KinShow.All -> s != "archived"
    }
}

/** The Kin tab's rows for [show], then the name / species / breed search. Pure; tested. */
internal fun kinForShow(rows: List<Kin>, query: String, show: KinShow): List<Kin> {
    val needle = query.trim().lowercase()
    return rows.filter { k ->
        kinMatchesShow(k.status, show) && (
            needle.isEmpty() ||
                k.name.lowercase().contains(needle) ||
                k.species.lowercase().contains(needle) ||
                k.breed.lowercase().contains(needle)
            )
    }
}

/** #1902: the empty state, naming the Show choice that emptied the list. */
internal fun kinShowEmptyText(query: String, show: KinShow, anyOnFile: Boolean): Pair<String, String> = when {
    query.isNotBlank() -> "No matches for \"$query\"" to "Try a different name, species, or breed."
    show == KinShow.Archived -> "No archived Kin" to "An archived Kin is listed here, with Restore on its edit screen."
    show == KinShow.InCare -> "No Kin in care" to "Choose All kin under Show to see every Kin on file."
    anyOnFile -> "Every Kin on file is archived" to "Choose Archived under Show to see them."
    else -> "No Kin on file yet" to "Add Kin from a Kinfolk profile."
}
