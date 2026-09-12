package com.tribetails.auntieos.ui.directory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.coversKin
import com.tribetails.auntieos.domain.horizonIso
import com.tribetails.auntieos.domain.recentTalesFor
import com.tribetails.auntieos.domain.upcomingVisitsFor
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * What the Kin (pet) detail screen holds.
 *
 * Each feed carries its own error string rather than one page-level error,
 * because each is its own read: a 411 that fails must say so on its own panel
 * while the rest of the page stands. That is how the React twin
 * (`src/screens/KinView.tsx`) is built, one `AsyncRegion` per panel, and it is
 * the fail-loud rule in `AGENTS.md` applied at panel granularity rather than
 * collapsing four reads into one banner.
 *
 * [error] is reserved for the one failure that leaves nothing to draw: the pet
 * itself could not be read.
 */
data class KinDetailUiState(
    val kin: Kin? = null,
    val kin411: Kin411? = null,
    val kin411Error: String? = null,
    /** The owning household, for the trail's middle step and the "belongs to" line. */
    val householdId: String = "",
    val householdName: String = "",
    val tales: List<KinCareReport> = emptyList(),
    /** Every SENT tale about this pet, before the five the panel shows. */
    val taleCount: Int = 0,
    val talesError: String? = null,
    val upcomingVisits: List<KinCareSession> = emptyList(),
    val visitsError: String? = null,
    /** KIN-placed form_schemas, so the structured care checklist renders read-only. */
    val kinSchemas: List<FormSchema> = emptyList(),
    val schemaError: String? = null,
    val isLoading: Boolean = true,
    val error: String? = null,
)

/**
 * The Kin (pet) detail screen's reads.
 *
 * ITS OWN VIEW MODEL, AND ITS OWN BY-ID READ, on purpose. `DirectoryViewModel`
 * resolves a pet out of `profileState.kinList`, which is populated only by
 * `loadProfile`, so everything that hangs off it works from a household profile
 * and from nowhere else. This screen is reachable cold: from the Directory's Kin
 * tab, and by any deep link that follows. So the pet is fetched by document id
 * (`getKinByIds`, the bulk lookup used with one id rather than a new repository
 * method) and a pet that is not there fails loud instead of rendering blank.
 *
 * Reads and writes go through [AuntieRepository] / [KinCareRepository]; there
 * are no Firestore calls in this file.
 */
class KinDetailViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(KinDetailUiState())
    val uiState: StateFlow<KinDetailUiState> = _uiState.asStateFlow()

    fun load(kinId: String) {
        if (kinId.isBlank()) {
            _uiState.value = KinDetailUiState(isLoading = false, error = "No kin id to open.")
            return
        }
        viewModelScope.launch {
            _uiState.value = KinDetailUiState(isLoading = true)

            val kin = repository.getKinByIds(listOf(kinId)).getOrNull()?.get(kinId)
            if (kin == null) {
                AuntieLog.w("Kin $kinId could not be read for detail")
                _uiState.value = KinDetailUiState(isLoading = false, error = "Kin not found: $kinId")
                return@launch
            }

            val kinfolkId = kin.kinfolkId
            // Four independent reads, fired together and each judged on its own.
            val the411Def = async { repository.get411ForKin(kinId) }
            val ownerDef = async {
                if (kinfolkId.isBlank()) Result.success(null) else repository.getKinfolkById(kinfolkId)
            }
            val reportsDef = async { kinCareRepository.getAllKinCareReports() }
            val sessionsDef = async {
                if (kinfolkId.isBlank()) {
                    Result.success(emptyList())
                } else {
                    kinCareRepository.getKinCareSessionsForKinfolk(kinfolkId)
                }
            }

            val the411 = the411Def.await()
            val owner = ownerDef.await().getOrNull()

            // The household's own feeds, kept to the rows that cover THIS pet.
            // The reads stay household-scoped because that is the indexed query;
            // a pet is a filter over it, never a second index.
            val now = Instant.now()
            val nowIso = now.toString()
            val throughIso = horizonIso(now)
            val reports = reportsDef.await()
            val sessions = sessionsDef.await()
            val minePet = { ids: List<String> -> coversKin(ids, kinId) }
            val mineReports = reports.getOrDefault(emptyList()).filter { minePet(it.kinIds) }
            val mineSessions = sessions.getOrDefault(emptyList()).filter { minePet(it.kinIds) }

            _uiState.value = KinDetailUiState(
                kin = kin,
                kin411 = the411.getOrNull(),
                kin411Error = the411.exceptionOrNull()?.let { it.message ?: "Couldn't load the 411" },
                householdId = kinfolkId,
                householdName = owner?.displayName.orEmpty(),
                tales = recentTalesFor(mineReports, kinfolkId),
                // Counted BEFORE the five the panel shows, so the card can head
                // itself "3 of 8 total" rather than implying five is all there is.
                taleCount = recentTalesFor(mineReports, kinfolkId, limit = Int.MAX_VALUE).size,
                talesError = reports.exceptionOrNull()?.let { it.message ?: "Couldn't load KinTales" },
                upcomingVisits = upcomingVisitsFor(mineSessions, kinfolkId, nowIso, throughIso),
                visitsError = sessions.exceptionOrNull()?.let { it.message ?: "Couldn't load visits" },
                isLoading = false,
            )

            // The KIN form_schemas behind the structured care checklist. Loaded
            // after the page is already drawable, and fail-loud via schemaError
            // rather than a silently empty section.
            val schemas = runCatching {
                val summaries = repository.listFormSchemas().getOrThrow()
                kinSchemaIds(summaries).mapNotNull { repository.getFormSchema(it).getOrThrow() }
            }
            _uiState.value = _uiState.value.copy(
                kinSchemas = schemas.getOrDefault(emptyList()),
                schemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load checklist fields" },
            )
        }
    }

    /**
     * Replace this pet's tag NAME list.
     *
     * ONE FIELD, never the model. The React admin's `updateKinTags` writes
     * exactly this one key for exactly this reason, and the long form is in
     * `DirectoryFieldChanges.kt`: a save that hands Firestore a whole `Kin`
     * reverts every field the phone happened to read, and a `Kin` rebuilt from
     * screen state writes Kotlin defaults over the fields no control carries.
     * Adding a tag must not be able to touch a medication note.
     *
     * Throws on failure, which is what `ProfileTagsSection` turns into a
     * reverted chip plus a visible banner.
     */
    suspend fun saveTags(kinId: String, kinfolkId: String, tags: List<String>) {
        repository.updateKinFields(kinId, kinfolkId, mapOf("tags" to tags)).getOrThrow()
        val current = _uiState.value.kin ?: return
        if (current.id == kinId) {
            _uiState.value = _uiState.value.copy(kin = current.copy(tags = tags))
        }
    }
}
