package com.tribetails.auntieos.ui.directory

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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import com.tribetails.auntieos.data.model.ContactOverride
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.emergencyContactsOf
import com.tribetails.auntieos.data.model.FormSchema
// Tags (2026-07-19): the vocabulary lives on business_settings, so the scope ->
// field mapping is shared with the Den's Tags editor rather than duplicated.
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.UPCOMING_HORIZON_DAYS
import com.tribetails.auntieos.domain.feedCountMeta
import com.tribetails.auntieos.domain.freeTextDateLabel
import com.tribetails.auntieos.domain.invoiceStateOrNull
import com.tribetails.auntieos.domain.kinfolkInvoiceFeedLabel
import com.tribetails.auntieos.domain.tenureLabel
import com.tribetails.auntieos.ui.admin.settingsWithTagVocab
import com.tribetails.auntieos.ui.admin.tagVocabFor
import com.tribetails.auntieos.AuntieOSApp
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
    /** A Kin card row opens the PET (its own screen since the Kin detail build), not the editor. */
    onOpenKin: (String) -> Unit = {},
    onNavigateToHouseholdData: (String, String) -> Unit = { _, _ -> },
    onNavigateToMediaGallery: (String, String) -> Unit = { _, _ -> },
    onOpenReport: (sessionId: String) -> Unit = {},
    /** #809: a row in Upcoming KinCare opens the session it names, matching web. */
    onOpenVisit: (sessionId: String) -> Unit = {},
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

    val back = {
        viewModel.clearProfile()
        onBack()
    }

    AuntieScreenScaffold(
        title = state.kinfolk?.displayName ?: "Profile",
        onBack = back,
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
            // ONE COLUMN, in the order the web profile reads (#678/#679/#682,
            // walk admin-2026-09-10): the hero, then the household's own facts
            // (the web's left column), then who they have and what has happened
            // or is coming (the web's right column). Auntie's notes is pinned
            // last (#683, "pin to the bottom"). Every section is the kit's
            // DenPanel with the mock's serif title and its right-aligned mono
            // count; the uppercase orange kickers on plain cards this screen
            // used to draw were the pre-kit world (#755).
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = PaddingValues(bottom = 80.dp)
            ) {
                item {
                    ProfileHero(
                        kinfolk = kinfolk,
                        onDirectory = back,
                        onEdit = { onEdit(kinfolk.id) },
                        onHouseholdData = { onNavigateToHouseholdData(kinfolk.id, kinfolk.displayName) },
                        onMembers = { onNavigateToMembers(kinfolk.id, kinfolk.displayName) },
                        onMedia = { onNavigateToMediaGallery(kinfolk.id, kinfolk.displayName) },
                    )
                }
                kinfolk.contactOverride?.takeIf { it.channel.isNotBlank() }?.let { override ->
                    item { ContactOverrideBanner(override, kinfolk.preferredContactMethod) }
                }
                // #552 used to put "New KinTale" here, below the contact row, as
                // the hero's primary action. #676 (walk admin-2026-09-10, same
                // ruling as the React profile) removed it: a KinTale is only
                // ever started from a KinCare session, so a standalone entry
                // point on the household profile is gone.
                item { ContactPanel(kinfolk) }
                item { HomeAccessPanel(kinfolk) }
                item { EmergencyContactsPanel(kinfolk) }
                item { VetPanel(state.householdVet) }
                if (hasDynamicFieldValues(state.kinfolkSchemas, kinfolk.formValues)) {
                    item { AdditionalInfoPanel(state.kinfolkSchemas, kinfolk.formValues) }
                } else if (state.schemaError != null && kinfolk.formValues.isNotEmpty()) {
                    // Fail loud: saved custom values exist but their labels couldn't load.
                    item {
                        DenPanel(title = "Additional info") {
                            EmptyHint("Couldn't load the custom field labels. ${state.schemaError}", error = true)
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
                // The two household-level actions that are not navigation: get
                // the household into the portal, and rebuild what Auntie knows
                // about them. The sentences that used to sit under each button
                // are gone (#758: explanatory copy is a tooltip at most, and a
                // button's label already says what it does).
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        PrimaryButton(
                            label   = if (inviteBusy) "Sending…" else "Invite to portal",
                            onClick = { viewModel.inviteKinfolkToPortal(kinfolk.id, kinfolk.displayName) },
                            enabled = !inviteBusy && kinfolk.email.isNotBlank(),
                            loading = inviteBusy,
                            modifier = Modifier.weight(1f),
                        )
                        // Phase 3: rebuild this household's dossier + every pet's
                        // 411 from recent history via the synthesize callable.
                        // In-flight guarded; the result toasts (success or fail-loud).
                        GhostButton(
                            label = if (isSynthesizing) "Refreshing…" else "Refresh intelligence",
                            enabled = !isSynthesizing,
                            onClick = { viewModel.synthesizeProfile(kinfolk.id) },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                // K3 (A8): the household-notes migration box (a mutating "Clear from
                // dossier" action) moved OFF this read-only profile and onto the Edit
                // screen, where editing belongs. See EditKinfolkScreen.

                // Kin: the mock's `.pet` rows, one tap opening the pet. The pet
                // now HAS its own screen (`KinDetailScreen`), so that is where a
                // row goes; it used to go straight to the editor because there
                // was nothing else to open.
                item {
                    DenPanel(
                        title = "Kin",
                        // The count sits BESIDE the section name, not inside it, on
                        // the kit's own meta slot (#780), the same shape the React
                        // admin's DenPanel gives this panel. Absent while the read
                        // is in flight: "0 kin" on a load that has not landed is a
                        // claim.
                        meta = if (state.isLoading) null else if (state.kinList.size == 1) "1 kin" else "${state.kinList.size} kin",
                        trailing = {
                            GhostButton(
                                label   = "Add kin",
                                onClick = { onAddKin(kinfolk.id, kinfolk.displayName) },
                            )
                        },
                    ) {
                        if (state.kinList.isEmpty()) {
                            EmptyHint("No kin on file for this household.")
                        } else {
                            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                                state.kinList.forEach { kin ->
                                    KinRow(kin = kin, kin411 = state.kin411Map[kin.id], onOpen = { onOpenKin(kin.id) })
                                }
                            }
                        }
                    }
                }

                // Profile feeds (parity with web): real per-kinfolk joins.
                // #678/#682 (parity with the React admin's right column):
                // Upcoming KinCare before Recent KinTales, then Invoices.
                item {
                    DenPanel(
                        title = "Upcoming KinCare",
                        // The window has a far edge (the mock's own header), so
                        // the card says what it is rather than implying it
                        // shows everything ahead.
                        meta = "next $UPCOMING_HORIZON_DAYS days",
                    ) {
                        if (state.upcomingVisits.isEmpty()) {
                            EmptyHint("No visits booked in the next $UPCOMING_HORIZON_DAYS days.")
                        } else {
                            Column {
                                state.upcomingVisits.forEachIndexed { index, s ->
                                    VisitLine(
                                        s = s,
                                        last = index == state.upcomingVisits.lastIndex,
                                        onOpen = { s.id.takeIf { it.isNotBlank() }?.let(onOpenVisit) },
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    DenPanel(
                        title = "Recent KinTales",
                        meta = feedCountMeta(state.recentTales.size, state.sentTaleCount, capped = false),
                    ) {
                        if (state.recentTales.isEmpty()) {
                            EmptyHint("No KinTales sent to this household yet.")
                        } else {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                state.recentTales.forEach { r ->
                                    // K1 (A8): tap a recent tale to open its report.
                                    TaleTile(
                                        report = r,
                                        onOpen = r.sessionId.takeIf { it.isNotBlank() }?.let { id -> { onOpenReport(id) } },
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    DenPanel(
                        title = "Invoices",
                        meta = feedCountMeta(state.kinfolkInvoices.size, state.invoiceCount, capped = false),
                    ) {
                        if (state.kinfolkInvoices.isEmpty()) {
                            EmptyHint("No invoices for this household yet.")
                        } else {
                            Column {
                                state.kinfolkInvoices.forEachIndexed { index, inv -> InvoiceLine(inv, last = index == state.kinfolkInvoices.lastIndex) }
                            }
                        }
                    }
                }
                // Auntie's notes, LAST (#683: "Admin Notes should be pin to the
                // bottom when viewing the kinfolk IF notes exist"). Admin-only,
                // on an admin surface: dossiers never reach a kinfolk-facing screen.
                if (dossierHasAnything(kinfolk, state.dossier)) {
                    item { AuntieNotesPanel(kinfolk, state.dossier) }
                }
            }
        }
    }
}

/**
 * The mock's hero: the trail, the household's identity, the `.tags` row and
 * the actions that act on the household.
 *
 * It IS the kit's `DenScreenHeading`, band and all (#780): the trail and the
 * title are its own, the avatar rides its `leading` slot, the joined line its
 * `detail`, the status, tenure and tag pills its `badges` row, and the action
 * row its `trailing`, which a band with a leading slot lays out under the
 * identity, full width, the way the mock's own phone-width rule does. Nothing
 * here composes a hero around the band any more, and nothing paints one.
 *
 * #681: household tags are read-only pills here, next to the status and the
 * tenure. Editing them is unchanged on this screen (`ProfileTagsSection`
 * further down still owns the write). Every pill is the kit's status capsule,
 * which is the mock's `.tag`: teal for the status and the tags, purple for
 * the tenure (`.tag.loyal`). Teal is reserved for an active household; any
 * other status word wears the neutral tone rather than a colour the mock
 * never drew.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileHero(
    kinfolk: Kinfolk,
    onDirectory: () -> Unit,
    onEdit: () -> Unit,
    onHouseholdData: () -> Unit,
    onMembers: () -> Unit,
    onMedia: () -> Unit,
) {
    val c = AuntieTheme.colors
    val initials = kinfolk.displayName.split(" ").mapNotNull { it.firstOrNull()?.toString() }.take(2).joinToString("").uppercase()
    // WHEN THEY JOINED, spelled for the operator rather than left as
    // stored. `freeTextDateLabel` formats what it can read and prints
    // the rest exactly as stored, so a legacy free-text join date never
    // renders as an error and never becomes a different date.
    val joined = freeTextDateLabel(kinfolk.joinDate)
    // The tenure chip is ABSENT when the stored join date is not one
    // anybody can read, rather than a fabricated "0 months". Same rule,
    // same branches, as the React admin's hero.
    val tenure = tenureLabel(kinfolk.joinDate, java.time.LocalDate.now())
    val active = kinfolk.status.trim().equals("active", ignoreCase = true)
    val context = LocalContext.current
    DenScreenHeading(
        kicker = "The Den · Directory",
        crumbs = listOf(
            DenCrumb("Directory", onDirectory),
            DenCrumb(kinfolk.displayName),
        ),
        title = kinfolk.displayName,
        detail = if (joined.isNotBlank()) "Joined $joined" else null,
        modifier = Modifier.fillMaxWidth(),
        leading = {
            AuntieAvatar(
                imageUrl = kinfolk.profilePictureUrl,
                initials = initials.ifBlank { "?" },
                size = 84.dp,
                shape = RoundedCornerShape(24.dp),
                gradientSeed = kinfolk.id,
            )
        },
        badges = {
            AuntieStatusPill(
                label = kinfolk.status.trim().ifBlank { "no status" }.lowercase(),
                tone = if (active) AuntieStatusTone.Teal else AuntieStatusTone.Neutral,
                mono = true,
            )
            if (tenure != null) {
                AuntieStatusPill(label = tenure, tone = AuntieStatusTone.Purple, mono = true)
            }
            kinfolk.tagNames().forEach { tag ->
                AuntieStatusPill(label = tag, tone = AuntieStatusTone.Teal, mono = true)
            }
        },
        // The action row: Call and Text on the real number, then the household's
        // other surfaces. Call and Text render only once there is a number to
        // dial, never as dead controls; Email the same on the address.
        trailing = {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (kinfolk.phoneNumber.isNotBlank()) {
                    GhostButton(
                        label = "Call",
                        leading = { Icon(Lucide.Phone, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.textPrimary) },
                        onClick = { context.startActivity(Intent(Intent.ACTION_DIAL).apply { data = Uri.parse("tel:${kinfolk.phoneNumber}") }) },
                    )
                    GhostButton(
                        label = "Text",
                        leading = { Icon(Lucide.MessageCircle, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.textPrimary) },
                        onClick = { context.startActivity(Intent(Intent.ACTION_VIEW).apply { data = Uri.parse("sms:${kinfolk.phoneNumber}") }) },
                    )
                }
                if (kinfolk.email.isNotBlank()) {
                    GhostButton(
                        label = "Email",
                        leading = { Icon(Lucide.Mail, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.textPrimary) },
                        onClick = { context.startActivity(Intent(Intent.ACTION_SENDTO).apply { data = Uri.parse("mailto:${kinfolk.email}") }) },
                    )
                }
                GhostButton(label = "Household data", onClick = onHouseholdData)
                // B1: who can reach this household in MyTribe, and its invites.
                GhostButton(label = "Members and invites", onClick = onMembers)
                GhostButton(label = "Media", onClick = onMedia)
                GhostButton(label = "Edit", onClick = onEdit)
            }
        },
    )
}

/** One of the mock's `.field` rows, declared so a panel can lay a run of them out. */
internal class Field(
    val label: String,
    val value: String,
    val mono: Boolean = false,
    /**
     * The value opens Google Maps directions (#685), the same destination URL
     * the React admin's `Fact` renders for the service address and the vet
     * clinic address.
     */
    val directions: Boolean = false,
)
/**
 * A run of the mock's `.field` rows: label left in dim, value right, a
 * hairline under every row but the last. A blank value renders nothing, and
 * so does the "()" a half-filled emergency contact used to print, so the
 * hairlines land between the rows that are actually there.
 */
@Composable
internal fun FieldRows(vararg fields: Field) {
    val shown = fields.filter { it.value.isNotBlank() && !it.value.contains("()") }
    val context = LocalContext.current
    Column {
        shown.forEachIndexed { index, f ->
            AuntieKeyValueRow(
                label = f.label,
                value = f.value,
                valueMono = f.mono,
                showDivider = index < shown.lastIndex,
                onValueClick = if (f.directions) ({
                    val uri = Uri.parse(
                        "https://www.google.com/maps/dir/?api=1&destination=" + Uri.encode(f.value),
                    )
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                }) else null,
            )
        }
    }
}
/**
 * CONTACT FIRST under the hero (#679): the household's own facts, the service
 * address folded in (an address is a way to reach the household the same as a
 * phone number is). K2 (A8): "Preferred contact" is not read here, per the
 * operator; the model field is kept.
 */
@Composable
private fun ContactPanel(kinfolk: Kinfolk) {
    DenPanel(title = "Contact") {
        val any = listOf(
            kinfolk.phoneNumber, kinfolk.secondaryPhone, kinfolk.email, kinfolk.secondaryEmail,
            kinfolk.bestTimeToContact, kinfolk.serviceAddress,
        ).any { it.isNotBlank() }
        if (!any) {
            EmptyHint("No contact details on file.")
        } else {
            val balance = kinfolk.outstandingBalance.takeIf { it.isNotBlank() && it != "0.00" }?.let { "$$it" }.orEmpty()
            FieldRows(
                Field("Phone", kinfolk.phoneNumber, mono = true),
                Field("Email", kinfolk.email),
                Field("Secondary phone", kinfolk.secondaryPhone, mono = true),
                Field("Secondary email", kinfolk.secondaryEmail),
                Field("Best time to reach", kinfolk.bestTimeToContact),
                // #685 (parity with the React admin): the address opens Google
                // Maps directions, the same destination URL the web Fact renders.
                Field("Service address", kinfolk.serviceAddress, directions = true),
                Field("Outstanding balance", balance, mono = true),
            )
        }
    }
}

/**
 * ALWAYS RENDERED, empty or not (#407): a household with no gate code and no
 * parking note still needs to see this panel as a thing it could fill in, not
 * have it vanish. The address lives in Contact (#679); what is here is about
 * getting into the home once an Auntie has already found it.
 */
@Composable
private fun HomeAccessPanel(kinfolk: Kinfolk) {
    DenPanel(title = "Home & access") {
        val any = listOf(kinfolk.gateCode, kinfolk.parkingInstructions, kinfolk.entryNotes, kinfolk.wifiName, kinfolk.wifiPassword)
            .any { it.isNotBlank() }
        if (!any) {
            EmptyHint("No entry details on file.")
        } else {
            FieldRows(
                Field("Gate code", kinfolk.gateCode, mono = true),
                Field("Parking", kinfolk.parkingInstructions),
                Field("Entry notes", kinfolk.entryNotes),
                // The network name and the password are two rows, the way the
                // web profile shows them, not one "name / password" string.
                Field("Wi-Fi network", kinfolk.wifiName),
                Field("Wi-Fi password", kinfolk.wifiPassword, mono = true),
            )
        }
    }
}

/**
 * #680 (parity with the React admin): "Emergency Contacts", so it reads apart
 * from the emergency vet below rather than the singular that could be misread
 * as naming the same thing.
 *
 * #829: always rendered, even with none on file - a household with no
 * Emergency Contact is a defect state the panel flags rather than hides, the
 * same way the directory card's badge does.
 */
@Composable
private fun EmergencyContactsPanel(kinfolk: Kinfolk) {
    val contacts = emergencyContactsOf(kinfolk)
    DenPanel(title = "Emergency Contacts") {
        if (contacts.isEmpty()) {
            // #829 review item 14: the compact pill, as on every other surface.
            AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange, compact = true)
        } else {
            contacts.forEachIndexed { i, c ->
                FieldRows(
                    Field(if (i == 0) "Called first" else "Called second", c.name),
                    Field("Phone", c.phone, mono = true),
                    Field("Relationship", c.relationship.orEmpty()),
                )
            }
        }
    }
}

/**
 * THE VET IS READ, NOT OWNED. Operator ruling 2026-08-01: "vet info lives on
 * household data, it can be seen on the kin profile". It used to read
 * kinfolk.vetClinic*, the copy that made the vet authored in two places at
 * once; it now resolves through household data's clinic id, so what is shown
 * here is the same single record the Household Data screen edits. The
 * emergency clinic is a DISTINCT practice, never folded into the primary:
 * "who to call" and "who to call at 2am" differ.
 */
@Composable
private fun VetPanel(householdVet: HouseholdVet) {
    val primary = householdVet.primary
    val er = householdVet.emergency
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        DenPanel(title = "Vet clinic") {
            if (listOf(primary.name, primary.phone, primary.address).all { it.isBlank() }) {
                EmptyHint("No household vet on file yet.")
            } else {
                FieldRows(
                    Field("Clinic", primary.name),
                    Field("Phone", primary.phone, mono = true),
                    Field("Address", primary.address, directions = true),
                )
            }
        }
        if (listOf(er.name, er.phone, er.address).any { it.isNotBlank() }) {
            DenPanel(title = "Emergency vet", subtitle = "The 24 hour clinic for this household.") {
                FieldRows(
                    Field("Clinic", er.name),
                    Field("Phone", er.phone, mono = true),
                    Field("Address", er.address, directions = true),
                )
            }
        }
    }
}

/** Read-only display of admin-authored KINFOLK custom field VALUES on the profile. */
@Composable
private fun AdditionalInfoPanel(schemas: List<FormSchema>, values: Map<String, String>) {
    DenPanel(title = "Additional info") {
        Column {
            DynamicFormFieldsReadOnly(schemas, values) { label, value ->
                if (value.isNotBlank()) AuntieKeyValueRow(label = label, value = value)
            }
        }
    }
}

/** True when the dossier band has anything to say, the web panel's own rule (#683). */
private fun dossierHasAnything(kinfolk: Kinfolk, dossier: com.tribetails.auntieos.data.model.Dossier?): Boolean =
    kinfolk.internalNotes.isNotBlank() || kinfolk.referralSource.isNotBlank() ||
        (dossier != null && listOf(
            dossier.tldr, dossier.rawSummary, dossier.householdNotes,
            dossier.communicationStyle, dossier.relationshipWithAuntie,
        ).any { it.isNotBlank() })

/**
 * The mock's "Auntie's notes · admin only": the dossier summary in the dashed
 * note box, then the structured notes under it. Internal notes and the
 * referral source are the two kinfolk-doc fields that belong beside them
 * rather than on Contact; they stay visible here so nothing persisted goes
 * dark on this platform.
 *
 * ADMIN-ONLY, and only ever on an admin surface: dossiers never reach a
 * kinfolk-facing screen. READ-ONLY: the one mutating action it ever had
 * (clearing migrated household notes) lives on the Edit screen (K3/A8).
 */
@Composable
private fun AuntieNotesPanel(
    kinfolk: Kinfolk,
    dossier: com.tribetails.auntieos.data.model.Dossier?,
) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Auntie's notes",
        meta = "admin only",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (dossier == null || dossier.needsMoreSamples) {
                NeedsMoreSamplesBanner(
                    message = "Not enough comms history yet to summarize this kinfolk. Send/receive a few more messages.",
                )
            }
            val summary = listOf(dossier?.tldr.orEmpty(), dossier?.rawSummary.orEmpty())
                .map { stripDossierSources(it) }
                .firstOrNull { it.isNotBlank() }
            if (summary != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(c.surface2)
                        .border(1.dp, c.border, RoundedCornerShape(12.dp))
                        .padding(13.dp),
                ) {
                    Text(
                        summary,
                        style = AuntieTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic),
                        color = c.textDim,
                    )
                }
            }
            FieldRows(
                Field("Household notes", dossier?.householdNotes.orEmpty()),
                Field("Communication style", stripDossierSources(dossier?.communicationStyle.orEmpty())),
                Field("Relationship with Auntie", dossier?.relationshipWithAuntie.orEmpty()),
                Field("Internal notes", kinfolk.internalNotes),
                Field("Referral source", kinfolk.referralSource),
                Field("Last enriched", dossier?.lastReconciledAt.orEmpty().take(10), mono = true),
            )
        }
    }
}

/**
 * The mock's `.pet` row: photo, name, one dim line of facts and the pet's own
 * line from its 411, a chevron, and the whole row opens the pet. Under the row,
 * the three 411 facts this profile has always shown (medical, feeding, potty),
 * because the 411 is admin-only and this profile is the one Android surface
 * that reads them per pet: dropping them for the mock's one line would take
 * them off the platform.
 */
@Composable
private fun KinRow(kin: Kin, kin411: Kin411?, onOpen: () -> Unit) {
    val c = AuntieTheme.colors
    val facts = listOf(kin.species, kin.breed, kin.age.takeIf { it.isNotBlank() }?.let { "$it yrs" }.orEmpty())
        .filter { it.isNotBlank() }
    val own = kin411?.let { f -> listOf(f.tldr, f.personality, f.quirksAndPreferences).firstOrNull { it.isNotBlank() } }
        ?.let { stripDossierSources(it) }.orEmpty()
    val line = (facts + listOfNotNull(own.takeIf { it.isNotBlank() })).joinToString(" · ")
    val medical = kin411?.medicalNotes.orEmpty()
    val feeding = listOfNotNull(kin411?.feedingAmount, kin411?.feedingFrequency).filter { it.isNotBlank() }.joinToString(" / ")
    val potty = kin411?.pottyRoutine.orEmpty()
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, c.borderSoft, RoundedCornerShape(14.dp)),
    ) {
        AuntieEntityRow(
            title = kin.name,
            subtitle = line.ifBlank { null },
            leading = {
                AuntieAvatar(
                    imageUrl = kin.profilePictureUrl,
                    initials = kin.name.take(1),
                    size = 52.dp,
                    gradientSeed = kin.id.ifBlank { kin.name },
                )
            },
            trailing = {
                Icon(Lucide.ChevronRight, contentDescription = null, tint = c.textDim, modifier = Modifier.size(18.dp))
            },
            supporting = if (listOf(medical, feeding, potty).any { it.isNotBlank() }) ({
                if (kin411 == null || kin411.needsMoreSamples) {
                    NeedsMoreSamplesBanner(message = "Not enough notes about ${kin.name} yet.")
                }
                FieldRows(
                    Field("Medical notes", medical),
                    Field("Feeding", feeding),
                    Field("Potty routine", potty),
                )
            }) else null,
            onClick = onOpen,
        )
    }
}

/**
 * The mock's `.visit` line: a dot in the service tone, the time in mono, what
 * the visit is, and the service pill at the far edge. A hairline under every
 * line but the last.
 *
 * [onOpen] opens the visit, which is the operator's standing directive on the
 * bookings mock ("cards should open displaying fuller details") and what the
 * React twin's rows do. It is REQUIRED, not defaulted to a no-op: #808 shipped
 * this with `onOpen: (() -> Unit)? = null` so a forgotten wiring rendered a
 * plain, silently inert line instead of failing to compile, and that is
 * exactly how #809 (this component wired on the Kin detail screen but not the
 * household profile it has always rendered on) happened. A caller with
 * nowhere to send the tap now has to say so on purpose, by passing `{}`,
 * rather than getting that for free.
 */
@Composable
internal fun VisitLine(s: KinCareSession, last: Boolean, onOpen: () -> Unit) {
    val c = AuntieTheme.colors
    val tone = serviceTone(s.serviceType)
    val description = if (s.serviceDurationMinutes > 0) {
        "${s.serviceDurationMinutes}-min ${s.serviceType.ifBlank { "visit" }.lowercase()}"
    } else {
        s.serviceType.ifBlank { "visit" }.lowercase()
    }
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpen)
                .padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(tone.color(c)))
            Text(
                "${s.startTime.take(10)} ${formatTime(s.startTime)}",
                style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
                color = c.textPrimary,
            )
            Text(description, style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.weight(1f))
            ServicePill(serviceType = s.serviceType, tone = tone)
        }
        if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderSoft))
    }
}

/**
 * The mock's `.tale` tile: a boxed row on a soft hairline with the title, a
 * line of the body and a "SENT · <when>" stamp. Tappable when the report has a
 * session to open.
 */
@Composable
internal fun TaleTile(report: KinCareReport, onOpen: (() -> Unit)?) {
    val c = AuntieTheme.colors
    val title = report.title.ifBlank { report.serviceType.orEmpty().ifBlank { "KinTale" } }
    val body = report.bodyCopy.trim().lineSequence().firstOrNull().orEmpty()
    val whenStamp = (report.sentAt.orEmpty().ifBlank { report.visitDate }).take(10)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.background.copy(alpha = 0.4f))
            .border(1.dp, c.borderSoft, RoundedCornerShape(14.dp))
            .then(if (onOpen != null) Modifier.clickable(onClick = onOpen) else Modifier)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
        if (body.isNotBlank()) {
            Text(body, style = AuntieTheme.typography.bodySmall, color = c.textDim, maxLines = 2)
        }
        if (whenStamp.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "SENT · $whenStamp".uppercase(),
                style = AuntieTheme.typography.mono.copy(fontSize = 10.sp, letterSpacing = 0.4.sp),
                color = c.textFaint,
            )
        }
    }
}

/**
 * The mock's `.invrow`: the invoice's number and visit count in mono on the
 * left, the amount and the state capsule on the right, a hairline under every
 * line but the last. The capsule carries the state the server STAMPED, through
 * the same reader the Invoices screen uses (never a two-value paid/unpaid guess
 * off the money); an unstamped legacy doc reads as what it says.
 */
@Composable
private fun InvoiceLine(inv: Invoice, last: Boolean) {
    val c = AuntieTheme.colors
    val (label, tone) = invoiceFeedPill(inv)
    val amount = if (inv.amountDue > 0) inv.amountDue else inv.total
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                kinfolkInvoiceFeedLabel(inv),
                style = AuntieTheme.typography.mono.copy(fontSize = 11.5.sp),
                color = c.textDim,
                modifier = Modifier.weight(1f),
            )
            Text("$" + "%.2f".format(amount), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            AuntieStatusPill(label = label, tone = tone, mono = true)
        }
        if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderSoft))
    }
}

/** Label and tone for one invoice's stamped state, mirroring the web feed's `invoicePillTone`. */
internal fun invoiceFeedPill(inv: Invoice): Pair<String, AuntieStatusTone> = when (invoiceStateOrNull(inv)) {
    InvoiceState.PAID -> "Paid" to AuntieStatusTone.Teal
    InvoiceState.ZERO -> "Zero" to AuntieStatusTone.Teal
    InvoiceState.OPEN -> "Unpaid" to AuntieStatusTone.Orange
    InvoiceState.QUOTE -> "Quote" to AuntieStatusTone.Purple
    InvoiceState.DRAFT -> "Draft" to AuntieStatusTone.Muted
    InvoiceState.CANCELLED -> "Cancelled" to AuntieStatusTone.Muted
    InvoiceState.CREDIT -> "Credit" to AuntieStatusTone.Teal
    InvoiceState.REDEEMED -> "Redeemed" to AuntieStatusTone.Muted
    null -> inv.status.trim().ifBlank { "No status" } to AuntieStatusTone.Muted
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

/**
 * D1 (A8): the comms-reconcile pipeline embeds `[[source:msg-123]]` citation tags in
 * dossier free-text. They are internal provenance, not for the operator's eyes, so
 * they are stripped (with the leading whitespace they trail) before render. Mirror
 * of web stripDossierSources. Pure + unit-tested in StripDossierSourcesTest.
 */
private val DOSSIER_SOURCE_TAG = Regex("""\s*\[\[source:[^]]*]]""")
fun stripDossierSources(raw: String): String =
    DOSSIER_SOURCE_TAG.replace(raw, "").trim()

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
