package com.tribetails.auntieos.ui.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.ui.theme.AccentChoice
import com.tribetails.auntieos.ui.theme.DensityChoice
import com.tribetails.auntieos.ui.theme.FontScaleChoice
import com.tribetails.auntieos.ui.theme.ThemeMode
import com.tribetails.auntieos.ui.theme.ThemePersonalization
import com.tribetails.auntieos.ui.theme.withAccent
import com.tribetails.auntieos.ui.theme.withDensity
import com.tribetails.auntieos.ui.theme.withFontScale
import com.tribetails.auntieos.ui.theme.withTheme
import com.tribetails.auntieos.util.baseUrlFlow
import com.tribetails.auntieos.util.fcmTokenFlow
import com.tribetails.auntieos.util.personalizationFlow
import com.tribetails.auntieos.util.saveAccent
import com.tribetails.auntieos.util.saveBaseUrl
import com.tribetails.auntieos.util.saveDensity
import com.tribetails.auntieos.util.saveFontScale
import com.tribetails.auntieos.util.saveThemeMode
import com.tribetails.auntieos.util.themeModeFlow
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class SettingsUiState(
    val fcmToken: String = "",
    val baseUrl: String = RetrofitClient.DEFAULT_BASE_URL,
    val savedConfirmation: Boolean = false
)

class SettingsViewModel(private val appContext: Context) : ViewModel() {

    val themeMode: StateFlow<ThemeMode> = appContext.themeModeFlow()
        .stateIn(viewModelScope, SharingStarted.Eagerly, ThemeMode.DARK)

    private val _themeSyncError = MutableStateFlow<String?>(null)
    /** Non-null when the cloud sync of the theme failed (the local theme still applied). */
    val themeSyncError: StateFlow<String?> = _themeSyncError.asStateFlow()

    fun clearThemeSyncError() { _themeSyncError.value = null }

    fun saveThemeMode(mode: ThemeMode) {
        viewModelScope.launch {
            // Local boot cache first so the theme applies instantly.
            appContext.saveThemeMode(mode)
            // Then persist to the shared per-operator profile so the choice follows the
            // operator across web/desktop/android. Fail loud if the cloud write fails.
            val user = FirebaseAuth.getInstance().currentUser ?: return@launch
            val repo = AuntieOSApp.instance.repository
            val current = repo.observeUserProfile(user.uid).first()
                ?: UserProfile(uid = user.uid, email = user.email.orEmpty())
            repo.saveUserProfile(current.withTheme(mode)).onFailure { e ->
                _themeSyncError.value = "Theme saved on this device, but cloud sync failed: ${e.message}"
            }
        }
    }

    // ---- 17.1 personalization (accent / density / font scale) ----

    val personalization: StateFlow<ThemePersonalization> = appContext.personalizationFlow()
        .stateIn(viewModelScope, SharingStarted.Eagerly, ThemePersonalization())

    private val _appearanceSyncError = MutableStateFlow<String?>(null)
    /** Non-null when the cloud sync of a personalization knob failed (local still applied). */
    val appearanceSyncError: StateFlow<String?> = _appearanceSyncError.asStateFlow()

    fun clearAppearanceSyncError() { _appearanceSyncError.value = null }

    fun saveAccent(accent: AccentChoice) = persistAppearance { appContext.saveAccent(accent) }

    fun saveDensity(density: DensityChoice) = persistAppearance { appContext.saveDensity(density) }

    fun saveFontScale(scale: FontScaleChoice) = persistAppearance { appContext.saveFontScale(scale) }

    /** Local boot cache first (instant apply), then the shared users/{uid} profile,
     *  fail-loud on the cloud write. Mirrors saveThemeMode. The cloud write applies
     *  ALL THREE knobs from the just-updated boot cache (not just the changed one),
     *  so a quick second change cannot clobber the first via a stale single-field
     *  write to a doc that does not yet reflect the prior change. */
    private val appearanceSaveMutex = Mutex()

    private fun persistAppearance(cache: suspend () -> Unit) {
        viewModelScope.launch {
            cache()
            // FIFO-serialize the cloud writes so two quick changes cannot land out of
            // order and overwrite the doc with an older snapshot.
            appearanceSaveMutex.withLock {
                val user = FirebaseAuth.getInstance().currentUser ?: return@withLock
                val repo = AuntieOSApp.instance.repository
                val current = repo.observeUserProfile(user.uid).first()
                    ?: UserProfile(uid = user.uid, email = user.email.orEmpty())
                val pers = appContext.personalizationFlow().first()
                val merged = current.withAccent(pers.accent).withDensity(pers.density).withFontScale(pers.fontScale)
                repo.saveUserProfile(merged).onFailure { e ->
                    _appearanceSyncError.value = "Appearance saved on this device, but cloud sync failed: ${e.message}"
                }
            }
        }
    }

    val uiState: StateFlow<SettingsUiState> = combine(
        appContext.fcmTokenFlow(),
        appContext.baseUrlFlow()
    ) { token, url ->
        SettingsUiState(fcmToken = token, baseUrl = url)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SettingsUiState())

    private val _baseUrlError = MutableStateFlow<String?>(null)

    /** Non-null when the last Save could not build a client for the URL entered. */
    val baseUrlError: StateFlow<String?> = _baseUrlError.asStateFlow()

    /**
     * Persist and apply the tunnel URL. Retrofit requires a trailing slash, so the
     * value is normalized first (see [RetrofitClient.normalizeBaseUrl]); this used
     * to store `url.trimEnd('/')` and then hand that same slash-less string to
     * Retrofit, which threw inside a bare launch and killed the app on every Save.
     *
     * A URL Retrofit still rejects after normalizing (usually a missing http/https
     * scheme) surfaces in [baseUrlError] and is NOT persisted, so a bad entry
     * cannot poison the next launch.
     */
    fun saveBaseUrl(url: String) {
        viewModelScope.launch {
            val normalized = RetrofitClient.normalizeBaseUrl(url)
            try {
                AuntieOSApp.instance.rebuildRepository(normalized)
            } catch (e: IllegalArgumentException) {
                _baseUrlError.value = "Not a usable URL: ${e.message ?: "check the address"}"
                return@launch
            }
            appContext.saveBaseUrl(normalized)
            _baseUrlError.value = null
        }
    }

    fun clearBaseUrlError() { _baseUrlError.value = null }
}
