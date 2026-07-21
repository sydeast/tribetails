package com.tribetails.auntieos.util

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.ui.theme.AccentChoice
import com.tribetails.auntieos.ui.theme.DensityChoice
import com.tribetails.auntieos.ui.theme.FontScaleChoice
import com.tribetails.auntieos.ui.theme.ThemeMode
import com.tribetails.auntieos.ui.theme.ThemePersonalization
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

val Context.dataStore by preferencesDataStore(name = "auntieos_prefs")

object PrefKeys {
    val FCM_TOKEN   = stringPreferencesKey("fcm_token")
    val BASE_URL    = stringPreferencesKey("base_url")
    val THEME_MODE  = stringPreferencesKey("theme_mode")
    // 17.1 personalization boot cache (durable source is users/{uid}).
    val ACCENT      = stringPreferencesKey("accent_color")
    val DENSITY     = stringPreferencesKey("density")
    val FONT_SCALE  = stringPreferencesKey("font_scale")
}

fun Context.fcmTokenFlow(): Flow<String> =
    dataStore.data.map { it[PrefKeys.FCM_TOKEN] ?: "" }

fun Context.baseUrlFlow(): Flow<String> =
    dataStore.data.map { it[PrefKeys.BASE_URL] ?: RetrofitClient.DEFAULT_BASE_URL }

suspend fun Context.saveFcmToken(token: String) {
    dataStore.edit { it[PrefKeys.FCM_TOKEN] = token }
}

suspend fun Context.saveBaseUrl(url: String) {
    dataStore.edit { it[PrefKeys.BASE_URL] = url }
}

fun Context.themeModeFlow(): Flow<ThemeMode> =
    dataStore.data.map { prefs ->
        when (prefs[PrefKeys.THEME_MODE]) {
            "LIGHT"  -> ThemeMode.LIGHT
            "DARK"   -> ThemeMode.DARK
            else     -> ThemeMode.DARK
        }
    }

suspend fun Context.saveThemeMode(mode: ThemeMode) {
    dataStore.edit { it[PrefKeys.THEME_MODE] = mode.name }
}

// ---- 17.1 personalization (accent / density / font scale) boot cache ----

/** Combined personalization from DataStore; each field fail-safe to its default. */
fun Context.personalizationFlow(): Flow<ThemePersonalization> =
    dataStore.data.map { prefs ->
        ThemePersonalization(
            accent = AccentChoice.parse(prefs[PrefKeys.ACCENT]),
            density = DensityChoice.parse(prefs[PrefKeys.DENSITY]),
            fontScale = FontScaleChoice.parse(prefs[PrefKeys.FONT_SCALE]),
        )
    }

suspend fun Context.saveAccent(accent: AccentChoice) {
    dataStore.edit { it[PrefKeys.ACCENT] = accent.key }
}

suspend fun Context.saveDensity(density: DensityChoice) {
    dataStore.edit { it[PrefKeys.DENSITY] = density.key }
}

suspend fun Context.saveFontScale(scale: FontScaleChoice) {
    dataStore.edit { it[PrefKeys.FONT_SCALE] = scale.key }
}
