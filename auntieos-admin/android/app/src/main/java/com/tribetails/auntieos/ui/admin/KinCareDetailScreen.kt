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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.BookingNotesRepository
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
 */
@Composable
fun KinCareDetailScreen(
    kinCareId: String,
    onBack: () -> Unit,
    onLiveTrack: (sessionId: String, kinfolkId: String, kinfolkName: String) -> Unit = { _, _, _ -> },
    onViewRoute: (routeId: String, kinfolkName: String) -> Unit = { _, _ -> },
) {
    val repo = AuntieOSApp.instance.repository
    // W4-3: the visit and its KinTales read from the KinCare repo; the kinfolk,
    // kin and 411 reads on this screen are Directory domain and stay on [repo].
    val kinCareRepo = AuntieOSApp.instance.kinCareRepository
    val notesRepo = remember { BookingNotesRepository() }
    val scope = rememberCoroutineScope()

    var session    by remember(kinCareId) { mutableStateOf<KinCareSession?>(null) }
    var kinfolk    by remember(kinCareId) { mutableStateOf<Kinfolk?>(null) }
    var kinById    by remember(kinCareId) { mutableStateOf<Map<String, Kin>>(emptyMap()) }
    var fourOnes   by remember(kinCareId) { mutableStateOf<Map<String, Kin411>>(emptyMap()) }
    var reports    by remember(kinCareId) { mutableStateOf<List<KinCareReport>>(emptyList()) }
    var loading    by remember(kinCareId) { mutableStateOf(true) }

    LaunchedEffect(kinCareId) {
        loading = true
        scope.launch {
            kinCareRepo.getKinCareSessions().onSuccess { all ->
                val s = all.firstOrNull { it.id == kinCareId }
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
        if (loading || s == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (loading) {
                    AuntieSpinner(modifier = Modifier.size(32.dp), color = AuntieTheme.colors.kinfolkOrange)
                } else {
                    Text("Kin Care not found", color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
                }
            }
            return@AuntieScreenScaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            item { Subhead(text = listOfNotNull(
                s.serviceType.takeIf { it.isNotBlank() },
                window(s),
            ).joinToString(" · ")) }

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
                if (kf.emergencyContactName.isNotBlank() || kf.emergencyContactPhone.isNotBlank()) {
                    item {
                        DetailSection("Emergency contact") {
                            FactRow(Lucide.Phone, "Name",         kf.emergencyContactName)
                            FactRow(Lucide.Phone, "Phone",        kf.emergencyContactPhone)
                            FactRow(Lucide.Phone, "Relationship", kf.emergencyContactRelation)
                        }
                    }
                }
            }

            item {
                BookingNotesSection(
                    session = s,
                    notesRepo = notesRepo,
                )
            }

            run {
                val orderedIds = (s.kinIds + listOf(s.kinId)).filter { it.isNotBlank() }.distinct()
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
            }

            item {
                DetailSection("Lifecycle") {
                    TimelineRow("Scheduled", s.startTime)
                    TimelineRow("On my way", s.onMyWayAt.orEmpty())
                    TimelineRow("Arrived",   s.arrivedAt.orEmpty())
                    TimelineRow("Departed",  s.departedAt.orEmpty())
                    TimelineRow("Completed", s.completedAt.orEmpty())
                }
            }

            val isActive = !s.arrivedAt.isNullOrBlank() && s.departedAt.isNullOrBlank()
            val hasRoute = s.visitRouteId.isNotBlank()
            if (isActive || hasRoute) {
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
            tint = if (selected) c.kinfolkOrange else c.textPrimary.copy(alpha = 0.5f),
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = name,
            style = AuntieTheme.typography.bodyMedium,
            color = if (enabled || selected) c.textPrimary else c.textPrimary.copy(alpha = 0.5f),
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

@Composable
private fun Subhead(text: String) {
    if (text.isBlank()) return
    Text(
        text = text,
        style = AuntieTheme.typography.bodyMedium,
        color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
        modifier = Modifier.padding(vertical = 4.dp),
    )
}

@Composable
private fun DetailSection(title: String, content: @Composable () -> Unit) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.border),
        shape  = RoundedCornerShape(10.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text  = title.uppercase(),
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f),
            )
            content()
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
        Icon(icon, contentDescription = null, tint = AuntieTheme.colors.textPrimary.copy(alpha = 0.5f), modifier = Modifier.size(14.dp))
        Text(
            text  = label,
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
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
private fun TimelineRow(label: String, iso: String) {
    val hit = iso.isNotBlank()
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(if (hit) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textPrimary.copy(alpha = 0.3f)),
        )
        Text(
            text  = label,
            style = AuntieTheme.typography.bodyMedium,
            color = if (hit) AuntieTheme.colors.textPrimary else AuntieTheme.colors.textPrimary.copy(alpha = 0.5f),
            modifier = Modifier.weight(1f),
        )
        Text(
            text  = if (hit) shortIso(iso) else "-",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.4f),
        )
    }
}

@Composable
private fun KinTaleSnippet(report: KinCareReport) {
    val accent = when (report.status.uppercase()) {
        "SENT"   -> AuntieTheme.colors.success
        "FAILED" -> AuntieTheme.colors.error
        else     -> AuntieTheme.colors.textPrimary.copy(alpha = 0.6f)
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
                    Text(ts, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.5f))
                }
            }
            if (report.bodyCopy.isNotBlank()) {
                Text(
                    text  = report.bodyCopy.take(180) + if (report.bodyCopy.length > 180) "…" else "",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
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
                            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f),
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

@Composable
private fun EmptyHint(text: String) {
    Text(
        text  = text,
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.textPrimary.copy(alpha = 0.5f),
    )
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

    DetailSection("Pre-visit notes") {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = "Kinfolk-facing",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
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

            Spacer(Modifier.height(8.dp))
            Text(
                text = "Internal - staff only",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
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
