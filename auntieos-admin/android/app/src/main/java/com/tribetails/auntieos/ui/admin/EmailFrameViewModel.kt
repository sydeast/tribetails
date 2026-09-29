package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.repository.EmailFrameRepository
import com.tribetails.auntieos.media.MediaUploadManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * #957: the Settings "Email frame" section on Android. The web twin is
 * `auntieos-admin/src/screens/settings/EmailFrameSection.tsx`.
 *
 * Pessimistic (D-2026-09-12-SLOW-WAIT): nothing shows as saved until the
 * server answers, and the answer replaces both the loaded state and the draft.
 * A failed save keeps the draft and says why (D-SAVE-OR-FAIL-VISIBLY).
 */
class EmailFrameViewModel(
    private val repository: EmailFrameRepository = EmailFrameRepository(),
    // A real MediaUploadManager needs an android Context, which a JVM test
    // cannot build; tests pass a mock. Same seam as AdminSettingsViewModel.
    private val mediaUploadManagerFactory: (Context) -> MediaUploadManager = { ctx ->
        MediaUploadManager(ctx, AuntieOSApp.instance.repository)
    },
) : ViewModel() {

    sealed interface Load {
        data object Loading : Load
        data class Failed(val message: String) : Load
        data class Ready(val frame: EmailFrameRepository.EmailFrameState) : Load
    }

    enum class Busy { Save, Reset }

    data class UiState(
        val load: Load = Load.Loading,
        val draft: Map<String, String> = emailFrameDraftFrom(emptyMap()),
        val busy: Busy? = null,
        val error: String? = null,
        val savedNote: String? = null,
        val uploadingLogo: Boolean = false,
        val uploadError: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.value = _state.value.copy(load = Load.Loading)
        viewModelScope.launch {
            repository.getEmailFrame()
                .onSuccess { frame ->
                    _state.value = _state.value.copy(load = Load.Ready(frame), draft = emailFrameDraftFrom(frame.stored))
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(load = Load.Failed("Couldn't read the email frame: ${e.message ?: "load failed"}"))
                }
        }
    }

    fun edit(field: String, value: String) {
        _state.value = _state.value.copy(draft = _state.value.draft + (field to value), savedNote = null)
    }

    /** Back to what the server holds. */
    fun cancel() {
        val ready = _state.value.load as? Load.Ready ?: return
        _state.value = _state.value.copy(draft = emailFrameDraftFrom(ready.frame.stored), error = null)
    }

    /** The diff between the draft and what was loaded: exactly what Save would send. */
    fun pendingChanges(): Map<String, String?> {
        val ready = _state.value.load as? Load.Ready ?: return emptyMap()
        return emailFrameChanges(_state.value.draft, ready.frame.stored)
    }

    fun save() {
        val s = _state.value
        if (s.busy != null || s.load !is Load.Ready) return
        if (emailFrameProblems(s.draft).isNotEmpty()) return
        val changes = pendingChanges()
        if (changes.isEmpty()) return
        run(Busy.Save, "Saved. The next email sent uses it.") { repository.saveEmailFrame(changes) }
    }

    fun reset() {
        if (_state.value.busy != null || _state.value.load !is Load.Ready) return
        run(Busy.Reset, "Back to the default frame.") { repository.resetEmailFrame() }
    }

    /** The write in flight, kept so a slow one can be sent again. */
    private var inFlight: (() -> Unit)? = null
    /**
     * D-2026-09-12-SLOW-WAIT: "Sync now" on a slow save. Re-issues the write
     * already in flight, skipping the busy guard that [save] and [reset] apply.
     * Safe to repeat: a patch of the same values, or a reset, lands on the same
     * document the second time.
     */
    fun resend() {
        if (_state.value.busy == null) return
        inFlight?.invoke()
    }
    private fun run(kind: Busy, note: String, request: suspend () -> Result<EmailFrameRepository.EmailFrameState>) {
        _state.value = _state.value.copy(busy = kind, error = null, savedNote = null)
        inFlight = { launchRequest(note, request) }
        launchRequest(note, request)
    }
    private fun launchRequest(note: String, request: suspend () -> Result<EmailFrameRepository.EmailFrameState>) {
        viewModelScope.launch {
            request()
                .onSuccess { frame ->
                    _state.value = _state.value.copy(
                        load = Load.Ready(frame),
                        draft = emailFrameDraftFrom(frame.stored),
                        busy = null,
                        savedNote = note,
                    )
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(busy = null, error = e.message ?: "Save failed.")
                }
        }
    }

    /** Uploads to the business library (the folder the server's logo check accepts) and puts the URL in the draft. */
    fun uploadLogo(context: Context, uri: Uri) {
        _state.value = _state.value.copy(uploadingLogo = true, uploadError = null)
        viewModelScope.launch {
            mediaUploadManagerFactory(context)
                .uploadMedia(uri = uri, entityId = "business_settings", entityType = MediaEntityType.BUSINESS)
                .onSuccess { media ->
                    _state.value = _state.value.copy(uploadingLogo = false)
                    edit(EmailFrameFields.LOGO_URL, media.storageUrl)
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(uploadingLogo = false, uploadError = "Logo upload failed: ${e.message}")
                }
        }
    }

    suspend fun preview(frame: Map<String, String>) = repository.previewEmailFrame(frame)
}
