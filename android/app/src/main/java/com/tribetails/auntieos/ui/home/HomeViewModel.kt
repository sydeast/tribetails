package com.tribetails.auntieos.ui.home

import android.content.Context
import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.flow.first
import com.tribetails.auntieos.location.LocationTrackingService
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

data class TodayVisitCard(
    val session: KinCareSession,
    val kinfolk: Kinfolk?
)

data class HomeUiState(
    val isLoading: Boolean = true,
    val isOffline: Boolean = false,
    val kinfolkCount: Int = 0,
    val kinCount: Int = 0,
    val pendingDraftCount: Int = 0,
    val recentDrafts: List<Draft> = emptyList(),
    val todayVisits: List<TodayVisitCard> = emptyList(),
    val businessSettings: BusinessSettings = BusinessSettings(),
    val pendingActionSessionId: String? = null,
    // Stage 2 Step 2: "This week $" revenue = sum of PAID invoices dated within the
    // current local week (Monday..today), computed via the pure weeklyRevenue helper.
    val weeklyRevenue: Double = 0.0,
    // Cash Flow widget: what is still owed across all unpaid invoices, and how many.
    val outstandingTotal: Double = 0.0,
    val outstandingCount: Int = 0,
    // True once the invoices read finished (success or failure) so the Cash Flow
    // widget can tell "loading" apart from "genuinely zero".
    val invoicesLoaded: Boolean = false,
    // Gatekeeper widget: top households by days since their last completed visit.
    val visitGaps: List<com.tribetails.auntieos.domain.HouseholdGap> = emptyList(),
    val gapsLoaded: Boolean = false,
    // AO-24: full session + kin lists feeding the A8 insight widgets (Weekly
    // capacity / Overdue / Pets by type / Frequent flyers / Holiday runway).
    val allSessions: List<KinCareSession> = emptyList(),
    val kin: List<Kin> = emptyList(),
    // 17.3 Dashboard: this admin's saved widget layout tokens ("key:size"); empty =
    // the shipped default. Resolved for render by DashboardLayout.resolvedDashboard.
    val dashboardWidgets: List<String> = emptyList(),
    // W16/W17 weather widgets: one-shot getLocalWeather result (server-cached). null =
    // not loaded yet. Loaded lazily only when a weather widget is on the dashboard.
    val weather: Result<com.tribetails.auntieos.data.model.LocalWeather>? = null,
    // AO-38 Unread Messages widget: one-shot listConversations result. null = not
    // loaded yet. Loaded lazily only while the widget is on the dashboard.
    val conversations: Result<List<com.tribetails.auntieos.ui.inbox.ConversationSummary>>? = null,
    val actionError: String? = null
)

class HomeViewModel(
    private val repo: AuntieRepository,
    private val notifier: VisitNotifier = AuntieOSApp.instance.visitNotifier
) : ViewModel() {

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    // 17.3 Dashboard: the loaded profile snapshot, copied onto for the dashboard save
    // so theme/branding/etc are never clobbered (saveUserProfile overwrites the doc).
    private var loadedProfile: UserProfile? = null

    init {
        AuntieLog.d("HomeViewModel initialized")
        load()
    }

    /**
     * W16/W17: fetch the local forecast once, when a weather widget is actually shown.
     * Idempotent — a successful load is kept; a failure can be retried by re-invoking.
     * Fail-loud: the error rides in HomeUiState.weather for the widget to surface.
     */
    fun loadWeather() {
        if (_uiState.value.weather?.isSuccess == true) return
        viewModelScope.launch {
            val result = repo.getLocalWeather()
            _uiState.value = _uiState.value.copy(weather = result)
        }
    }

    /** AO-38: one-shot load of the Unread Messages widget's conversations. */
    fun loadConversations() {
        if (_uiState.value.conversations?.isSuccess == true) return
        viewModelScope.launch {
            val result = repo.listConversations()
            _uiState.value = _uiState.value.copy(conversations = result)
        }
    }

    fun load() {
        AuntieLog.d("Loading dashboard data")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true)
            try {
                val kinfolkCount   = async { repo.getKinfolkCount() }
                val kinCount       = async { repo.getKinCount() }
                val pendingDrafts  = async { repo.getPendingDraftCount() }
                val recentDrafts   = async { repo.getRecentDrafts() }
                val todaySessions  = async { repo.getKinCareSessionsForDay(todayStartIso(), todayEndIso()) }
                val settings       = async { repo.getBusinessSettings() }
                // Invoices feed the "This week $" revenue tile + Cash Flow widget. A
                // read failure degrades those tiles (logged), never blanks the dashboard.
                val invoicesDef    = async { repo.getInvoices() }
                // Gatekeeper: all sessions (not just today's) to find each household's
                // last completed visit. Same degrade-not-blank policy as invoices.
                val allSessionsDef = async { repo.getKinCareSessions() }
                // AO-24: the pack, for the Pets-by-type insight widget. Degrade-not-blank.
                val allKinDef      = async { repo.getAllKin() }

                // WARNING-9: use getOrElse so read failures are logged and surfaced via
                // the isOffline banner, not silently defaulted to 0 / empty list.
                var hasReadError = false
                val kf = kinfolkCount.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load kinfolk count", e)
                    hasReadError = true; 0
                }
                val kn = kinCount.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load kin count", e)
                    hasReadError = true; 0
                }
                val pd = pendingDrafts.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load pending draft count", e)
                    hasReadError = true; 0
                }
                // Drop content-less junk drafts (leftover all-null import/seed rows
                // with no generatedCopy): nothing to review, would render "No recipient".
                val rd = recentDrafts.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load recent drafts", e)
                    hasReadError = true; emptyList()
                }.filter { it.generatedCopy.isNotBlank() }
                var sessions = todaySessions.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load today's sessions", e)
                    hasReadError = true; emptyList()
                }
                val bs = settings.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load business settings", e)
                    hasReadError = true; BusinessSettings()
                }
                var invoicesLoaded = true
                val invoices = invoicesDef.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load invoices for weekly revenue", e)
                    invoicesLoaded = false
                    emptyList()
                }
                val weekRevenue = com.tribetails.auntieos.domain.weeklyRevenue(
                    invoices = invoices,
                    weekStartIso = localWeekStartIso(),
                    nowIso = LocalDate.now().toString(),
                )
                // Cash Flow: invoices still owed (amountDue > 0 per the model).
                val outstanding = invoices.filter { it.amountDue > 0.0 }
                // Gatekeeper: rank households by days since their last completed visit.
                var gapsLoaded = true
                val allSessions = allSessionsDef.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load sessions for visit gaps", e)
                    gapsLoaded = false
                    emptyList()
                }
                val visitGaps = com.tribetails.auntieos.domain.householdVisitGaps(
                    sessions = allSessions,
                    todayIso = LocalDate.now().toString(),
                    limit = 5,
                )
                val allKin = allKinDef.await().getOrElse { e ->
                    AuntieLog.e("Home: failed to load kin for insight widgets", e)
                    emptyList()
                }

                // 17.3 Dashboard: load this admin's saved widget layout (snapshot).
                // Non-critical + isolated from the dashboard's core data: a failure
                // (e.g. no auth) degrades to the default layout rather than blanking
                // the screen. A later save still fail-louds if the profile is missing.
                val profile = runCatching {
                    FirebaseAuth.getInstance().currentUser?.uid?.let { uid ->
                        repo.observeUserProfile(uid).first()
                    }
                }.getOrNull()
                loadedProfile = profile

                // Hydrate each session with its kinfolk record (parallel)
                suspend fun hydrateCards(source: List<KinCareSession>) = source.map { session ->
                    async {
                        val kinfolk = if (session.kinfolkId.isNotBlank()) {
                            repo.getKinfolkById(session.kinfolkId).getOrNull()
                        } else null
                        TodayVisitCard(session, kinfolk)
                    }
                }.map { it.await() }

                var cards = hydrateCards(sessions)

                val eligibleForAutoComplete = cards
                    .map { it.session }
                    .filter { it.status == VisitStatus.DEPARTED.name && it.autoCompleteEligible }

                if (eligibleForAutoComplete.isNotEmpty()) {
                    eligibleForAutoComplete.forEach { session ->
                        repo.markSessionComplete(session.id).getOrElse { e ->
                            throw IllegalStateException(
                                "Failed to auto-complete session ${session.id} flagged autoCompleteEligible",
                                e
                            )
                        }
                    }
                    sessions = repo.getKinCareSessionsForDay(todayStartIso(), todayEndIso()).getOrElse { e ->
                        throw IllegalStateException("Auto-complete succeeded but session reload failed", e)
                    }
                    cards = hydrateCards(sessions)
                }

                AuntieLog.d("Dashboard loaded: $kf kinfolk, $kn kin, $pd drafts, ${cards.size} visits today")

                _uiState.value = HomeUiState(
                    isLoading         = false,
                    isOffline         = hasReadError,
                    kinfolkCount      = kf,
                    kinCount          = kn,
                    pendingDraftCount = pd,
                    recentDrafts      = rd,
                    todayVisits       = cards,
                    businessSettings  = bs,
                    weeklyRevenue     = weekRevenue,
                    outstandingTotal  = outstanding.sumOf { it.amountDue },
                    outstandingCount  = outstanding.size,
                    invoicesLoaded    = invoicesLoaded,
                    visitGaps         = visitGaps,
                    gapsLoaded        = gapsLoaded,
                    allSessions       = allSessions,
                    kin               = allKin,
                    dashboardWidgets  = profile?.dashboardWidgets ?: emptyList(),
                    actionError       = null
                )
            } catch (e: Exception) {
                AuntieLog.e("Failed to load dashboard data", e)
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    isOffline = true,
                    actionError = e.message ?: "Dashboard refresh failed"
                )
            }
        }
    }

    fun clearActionError() {
        _uiState.value = _uiState.value.copy(actionError = null)
    }

    /**
     * 17.3 Dashboard: persist this admin's widget layout. Optimistically updates the
     * UI, then writes users/{uid} by copying the layout onto the LOADED profile (so
     * theme/branding/etc are preserved - saveUserProfile overwrites the whole doc).
     * Fail loud: a write failure surfaces via actionError, never a fake success.
     */
    fun saveDashboard(tokens: List<String>) {
        _uiState.value = _uiState.value.copy(dashboardWidgets = tokens, actionError = null)
        viewModelScope.launch {
            // Re-read the latest profile before merging so a pref another screen saved
            // since this screen loaded (theme / nav / branding) is never clobbered -
            // saveUserProfile overwrites the whole doc. Falls back to the load snapshot.
            val uid = runCatching { FirebaseAuth.getInstance().currentUser?.uid }.getOrNull()
            val base = (uid?.let { runCatching { repo.observeUserProfile(it).first() }.getOrNull() }) ?: loadedProfile
            if (base == null) {
                _uiState.value = _uiState.value.copy(actionError = "Can't save dashboard: profile not loaded yet")
                return@launch
            }
            val merged = base.copy(dashboardWidgets = tokens)
            repo.saveUserProfile(merged).fold(
                onSuccess = { loadedProfile = merged },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(actionError = "Couldn't save dashboard: ${e.message}")
                },
            )
        }
    }

    // --- Visit lifecycle actions ---

    fun onMyWay(sessionId: String, etaMinutes: Int) {
        runOnSession(sessionId) { card ->
            repo.markSessionOnMyWay(sessionId, etaMinutes).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repo,
                    actionType       = "VISIT_ON_MY_WAY",
                    description      = "Marked on the way (ETA ${etaMinutes}m) for ${card.session.kinfolkId}",
                    targetId         = sessionId,
                    targetCollection = "kin_care_sessions",
                )
                notifier.notify(
                    event = VisitNotifier.Event.ON_MY_WAY,
                    session = card.session,
                    etaMinutes = etaMinutes,
                )
            }
        }
    }

    fun arrived(sessionId: String, context: Context) {
        runOnSession(sessionId) { card ->
            // Mark arrived first; the GPS service will fill in visitRouteId once tracking starts
            repo.markSessionArrived(sessionId, visitRouteId = "").onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repo,
                    actionType       = "VISIT_ARRIVED",
                    description      = "Arrived at ${card.session.kinfolkId}",
                    targetId         = sessionId,
                    targetCollection = "kin_care_sessions",
                )
                if (_uiState.value.businessSettings.enableGPSTrackingForAllVisits) {
                    startGpsForSession(context, card.session)
                }
                notifier.notify(VisitNotifier.Event.ARRIVED, card.session)
            }
        }
    }

    fun departed(sessionId: String, context: Context) {
        runOnSession(sessionId) { card ->
            repo.markSessionDeparted(sessionId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repo,
                    actionType       = "VISIT_DEPARTED",
                    description      = "Departed ${card.session.kinfolkId}",
                    targetId         = sessionId,
                    targetCollection = "kin_care_sessions",
                )
                if (_uiState.value.businessSettings.enableGPSTrackingForAllVisits) {
                    stopGpsTracking(context)
                }
                notifier.notify(VisitNotifier.Event.DEPARTED, card.session)
            }
        }
    }

    fun complete(sessionId: String) {
        runOnSession(sessionId) { card ->
            repo.markSessionComplete(sessionId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = repo,
                    actionType       = "VISIT_COMPLETED",
                    description      = "Completed visit for ${card.session.kinfolkId}",
                    targetId         = sessionId,
                    targetCollection = "kin_care_sessions",
                )
            }
        }
    }

    private fun runOnSession(sessionId: String, block: suspend (TodayVisitCard) -> Unit) {
        val card = _uiState.value.todayVisits.firstOrNull { it.session.id == sessionId }
            ?: run {
                AuntieLog.w("runOnSession: session '$sessionId' not found in todayVisits")
                _uiState.value = _uiState.value.copy(actionError = "Session not found: $sessionId")
                return
            }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(pendingActionSessionId = sessionId)
            try {
                block(card)
            } catch (e: Exception) {
                AuntieLog.e("Visit action failed for $sessionId", e)
            } finally {
                _uiState.value = _uiState.value.copy(pendingActionSessionId = null)
                load()
            }
        }
    }

    private fun startGpsForSession(context: Context, session: KinCareSession) {
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START_TRACKING
            putExtra(LocationTrackingService.EXTRA_SESSION_ID, session.id)
            putExtra(LocationTrackingService.EXTRA_KINFOLK_ID, session.kinfolkId)
        }
        try {
            context.startForegroundService(intent)
        } catch (e: Exception) {
            AuntieLog.e("Failed to start GPS service for session ${session.id}", e)
        }
    }

    private fun stopGpsTracking(context: Context) {
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_STOP_TRACKING
        }
        try {
            context.startService(intent)
        } catch (e: Exception) {
            AuntieLog.w("Failed to stop GPS service", e)
        }
    }

    private fun todayStartIso(): String =
        LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toString()

    private fun todayEndIso(): String =
        LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString()

    /** Monday of the current local week as YYYY-MM-DD (week window lower bound). */
    private fun localWeekStartIso(): String {
        val today = LocalDate.now()
        val mondayOffset = today.dayOfWeek.value - 1 // Mon=1 -> 0, Sun=7 -> 6
        return today.minusDays(mondayOffset.toLong()).toString()
    }
}
