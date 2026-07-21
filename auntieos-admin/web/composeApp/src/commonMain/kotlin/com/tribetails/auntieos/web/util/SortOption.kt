package com.tribetails.auntieos.web.util

/**
 * Canonical sort options shared by Directory, KinTales, Kin sub-directory,
 * and any list screen that needs the standard four. Keep this enum stable -
 * the [key] value is persisted (or may be in the future) into user prefs.
 */
enum class SortOption(val key: String, val label: String) {
    AlphaAsc       ("alpha_asc",        "A → Z"),
    AlphaDesc      ("alpha_desc",       "Z → A"),
    RecentlyCreated("recently_created", "Recently Created"),
    RecentlyUpdated("recently_updated", "Recently Updated");

    companion object {
        val Default: SortOption = AlphaAsc
        fun fromKey(key: String?): SortOption =
            entries.firstOrNull { it.key == key } ?: Default
    }
}

/**
 * 03-directory item 3: surname-primary sort key for Kinfolk. "A to Z" must order by
 * LAST name (directory convention), with a first-name tiebreak, falling back to the
 * display name when the last name is blank (so an unnamed kinfolk does not jump to the
 * top). Feed this as the `name` accessor to [sortedByOption] for the Kinfolk tab.
 */
fun kinfolkSurnameSortKey(firstName: String, lastName: String, displayName: String): String =
    (if (lastName.isNotBlank()) "$lastName $firstName" else displayName).trim().lowercase()

/**
 * Generic helper: sort a list by [SortOption] using accessor lambdas. Keeps
 * the comparator construction out of every list screen. Falls back to
 * `name.lowercase()` ordering when a date string is blank.
 *
 * Named `sortedByOption` (not `sortedBy`) to avoid shadowing the stdlib
 * `List<T>.sortedBy(selector)` extension.
 */
fun <T> List<T>.sortedByOption(
    option: SortOption,
    name: (T) -> String,
    createdAt: (T) -> String,
    updatedAt: (T) -> String,
): List<T> = when (option) {
    SortOption.AlphaAsc        -> sortedBy { name(it).lowercase() }
    SortOption.AlphaDesc       -> sortedByDescending { name(it).lowercase() }
    SortOption.RecentlyCreated -> sortedByDescending { createdAt(it).ifBlank { "" } }
    SortOption.RecentlyUpdated -> sortedByDescending { updatedAt(it).ifBlank { "" } }
}
