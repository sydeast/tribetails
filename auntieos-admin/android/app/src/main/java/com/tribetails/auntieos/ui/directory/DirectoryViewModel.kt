package com.tribetails.auntieos.ui.directory

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.BreedBank
import com.tribetails.auntieos.data.model.Dossier
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.FormSchemaSummary
import com.tribetails.auntieos.data.model.appliesToSchemaIds
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.domain.recentTalesFor
import com.tribetails.auntieos.domain.upcomingVisitsFor
import com.tribetails.auntieos.domain.invoicesForKinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.joinDateForEdit
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class DirectoryUiState(
    val allKinfolk: List<Kinfolk> = emptyList(),
    val displayedKinfolk: List<Kinfolk> = emptyList(),
    val kinByKinfolkId: Map<String, List<Kin>> = emptyMap(),
    // Stage 2 Step 2: per-kinfolk last completed visit date (YYYY-MM-DD) and KinTale
    // (sent report) counts, derived from kin_care_sessions. Drive the card's
    // last-visit footer (directory.lastVisit) and "New" badge (directory.newBadge).
    val lastVisitByKinfolkId: Map<String, String> = emptyMap(),
    val kintaleCountByKinfolkId: Map<String, Int> = emptyMap(),
    val isLoading: Boolean = true,
    val searchQuery: String = "",
    val statusFilter: String = "Active",
    val error: String? = null
)

data class ProfileUiState(
    val kinfolk: Kinfolk? = null,
    val dossier: Dossier? = null,
    val kinList: List<Kin> = emptyList(),
    val kin411Map: Map<String, Kin411> = emptyMap(),
    // Profile feeds (parity with web): real per-kinfolk joins.
    val recentTales: List<KinCareReport> = emptyList(),
    val upcomingVisits: List<KinCareSession> = emptyList(),
    val kinfolkInvoices: List<Invoice> = emptyList(),
    // Phase 2 household-notes migration: the structured HouseholdData backing the
    // gap list on the dossier migration box. null while still loading.
    val householdData: HouseholdData? = null,
    val isLoading: Boolean = true,
    val error: String? = null,
    // Custom KINFOLK form_schemas so saved dynamic-field VALUES render on the profile too.
    val kinfolkSchemas: List<FormSchema> = emptyList(),
    val schemaError: String? = null,
)

data class AddKinfolkUiState(
    val firstName: String = "",
    val lastName: String = "",
    val phoneNumber: String = "",
    val email: String = "",
    val secondaryPhone: String = "",
    val preferredContactMethod: String = "Text",
    val status: String = "prospect",
    val serviceAddress: String = "",
    val gateCode: String = "",
    val entryNotes: String = "",
    val wifiName: String = "",
    val wifiPassword: String = "",
    val emergencyContactName: String = "",
    val emergencyContactPhone: String = "",
    val internalNotes: String = "",
    val isSaving: Boolean = false,
    val isSuccess: Boolean = false,
    val error: String? = null
)

data class EditKinfolkUiState(
    val kinfolkId: String = "",
    val firstName: String = "",
    val lastName: String = "",
    val phoneNumber: String = "",
    val email: String = "",
    val status: String = "active",
    val outstandingBalance: String = "0.00",
    val tags: String = "", // comma-separated string

    // Contact & Identity
    val secondaryPhone: String = "",
    val secondaryEmail: String = "",
    val preferredContactMethod: String = "Text",
    val bestTimeToContact: String = "",

    // Home & Access
    val serviceAddress: String = "",
    val gateCode: String = "",
    val parkingInstructions: String = "",
    val entryNotes: String = "",
    val wifiName: String = "",
    val wifiPassword: String = "",

    // Emergency Contacts
    val emergencyContactName: String = "",
    val emergencyContactPhone: String = "",
    val emergencyContactRelation: String = "",

    // Household-level Vet Clinic.
    //
    // `vetClinicId` joins the household to a `vet_clinics` row; the three
    // strings stay DENORMALIZED beside it so an Auntie at a door has the clinic
    // phone off the household record without a second read, and a clinic
    // renamed in the shared bank cannot blank the number on file. Every
    // household that predates the picker has the strings and an EMPTY id, which
    // is a valid state the form renders rather than treating as broken.
    val vetClinicId: String = "",
    val vetClinicName: String = "",
    val vetClinicPhone: String = "",
    val vetClinicAddress: String = "",

    // The 24 hour clinic, same id + denormalized shape.
    val emergencyVetClinicId: String = "",
    val emergencyVetClinicName: String = "",
    val emergencyVetClinicPhone: String = "",
    val emergencyVetClinicAddress: String = "",

    // Admin & Relationship
    val internalNotes: String = "",
    val referralSource: String = "",
    /** `YYYY-MM-DD`, or blank. The editor's date picker cannot hold anything else. */
    val joinDate: String = "",
    /** What the document actually stored, when the picker could not open it as-is. */
    val joinDateNote: String? = null,

    // Profile photo (preserved through save so an unrelated edit cannot wipe it).
    val profilePictureUrl: String = "",
    val isUploadingPhoto: Boolean = false,

    // Phase 14: admin-authored KINFOLK form_schemas (appliesTo == KINFOLK). Answers
    // persist into Kinfolk.formValues. Mirrors the KIN precare fields above.
    val formValues: Map<String, String> = emptyMap(),
    val kinfolkSchemas: List<FormSchema> = emptyList(),
    val schemaError: String? = null,

    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val isSuccess: Boolean = false,
    val isDeleted: Boolean = false,
    val error: String? = null
)

data class AddKinUiState(
    val kinfolkId: String = "",
    val name: String = "",
    val species: String = "Dog",
    val breed: String = "",
    val age: String = "",
    val sex: String = "",
    val weight: String = "",
    val vetClinicName: String = "",
    val vetPhone: String = "",
    val allergies: String = "",
    val medicalConditions: String = "",
    val medications: String = "",
    val feedingBrand: String = "",
    val feedingAmount: String = "",
    val feedingFrequency: String = "",
    val pottyRoutine: String = "",
    val isSaving: Boolean = false,
    val isSuccess: Boolean = false,
    val error: String? = null
)

data class EditKinUiState(
    val kinId: String = "",
    val kinfolkId: String = "",
    val name: String = "",
    val species: String = "Dog",
    val breed: String = "",
    val age: String = "",
    val sex: String = "",
    val weight: String = "",
    val colorMarkings: String = "",
    val spayedNeutered: Boolean = false,
    val staysAs: String = "",
    val routine: String = "",
    val trainingCommands: String = "",
    val feedingBrand: String = "",
    val vaccinations: String = "",
    val medicationHealthNotes: String = "",
    val vetInfo: String = "",
    val checklist: String = "",
    val reactive: Boolean = false,
    val officeNotes: String = "",
    // Structured KIN form_schemas precare checklist (spec 06 item 5 / 1C).
    val formValues: Map<String, String> = emptyMap(),
    val kinSchemas: List<FormSchema> = emptyList(),
    val schemaError: String? = null,
    // Profile photo (preserved through save so an unrelated edit cannot wipe it).
    val profilePictureUrl: String = "",
    val isUploadingPhoto: Boolean = false,
    // Vet is single-source on the owning Kinfolk (household); shown READ-ONLY here,
    // inherited (spec 06 item 2 / 04 item 3). NOT written back from the Kin.
    val householdName: String = "",
    val householdVetName: String = "",
    val householdVetPhone: String = "",
    val householdVetAddress: String = "",
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val isSuccess: Boolean = false,
    val error: String? = null
)

/** Ids of the form_schemas placed on KIN (appliesTo == KIN). Pure; unit-tested. */
internal fun kinSchemaIds(summaries: List<FormSchemaSummary>): List<String> =
    appliesToSchemaIds(summaries, "KIN")

class DirectoryViewModel(
    private val repository: AuntieRepository,
    // W4-1: the household profile's invoice list is Invoice domain, injected directly.
    private val invoiceRepository: InvoiceRepository,
    // W4-3: the household's visit history and its KinTales are KinCare domain.
    private val kinCareRepository: KinCareRepository,
) : ViewModel() {

    private val _directoryState = MutableStateFlow(DirectoryUiState())
    val directoryState: StateFlow<DirectoryUiState> = _directoryState.asStateFlow()

    private val _profileState = MutableStateFlow(ProfileUiState())
    val profileState: StateFlow<ProfileUiState> = _profileState.asStateFlow()

    private val _addKinfolkState = MutableStateFlow(AddKinfolkUiState())
    val addKinfolkState: StateFlow<AddKinfolkUiState> = _addKinfolkState.asStateFlow()

    private val _editKinfolkState = MutableStateFlow(EditKinfolkUiState())
    val editKinfolkState: StateFlow<EditKinfolkUiState> = _editKinfolkState.asStateFlow()

    private val _addKinState = MutableStateFlow(AddKinUiState())
    val addKinState: StateFlow<AddKinUiState> = _addKinState.asStateFlow()

    private val _editKinState = MutableStateFlow(EditKinUiState())
    val editKinState: StateFlow<EditKinUiState> = _editKinState.asStateFlow()

    // Run-4 #6: seeded dog/cat breed banks for the Kin breed dropdown. Loaded from the
    // screen (LaunchedEffect), not VM init, so strict-mockk unit tests stay isolated.
    // A load failure leaves the banks empty -> the field degrades to free-text.
    private val _breedBank = MutableStateFlow(BreedBank())
    val breedBank: StateFlow<BreedBank> = _breedBank.asStateFlow()
    fun loadBreeds() {
        if (_breedBank.value.dogBreeds.isNotEmpty() || _breedBank.value.catBreeds.isNotEmpty()) return
        viewModelScope.launch {
            repository.getBreeds().onSuccess { _breedBank.value = it }
        }
    }

    // #14: portal-invite result message + in-flight flag (per-kinfolk + bulk).
    private val _inviteMessage = MutableStateFlow<String?>(null)
    val inviteMessage: StateFlow<String?> = _inviteMessage.asStateFlow()
    private val _inviteBusy = MutableStateFlow(false)
    val inviteBusy: StateFlow<Boolean> = _inviteBusy.asStateFlow()
    fun clearInviteMessage() { _inviteMessage.value = null }

    // Phase 2: dedicated toast channel for the dossier household-notes clear action
    // (kept separate from invites so neither one stomps the other's message).
    private val _clearMessage = MutableStateFlow<String?>(null)
    val clearMessage: StateFlow<String?> = _clearMessage.asStateFlow()
    fun clearClearMessage() { _clearMessage.value = null }

    // Phase 3: refresh-intelligence (synthesize) message + in-flight flag. Its own
    // channel so it never stomps the invite/clear toasts.
    private val _synthesizeMessage = MutableStateFlow<String?>(null)
    val synthesizeMessage: StateFlow<String?> = _synthesizeMessage.asStateFlow()
    private val _isSynthesizing = MutableStateFlow(false)
    val isSynthesizing: StateFlow<Boolean> = _isSynthesizing.asStateFlow()
    fun clearSynthesizeMessage() { _synthesizeMessage.value = null }

    /**
     * Refresh intelligence: re-runs synthesis for one household via the admin callable,
     * then reloads the profile so the new dossier/411 show. In-flight guarded; fail-loud.
     * Synthesis is per-household, so the kin-edit screen passes the kin's parent kinfolkId.
     */
    fun synthesizeProfile(kinfolkId: String) {
        if (_isSynthesizing.value) return
        if (kinfolkId.isBlank()) {
            _synthesizeMessage.value = "No household selected for refresh."
            return
        }
        viewModelScope.launch {
            _isSynthesizing.value = true
            repository.synthesizeProfile(kinfolkId)
                .onSuccess {
                    _synthesizeMessage.value = "Profile updated from recent history."
                    loadProfile(kinfolkId)
                }
                .onFailure { _synthesizeMessage.value = "Refresh failed: ${it.message}" }
            _isSynthesizing.value = false
        }
    }

    /**
     * Clears the kinfolk's free-text dossier householdNotes once the admin has migrated
     * it into structured HouseholdData. On success, reloads the profile so the one-shot
     * migration box hides; on failure, surfaces a fail-loud toast.
     */
    fun clearDossierHouseholdNotes(kinfolkId: String) {
        viewModelScope.launch {
            repository.clearDossierHouseholdNotes(kinfolkId)
                .onSuccess {
                    _clearMessage.value = "Cleared household notes from the dossier."
                    loadProfile(kinfolkId)
                }
                .onFailure { _clearMessage.value = "Clear failed: ${it.message}" }
        }
    }

    /** Invite a single kinfolk to the portal (inviteKinfolkToPortal callable). */
    fun inviteKinfolkToPortal(kinfolkId: String, kinfolkName: String) {
        if (_inviteBusy.value) return
        viewModelScope.launch {
            _inviteBusy.value = true
            repository.inviteKinfolkToPortal(kinfolkId).fold(
                onSuccess = { status ->
                    _inviteMessage.value = when (status) {
                        "sent" -> "Portal invite emailed."
                        "already_active" -> "$kinfolkName already has portal access."
                        "no_email" -> "No email on file for $kinfolkName."
                        else -> "Invite: $status"
                    }
                },
                onFailure = { _inviteMessage.value = "Invite failed: ${it.message}" },
            )
            _inviteBusy.value = false
        }
    }

    /** Bulk-invite every kinfolk with an email on file. Reports a summary. */
    fun inviteAllKinfolk() {
        if (_inviteBusy.value) return
        viewModelScope.launch {
            _inviteBusy.value = true
            val all = _directoryState.value.allKinfolk.filter { it.email.isNotBlank() }
            if (all.isEmpty()) {
                _inviteMessage.value = "No kinfolk have an email on file."
                _inviteBusy.value = false
                return@launch
            }
            var sent = 0; var already = 0; var failed = 0
            for (kf in all) {
                repository.inviteKinfolkToPortal(kf.id).fold(
                    onSuccess = { when (it) { "sent" -> sent++; "already_active" -> already++; else -> failed++ } },
                    onFailure = { failed++ },
                )
            }
            _inviteMessage.value = "Invites: $sent sent, $already already active" +
                if (failed > 0) ", $failed failed" else ""
            _inviteBusy.value = false
        }
    }

    init {
        AuntieLog.d("DirectoryViewModel initialized")
        loadDirectory()
    }

    fun loadDirectory() {
        AuntieLog.d("Loading directory")
        viewModelScope.launch {
            _directoryState.value = _directoryState.value.copy(isLoading = true, error = null)
            val kinfolkDef  = async { repository.getKinfolk() }
            val kinDef      = async { repository.getAllKin() }
            // Sessions feed the card's last-visit footer + the "New" badge's
            // zero-KinTale signal. A sessions read failure must not blank the
            // directory itself: degrade those two card extras to empty (the cards
            // still render), and log it.
            val sessionsDef = async { kinCareRepository.getKinCareSessions() }

            val kinfolkResult  = kinfolkDef.await()
            val kinResult      = kinDef.await()
            val sessionsResult = sessionsDef.await()

            kinfolkResult.onSuccess { all ->
                AuntieLog.d("Directory loaded: ${all.size} kinfolk")
                val kinMap = kinResult.getOrDefault(emptyList())
                    .groupBy { it.kinfolkId }
                val sessions = sessionsResult.getOrElse { e ->
                    AuntieLog.e("Directory: failed to load sessions for card extras", e)
                    emptyList()
                }
                _directoryState.value = _directoryState.value.copy(
                    allKinfolk              = all,
                    kinByKinfolkId          = kinMap,
                    lastVisitByKinfolkId    = com.tribetails.auntieos.domain.lastVisitByKinfolk(sessions),
                    kintaleCountByKinfolkId = com.tribetails.auntieos.domain.kintaleCountByKinfolk(sessions),
                    isLoading               = false,
                )
                applyFilters()
            }.onFailure { e ->
                AuntieLog.e("Failed to load directory", e)
                _directoryState.value = _directoryState.value.copy(isLoading = false, error = "Failed to load directory.")
            }
        }
    }

    fun search(query: String) {
        AuntieLog.d("Directory search: $query")
        _directoryState.value = _directoryState.value.copy(searchQuery = query)
        applyFilters()
    }

    fun setStatusFilter(status: String) {
        AuntieLog.d("Directory filter by status: $status")
        _directoryState.value = _directoryState.value.copy(statusFilter = status)
        applyFilters()
    }

    private fun applyFilters() {
        val state = _directoryState.value
        val filter = state.statusFilter
        val filtered = state.allKinfolk.filter { kf ->
            // Archived hidden unless the user explicitly selected the Archived filter.
            // "All" means all non-archived; explicit status match is case-insensitive.
            val matchesStatus = when {
                filter.equals("Archived", ignoreCase = true) -> kf.status.equals("archived", ignoreCase = true)
                filter == "All"                              -> !kf.status.equals("archived", ignoreCase = true)
                else                                         -> kf.status.equals(filter, ignoreCase = true)
            }
            val matchesSearch = state.searchQuery.isBlank() ||
                                kf.displayName.contains(state.searchQuery, ignoreCase = true) ||
                                kf.phoneNumber.contains(state.searchQuery, ignoreCase = true) ||
                                kf.email.contains(state.searchQuery, ignoreCase = true)
            matchesStatus && matchesSearch
        }
        // 03-directory item 3: order the directory by surname (last name), parity with web.
        val sorted = filtered.sortedBy {
            com.tribetails.auntieos.domain.kinfolkSurnameSortKey(it.firstName, it.lastName, it.displayName)
        }
        _directoryState.value = state.copy(displayedKinfolk = sorted)
    }

    fun loadProfile(kinfolkId: String) {
        AuntieLog.d("Loading profile for kinfolk: $kinfolkId")
        viewModelScope.launch {
            _profileState.value = ProfileUiState(isLoading = true)
            
            val kinfolk = _directoryState.value.allKinfolk.find { it.id == kinfolkId }
            if (kinfolk == null) {
                AuntieLog.w("Kinfolk $kinfolkId not found in local state, trying to fetch others")
                // Possibly load single kinfolk here if not in directory
                _profileState.value = ProfileUiState(isLoading = false, error = "Could not find Kinfolk.")
                return@launch
            }

            try {
                // Fetch linked sub-records
                val dossierDef = async { repository.getDossier(kinfolkId) }
                val kinDef = async { repository.getKin(kinfolkId) }
                val reportsDef = async { kinCareRepository.getAllKinCareReports() }
                val sessionsDef = async { kinCareRepository.getKinCareSessionsForKinfolk(kinfolkId) }
                val invoicesDef = async { invoiceRepository.getInvoicesForKinfolk(kinfolkId) }
                // Phase 2: structured HouseholdData drives the migration box's gap list.
                val householdDef = async { repository.getHouseholdData(kinfolkId) }

                val dossier = dossierDef.await().getOrNull()
                val kinList = kinDef.await().getOrDefault(emptyList())

                val kin411Map = mutableMapOf<String, Kin411>()
                kinList.map { kin ->
                    async { repository.get411ForKin(kin.id).getOrNull()?.let { kin411Map[kin.id] = it } }
                }.forEach { it.await() }

                // Profile feeds (parity with web): real joins via the pure helpers.
                val nowIso = java.time.Instant.now().toString()
                val recentTales = recentTalesFor(reportsDef.await().getOrDefault(emptyList()), kinfolkId)
                val upcomingVisits = upcomingVisitsFor(sessionsDef.await().getOrDefault(emptyList()), kinfolkId, nowIso)
                val kinfolkInvoices = invoicesForKinfolk(invoicesDef.await().getOrDefault(emptyList()), kinfolkId)
                val householdData = householdDef.await().getOrNull()

                AuntieLog.d("Profile loaded successfully for $kinfolkId")
                _profileState.value = ProfileUiState(
                    kinfolk = kinfolk,
                    dossier = dossier,
                    kinList = kinList,
                    kin411Map = kin411Map,
                    recentTales = recentTales,
                    upcomingVisits = upcomingVisits,
                    kinfolkInvoices = kinfolkInvoices,
                    householdData = householdData,
                    isLoading = false
                )
                // Custom KINFOLK form_schemas so saved dynamic-field values render on the
                // profile (read-only). Fail-loud via schemaError. Mirrors loadKinfolkForEdit.
                launch {
                    val schemas = runCatching {
                        val summaries = repository.listFormSchemas().getOrThrow()
                        appliesToSchemaIds(summaries, "KINFOLK").mapNotNull { repository.getFormSchema(it).getOrThrow() }
                    }
                    _profileState.value = _profileState.value.copy(
                        kinfolkSchemas = schemas.getOrDefault(emptyList()),
                        schemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load custom fields" },
                    )
                }
            } catch (e: Exception) {
                AuntieLog.e("Failed to load full profile for $kinfolkId", e)
                _profileState.value = ProfileUiState(isLoading = false, error = "Failed to load full profile.")
            }
        }
    }
    
    fun clearProfile() {
        _profileState.value = ProfileUiState()
    }

    // Add Kinfolk Form Methods
    fun updateFirstName(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(firstName = value) }
    fun updateLastName(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(lastName = value) }
    fun updatePhoneNumber(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(phoneNumber = value) }
    fun updateEmail(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(email = value) }
    fun updateSecondaryPhone(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(secondaryPhone = value) }
    fun updatePreferredContactMethod(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(preferredContactMethod = value) }
    fun updateAddStatus(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(status = value) }
    fun updateServiceAddress(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(serviceAddress = value) }
    fun updateGateCode(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(gateCode = value) }
    fun updateEntryNotes(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(entryNotes = value) }
    fun updateWifiName(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(wifiName = value) }
    fun updateWifiPassword(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(wifiPassword = value) }
    fun updateEmergencyContactName(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(emergencyContactName = value) }
    fun updateEmergencyContactPhone(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(emergencyContactPhone = value) }
    fun updateInternalNotes(value: String) { _addKinfolkState.value = _addKinfolkState.value.copy(internalNotes = value) }

    fun saveKinfolk() {
        val state = _addKinfolkState.value
        if (state.firstName.isBlank()) {
            _addKinfolkState.value = state.copy(error = "First name is required.")
            return
        }

        val finalStatus = state.status.ifBlank { "prospect" }
        AuntieLog.i("Saving new kinfolk: ${state.firstName} ${state.lastName} status=$finalStatus")
        viewModelScope.launch {
            _addKinfolkState.value = state.copy(isSaving = true, error = null)

            val newKinfolk = Kinfolk(
                firstName              = state.firstName,
                lastName               = state.lastName,
                phoneNumber            = state.phoneNumber,
                email                  = state.email,
                secondaryPhone         = state.secondaryPhone,
                preferredContactMethod = state.preferredContactMethod,
                serviceAddress         = state.serviceAddress,
                gateCode               = state.gateCode,
                entryNotes             = state.entryNotes,
                wifiName               = state.wifiName,
                wifiPassword           = state.wifiPassword,
                emergencyContactName   = state.emergencyContactName,
                emergencyContactPhone  = state.emergencyContactPhone,
                internalNotes          = state.internalNotes,
                status                 = finalStatus,
            )

            repository.createKinfolkComplete(newKinfolk).onSuccess { saved ->
                AuntieLog.i("Kinfolk saved: $finalStatus")
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "CREATE_KINFOLK",
                    description      = "Created kinfolk ${saved.displayName}",
                    targetId         = saved.id,
                    targetCollection = "kinfolk",
                )
                _addKinfolkState.value = AddKinfolkUiState(isSuccess = true)
                loadDirectory()
            }.onFailure { error ->
                AuntieLog.e("Failed to save kinfolk", error)
                _addKinfolkState.value = state.copy(
                    isSaving = false,
                    error    = error.message ?: "Failed to save Kinfolk",
                )
            }
        }
    }

    fun clearAddKinfolkForm() {
        _addKinfolkState.value = AddKinfolkUiState()
    }

    // Edit Kinfolk Form Methods
    fun updateEditFirstName(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(firstName = value) }
    fun updateEditLastName(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(lastName = value) }
    fun updateEditPhoneNumber(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(phoneNumber = value) }
    fun updateEditEmail(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(email = value) }
    fun updateEditStatus(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(status = value) }
    fun updateEditOutstandingBalance(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(outstandingBalance = value) }
    fun updateEditTags(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(tags = value) }
    fun updateEditSecondaryPhone(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(secondaryPhone = value) }
    fun updateEditSecondaryEmail(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(secondaryEmail = value) }
    fun updateEditPreferredContactMethod(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(preferredContactMethod = value) }
    fun updateEditBestTimeToContact(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(bestTimeToContact = value) }
    fun updateEditServiceAddress(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(serviceAddress = value) }
    fun updateEditGateCode(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(gateCode = value) }
    fun updateEditParkingInstructions(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(parkingInstructions = value) }
    fun updateEditEntryNotes(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(entryNotes = value) }
    fun updateEditWifiName(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(wifiName = value) }
    fun updateEditWifiPassword(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(wifiPassword = value) }
    fun updateEditEmergencyContactName(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(emergencyContactName = value) }
    fun updateEditEmergencyContactPhone(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(emergencyContactPhone = value) }
    fun updateEditEmergencyContactRelation(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(emergencyContactRelation = value) }
    fun updateEditReferralSource(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(referralSource = value) }
    /** Picked from the calendar, so the legacy note has been answered and goes away. */
    fun updateEditJoinDate(value: String) {
        _editKinfolkState.value = _editKinfolkState.value.copy(joinDate = value, joinDateNote = null)
    }
    fun updateEditInternalNotes(value: String) { _editKinfolkState.value = _editKinfolkState.value.copy(internalNotes = value) }
    // ── vet clinic: always a catalog row, never free text ────────────────────
    //
    // Operator ruling (issue #13, 2026-07-25): parity with web. There are
    // deliberately NO `updateEditVetClinicName/Phone/Address` writers any more.
    // They existed so the edit screen's plain text fields could type straight
    // into the household's stored vet, which is exactly the free-text path the
    // ruling removes. The only ways in are now [selectVetClinic] (a catalog
    // row), [createVetClinicFromSearch] (a row this creates), and
    // [clearVetClinic]. Re-adding a plain setter here re-opens the hole.
    //
    // Legacy households still LOAD their stored strings with an empty id, and
    // save back untouched. What is forbidden is creating new free-text vets,
    // not displaying old ones.

    fun selectVetClinic(clinic: com.tribetails.auntieos.data.model.VetClinic) {
        val sel = vetClinicSelectionOf(clinic)
        _editKinfolkState.value = _editKinfolkState.value.copy(
            vetClinicId      = sel.clinicId,
            vetClinicName    = sel.name,
            vetClinicPhone   = sel.phone,
            vetClinicAddress = sel.address,
        )
    }

    /** Empties ALL FOUR fields. A cleared vet must not leave a name behind. */
    fun clearVetClinic() {
        _editKinfolkState.value = _editKinfolkState.value.copy(
            vetClinicId = "", vetClinicName = "", vetClinicPhone = "", vetClinicAddress = "",
        )
    }

    fun selectEmergencyVetClinic(clinic: com.tribetails.auntieos.data.model.VetClinic) {
        val sel = vetClinicSelectionOf(clinic)
        _editKinfolkState.value = _editKinfolkState.value.copy(
            emergencyVetClinicId      = sel.clinicId,
            emergencyVetClinicName    = sel.name,
            emergencyVetClinicPhone   = sel.phone,
            emergencyVetClinicAddress = sel.address,
        )
    }

    fun clearEmergencyVetClinic() {
        _editKinfolkState.value = _editKinfolkState.value.copy(
            emergencyVetClinicId = "", emergencyVetClinicName = "",
            emergencyVetClinicPhone = "", emergencyVetClinicAddress = "",
        )
    }

    /**
     * The pinned "create this clinic" action under the search dropdown.
     *
     * Goes through `submitVetClinic` rather than the old direct
     * `createVetClinic` write, because that callable dedupes on a NORMALIZED
     * name and hands back the EXISTING id on a match. So a double tap, or a
     * clinic the bank already holds under a different capitalisation, SELECTS
     * that record instead of writing a second copy of it. Staff callers land
     * `verified: true`, so the clinic is live for households at once.
     *
     * `isEmergency` is stamped at creation for the emergency instance, so the
     * new clinic is already flagged and appears in that picker next time.
     */
    fun createVetClinicFromSearch(
        name: String,
        phone: String = "",
        address: String = "",
        website: String = "",
        isEmergency: Boolean = false,
        forEmergencySlot: Boolean = false,
    ) {
        val trimmed = name.trim()
        if (trimmed.isBlank()) return
        viewModelScope.launch {
            repository.submitVetClinic(
                com.tribetails.auntieos.data.model.VetClinic(
                    name = trimmed,
                    phone = phone.trim(),
                    address = address.trim(),
                    website = website.trim(),
                    isEmergency = isEmergency,
                )
            ).onSuccess { clinicId ->
                // On a DEDUPE hit the callable returns the id of a clinic already
                // in the bank. Prefer that record's stored details over what was
                // just typed: the bank's copy is the curated one, and replacing a
                // good phone number with a blank from a hurried retype is the
                // failure this guards. Falls back to the typed values for a
                // genuinely new clinic, which is not in the catalog snapshot yet.
                val existing = vetClinicsFlow.value.firstOrNull { it.id == clinicId }
                val selected = existing ?: com.tribetails.auntieos.data.model.VetClinic(
                    id = clinicId,
                    name = trimmed,
                    phone = phone.trim(),
                    address = address.trim(),
                    website = website.trim(),
                    isEmergency = isEmergency,
                )
                if (forEmergencySlot) selectEmergencyVetClinic(selected) else selectVetClinic(selected)
            }
        }
    }

    val vetClinicsFlow: kotlinx.coroutines.flow.StateFlow<List<com.tribetails.auntieos.data.model.VetClinic>> =
        repository.observeVetClinics()
            .stateIn(viewModelScope, kotlinx.coroutines.flow.SharingStarted.WhileSubscribed(5_000), emptyList())

    // ---- Address autocomplete (Mapbox via Functions) ----
    private val mapboxClient = com.tribetails.auntieos.data.api.MapboxClient(repository)
    private var mapboxSession: String = com.tribetails.auntieos.data.api.newMapboxSessionToken()
    private var lastSuggestJob: kotlinx.coroutines.Job? = null

    private val _addressSuggestions = MutableStateFlow<List<com.tribetails.auntieos.data.api.MapboxSuggestion>>(emptyList())
    val addressSuggestions: StateFlow<List<com.tribetails.auntieos.data.api.MapboxSuggestion>> = _addressSuggestions.asStateFlow()

    private val _addressError = MutableStateFlow<String?>(null)
    val addressError: StateFlow<String?> = _addressError.asStateFlow()

    fun queryAddressSuggestions(query: String) {
        lastSuggestJob?.cancel()
        if (query.length < 3) {
            _addressSuggestions.value = emptyList()
            return
        }
        lastSuggestJob = viewModelScope.launch {
            kotlinx.coroutines.delay(250) // debounce
            when (val r = mapboxClient.suggest(query, mapboxSession)) {
                is com.tribetails.auntieos.data.api.MapboxClient.SuggestResult.Ok -> {
                    _addressSuggestions.value = r.suggestions
                    _addressError.value = null
                }
                is com.tribetails.auntieos.data.api.MapboxClient.SuggestResult.Err -> {
                    _addressSuggestions.value = emptyList()
                    _addressError.value = r.message
                }
            }
        }
    }

    fun pickAddressSuggestion(s: com.tribetails.auntieos.data.api.MapboxSuggestion) {
        retrieveAddress(s) { resolved ->
            _editKinfolkState.value = _editKinfolkState.value.copy(serviceAddress = resolved)
        }
    }

    /**
     * The ADD path's picker. Same retrieve and the same session-token rotation,
     * writing into the add form instead of the edit form. Split rather than
     * parameterised on a flag so neither screen can accidentally write the
     * other's state.
     */
    fun pickAddressSuggestionForAdd(s: com.tribetails.auntieos.data.api.MapboxSuggestion) {
        retrieveAddress(s) { resolved ->
            _addKinfolkState.value = _addKinfolkState.value.copy(serviceAddress = resolved)
        }
    }

    /**
     * Resolve a picked suggestion, then ROTATE the Mapbox session token. The
     * token must be the same one every suggest in this search used, or Mapbox
     * bills the suggests and the retrieve as separate sessions; it must be a
     * fresh one for the NEXT search, or the retired session keeps being charged.
     *
     * A failure leaves the typed address exactly as it is. Overwriting what the
     * operator typed with a blank on a failed lookup would be the worst possible
     * response to "we could not resolve that".
     */
    private fun retrieveAddress(
        s: com.tribetails.auntieos.data.api.MapboxSuggestion,
        write: (String) -> Unit,
    ) {
        viewModelScope.launch {
            when (val r = mapboxClient.retrieve(s.mapboxId, mapboxSession)) {
                is com.tribetails.auntieos.data.api.MapboxClient.RetrieveResult.Ok -> {
                    write(r.feature.resolvedAddress)
                    _addressSuggestions.value = emptyList()
                    _addressError.value = null
                    mapboxSession = com.tribetails.auntieos.data.api.newMapboxSessionToken()
                }
                is com.tribetails.auntieos.data.api.MapboxClient.RetrieveResult.Err -> {
                    _addressError.value = r.message
                }
            }
        }
    }

    fun loadKinfolkForEdit(kinfolkId: String) {
        AuntieLog.d("Loading kinfolk for edit: $kinfolkId")
        viewModelScope.launch {
            _editKinfolkState.value = EditKinfolkUiState(isLoading = true)

            val kinfolk = _directoryState.value.allKinfolk.find { it.id == kinfolkId }
            if (kinfolk == null) {
                repository.getKinfolk().onSuccess { kinfolkList ->
                    val foundKinfolk = kinfolkList.find { it.id == kinfolkId }
                    if (foundKinfolk != null) {
                        populateEditForm(foundKinfolk)
                    } else {
                        AuntieLog.w("Kinfolk $kinfolkId not found for edit")
                        _editKinfolkState.value = EditKinfolkUiState(isLoading = false, error = "Kinfolk not found")
                    }
                }.onFailure { e ->
                    AuntieLog.e("Failed to load kinfolk for edit", e)
                    _editKinfolkState.value = EditKinfolkUiState(isLoading = false, error = "Failed to load Kinfolk")
                }
            } else {
                populateEditForm(kinfolk)
            }
        }
    }

    private fun populateEditForm(kinfolk: Kinfolk) {
        // The join date is a picker now, and a picker can only hold YYYY-MM-DD.
        // Legacy values (stored ISO instants, free text from when this was a text
        // field) are coerced or cleared HERE, once, on the way in, and whatever
        // was stored is carried alongside in `joinDateNote` so the editor can say
        // so rather than dropping it silently. See util/JoinDate.kt.
        val opened = joinDateForEdit(kinfolk.joinDate)
        _editKinfolkState.value = EditKinfolkUiState(
            kinfolkId = kinfolk.id,
            firstName = kinfolk.firstName,
            lastName = kinfolk.lastName,
            phoneNumber = kinfolk.phoneNumber,
            email = kinfolk.email,
            status = kinfolk.status,
            outstandingBalance = kinfolk.outstandingBalance,
            tags = kinfolk.tagNames().joinToString(", "),

            secondaryPhone = kinfolk.secondaryPhone,
            secondaryEmail = kinfolk.secondaryEmail,
            preferredContactMethod = kinfolk.preferredContactMethod,
            bestTimeToContact = kinfolk.bestTimeToContact,

            serviceAddress = kinfolk.serviceAddress,
            gateCode = kinfolk.gateCode,
            parkingInstructions = kinfolk.parkingInstructions,
            entryNotes = kinfolk.entryNotes,
            wifiName = kinfolk.wifiName,
            wifiPassword = kinfolk.wifiPassword,

            emergencyContactName = kinfolk.emergencyContactName,
            emergencyContactPhone = kinfolk.emergencyContactPhone,
            emergencyContactRelation = kinfolk.emergencyContactRelation,

            vetClinicId      = kinfolk.vetClinicId,
            vetClinicName    = kinfolk.vetClinicName,
            vetClinicPhone   = kinfolk.vetClinicPhone,
            vetClinicAddress = kinfolk.vetClinicAddress,
            emergencyVetClinicId      = kinfolk.emergencyVetClinicId,
            emergencyVetClinicName    = kinfolk.emergencyVetClinicName,
            emergencyVetClinicPhone   = kinfolk.emergencyVetClinicPhone,
            emergencyVetClinicAddress = kinfolk.emergencyVetClinicAddress,

            internalNotes = kinfolk.internalNotes,
            referralSource = kinfolk.referralSource,
            joinDate = opened.value,
            joinDateNote = opened.note,

            profilePictureUrl = kinfolk.profilePictureUrl,

            formValues = kinfolk.formValues,

            isLoading = false
        )
        // Phase 14: fetch the KINFOLK-placed form_schemas. A load failure surfaces as
        // schemaError (fail-loud), never a silent-empty panel. Mirrors loadKinForEdit.
        viewModelScope.launch {
            val schemas = runCatching {
                val summaries = repository.listFormSchemas().getOrThrow()
                appliesToSchemaIds(summaries, "KINFOLK").mapNotNull { repository.getFormSchema(it).getOrThrow() }
            }
            _editKinfolkState.value = _editKinfolkState.value.copy(
                kinfolkSchemas = schemas.getOrDefault(emptyList()),
                schemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load custom fields" },
            )
        }
    }

    /** Phase 14: update one KINFOLK custom-field answer in the edit state. */
    fun updateEditKinfolkFormValue(key: String, value: String) {
        _editKinfolkState.value =
            _editKinfolkState.value.copy(formValues = _editKinfolkState.value.formValues + (key to value))
    }

    fun saveKinfolkChanges() {
        val state = _editKinfolkState.value
        if (state.firstName.isBlank() || state.phoneNumber.isBlank() || state.kinfolkId.isBlank()) return

        AuntieLog.i("Saving changes for kinfolk: ${state.kinfolkId}")
        viewModelScope.launch {
            _editKinfolkState.value = state.copy(isSaving = true, error = null)

            val updatedKinfolk = buildKinfolkFromEditState(state)

            repository.updateKinfolk(updatedKinfolk).onSuccess {
                AuntieLog.i("Kinfolk changes saved")
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "UPDATE_KINFOLK",
                    description      = "Updated kinfolk ${updatedKinfolk.displayName}",
                    targetId         = updatedKinfolk.id,
                    targetCollection = "kinfolk",
                )
                _editKinfolkState.value = state.copy(isSaving = false, isSuccess = true)
                loadDirectory()
            }.onFailure { error ->
                AuntieLog.e("Failed to update kinfolk", error)
                _editKinfolkState.value = state.copy(
                    isSaving = false,
                    error = error.message ?: "Failed to update Kinfolk"
                )
            }
        }
    }

    fun archiveKinfolk(reason: String) {
        val kinfolkId = _editKinfolkState.value.kinfolkId
        if (kinfolkId.isBlank()) return

        AuntieLog.i("Archiving kinfolk: $kinfolkId (reason: $reason)")
        viewModelScope.launch {
            repository.archiveKinfolk(kinfolkId, reason.trim()).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "ARCHIVE_KINFOLK",
                    description      = if (reason.isBlank()) "Archived kinfolk" else "Archived kinfolk (reason: ${reason.trim()})",
                    targetId         = kinfolkId,
                    targetCollection = "kinfolk",
                )
                _editKinfolkState.value = _editKinfolkState.value.copy(isDeleted = true)
                loadDirectory()
            }.onFailure { error ->
                AuntieLog.e("Failed to archive kinfolk", error)
                _editKinfolkState.value = _editKinfolkState.value.copy(
                    error = error.message ?: "Failed to archive Kinfolk"
                )
            }
        }
    }

    fun unarchiveKinfolk() {
        val kinfolkId = _editKinfolkState.value.kinfolkId
        if (kinfolkId.isBlank()) return

        AuntieLog.i("Unarchiving kinfolk: $kinfolkId")
        viewModelScope.launch {
            repository.unarchiveKinfolk(kinfolkId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "UNARCHIVE_KINFOLK",
                    description      = "Unarchived kinfolk",
                    targetId         = kinfolkId,
                    targetCollection = "kinfolk",
                )
                _editKinfolkState.value = _editKinfolkState.value.copy(status = "active")
                loadDirectory()
            }.onFailure { error ->
                AuntieLog.e("Failed to unarchive kinfolk", error)
                _editKinfolkState.value = _editKinfolkState.value.copy(
                    error = error.message ?: "Failed to unarchive Kinfolk"
                )
            }
        }
    }

    fun clearEditKinfolkForm() {
        _editKinfolkState.value = EditKinfolkUiState()
    }

    // Rebuilds the full Kinfolk from edit-form state. updateKinfolk uses .set()
    // (full overwrite), so EVERY field the user can carry must be present here or
    // it gets wiped, profilePictureUrl included.
    private fun buildKinfolkFromEditState(state: EditKinfolkUiState): Kinfolk = Kinfolk(
        id = state.kinfolkId,
        firstName = state.firstName,
        lastName = state.lastName,
        phoneNumber = state.phoneNumber,
        email = state.email,
        status = state.status,
        outstandingBalance = state.outstandingBalance,
        tags = state.tags.split(",").map { it.trim() }.filter { it.isNotBlank() },

        secondaryPhone = state.secondaryPhone,
        secondaryEmail = state.secondaryEmail,
        preferredContactMethod = state.preferredContactMethod,
        bestTimeToContact = state.bestTimeToContact,

        serviceAddress = state.serviceAddress,
        gateCode = state.gateCode,
        parkingInstructions = state.parkingInstructions,
        entryNotes = state.entryNotes,
        wifiName = state.wifiName,
        wifiPassword = state.wifiPassword,

        emergencyContactName = state.emergencyContactName,
        emergencyContactPhone = state.emergencyContactPhone,
        emergencyContactRelation = state.emergencyContactRelation,

        vetClinicId      = state.vetClinicId,
        vetClinicName    = state.vetClinicName,
        vetClinicPhone   = state.vetClinicPhone,
        vetClinicAddress = state.vetClinicAddress,
        emergencyVetClinicId      = state.emergencyVetClinicId,
        emergencyVetClinicName    = state.emergencyVetClinicName,
        emergencyVetClinicPhone   = state.emergencyVetClinicPhone,
        emergencyVetClinicAddress = state.emergencyVetClinicAddress,

        internalNotes = state.internalNotes,
        referralSource = state.referralSource,
        joinDate = state.joinDate,
        profilePictureUrl = state.profilePictureUrl,
        formValues = state.formValues,
    )

    // Uploads a Kinfolk profile photo and persists it immediately (parity with the
    // web KinfolkEditScreen flow). Reuses the proven Cloudinary signed-upload
    // pipeline via MediaUploadManager. Fail-loud: any failure surfaces in state.error.
    fun uploadKinfolkPhoto(context: Context, uri: Uri) {
        val state = _editKinfolkState.value
        if (state.kinfolkId.isBlank()) {
            _editKinfolkState.value = state.copy(error = "Save the kinfolk before adding a photo")
            return
        }
        viewModelScope.launch {
            _editKinfolkState.value = _editKinfolkState.value.copy(isUploadingPhoto = true, error = null)
            MediaUploadManager(context, repository).uploadMedia(
                uri = uri,
                entityId = state.kinfolkId,
                entityType = MediaEntityType.KINFOLK,
            ).onSuccess { media ->
                val withPhoto = _editKinfolkState.value.copy(profilePictureUrl = media.storageUrl)
                repository.updateKinfolk(buildKinfolkFromEditState(withPhoto)).onSuccess {
                    _editKinfolkState.value = withPhoto.copy(isUploadingPhoto = false)
                    loadDirectory()
                }.onFailure { e ->
                    _editKinfolkState.value = _editKinfolkState.value.copy(
                        isUploadingPhoto = false,
                        error = "Photo uploaded but save failed: ${e.message}",
                    )
                }
            }.onFailure { e ->
                AuntieLog.e("Kinfolk photo upload failed", e)
                _editKinfolkState.value = _editKinfolkState.value.copy(
                    isUploadingPhoto = false,
                    error = "Photo upload failed: ${e.message}",
                )
            }
        }
    }

    // Add Kin Form Methods
    fun setKinfolkForNewKin(kinfolkId: String) { _addKinState.value = _addKinState.value.copy(kinfolkId = kinfolkId) }
    fun updateKinName(value: String) { _addKinState.value = _addKinState.value.copy(name = value) }
    fun updateKinSpecies(value: String) { _addKinState.value = _addKinState.value.copy(species = value) }
    fun updateKinBreed(value: String) { _addKinState.value = _addKinState.value.copy(breed = value) }
    fun updateKinAge(value: String) { _addKinState.value = _addKinState.value.copy(age = value) }
    fun updateKinSex(value: String) { _addKinState.value = _addKinState.value.copy(sex = value) }
    fun updateKinWeight(value: String) { _addKinState.value = _addKinState.value.copy(weight = value) }
    fun updateKinVetClinicName(value: String) { _addKinState.value = _addKinState.value.copy(vetClinicName = value) }
    fun updateKinVetPhone(value: String) { _addKinState.value = _addKinState.value.copy(vetPhone = value) }
    fun updateKinAllergies(value: String) { _addKinState.value = _addKinState.value.copy(allergies = value) }
    fun updateKinMedicalConditions(value: String) { _addKinState.value = _addKinState.value.copy(medicalConditions = value) }
    fun updateKinMedications(value: String) { _addKinState.value = _addKinState.value.copy(medications = value) }
    fun updateKinFeedingBrand(value: String) { _addKinState.value = _addKinState.value.copy(feedingBrand = value) }
    fun updateKinFeedingAmount(value: String) { _addKinState.value = _addKinState.value.copy(feedingAmount = value) }
    fun updateKinFeedingFrequency(value: String) { _addKinState.value = _addKinState.value.copy(feedingFrequency = value) }
    fun updateKinPottyRoutine(value: String) { _addKinState.value = _addKinState.value.copy(pottyRoutine = value) }

    fun saveKin() {
        val state = _addKinState.value
        if (state.name.isBlank() || state.kinfolkId.isBlank()) return

        AuntieLog.i("Saving new kin: ${state.name} for kinfolk: ${state.kinfolkId}")
        viewModelScope.launch {
            _addKinState.value = state.copy(isSaving = true, error = null)

            val newKin = Kin(
                kinfolkId = state.kinfolkId,
                name = state.name,
                species = state.species,
                breed = state.breed,
                age = state.age,
                sex = state.sex,
                weight = state.weight,
                status = "active"
            )

            repository.createKin(newKin).onSuccess { saved ->
                AuntieLog.i("Kin saved successfully")
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "CREATE_KIN",
                    description      = "Created kin ${newKin.name} for kinfolk ${state.kinfolkId}",
                    targetId         = saved.id,
                    targetCollection = "kin",
                )
                _addKinState.value = AddKinUiState(isSuccess = true)
                loadProfile(state.kinfolkId)
            }.onFailure { error ->
                AuntieLog.e("Failed to save kin", error)
                _addKinState.value = state.copy(
                    isSaving = false,
                    error = error.message ?: "Failed to save Kin"
                )
            }
        }
    }

    fun clearAddKinForm() {
        _addKinState.value = AddKinUiState()
    }

    // --- Edit Kin Methods ---

    fun loadKinForEdit(kinId: String) {
        AuntieLog.d("Loading kin for edit: $kinId")
        viewModelScope.launch {
            _editKinState.value = _editKinState.value.copy(isLoading = true, error = null)

            val kin = _profileState.value.kinList.find { it.id == kinId }
            if (kin != null) {
                // Inherit the household vet from the owning Kinfolk (read-only on Kin).
                val owner = _directoryState.value.allKinfolk.find { it.id == kin.kinfolkId }
                    ?: _profileState.value.kinfolk?.takeIf { it.id == kin.kinfolkId }
                _editKinState.value = EditKinUiState(
                    kinId = kin.id,
                    kinfolkId = kin.kinfolkId,
                    name = kin.name,
                    species = kin.species,
                    breed = kin.breed,
                    age = kin.age,
                    sex = kin.sex,
                    weight = kin.weight,
                    colorMarkings = kin.colorMarkings,
                    spayedNeutered = kin.spayedNeutered,
                    staysAs = kin.staysAs,
                    routine = kin.routine,
                    trainingCommands = kin.trainingCommands,
                    feedingBrand = kin.feedingBrand,
                    vaccinations = kin.vaccinations,
                    medicationHealthNotes = kin.medicationHealthNotes,
                    vetInfo = kin.vetInfo,
                    checklist = kin.checklist,
                    reactive = kin.reactive,
                    officeNotes = kin.officeNotes,
                    formValues = kin.formValues,
                    profilePictureUrl = kin.profilePictureUrl,
                    householdName = listOf(owner?.firstName, owner?.lastName)
                        .mapNotNull { it?.takeIf(String::isNotBlank) }.joinToString(" ").ifBlank { "household" },
                    householdVetName = owner?.vetClinicName.orEmpty(),
                    householdVetPhone = owner?.vetClinicPhone.orEmpty(),
                    householdVetAddress = owner?.vetClinicAddress.orEmpty(),
                    isLoading = false
                )
                // Fetch the KIN-placed form_schemas for the precare checklist. A load
                // failure surfaces as schemaError (fail-loud), never a silent-empty panel.
                val schemas = runCatching {
                    val summaries = repository.listFormSchemas().getOrThrow()
                    kinSchemaIds(summaries).mapNotNull { repository.getFormSchema(it).getOrThrow() }
                }
                _editKinState.value = _editKinState.value.copy(
                    kinSchemas = schemas.getOrDefault(emptyList()),
                    schemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load checklist fields" },
                )
            } else {
                AuntieLog.w("Kin $kinId not found for edit")
                _editKinState.value = _editKinState.value.copy(
                    isLoading = false,
                    error = "Kin not found"
                )
            }
        }
    }

    // Edit Kin Form Field Updates
    fun updateEditKinName(value: String) { _editKinState.value = _editKinState.value.copy(name = value) }
    fun updateEditKinSpecies(value: String) { _editKinState.value = _editKinState.value.copy(species = value) }
    fun updateEditKinBreed(value: String) { _editKinState.value = _editKinState.value.copy(breed = value) }
    fun updateEditKinAge(value: String) { _editKinState.value = _editKinState.value.copy(age = value) }
    fun updateEditKinSex(value: String) { _editKinState.value = _editKinState.value.copy(sex = value) }
    fun updateEditKinWeight(value: String) { _editKinState.value = _editKinState.value.copy(weight = value) }
    fun updateEditKinColorMarkings(value: String) { _editKinState.value = _editKinState.value.copy(colorMarkings = value) }
    fun updateEditKinSpayedNeutered(value: Boolean) { _editKinState.value = _editKinState.value.copy(spayedNeutered = value) }
    fun updateEditKinStaysAs(value: String) { _editKinState.value = _editKinState.value.copy(staysAs = value) }
    fun updateEditKinRoutine(value: String) { _editKinState.value = _editKinState.value.copy(routine = value) }
    fun updateEditKinTrainingCommands(value: String) { _editKinState.value = _editKinState.value.copy(trainingCommands = value) }
    fun updateEditKinFeedingBrand(value: String) { _editKinState.value = _editKinState.value.copy(feedingBrand = value) }
    fun updateEditKinVaccinations(value: String) { _editKinState.value = _editKinState.value.copy(vaccinations = value) }
    fun updateEditKinMedicationHealthNotes(value: String) { _editKinState.value = _editKinState.value.copy(medicationHealthNotes = value) }
    // vetInfo has no setter: vet is read-only on the Kin (single-source on Kinfolk, 1D).
    // The legacy value is still loaded + preserved through save until migration.
    fun updateEditKinChecklist(value: String) { _editKinState.value = _editKinState.value.copy(checklist = value) }
    fun updateEditKinReactive(value: Boolean) { _editKinState.value = _editKinState.value.copy(reactive = value) }
    fun updateEditKinOfficeNotes(value: String) { _editKinState.value = _editKinState.value.copy(officeNotes = value) }
    fun updateEditKinFormValue(key: String, value: String) {
        _editKinState.value = _editKinState.value.copy(formValues = _editKinState.value.formValues + (key to value))
    }

    fun saveKinChanges() {
        val state = _editKinState.value
        if (state.name.isBlank() || state.kinId.isBlank()) return

        AuntieLog.i("Saving changes for kin: ${state.kinId}")
        viewModelScope.launch {
            _editKinState.value = state.copy(isSaving = true, error = null)

            val updatedKin = buildKinFromEditState(state)

            repository.updateKin(updatedKin).onSuccess {
                AuntieLog.i("Kin changes saved")
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repository,
                    actionType       = "UPDATE_KIN",
                    description      = "Updated kin ${updatedKin.name}",
                    targetId         = updatedKin.id,
                    targetCollection = "kin",
                )
                _editKinState.value = EditKinUiState(isSuccess = true)
                loadProfile(state.kinfolkId)
            }.onFailure { error ->
                AuntieLog.e("Failed to update kin", error)
                _editKinState.value = state.copy(
                    isSaving = false,
                    error = error.message ?: "Failed to update Kin"
                )
            }
        }
    }

    fun clearEditKinForm() {
        _editKinState.value = EditKinUiState()
    }

    // Rebuilds the full Kin from edit-form state. updateKin uses .set() (full
    // overwrite), so every carried field must be present, profilePictureUrl included.
    private fun buildKinFromEditState(state: EditKinUiState): Kin = Kin(
        id = state.kinId,
        kinfolkId = state.kinfolkId,
        name = state.name,
        species = state.species,
        breed = state.breed,
        age = state.age,
        sex = state.sex,
        weight = state.weight,
        colorMarkings = state.colorMarkings,
        spayedNeutered = state.spayedNeutered,
        staysAs = state.staysAs,
        routine = state.routine,
        trainingCommands = state.trainingCommands,
        feedingBrand = state.feedingBrand,
        vaccinations = state.vaccinations,
        medicationHealthNotes = state.medicationHealthNotes,
        vetInfo = state.vetInfo,
        checklist = state.checklist,
        reactive = state.reactive,
        officeNotes = state.officeNotes,
        formValues = state.formValues,
        profilePictureUrl = state.profilePictureUrl,
        status = "active"
    )

    // Uploads a Kin (pet) profile photo and persists it immediately (parity with
    // the web KinEditScreen flow). Fail-loud on any error.
    fun uploadKinPhoto(context: Context, uri: Uri) {
        val state = _editKinState.value
        if (state.kinId.isBlank()) {
            _editKinState.value = state.copy(error = "Save the kin before adding a photo")
            return
        }
        viewModelScope.launch {
            _editKinState.value = _editKinState.value.copy(isUploadingPhoto = true, error = null)
            MediaUploadManager(context, repository).uploadMedia(
                uri = uri,
                entityId = state.kinId,
                entityType = MediaEntityType.KIN,
            ).onSuccess { media ->
                val withPhoto = _editKinState.value.copy(profilePictureUrl = media.storageUrl)
                repository.updateKin(buildKinFromEditState(withPhoto)).onSuccess {
                    _editKinState.value = withPhoto.copy(isUploadingPhoto = false)
                    loadProfile(state.kinfolkId)
                }.onFailure { e ->
                    _editKinState.value = _editKinState.value.copy(
                        isUploadingPhoto = false,
                        error = "Photo uploaded but save failed: ${e.message}",
                    )
                }
            }.onFailure { e ->
                AuntieLog.e("Kin photo upload failed", e)
                _editKinState.value = _editKinState.value.copy(
                    isUploadingPhoto = false,
                    error = "Photo upload failed: ${e.message}",
                )
            }
        }
    }
}
