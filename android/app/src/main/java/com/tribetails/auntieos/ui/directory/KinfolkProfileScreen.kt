package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.ContactOverride
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun KinfolkProfileScreen(
    viewModel: DirectoryViewModel,
    kinfolkId: String,
    onBack: () -> Unit,
    onEdit: (String) -> Unit,
    onAddKin: (String, String) -> Unit,
    onEditKin: (String) -> Unit = {},
    onNavigateToHouseholdData: (String, String) -> Unit = { _, _ -> },
    onNavigateToMediaGallery: (String, String) -> Unit = { _, _ -> },
    onOpenReport: (sessionId: String) -> Unit = {},
) {
    val state by viewModel.profileState.collectAsState()
    // #14: portal invite state + Toast feedback on each outcome.
    val inviteBusy by viewModel.inviteBusy.collectAsState()
    val inviteMessage by viewModel.inviteMessage.collectAsState()
    // Phase 2: dossier household-notes clear feedback (success + fail-loud).
    val clearMessage by viewModel.clearMessage.collectAsState()
    // Phase 3: refresh-intelligence (synthesize) state + feedback.
    val isSynthesizing by viewModel.isSynthesizing.collectAsState()
    val synthesizeMessage by viewModel.synthesizeMessage.collectAsState()
    val profileContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(inviteMessage) {
        inviteMessage?.let {
            android.widget.Toast.makeText(profileContext, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.clearInviteMessage()
        }
    }
    LaunchedEffect(clearMessage) {
        clearMessage?.let {
            android.widget.Toast.makeText(profileContext, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.clearClearMessage()
        }
    }
    LaunchedEffect(synthesizeMessage) {
        synthesizeMessage?.let {
            android.widget.Toast.makeText(profileContext, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.clearSynthesizeMessage()
        }
    }

    LaunchedEffect(kinfolkId) {
        viewModel.loadProfile(kinfolkId)
    }

    AuntieScreenScaffold(
        title = state.kinfolk?.displayName ?: "Profile",
        onBack = {
            viewModel.clearProfile()
            onBack()
        },
        actions = if (state.kinfolk != null) ({
            AuntieIconBtn(onClick = { onEdit(state.kinfolk!!.id) }) {
                Icon(Lucide.Pencil, contentDescription = "Edit Profile", tint = AuntieTheme.colors.kinfolkOrange)
            }
        }) else null,
    ) {
        if (state.isLoading) {
            com.tribetails.auntieos.ui.components.LoadingScreen(
                message  = "Loading profile...",
                modifier = Modifier.fillMaxSize()
            )
        } else if (state.error != null || state.kinfolk == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(state.error ?: "Profile not found", color = AuntieTheme.colors.error)
            }
        } else {
            val kinfolk = state.kinfolk!!
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = PaddingValues(bottom = 80.dp)
            ) {
                item { ProfileHeader(kinfolk) }
                kinfolk.contactOverride?.takeIf { it.channel.isNotBlank() }?.let { override ->
                    item { ContactOverrideBanner(override, kinfolk.preferredContactMethod) }
                }
                item { QuickContactBar(kinfolk) }
                item { ContactInfoCard(kinfolk) }
                if (hasDynamicFieldValues(state.kinfolkSchemas, kinfolk.formValues)) {
                    item { AdditionalInfoCard(state.kinfolkSchemas, kinfolk.formValues) }
                } else if (state.schemaError != null && kinfolk.formValues.isNotEmpty()) {
                    // Fail loud: saved custom values exist but their labels couldn't load.
                    item {
                        AuntieCard(modifier = Modifier.fillMaxWidth()) {
                            Column(
                                modifier = Modifier.padding(16.dp).fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Text("ADDITIONAL INFO", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                                Text(
                                    "Couldn't load the custom field labels. ${state.schemaError}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.error,
                                )
                            }
                        }
                    }
                }
                item {
                    PrimaryButton(
                        label   = if (inviteBusy) "Sending…" else "Invite to portal",
                        onClick = { viewModel.inviteKinfolkToPortal(kinfolk.id, kinfolk.displayName) },
                        enabled = !inviteBusy && kinfolk.email.isNotBlank(),
                        loading = inviteBusy,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                // Phase 3: rebuild this household's dossier + every pet's 411 from
                // recent history via the synthesize callable. In-flight guarded; the
                // result toasts (success or fail-loud).
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GhostButton(
                            label = if (isSynthesizing) "Refreshing…" else "Refresh intelligence",
                            enabled = !isSynthesizing,
                            onClick = { viewModel.synthesizeProfile(kinfolk.id) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Rebuilds this household's dossier and every pet's 411 from recent history.",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
                item { HouseholdManagementCard(kinfolk, onNavigateToHouseholdData, onNavigateToMediaGallery) }
                item { DossierCard(kinfolk, state.dossier) }

                // K3 (A8): the household-notes migration box (a mutating "Clear from
                // dossier" action) moved OFF this read-only profile and onto the Edit
                // screen, where editing belongs. See EditKinfolkScreen.

                // Kin (Pets) Section
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("KIN (PETS)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                        PrimaryButton(
                            label   = "+ Add Kin",
                            onClick = { onAddKin(kinfolk.id, kinfolk.displayName) },
                        )
                    }
                }

                if (state.kinList.isNotEmpty()) {
                    items(state.kinList.size) { index ->
                        val kin = state.kinList[index]
                        KinDetailsCard(kin = kin, kin411 = state.kin411Map[kin.id], onEdit = onEditKin)
                    }
                } else {
                    item {
                        AuntieCard(
                            modifier = Modifier.fillMaxWidth(),
                            containerColor = AuntieTheme.colors.surface2,
                        ) {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(24.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    "No kin profiles yet. Add the pets for this kinfolk!",
                                    style = AuntieTheme.typography.bodyMedium,
                                    color = AuntieTheme.colors.textDim
                                )
                            }
                        }
                    }
                }

                // Profile feeds (parity with web): real per-kinfolk joins.
                item {
                    ProfileFeedSection(
                        title = "RECENT KINTALES",
                        emptyMsg = "No KinTales sent to this kinfolk yet.",
                        lines = state.recentTales.map { r ->
                            (r.title.ifBlank { r.serviceType.ifBlank { "KinTale" } }) to
                                (r.sentAt.ifBlank { r.visitDate }).take(10)
                        },
                        // K1 (A8): tap a recent tale to open its report.
                        onRowClick = { idx ->
                            state.recentTales.getOrNull(idx)?.sessionId
                                ?.takeIf { it.isNotBlank() }
                                ?.let { onOpenReport(it) }
                        },
                    )
                }
                item {
                    ProfileFeedSection(
                        title = "UPCOMING VISITS",
                        emptyMsg = "No upcoming visits scheduled.",
                        lines = state.upcomingVisits.map { s ->
                            (s.serviceType.ifBlank { "Visit" }) to s.startTime.take(16).replace('T', ' ')
                        },
                    )
                }
                item {
                    ProfileFeedSection(
                        title = "INVOICES",
                        emptyMsg = "No invoices for this kinfolk yet.",
                        lines = state.kinfolkInvoices.map { inv ->
                            (inv.invoiceNumber.ifBlank { "Invoice" } +
                                (if (inv.date.isNotBlank()) " · ${inv.date.take(10)}" else "")) to
                                ("$" + "%.2f".format(if (inv.amountDue > 0) inv.amountDue else inv.total))
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun ProfileFeedSection(
    title: String,
    emptyMsg: String,
    lines: List<Pair<String, String>>,
    // K1 (A8): when set, each row is tappable — index maps back to the source list so the
    // caller can open the underlying record (e.g. a recent KinTale's report).
    onRowClick: ((Int) -> Unit)? = null,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        AuntieCard(modifier = Modifier.fillMaxWidth(), containerColor = AuntieTheme.colors.surface2) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (lines.isEmpty()) {
                    Text(emptyMsg, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
                } else {
                    lines.forEachIndexed { index, (label, value) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(if (onRowClick != null) Modifier.clickable { onRowClick(index) } else Modifier),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                label,
                                style = AuntieTheme.typography.bodyMedium,
                                color = AuntieTheme.colors.textPrimary,
                                modifier = Modifier.weight(1f),
                            )
                            if (value.isNotBlank()) {
                                Text(value, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileHeader(kinfolk: Kinfolk) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(80.dp)
                .clip(CircleShape)
                .background(AuntieTheme.colors.surface2),
            contentAlignment = Alignment.Center
        ) {
            val initials = kinfolk.displayName.split(" ").mapNotNull { it.firstOrNull()?.toString() }.take(2).joinToString("").uppercase()
            Text(if (initials.isNotBlank()) initials else "?", color = AuntieTheme.colors.kinfolkOrange, style = AuntieTheme.typography.headlineLarge)
        }
        Spacer(Modifier.height(12.dp))
        Text(kinfolk.displayName, style = AuntieTheme.typography.headlineSmall, color = AuntieTheme.colors.textPrimary)

        val statusColor = if (kinfolk.status == "active") AuntieTheme.colors.success else AuntieTheme.colors.textDim
        Box(
            modifier = Modifier
                .padding(top = 8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(statusColor.copy(alpha = 0.15f))
                .padding(horizontal = 8.dp, vertical = 4.dp)
        ) {
            Text(kinfolk.status.uppercase(), style = AuntieTheme.typography.labelSmall, color = statusColor)
        }
    }
}

@Composable
private fun QuickContactBar(kinfolk: Kinfolk) {
    val context = LocalContext.current

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        QuickActionBtn(
            modifier = Modifier.weight(1f),
            icon     = { Icon(Lucide.Phone, contentDescription = null, modifier = Modifier.size(18.dp), tint = AuntieTheme.colors.kinfolkOrange) },
            label    = "Call",
            onClick  = {
                if (kinfolk.phoneNumber.isNotBlank()) {
                    context.startActivity(Intent(Intent.ACTION_DIAL).apply { data = Uri.parse("tel:${kinfolk.phoneNumber}") })
                }
            }
        )
        QuickActionBtn(
            modifier = Modifier.weight(1f),
            icon     = { Icon(Lucide.MessageCircle, contentDescription = null, modifier = Modifier.size(18.dp), tint = AuntieTheme.colors.kinfolkOrange) },
            label    = "Message",
            onClick  = {
                if (kinfolk.phoneNumber.isNotBlank()) {
                    context.startActivity(Intent(Intent.ACTION_VIEW).apply { data = Uri.parse("sms:${kinfolk.phoneNumber}") })
                }
            }
        )
        QuickActionBtn(
            modifier = Modifier.weight(1f),
            icon     = { Icon(Lucide.Mail, contentDescription = null, modifier = Modifier.size(18.dp), tint = AuntieTheme.colors.kinfolkOrange) },
            label    = "Email",
            onClick  = {
                if (kinfolk.email.isNotBlank()) {
                    context.startActivity(Intent(Intent.ACTION_SENDTO).apply { data = Uri.parse("mailto:${kinfolk.email}") })
                }
            }
        )
    }
}

@Composable
private fun QuickActionBtn(
    modifier: Modifier = Modifier,
    icon: @Composable () -> Unit,
    label: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface2)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            icon()
            Text(label, style = AuntieTheme.typography.labelMedium, color = AuntieTheme.colors.kinfolkOrange)
        }
    }
}

@Composable
private fun ContactInfoCard(kinfolk: Kinfolk) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("CONTACT & IDENTITY", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            ProfileField("Primary Phone", kinfolk.phoneNumber)
            ProfileField("Secondary Phone", kinfolk.secondaryPhone)
            ProfileField("Primary Email", kinfolk.email)
            ProfileField("Secondary Email", kinfolk.secondaryEmail)
            // K2 (A8): "Preferred Contact" read removed per operator — the value the
            // comms-reconcile pipeline set was noise on the profile. Model field kept.
            ProfileField("Service Address", kinfolk.serviceAddress)
            ProfileField("Parking Instructions", kinfolk.parkingInstructions)
            // Show emergency contact only when at least one part is filled (no "() -" noise).
            val emergency = listOfNotNull(
                kinfolk.emergencyContactName.takeIf { it.isNotBlank() },
                kinfolk.emergencyContactPhone.takeIf { it.isNotBlank() }?.let { "($it)" },
                kinfolk.emergencyContactRelation.takeIf { it.isNotBlank() }?.let { "- $it" },
            ).joinToString(" ")
            if (emergency.isNotBlank()) ProfileField("Emergency Contact", emergency)

            // Household vet: single source for all kin in this household (1D). Each Kin
            // shows this read-only; it is authored here, not per-pet.
            val vet = listOf(kinfolk.vetClinicName, kinfolk.vetClinicPhone, kinfolk.vetClinicAddress)
                .filter { it.isNotBlank() }.joinToString(" · ")
            ProfileField("Veterinarian (household)", vet.ifBlank { "No household vet on file yet" })

            if (kinfolk.outstandingBalance != "0.00" && kinfolk.outstandingBalance.isNotBlank()) {
                ProfileField("Outstanding Balance", "$${kinfolk.outstandingBalance}")
            }

            if (kinfolk.tags.isNotEmpty()) {
                ProfileField("Tags", kinfolk.tags.joinToString(", "))
            }
        }
    }
}

/** Read-only display of admin-authored KINFOLK custom field VALUES on the profile. */
@Composable
private fun AdditionalInfoCard(schemas: List<FormSchema>, values: Map<String, String>) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("ADDITIONAL INFO", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            DynamicFormFieldsReadOnly(schemas, values) { label, value ->
                ProfileField(label, value)
            }
        }
    }
}

@Composable
private fun DossierCard(
    kinfolk: Kinfolk,
    dossier: com.tribetails.auntieos.data.model.Dossier?,
) {
    if (dossier == null || dossier.needsMoreSamples) {
        NeedsMoreSamplesBanner(
            message = "Not enough comms history yet to summarize this kinfolk. Send/receive a few more messages.",
        )
    }
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("HOUSEHOLD & ADMIN", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                val reconciledAt = dossier?.lastReconciledAt.orEmpty()
                if (reconciledAt.isNotBlank()) {
                    Text(
                        "Last enriched ${reconciledAt.take(10)}",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textFaint,
                    )
                }
            }
            ProfileField("Entry Notes", kinfolk.entryNotes)
            ProfileField("Gate Code", kinfolk.gateCode)
            ProfileField("WiFi Network", "${kinfolk.wifiName} / ${kinfolk.wifiPassword}")
            ProfileField("Internal Notes", kinfolk.internalNotes)
            ProfileField("Referral Source", kinfolk.referralSource)
            ProfileField("Join Date", kinfolk.joinDate)
            if (!dossier?.rawSummary.isNullOrBlank()) {
                ProfileField("Reconciled Summary", stripDossierSources(dossier!!.rawSummary))
            }
            if (!dossier?.communicationStyle.isNullOrBlank()) {
                ProfileField("Communication Style", stripDossierSources(dossier!!.communicationStyle))
            }
        }
    }
}

/**
 * Phase 2 household-notes migration box (admin-only). Shows the free-text dossier
 * householdNotes, the structured fields still missing, and the actions to fill the
 * structured editor or clear the blob once migrated.
 */
@Composable
internal fun HouseholdNotesMigrationCard(
    notes: String,
    household: HouseholdData?,
    onOpenHouseholdData: (() -> Unit)?,
    onClearFromDossier: () -> Unit,
) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("HOUSEHOLD NOTES (FROM DOSSIER)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            Text("Admin only / internal", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
            Text(notes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)

            val gaps = household?.let { missingHouseholdFields(it) }.orEmpty()
            when {
                household == null ->
                    Text("Loading household data...", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                gaps.isNotEmpty() -> {
                    Text("Still missing in Household Data (${gaps.size}):", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                    Text(gaps.joinToString(", ") { it.label }, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                    if (onOpenHouseholdData != null) {
                        GhostButton(label = "Open household data", onClick = onOpenHouseholdData, modifier = Modifier.fillMaxWidth())
                    }
                }
                else ->
                    Text("All structured fields are filled. Safe to clear from the dossier.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
            }

            GhostButton(label = "Clear from dossier", onClick = onClearFromDossier, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun KinDetailsCard(kin: Kin, kin411: Kin411?, onEdit: (String) -> Unit = {}) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface2,
    ) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(kin.name, style = AuntieTheme.typography.titleMedium, color = AuntieTheme.colors.kinfolkOrange)
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(kin.species.uppercase(), style = AuntieTheme.typography.labelMedium, color = AuntieTheme.colors.textDim)
                    AuntieIconBtn(
                        onClick  = { onEdit(kin.id) },
                        modifier = Modifier.size(32.dp)
                    ) {
                        Icon(
                            Lucide.Pencil,
                            contentDescription = "Edit ${kin.name}",
                            tint     = AuntieTheme.colors.kinfolkOrange,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }
            }

            ProfileField("Breed", kin.breed)
            ProfileField("Age/Sex/Weight", "${kin.age} / ${kin.sex} / ${kin.weight}")

            Box(modifier = Modifier.padding(vertical = 4.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

            if (kin411 == null || kin411.needsMoreSamples) {
                NeedsMoreSamplesBanner(
                    message = "Not enough notes about ${kin.name} yet.",
                )
            }

            Text("MEDICAL & ROUTINE", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            // Vet is household-level now (single-source on the Kinfolk, shown in
            // ContactInfoCard). Removed the per-kin kin411 vet line to stop double-authoring (1D).
            ProfileField("Medical Notes", kin411?.medicalNotes.orEmpty())
            ProfileField("Feeding", listOf(kin411?.feedingAmount, kin411?.feedingFrequency).filterNotNull().filter { it.isNotBlank() }.joinToString(" / "))
            ProfileField("Potty Routine", kin411?.pottyRoutine.orEmpty())
        }
    }
}

@Composable
private fun ProfileField(label: String, value: String) {
    if (value.isBlank() || value.contains("()")) return
    Column {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        Spacer(Modifier.height(2.dp))
        Text(value, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
    }
}

/**
 * D1 (A8): the comms-reconcile pipeline embeds `[[source:msg-123]]` citation tags in
 * dossier free-text. They're internal provenance, not for the operator's eyes — strip
 * them (and the leading whitespace they trail) before render. Mirror of web
 * stripDossierSources. Pure + unit-tested in StripDossierSourcesTest.
 */
private val DOSSIER_SOURCE_TAG = Regex("""\s*\[\[source:[^]]*]]""")
fun stripDossierSources(raw: String): String =
    DOSSIER_SOURCE_TAG.replace(raw, "").trim()

@Composable
private fun HouseholdManagementCard(
    kinfolk: Kinfolk,
    onNavigateToHouseholdData: (String, String) -> Unit,
    onNavigateToMediaGallery: (String, String) -> Unit
) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("HOUSEHOLD MANAGEMENT", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.surface2)
                        .clickable { onNavigateToHouseholdData(kinfolk.id, kinfolk.displayName) }
                        .padding(horizontal = 8.dp, vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(Lucide.House, contentDescription = null, modifier = Modifier.size(20.dp), tint = AuntieTheme.colors.kinfolkOrange)
                        Text("Household", style = AuntieTheme.typography.labelMedium, color = AuntieTheme.colors.kinfolkOrange)
                    }
                }

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.surface2)
                        .clickable { onNavigateToMediaGallery(kinfolk.id, kinfolk.displayName) }
                        .padding(horizontal = 8.dp, vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(Lucide.Images, contentDescription = null, modifier = Modifier.size(20.dp), tint = AuntieTheme.colors.kinfolkOrange)
                        Text("Media", style = AuntieTheme.typography.labelMedium, color = AuntieTheme.colors.kinfolkOrange)
                    }
                }
            }

            Text(
                "Manage shared household information and view photos/videos for this family",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )
        }
    }
}

@Composable
private fun NeedsMoreSamplesBanner(message: String) {
    AuntieCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp, bottom = 2.dp),
        containerColor = AuntieTheme.colors.warning.copy(alpha = 0.12f),
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.warning.copy(alpha = 0.45f)),
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Lucide.TriangleAlert,
                contentDescription = null,
                tint = AuntieTheme.colors.warning,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = message,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textPrimary,
            )
        }
    }
}

@Composable
private fun ContactOverrideBanner(override: ContactOverride, defaultMethod: String) {
    val accent = AuntieTheme.colors.warning
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        border   = androidx.compose.foundation.BorderStroke(0.5.dp, accent.copy(alpha = 0.6f)),
        shape    = RoundedCornerShape(10.dp),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Lucide.Clock3,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = "Reach via ${override.channel} for now",
                    style = AuntieTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = accent,
                )
            }
            val window = listOfNotNull(
                override.effectiveFrom.takeIf { it.isNotBlank() },
                override.effectiveUntil.takeIf { it.isNotBlank() },
            ).joinToString(" → ")
            if (window.isNotBlank()) {
                Text(window, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
            if (override.note.isNotBlank()) {
                Text(
                    text  = override.note,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
            if (defaultMethod.isNotBlank() && !defaultMethod.equals(override.channel, ignoreCase = true)) {
                Text(
                    text  = "Default channel is $defaultMethod once this lifts.",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }
}
