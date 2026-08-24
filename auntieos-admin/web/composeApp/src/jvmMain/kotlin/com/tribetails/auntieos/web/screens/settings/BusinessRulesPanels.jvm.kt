package com.tribetails.auntieos.web.screens.settings

import java.time.ZoneId

/**
 * ISSUE #519: the desktop's answer to "which time zones exist, and can this
 * runtime read one".
 *
 * `java.time` carries the tzdata the JVM was built with, which is the same
 * source every server-side consumer of `business_settings.timeZone` resolves
 * against. Asking it, rather than shipping a hand-written list, is what keeps
 * the picker from offering a zone the phone line cannot answer in.
 */
internal actual fun platformTimeZoneIds(): List<String> =
    runCatching { ZoneId.getAvailableZoneIds().toList() }.getOrDefault(emptyList())

internal actual fun platformTimeZoneUsable(zone: String): Boolean =
    zone.isNotBlank() && runCatching { ZoneId.of(zone.trim()) }.isSuccess
