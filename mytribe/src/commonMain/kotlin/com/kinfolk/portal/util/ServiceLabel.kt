package com.kinfolk.portal.util
/**
 * #1297: THE ONE PLACE THE PORTAL DECIDES WHAT A VISIT'S SERVICE IS CALLED.
 *
 * The name is resolved on the server against the operator's KinCare list
 * (`mytribe/functions/src/lib/serviceDisplayName.ts`) and arrives as
 * `serviceLabel` on `getMyBookings` and `getMyVisits` rows. Screens never print
 * `serviceType`, the stored value, which is often a code (`visit_60`).
 *
 * Mirrors `mytribe/web/src/lib/serviceLabel.ts`, so both portals name a visit
 * the same way.
 */
/** True for an identifier rather than a name: `visit_60`, `VISIT_60`. Same rule as the server. */
fun looksLikeServiceCode(label: String): Boolean =
    Regex("^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$").matches(label.trim())
/**
 * The decoded service name. [labelPresent] is whether the server sent the
 * `serviceLabel` key at all: a server that predates it (web and functions do
 * not deploy together) sends only `serviceType`, which is then used only when
 * it reads as a name. A code is never shown.
 */
fun decodeServiceLabel(labelPresent: Boolean, serviceLabel: String?, serviceType: String?): String? {
    if (labelPresent) return serviceLabel?.trim()?.takeIf { it.isNotEmpty() }
    val raw = serviceType?.trim().orEmpty()
    return if (raw.isEmpty() || looksLikeServiceCode(raw)) null else raw
}
/** A visit's title: its own, else the service name. A title that is a code counts as none. */
fun visitTitle(title: String?, serviceLabel: String?): String? {
    val own = title?.trim().orEmpty()
    if (own.isNotEmpty() && !looksLikeServiceCode(own)) return own
    return serviceLabel
}
/** The line above a title: the service name when it says something the title does not. No prefix. */
fun serviceEyebrow(title: String?, serviceLabel: String?): String? {
    val shown = visitTitle(title, serviceLabel)
    return if (serviceLabel != null && shown != null && serviceLabel != shown) serviceLabel else null
}
