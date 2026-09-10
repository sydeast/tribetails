package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.TagScope
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
    /**
     * #713 tag delete. Its own three fields rather than reusing [error] and
     * [saveSuccess]: deleting a tag is a cascade over the whole directory and
     * says nothing about whether the settings document saved. An operator shown
     * "Saved" after a delete would not learn that households changed too.
     */
    val tagRemoveBusy: Boolean = false,
    /** What the last delete actually did. Null until one succeeds. */
    val tagRemoveMessage: String? = null,
    val tagRemoveError: String? = null,
)

class AdminSettingsViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    // Its own domain repo rather than another method on AuntieRepository: this
    // reaches one callable and shares no state with the rest of settings, the
    // same shape BookingRepository / InvoiceRepository have. Default-constructed
    // so existing call sites are unchanged; JVM tests pass a mock.
    private val integrationsRepository: IntegrationsRepository = IntegrationsRepository(),
    // #518: MediaUploadManager needs a real android.content.Context, which a plain
    // JVM unit test cannot construct. Real call sites never pass this (it defaults
    // to the production constructor); tests inject a mockk<MediaUploadManager>() so
    // uploadAvatar/uploadLogo's success/failure branches are exercised without
    // touching ContentResolver/OkHttp.
    private val mediaUploadManagerFactory: (Context) -> MediaUploadManager = { ctx -> MediaUploadManager(ctx, repository) },
) : ViewModel() {

    private val _uiState = MutableStateFlow(AdminSettingsUiState())
    val uiState: StateFlow<AdminSettingsUiState> = _uiState.asStateFlow()

    /**
     * The settings document exactly as Firestore handed it over, and the only
     * thing a save is allowed to diff against.
     *
     * NULL UNTIL A LOAD SUCCEEDS, which is load-bearing rather than tidy:
     * [AdminSettingsUiState.businessSettings] starts at `BusinessSettings()`, so
     * a save with no baseline would write ~46 Kotlin defaults over the real
     * document. [saveSettingsDiff] refuses instead.
     *
     * It advances only after a write the server accepted, so a failed save
     * leaves the edit pending and the retry still carries it.
     */
    private var settingsBaseline: BusinessSettings? = null

    fun loadBusinessSettings() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            repository.getBusinessSettings().fold(
                onSuccess = { settings ->
                    settingsBaseline = settings
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

    /**
     * Persist [settings] as the fields it CHANGES against [settingsBaseline].
     *
     * Every panel on this screen edits a different slice of one shared document,
     * and so does the React admin, which patches it per section
     * (`auntieos-admin/src/api/settingsWrite.ts`). Handing the repository the
     * whole model - which is what this used to do - wrote all ~46 fields back at
     * the values the phone read, reverting whatever had changed since. Only the
     * changed fields go now; `BusinessSettingsDiff.kt` says which fields exist
     * and why.
     *
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. `updatedAt`
     * says when the document last changed, and moving it for a save that changed
     * nothing makes it lie. The screen still reports success, because "saved" and
     * "nothing to save" are the same outcome to the operator - and the Business
     * Operations panel has a Save button that re-submits an untouched object.
     */
    private fun saveSettingsDiff(
        settings: BusinessSettings,
        failureLabel: String,
        // Branding stages its logo pick and commits it with the text fields, so
        // only that save may clear the staging slot. An unrelated panel's save
        // clearing it would throw away a logo the operator had picked but not
        // yet committed.
        clearStagedLogo: Boolean = false,
    ) {
        val baseline = settingsBaseline
        if (baseline == null) {
            _uiState.value = _uiState.value.copy(
                saveSuccess = false,
                error = "Reopen Settings before saving: its saved copy was never loaded.",
            )
            return
        }
        val changes = businessSettingsFieldChanges(baseline, settings)
        if (changes.isEmpty()) {
            _uiState.value = _uiState.value.copy(
                businessSettings = settings,
                stagedLogoUrl = if (clearStagedLogo) null else _uiState.value.stagedLogoUrl,
                saveSuccess = true,
                error = null,
            )
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(businessSettings = settings, saveSuccess = false)

            repository.updateBusinessSettingsFields(changes, "admin").fold(
                onSuccess = {
                    // The baseline moves to what the server now holds. Without
                    // this a second save re-sends the first save's fields, which
                    // is the same clobber one step later.
                    settingsBaseline = settings
                    _uiState.value = _uiState.value.copy(
                        businessSettings = settings,
                        stagedLogoUrl = if (clearStagedLogo) null else _uiState.value.stagedLogoUrl,
                        saveSuccess = true,
                        error = null
                    )
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "$failureLabel: ${error.message}",
                        saveSuccess = false
                    )
                }
            )
        }
    }

    fun updateBusinessSettings(settings: BusinessSettings) {
        saveSettingsDiff(settings, failureLabel = "Failed to save settings")
    }

    // ---- Tag vocabulary delete (#713) ----

    /**
     * Delete one tag, everywhere. Operator ruling: "IF THE TAG IS DELETED THEN
     * IT GOES AWAY COMPLETELY."
     *
     * NOT a settings save, and deliberately not routed through
     * [saveSettingsDiff]. The vocabulary row is only half of it; the name also
     * has to come off every `kinfolk` (household scope) or `kin` (pet scope)
     * doc carrying it, and that fan-out belongs on the server. `removeBusinessTag`
     * does both in one pass and reports how many records it touched.
     *
     * On success the row leaves BOTH the on-screen settings and
     * [settingsBaseline]. Leaving it in the baseline would make the next diff
     * re-send the deleted row and put the tag back in the list.
     *
     * A failure changes nothing locally: the callable strips assignments before
     * it touches the vocabulary, so the row is still on screen and pressing
     * Remove again finishes what the failed call started.
     */
    fun removeBusinessTag(scope: TagScope, name: String) {
        if (_uiState.value.tagRemoveBusy) return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                tagRemoveBusy = true,
                tagRemoveError = null,
                tagRemoveMessage = null,
            )
            repository.removeBusinessTag(scope.wire, name).fold(
                onSuccess = { touched ->
                    val current = _uiState.value.businessSettings
                    settingsBaseline = settingsBaseline?.let { withTagRemoved(it, scope, name) }
                    _uiState.value = _uiState.value.copy(
                        businessSettings = withTagRemoved(current, scope, name),
                        tagRemoveBusy = false,
                        tagRemoveMessage = tagRemovedSummary(scope, name, touched),
                        tagRemoveError = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        tagRemoveBusy = false,
                        tagRemoveError = "Couldn't remove \"$name\": ${e.message}",
                    )
                },
            )
        }
    }

    /** Clears the delete banners once the operator has read them. */
    fun clearTagRemoveFeedback() {
        _uiState.value = _uiState.value.copy(tagRemoveMessage = null, tagRemoveError = null)
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

    /**
     * The `users/{uid}` document as Firestore last handed it over, and the only
     * thing a profile save may diff against. Null while the document does not
     * exist: [uiState] falls back to a blank [UserProfile] so the form can
     * render, and diffing against that fallback would write ten Kotlin defaults
     * over a real profile. A null baseline therefore means CREATE, which is the
     * one case where writing the whole model is correct.
     */
    private var profileBaseline: UserProfile? = null

    fun loadUserProfile() {
        val user = FirebaseAuth.getInstance().currentUser ?: return
        viewModelScope.launch {
            repository.observeUserProfile(user.uid).collect { stored ->
                profileBaseline = stored
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
            repository.saveUserProfile(profileBaseline, toSave).fold(
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
     * Writes `navConfig` and nothing else, so a theme or dashboard saved elsewhere
     * since this screen loaded survives. Fail loud on a write failure.
     *
     * This used to RE-READ the profile before writing the whole model back, to
     * narrow the window in which it clobbered another screen's pref. Both halves
     * are gone: the diff against [profileBaseline] is what actually closes that
     * window, and a re-read could not, because the whole-model write still
     * reverted anything saved between the re-read and the save. Keeping the
     * re-read alongside the diff would be worse than either, since the re-read
     * returns the concurrent edit the diff exists to preserve and would make it
     * look unchanged.
     */
    fun saveNavConfig(tokens: List<String>) {
        val user = FirebaseAuth.getInstance().currentUser ?: run {
            _uiState.value = _uiState.value.copy(error = "Sign in required to save navigation")
            return
        }
        viewModelScope.launch {
            val base = profileBaseline ?: _uiState.value.profile
            val toSave = base.copy(
                uid = user.uid,
                email = base.email.ifBlank { user.email.orEmpty() },
                navConfig = tokens,
            )
            repository.saveUserProfile(profileBaseline, toSave).fold(
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
            val manager = mediaUploadManagerFactory(context)
            manager.uploadMedia(
                uri = uri,
                entityId = user.uid,
                entityType = MediaEntityType.USER,
            ).fold(
                onSuccess = { mediaFile ->
                    val updated = _uiState.value.profile.copy(photoUrl = mediaFile.storageUrl)
                    repository.saveUserProfile(profileBaseline, updated.copy(uid = user.uid)).fold(
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
            val manager = mediaUploadManagerFactory(context)
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
     * URL when present, else the already-saved one. Fail-loud on save failure.
     *
     * "Only the five branding fields change" used to be true of the MODEL and
     * false of the WRITE: `withBranding` preserves every sibling in memory, and
     * the write then sent all of them anyway. The diff is what makes the sentence
     * true of the document - a branding save now names the branding fields the
     * operator actually altered and nothing else.
     */
    fun saveBranding(wordmark: String, tagline: String, greeting: String, accentTail: String) {
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
        saveSettingsDiff(
            merged,
            failureLabel = "Failed to save branding",
            clearStagedLogo = true,
        )
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
