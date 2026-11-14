package com.tribetails.auntieos.web.util

/** Tiny platform interop shared by screens - kept in its own module so the
 *  per-platform `@JsFun` / Android intent code stays out of common UI files. */

/** Open the platform's map app for the given free-text address. No-op on blank. */
expect fun openInMaps(address: String)

/** Current time as a UTC instant, whole seconds, with a `Z`
 *  (`2026-11-10T22:00:00Z`), the shape web and Android stamp. Used to stamp
 *  lifecycle fields like onMyWayAt / arrivedAt / departedAt / completedAt and
 *  every other written "when". Never read it as today or this hour: that is
 *  [businessNowLocalIso]. */
expect fun nowIso(): String

/** The business's own wall clock now, zone-less and whole seconds
 *  (`2026-11-10T16:00:00` in America/Chicago), in the zone
 *  `business_settings.timeZone` names. For "today" and "this hour" only; it is
 *  never written as a stamp. */
expect fun businessNowLocalIso(): String

/** Today on the business's calendar, `YYYY-MM-DD`. */
fun businessTodayIso(): String = businessNowLocalIso().take(10)

/** The IANA id of the zone the business's days are counted in, the one
 *  [businessNowLocalIso] reads (America/Chicago until settings are read). */
expect fun businessTimeZoneId(): String

/** [businessTimeZoneId] as a zone, for reading a stored visit time on the
 *  business's clock where no screen-level zone is to hand. */
fun businessTimeZone(): kotlinx.datetime.TimeZone =
    runCatching { kotlinx.datetime.TimeZone.of(businessTimeZoneId()) }
        .getOrElse { kotlinx.datetime.TimeZone.of("America/Chicago") }

/** Open a URL in a new tab/window. No-op on blank. */
expect fun openUrl(url: String)

/** Copy [text] to the system clipboard. No-op on blank. Best-effort: callers
 *  still SHOW the value (e.g. in a dialog) so a clipboard failure never hides it. */
expect fun copyToClipboard(text: String)

/** Save [bytes] to a temporary file named [fileName] and open it in the system's default audio player. */
expect fun openAudioBytes(bytes: ByteArray, fileName: String)
