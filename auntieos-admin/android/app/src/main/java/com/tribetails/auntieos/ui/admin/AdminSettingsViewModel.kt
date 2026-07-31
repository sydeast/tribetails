package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.IntegrationsRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.ui.branding.withBranding
import com.tribetails.auntieos.ui.branding.nextLogoRemovedAt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import com.google.firebase.messaging.FirebaseMessaging

data class AdminSettingsUiState(
    val businessSettings: BusinessSettings = BusinessSettings(),
    val businessHours: List<BusinessHours> = emptyList(),
    val profile: UserProfile = UserProfile(),
    val isLoading: Boolean = false,
    val isUploadingAvatar: Boolean = false,
    val isUploadingLogo: Boolean = false,
    // 17.2 Branding: a freshly-picked logo URL staged for the next "Save Branding"
    // (null = nothing staged, use businessSettings.logoUrl; "" = staged removal).
    // Mirrors web's stage-then-save model so the logo and text commit together.
    val stagedLogoUrl: String? = null,
    val isSendingPasswordReset: Boolean = false,
    val passwordResetSent: Boolean = false,
    val credentialBusy: Boolean = false,
    val credentialMessage: String? = null,
    val error: String? = null,
    val saveSuccess: Boolean = false,
    val profileSaveSuccess: Boolean = false,
    /**
     * The two facts a server genuinely cannot see, because they are about the
     * handset in the operator's hand rather than about the business.
     *
     * The other two rows this list used to hold are gone, and their removal is
     * the point of the change: "n8n Webhooks: CONFIGURED" was a fixed string
     * that outlived the retirement of n8n by more than a year, and "Twilio
     * Studio: CONFIGURED" asserted a state nothing had checked. Both are
     * server-side questions, and the server now answers them in
     * [integrationsHealth].
     */
    val deviceProbes: List<IntegrationHealth> = listOf(
        IntegrationHealth("Firestore", "This device's read/write round-trip", IntegrationHealthState.UNKNOWN),
        IntegrationHealth("Push notifications", "This device's FCM registration", IntegrationHealthState.UNKNOWN),
    ),
    /** The server's answer for every outside service. Null until it comes back. */
    val integrationsHealth: IntegrationsHealth? = null,
    val integrationsLoading: Boolean = false,
    /**
     * Fail loud, and separately from [error]: a failed integrations read must
     * show as its own banner on its own panel, never as an empty list that
     * reads like a clean bill of health.
     */
    val integrationsError: String? = null,
)

class AdminSettingsViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    // Its own domain repo rather than another method on AuntieRepository: this
    // reaches one callable and shares no state with the rest of settings, the
    // same shape BookingRepository / InvoiceRepository have. Default-constructed
    // so existing call sites are unchanged; JVM tests pass a mock.
    private val integrationsRepository: IntegrationsRepository = IntegrationsRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(AdminSettingsUiState())
    val uiState: StateFlow<AdminSettingsUiState> = _uiState.asStateFlow()

    fun loadBusinessSettings() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            repository.getBusinessSettings().fold(
                onSuccess = { settings ->
                    _uiState.value = _uiState.value.copy(
                        businessSettings = settings,
                        isLoading = false
                    )
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to load settings: ${error.message}",
                        isLoading = false
                    )
                }
            )
        }
    }

    fun updateBusinessSettings(settings: BusinessSettings) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(businessSettings = settings, saveSuccess = false)

            repository.saveBusinessSettings(settings, "admin").fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        businessSettings = settings,
                        saveSuccess = true,
                        error = null
                    )
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to save settings: ${error.message}",
                        saveSuccess = false
                    )
                }
            )
        }
    }

    // ---- Business hours ----

    fun loadBusinessHours() {
        viewModelScope.launch {
            repository.getBusinessHours().fold(
                onSuccess = { rows ->
                    _uiState.value = _uiState.value.copy(
                        businessHours = ensureSevenDays(rows),
                        error         = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to load business hours: ${e.message}",
                    )
                }
            )
        }
    }

    fun updateBusinessHours(hours: List<BusinessHours>) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(businessHours = hours, saveSuccess = false)
            repository.saveBusinessHours(hours).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        businessHours = hours,
                        saveSuccess   = true,
                        error         = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        error       = "Failed to save business hours: ${e.message}",
                        saveSuccess = false,
                    )
                }
            )
        }
    }

    /** Local-only single-row edit. Persisted when the user hits the save button. */
    fun setBusinessHourRow(row: BusinessHours) {
        val next = _uiState.value.businessHours.map {
            if (it.dayOfWeek == row.dayOfWeek) row else it
        }
        _uiState.value = _uiState.value.copy(businessHours = next, saveSuccess = false)
    }

    // ---- User profile ----

    fun loadUserProfile() {
        val user = FirebaseAuth.getInstance().currentUser ?: return
        viewModelScope.launch {
            repository.observeUserProfile(user.uid).collect { stored ->
                val profile = stored ?: UserProfile(
                    uid = user.uid,
                    email = user.email.orEmpty(),
                )
                _uiState.value = _uiState.value.copy(profile = profile)
            }
        }
    }

    fun updateProfileField(transform: (UserProfile) -> UserProfile) {
        _uiState.value = _uiState.value.copy(
            profile = transform(_uiState.value.profile),
            profileSaveSuccess = false,
        )
    }

    fun saveProfile() {
        val current = _uiState.value.profile
        val user = FirebaseAuth.getInstance().currentUser ?: run {
            _uiState.value = _uiState.value.copy(error = "Sign in required to save profile")
            return
        }
        viewModelScope.launch {
            val toSave = current.copy(
                uid = user.uid,
                email = current.email.ifBlank { user.email.orEmpty() },
            )
            repository.saveUserProfile(toSave).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        profile = toSave,
                        profileSaveSuccess = true,
                        error = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to save profile: ${e.message}",
                        profileSaveSuccess = false,
                    )
                }
            )
        }
    }

    /**
     * 17.4 Nav editor: persist this admin's bottom-nav customization onto users/{uid}.
     * Copies the tokens onto the loaded profile (saveUserProfile overwrites the doc, so
     * theme/branding/dashboard are preserved). Fail loud on a write failure.
     */
    fun saveNavConfig(tokens: List<String>) {
        val user = FirebaseAuth.getInstance().currentUser ?: run {
            _uiState.value = _uiState.value.copy(error = "Sign in required to save navigation")
            return
        }
        viewModelScope.launch {
            // Re-read the latest profile before merge so a pref another screen saved
            // (dashboard / theme / branding) since this screen loaded is never clobbered
            // (saveUserProfile overwrites the whole doc). Falls back to the in-memory copy.
            val fresh = runCatching { repository.observeUserProfile(user.uid).first() }.getOrNull()
                ?: _uiState.value.profile
            val toSave = fresh.copy(
                uid = user.uid,
                email = fresh.email.ifBlank { user.email.orEmpty() },
                navConfig = tokens,
            )
            repository.saveUserProfile(toSave).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(profile = toSave, profileSaveSuccess = true, error = null)
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(error = "Navigation not saved: ${e.message}")
                },
            )
        }
    }

    fun uploadAvatar(context: Context, uri: Uri) {
        val user = FirebaseAuth.getInstance().currentUser ?: run {
            _uiState.value = _uiState.value.copy(error = "Sign in required to upload avatar")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isUploadingAvatar = true, error = null)
            val manager = MediaUploadManager(context, repository)
            manager.uploadMedia(
                uri = uri,
                entityId = user.uid,
                entityType = MediaEntityType.USER,
            ).fold(
                onSuccess = { mediaFile ->
                    val updated = _uiState.value.profile.copy(photoUrl = mediaFile.storageUrl)
                    repository.saveUserProfile(updated.copy(uid = user.uid)).fold(
                        onSuccess = {
                            _uiState.value = _uiState.value.copy(
                                profile = updated,
                                isUploadingAvatar = false,
                                profileSaveSuccess = true,
                            )
                        },
                        onFailure = { e ->
                            _uiState.value = _uiState.value.copy(
                                isUploadingAvatar = false,
                                error = "Avatar uploaded but profile save failed: ${e.message}",
                            )
                        }
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        isUploadingAvatar = false,
                        error = "Avatar upload failed: ${e.message}",
                    )
                }
            )
        }
    }

    /**
     * 17.2 Branding: upload a workspace logo to Cloudinary and STAGE its URL (do
     * not persist yet). The staged URL commits to the business_settings doc only
     * when the operator hits "Save Branding" ([saveBranding]), together with the
     * text fields - one write, the web stage-then-save model. Staging (rather than
     * an immediate save) removes the prior read-modify-write race where a logo save
     * could merge onto a stale in-memory doc and clobber a sibling field. Fail-loud:
     * an upload failure surfaces the raw message. Picker null (cancel) is guarded at
     * the call site.
     */
    fun uploadLogo(context: Context, uri: Uri) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isUploadingLogo = true, error = null)
            val manager = MediaUploadManager(context, repository)
            manager.uploadMedia(
                uri = uri,
                entityId = "business_settings",
                entityType = MediaEntityType.BUSINESS,
            ).fold(
                onSuccess = { mediaFile ->
                    _uiState.value = _uiState.value.copy(
                        stagedLogoUrl = mediaFile.storageUrl,
                        isUploadingLogo = false,
                        error = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        isUploadingLogo = false,
                        error = "Logo upload failed: ${e.message}",
                    )
                }
            )
        }
    }

    /** Stage logo removal (commits on the next [saveBranding], like the text edits). */
    fun stageLogoRemoval() {
        _uiState.value = _uiState.value.copy(stagedLogoUrl = "")
    }

    /**
     * 17.2 Branding: commit the staged logo (if any) + the four text fields onto the
     * business_settings doc in a single merge write. The effective logo is the staged
     * URL when present, else the already-saved one. Only the five branding fields
     * change (withBranding preserves every sibling); fail-loud on save failure.
     */
    fun saveBranding(wordmark: String, tagline: String, greeting: String, accentTail: String) {
        viewModelScope.launch {
            val current = _uiState.value.businessSettings
            val effectiveLogo = _uiState.value.stagedLogoUrl ?: current.logoUrl
            val merged = current.withBranding(
                logoUrl = effectiveLogo,
                wordmark = wordmark,
                tagline = tagline,
                greeting = greeting,
                accentTail = accentTail,
                // Stamped so a removal made HERE reads as a removal on the web
                // Settings screen too, rather than as "no logo set yet". Without
                // it the two surfaces would disagree about what an empty logo
                // means, which is the whole point of the field.
                logoRemovedAt = nextLogoRemovedAt(
                    previousLogoUrl = current.logoUrl,
                    previousRemovedAt = current.logoRemovedAt,
                    nextLogoUrl = effectiveLogo,
                    nowIso = java.time.Instant.now().toString(),
                ),
            )
            _uiState.value = _uiState.value.copy(saveSuccess = false)
            repository.saveBusinessSettings(merged, "admin").fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        businessSettings = merged,
                        stagedLogoUrl = null,
                        saveSuccess = true,
                        error = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to save branding: ${e.message}",
                        saveSuccess = false,
                    )
                }
            )
        }
    }

    // ---- Password reset ----

    fun sendPasswordResetEmail(email: String) {
        if (!isPlausibleEmail(email)) {
            _uiState.value = _uiState.value.copy(error = "Enter a valid email address before sending a reset link.")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSendingPasswordReset = true, error = null)
            repository.sendPasswordReset(email.trim()).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        isSendingPasswordReset = false,
                        passwordResetSent      = true,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        isSendingPasswordReset = false,
                        passwordResetSent      = false,
                        error                  = "Failed to send reset email: ${e.message}",
                    )
                }
            )
        }
    }

    fun clearPasswordResetSent() {
        _uiState.value = _uiState.value.copy(passwordResetSent = false)
    }

    // ---- Credential change (login email / password), spec 29 item 15.4 ----

    fun changeLoginEmail(currentPassword: String, newEmail: String) {
        if (currentPassword.isBlank()) { _uiState.value = _uiState.value.copy(error = "Enter your current password.") ; return }
        if (!isPlausibleEmail(newEmail)) { _uiState.value = _uiState.value.copy(error = "Enter a valid new login email.") ; return }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(credentialBusy = true, error = null, credentialMessage = null)
            repository.updateLoginEmail(currentPassword, newEmail).fold(
                onSuccess = { _uiState.value = _uiState.value.copy(credentialBusy = false, credentialMessage = "Verification link sent to ${newEmail.trim()}. Confirm there to finish.") },
                onFailure = { e -> _uiState.value = _uiState.value.copy(credentialBusy = false, error = friendlyAuthError(e)) },
            )
        }
    }

    fun changeLoginPassword(currentPassword: String, newPassword: String, confirm: String) {
        if (currentPassword.isBlank()) { _uiState.value = _uiState.value.copy(error = "Enter your current password.") ; return }
        if (newPassword.length < 6) { _uiState.value = _uiState.value.copy(error = "New password must be at least 6 characters.") ; return }
        if (newPassword != confirm) { _uiState.value = _uiState.value.copy(error = "New passwords don't match.") ; return }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(credentialBusy = true, error = null, credentialMessage = null)
            repository.updateLoginPassword(currentPassword, newPassword).fold(
                onSuccess = { _uiState.value = _uiState.value.copy(credentialBusy = false, credentialMessage = "Password updated.") },
                onFailure = { e -> _uiState.value = _uiState.value.copy(credentialBusy = false, error = friendlyAuthError(e)) },
            )
        }
    }

    fun clearCredentialMessage() { _uiState.value = _uiState.value.copy(credentialMessage = null) }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    fun clearSaveSuccess() {
        _uiState.value = _uiState.value.copy(saveSuccess = false)
    }

    fun clearProfileSaveSuccess() {
        _uiState.value = _uiState.value.copy(profileSaveSuccess = false)
    }

    // ---- Integrations ----

    /**
     * The server's verdict on every outside service, plus this device's two
     * probes.
     *
     * TWO SOURCES, DELIBERATELY, AND THEY DO NOT OVERLAP. The callable owns
     * every question about the business (is Stripe's key set, did Cloudinary's
     * signing work, is a Google account connected), so the React admin and this
     * screen cannot disagree. The device probes own the two questions the server
     * cannot answer at all, because they are about this handset: can IT reach
     * Firestore, does IT hold an FCM token. A server answer to either would be
     * about a different machine.
     *
     * A FAILED READ IS RECORDED, NEVER FOLDED INTO AN EMPTY RESULT. "Nothing is
     * wrong" and "we could not find out" are the same screen otherwise, and the
     * first one is the one that stops an operator looking.
     */
    fun loadIntegrations() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                integrationsLoading = true,
                integrationsError = null,
                // Flip the device rows to CHECKING so the panel shows live activity.
                deviceProbes = _uiState.value.deviceProbes.map { it.copy(state = IntegrationHealthState.CHECKING) },
            )

            integrationsRepository.getIntegrationsHealth().fold(
                onSuccess = { health ->
                    _uiState.value = _uiState.value.copy(
                        integrationsHealth = health,
                        integrationsLoading = false,
                        integrationsError = null,
                    )
                },
                onFailure = { e ->
                    // The server's own text names the missing secret and the exact
                    // command that sets it. Summarising it here would delete the
                    // only instructions the operator gets.
                    _uiState.value = _uiState.value.copy(
                        integrationsLoading = false,
                        integrationsError = e.message ?: "The integrations check did not come back.",
                    )
                },
            )

            // This device's Firestore round-trip.
            val firestoreState = firestoreHealthFromProbe(repository.getBusinessSettings().isSuccess)

            // This device's FCM registration token.
            val fcmHasToken = runCatching {
                FirebaseMessaging.getInstance().token.await().isNotBlank()
            }.getOrDefault(false)
            val fcmState = fcmHealthFromTokenPresence(fcmHasToken)

            _uiState.value = _uiState.value.copy(
                deviceProbes = _uiState.value.deviceProbes.map { row ->
                    when (row.name) {
                        "Firestore" -> row.copy(state = firestoreState)
                        "Push notifications" -> row.copy(state = fcmState)
                        else -> row
                    }
                },
            )
        }
    }
}
