package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.emergencyContactsOf
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingNotesRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.admin.scheduling.assignUnavailableReason
import com.tribetails.auntieos.ui.admin.scheduling.canAssignAuntie
import com.tribetails.auntieos.ui.admin.scheduling.isNoteEditLocked
import com.tribetails.auntieos.ui.admin.scheduling.noteCutoffWarning
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Operational detail for one Kin Care. Auntie taps into this from the Auntie
 * Time row body - it's the in-the-field reference card she pulls up while
 * standing at the door or mid-visit. Action buttons live on the *list* row,
 * not here; this screen is read-only context.
 *
 * THE LAYOUT IS THE MOCK'S, `ui-ideas/auntieos-kincare-detail-2026-05-27.html`,
 * since the #755 sweep, the same pass the web detail took: a Den hero band
 * naming the visit by its Kin and service with the status pill on its right
 * edge, then Visit lifecycle (the five-node stepper), the route map and its
 * Location section, the two note boxes, and a Details panel of key/value
 * rows. The Android-only sections (Assigned Auntie, the address with its
 * maps chip, household access, emergency contact, the Kin 411 cards, the
 * KinTales sent) follow as kit panels in that order; the mock has no ruling
 * against them and the Auntie at the door needs them. What the mock draws
 * that this screen does not is the Kin photo stack at the front of the hero,
 * which needs a leading slot on `DenScreenHeading`.
 *
 * #446: resolves its visit BY ID (`KinCareRepository.getKinCareSession`)
 * instead of reading every `kin_care_sessions` doc and scanning for a match,
 * which is the pattern PR #432 moved the web admin's session/invoice/booking
 * lookups off of via `useDocById` (`lib/firestore.ts`) - this screen was left
 * on the old pattern deliberately in that PR because it already found the
 * deep-linked visit at any age, so there was no reported defect to fix. There
 * are three ways in, and all three already pass this same flat session id, so
 * none of them needed to change: the AuntieTime tab and the Admin Data > Kin
 * Care Sessions list both pass `session.id` straight from the row
 * (`KinCareSessionsScreen.onOpenDetail` in `Navigation.kt`), and the
 * `booking` notification type derives it from the envelope visit id before
 * navigating here (`sessionIdForVisit`, added by #389 / PR #432).
 *
 * States mirror `useDocById`'s three (opening / not available / read error):
 * a session that does not exist, and one this caller's test sandbox may not
 * see, both resolve to the SAME "not available" copy below - matching
 * `useDocById` folding a `permission-denied` snapshot error into
 * `ready + null` so a deep link never becomes an existence oracle for a
 * record outside the caller's scope. Anything else - a genuine read failure -
 * gets its own message and a Retry, which the old whole-collection scan never
 * distinguished either (a failed query silently produced the same
 * "not available" text, because [session] just stayed null).
 */
@Composable
fun KinCareDetailScreen(
    kinCareId: String,
    onBack: () -> Unit,
    onLiveTrack: (sessionId: String, kinfolkId: String, kinfolkName: String) -> Unit = { _, _, _ -> },
    onViewRoute: (routeId: String, kinfolkName: String) -> Unit = { _, _ -> },
    // #760: the purple house marker's coordinate, read raw off the household
    // document rather than carried on the `Kinfolk` model, because a field on
    // that model would be rebuilt from form state the next time somebody saved
    // the household from a screen that has no control for it. Injected so a
    // spec can hand the map a coordinate without Firebase; the default never
    // throws and answers null wherever Firestore is unreachable.
    householdLocation: suspend (String) -> HouseholdPoint? = ::fetchHouseholdServiceLocation,
    repo: AuntieRepository = AuntieOSApp.instance.repository,
    // W4-3: the visit and its KinTales read from the KinCare repo; the kinfolk,
    // kin and 411 reads on this screen are Directory domain and stay on [repo].
    kinCareRepo: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
    notesRepo: BookingNotesRepository = remember { BookingNotesRepository() },
) {
    val scope = rememberCoroutineScope()

    var session    by remember(kinCareId) { mutableStateOf<KinCareSession?>(null) }
    var kinfolk    by remember(kinCareId) { mutableStateOf<Kinfolk?>(null) }
    var kinById    by remember(kinCareId) { mutableStateOf<Map<String, Kin>>(emptyMap()) }
    var fourOnes   by remember(kinCareId) { mutableStateOf<Map<String, Kin411>>(emptyMap()) }
    var reports    by remember(kinCareId) { mutableStateOf<List<KinCareReport>>(emptyList()) }
    // #760: the GPS trail under the visit times. Live breadcrumbs while the
    // visit is in flight, the durable `gpsSummary` copy once it is not, because
    // `purgeOldVisitRoutes` deletes breadcrumbs past the retention window and a
    // panel that read them alone would be blank on exactly the visits the
    // office reviews. Same split the web admin's Route panel makes.
    var crumbs     by remember(kinCareId) { mutableStateOf<List<GpsPoint>>(emptyList()) }
    var house      by remember(kinCareId) { mutableStateOf<HouseholdPoint?>(null) }
    var loading    by remember(kinCareId) { mutableStateOf(true) }
    // A genuine read failure, kept apart from "not available" below - see the
    // useDocById mirror in the doc comment above.
    var loadError  by remember(kinCareId) { mutableStateOf<String?>(null) }
    var retryNonce by remember(kinCareId) { mutableStateOf(0) }

    LaunchedEffect(kinCareId, retryNonce) {
        loading = true
        loadError = null
        scope.launch {
            kinCareRepo.getKinCareSession(kinCareId)
                .onSuccess { s ->
                    session = s
                    if (s != null && s.kinfolkId.isNotBlank()) {
                        repo.getKinfolk().onSuccess { kf ->
                            kinfolk = kf.firstOrNull { it.id == s.kinfolkId }
                        }
                    }
                    if (s != null) {
                        val ids = (s.kinIds + listOf(s.kinId)).filter { it.isNotBlank() }.distinct()
                        if (ids.isNotEmpty()) {
                            repo.getKinByIds(ids).onSuccess { kinById = it }
                            repo.get411ByKinIds(ids).onSuccess { fourOnes = it }
                        }
                        kinCareRepo.getReportsForSession(kinCareId).onSuccess { list ->
                            reports = list.sortedByDescending { it.sentAt.orEmpty().ifBlank { it.createdAt } }
                        }
                        // #760. A failed breadcrumb read leaves the list empty,
                        // which falls through to the saved summary below rather
                        // than blanking the panel.
                        kinCareRepo.getBreadcrumbs(kinCareId).onSuccess { pts ->
                            crumbs = pts.map { GpsPoint(lat = it.latitude, lng = it.longitude, t = it.timestamp) }
                        }
                        house = householdLocation(s.kinfolkId)
                    }
                }
                .onFailure { err ->
                    session = null
                    // A sandbox operator reading a session outside their test scope
                    // gets PERMISSION_DENIED straight from the Firestore rule
                    // (`kin_care_sessions` allows read only to the owning kinfolk, a
                    // real Auntie, or the matching test scope - see
                    // `auntieos-admin/web/firestore.rules`). That fact reads exactly
                    // like "this doesn't exist" to the caller, so it falls through to
                    // the same not-available copy below instead of a scary rules
                    // error, same as `useDocById` folds `permission-denied` into
                    // `ready + null`.
                    if (!isKinCarePermissionDenied(err)) {
                        loadError = err.message
                            ?: "Couldn't load this Kin Care. Check your connection and try again."
                    }
                }
            loading = false
        }
    }

    val s = session
    AuntieScreenScaffold(
        title = s?.kinfolkName?.ifBlank { "Kin Care" } ?: "Loading…",
        onBack = onBack,
    ) {
        if (loading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                AuntieSpinner(modifier = Modifier.size(32.dp), color = AuntieTheme.colors.kinfolkOrange)
            }
            return@AuntieScreenScaffold
        }

        if (loadError != null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.padding(horizontal = 24.dp),
                ) {
                    Text(
                        loadError.orEmpty(),
                        color = AuntieTheme.colors.error,
                        style = AuntieTheme.typography.bodyMedium,
                    )
                    PrimaryButton(label = "Retry", onClick = { retryNonce++ })
                }
            }
            return@AuntieScreenScaffold
        }

        if (s == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                // NAMES THE THIRD READING, which is the one a notification
                // produces: a visit that is still REQUESTED has no
                // `kin_care_sessions` document at all, because approval is
                // what creates one (approveBookingSeriesCore.ts). "Not
                // found" on its own sent an operator hunting for a visit
                // that is sitting in the incoming-requests queue waiting on
                // them. Same sentence the React admin's "Booking
                // unavailable" dialog carries. Also covers the sandbox
                // permission-denied case folded in above.
                Text(
                    "This Kin Care isn't available to open. A visit gets its own record " +
                        "only once the request is approved, so a request still waiting on " +
                        "you has none yet. Otherwise it may have been cancelled or removed.",
                    color = AuntieTheme.colors.textDim,
                )
            }
            return@AuntieScreenScaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            val orderedIds = (s.kinIds + listOf(s.kinId)).filter { it.isNotBlank() }.distinct()
            // The mock names the visit by its Kin and its service ("Biscuit &
            // Gravy · 30-min walk"), puts the window, the household and the
            // door on the line under it, and hangs the status pill off the
            // right edge. The household is the fallback name, never the first
            // choice: on this screen the family is context, the visit is the
            // subject.
            val kinLabel = orderedIds
                .mapNotNull { kinById[it]?.name?.takeIf { n -> n.isNotBlank() } }
                .joinToString(" & ")
            val household = s.kinfolkName.ifBlank { "Kin Care" }
            val heroTitle = listOf(kinLabel, s.serviceType)
                .filter { it.isNotBlank() }
                .joinToString(" · ")
                .ifBlank { household }
            val heroDetail = listOfNotNull(
                window(s).takeIf { it.isNotBlank() },
                s.kinfolkName.takeIf { it.isNotBlank() },
                kinfolk?.serviceAddress?.takeIf { it.isNotBlank() },
            ).joinToString(" · ")

            item {
                DenScreenHeading(
                    kicker = "The Den · Auntie Time",
                    // The crumb IS the way back, the same trail the web detail
                    // draws: the rail's name for the board, then the Kin.
                    crumbs = listOf(
                        DenCrumb("Auntie Time", onBack),
                        DenCrumb(kinLabel.ifBlank { household }),
                    ),
                    title = heroTitle,
                    detail = heroDetail.ifBlank { null },
                    trailing = {
                        AuntieStatusPill(
                            label = statusLabel(s.status),
                            tone = kinCareStatusTone(s.status),
                            mono = true,
                        )
                    },
                )
            }

            item {
                DetailSection("Visit lifecycle") {
                    LifecycleStepper(steps = lifecycleSteps(s))
                }
            }

            val isActive = !s.arrivedAt.isNullOrBlank() && s.departedAt.isNullOrBlank()
            val hasRoute = s.visitRouteId.isNotBlank()

            // #760: the route map, DIRECTLY under the Visit lifecycle section,
            // which is where the arrival and departure times are. Operator
            // ruling 2026-09-11: "this is what the map looks like and is
            // usually listed under the arrival departure times".
            run {
                val summaryRoute = s.gpsSummary?.route.orEmpty()
                val trail = if (crumbs.isNotEmpty()) crumbs else summaryRoute
                if (trail.isNotEmpty()) {
                    item {
                        DetailSection("Visit route") {
                            KinCareRouteMap(
                                points = trail,
                                header = routeHeaderStrip(
                                    arrivedAt = s.arrivedAt,
                                    departedAt = s.departedAt,
                                    distanceMeters = s.gpsSummary?.distanceMeters,
                                    durationSeconds = s.gpsSummary?.durationSeconds,
                                    nowMillis = System.currentTimeMillis(),
                                ),
                                house = house,
                                live = isActive,
                            )
                            if (crumbs.isEmpty() && summaryRoute.isNotEmpty()) {
                                EmptyHint(
                                    "Replay from the route saved on this visit. The per-ping " +
                                        "breadcrumbs are not being read, so this is the " +
                                        "down-sampled copy.",
                                )
                            }
                        }
                    }
                }
            }

            // Not yet clocked in: "never tracked" would be a false verdict on a
            // visit that has not happened yet, so SCHEDULED/ON_MY_WAY get their
            // own forward-looking line instead of the two below.
            val notYetStarted = s.status.equals("SCHEDULED", ignoreCase = true) ||
                s.status.equals("ON_MY_WAY", ignoreCase = true)
            // #754: the section used to be OMITTED entirely once neither button
            // applied, so a finished visit with no route told the office nothing.
            // It now always renders and names which of the two facts is true,
            // matching the web admin's Route panel split on the same field.
            item {
                DetailSection("Location") {
                    if (isActive) {
                        PrimaryButton(
                            label = "Open live tracking",
                            onClick = { onLiveTrack(s.id, s.kinfolkId, s.kinfolkName) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (hasRoute) {
                        PrimaryButton(
                            label = "View visit route",
                            onClick = { onViewRoute(s.visitRouteId, s.kinfolkName) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (!isActive && !hasRoute) {
                        EmptyHint(
                            if (notYetStarted) {
                                "Tracking starts once an Auntie clocks in for this Kin Care."
                            } else if (s.gpsSummary != null) {
                                "A GPS summary was saved for this Kin Care, but it has no route to view."
                            } else {
                                "No GPS breadcrumbs were recorded for this Kin Care because it was never tracked."
                            }
                        )
                    }
                }
            }

            // The mock's two note boxes: what the household said about their
            // own house, and what the office keeps to itself.
            item {
                BookingNotesSection(
                    session = s,
                    notesRepo = notesRepo,
                )
            }

            // The mock's Details: key on the left, value on the right, one
            // hairline per row. Read-only here; the edit lives on the web
            // detail and the Bookings sheet.
            item {
                DetailSection("Details") {
                    DetailFieldRow("Service", s.serviceType)
                    DetailFieldRow(
                        "Visit length",
                        if (s.serviceDurationMinutes > 0) "${s.serviceDurationMinutes} min" else "",
                    )
                    // Present only once the visit has been billed, the same
                    // rule as the board's "Invoice linked" chip: an unbilled
                    // visit is the normal state of a visit, not a gap.
                    DetailFieldRow("Invoice", if (s.invoiceId.isNotBlank()) "Linked" else "")
                    if (s.serviceType.isBlank() && s.serviceDurationMinutes <= 0 && s.invoiceId.isBlank()) {
                        EmptyHint("No service, length or invoice on this record yet.")
                    }
                }
            }

            // Assigned Auntie lives on the MyTribe kinCare visit doc, so it can
            // only be set when the session carries the envelope FKs. When it
            // cannot, the section still renders and SAYS SO: hiding it outright
            // (the old behaviour) left an operator unable to tell "nobody is
            // assigned" from "this visit cannot be assigned".
            val assignBatchId = s.kinCareBatchId.orEmpty()
            val assignVisitId = s.kinCareVisitId.orEmpty()
            if (canAssignAuntie(s.kinfolkId, assignBatchId, assignVisitId)) {
                item {
                    AssignedAuntieSection(
                        kinfolkId = s.kinfolkId,
                        batchId = assignBatchId,
                        visitId = assignVisitId,
                    )
                }
            } else {
                item {
                    DetailSection("Assigned Auntie") {
                        EmptyHint(assignUnavailableReason())
                    }
                }
            }

            kinfolk?.serviceAddress?.takeIf { it.isNotBlank() }?.let { addr ->
                item { DetailSection("Address") { AddressBlock(addr) } }
            }

            kinfolk?.let { kf ->
                val anyAccess = listOf(
                    kf.gateCode, kf.parkingInstructions, kf.entryNotes,
                    kf.wifiName, kf.wifiPassword,
                ).any { it.isNotBlank() }
                if (anyAccess) {
                    item {
                        DetailSection("Household access") {
                            FactRow(Lucide.KeyRound, "Gate / door code", kf.gateCode)
                            FactRow(Lucide.House, "Parking", kf.parkingInstructions)
                            FactRow(Lucide.Wifi, "Wi-Fi", wifiSummary(kf))
                            FactRow(Lucide.NotebookPen, "Entry notes", kf.entryNotes, multiline = true)
                        }
                    }
                }
                val ec = emergencyContactsOf(kf)
                if (ec.isNotEmpty()) {
                    item {
                        DetailSection("Emergency contact") {
                            ec.forEach { c ->
                                FactRow(Lucide.Phone, "Name", c.name)
                                FactRow(Lucide.Phone, "Phone", c.phone)
                                FactRow(Lucide.Phone, "Relationship", c.relationship.orEmpty())
                            }
                        }
                    }
                }
            }

            if (orderedIds.isNotEmpty()) {
                item {
                    DetailSection("Kin in this care") {
                        if (kinById.isEmpty() && fourOnes.isEmpty()) {
                            EmptyHint("No Kin records linked to this Kin Care.")
                        } else {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                orderedIds.forEach { kid ->
                                    KinCard(kin = kinById[kid], fourOneOne = fourOnes[kid])
                                }
                            }
                        }
                    }
                }
            }

            item {
                DetailSection("KinTales sent") {
                    if (reports.isEmpty()) {
                        EmptyHint("No KinTales sent yet during this Kin Care.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            reports.forEach { r -> KinTaleSnippet(r) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Assigned Auntie row + reassign actions, backed by the admin assignAuntie
 * callable. Optimistic: the row flips before the callable resolves and reverts
 * (with the error shown) on failure. On success the visit doc is re-read so
 * the canonical staff display name replaces the optimistic placeholder.
 *
 * "Choose an Auntie" expands the staff roster (listStaff callable, loaded once
 * on first expand) so any staff member can be assigned, not just yourself.
 */
@Composable
private fun AssignedAuntieSection(
    kinfolkId: String,
    batchId: String,
    visitId: String,
) {
    val repo = AuntieOSApp.instance.kinCareRepository
    val scope = rememberCoroutineScope()
    val myUid = remember { FirebaseAuth.getInstance().currentUser?.uid }
    var assignedUid by remember(visitId) { mutableStateOf<String?>(null) }
    var assignedName by remember(visitId) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Staff roster for the picker: loaded once, on first expand.
    var pickerOpen by remember(visitId) { mutableStateOf(false) }
    var roster by remember(visitId) { mutableStateOf<List<com.tribetails.auntieos.data.repository.StaffMember>?>(null) }
    var rosterLoading by remember { mutableStateOf(false) }
    var rosterError by remember { mutableStateOf<String?>(null) }

    fun loadRoster() {
        if (rosterLoading || roster != null) return
        scope.launch {
            rosterLoading = true
            rosterError = null
            repo.listStaff()
                .onSuccess { roster = it }
                .onFailure { rosterError = it.message ?: "Couldn't load the staff roster." }
            rosterLoading = false
        }
    }

    LaunchedEffect(visitId) {
        repo.getKinCareAssignment(kinfolkId, batchId, visitId).onSuccess {
            assignedUid = it.assignedAuntieUid
            assignedName = it.auntieDisplayName
        }
    }

    fun change(uid: String?, optimisticName: String?) {
        if (saving) return
        val prevUid = assignedUid
        val prevName = assignedName
        assignedUid = uid
        assignedName = optimisticName
        scope.launch {
            saving = true
            error = null
            repo.assignAuntie(kinfolkId, batchId, visitId, uid)
                .onSuccess {
                    repo.getKinCareAssignment(kinfolkId, batchId, visitId).onSuccess { canon ->
                        assignedUid = canon.assignedAuntieUid
                        assignedName = canon.auntieDisplayName
                    }
                }
                .onFailure {
                    assignedUid = prevUid
                    assignedName = prevName
                    error = it.message ?: "Couldn't change the Auntie."
                }
            saving = false
        }
    }

    DetailSection("Assigned Auntie") {
        FactRow(
            Lucide.UserCheck,
            "Auntie",
            assignedName ?: if (assignedUid != null) "Assigned" else "Unassigned",
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            PrimaryButton(
                label = "Assign to me",
                onClick = { change(myUid, "You") },
                enabled = !saving && myUid != null && myUid != assignedUid,
                loading = saving,
                modifier = Modifier.weight(1f),
            )
            PrimaryButton(
                label = "Unassign",
                onClick = { change(null, null) },
                enabled = !saving && assignedUid != null,
                modifier = Modifier.weight(1f),
            )
        }
        GhostButton(
            label = if (pickerOpen) "Hide the roster" else "Choose an Auntie",
            onClick = {
                pickerOpen = !pickerOpen
                if (pickerOpen) loadRoster()
            },
            modifier = Modifier.fillMaxWidth(),
        )
        if (pickerOpen) {
            when {
                rosterLoading -> EmptyHint("Loading the roster…")
                rosterError != null -> Text(
                    text = rosterError.orEmpty(),
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.error,
                )
                roster?.isEmpty() == true -> EmptyHint("No staff on the roster yet.")
                else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    roster.orEmpty().forEach { staff ->
                        StaffPickRow(
                            name = if (staff.uid == myUid) "${staff.label} (you)" else staff.label,
                            selected = staff.uid == assignedUid,
                            enabled = !saving && staff.uid != assignedUid,
                            onPick = {
                                pickerOpen = false
                                change(staff.uid, staff.label)
                            },
                        )
                    }
                    if (roster.orEmpty().size == 1) {
                        EmptyHint("Just one Auntie on the roster right now.")
                    }
                }
            }
        }
        error?.let { msg ->
            Text(
                text = msg,
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.error,
            )
        }
    }
}

/** One tappable staff row in the Assigned Auntie picker; a check marks the current pick. */
@Composable
private fun StaffPickRow(
    name: String,
    selected: Boolean,
    enabled: Boolean,
    onPick: () -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) c.kinfolkOrange.copy(alpha = 0.10f) else c.surface2)
            .border(
                0.5.dp,
                if (selected) c.kinfolkOrange.copy(alpha = 0.45f) else c.border,
                RoundedCornerShape(8.dp),
            )
            .then(if (enabled) Modifier.clickable(onClick = onPick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = if (selected) Lucide.Check else Lucide.UserRound,
            contentDescription = null,
            tint = if (selected) c.kinfolkOrange else c.textDim,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = name,
            style = AuntieTheme.typography.bodyMedium,
            color = if (enabled || selected) c.textPrimary else c.textDim,
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Text(
                text = "On this visit",
                style = AuntieTheme.typography.labelSmall,
                color = c.kinfolkOrange,
            )
        }
    }
}

/**
 * One section of the detail as the kit's glass panel with its serif title
 * (#755). This used to be an `AuntieCard` with an uppercase label, which is
 * the one shape the mock never draws; every other admin screen's section is a
 * `DenPanel`, and now so is this one.
 */
@Composable
private fun DetailSection(
    title: String,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    DenPanel(title = title, modifier = Modifier.fillMaxWidth(), trailing = trailing) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            content()
        }
    }
}

/**
 * The mock's `.field`: dim key on the left, bold value on the right, a
 * hairline under the row. Renders nothing when the value is blank, the same
 * rule [FactRow] applies, so an absent field is absent rather than "".
 */
@Composable
private fun DetailFieldRow(label: String, value: String) {
    if (value.isBlank()) return
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                drawLine(
                    color = c.borderSoft,
                    start = Offset(0f, size.height),
                    end = Offset(size.width, size.height),
                    strokeWidth = 1.dp.toPx(),
                )
            }
            .padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.End,
        )
    }
}

/**
 * The mock's `.life`: five nodes on a hairline, the teal bar running to the
 * last one that has happened, the lit node in orange with a soft halo. The
 * line runs from the first node's centre to the last node's centre (each
 * node is centred in a fifth of the row, so 10% in from either edge).
 */
@Composable
private fun LifecycleStepper(steps: List<LifecycleStep>) {
    val c = AuntieTheme.colors
    val progress = lifecycleProgress(steps)
    val haloSize = 36.dp
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val y = haloSize.toPx() / 2f
                val x0 = size.width * 0.1f
                val x1 = size.width * 0.9f
                val stroke = 2.dp.toPx()
                drawLine(color = c.border, start = Offset(x0, y), end = Offset(x1, y), strokeWidth = stroke)
                if (progress > 0f) {
                    drawLine(
                        color = c.accent,
                        start = Offset(x0, y),
                        end = Offset(x0 + (x1 - x0) * progress, y),
                        strokeWidth = stroke,
                    )
                }
            },
    ) {
        steps.forEach { step ->
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val now = step.mood == LifecycleMood.Now
                val done = step.mood == LifecycleMood.Done
                Box(
                    modifier = Modifier
                        .size(haloSize)
                        .clip(CircleShape)
                        .background(if (now) c.primary.copy(alpha = 0.25f) else Color.Transparent),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    now -> c.primary
                                    done -> c.accent
                                    else -> c.surface2
                                },
                            )
                            .then(if (now || done) Modifier else Modifier.border(2.dp, c.border, CircleShape)),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (now || done) {
                            Text(
                                text = if (done) "✓" else "●",
                                style = AuntieTheme.typography.labelSmall,
                                color = if (now) c.background else c.textPrimary,
                            )
                        }
                    }
                }
                Text(
                    text = step.name,
                    style = AuntieTheme.typography.labelSmall,
                    color = if (step.mood == LifecycleMood.Todo) c.textDim else c.textPrimary,
                    textAlign = TextAlign.Center,
                )
                // A stamp when there is one. A node still to come reads "-";
                // a lit node with nothing on the record (Scheduled has no
                // booking timestamp on the session) reads nothing, rather
                // than a dash that says "not yet".
                val ts = when {
                    step.stamp.isNotBlank() -> shortIso(step.stamp)
                    step.mood == LifecycleMood.Todo -> "-"
                    else -> ""
                }
                if (ts.isNotBlank()) {
                    Text(
                        text = ts,
                        style = AuntieTheme.typography.mono.copy(fontSize = 10.sp),
                        color = c.textDim,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun FactRow(icon: ImageVector, label: String, value: String, multiline: Boolean = false) {
    if (value.isBlank()) return
    Row(
        verticalAlignment = if (multiline) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = AuntieTheme.colors.textDim, modifier = Modifier.size(14.dp))
        Text(
            text  = label,
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim,
            modifier = Modifier.padding(end = 6.dp),
        )
        Text(
            text  = value,
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textPrimary,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun AddressBlock(address: String) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(address, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.12f))
                .border(0.5.dp, AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.45f), RoundedCornerShape(999.dp))
                .clickable {
                    val uri = Uri.parse("geo:0,0?q=" + Uri.encode(address))
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        })
                    }
                },
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Lucide.MapPin, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(13.dp))
                Text("Open in Maps", style = AuntieTheme.typography.labelLarge, color = AuntieTheme.colors.kinfolkOrange)
            }
        }
    }
}

@Composable
private fun KinTaleSnippet(report: KinCareReport) {
    val accent = when (report.status.uppercase()) {
        "SENT"   -> AuntieTheme.colors.success
        "FAILED" -> AuntieTheme.colors.error
        else     -> AuntieTheme.colors.textDim
    }
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface2,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.border),
        shape  = RoundedCornerShape(8.dp),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = report.status.lowercase().replaceFirstChar { it.uppercaseChar() },
                    style = AuntieTheme.typography.titleSmall,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                )
                val ts = report.sentAt.orEmpty().ifBlank { report.updatedAt.ifBlank { report.createdAt } }
                if (ts.isNotBlank()) {
                    Text(ts, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                }
            }
            if (report.bodyCopy.isNotBlank()) {
                Text(
                    text  = report.bodyCopy.take(180) + if (report.bodyCopy.length > 180) "…" else "",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }
}

@Composable
private fun KinCard(kin: Kin?, fourOneOne: Kin411?) {
    val title = kin?.name?.takeIf { it.isNotBlank() } ?: "Unnamed Kin"
    val sublineParts = buildList {
        kin?.species?.takeIf { it.isNotBlank() }?.let { add(it) }
        kin?.breed?.takeIf { it.isNotBlank() }?.let { add(it) }
        kin?.age?.takeIf { it.isNotBlank() }?.let { add(it) }
        kin?.sex?.takeIf { it.isNotBlank() }?.let { add(it) }
    }
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface2,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.border),
        shape  = RoundedCornerShape(8.dp),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Lucide.PawPrint, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(14.dp))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(title, style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (sublineParts.isNotEmpty()) {
                        Text(
                            text = sublineParts.joinToString(" · "),
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
                if (kin?.reactive == true || fourOneOne?.reactive == true) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(AuntieTheme.colors.error.copy(alpha = 0.15f))
                            .border(0.5.dp, AuntieTheme.colors.error.copy(alpha = 0.5f), RoundedCornerShape(999.dp))
                    ) {
                        Text(
                            text = "Reactive",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.error,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }

            FactRow(Lucide.FileText, "Personality", fourOneOne?.personality.orEmpty(), multiline = true)
            FactRow(Lucide.FileText, "Quirks",      fourOneOne?.quirksAndPreferences.orEmpty(), multiline = true)
            FactRow(Lucide.FileText, "Medical",     fourOneOne?.medicalNotes.orEmpty(), multiline = true)
            FactRow(Lucide.FileText, "Diet",        feedingSummary(fourOneOne), multiline = true)
            FactRow(Lucide.Phone,       "Vet",         vetSummary(fourOneOne))
        }
    }
}

private fun feedingSummary(k: Kin411?): String {
    if (k == null) return ""
    val parts = listOf(k.dietaryDetails, k.feedingAmount, k.feedingFrequency).filter { !it.isNullOrBlank() }
    return parts.joinToString(" · ")
}

private fun vetSummary(k: Kin411?): String {
    if (k == null) return ""
    val parts = listOf(k.vetName, k.vetPhone).filter { !it.isNullOrBlank() }
    return parts.joinToString(" · ")
}

private fun wifiSummary(k: Kinfolk): String {
    if (k.wifiName.isBlank() && k.wifiPassword.isBlank()) return ""
    val name = k.wifiName.ifBlank { "(unnamed)" }
    val pass = if (k.wifiPassword.isNotBlank()) " · password on file" else ""
    return "$name$pass"
}

private fun window(s: KinCareSession): String {
    val start = shortIso(s.startTime)
    val end   = shortIsoTimeOnly(s.endTime)
    return when {
        start.isBlank() && end.isBlank() -> "Time TBD"
        end.isBlank()                    -> start
        else                             -> "$start - $end"
    }
}

private fun shortIso(iso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        "$month $day · $time"
    }.getOrDefault(iso)

private fun shortIsoTimeOnly(iso: String): String =
    runCatching { if (iso.length >= 16) iso.substring(11, 16) else iso }
        .getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")

/** True iff a by-id session read failed because Firestore rules denied it -
 *  the sandbox "not yours to see" case, folded into "not available" above. */
private fun isKinCarePermissionDenied(err: Throwable): Boolean =
    err is FirebaseFirestoreException && err.code == FirebaseFirestoreException.Code.PERMISSION_DENIED

@Composable
private fun BookingNotesSection(
    session: KinCareSession,
    notesRepo: BookingNotesRepository,
) {
    val scope = rememberCoroutineScope()
    val bookingId = session.sourceBookingId.ifBlank { session.id }
    val canStream = session.kinfolkId.isNotBlank() && bookingId.isNotBlank()

    val kinfolkFacing by remember(canStream, bookingId) {
        if (canStream) notesRepo.streamKinfolkFacingNotes(session.kinfolkId, bookingId)
        else flowOf(emptyList<BookingNotesRepository.BookingNote>())
    }.collectAsState(initial = emptyList())
    val internal by remember(canStream, bookingId) {
        if (canStream) notesRepo.streamInternalNotes(session.kinfolkId, bookingId)
        else flowOf(emptyList<BookingNotesRepository.BookingNote>())
    }.collectAsState(initial = emptyList())

    // Through the shared helper, not a re-implementation: this screen used to
    // carry its own private NOTE_CUTOFF_MS and its own inline comparison, which
    // could drift from the copy the Schedule dialog uses.
    val locked = remember(session.startTime) {
        val startMs = runCatching {
            LocalDateTime.parse(session.startTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                .atZone(ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli()
        }.getOrNull()
        isNoteEditLocked(System.currentTimeMillis(), startMs)
    }

    var kinfolkInput by remember(bookingId) { mutableStateOf("") }
    var internalInput by remember(bookingId) { mutableStateOf("") }
    var savingKinfolk by remember { mutableStateOf(false) }
    var savingInternal by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // The mock's two note boxes, one panel each, with the mock's `.who-can`
    // note on the header rule saying who sees the box. The composers and
    // their 3-hour cutoff are unchanged; only the container moved.
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        DetailSection(
            "Kinfolk-facing note",
            trailing = { PanelWhoCan("visible to ${session.kinfolkName.ifBlank { "the household" }}") },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Legacy inline notes (still present on existing session docs)
                if (session.kinfolkNotes.isNotBlank()) {
                    FactRow(Lucide.NotebookPen, "On file", session.kinfolkNotes, multiline = true)
                }
                kinfolkFacing.sortedBy { it.createdAtMs ?: 0L }.forEach { note ->
                    FactRow(Lucide.NotebookPen, note.authorRole.ifBlank { "note" }, note.body, multiline = true)
                }
                if (session.kinfolkNotes.isBlank() && kinfolkFacing.isEmpty()) {
                    EmptyHint("No kinfolk-facing notes yet.")
                }
                AuntieField(
                    value = kinfolkInput,
                    onValueChange = { kinfolkInput = it },
                    label = "Add kinfolk-facing note",
                    placeholder = "Editable until 3 hours before visit.",
                    singleLine = false,
                    minLines = 3,
                    enabled = canStream && !locked,
                )
                noteCutoffWarning(locked)?.let { msg ->
                    Text(
                        text = msg,
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.warning,
                    )
                }
                PrimaryButton(
                    label = if (savingKinfolk) "Saving…" else "Save kinfolk-facing note",
                    enabled = canStream && !locked && !savingKinfolk && kinfolkInput.isNotBlank(),
                    onClick = {
                        scope.launch {
                            savingKinfolk = true
                            error = null
                            notesRepo.addKinfolkFacingNote(session.kinfolkId, bookingId, kinfolkInput.trim())
                                .onSuccess { kinfolkInput = "" }
                                .onFailure { error = it.message ?: "Note save failed." }
                            savingKinfolk = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        DetailSection("Admin-internal note", trailing = { PanelWhoCan("private") }) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (session.notes.isNotBlank()) {
                    FactRow(Lucide.NotebookPen, "On file", session.notes, multiline = true)
                }
                internal.sortedBy { it.createdAtMs ?: 0L }.forEach { note ->
                    FactRow(Lucide.NotebookPen, note.authorRole.ifBlank { "admin" }, note.body, multiline = true)
                }
                if (session.notes.isBlank() && internal.isEmpty()) {
                    EmptyHint("No internal notes yet.")
                }
                AuntieField(
                    value = internalInput,
                    onValueChange = { internalInput = it },
                    label = "Add internal note",
                    placeholder = "Hidden from kinfolk. Visible to staff on every session of this booking.",
                    singleLine = false,
                    minLines = 3,
                    // Locked on the same 3-hour cutoff as the kinfolk-facing thread.
                    // addInternalBookingNote enforces it server-side too, so this is
                    // a mirror that closes the composer early, not the guard itself;
                    // see BookingNoteCutoff.kt.
                    enabled = canStream && !locked,
                )
                noteCutoffWarning(locked)?.let { msg ->
                    Text(
                        text = msg,
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.warning,
                    )
                }
                PrimaryButton(
                    label = if (savingInternal) "Saving…" else "Save internal note",
                    enabled = canStream && !locked && !savingInternal && internalInput.isNotBlank(),
                    onClick = {
                        scope.launch {
                            savingInternal = true
                            error = null
                            notesRepo.addInternalNote(session.kinfolkId, bookingId, internalInput.trim())
                                .onSuccess { internalInput = "" }
                                .onFailure { error = it.message ?: "Note save failed." }
                            savingInternal = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )

                error?.let { msg ->
                    Text(
                        text = msg,
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.error,
                    )
                }

                if (!canStream) {
                    Text(
                        text = "Notes unavailable - session is missing kinfolkId or bookingId.",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.error,
                    )
                }
            }
        }
    }
}

/**
 * The mock's `.who-can`: a short mono note on the panel header saying who
 * sees the box. The web twin is `DenPanel`'s `meta` prop; the Android panel
 * has only a trailing slot, so the same mono text rides there.
 */
@Composable
private fun PanelWhoCan(text: String) {
    Text(
        text = text,
        style = AuntieTheme.typography.mono.copy(fontSize = 10.sp),
        color = AuntieTheme.colors.textDim,
    )
}
