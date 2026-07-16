package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.AlarmClock
import com.composables.icons.lucide.Calendar
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.HousePlus
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.composables.icons.lucide.MessageCircle
import com.composables.icons.lucide.NotebookPen
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Phone
import com.composables.icons.lucide.PhoneCall
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Receipt
import com.composables.icons.lucide.ShieldAlert
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.Users
import com.tribetails.auntieos.web.data.ContactOverride
import com.tribetails.auntieos.web.data.Dossier
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.HouseholdData
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.platform.launchSms
import com.tribetails.auntieos.web.platform.launchTel
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.util.householdLabel
import com.tribetails.auntieos.web.util.nowIso
import com.tribetails.auntieos.web.screens.invoices.formatMoney
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.appliesToSchemaIds
import androidx.compose.runtime.LaunchedEffect
import com.tribetails.auntieos.web.ui.components.DynamicFormFieldsReadOnly
import com.tribetails.auntieos.web.ui.components.hasDynamicFieldValues
import com.tribetails.auntieos.web.screens.communicate.SYNTHESIZE_SUCCESS

@Composable
fun KinfolkProfileScreen(
    kinfolkId: String,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onAddKin: () -> Unit,
    // B4: tapping a Kin card opens its read-only VIEW (not the edit form).
    onViewKin: (kinId: String) -> Unit,
    onOpenHousehold: () -> Unit = {},
    onOpenTale: (sessionId: String) -> Unit = {},
) {
    val client = remember { FirestoreClient() }
    val state    by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val dossier  by remember(kinfolkId) { client.dossierStream(kinfolkId) }.collectAsState(initial = FirestoreResult.Loading)
    val kinList  by remember(kinfolkId) { client.kinStream(kinfolkId) }.collectAsState(initial = FirestoreResult.Loading)
    // Profile feed sources: filtered by kinfolkId via the pure helpers below.
    val invoicesState by remember { client.invoicesStream() }.collectAsState(initial = FirestoreResult.Loading)
    val sessionsState by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val reportsState  by remember { client.reportsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val now = remember { nowIso() }

    val kinfolk = remember(state, kinfolkId) {
        (state as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinfolkId }
    }

    // Custom KINFOLK form_schemas, loaded read-only so the saved dynamic-field VALUES show on
    // the profile (not only the edit screen). Only fields that have a value render (below).
    val schemaRepo = remember { CloudFormSchemaRepository() }
    var kinfolkSchemas by remember { mutableStateOf<List<FormSchema>>(emptyList()) }
    var schemaError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        when (val list = schemaRepo.listSchemas()) {
            is WriteResult.Ok -> {
                val loaded = mutableListOf<FormSchema>()
                for (id in appliesToSchemaIds(list.value, "KINFOLK")) {
                    when (val s = schemaRepo.getSchema(id)) {
                        is WriteResult.Ok  -> loaded.add(s.value)
                        is WriteResult.Err -> schemaError = s.message
                    }
                }
                kinfolkSchemas = loaded
            }
            is WriteResult.Err -> schemaError = list.message
        }
    }

    // #14: invite this kinfolk to the kinfolk portal (mints a PRIMARY claim email
    // via the inviteKinfolkToPortal callable). Fail-loud toast on every outcome.
    val scope = rememberCoroutineScope()
    var inviteBusy by remember { mutableStateOf(false) }
    var inviteToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    fun sendPortalInvite() {
        val k = kinfolk ?: return
        if (inviteBusy) return
        inviteBusy = true
        scope.launch {
            inviteToast = when (val r = client.inviteKinfolkToPortal(kinfolkId)) {
                is WriteResult.Ok -> when (r.value.status) {
                    "sent" -> "Portal invite emailed to ${k.email}" to ToastKind.Success
                    "already_active" -> "${k.displayName} already has portal access" to ToastKind.Info
                    "no_email" -> "No email on file for ${k.displayName}" to ToastKind.Error
                    else -> "Invite: ${r.value.status}" to ToastKind.Info
                }
                is WriteResult.Err -> "Invite failed: ${r.message}" to ToastKind.Error
            }
            inviteBusy = false
        }
    }

    // Refresh intelligence: re-runs reconcile synthesis for this whole household via the
    // admin synthesize_kinfolk_profile callable, then the live dossier/411 streams re-emit.
    // In-flight guarded; fail-loud toast on every outcome.
    var refreshBusy by remember { mutableStateOf(false) }
    var refreshToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    fun doRefresh() {
        if (refreshBusy) return
        refreshBusy = true
        scope.launch {
            refreshToast = when (val r = client.synthesizeProfile(kinfolkId)) {
                is WriteResult.Ok  -> SYNTHESIZE_SUCCESS to ToastKind.Success
                is WriteResult.Err -> "Refresh failed: ${r.message}" to ToastKind.Error
            }
            refreshBusy = false
        }
    }

    ScreenScaffold {
        inviteToast?.let { (msg, kind) ->
            StatusToast(visible = true, message = msg, kind = kind, onDismiss = { inviteToast = null })
        }
        refreshToast?.let { (msg, kind) ->
            StatusToast(visible = true, message = msg, kind = kind, onDismiss = { refreshToast = null })
        }
        if (kinfolk == null) {
            SectionHeader(
                title    = "Loading…",
                subtitle = "Pulling profile from Firestore",
                icon     = Lucide.Users,
                onBack   = onBack,
                breadcrumbs = listOf("Directory", "Kinfolk"),
            )
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 72.dp) }
            }
            return@ScreenScaffold
        }

        SectionHeader(
            title    = kinfolk.displayName,
            subtitle = subtitle(kinfolk),
            icon     = Lucide.Users,
            onBack   = onBack,
            breadcrumbs = listOf("Directory", "Kinfolk"),
        )

        // ---- Hero: avatar, identity, tenure + status tags, quick actions ----
        ProfileHero(
            kinfolk  = kinfolk,
            onEdit   = onEdit,
            onAddKin = onAddKin,
            onOpenHousehold = onOpenHousehold,
        )
        Spacer(Modifier.height(18.dp))

        // ---- Active contact override banner (Phase 4 read-side) ----
        kinfolk.contactOverride?.let { override ->
            if (override.channel.isNotBlank()) {
                ContactOverrideBanner(override)
                Spacer(Modifier.height(18.dp))
            }
        }

        // #14: two columns on wide screens so the panels stop spanning full width with
        // empty space (operator: "boring, too many gaps"). One column on narrow.
        val leftCol: @Composable () -> Unit = {
            // ---- Identity & contact ----
            Panel(
                title = "Contact",
                icon = Lucide.Phone,
                tone = AuntieStatusTone.Teal,
                trailing = {
                    GhostButton(
                        label = if (inviteBusy) "Sending" else "Invite to portal",
                        enabled = !inviteBusy && kinfolk.email.isNotBlank(),
                        onClick = { sendPortalInvite() },
                    )
                },
            ) {
                FactRow(label = "Phone",           value = kinfolk.phoneNumber, mono = true)
                FactRow(label = "Secondary phone", value = kinfolk.secondaryPhone, mono = true)
                FactRow(label = "Email",           value = kinfolk.email)
                FactRow(label = "Secondary email", value = kinfolk.secondaryEmail, last = true)
                // K2: "Preferred contact method" removed from the profile per operator —
                // unusable now that kinfolk set their own notification prefs. Model field kept.
            }
            Spacer(Modifier.height(18.dp))
            // ---- Home & access ----
            Panel(title = "Home & access", icon = Lucide.MapPin, tone = AuntieStatusTone.Teal) {
                FactRow(label = "Service address", value = kinfolk.serviceAddress)
                FactRow(label = "Gate code",       value = kinfolk.gateCode, mono = true)
                FactRow(label = "Parking",         value = kinfolk.parkingInstructions)
                FactRow(label = "Wi-Fi",           value = wifiSummary(kinfolk))
                FactRow(label = "Entry notes",     value = kinfolk.entryNotes, last = true)
            }
            // ---- Emergency ----
            if (kinfolk.emergencyContactName.isNotBlank() ||
                kinfolk.emergencyContactPhone.isNotBlank()) {
                Spacer(Modifier.height(18.dp))
                Panel(title = "Emergency", icon = Lucide.ShieldAlert, tone = AuntieStatusTone.Orange) {
                    FactRow(label = "Name",     value = kinfolk.emergencyContactName)
                    FactRow(label = "Phone",    value = kinfolk.emergencyContactPhone, mono = true)
                    FactRow(label = "Relation", value = kinfolk.emergencyContactRelation, last = true)
                }
            }
            // ---- Vet Clinic (household-level) ----
            if (kinfolk.vetClinicName.isNotBlank() ||
                kinfolk.vetClinicPhone.isNotBlank() ||
                kinfolk.vetClinicAddress.isNotBlank()) {
                Spacer(Modifier.height(18.dp))
                Panel(title = "Vet Clinic", icon = Lucide.HousePlus, tone = AuntieStatusTone.Teal) {
                    FactRow(label = "Clinic",  value = kinfolk.vetClinicName)
                    FactRow(label = "Phone",   value = kinfolk.vetClinicPhone, mono = true)
                    FactRow(label = "Address", value = kinfolk.vetClinicAddress, last = true)
                }
            }
            // ---- Notes ----
            if (kinfolk.internalNotes.isNotBlank() || kinfolk.referralSource.isNotBlank()) {
                Spacer(Modifier.height(18.dp))
                Panel(title = "Notes", icon = Lucide.NotebookPen, tone = AuntieStatusTone.Muted) {
                    FactRow(label = "Internal notes", value = kinfolk.internalNotes)
                    FactRow(label = "Referral",       value = kinfolk.referralSource, last = true)
                }
            }
            // ---- Custom fields (admin-authored KINFOLK form_schemas) ----
            if (hasDynamicFieldValues(kinfolkSchemas, kinfolk.formValues)) {
                Spacer(Modifier.height(18.dp))
                Panel(title = "Additional info", icon = Lucide.FileText, tone = AuntieStatusTone.Muted) {
                    DynamicFormFieldsReadOnly(kinfolkSchemas, kinfolk.formValues) { label, value ->
                        FactRow(label = label, value = value)
                    }
                }
            } else if (schemaError != null && kinfolk.formValues.isNotEmpty()) {
                // Fail loud: saved custom values exist but their labels could not be loaded.
                Spacer(Modifier.height(18.dp))
                Panel(title = "Additional info", icon = Lucide.FileText, tone = AuntieStatusTone.Orange) {
                    Text(
                        "Couldn't load the custom field labels. $schemaError",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.error,
                    )
                }
            }
            Spacer(Modifier.height(18.dp))
            // ---- Kin list ----
            Panel(
                title = "Kin",
                icon = Lucide.PawPrint,
                tone = AuntieStatusTone.Teal,
                count = (kinList as? FirestoreResult.Data)?.value
                    ?.count { it.status != "archived" }
                    ?.let { "$it pets" },
                trailing = {
                    PrimaryButton(
                        label = "Add Kin",
                        onClick = onAddKin,
                        leading = {
                            AuntieIconTile(
                                icon = Lucide.Plus,
                                tone = AuntieStatusTone.Orange,
                                size = 18.dp,
                            )
                        },
                    )
                },
            ) {
                when (val ks = kinList) {
                    FirestoreResult.Loading ->
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            repeat(2) { ShimmerCard(height = 72.dp) }
                        }
                    is FirestoreResult.Error -> EmptyKin("Couldn't load kin: ${ks.message}")
                    is FirestoreResult.Data  -> {
                        val active = ks.value.filter { it.status != "archived" }
                        if (active.isEmpty()) {
                            EmptyKin("No kin on file yet for ${kinfolk.firstName.ifBlank { "this household" }}.")
                        } else {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                active.forEachIndexed { idx, kin ->
                                    KinRow(
                                        kin = kin,
                                        showDivider = idx < active.lastIndex,
                                        onClick = { onViewKin(kin._id) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
            // ---- Internal notes (Auntie's admin-only notes) ----
            if (kinfolk.internalNotes.isNotBlank()) {
                Spacer(Modifier.height(18.dp))
                Panel(title = "Auntie's notes", icon = Lucide.NotebookPen, tone = AuntieStatusTone.Purple, count = "admin only") {
                    AuntieNoteCallout(text = kinfolk.internalNotes)
                }
            }
        }

        // Recent KinTales / Upcoming visits / Invoices for this kinfolk: real joins over
        // reportsStream / sessionsStream / invoicesStream (filtered by kinfolkId via
        // KinfolkProfileFeeds.kt). Fail-loud per result state; no fabricated rows.
        val rightCol: @Composable () -> Unit = {
            // ---- Dossier (reconcile-managed narrative) ----
            Panel(
                title = "Dossier",
                icon = Lucide.NotebookPen,
                tone = AuntieStatusTone.Purple,
                trailing = {
                    GhostButton(
                        label = if (refreshBusy) "Refreshing…" else "Refresh intelligence",
                        enabled = !refreshBusy,
                        onClick = { doRefresh() },
                    )
                },
            ) {
                Text(
                    "Rebuilds this household's dossier and every pet's 411 from recent messages, calls, and notes.",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textDim,
                )
                DossierBody(dossier)
            }

            // K3: the household-notes migration box (incl. the "Clear from dossier"
            // action) moved to the kin EDIT screen per operator. Removed from the profile.

            Spacer(Modifier.height(18.dp))
            Panel(title = "Recent KinTales", icon = Lucide.FileText, tone = AuntieStatusTone.Orange) {
                FeedState(reportsState) { all ->
                    val tales = recentTalesFor(all, kinfolkId)
                    if (tales.isEmpty()) {
                        EmptyKin("No KinTales sent to this kinfolk yet.")
                    } else {
                        tales.forEachIndexed { i, r ->
                            AuntieKeyValueRow(
                                label = r.title.ifBlank { r.serviceType.ifBlank { "KinTale" } },
                                value = (r.sentAt.ifBlank { r.visitDate }).take(10).ifBlank { null },
                                // K1: open the tale. sessionId routes to KinTaleReportScreen.
                                onValueClick = r.sessionId.takeIf { it.isNotBlank() }?.let { sid -> { onOpenTale(sid) } },
                                showDivider = i != tales.lastIndex,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
            Panel(title = "Upcoming visits", icon = Lucide.Calendar, tone = AuntieStatusTone.Teal) {
                FeedState(sessionsState) { all ->
                    val ups = upcomingVisitsFor(all, kinfolkId, now)
                    if (ups.isEmpty()) {
                        EmptyKin("No upcoming visits scheduled.")
                    } else {
                        ups.forEachIndexed { i, s ->
                            AuntieKeyValueRow(
                                label = s.serviceType.ifBlank { "Visit" },
                                value = s.startTime.take(16).replace('T', ' ').ifBlank { null },
                                showDivider = i != ups.lastIndex,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
            Panel(title = "Invoices", icon = Lucide.Receipt, tone = AuntieStatusTone.Orange) {
                FeedState(invoicesState) { all ->
                    val invs = invoicesForKinfolk(all, kinfolkId)
                    if (invs.isEmpty()) {
                        EmptyKin("No invoices for this kinfolk yet.")
                    } else {
                        invs.forEachIndexed { i, inv ->
                            AuntieKeyValueRow(
                                label = inv.invoiceNumber.ifBlank { "Invoice" } +
                                    (if (inv.date.isNotBlank()) " · ${inv.date.take(10)}" else ""),
                                value = formatMoney(if (inv.amountDue > 0) inv.amountDue else inv.total),
                                valueMono = true,
                                showDivider = i != invs.lastIndex,
                            )
                        }
                    }
                }
            }
        }

        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            if (maxWidth >= 900.dp) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    Column(modifier = Modifier.weight(1f)) { leftCol() }
                    Column(modifier = Modifier.weight(1.1f)) { rightCol() }
                }
            } else {
                Column(modifier = Modifier.fillMaxWidth()) {
                    leftCol()
                    Spacer(Modifier.height(18.dp))
                    rightCol()
                }
            }
        }
    }
}

private fun subtitle(k: Kinfolk): String {
    // K2: preferred-contact-method dropped from the subtitle per operator.
    val parts = listOfNotNull(
        k.serviceAddress.takeIf { it.isNotBlank() },
    )
    return parts.joinToString(" · ").ifBlank { "Kinfolk profile" }
}

private fun wifiSummary(k: Kinfolk): String {
    if (k.wifiName.isBlank() && k.wifiPassword.isBlank()) return ""
    val name = k.wifiName.ifBlank { "(unnamed)" }
    val pass = if (k.wifiPassword.isNotBlank()) " · password on file" else ""
    return "$name$pass"
}

/** Initials for the hero avatar, derived from the real name fields. */
private fun initialsFor(k: Kinfolk): String {
    val f = k.firstName.trim().firstOrNull()?.uppercaseChar()
    val l = k.lastName.trim().firstOrNull()?.uppercaseChar()
    return listOfNotNull(f, l).joinToString("").ifBlank { "?" }
}

/** Hero subtitle: "the {lastName}s · {address} · kinfolk since {joinDate}". */
private fun heroWhere(k: Kinfolk): String {
    val household = k.lastName.takeIf { it.isNotBlank() }?.let { householdLabel(it) }
    val since = k.joinDate.takeIf { it.isNotBlank() }?.let { "kinfolk since $it" }
    return listOfNotNull(household, k.serviceAddress.takeIf { it.isNotBlank() }, since)
        .joinToString(" · ")
}

@Composable
private fun ProfileHero(
    kinfolk: Kinfolk,
    onEdit: () -> Unit,
    onAddKin: () -> Unit,
    onOpenHousehold: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(
                Brush.linearGradient(listOf(c.surface2, c.surfaceGlass)),
            )
            .border(dims.borderHairline, c.border, RoundedCornerShape(24.dp))
            .padding(dims.space6),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space5),
        ) {
            AuntieAvatar(
                imageUrl = kinfolk.profilePictureUrl.takeIf { it.isNotBlank() },
                initials = initialsFor(kinfolk),
                size = 84.dp,
                shape = RoundedCornerShape(24.dp),
                gradientSeed = kinfolk._id.ifBlank { kinfolk.displayName },
            )

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                Text(
                    text = kinfolk.displayName,
                    style = AuntieTheme.typography.displayMedium,
                    color = c.textPrimary,
                )
                val where = heroWhere(kinfolk)
                if (where.isNotBlank()) {
                    Text(where, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
                Row(
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val statusTone = when (kinfolk.status.lowercase()) {
                        "active"   -> AuntieChipTone.Teal
                        "archived" -> AuntieChipTone.Neutral
                        else       -> AuntieChipTone.Orange
                    }
                    AuntieChip(
                        label = kinfolk.status.ifBlank { "active" }.replaceFirstChar { it.uppercase() },
                        tone = statusTone,
                        mono = true,
                    )
                    // Tenure chip only when we actually have a join date to read from.
                    kinfolk.joinDate.takeIf { it.isNotBlank() }?.let { join ->
                        AuntieChip(
                            label = "since $join",
                            tone = AuntieChipTone.Purple,
                            mono = true,
                        )
                    }
                    kinfolk.tags.forEach { tag ->
                        if (tag.isNotBlank()) {
                            AuntieChip(label = tag, tone = AuntieChipTone.Neutral, mono = true)
                        }
                    }
                }
            }

            // Quick actions. Phone / Text mirror the hero's call + text affordances;
            // Edit + Household stay wired to the existing navigation callbacks.
            Row(horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
                if (kinfolk.phoneNumber.isNotBlank()) {
                    AuntieIconButton(
                        icon = Lucide.PhoneCall,
                        contentDescription = "Call",
                        onClick = { launchTel(kinfolk.phoneNumber) },
                        size = 46.dp,
                    )
                    AuntieIconButton(
                        icon = Lucide.MessageCircle,
                        contentDescription = "Text",
                        onClick = { launchSms(kinfolk.phoneNumber) },
                        size = 46.dp,
                    )
                }
                AuntieIconButton(
                    icon = Lucide.HousePlus,
                    contentDescription = "Household",
                    onClick = onOpenHousehold,
                    size = 46.dp,
                )
                PrimaryButton(
                    label = "Edit",
                    onClick = onEdit,
                )
            }
        }
    }
}

/**
 * Den panel: a glass card with a tone-tinted icon tile header, optional [count]
 * caption and optional [trailing] action, then caller content. Mirrors the
 * mockup ".panel > h3" treatment.
 */
@Composable
private fun Panel(
    title: String,
    icon: ImageVector,
    tone: AuntieStatusTone,
    count: String? = null,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(Brush.linearGradient(listOf(c.surface2, c.surfaceGlass)))
            .border(dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .padding(dims.space5),
        verticalArrangement = Arrangement.spacedBy(dims.space4),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            AuntieIconTile(icon = icon, tone = tone, size = 32.dp)
            Text(title, style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
            if (count != null) {
                Text(count, style = AuntieTheme.typography.mono, color = c.textDim)
            }
            Box(modifier = Modifier.weight(1f))
            trailing?.invoke()
        }
        content()
    }
}

@Composable
private fun FactRow(label: String, value: String, mono: Boolean = false, last: Boolean = false) {
    if (value.isBlank()) return
    AuntieKeyValueRow(
        label = label,
        value = value,
        valueMono = mono,
        showDivider = !last,
    )
}

@Composable
private fun ContactOverrideBanner(override: ContactOverride) {
    val c = AuntieTheme.colors
    AuntieBanner(
        tone = AuntieBannerTone.Warning,
        icon = Lucide.AlarmClock,
        title = "Reach via ${override.channel} for now",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val window = listOfNotNull(
                override.effectiveFrom.takeIf { it.isNotBlank() },
                override.effectiveUntil.takeIf { it.isNotBlank() },
            ).joinToString(" → ")
            if (window.isNotBlank()) {
                Text(window, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            if (override.note.isNotBlank()) {
                Text(override.note, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            }
            // K2: the "default channel is <preferred>" line removed — operator wants
            // preferred-contact-method gone everywhere, not just the static row.
        }
    }
}

/**
 * D1: strip inline [[source: <channel> on YYYY-MM-DD]] citations from dossier prose
 * at render time (Firestore data is untouched). The operator finds the dated
 * citations too long; this removes the citation plus its leading space, then tidies
 * any double spaces and space-before-punctuation left behind.
 */
internal fun stripDossierSources(text: String): String =
    text
        .replace(Regex("""\s*\[\[source:[^\]]*]]"""), "")
        .replace(Regex("""[ \t]{2,}"""), " ")
        .replace(Regex("""\s+([.,;:!?])"""), "$1")
        .trim()

@Composable
private fun DossierBody(dossier: FirestoreResult<Dossier?>) {
    val c = AuntieTheme.colors
    when (dossier) {
        FirestoreResult.Loading      -> ShimmerCard(height = 60.dp)
        is FirestoreResult.Error     -> Text(
            "Couldn't load dossier: ${dossier.message}",
            style = AuntieTheme.typography.bodySmall,
            color = c.error,
        )
        is FirestoreResult.Data       -> {
            val d = dossier.value
            if (d == null || d.needsMoreSamples) {
                NeedsMoreSamplesBanner(
                    "Not enough comms history yet to summarize this kinfolk. Send/receive a few more messages.",
                )
            } else if (d.rawSummary.isBlank()) {
                Text(
                    text = "No dossier prose yet. Once the comms reconcile pipeline starts merging messages, the warm narrative builds up here.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
            } else {
                AuntieNoteCallout(text = stripDossierSources(d.rawSummary), dashed = false, italic = false)
                if (d.lastReconciledAt.isNotBlank()) {
                    Text(
                        "Last enriched ${d.lastReconciledAt.take(10)}",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textFaint,
                    )
                }
            }
        }
    }
}

/**
 * Admin-only box for migrating the free-text `dossier.householdNotes` blob into the
 * structured HouseholdData collection. Shows the blob read-only, a list of structured
 * fields still empty (from [missingHouseholdFields]), a jump to the household editor,
 * and a fail-loud "Clear from dossier" action. Caller only renders this when [notes]
 * is non-blank; the box auto-hides after a clear because the dossier stream re-emits "".
 */
@Composable
// K3: internal + nullable onOpenHousehold so the kin EDIT screen can render this
// (the clear-from-dossier action moved there per operator). On the edit screen there
// is no household-data nav, so onOpenHousehold is null and that button is hidden.
internal fun HouseholdNotesMigrationBox(
    notes: String,
    household: HouseholdData?,
    onClear: suspend () -> WriteResult<Unit>,
    scope: CoroutineScope,
    onOpenHousehold: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    var clearBusy by remember { mutableStateOf(false) }
    var clearToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }

    Panel(title = "Household notes (from dossier)", icon = Lucide.NotebookPen, tone = AuntieStatusTone.Orange) {
        Text("Admin only / internal", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Text(notes, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)

        val gaps = household?.let { missingHouseholdFields(it) }.orEmpty()
        when {
            household == null ->
                Text("Loading household data…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            gaps.isNotEmpty() -> {
                Text(
                    "Still missing in Household Data (${gaps.size}):",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                Text(
                    gaps.joinToString(", ") { it.label },
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
                onOpenHousehold?.let { GhostButton(label = "Open household data", onClick = it) }
            }
            else ->
                Text(
                    "Every household field is filled. Safe to clear this from the dossier.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
        }

        GhostButton(
            label = if (clearBusy) "Clearing" else "Clear from dossier",
            enabled = !clearBusy,
            onClick = {
                clearBusy = true
                scope.launch {
                    clearToast = when (val r = onClear()) {
                        is WriteResult.Ok  -> "Cleared the household notes from the dossier." to ToastKind.Success
                        is WriteResult.Err -> "Clear failed: ${r.message}" to ToastKind.Error
                    }
                    clearBusy = false
                    // dossierStream is live, so the box hides itself once householdNotes clears.
                }
            },
        )
    }
    clearToast?.let { (msg, kind) ->
        StatusToast(visible = true, message = msg, kind = kind, onDismiss = { clearToast = null })
    }
}

@Composable
private fun KinRow(kin: Kin, showDivider: Boolean, onClick: () -> Unit) {
    val client = remember { FirestoreClient() }
    val info   by remember(kin._id) { client.kin411Stream(kin._id) }.collectAsState(initial = FirestoreResult.Loading)
    val c = AuntieTheme.colors

    val sub = listOf(kin.species, kin.breed, kin.sex, kin.age.takeIf { it.isNotBlank() })
        .filterNot { it.isNullOrBlank() }
        .joinToString(" · ")

    // Append the warm 411 snippet (or a needs-more-samples hint) to the subtitle so
    // the row mirrors the mockup's "loves sticks, hates the mailman" descriptor line.
    val resolvedInfo = info
    val kin411Data = (resolvedInfo as? FirestoreResult.Data)?.value
    val snippet: String? = when {
        resolvedInfo is FirestoreResult.Data && (kin411Data == null || kin411Data.needsMoreSamples) ->
            "Not enough notes about ${kin.name.ifBlank { "this kin" }} yet."
        resolvedInfo is FirestoreResult.Data -> {
            val d = resolvedInfo.value
            d?.rawSummary?.takeIf { it.isNotBlank() }
                ?: listOf(d?.personality, d?.medicalNotes, d?.dietaryDetails)
                    .firstOrNull { !it.isNullOrBlank() }
        }
        else -> null
    }

    val subtitle = listOfNotNull(
        sub.takeIf { it.isNotBlank() },
        snippet?.takeIf { it.isNotBlank() },
    ).joinToString(" · ").ifBlank { null }

    AuntieEntityRow(
        title = kin.name.ifBlank { "Unnamed" },
        subtitle = subtitle,
        showDivider = showDivider,
        onClick = onClick,
        leading = {
            AuntieAvatar(
                imageUrl = null,
                glyph = Lucide.PawPrint,
                size = 52.dp,
                gradientSeed = kin._id.ifBlank { kin.name },
            )
        },
        trailing = {
            AuntieIconButton(
                icon = Lucide.ChevronRight,
                contentDescription = "Open kin",
                onClick = onClick,
                size = 32.dp,
            )
        },
    )
}

@Composable
private fun NeedsMoreSamplesBanner(message: String) {
    AuntieBanner(
        tone = AuntieBannerTone.Warning,
        icon = Lucide.TriangleAlert,
        dashed = true,
    ) {
        Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
    }
}

/**
 * Renders a profile feed panel body from a stream result, fail-loud per state:
 * Loading -> shimmer, Error -> visible banner, Data -> caller content.
 */
@Composable
private fun <T> FeedState(
    state: FirestoreResult<List<T>>,
    content: @Composable (List<T>) -> Unit,
) {
    when (state) {
        is FirestoreResult.Loading -> ShimmerCard(height = 64.dp)
        is FirestoreResult.Error -> AuntieBanner(
            tone = AuntieBannerTone.Warning,
            icon = Lucide.TriangleAlert,
        ) {
            Text(
                "Couldn't load: ${state.message}",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textPrimary,
            )
        }
        is FirestoreResult.Data -> content(state.value)
    }
}

@Composable
private fun EmptyKin(message: String) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(message, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
    }
}
