package com.tribetails.auntieos.web.ui.shell

/** A resolved location: a top-level [dest] plus optional detail params. */
data class Route(
    val dest: Destination,
    val detailId: String? = null,
    val detailType: String? = null,
)

/** URL slug per destination. Stable, kebab-case. */
private val slugOf: Map<Destination, String> = mapOf(
    Destination.Home to "home",
    Destination.Communicate to "communicate",
    Destination.Directory to "directory",
    Destination.KinTales to "kintales",
    Destination.Bookings to "bookings",
    Destination.Sessions to "sessions",
    Destination.Schedule to "schedule",
    Destination.Invoices to "invoices",
    Destination.Inbox to "inbox",
    Destination.Activity to "activity",
    Destination.Settings to "settings",
    Destination.MediaGallery to "media",
    Destination.Gallery to "gallery",
    Destination.AccountSettings to "account",
    Destination.MyNotifications to "my-notifications",
    Destination.TrainingDocs to "tribal-intel",
    Destination.Notifications to "notifications",
    Destination.Templates to "templates",
    Destination.FormSchemas to "form-schemas",
    Destination.FeatureFlags to "feature-flags",
)
private val destOf: Map<String, Destination> =
    // Old "training-docs" slug stays resolvable after the Tribal Intel rename (Decision 3).
    slugOf.entries.associate { (k, v) -> v to k } +
        ("training-docs" to Destination.TrainingDocs) +
        // Legacy standalone template slugs resolve to the merged two-tab screen (Decision 2).
        ("template-bank" to Destination.Templates) +
        ("template-assignment" to Destination.Templates)

/** Build a hash string ("#/slug" or "#/slug/id" or "#/media/type/id"). */
fun routeToHash(r: Route): String {
    val slug = slugOf[r.dest] ?: "home"
    return when {
        r.dest == Destination.MediaGallery && r.detailId != null ->
            "#/media/${r.detailType ?: "kin"}/${r.detailId}"
        // Directory deep-link to a kin: #/directory/{kinfolkId}/{kinId}.
        // detailId = kinfolkId, detailType = kinId (carries the kin under its household).
        r.dest == Destination.Directory && r.detailId != null && r.detailType != null ->
            "#/$slug/${r.detailId}/${r.detailType}"
        r.detailId != null -> "#/$slug/${r.detailId}"
        else -> "#/$slug"
    }
}

/**
 * 17.4 fail-loud: a message to surface when [hash] names a slug that resolves to no
 * screen (parseHash silently falls back to Home). Null for a valid or empty hash. The
 * router still lands on Home; this makes the dead link visible instead of silent.
 */
fun routeWarning(hash: String): String? {
    val parts = hash.removePrefix("#").removePrefix("/").trim('/')
        .split('/').filter { it.isNotBlank() }
    val slug = parts.firstOrNull() ?: return null
    return if (destOf[slug] == null) "The page \"$slug\" isn't available. Showing Home instead." else null
}

/** Parse a hash string into a [Route]. Unknown/empty -> Home. */
fun parseHash(hash: String): Route {
    val parts = hash.removePrefix("#").removePrefix("/").trim('/')
        .split('/').filter { it.isNotBlank() }
    if (parts.isEmpty()) return Route(Destination.Home)
    val dest = destOf[parts[0]] ?: return Route(Destination.Home)
    // Legacy template slugs imply a starting tab on the merged Templates screen.
    val legacyTemplatesTab = when (parts[0]) {
        "template-assignment" -> "assignment"
        "template-bank" -> "bank"
        else -> null
    }
    return when {
        dest == Destination.MediaGallery && parts.size >= 3 ->
            Route(dest, detailId = parts[2], detailType = parts[1])
        // Directory kin deep-link: #/directory/{kinfolkId}/{kinId}.
        dest == Destination.Directory && parts.size >= 3 ->
            Route(dest, detailId = parts[1], detailType = parts[2])
        parts.size >= 2 -> Route(dest, detailId = parts[1])
        legacyTemplatesTab != null -> Route(dest, detailId = legacyTemplatesTab)
        else -> Route(dest)
    }
}
