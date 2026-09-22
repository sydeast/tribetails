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
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.NO_EMERGENCY_CONTACT
import com.tribetails.auntieos.web.ui.components.AuntieInfoTip
import com.tribetails.auntieos.web.data.draftsEqual
import com.tribetails.auntieos.web.data.emergencyContactsOf
import com.tribetails.auntieos.web.data.kinfolkChanges
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
import com.tribetails.auntieos.web.data.MediaFile
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
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.rememberReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.data.AuthUser
import kotlinx.coroutines.flow.Flow
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
    /**
     * #829 review item 6: leaving Add after the household was created but its
     * Emergency Contact did not save. Receives that household's id so the caller
     * can take the operator to it; without a handler it is an ordinary back.
     */
    onLeftWithoutContact: ((kinfolkId: String) -> Unit)? = null,
    /**
     * #907 review item 1(b): the server answered Add with `duplicateOf`, a household
     * this operator added minutes ago. Nothing was written and no contact saved; what
     * was typed is kept (PendingAddKinfolk.keepDuplicate) and the caller opens that
     * household's edit screen, which fills in the differences as unsaved changes.
     */
    onDuplicate: ((kinfolkId: String) -> Unit)? = null,
    /**
     * #907 review item 4: the signed-in operator. Null uses the app's own auth
     * state; a render test passes a flow with a real uid.
     */
    authState: Flow<AuthUser?>? = null,
) {
    val client = remember { FirestoreClient() }
    val scope  = rememberReportingScope()
    val isNew  = kinfolkId.isNullOrBlank()

    // For edits we need the live doc to pre-fill. Subscribe to the kinfolk list
    // (it's already in memory from Directory) and pluck the matching record.
    // For creates, we never read; the form starts blank.
    val reload = rememberReloadableRead()
    val state by remember(reload.generation) { client.kinfolkStream().settlesRetry(reload) }.collectAsState(initial = FirestoreResult.Loading)
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
    // #829 review: the record as this screen read it, frozen at prefill (the
    // stream keeps polling). Saves build from it and send only the fields that
    // differ from it; it advances to what was written after each successful save.
    var loaded by remember(kinfolkId) { mutableStateOf<Kinfolk?>(null) }

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
    // #890: the operator this Add belongs to. A household created without its
    // contact is kept under this uid (PendingAddKinfolk), so opening Add again
    // offers to continue it rather than creating a second one.
    //
    // #907 review item 4: read from the auth state's first answer, not an initial
    // null. Until it answers, Add shows a loading cue instead of choosing between
    // the Continue prompt and the form, so a pending household is never missed.
    val authFlow = remember(authState) { authState ?: AuthClient().authStateStream() }
    var operatorUid by remember { mutableStateOf<String?>(null) }
    var authSeen by remember { mutableStateOf(false) }
    LaunchedEffect(authFlow) {
        authFlow.collect { user ->
            operatorUid = user?.uid
            authSeen = true
        }
    }
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
            loaded = existing
            initialized = true
        }
    }

    // #907 review item 1(b): this household is open because Add was answered
    // `duplicateOf`. What was typed there and differs from what is stored is laid
    // over the form once, as unsaved changes; the baseline stays the stored record,
    // so Save sends only those through the normal update and Cancel drops them.
    var duplicateNotice by remember(kinfolkId) { mutableStateOf<String?>(null) }
    LaunchedEffect(initialized, authSeen) {
        val base = loaded
        if (isNew || !initialized || !authSeen || base == null) return@LaunchedEffect
        val typed = PendingAddKinfolk.duplicateFor(operatorUid, base._id) ?: return@LaunchedEffect
        PendingAddKinfolk.clearDuplicate(operatorUid)
        val h = overlayDuplicateAdd(base, typed.household)
        firstName = h.firstName; lastName = h.lastName; phoneNumber = h.phoneNumber
        secondaryPhone = h.secondaryPhone; email = h.email; secondaryEmail = h.secondaryEmail
        serviceAddr = h.serviceAddress; gateCode = h.gateCode; parking = h.parkingInstructions
        entryNotes = h.entryNotes; wifiName = h.wifiName; wifiPass = h.wifiPassword
        internalNotes = h.internalNotes; referral = h.referralSource; vetName = h.vetClinicName
        vetPhone = h.vetClinicPhone; vetAddress = h.vetClinicAddress
        formValues.clear(); formValues.putAll(h.formValues)
        if (!typed.contacts.isBlankDrafts() && !draftsEqual(typed.contacts, emergencyContactsOf(base).toDrafts())) {
            ecDrafts = typed.contacts
        }
        duplicateNotice = duplicateAddNotice(base, typed.household)
    }

    var saving       by remember { mutableStateOf(false) }
    /** #853: true while a photo upload + write is in flight, so the change-photo
     * control shows a loading cue and cannot be clicked again mid-save. */
    var photoSaving  by remember(kinfolkId) { mutableStateOf(false) }
    /** #829 review: a contact refusal or failed contact save, shown under the contact editor. */
    var ecError      by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var toast        by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind    by remember { mutableStateOf(ToastKind.Info) }

    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    /** Back and Cancel. A household created without its contact goes to [onLeftWithoutContact]. */
    fun leave() {
        val pending = createdKinfolkId
        if (pending != null && onLeftWithoutContact != null) onLeftWithoutContact(pending) else onBack()
    }

    // #829 review: trimmed fields go through keepStoredUnlessEdited, so stray
    // whitespace on file is neither shown as an unsaved change nor rewritten.
    fun build(): Kinfolk = (loaded ?: existing ?: Kinfolk(_id = kinfolkId.orEmpty())).let { base -> base.copy(
        firstName                = keepStoredUnlessEdited(firstName, base.firstName),
        lastName                 = keepStoredUnlessEdited(lastName, base.lastName),
        phoneNumber              = keepStoredUnlessEdited(phoneNumber, base.phoneNumber),
        secondaryPhone           = keepStoredUnlessEdited(secondaryPhone, base.secondaryPhone),
        email                    = keepStoredUnlessEdited(email, base.email),
        secondaryEmail           = keepStoredUnlessEdited(secondaryEmail, base.secondaryEmail),
        // preferredContactMethod / bestTimeToContact intentionally NOT overwritten
        // here (item 2: editor removed); existing values are preserved via copy().
        serviceAddress           = keepStoredUnlessEdited(serviceAddr, base.serviceAddress),
        gateCode                 = keepStoredUnlessEdited(gateCode, base.gateCode),
        parkingInstructions      = keepStoredUnlessEdited(parking, base.parkingInstructions),
        entryNotes               = entryNotes,
        wifiName                 = keepStoredUnlessEdited(wifiName, base.wifiName),
        wifiPassword             = wifiPass,
        // #829: no Emergency Contact field here. The four keys are dropped from
        // every kinfolk write (kinfolkWriteJson); contacts go through the callable.
        internalNotes            = internalNotes,
        referralSource           = keepStoredUnlessEdited(referral, base.referralSource),
        vetClinicName            = keepStoredUnlessEdited(vetName, base.vetClinicName),
        vetClinicPhone           = keepStoredUnlessEdited(vetPhone, base.vetClinicPhone),
        vetClinicAddress         = keepStoredUnlessEdited(vetAddress, base.vetClinicAddress),
        profilePictureUrl        = photoUrl,
        // The status picker exists only on Add. On edit the loaded status stands,
        // so a stored blank status is not rewritten as "active" by a save.
        status                   = if (isNew) status else base.status,
        formValues               = formValues.toMap(),
    ) }

    // #890: the household Add created, kept outside this screen until its contact saves.
    fun keepPending(id: String) {
        PendingAddKinfolk.keep(operatorUid, PendingKinfolk(kinfolkId = id, household = build(), contacts = ecDrafts))
    }

    /** #890: Continue. The form comes back as it was saved, locked, with the contact as last typed. */
    fun continuePending(pending: PendingKinfolk) {
        val h = pending.household
        firstName = h.firstName; lastName = h.lastName; phoneNumber = h.phoneNumber
        secondaryPhone = h.secondaryPhone; email = h.email; secondaryEmail = h.secondaryEmail
        status = h.status.ifBlank { "active" }; serviceAddr = h.serviceAddress
        gateCode = h.gateCode; parking = h.parkingInstructions; entryNotes = h.entryNotes
        wifiName = h.wifiName; wifiPass = h.wifiPassword; internalNotes = h.internalNotes
        referral = h.referralSource; vetName = h.vetClinicName; vetPhone = h.vetClinicPhone
        vetAddress = h.vetClinicAddress; photoUrl = h.profilePictureUrl
        formValues.clear(); formValues.putAll(h.formValues)
        ecDrafts = pending.contacts.ifEmpty { listOf(EmergencyContactDraft()) }
        createdKinfolkId = pending.kinfolkId
    }

    /**
     * #890: Discard. Nothing is written; the household stays as created, with its No
     * Emergency Contact flag. #907 review item 1(a): its id is recorded, and the next
     * create sends it as `ignoreDuplicateOf`, because Discard says the next Add is a
     * new household.
     */
    fun discardPending() {
        PendingAddKinfolk.get(operatorUid)?.let { PendingAddKinfolk.discard(operatorUid, it.kinfolkId) }
        PendingAddKinfolk.clear(operatorUid)
    }

    // #890: asked when Add opens on a household still waiting on its contact.
    // Never while saving: the save keeps the household the moment it is created,
    // before `createdKinfolkId` is set, and the form must stay on screen meanwhile.
    val offeredPending = if (isNew && !saving && createdKinfolkId == null) PendingAddKinfolk.get(operatorUid) else null

    // #890: keeps the pending household's contact current while a retry is edited.
    LaunchedEffect(ecDrafts, createdKinfolkId) {
        val id = createdKinfolkId
        if (isNew && id != null) keepPending(id)
    }

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

    // Live unsaved-changes indicator for the sticky save bar. It drives only the
    // pip + label and never gates the save itself.
    //
    // #829 review: computed on every recomposition from the SAME diff the save
    // sends (kinfolkChanges against the loaded record), so the indicator and the
    // write can never disagree. It used to be a `remember` keyed on a hand-kept
    // list of fields that left out `formValues`, so editing only a custom field
    // never lit it and the operator could leave believing the change was saved.
    // build() reads every form state, the custom-field map included, so
    // Compose recomputes this whenever any of them changes.
    val dirty = if (isNew) {
        createdKinfolkId != null || !ecDrafts.isBlankDrafts() || formValues.values.any { it.isNotBlank() } || listOf(
            firstName, lastName, phoneNumber, secondaryPhone, email, secondaryEmail,
            serviceAddr, gateCode, parking, entryNotes, wifiName, wifiPass,
            internalNotes, referral, vetName, vetPhone, vetAddress,
        ).any { it.isNotBlank() }
    } else {
        loaded?.let { base -> kinfolkChanges(base, build()).isNotEmpty() || !draftsEqual(ecDrafts, ecBaseline) } ?: false
    }

    // Save handler shared by the sticky save bar. Behavior verbatim from the
    // original PrimaryButton onClick: gate on canSave (fail-loud toast on
    // failure), upsert any new vet clinic into the shared catalog, then
    // create / update the Kinfolk and fire the audit log.
    fun onSave() {
        // #853 review: never save while a photo write is in flight (the bar is
        // disabled too; this also covers any other path into onSave).
        if (saving || photoSaving) return
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
        val contactProblem = if (saveContacts) {
            validateEmergencyContactDrafts(ecDrafts, listOf("$firstName $lastName"), listOf(phoneNumber, secondaryPhone))
        } else null
        // Add (and an Add retry) requires a valid contact before anything is
        // written. On Edit the contact never blocks the household (#829 review
        // item 14, operator ruling): the household saves below, then the contact
        // problem is shown on the contact editor.
        if (contactBlocksSave(isNew, retryId, contactProblem) && contactProblem != null) {
            ecError = contactProblem
            showToast(contactProblem, ToastKind.Error)
            return
        }
        ecError = null
        saving = true
        scope.launch {
            val draft = build()
            val outcome = saveKinfolkWithContacts(
                retryKinfolkId = retryId,
                saveContacts   = saveContacts && contactProblem == null,
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
                    if (isNew) {
                        when (val r = client.createKinfolk(draft, PendingAddKinfolk.discardedFor(operatorUid))) {
                            // #890: kept the moment it exists, so leaving mid-save still
                            // offers it. A duplicateOf answer is a household that was
                            // already created (and audited then): nothing is logged again,
                            // nothing is kept pending, and the save stops there (#907).
                            is WriteResult.Ok  -> {
                                // The discarded id has done its job once a create is answered.
                                PendingAddKinfolk.clearDiscarded(operatorUid)
                                val duplicateOf = r.value.duplicateOf
                                if (duplicateOf == null) keepPending(r.value.kinfolkId)
                                WriteResult.Ok(HouseholdWrite(r.value.kinfolkId, wrote = duplicateOf == null, duplicateOf = duplicateOf))
                            }
                            is WriteResult.Err -> WriteResult.Err(r.message)
                        }
                    } else {
                        // #829 review: only the fields the form changed; `wrote` is
                        // false when nothing did, so no audit entry is logged.
                        when (val r = client.updateKinfolk(loaded ?: existing ?: draft, draft)) {
                            is WriteResult.Ok  -> { loaded = draft; WriteResult.Ok(HouseholdWrite(draft._id, wrote = r.value)) }
                            is WriteResult.Err -> WriteResult.Err(r.message)
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
            ecError = contactErrorAfterSave(outcome, isNew, contactProblem)
            when (outcome) {
                is KinfolkSaveOutcome.Saved -> {
                    if (contactProblem != null) {
                        // Edit: the household is saved; the contact still needs fixing
                        // and the screen stays open for it. #893 item 2: only when the
                        // household step actually wrote something - an edit whose diff
                        // was empty must not claim a save that never happened. Either
                        // way ecError (set above) already shows the contact problem.
                        if (outcome.wrote) {
                            showToast("The household is saved. The Emergency Contact still needs attention.", ToastKind.Info)
                        }
                    } else {
                        if (saveContacts) ecBaseline = ecDrafts
                        if (isNew) PendingAddKinfolk.clear(operatorUid)
                        showToast(if (isNew) "Kinfolk added." else "Saved.", ToastKind.Success)
                        onSaved(outcome.kinfolkId)
                    }
                }
                is KinfolkSaveOutcome.HouseholdFailed ->
                    showToast("Save failed: ${outcome.message}", ToastKind.Error)
                is KinfolkSaveOutcome.ContactsFailed -> {
                    if (isNew) {
                        createdKinfolkId = outcome.kinfolkId
                        keepPending(outcome.kinfolkId)
                    }
                    showToast(ecError.orEmpty(), ToastKind.Error)
                }
                // #907 review item 1(b): never "Kinfolk added." The typing goes to
                // that household's edit screen as unsaved changes.
                is KinfolkSaveOutcome.Duplicate -> {
                    val typed = PendingKinfolk(outcome.kinfolkId, draft, ecDrafts)
                    PendingAddKinfolk.clear(operatorUid)
                    PendingAddKinfolk.keepDuplicate(operatorUid, typed)
                    val openIt = onDuplicate
                    if (openIt != null) openIt(outcome.kinfolkId)
                    else showToast("${pendingHouseholdName(typed)} was already added a few minutes ago.", ToastKind.Info)
                }
                // #907 review item 2: deleted under a pending Add. Retrying would fail
                // forever, so it is dropped and the form opens for a fresh Add.
                is KinfolkSaveOutcome.HouseholdGone -> {
                    if (isNew) {
                        PendingAddKinfolk.clear(operatorUid)
                        createdKinfolkId = null
                    }
                    showToast(HOUSEHOLD_NO_LONGER_EXISTS, ToastKind.Error)
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
            onBack   = { leave() },
            breadcrumbs = if (isNew) listOf("Directory") else listOf("Directory", "Profile"),
        )

        StatusToast(visible = toastVisible, message = toast, kind = toastKind, onDismiss = { toastVisible = false })

        // #907 review item 4: Add waits for the operator before it can know whether
        // one of their households is waiting on its contact.
        if (isNew && !authSeen) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 56.dp) }
            }
            return@ScreenScaffold
        }

        // #890: Add opened on a household still waiting on its Emergency Contact.
        // The form is not shown until the operator chooses.
        if (offeredPending != null) {
            val name = pendingHouseholdName(offeredPending)
            AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.UserPlus) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text  = "$name was created, but the Emergency Contact did not save. The household shows $NO_EMERGENCY_CONTACT until it is saved.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textPrimary,
                    )
                    Text(
                        text  = "Discard starts a new Add and leaves $name as it is.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        PrimaryButton(label = "Continue adding the Emergency Contact for $name", onClick = { continuePending(offeredPending) })
                        GhostButton(label = "Discard", onClick = { discardPending() })
                    }
                }
            }
            return@ScreenScaffold
        }

        // While editing, wait for the live doc to land before showing the form
        // (otherwise the user briefly sees blank fields before the prefill).
        if (!isNew && existing == null) {
            // #867: a failed read shows its error, not a shimmer that never ends.
            (state as? FirestoreResult.Error)?.let {
                LoadErrorBanner("Couldn't load this household", it.message, onRetry = reload::retry, retrying = reload.retrying)
                return@ScreenScaffold
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 56.dp) }
            }
            return@ScreenScaffold
        }

        duplicateNotice?.let { notice ->
            AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.UserCog) {
                Text(
                    text  = notice,
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
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
                    text = when {
                        photoSaving        -> "Uploading…"
                        photoUrl.isBlank() -> "Add photo"
                        else               -> "Change photo"
                    },
                    style = AuntieTheme.typography.labelLarge,
                    color = if (photoSaving) AuntieTheme.colors.textDim else AuntieTheme.colors.primary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(enabled = !photoSaving) {
                            val base = loaded ?: existing
                            if (base == null) {
                                showToast("Photo update failed: record not loaded yet.", ToastKind.Error)
                            } else {
                                photoSaving = true
                                val previousUrl = photoUrl
                                scope.launch {
                                    runKinfolkPhotoUploadPipeline(
                                        previousUrl = previousUrl,
                                        upload      = { client.uploadMedia(kinfolkId, "KINFOLK", ByteArray(0), "") },
                                        write       = { url -> writeKinfolkPhoto(client, base, url) },
                                        onPhotoUrl  = { photoUrl = it },
                                        onLoaded    = { loaded = kinfolkBaselineAfterPhotoWrite(loaded, it) },
                                        onToast     = { (msg, kind) -> showToast(msg, kind) },
                                    )
                                    photoSaving = false
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
            // #829 review item 14: the section title with the who-gets-called
            // tip beside it (a tap opens it), as on every client.
            Row(verticalAlignment = Alignment.CenterVertically) {
                AuntieFieldLabel(text = "Emergency Contacts")
                AuntieInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED)
            }
            Spacer(Modifier.height(8.dp))
            if (!isNew && ecBaseline.isBlankDrafts()) {
                AuntieStatusPill(label = NO_EMERGENCY_CONTACT, tone = AuntieStatusTone.Orange, compact = true)
                Spacer(Modifier.height(8.dp))
            }
            // Stays live during an Add retry: the contact is the one thing a
            // retry exists to fix.
            EmergencyContactsEditor(
                drafts      = ecDrafts,
                onChange    = { i, d -> ecDrafts = ecDrafts.mapIndexed { j, x -> if (j == i) d else x }; ecError = null },
                onAdd       = { if (ecDrafts.size < com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX) ecDrafts = ecDrafts + EmergencyContactDraft(); ecError = null },
                onRemove    = { i -> ecDrafts = ecDrafts.filterIndexed { j, _ -> j != i }.ifEmpty { listOf(EmergencyContactDraft()) }; ecError = null },
                onMoveFirst = { i -> ecDrafts = listOf(ecDrafts[i]) + ecDrafts.filterIndexed { j, _ -> j != i }; ecError = null },
                enabled     = !saving,
            )
            ecError?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.error)
            }
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

        // Emergency Contacts live in "02 · Other Contacts" (#829).

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
            // #853 review: also held while a photo upload + write is in flight.
            saveEnabled = !saving && !photoSaving,
            onCancel    = { leave() },
            onSave      = { onSave() },
            saveLabel   = when {
                photoSaving                        -> "Uploading photo…"
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

/**
 * #853: the write behind a Kinfolk photo change. [base] is always the
 * last-loaded record ([loaded] or [existing]), never the live form draft, so
 * whatever the operator has typed elsewhere on the screen cannot ride along
 * with the photo. Sent through [FirestoreClient.updateKinfolk] as a merge
 * naming only `profilePictureUrl`.
 */
internal suspend fun writeKinfolkPhoto(client: FirestoreClient, base: Kinfolk, url: String): WriteResult<Kinfolk> {
    val edited = base.copy(profilePictureUrl = url)
    return when (val w = client.updateKinfolk(base, edited)) {
        is WriteResult.Ok  -> WriteResult.Ok(edited)
        is WriteResult.Err -> WriteResult.Err(w.message)
    }
}

/**
 * #853 review: the unsaved-changes baseline after a photo write lands. Only
 * `profilePictureUrl` is taken from [written]; every other field stays as
 * [current] holds it, so a Save that completed while the upload was running
 * (and moved the baseline to its draft) is not rolled back to the record
 * captured when the photo was clicked.
 */
internal fun kinfolkBaselineAfterPhotoWrite(current: Kinfolk?, written: Kinfolk): Kinfolk =
    current?.copy(profilePictureUrl = written.profilePictureUrl) ?: written

/**
 * #853: the photo-change pipeline behind KinfolkEditScreen's "Change photo"
 * control, extracted so a fake [upload]/[write] can drive every outcome
 * without a live Cloudinary upload or Firestore write (mirrors
 * `runAvatarUploadPipeline` in SettingsScreen.kt). The preview is set
 * optimistically once the upload succeeds and reverted to [previousUrl] if
 * the write then fails; "Photo updated." shows only once the write itself
 * comes back Ok, never on upload success alone.
 */
internal suspend fun runKinfolkPhotoUploadPipeline(
    previousUrl: String,
    upload: suspend () -> WriteResult<MediaFile>,
    write: suspend (url: String) -> WriteResult<Kinfolk>,
    onPhotoUrl: (String) -> Unit,
    onLoaded: (Kinfolk) -> Unit,
    onToast: (Pair<String, ToastKind>) -> Unit,
) {
    when (val up = upload()) {
        is WriteResult.Err -> onToast("Photo upload failed: ${up.message}" to ToastKind.Error)
        is WriteResult.Ok -> {
            val url = up.value.storageUrl
            if (url.isBlank()) {
                onToast("No photo selected" to ToastKind.Error)
                return
            }
            onPhotoUrl(url)
            when (val w = write(url)) {
                is WriteResult.Ok -> {
                    onLoaded(w.value)
                    onToast("Photo updated." to ToastKind.Success)
                }
                is WriteResult.Err -> {
                    // The file is already in Cloudinary + media_files (it shows in
                    // Gallery), so say so: a plain "update failed" invites a retry
                    // that uploads a duplicate. Matches admin Android.
                    onPhotoUrl(previousUrl)
                    onToast("Photo uploaded but save failed: ${w.message}" to ToastKind.Error)
                }
            }
        }
    }
}
