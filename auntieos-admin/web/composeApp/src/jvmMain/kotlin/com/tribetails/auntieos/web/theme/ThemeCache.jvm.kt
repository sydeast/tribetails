package com.tribetails.auntieos.web.theme

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import java.util.prefs.Preferences

// Desktop (JVM) warm-start cache backed by java.util.prefs. Same role as the web
// localStorage bridge: synchronous, never throws, returns null when absent.
private val themePrefs: Preferences = Preferences.userRoot().node("com/tribetails/auntieos")

internal actual fun readThemeCache(): String? =
    runCatchingCancellable { themePrefs.get("theme", null) }.getOrNull()

internal actual fun writeThemeCache(value: String) {
    runCatchingCancellable {
        themePrefs.put("theme", value)
        themePrefs.flush()
    }
}
