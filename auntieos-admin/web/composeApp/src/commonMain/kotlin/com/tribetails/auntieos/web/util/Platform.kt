package com.tribetails.auntieos.web.util

/** Tiny platform interop shared by screens - kept in its own module so the
 *  per-platform `@JsFun` / Android intent code stays out of common UI files. */

/** Open the platform's map app for the given free-text address. No-op on blank. */
expect fun openInMaps(address: String)

/** Current time as ISO-8601 (UTC, second-precision) - used to stamp lifecycle
 *  fields like onMyWayAt / arrivedAt / departedAt / completedAt. */
expect fun nowIso(): String

/** Open a URL in a new tab/window. No-op on blank. */
expect fun openUrl(url: String)

/** Copy [text] to the system clipboard. No-op on blank. Best-effort: callers
 *  still SHOW the value (e.g. in a dialog) so a clipboard failure never hides it. */
expect fun copyToClipboard(text: String)
