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
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import com.tribetails.auntieos.data.model.ContactOverride
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.FormSchema
// Tags (2026-07-19): the vocabulary lives on business_settings, so the scope ->
// field mapping is shared with the Den's Tags editor rather than duplicated.
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.UPCOMING_HORIZON_DAYS
import com.tribetails.auntieos.domain.feedCountMeta
import com.tribetails.auntieos.domain.freeTextDateLabel
import com.tribetails.auntieos.domain.kinfolkInvoiceFeedLabel
import com.tribetails.auntieos.domain.tenureLabel
import com.tribetails.auntieos.ui.admin.settingsWithTagVocab
import com.tribetails.auntieos.ui.admin.tagVocabFor
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.util.formatJoinDate
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
    /** B1: (kinfolkId, kinfolkName) -> the members and invites screen. */
    onNavigateToMembers: (String, String) -> Unit = { _, _ -> },
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
                item { ContactInfoCard(kinfolk, state.householdVet) }
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
                // Household tags: the managed vocabulary, replacing the comma-joined
                // string this profile used to show. Each add and remove saves on the
                // spot; a failed save reverts the chip AND says so.
                item {
                    key(kinfolk.id) {
                        val tagRepository = remember { AuntieOSApp.instance.repository }
                        ProfileTagsSection(
                            scope = TagScope.HOUSEHOLD,
                            initialTags = kinfolk.tagNames(),
                            // TAGS ONLY. This used to write the whole loaded
                            // `Kinfolk` back under merge(), so adding one chip
                            // reverted every other field to whatever this
                            // profile happened to have read - the bug
                            // `DirectoryFieldChanges.kt` documents. React's
                            // `updateKinfolkTags` writes exactly this one field
                            // for exactly this reason.
                            onSaveTags = { next ->
                                tagRepository.updateKinfolkFields(
                                    kinfolk.id,
                                    mapOf("tags" to kinfolkWithTags(kinfolk, next).tagNames()),
                                ).getOrThrow()
                            },
                            loadVocab = { loadTagVocab(tagRepository, TagScope.HOUSEHOLD) },
                            onSaveVocab = { defs ->
                                saveTagVocab(tagRepository, TagScope.HOUSEHOLD, defs)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
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
                // B1: the members-and-invites surface for THIS household. It sits
                // next to "Invite to portal" because the two are the same job at
                // different stages: that button gets the household in, this
                // screen manages who else is in and what each of them may do.
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GhostButton(
                            label = "Members and invites",
                            onClick = { onNavigateToMembers(kinfolk.id, kinfolk.displayName) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Who else can reach this household in MyTribe, what each of them may " +
                                "do, and every invite it has been sent.",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
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
                        // The count sits BESIDE the section name, not inside it,
                        // the same shape the React admin's DenPanel meta slot
                        // gives this panel. Absent while the read is in flight:
                        // "0 kin" on a load that has not landed is a claim.
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("KIN (PETS)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                            if (!state.isLoading) {
                                Text(
                                    if (state.kinList.size == 1) "1 kin" else "${state.kinList.size} kin",
                                    style = AuntieTheme.typography.labelSmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }
                        }
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
                        meta = feedCountMeta(state.recentTales.size, state.sentTaleCount, capped = false),
                        emptyMsg = "No KinTales sent to this kinfolk yet.",
                        lines = state.recentTales.map { r ->
                            (r.title.ifBlank { r.serviceType.ifBlank { "KinTale" } }) to
                                (r.sentAt.orEmpty().ifBlank { r.visitDate }).take(10)
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
                        // The window has a far edge now (the mock's own header),
                        // so the card says what it is rather than implying it
                        // shows everything ahead.
                        meta = "next $UPCOMING_HORIZON_DAYS days",
                        emptyMsg = "No visits booked in the next $UPCOMING_HORIZON_DAYS days.",
                        lines = state.upcomingVisits.map { s ->
                            (s.serviceType.ifBlank { "Visit" }) to s.startTime.take(16).replace('T', ' ')
                        },
                    )
                }
                item {
                    ProfileFeedSection(
                        title = "INVOICES",
                        meta = feedCountMeta(state.kinfolkInvoices.size, state.invoiceCount, capped = false),
                        emptyMsg = "No invoices for this kinfolk yet.",
                        lines = state.kinfolkInvoices.map { inv ->
                            // `invoices.date` is free text (PR #241 confirmed it in
                            // production). The label is built in the domain so what
                            // it does with that string is testable.
                            kinfolkInvoiceFeedLabel(inv) to
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
    /** The mock's `.ct`: a count or a window, beside the title and never inside it. */
    meta: String? = null,
    lines: List<Pair<String, String>>,
    // K1 (A8): when set, each row is tappable — index maps back to the source list so the
    // caller can open the underlying record (e.g. a recent KinTale's report).
    onRowClick: ((Int) -> Unit)? = null,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
            if (meta != null) {
                Text(meta, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
            }
        }
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

        // WHEN THEY JOINED, spelled for the operator rather than left as stored.
        // `freeTextDateLabel` formats what it can read and prints the rest exactly
        // as stored, so a legacy free-text join date never renders as an error and
        // never becomes a different date.
        val joined = freeTextDateLabel(kinfolk.joinDate)
        if (joined.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Joined $joined",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
        val statusColor = if (kinfolk.status == "active") AuntieTheme.colors.success else AuntieTheme.colors.textDim
        // The mock's two hero chips: the status, and how long they have been a
        // client. The tenure chip is ABSENT when the stored join date is not one
        // anybody can read, rather than a fabricated "0 months". Same rule, same
        // branches, as the React admin's hero.
        val tenure = tenureLabel(kinfolk.joinDate, java.time.LocalDate.now())
        Row(
            modifier = Modifier.padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(statusColor.copy(alpha = 0.15f))
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Text(kinfolk.status.uppercase(), style = AuntieTheme.typography.labelSmall, color = statusColor)
            }
            if (tenure != null) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(AuntieTheme.colors.familyPurple.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        tenure.uppercase(),
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.familyPurple,
                    )
                }
            }
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
private fun ContactInfoCard(kinfolk: Kinfolk, householdVet: HouseholdVet) {
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

            // The household vet is DISPLAYED here and authored on Household Data
            // (operator ruling 2026-08-01). It used to read kinfolk.vetClinic*,
            // the copy that made the vet authored in two places at once.
            val vet = listOf(householdVet.primary.name, householdVet.primary.phone, householdVet.primary.address)
                .filter { it.isNotBlank() }.joinToString(" · ")
            ProfileField("Veterinarian (household)", vet.ifBlank { "No household vet on file yet" })
            val erVet = listOf(householdVet.emergency.name, householdVet.emergency.phone, householdVet.emergency.address)
                .filter { it.isNotBlank() }.joinToString(" · ")
            // The emergency clinic is a DISTINCT practice, never folded into the
            // line above: "who to call" and "who to call at 2am" differ.
            if (erVet.isNotBlank()) ProfileField("Emergency vet (household)", erVet)

            if (kinfolk.outstandingBalance != "0.00" && kinfolk.outstandingBalance.isNotBlank()) {
                ProfileField("Outstanding Balance", "$${kinfolk.outstandingBalance}")
            }

            // Tags moved OUT of this card and onto their own panel below: they are
            // now a managed vocabulary with colors, icons, and inline editing, not
            // a comma-joined string squeezed into a read-only row.
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
            // Read in the operator's locale. A legacy value formatJoinDate cannot
            // read prints exactly as stored rather than as "Invalid Date".
            ProfileField("Join Date", formatJoinDate(kinfolk.joinDate))
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

// ─────────────────────────────────────────────────────────────────────────────
// Tags wiring (2026-07-19 Tags port)
//
// The directory screens hand ProfileTagsSection plain suspend lambdas rather
// than a repository, so the panel itself stays Firebase-free. These are the
// three the household and pet panels share. They live here because the profile
// and both edit screens sit in this package and would otherwise each grow their
// own copy.
//
// Every one throws on failure. ProfileTagsSection turns a throw into a revert
// plus a visible banner, so swallowing here would silently tell the operator a
// tag saved when it never left the device.
// ─────────────────────────────────────────────────────────────────────────────

/** Read a scope's vocabulary off `business_settings` for autocomplete + chip resolution. */
internal suspend fun loadTagVocab(
    repository: AuntieRepository,
    scope: TagScope,
): List<TagDef> = tagVocabFor(repository.getBusinessSettings().getOrThrow(), scope)

/**
 * Persist a vocabulary grown by an inline promotion on a profile.
 *
 * React patches the single key it changed, and now so does this: the re-read is
 * the baseline, and only the fields that differ from it go out. The re-read used
 * to be the whole defence - android sent the entire settings object, so a
 * household promotion carried a stale copy of the pet list, the calendar id and
 * the payment handles along with it, and a fresh read only narrowed that window.
 * With the diff one vocabulary key is written and the window closes: no tag
 * promotion can revert anything else on the document, whatever landed between
 * the read and the write.
 *
 * An unchanged vocabulary writes nothing rather than moving the stamp.
 *
 * Fail-loud is unchanged: `ProfileTagsSection` turns a throw into a reverted chip
 * plus a visible banner, so a swallowed failure would tell the operator a tag
 * saved when it never left the device.
 */
internal suspend fun saveTagVocab(
    repository: AuntieRepository,
    scope: TagScope,
    defs: List<TagDef>,
) {
    val current = repository.getBusinessSettings().getOrThrow()
    val changes = businessSettingsFieldChanges(current, settingsWithTagVocab(current, scope, defs))
    if (changes.isEmpty()) return
    repository.updateBusinessSettingsFields(changes).getOrThrow()
}

/**
 * The kinfolk to write when its tag assignments change.
 *
 * Android saves the WHOLE object, so the copy has to start from the loaded doc
 * or every field the form did not touch is wiped. An empty list is a real value
 * here: taking the last tag off has to clear the field, not leave the old one.
 * Pure; tested.
 */
internal fun kinfolkWithTags(kinfolk: Kinfolk, tags: List<String>): Kinfolk =
    kinfolk.copy(tags = tags)
