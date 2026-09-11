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
import com.tribetails.auntieos.data.model.SubmitVetClinicResult
import com.tribetails.auntieos.data.model.VetClinicsSnapshot
import com.tribetails.auntieos.domain.horizonIso
import com.tribetails.auntieos.domain.recentTalesFor
import com.tribetails.auntieos.domain.upcomingVisitsFor
import com.tribetails.auntieos.domain.invoicesForKinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.joinDateForEdit
import com.tribetails.auntieos.util.SortOption
import com.tribetails.auntieos.data.model.updatedAtIso
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

// ── Tag filtering (#713) ─────────────────────────────────────────────────────
//
// The operator's second complaint on the issue: "tags are just labels and not
// actual tags which act like a filter." These helpers are that filter, and they
// are PURE and CLIENT-SIDE on purpose. The screen already holds the whole
// roster, so narrowing by tag costs no read and needs no composite index, and
// it matches the web admin's Directory filter one-for-one.

/** The value meaning "do not narrow by tag". Not a legal tag name. */
internal const val TAG_FILTER_ALL: String = ""

/** The comparison key for a tag name: normalized, then lowercased, as [resolveTag] compares. */
private fun tagFilterKey(name: String): String =
    com.tribetails.auntieos.data.model.normalizeTagName(name).lowercase()

/**
 * Every distinct tag carried by these rows, alphabetically, for the filter's
 * option list. Built from the ROWS rather than from the business_settings
 * vocabulary, so the list only ever offers a tag that would narrow something and
 * the screen needs no second read. Names differing only by case or spacing
 * collapse to one option, keeping the first casing seen. Pure; tested.
 */
internal fun directoryTagOptions(rowTags: List<List<String>>): List<String> {
    val seen = LinkedHashMap<String, String>()
    for (tags in rowTags) {
        for (name in tags) {
            val key = tagFilterKey(name)
            if (key != "" && !seen.containsKey(key)) seen[key] = name.trim()
        }
    }
    return seen.values.sortedBy { it.lowercase() }
}

/** True when the row carries this tag. A blank [filter] matches everything. Pure; tested. */
internal fun matchesDirectoryTag(tags: List<String>, filter: String): Boolean {
    val key = tagFilterKey(filter)
    if (key == "") return true
    return tags.any { tagFilterKey(it) == key }
}

/**
 * The Kin tab's list: name/species/breed search, then the tag filter, then the
 * chosen [sort]. Lifted out of the composable so the filter is unit-testable
 * without an Android runtime. Pure; tested.
 *
 * The flat `kin` collection has no createdAt, so "Recently Created" has nothing
 * to order by and falls back to A to Z, the same fallback the web admin's
 * `filterSortKin` makes; the screen does not offer it on this tab.
 */
internal fun filterKinDirectory(
    kin: List<Kin>,
    search: String,
    tag: String,
    sort: SortOption = SortOption.AlphaAsc,
): List<Kin> {
    val rows = kin.filter { k ->
        val matchesSearch = search.isBlank() ||
            k.name.contains(search, ignoreCase = true) ||
            k.species.contains(search, ignoreCase = true) ||
            k.breed.contains(search, ignoreCase = true)
        matchesSearch && matchesDirectoryTag(k.tagNames(), tag)
    }
    return when (sort) {
        SortOption.AlphaAsc, SortOption.RecentlyCreated -> rows.sortedBy { it.name.lowercase() }
        SortOption.AlphaDesc -> rows.sortedByDescending { it.name.lowercase() }
        SortOption.RecentlyUpdated -> rows.sortedByDescending { it.updatedAtIso() }
    }
}

/** The sort options the Kin tab offers: every one with a field behind it. */
internal val KIN_SORT_OPTIONS: List<SortOption> =
    listOf(SortOption.AlphaAsc, SortOption.AlphaDesc, SortOption.RecentlyUpdated)

/**
 * The Kinfolk tab's order. A to Z is by surname with a first-name tiebreak
 * (03-directory item 3, parity with web); Z to A is that reversed; the two
 * recency sorts read `joinDate` and `updatedAt`, the same two fields the web
 * admin's `filterSortKinfolk` reads, newest first. Pure; tested.
 */
internal fun sortKinfolkDirectory(rows: List<Kinfolk>, sort: SortOption): List<Kinfolk> {
    val surname = { kf: Kinfolk ->
        com.tribetails.auntieos.domain.kinfolkSurnameSortKey(kf.firstName, kf.lastName, kf.displayName)
    }
    return when (sort) {
        SortOption.AlphaAsc -> rows.sortedBy(surname)
        SortOption.AlphaDesc -> rows.sortedByDescending(surname)
        SortOption.RecentlyCreated -> rows.sortedByDescending { it.joinDate }
        SortOption.RecentlyUpdated -> rows.sortedByDescending { it.updatedAtIso() }
    }
}

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
    /**
     * #713: narrow the household list to one tag. Operator: "tags are just
     * labels and not actual tags which act like a filter." Blank means no
     * narrowing, and it is not a legal tag name (a blank name is refused by
     * `addTag`), so it can never collide with a real one.
     */
    val tagFilter: String = TAG_FILTER_ALL,
    /**
     * The Kinfolk tab's order. The mock draws a Sort pill beside the search
     * (#755) and the web admin has carried one since the port; this is the
     * Android half. Applied in [DirectoryViewModel.applyFilters].
     */
    val sortOption: SortOption = SortOption.Default,
    val error: String? = null
)

data class ProfileUiState(
    val kinfolk: Kinfolk? = null,
    val dossier: Dossier? = null,
    val kinList: List<Kin> = emptyList(),
    val kin411Map: Map<String, Kin411> = emptyMap(),
    // Profile feeds: real per-kinfolk joins, shared with the React admin through
    // `domain/KinfolkProfileFeeds.kt` and its web twin.
    val recentTales: List<KinCareReport> = emptyList(),
    val upcomingVisits: List<KinCareSession> = emptyList(),
    val kinfolkInvoices: List<Invoice> = emptyList(),
    /**
     * How many rows each feed HAS, before the five its card shows.
     *
     * Kept beside the truncated lists so a card can head itself "5 of 12 total"
     * instead of implying that five is all there is. These reads are unbounded
     * `.get()`s scoped to one household, so the count is a real total and
     * `feedCountMeta` is called with `capped = false`; if a limit is ever put on
     * those queries, this is the pair that has to learn about it.
     */
    val sentTaleCount: Int = 0,
    val upcomingVisitCount: Int = 0,
    val invoiceCount: Int = 0,
    // Phase 2 household-notes migration: the structured HouseholdData backing the
    // gap list on the dossier migration box. null while still loading.
    val householdData: HouseholdData? = null,
    /**
     * The household vet, resolved from `householdData`'s clinic id through the
     * catalog. The profile DISPLAYS it and Household Data authors it (operator
     * ruling 2026-08-01); it used to be read off the kinfolk doc.
     */
    val householdVet: HouseholdVet = HouseholdVet(),
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

    // NO VET FIELDS. The household vet is authored on Household Data, against
    // the shared `vet_clinics` catalog (operator ruling 2026-08-01). Keeping
    // them here is what made the kinfolk doc a second writable copy.

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

    /**
     * The household and pet AS THE SERVER LAST GAVE THEM TO US, and the baseline
     * every save diffs against. Never re-read to compute a diff: a fresh read
     * would hand back the very concurrent edit the diff exists to leave alone.
     *
     * They are also what the edited model is BUILT FROM, so a field no form
     * control carries is carried through untouched instead of reverting to its
     * Kotlin default. See `DirectoryFieldChanges.kt`.
     *
     * Advanced only after a save the server accepted, so a failed save keeps the
     * operator's edit pending instead of swallowing it.
     */
    private var loadedKinfolk: Kinfolk? = null
    private var loadedKin: Kin? = null

    // Run-4 #6: seeded dog/cat breed banks for the Kin breed dropdown. Loaded from the
    // screen (LaunchedEffect), not VM init, so strict-mockk unit tests stay isolated.
    // A load failure leaves the banks empty -> the field degrades to free-text, AND
    // is disclosed via breedBankFailed rather than only logged (AuntieRepository
    // already logs it through AuntieLog.e, which never reaches the operator): an
    // outright failure and dog_breeds/cat_breeds genuinely not being seeded must
    // read differently on screen (see BreedSearch.breedBankNote), not collapse
    // into the same silent empty field. See DirectoryViewModelBreedTest.
    private val _breedBank = MutableStateFlow(BreedBank())
    val breedBank: StateFlow<BreedBank> = _breedBank.asStateFlow()
    private val _breedBankFailed = MutableStateFlow(false)
    val breedBankFailed: StateFlow<Boolean> = _breedBankFailed.asStateFlow()
    fun loadBreeds() {
        if (_breedBank.value.dogBreeds.isNotEmpty() || _breedBank.value.catBreeds.isNotEmpty()) return
        viewModelScope.launch {
            repository.getBreeds()
                .onSuccess {
                    _breedBank.value = it
                    _breedBankFailed.value = false
                }
                .onFailure { _breedBankFailed.value = true }
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
                    // #713: a tag filter no loaded row can satisfy any more falls
                    // back to "All tags". Deleting the tag the operator was
                    // filtering by empties the option list, which hides the
                    // dropdown, and without this the list would sit on an empty
                    // result with no control left to clear it.
                    tagFilter               = _directoryState.value.tagFilter.takeIf { wanted ->
                        directoryTagOptions(all.map { it.tagNames() })
                            .any { it.equals(wanted, ignoreCase = true) }
                    } ?: TAG_FILTER_ALL,
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

    /** Order the household list. See [DirectoryUiState.sortOption]. */
    fun setSortOption(option: SortOption) {
        AuntieLog.d("Directory sort: ${option.key}")
        _directoryState.value = _directoryState.value.copy(sortOption = option)
        applyFilters()
    }

    /** #713: narrow the household list to one tag. [TAG_FILTER_ALL] clears it. */
    fun setTagFilter(tag: String) {
        AuntieLog.d("Directory filter by tag: $tag")
        _directoryState.value = _directoryState.value.copy(tagFilter = tag)
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
            // #713: the tag filter sits beside status and search, not instead of
            // either, so "Active households tagged VIP" is one list.
            matchesStatus && matchesSearch && matchesDirectoryTag(kf.tagNames(), state.tagFilter)
        }
        // 03-directory item 3: A to Z is by surname (last name), parity with web.
        // The other three orders are the Sort pill's (#755).
        _directoryState.value = state.copy(displayedKinfolk = sortKinfolkDirectory(filtered, state.sortOption))
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

                // Profile feeds: real joins via the pure helpers, which the React
                // admin calls by the same names with the same arguments.
                val now = java.time.Instant.now()
                val nowIso = now.toString()
                // The profile heads UPCOMING KINCARE "next 7 days" (renamed from
                // "Upcoming visits", #682), so the window has a far edge and
                // both surfaces use the same one.
                val throughIso = horizonIso(now)
                val allReports = reportsDef.await().getOrDefault(emptyList())
                val allSessions = sessionsDef.await().getOrDefault(emptyList())
                val allInvoices = invoicesDef.await().getOrDefault(emptyList())
                val recentTales = recentTalesFor(allReports, kinfolkId)
                val upcomingVisits = upcomingVisitsFor(allSessions, kinfolkId, nowIso, throughIso)
                val kinfolkInvoices = invoicesForKinfolk(allInvoices, kinfolkId)
                // Counted BEFORE the take(5), so a card can say how many it is
                // showing out of how many there are. Uncapped reads, so these are
                // real totals rather than "at least this many".
                val sentTaleCount = recentTalesFor(allReports, kinfolkId, limit = Int.MAX_VALUE).size
                val upcomingVisitCount =
                    upcomingVisitsFor(allSessions, kinfolkId, nowIso, throughIso, limit = Int.MAX_VALUE).size
                val invoiceCount = invoicesForKinfolk(allInvoices, kinfolkId, limit = Int.MAX_VALUE).size
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
                    sentTaleCount = sentTaleCount,
                    upcomingVisitCount = upcomingVisitCount,
                    invoiceCount = invoiceCount,
                    householdData = householdData,
                    householdVet = resolveHouseholdVet(
                        householdData,
                        repository.getVetClinicsOnce().getOrNull().orEmpty(),
                    ),
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

    // A stale dedupe note (see _vetClinicDedupeNote below) belongs to whatever
    // create attempt produced it. Any OTHER change to the selection -- a fresh
    // pick, or an explicit clear -- makes it stale, so all four entry points
    // clear it themselves rather than relying on every caller to remember to.

    /** Empties ALL FOUR fields. A cleared vet must not leave a name behind. */



    // `createVetClinicFromSearch` lived here to serve Kinfolk Edit's vet picker.
    // That picker is gone (the vet is authored on Household Data now), so the
    // create flow moved with it rather than being left as a second write path
    // into the shared catalog from a screen that no longer shows a vet.
    // observeVetClinicsOrFail (not the plain observeVetClinics) so a load
    // FAILURE stays distinguishable from a genuinely empty catalog: scan() folds
    // each VetClinicsSnapshot into a running state that keeps the last good
    // clinic list on a failure (a picker mid-edit should not blank out because
    // of a network blip) while still flipping vetClinicsLoadFailed so the screen
    // can disclose it. See EditKinfolkScreen's banner and
    // DirectoryViewModelVetPickerTest's load-failure cases.
    private val vetClinicsState: StateFlow<VetClinicsSnapshot> =
        repository.observeVetClinicsOrFail()
            .scan(VetClinicsSnapshot()) { acc, next -> if (next.failed) acc.copy(failed = true) else next }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), VetClinicsSnapshot())

    val vetClinicsFlow: StateFlow<List<com.tribetails.auntieos.data.model.VetClinic>> =
        vetClinicsState.map { it.clinics }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val vetClinicsLoadFailed: StateFlow<Boolean> =
        vetClinicsState.map { it.failed }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

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
        loadedKinfolk = kinfolk
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

    /**
     * Saves ONLY what the operator actually changed on the household.
     *
     * This used to hand the repository a whole `Kinfolk` rebuilt from form
     * state, which went to Firestore as `.set(model, merge())`. That was wrong
     * twice over, and `DirectoryFieldChanges.kt` documents both: merge does
     * nothing about stale fields INSIDE the written map, so every field the
     * phone read reverted whatever had changed since; and the from-scratch
     * rebuild wrote Kotlin defaults over `uid`, `contactOverride` and the
     * `archived*` trail, which is destruction rather than staleness.
     *
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. `updatedAt`
     * says when the record last changed; moving it for a save that changed
     * nothing makes it lie. The screen still reports success, because "saved"
     * and "nothing to save" are the same outcome to the operator.
     */
    fun saveKinfolkChanges() {
        val state = _editKinfolkState.value
        if (state.firstName.isBlank() || state.phoneNumber.isBlank() || state.kinfolkId.isBlank()) return

        val baseline = loadedKinfolk
        if (baseline == null || baseline.id != state.kinfolkId) {
            _editKinfolkState.value = state.copy(
                error = "Reopen this household before saving: its saved copy was never loaded."
            )
            return
        }

        val updatedKinfolk = buildKinfolkFromEditState(state)
        val changes = kinfolkFieldChanges(baseline, updatedKinfolk)
        if (changes.isEmpty()) {
            _editKinfolkState.value = state.copy(isSaving = false, isSuccess = true, error = null)
            return
        }

        AuntieLog.i("Saving changes for kinfolk: ${state.kinfolkId}")
        viewModelScope.launch {
            _editKinfolkState.value = state.copy(isSaving = true, error = null)

            repository.updateKinfolkFields(state.kinfolkId, changes).onSuccess {
                AuntieLog.i("Kinfolk changes saved")
                // The baseline moves to what the server now holds. Without this a
                // second save re-sends the first save's fields, which is the same
                // clobber one step later.
                loadedKinfolk = updatedKinfolk
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

    /**
     * The loaded household with this form's edits applied ON TOP, never a
     * `Kinfolk(...)` built from nothing.
     *
     * The from-scratch version was a data-loss bug in its own right: `uid` (the
     * MyTribe login linkage), `contactOverride` (the comms pipeline's time-boxed
     * channel override) and the three `archived*` audit fields are on the model
     * but on no form control, so every save wrote their Kotlin defaults - blank,
     * blank, and null - straight over the stored values. Copying the baseline
     * carries them through untouched, and the diff then keeps them out of the
     * write entirely.
     *
     * The baseline is absent only before a load, which [saveKinfolkChanges]
     * refuses outright rather than saving against a blank.
     */
    private fun buildKinfolkFromEditState(state: EditKinfolkUiState): Kinfolk = (loadedKinfolk ?: Kinfolk()).copy(
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
                // The photo is its own write, not an excuse to flush the whole
                // form: only `profilePictureUrl` has actually changed, so only
                // that field (plus the stamp) goes.
                repository.updateKinfolkFields(
                    state.kinfolkId,
                    mapOf("profilePictureUrl" to media.storageUrl),
                ).onSuccess {
                    loadedKinfolk = loadedKinfolk?.copy(profilePictureUrl = media.storageUrl)
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
                // The owner is still needed for the household NAME.
                val owner = _directoryState.value.allKinfolk.find { it.id == kin.kinfolkId }
                    ?: _profileState.value.kinfolk?.takeIf { it.id == kin.kinfolkId }
                // The vet is inherited from `household_data`, resolved through the
                // clinic catalog, and shown read-only on the kin. It used to be
                // read off the owning Kinfolk doc, which is the copy that made
                // the vet authored in two places at once. A failed read leaves
                // the vet blank rather than showing a stale one.
                val householdVet = resolveHouseholdVet(
                    repository.getHouseholdData(kin.kinfolkId).getOrNull(),
                    repository.getVetClinicsOnce().getOrNull().orEmpty(),
                )
                loadedKin = kin
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
                    // The household vet, resolved from `household_data` through
                    // the clinic catalog. It used to read `owner.vetClinicName`
                    // off the kinfolk doc, the copy that made the vet authored
                    // in two places at once.
                    householdVetName = householdVet.primary.name,
                    householdVetPhone = householdVet.primary.phone,
                    householdVetAddress = householdVet.primary.address,
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

    /**
     * Saves ONLY what the operator actually changed on the pet. Same rule, same
     * reasons as [saveKinfolkChanges]; `DirectoryFieldChanges.kt` carries the
     * long form. The React admin patches `kin` field-level for the same reason
     * (`api/directoryWrite.ts#updateKin`), so a phone save must not send back
     * the medication note the web corrected while this screen sat open.
     */
    fun saveKinChanges() {
        val state = _editKinState.value
        if (state.name.isBlank() || state.kinId.isBlank()) return

        val baseline = loadedKin
        if (baseline == null || baseline.id != state.kinId) {
            _editKinState.value = state.copy(
                error = "Reopen this pet before saving: its saved copy was never loaded."
            )
            return
        }

        val updatedKin = buildKinFromEditState(state)
        val changes = kinFieldChanges(baseline, updatedKin)
        if (changes.isEmpty()) {
            _editKinState.value = state.copy(isSaving = false, isSuccess = true, error = null)
            return
        }

        AuntieLog.i("Saving changes for kin: ${state.kinId}")
        viewModelScope.launch {
            _editKinState.value = state.copy(isSaving = true, error = null)

            repository.updateKinFields(state.kinId, updatedKin.kinfolkId, changes).onSuccess {
                AuntieLog.i("Kin changes saved")
                loadedKin = updatedKin
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

    /**
     * The loaded pet with this form's edits applied ON TOP, never a `Kin(...)`
     * built from nothing.
     *
     * The from-scratch version wiped four fields on every save. `tags` is the
     * pointed one: `Kin.tags` was ADDED to the model expressly so android saves
     * would stop wiping the pet tags the React admin writes, and declaring it
     * turned out to be only half the fix, because this builder never populated
     * it and kept sending null. `photos`, `ownerEmail` and `ownerPhone` went the
     * same way.
     *
     * `status` is no longer hardcoded to "active" either. No control on this
     * form edits it, and forcing it un-archived an archived pet - the web editor
     * says the same thing about its own patch ("status stays owned by archive").
     */
    private fun buildKinFromEditState(state: EditKinUiState): Kin = (loadedKin ?: Kin()).copy(
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
                // Only the photo changed; see uploadKinfolkPhoto above.
                repository.updateKinFields(
                    state.kinId,
                    state.kinfolkId,
                    mapOf("profilePictureUrl" to media.storageUrl),
                ).onSuccess {
                    loadedKin = loadedKin?.copy(profilePictureUrl = media.storageUrl)
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
