package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.UserCog
import com.composables.icons.lucide.UserPlus
import com.tribetails.auntieos.web.data.AuditLog
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.NO_EMERGENCY_CONTACT
import com.tribetails.auntieos.web.data.draftsEqual
import com.tribetails.auntieos.web.data.emergencyContactsOf
import com.tribetails.auntieos.web.data.isBlankDrafts
import com.tribetails.auntieos.web.data.toDrafts
import com.tribetails.auntieos.web.data.validateEmergencyContactDrafts
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import androidx.compose.ui.draw.alpha
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.HouseholdData
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.appliesToSchemaIds
import com.tribetails.auntieos.web.data.MapboxClient
import com.tribetails.auntieos.web.data.MapboxRetrieveResult
import com.tribetails.auntieos.web.data.MapboxSuggestResult
import com.tribetails.auntieos.web.data.MapboxSuggestion
import com.tribetails.auntieos.web.data.VetClinic
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.util.isValidEmail
import com.tribetails.auntieos.web.util.isValidPhone
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DynamicFormFields
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.launch

/**
 * Single screen handling both **create** (kinfolkId == null) and **update**
 * (existing). Same form, same field set; the only behavioral differences are
 * the title, the presence of the Archive block, and the Firestore call we
 * make on Save.
 *
 * Den redesign 2026-05-27: each subsection is a frosted glass panel with a
 * numbered mono legend and a required / optional advisory pill (the pills are
 * a mockup SUGGESTION). Save / cancel live in a sticky [AuntieSaveBar] footer
 * with a live "unsaved changes" pip (also a SUGGESTION). All data wiring,
 * validators, Mapbox autocomplete, vet-clinic catalog, and fail-loud toasts
 * are preserved verbatim from the original screen.
 */
@Composable
fun KinfolkEditScreen(
    kinfolkId: String?,
    onBack: () -> Unit,
    onSaved: (kinfolkId: String) -> Unit,
    onArchived: () -> Unit,
) {
    val client = remember { FirestoreClient() }
    val scope  = rememberReportingScope()
    val isNew  = kinfolkId.isNullOrBlank()

    // For edits we need the live doc to pre-fill. Subscribe to the kinfolk list
    // (it's already in memory from Directory) and pluck the matching record.
    // For creates, we never read; the form starts blank.
    val state by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val existing: Kinfolk? = remember(state, kinfolkId) {
        if (isNew) null
        else (state as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinfolkId }
    }

    // K3: dossier household-notes (migration) — the "Clear from dossier" action lives
    // here now (moved off the profile per operator). Live dossier stream so the section
    // hides itself once the notes clear; one-shot household read powers the gap list.
    val dossier by remember(kinfolkId) { client.dossierStream(kinfolkId.orEmpty()) }
        .collectAsState(initial = FirestoreResult.Loading)
    var householdData by remember(kinfolkId) { mutableStateOf<HouseholdData?>(null) }
    LaunchedEffect(kinfolkId) {
        if (!isNew && !kinfolkId.isNullOrBlank()) {
            (client.getHouseholdData(kinfolkId) as? WriteResult.Ok)?.let { householdData = it.value }
        }
    }

    var initialized by remember(kinfolkId) { mutableStateOf(false) }

    var firstName      by remember(kinfolkId) { mutableStateOf("") }
    var lastName       by remember(kinfolkId) { mutableStateOf("") }
    var phoneNumber    by remember(kinfolkId) { mutableStateOf("") }
    var secondaryPhone by remember(kinfolkId) { mutableStateOf("") }
    var email          by remember(kinfolkId) { mutableStateOf("") }
    var secondaryEmail by remember(kinfolkId) { mutableStateOf("") }
    var status         by remember(kinfolkId) { mutableStateOf("active") }
    var serviceAddr    by remember(kinfolkId) { mutableStateOf("") }
    var gateCode       by remember(kinfolkId) { mutableStateOf("") }
    var parking        by remember(kinfolkId) { mutableStateOf("") }
    var entryNotes     by remember(kinfolkId) { mutableStateOf("") }
    var wifiName       by remember(kinfolkId) { mutableStateOf("") }
    var wifiPass       by remember(kinfolkId) { mutableStateOf("") }
    // #829: Emergency Contacts are edited here but saved ONLY through the
    // saveEmergencyContacts callable. The baseline is what is on file, so an
    // unchanged editor never calls it.
    var ecDrafts       by remember(kinfolkId) { mutableStateOf(listOf(EmergencyContactDraft())) }
    var ecBaseline     by remember(kinfolkId) { mutableStateOf(listOf(EmergencyContactDraft())) }
    // #829: set when Add created the household but the contact save failed. From
    // then on Save retries ONLY the contacts (never a second household) and the
    // household fields lock, as admin web and Android do.
    var createdKinfolkId by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var internalNotes  by remember(kinfolkId) { mutableStateOf("") }
    var referral       by remember(kinfolkId) { mutableStateOf("") }
    var vetName        by remember(kinfolkId) { mutableStateOf("") }
    var vetPhone       by remember(kinfolkId) { mutableStateOf("") }
    var vetAddress     by remember(kinfolkId) { mutableStateOf("") }
    var photoUrl       by remember(kinfolkId) { mutableStateOf("") }

    // Phase 14: KINFOLK form_schemas (appliesTo == KINFOLK). Admin-authored custom
    // fields are rendered + persisted into Kinfolk.formValues. Mirrors KIN precare.
    val formValues = remember(kinfolkId) { mutableStateMapOf<String, String>() }
    val schemaRepo = remember { CloudFormSchemaRepository() }
    var kinfolkSchemas by remember { mutableStateOf<List<FormSchema>>(emptyList()) }
    var schemaError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        when (val list = schemaRepo.listSchemas()) {
            is WriteResult.Err -> schemaError = list.message
            is WriteResult.Ok  -> {
                val loaded = mutableListOf<FormSchema>()
                for (id in appliesToSchemaIds(list.value, "KINFOLK")) {
                    when (val s = schemaRepo.getSchema(id)) {
                        is WriteResult.Ok  -> loaded.add(s.value)
                        is WriteResult.Err -> schemaError = s.message
                    }
                }
                kinfolkSchemas = loaded
            }
        }
    }

    val vetClinicsState by remember { client.vetClinicsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val vetClinics: List<VetClinic> = (vetClinicsState as? FirestoreResult.Data)?.value
        ?.sortedBy { it.name.lowercase() }
        ?: emptyList()

    // Pre-fill once the existing record arrives. Don't re-prefill on every
    // stream emission. Auntie's keystrokes would get clobbered.
    LaunchedEffect(existing, isNew) {
        if (!isNew && existing != null && !initialized) {
            firstName      = existing.firstName
            lastName       = existing.lastName
            phoneNumber    = existing.phoneNumber
            secondaryPhone = existing.secondaryPhone
            email          = existing.email
            secondaryEmail = existing.secondaryEmail
            status         = existing.status.ifBlank { "active" }
            serviceAddr    = existing.serviceAddress
            gateCode       = existing.gateCode
            parking        = existing.parkingInstructions
            entryNotes     = existing.entryNotes
            wifiName       = existing.wifiName
            wifiPass       = existing.wifiPassword
            ecDrafts       = emergencyContactsOf(existing).toDrafts()
            ecBaseline     = ecDrafts
            internalNotes  = existing.internalNotes
            referral       = existing.referralSource
            vetName        = existing.vetClinicName
            vetPhone       = existing.vetClinicPhone
            vetAddress     = existing.vetClinicAddress
            photoUrl       = existing.profilePictureUrl
            formValues.clear()
            formValues.putAll(existing.formValues)
            initialized = true
        }
    }

    var saving       by remember { mutableStateOf(false) }
    var toast        by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind    by remember { mutableStateOf(ToastKind.Info) }

    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    fun build(): Kinfolk = (existing ?: Kinfolk(_id = kinfolkId.orEmpty())).copy(
        firstName                = firstName.trim(),
        lastName                 = lastName.trim(),
        phoneNumber              = phoneNumber.trim(),
        secondaryPhone           = secondaryPhone.trim(),
        email                    = email.trim(),
        secondaryEmail           = secondaryEmail.trim(),
        // preferredContactMethod / bestTimeToContact intentionally NOT overwritten
        // here (item 2: editor removed); existing values are preserved via copy().
        serviceAddress           = serviceAddr.trim(),
        gateCode                 = gateCode.trim(),
        parkingInstructions      = parking.trim(),
        entryNotes               = entryNotes,
        wifiName                 = wifiName.trim(),
        wifiPassword             = wifiPass,
        // #829: no Emergency Contact field here. The four keys are dropped from
        // every kinfolk write (kinfolkWriteJson); contacts go through the callable.
        internalNotes            = internalNotes,
        referralSource           = referral.trim(),
        vetClinicName            = vetName.trim(),
        vetClinicPhone           = vetPhone.trim(),
        vetClinicAddress         = vetAddress.trim(),
        profilePictureUrl        = photoUrl,
        status                   = status,
        formValues               = formValues.toMap(),
    )

    var attemptedSave  by remember { mutableStateOf(false) }
    // P1-FORMS hardening 2026-05-26: require Last name; reject alpha in phone;
    // require RFC-ish email format. Validators live in
    // `com.tribetails.auntieos.web.util.FieldValidators` so they're testable
    // independently of Compose and reusable on other screens.
    val firstNameError = firstName.isBlank()
    val lastNameError  = lastName.isBlank()
    val phoneError     = !isValidPhone(phoneNumber)
    val secondaryPhoneError = secondaryPhone.isNotBlank() && !isValidPhone(secondaryPhone)
    val emailError     = !isValidEmail(email)
    val secondaryEmailError = secondaryEmail.isNotBlank() && !isValidEmail(secondaryEmail)
    // item 3: service address is REQUIRED. The Emergency Contact requirement
    // (#829) is checked by validateEmergencyContactDrafts in onSave, with the
    // server's own messages.
    val serviceAddrError = serviceAddr.isBlank()
    val vetPhoneError  = vetPhone.isNotBlank() && !isValidPhone(vetPhone)
    val canSave = !firstNameError && !lastNameError && !phoneError && !emailError &&
        !secondaryPhoneError && !secondaryEmailError && !serviceAddrError &&
        !vetPhoneError

    // #829: household fields lock while a save is in flight and, on Add, once the
    // household exists and only its Emergency Contact is left to retry. Setters
    // for controls with no `enabled` parameter go through [unlessLocked].
    val householdFieldsEnabled = !saving && createdKinfolkId == null
    fun unlessLocked(set: () -> Unit) { if (householdFieldsEnabled) set() }

    // SUGGESTION: live dirty indicator for the sticky save bar. The original
    // screen has no unsaved-changes tracking; this drives only the pip + label
    // and never gates the save itself.
    val dirty = remember(
        firstName, lastName, phoneNumber, secondaryPhone, email, secondaryEmail,
        status, serviceAddr, gateCode, parking, entryNotes,
        wifiName, wifiPass, ecDrafts, ecBaseline, internalNotes, referral,
        vetName, vetPhone, vetAddress, existing, createdKinfolkId,
    ) {
        if (isNew) {
            createdKinfolkId != null || !ecDrafts.isBlankDrafts() || listOf(
                firstName, lastName, phoneNumber, secondaryPhone, email, secondaryEmail,
                serviceAddr, gateCode, parking, entryNotes, wifiName, wifiPass,
                internalNotes, referral, vetName, vetPhone, vetAddress,
            ).any { it.isNotBlank() }
        } else {
            existing != null && (build() != existing || !draftsEqual(ecDrafts, ecBaseline))
        }
    }

    // Save handler shared by the sticky save bar. Behavior verbatim from the
    // original PrimaryButton onClick: gate on canSave (fail-loud toast on
    // failure), upsert any new vet clinic into the shared catalog, then
    // create / update the Kinfolk and fire the audit log.
    fun onSave() {
        if (saving) return
        attemptedSave = true
        val retryId = createdKinfolkId
        // The retry skips the household checks (those fields are locked and
        // already saved) but still validates the contacts, so a refusal reads as
        // the plain rule rather than a wrapped callable failure.
        if (retryId == null && !canSave) {
            showToast(
                "Fix the highlighted fields. First+Last name required; phone must be digits only; email must be a real address.",
                ToastKind.Error,
            )
            return
        }
        val saveContacts = retryId != null || emergencyContactsNeedSaving(isNew, ecDrafts, ecBaseline)
        if (saveContacts) {
            validateEmergencyContactDrafts(
                ecDrafts,
                listOf("$firstName $lastName"),
                listOf(phoneNumber, secondaryPhone),
            )?.let {
                showToast(it, ToastKind.Error)
                return
            }
        }
        saving = true
        scope.launch {
            val draft = build()
            val outcome = saveKinfolkWithContacts(
                retryKinfolkId = retryId,
                saveContacts   = saveContacts,
                writeHousehold = {
                    // If the entered clinic name is new (or has new details),
                    // write it to the shared catalog so other households see it
                    // next time. Match by case-insensitive name.
                    val typedClinic = vetName.trim()
                    if (typedClinic.isNotBlank() &&
                        vetClinics.none { it.name.equals(typedClinic, ignoreCase = true) }
                    ) {
                        client.createVetClinic(
                            VetClinic(
                                name    = typedClinic,
                                phone   = vetPhone.trim(),
                                address = vetAddress.trim(),
                            )
                        )
                    }
                    if (isNew) client.createKinfolk(draft) else {
                        when (val r = client.updateKinfolk(draft)) {
                            is WriteResult.Ok  -> WriteResult.Ok(draft._id)
                            is WriteResult.Err -> r
                        }
                    }
                },
                writeContacts = { id -> client.saveEmergencyContacts(id, ecDrafts) },
                onHouseholdWritten = { id ->
                    AuditLog.fire(
                        scope            = scope,
                        client           = client,
                        actorId          = "",
                        actionType       = if (isNew) "CREATE_KINFOLK" else "UPDATE_KINFOLK",
                        description      = if (isNew)
                            "Added Kinfolk ${draft.displayName}"
                        else
                            "Updated Kinfolk ${draft.displayName}",
                        targetId         = id,
                        targetCollection = "kinfolk",
                    )
                },
            )
            saving = false
            when (outcome) {
                is KinfolkSaveOutcome.Saved -> {
                    if (saveContacts) ecBaseline = ecDrafts
                    showToast(if (isNew) "Kinfolk added." else "Saved.", ToastKind.Success)
                    onSaved(outcome.kinfolkId)
                }
                is KinfolkSaveOutcome.HouseholdFailed ->
                    showToast("Save failed: ${outcome.message}", ToastKind.Error)
                is KinfolkSaveOutcome.ContactsFailed -> {
                    if (isNew) {
                        createdKinfolkId = outcome.kinfolkId
                        showToast(
                            "saveEmergencyContacts failed: ${outcome.message}. The household was created and shows No Emergency Contact until this is saved.",
                            ToastKind.Error,
                        )
                    } else {
                        showToast(
                            "The household is saved. saveEmergencyContacts failed: ${outcome.message}",
                            ToastKind.Error,
                        )
                    }
                }
            }
        }
    }

    ScreenScaffold {
        SectionHeader(
            title    = if (isNew) "Add Kinfolk" else "Edit Kinfolk",
            subtitle = if (isNew) "A new household joining the Tribe"
                       else        existing?.displayName?.let { "Updating $it" } ?: "Updating profile",
            icon     = if (isNew) Lucide.UserPlus else Lucide.UserCog,
            onBack   = onBack,
            breadcrumbs = if (isNew) listOf("Directory") else listOf("Directory", "Profile"),
        )

        StatusToast(visible = toastVisible, message = toast, kind = toastKind, onDismiss = { toastVisible = false })

        // While editing, wait for the live doc to land before showing the form
        // (otherwise the user briefly sees blank fields before the prefill).
        if (!isNew && existing == null) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 56.dp) }
            }
            return@ScreenScaffold
        }

        // ---- Profile photo (#4). Reuses the proven media pipeline; on desktop the upload
        // fails loud (mobile-only today). Needs a saved kinfolk (real entityId) first. ----
        if (!isNew && kinfolkId != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                AuntieAvatar(
                    imageUrl = photoUrl.ifBlank { null },
                    initials = firstName.take(1).ifBlank { "?" }.uppercase(),
                    size = 64.dp,
                    gradientSeed = firstName.ifBlank { "kinfolk" },
                )
                Text(
                    text = if (photoUrl.isBlank()) "Add photo" else "Change photo",
                    style = AuntieTheme.typography.labelLarge,
                    color = AuntieTheme.colors.primary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable {
                            scope.launch {
                                when (val r = client.uploadMedia(kinfolkId, "KINFOLK", ByteArray(0), "")) {
                                    is WriteResult.Ok -> {
                                        val url = r.value.storageUrl
                                        photoUrl = url
                                        client.updateKinfolk(build().copy(profilePictureUrl = url))
                                        showToast("Photo updated.", ToastKind.Success)
                                    }
                                    is WriteResult.Err -> showToast("Photo upload failed: ${r.message}", ToastKind.Error)
                                }
                            }
                        }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
        }

        // Mockup error toast: an inline fail-loud banner surfaces while the form
        // has invalid fields after a save attempt. Mirrors the StatusToast copy.
        if (attemptedSave && !canSave) {
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                icon = if (isNew) Lucide.UserPlus else Lucide.UserCog,
            ) {
                Text(
                    text  = "Fix the highlighted fields. First+Last name required; phone must be digits only; email must be a real address.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
            Spacer(Modifier.height(16.dp))
        }

        // ── 01 · Identity ─────────────────────────────────────────────────────
        SubsectionPanel(index = "01", title = "Identity", enabled = householdFieldsEnabled) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    firstName, { firstName = it },
                    label    = "First name *",
                    enabled  = householdFieldsEnabled,
                    isError  = firstNameError && attemptedSave,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    lastName, { lastName = it },
                    label    = "Last name *",
                    enabled  = householdFieldsEnabled,
                    isError  = lastNameError && attemptedSave,
                    modifier = Modifier.weight(1f),
                )
            }
            // Status segmented picker exists ONLY on the create path.
            if (isNew) {
                Spacer(Modifier.height(16.dp))
                AuntieFieldLabel(text = "Status")
                SegmentedPicker(
                    options  = listOf("prospect", "active"),
                    selected = status,
                    onSelect = { unlessLocked { status = it } },
                    label    = { it.replaceFirstChar { c -> c.uppercaseChar() } },
                )
            }
            // Run 4: the kinfolk's OWN phone + email live in Identity (emergency
            // contact moved to "Other Contacts").
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    phoneNumber, { phoneNumber = it },
                    label        = "Phone *",
                    enabled      = householdFieldsEnabled,
                    isError      = phoneError && attemptedSave,
                    modifier     = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(
                    email, { email = it },
                    label        = "Email *",
                    enabled      = householdFieldsEnabled,
                    isError      = emailError && attemptedSave,
                    modifier     = Modifier.weight(1f),
                    keyboardType = KeyboardType.Email,
                )
            }
            Spacer(Modifier.height(16.dp))
            AuntieFieldLabel(text = "Service address *")
            AddressAutofillField(
                value         = serviceAddr,
                onValueChange = { unlessLocked { serviceAddr = it } },
                scope         = scope,
                enabled       = householdFieldsEnabled,
            )
            if (serviceAddrError && attemptedSave) {
                Spacer(Modifier.height(4.dp))
                Text("Service address is required.", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.error)
            }
        }

        // ── 02 · Other Contacts ───────────────────────────────────────────────
        SubsectionPanel(index = "02", title = "Other Contacts") {
            AuntieFieldLabel(text = "Emergency Contacts")
            Spacer(Modifier.height(8.dp))
            if (!isNew && ecBaseline.isBlankDrafts()) {
                AuntieStatusPill(label = NO_EMERGENCY_CONTACT, tone = AuntieStatusTone.Orange)
                Spacer(Modifier.height(8.dp))
            }
            // Stays live during an Add retry: the contact is the one thing a
            // retry exists to fix.
            EmergencyContactsEditor(
                drafts      = ecDrafts,
                onChange    = { i, d -> ecDrafts = ecDrafts.mapIndexed { j, x -> if (j == i) d else x } },
                onAdd       = { if (ecDrafts.size < com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX) ecDrafts = ecDrafts + EmergencyContactDraft() },
                onRemove    = { i -> ecDrafts = ecDrafts.filterIndexed { j, _ -> j != i }.ifEmpty { listOf(EmergencyContactDraft()) } },
                onMoveFirst = { i -> ecDrafts = listOf(ecDrafts[i]) + ecDrafts.filterIndexed { j, _ -> j != i } },
                enabled     = !saving,
            )
            Spacer(Modifier.height(16.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.alpha(if (householdFieldsEnabled) 1f else 0.5f),
            ) {
                BottomBorderField(
                    secondaryPhone, { secondaryPhone = it },
                    label        = "Secondary phone",
                    enabled      = householdFieldsEnabled,
                    isError      = secondaryPhoneError && attemptedSave,
                    modifier     = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(
                    secondaryEmail, { secondaryEmail = it },
                    label        = "Secondary email",
                    enabled      = householdFieldsEnabled,
                    isError      = secondaryEmailError && attemptedSave,
                    modifier     = Modifier.weight(1f),
                    keyboardType = KeyboardType.Email,
                )
            }
        }

        // 03 · Preferred contact method REMOVED (Auntie complaint, item 2). The
        // model fields stay (read by the comms reconcile pipeline) but are no longer
        // edited here; build() preserves the existing values.

        // ── 03 · Home & access (optional) ─────────────────────────────────────
        SubsectionPanel(index = "03", title = "Home & access", enabled = householdFieldsEnabled) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(gateCode, { gateCode = it }, label = "Gate / door code", enabled = householdFieldsEnabled, modifier = Modifier.weight(1f))
                BottomBorderField(parking,  { parking  = it }, label = "Parking",          enabled = householdFieldsEnabled, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(wifiName, { wifiName = it }, label = "Wi-Fi name",     enabled = householdFieldsEnabled, modifier = Modifier.weight(1f))
                BottomBorderField(wifiPass, { wifiPass = it }, label = "Wi-Fi password", enabled = householdFieldsEnabled, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(16.dp))
            MultilineField(entryNotes, { unlessLocked { entryNotes = it } }, label = "Entry notes", placeholder = "Anything Auntie should know walking up to the door", minLines = 3)
        }

        // 04/05 · Emergency contact MOVED up into Identity (item 3, now required).

        // ── 04 · Vet Clinic (optional, attaches to the HOUSEHOLD) ─────────────
        SubsectionPanel(index = "04", title = "Vet Clinic", enabled = householdFieldsEnabled) {
            VetClinicPicker(
                clinics = vetClinics,
                name = vetName,
                onNameChange = { vetName = it },
                onPick = { picked ->
                    unlessLocked {
                        vetName    = picked.name
                        vetPhone   = picked.phone
                        vetAddress = picked.address
                    }
                },
                enabled = householdFieldsEnabled,
            )
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    vetPhone, { vetPhone = it },
                    label        = "Clinic phone",
                    enabled      = householdFieldsEnabled,
                    isError      = vetPhoneError && attemptedSave,
                    modifier     = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(vetAddress, { vetAddress = it }, label = "Clinic address", enabled = householdFieldsEnabled, modifier = Modifier.weight(2f))
            }
            if (vetName.isNotBlank() && vetClinics.none { it.name.equals(vetName, ignoreCase = true) }) {
                Spacer(Modifier.height(10.dp))
                AuntieNoteCallout(
                    text = "“${vetName.trim()}” is a new clinic. Saved to the shared catalog.",
                )
            }
        }

        // ── 05 · Notes (optional) ─────────────────────────────────────────────
        SubsectionPanel(index = "05", title = "Notes", enabled = householdFieldsEnabled) {
            MultilineField(internalNotes, { unlessLocked { internalNotes = it } }, label = "Internal notes", placeholder = "Anything that doesn't belong on the dossier yet", minLines = 4)
            Spacer(Modifier.height(16.dp))
            BottomBorderField(referral, { referral = it }, label = "Referral source", enabled = householdFieldsEnabled, modifier = Modifier.fillMaxWidth())
        }

        // ── 06 · Custom fields (admin-authored KINFOLK form_schemas, Phase 14) ─
        // Only shown when a KINFOLK schema exists or a load failed; an empty panel
        // would just be noise. Answers persist into Kinfolk.formValues.
        if (kinfolkSchemas.isNotEmpty() || schemaError != null) {
            SubsectionPanel(index = "06", title = "Custom fields", enabled = householdFieldsEnabled) {
                when {
                    // Fail loud: surface a schema load failure, never swallow it.
                    schemaError != null -> AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't load the custom fields",
                    ) {
                        Text(schemaError!!, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    }
                    else -> DynamicFormFields(
                        schemas = kinfolkSchemas,
                        values = formValues,
                        onValueChange = { k, v -> unlessLocked { formValues[k] = v } },
                    )
                }
            }
        }

        // ── Household notes from dossier (K3: clear-from-dossier lives here) ───
        // Admin-internal. Shows the free-text dossier.householdNotes blob + the gap
        // list, with the "Clear from dossier" action. Hides itself once cleared
        // (dossierStream re-emits ""). No household-data nav from here, so that
        // button is hidden (onOpenHousehold = null).
        val dossierNotes = (dossier as? FirestoreResult.Data)?.value?.householdNotes.orEmpty()
        if (!isNew && !kinfolkId.isNullOrBlank() && dossierNotes.isNotBlank()) {
            HouseholdNotesMigrationBox(
                notes = dossierNotes,
                household = householdData,
                onClear = { client.clearDossierHouseholdNotes(kinfolkId) },
                scope = scope,
            )
            Spacer(Modifier.height(20.dp))
        }

        // ── Archive block (edit path only; absent on create) ──────────────────
        if (!isNew && existing != null) {
            ArchivePanel(
                kinfolkName = existing.displayName,
                archived    = existing.status == "archived",
                disabled    = saving,
                onArchive   = {
                    saving = true
                    scope.launch {
                        val r = client.archiveKinfolk(existing._id)
                        saving = false
                        when (r) {
                            is WriteResult.Ok  -> {
                                AuditLog.fire(
                                    scope            = scope,
                                    client           = client,
                                    actorId          = "",
                                    actionType       = "ARCHIVE_KINFOLK",
                                    description      = "Archived ${existing.displayName}",
                                    targetId         = existing._id,
                                    targetCollection = "kinfolk",
                                )
                                showToast("Archived ${existing.displayName}.", ToastKind.Success); onArchived()
                            }
                            is WriteResult.Err -> showToast("Archive failed: ${r.message}", ToastKind.Error)
                        }
                    }
                },
            )
            Spacer(Modifier.height(20.dp))
        }

        // Sticky-style save bar (SUGGESTION). Save disabled while a write is in
        // flight; canSave is still enforced inside onSave with a fail-loud toast.
        // #829: pessimistic save with a visible cue while the write is in flight;
        // after a failed contact save on Add, the button says what the retry does.
        AuntieSaveBar(
            dirty       = dirty,
            saveEnabled = !saving,
            onCancel    = onBack,
            onSave      = { onSave() },
            saveLabel   = when {
                saving && createdKinfolkId != null -> "Saving…"
                saving && isNew                    -> "Adding…"
                saving                             -> "Saving…"
                createdKinfolkId != null           -> "Save Emergency Contact"
                isNew                              -> "Create Kinfolk"
                else                               -> "Save changes"
            },
        )
    }
}

/**
 * One Den subsection panel: a frosted glass card with a numbered mono legend.
 * (Run 4: the required / optional advisory pills were removed.)
 */
@Composable
private fun SubsectionPanel(
    index: String,
    title: String,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    // #829: a locked panel (Add retry, or a save in flight) dims, the cue for
    // controls with no `enabled` state of their own.
    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.5f)) {
        Column(modifier = Modifier.fillMaxWidth().padding(22.dp)) {
            AuntieFieldLabel(text = title, index = index)
            Spacer(Modifier.height(14.dp))
            content()
        }
    }
    Spacer(Modifier.height(16.dp))
}

/**
 * Service-address field with Mapbox Search Box autocomplete. Debounces user
 * input by 250ms, then queries the `/api/mapbox/sign-search` Firebase
 * Function (which holds the secret access token). On suggestion click we
 * call `/api/mapbox/retrieve` with the same Mapbox session token so the
 * suggest+retrieve pair counts as a single Mapbox billing session.
 *
 * Errors fail loud (Cloudinary-style red banner) to honor the project's
 * "never fake, never silently swallow" policy.
 */
@Composable
private fun AddressAutofillField(
    value: String,
    onValueChange: (String) -> Unit,
    scope: CoroutineScope,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val mapbox = remember { MapboxClient() }

    // Stable per-session token (random hex) reused across keystrokes until
    // the user picks a suggestion or clears the field. Mapbox docs:
    // https://docs.mapbox.com/api/search/search-box/#session-billing
    var sessionToken by remember {
        mutableStateOf(generateMapboxSessionToken())
    }

    var suggestions  by remember { mutableStateOf<List<MapboxSuggestion>>(emptyList()) }
    var loading      by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var lastQuery    by remember { mutableStateOf("") }
    var suppressOnce by remember { mutableStateOf(false) }

    // Debounced query. Fires 250ms after the last keystroke if value > 2 chars.
    LaunchedEffect(value) {
        if (suppressOnce) {
            suppressOnce = false
            return@LaunchedEffect
        }
        val trimmed = value.trim()
        if (trimmed.length < 3) {
            suggestions = emptyList(); errorMessage = null; lastQuery = trimmed
            return@LaunchedEffect
        }
        if (trimmed == lastQuery) return@LaunchedEffect
        delay(250)
        lastQuery = trimmed
        loading = true
        errorMessage = null
        when (val r = mapbox.suggest(query = trimmed, sessionToken = sessionToken)) {
            is MapboxSuggestResult.Ok  -> { suggestions = r.suggestions }
            is MapboxSuggestResult.Err -> {
                suggestions = emptyList()
                errorMessage = r.message
            }
        }
        loading = false
    }

    BottomBorderField(
        value         = value,
        onValueChange = { onValueChange(it) },
        label         = "Service address",
        enabled       = enabled,
        modifier      = Modifier.fillMaxWidth(),
    )

    if (errorMessage != null) {
        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(c.error.copy(alpha = 0.10f))
                .border(AuntieTheme.dims.borderHairline, c.error.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text  = "Address lookup failed: $errorMessage. Type the full street address manually.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textPrimary,
            )
        }
    } else if (loading || suggestions.isNotEmpty()) {
        Spacer(Modifier.height(6.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(c.surfaceGlass)
                .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(8.dp)),
        ) {
            if (loading && suggestions.isEmpty()) {
                Text(
                    text     = "Searching…",
                    style    = AuntieTheme.typography.bodySmall,
                    color    = c.textDim,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            } else {
                suggestions.forEachIndexed { idx, s ->
                    if (idx > 0) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(AuntieTheme.dims.borderHairline)
                                .background(c.borderSoft),
                        )
                    }
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                scope.launch {
                                    when (val r = mapbox.retrieve(s.mapbox_id, sessionToken)) {
                                        is MapboxRetrieveResult.Ok  -> {
                                            suppressOnce = true
                                            onValueChange(r.feature.resolvedAddress)
                                            suggestions = emptyList()
                                            // Mapbox billing: rotate session token after retrieve.
                                            sessionToken = generateMapboxSessionToken()
                                        }
                                        is MapboxRetrieveResult.Err -> {
                                            errorMessage = r.message
                                        }
                                    }
                                }
                            }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(
                            text  = s.name.ifBlank { s.full_address },
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                        if (s.full_address.isNotBlank() && s.full_address != s.name) {
                            Text(
                                text  = s.full_address,
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * 32-char hex session token for Mapbox Search Box billing grouping. Only
 * needs uniqueness within a single search session, not crypto strength.
 */
private fun generateMapboxSessionToken(): String {
    val bytes = ByteArray(16)
    kotlin.random.Random.nextBytes(bytes)
    return bytes.joinToString("") { (it.toInt() and 0xFF).toString(16).padStart(2, '0') }
}

/**
 * Pure filter for the vet-clinic search box. Prefix matches rank first, then substring
 * matches, capped at [limit] so a 100+ clinic catalog stays a short, scannable dropdown.
 * A blank query returns nothing: the box is a search field, not a full-catalog dump.
 */
internal fun vetClinicSuggestions(query: String, clinics: List<VetClinic>, limit: Int = 8): List<VetClinic> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val starts = clinics.filter { it.name.lowercase().startsWith(q) }
    val contains = clinics.filter { !it.name.lowercase().startsWith(q) && it.name.lowercase().contains(q) }
    return (starts + contains).take(limit)
}

/**
 * Searchable vet-clinic picker. Replaces the old 114-wide horizontal chip scroll: the
 * operator types into the clinic-name field and matching shared-catalog clinics drop down
 * inline; picking one autofills name / phone / address. Free text that matches nothing stays
 * a new clinic (the caller's "new clinic" callout handles that). Attaches to the HOUSEHOLD.
 */
@Composable
private fun VetClinicPicker(
    clinics: List<VetClinic>,
    name: String,
    onNameChange: (String) -> Unit,
    onPick: (VetClinic) -> Unit,
    enabled: Boolean = true,
) {
    val matches = if (enabled) vetClinicSuggestions(name, clinics) else emptyList()
    val exact = clinics.any { it.name.equals(name.trim(), ignoreCase = true) }
    Column(Modifier.fillMaxWidth()) {
        BottomBorderField(
            value = name,
            onValueChange = onNameChange,
            enabled = enabled,
            label = "Clinic name",
            placeholder = if (clinics.isEmpty()) "" else "Type to search ${clinics.size} clinics",
            modifier = Modifier.fillMaxWidth(),
        )
        if (matches.isNotEmpty() && !exact) {
            Spacer(Modifier.height(8.dp))
            GlassSurface(cornerRadius = 14.dp, modifier = Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 240.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    matches.forEach { clinic ->
                        VetClinicSuggestionRow(clinic, onClick = { onPick(clinic) })
                    }
                }
            }
        }
    }
}

@Composable
private fun VetClinicSuggestionRow(clinic: VetClinic, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val detail = listOf(clinic.phone, clinic.address).filter { it.isNotBlank() }.joinToString(" · ")
    Column(
        Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(clinic.name, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        if (detail.isNotBlank()) {
            Text(detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

/**
 * Edit-only Archive block, in a Den glass panel matching the form subsections.
 * Copy and behavior verbatim from the original ArchiveBlock.
 */
@Composable
private fun ArchivePanel(
    kinfolkName: String,
    archived: Boolean,
    disabled: Boolean,
    onArchive: () -> Unit,
) {
    val c = AuntieTheme.colors
    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text  = if (archived) "Already archived" else "Archive this Kinfolk",
                style = AuntieTheme.typography.titleMedium,
                color = c.textPrimary,
            )
            Text(
                text  = if (archived) "$kinfolkName is currently archived. They no longer show in the active Directory."
                        else            "Archiving keeps history but hides $kinfolkName from the active Directory. Reversible.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            if (!archived) {
                Spacer(Modifier.height(6.dp))
                GhostButton(label = "Archive", onClick = onArchive, enabled = !disabled, modifier = Modifier.fillMaxWidth())
            }
        }
    }
    Spacer(Modifier.height(16.dp))
}
