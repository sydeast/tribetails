package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.SchemaFormRenderer
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.config.BusinessContact
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.CONTACT_LABEL_MAX
import com.kinfolk.portal.portal.CONTACT_NAME_MAX
import com.kinfolk.portal.portal.CONTACT_PHONE_MAX
import com.kinfolk.portal.portal.CustomField
import com.kinfolk.portal.portal.DEFAULT_CONTACT_LABEL
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.portal.HomeAccess
import com.kinfolk.portal.portal.HouseholdContact
import com.kinfolk.portal.portal.MapboxSuggestion
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeProfileResult
import com.kinfolk.portal.portal.VetClinic
import com.kinfolk.portal.portal.metaLine
import com.kinfolk.portal.portal.newMapboxSessionToken
import com.kinfolk.portal.screens.gallery.isPermissionDenied
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.openExternalUrl
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Tribe Profile settings, per ui-ideas/mytribe-tribe-2026-05-31.html: a
 * "Household settings" hero band, then stacked glass cards (Family, Home
 * Information, Vet Clinic) with icon card-heads. Field pairs sit side by side
 * at the 880dp shell breakpoint and stack below it. All load/save wiring is
 * unchanged — this screen is the single writer for tribe profile + home access.
 */
@Composable
fun TribeScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<TribeProfileResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    /** #868: a partial result is a failure that does not start "Save failed", so the colour is carried, not read off the text. */
    var statusOk by remember { mutableStateOf(true) }

    var displayName by remember { mutableStateOf("") }
    var profileFields by remember { mutableStateOf<List<CustomField>>(emptyList()) }
    var gateCode by remember { mutableStateOf("") }
    var keyLocation by remember { mutableStateOf("") }
    var wifi by remember { mutableStateOf("") }
    var accessFields by remember { mutableStateOf<List<CustomField>>(emptyList()) }
    var saving by remember { mutableStateOf(false) }

    /** Optional admin-driven schemas. When present, schema-rendered values replace static fields. */
    var profileSchema by remember { mutableStateOf<FormSchema?>(null) }
    var homeSchema by remember { mutableStateOf<FormSchema?>(null) }
    var profileValues by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var homeValues by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var vetClinics by remember { mutableStateOf<List<VetClinic>>(emptyList()) }
    var vetName by remember { mutableStateOf("") }
    var vetPhone by remember { mutableStateOf("") }
    var vetAddress by remember { mutableStateOf("") }
    // After-hours emergency vet (gated). Stored in HomeAccess customFields under
    // stable keys so no backend change is needed.
    var afterHoursVetName by remember { mutableStateOf("") }
    var afterHoursVetPhone by remember { mutableStateOf("") }
    // #829: Emergency Contacts live in their own card over their own callables.
    // This flag only says the card holds edits its own Save has not sent, because
    // Save Changes below never sends contacts.
    var emergencyContactsDirty by remember { mutableStateOf(false) }

    LaunchedEffect(kinfolkId) {
        try {
            val r = portalApi.getMyTribeProfile(kinfolkId)
            loaded = r
            displayName = r.profile.displayName
            profileFields = r.profile.customFields
            gateCode = r.homeAccess.gateCode.orEmpty()
            keyLocation = r.homeAccess.keyLocation.orEmpty()
            wifi = r.homeAccess.wifiPassword.orEmpty()
            accessFields = r.homeAccess.customFields
            // Seed after-hours emergency vet from the same customFields store.
            val seededHome = accessFields.associate { it.key to it.value }
            afterHoursVetName = seededHome["afterHoursVetName"].orEmpty()
            afterHoursVetPhone = seededHome["afterHoursVetPhone"].orEmpty()
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load Tribe profile"
        }
        // Best-effort schema loads — fall back silently to static UI if missing.
        try {
            val ps = portalApi.getFormSchema("tribeProfile")
            profileSchema = ps
            // Seed values from existing customFields + displayName.
            val seeded = mutableMapOf<String, String>()
            seeded["displayName"] = displayName
            profileFields.forEach { seeded[it.key] = it.value }
            profileValues = seeded
        } catch (_: Throwable) { /* admin hasn't set up schema yet — keep static fields */ }
        // Load shared vet clinic catalog (best-effort) + seed current values
        // from existing customFields if previously set.
        try {
            vetClinics = portalApi.getVetClinics()
        } catch (_: Throwable) { /* catalog unreachable — fall back to manual entry */ }
        val seededVet = profileFields.associate { it.key to it.value }
        vetName    = seededVet["vetClinicName"].orEmpty()
        vetPhone   = seededVet["vetClinicPhone"].orEmpty()
        vetAddress = seededVet["vetClinicAddress"].orEmpty()

        try {
            val hs = portalApi.getFormSchema("homeAccess")
            homeSchema = hs
            val seeded = mutableMapOf<String, String>()
            seeded["gateCode"] = gateCode
            seeded["keyLocation"] = keyLocation
            seeded["wifiPassword"] = wifi
            accessFields.forEach { seeded[it.key] = it.value }
            homeValues = seeded
        } catch (_: Throwable) { /* same fallback */ }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            // Hero band: mono kicker + serif title (pink "Profile"), per mockup.
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
            ) {
                Text("HOUSEHOLD SETTINGS", style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange))
                Text(
                    text = buildAnnotatedString {
                        append("Tribe ")
                        withStyle(SpanStyle(color = KinfolkBrand.PackPink)) { append("Profile") }
                    },
                    style = type.heritageDisplay,
                )
                Text(
                    text = "The details your Aunties rely on when they visit. Keep names, home access, and your vet handy so every drop in goes smoothly.",
                    style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                )
            }

            ContactAuntieCard(portalApi = portalApi)

            if (loaded == null && error == null) {
                Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l), contentAlignment = Alignment.Center) {
                    KinSpinner()
                }
                return@Column
            }
            if (error != null) {
                Text(
                    error!!,
                    style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                    modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
                )
                return@Column
            }

            // #868: may this viewer see and change the home details. Primary kinfolk
            // and staff always may; a secondary kinfolk only with the Home access
            // grant. The server sends no home values without it.
            val canEditHome = loaded?.canEditHomeDetails ?: true

            // Profile section — admin schema (when present) drives the form; otherwise static fields.
            val ps = profileSchema
            if (ps != null) {
                SchemaFormRenderer(
                    schema = ps,
                    values = profileValues,
                    onChange = { profileValues = it },
                )
            } else {
                GlassCard(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    contentPadding = PaddingValues(KinfolkSpacing.l),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        CardHead(
                            icon = Icons.Filled.Groups,
                            tint = KinfolkBrand.KinfolkOrange,
                            title = "Family",
                            sub = "How your household shows up across MyTribe.",
                        )
                        KinField(
                            value = displayName,
                            onValueChange = { displayName = it },
                            label = "Family Display Name",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        // Save is gated on a display name; say so instead of a
                        // silently dead button.
                        if (displayName.isBlank()) {
                            Text(
                                "Add a display name to save.",
                                style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                            )
                        }
                        val hasProfileExtras =
                            profileFields.any { it.label.isNotBlank() || it.value.isNotBlank() }
                        if (hasProfileExtras) {
                            CardDivider()
                            Text("PROFILE FIELDS", style = type.sansMeta)
                        }
                        CustomFieldList(
                            fields = profileFields,
                        )
                    }
                }
            }

            val hs = homeSchema
            if (!canEditHome) {
                GlassCard(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    contentPadding = PaddingValues(KinfolkSpacing.l),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        CardHead(
                            icon = Icons.Filled.Home,
                            tint = KinfolkBrand.KinTeal,
                            title = "Home Information",
                            sub = "Shared only with the Aunties booked for your visits.",
                        )
                        Text(
                            HOME_DETAILS_LOCKED,
                            style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                            modifier = Modifier.testTag("home-locked"),
                        )
                    }
                }
            } else if (hs != null) {
                SchemaFormRenderer(
                    schema = hs,
                    values = homeValues,
                    onChange = { homeValues = it },
                )
            } else {
                GlassCard(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    contentPadding = PaddingValues(KinfolkSpacing.l),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        CardHead(
                            icon = Icons.Filled.Home,
                            tint = KinfolkBrand.KinTeal,
                            title = "Home Information",
                            sub = "Shared only with the Aunties booked for your visits.",
                        )
                        FieldPair(
                            wide = wide,
                            first = { m ->
                                KinField(
                                    value = gateCode,
                                    onValueChange = { gateCode = it },
                                    label = "Gate / Door Code",
                                    modifier = m,
                                )
                            },
                            second = { m ->
                                KinField(
                                    value = keyLocation,
                                    onValueChange = { keyLocation = it },
                                    label = "Key Location",
                                    singleLine = false,
                                    modifier = m,
                                )
                            },
                        )
                        KinField(
                            value = wifi,
                            onValueChange = { wifi = it },
                            label = "Wi-Fi Password",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        val hasHomeExtras =
                            accessFields.any { it.label.isNotBlank() || it.value.isNotBlank() }
                        if (hasHomeExtras) {
                            CardDivider()
                            Text("CUSTOM HOME FIELDS", style = type.sansMeta)
                        }
                        CustomFieldList(
                            fields = accessFields,
                        )
                    }
                }
            }

            VetClinicSection(
                portalApi = portalApi,
                clinics = vetClinics,
                name = vetName, phone = vetPhone, address = vetAddress,
                onPick = { c -> vetName = c.name; vetPhone = c.phone; vetAddress = c.address },
                onName = { vetName = it },
                onPhone = { vetPhone = it },
                onAddress = { vetAddress = it },
                showAfterHours = true,
                // #868: stored with the home details, behind the same grant.
                afterHoursLocked = !canEditHome,
                afterHoursName = afterHoursVetName,
                afterHoursPhone = afterHoursVetPhone,
                onAfterHoursName = { afterHoursVetName = it },
                onAfterHoursPhone = { afterHoursVetPhone = it },
                wide = wide,
            )

            // Emergency Contacts (#829): its own callables and its own Save. Read-only
            // with the #844 sentence when the caller lacks Home access.
            EmergencyContactsCard(
                kinfolkId = kinfolkId,
                portalApi = portalApi,
                onDirtyChange = { emergencyContactsDirty = it },
            )

            // Household members: edit an existing secondary's permissions.
            HouseholdMembersCard(kinfolkId = kinfolkId, portalApi = portalApi)

            // Secondary Kinfolk invite — moved here from Account settings.
            SecondaryInviteCard(kinfolkId = kinfolkId, portalApi = portalApi)

            // Contacts with no account, directly under the invite, because the
            // difference between the two is the point and it reads fastest side
            // by side (#818).
            HouseholdContactsCard(kinfolkId = kinfolkId, portalApi = portalApi)

            if (status != null) {
                // #868: coloured by outcome. A partial result ("Family and Vet
                // Clinic saved. Home Information ... did not save") is a failure.
                val statusColor = if (statusOk) KinfolkBrand.KinTeal else KinfolkBrand.SnuggleCoral
                Row(modifier = Modifier.padding(horizontal = KinfolkSpacing.l)) {
                    Row(
                        modifier = Modifier
                            .clip(KinfolkShapes.pill)
                            .background(statusColor.copy(alpha = 0.12f))
                            .border(1.dp, statusColor.copy(alpha = 0.22f), KinfolkShapes.pill)
                            .padding(horizontal = KinfolkSpacing.m, vertical = KinfolkSpacing.s),
                        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(statusColor))
                        Text(status!!, style = type.sansMeta.copy(color = statusColor))
                    }
                }
            }
            KinButton(
                label = if (saving) "Saving…" else "Save Changes",
                onClick = {
                    saving = true
                    status = null
                    scope.launch {
                        var profileHalf: SaveHalf = SaveHalf.Skipped
                        var homeHalf: SaveHalf = SaveHalf.Skipped
                        try {
                            // #873: both saves start from the stored rows and change only
                            // the rows this screen edits (schema fields and the vet cards).
                            // The callables merge by key, so an omitted row is KEPT, and a
                            // blank card field is removed by naming it. The old rebuild from
                            // schema keys deleted every office-set row on save.
                            // Emergency Contacts are not here (#829): the card saves them
                            // through saveEmergencyContacts, and their rows are never sent.
                            val profileSet = mutableListOf<CustomField>()
                            val profileClear = mutableListOf<String>()
                            fun card(key: String, label: String, value: String, set: MutableList<CustomField>, clear: MutableList<String>) {
                                if (value.isNotBlank()) set += CustomField(key = key, label = label, value = value.trim()) else clear += key
                            }
                            card("vetClinicName", "Vet Clinic", vetName, profileSet, profileClear)
                            card("vetClinicPhone", "Vet Clinic Phone", vetPhone, profileSet, profileClear)
                            card("vetClinicAddress", "Vet Clinic Address", vetAddress, profileSet, profileClear)
                            val ps = profileSchema
                            val nextDisplayName = if (ps != null) {
                                profileValues["displayName"]?.trim().orEmpty().ifBlank { displayName.trim() }
                            } else {
                                displayName.trim()
                            }
                            ps?.sections?.flatMap { it.fields }?.filter { it.key != "displayName" }?.forEach { f ->
                                schemaFieldRow(profileFields, f.key, f.label, profileValues[f.key])?.let { profileSet += it }
                            }
                            val profileEdit = editCustomFields(profileFields, profileSet, profileClear, LEGACY_EMERGENCY_CONTACT_KEYS)
                            // #868: the two halves are separate callables and either can
                            // be refused on its own, so each is attempted and reported.
                            profileHalf = try {
                                portalApi.saveTribeProfile(
                                    kinfolkId = kinfolkId,
                                    displayName = nextDisplayName,
                                    customFields = profileEdit.customFields,
                                    removeCustomFieldKeys = profileEdit.removeKeys,
                                )
                                SaveHalf.Saved
                            } catch (t: Throwable) {
                                SaveHalf.Failed(t)
                            }

                            // #868: saveHomeAccess needs Home access. Without it the home
                            // details are locked and never sent; with it they are sent only
                            // when this Save changes them, so a Family-only edit makes no
                            // home access call.
                            val loadedHome = loaded?.homeAccess
                            if (!canEditHome || loadedHome == null) return@launch

                            val homeSet = mutableListOf<CustomField>()
                            val homeClear = mutableListOf<String>()
                            card("afterHoursVetName", "After-hours Clinic", afterHoursVetName, homeSet, homeClear)
                            card("afterHoursVetPhone", "After-hours Phone", afterHoursVetPhone, homeSet, homeClear)
                            val hsSave = homeSchema
                            val gc: String?
                            val kl: String?
                            val wf: String?
                            if (hsSave != null) {
                                gc = homeValues["gateCode"]?.trim()?.ifBlank { null } ?: gateCode.trim().ifBlank { null }
                                kl = homeValues["keyLocation"]?.trim()?.ifBlank { null } ?: keyLocation.trim().ifBlank { null }
                                wf = homeValues["wifiPassword"]?.trim()?.ifBlank { null } ?: wifi.trim().ifBlank { null }
                                hsSave.sections.flatMap { it.fields }
                                    .filter { it.key != "gateCode" && it.key != "keyLocation" && it.key != "wifiPassword" }
                                    .forEach { f -> schemaFieldRow(accessFields, f.key, f.label, homeValues[f.key])?.let { homeSet += it } }
                            } else {
                                gc = gateCode.trim().ifBlank { null }
                                kl = keyLocation.trim().ifBlank { null }
                                wf = wifi.trim().ifBlank { null }
                            }
                            val homeEdit = editCustomFields(accessFields, homeSet, homeClear, LEGACY_EMERGENCY_CONTACT_KEYS)
                            if (!homeAccessEditChanged(loadedHome, gc, kl, wf, homeEdit, LEGACY_EMERGENCY_CONTACT_KEYS)) return@launch
                            homeHalf = try {
                                portalApi.saveHomeAccess(
                                    kinfolkId = kinfolkId,
                                    gateCode = gc,
                                    keyLocation = kl,
                                    wifiPassword = wf,
                                    customFields = homeEdit.customFields,
                                    removeCustomFieldKeys = homeEdit.removeKeys,
                                )
                                SaveHalf.Saved
                            } catch (t: Throwable) {
                                SaveHalf.Failed(t)
                            }
                        } catch (t: Throwable) {
                            // Neither callable reaches here: both are caught above. This is
                            // the row building around them, which used to sit under one
                            // catch-all, and an escaped throw would take this screen's
                            // scope down with it.
                            val blamed = blameUnfinishedHalf(profileHalf, homeHalf, t)
                            profileHalf = blamed.first
                            homeHalf = blamed.second
                        } finally {
                            // The card saves on its own button, so "Saved." here would be
                            // false about any contact edit still sitting in it (#829).
                            // Nothing on screen is reloaded, so an edit that did not save
                            // stays in its field.
                            val outcome = pageSaveOutcome(profileHalf, homeHalf, emergencyContactsDirty)
                            status = outcome.text
                            statusOk = outcome.ok
                            saving = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
                enabled = !saving && displayName.isNotBlank(),
            )
            if (emergencyContactsDirty) {
                Text(
                    "Your Emergency Contacts have unsaved changes.",
                    style = type.sansLabel.copy(color = KinfolkBrand.KinfolkOrange),
                    modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
                )
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

// ---- Brand building blocks (per mockup .cardhead / .grid2 / .addfield) ----

/**
 * Icon-in-tinted-tile card header with a serif title and an optional muted sub
 * line.
 *
 * [sub] DEFAULTS TO NOTHING and renders nothing when blank, per the 2026-09-11
 * ruling: "at most they can be tool tips, otherwise they are making the ui too
 * busy with unnecessary text". The existing callers keep the sentence they were
 * written with; a new card is a title and an icon.
 */
@Composable
internal fun CardHead(
    icon: ImageVector,
    tint: Color,
    title: String,
    sub: String = "",
    actions: @Composable RowScope.() -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = KinfolkSpacing.s),
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(KinfolkShapes.cardSmall)
                .background(tint.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = type.heritageSection)
            if (sub.isNotBlank()) {
                Text(sub, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
            }
        }
        actions()
    }
}

@Composable
internal fun CardDivider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = KinfolkSpacing.xs)
            .height(1.dp)
            .background(KinfolkBrand.NavyHairline),
    )
}

/** Two fields side by side at the wide breakpoint, stacked when narrow. */
@Composable
private fun FieldPair(
    wide: Boolean,
    first: @Composable (Modifier) -> Unit,
    second: @Composable (Modifier) -> Unit,
) {
    if (wide) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            first(Modifier.weight(1f))
            second(Modifier.weight(1f))
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            first(Modifier.fillMaxWidth())
            second(Modifier.fillMaxWidth())
        }
    }
}

/** Outline pill action — replaces raw OutlinedButton across this screen. */
@Composable
private fun GhostPillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    color: Color = KinfolkBrand.Navy,
) {
    val type = LocalKinfolkTypography.current
    val contentColor = if (enabled) color else KinfolkBrand.NavyMuted
    Row(
        modifier = modifier
            .clip(KinfolkShapes.pill)
            .border(1.dp, contentColor.copy(alpha = 0.45f), KinfolkShapes.pill)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = KinfolkSpacing.m, vertical = 11.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = contentColor, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(KinfolkSpacing.xs))
        }
        Text(label, style = type.sansLabel.copy(color = contentColor))
    }
}

@Composable
private fun CustomFieldList(
    fields: List<CustomField>,
) {
    val type = LocalKinfolkTypography.current
    // Keys owned by dedicated controls elsewhere on this screen (the after-hours
    // vet block) are never shown in this generic list to avoid duplicate display.
    // #829: getMyTribeProfile still serves slot 1 as emergencyContact* rows for
    // old clients; the Emergency Contacts card owns them now, so they stay hidden.
    val ownedElsewhere = setOf(
        "afterHoursVetName", "afterHoursVetPhone",
        "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation",
    )
    val visible = fields.filter { it.key !in ownedElsewhere }
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
        // Read-only: admins define fields in AuntieOS; a kinfolk cannot add them.
        // Any already-saved fields still show so no data is hidden or lost.
        if (visible.any { it.label.isNotBlank() || it.value.isNotBlank() }) {
            Text(
                "Set by your Auntie. Ask them to update these.",
                style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
            )
        }
        visible.forEach { cf ->
            if (cf.label.isNotBlank() || cf.value.isNotBlank()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (cf.label.isNotBlank()) {
                        Text(cf.label, style = type.sansMeta)
                    }
                    Text(cf.value, style = type.sansBody)
                }
            }
        }
    }
}

@Composable
private fun VetClinicSection(
    portalApi: PortalApi,
    clinics: List<VetClinic>,
    name: String,
    phone: String,
    address: String,
    onPick: (VetClinic) -> Unit,
    onName: (String) -> Unit,
    onPhone: (String) -> Unit,
    onAddress: (String) -> Unit,
    showAfterHours: Boolean = false,
    /** #868: the viewer has no Home access, so the after-hours clinic shows the lock sentence instead of fields. */
    afterHoursLocked: Boolean = false,
    afterHoursName: String = "",
    afterHoursPhone: String = "",
    onAfterHoursName: (String) -> Unit = {},
    onAfterHoursPhone: (String) -> Unit = {},
    wide: Boolean = false,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var sessionToken by remember { mutableStateOf(newMapboxSessionToken()) }
    var addressSuggestions by remember { mutableStateOf<List<MapboxSuggestion>>(emptyList()) }
    var addressLookupError by remember { mutableStateOf<String?>(null) }
    var debounceJob by remember { mutableStateOf<Job?>(null) }
    var vetQuery by remember { mutableStateOf("") }
    var submittingClinic by remember { mutableStateOf(false) }
    var submitClinicMsg by remember { mutableStateOf<String?>(null) }
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.LocalHospital,
                tint = KinfolkBrand.FamilyPurple,
                title = "Vet Clinic",
                sub = "The first call your Auntie makes if something is off.",
            )
            if (clinics.isNotEmpty()) {
                // Searchable picker over the shared catalog: type to filter by name,
                // tap a match to fill the clinic fields below.
                KinField(
                    value = vetQuery,
                    onValueChange = { vetQuery = it },
                    label = "Search vet clinics",
                    modifier = Modifier.fillMaxWidth(),
                )
                val vetMatches = remember(vetQuery, clinics) {
                    if (vetQuery.isBlank()) emptyList()
                    else clinics.filter { it.name.contains(vetQuery, ignoreCase = true) }.take(8)
                }
                vetMatches.forEach { clinic ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(KinfolkShapes.cardSmall)
                            .clickable { onPick(clinic); vetQuery = "" }
                            .padding(vertical = KinfolkSpacing.xs, horizontal = KinfolkSpacing.xs),
                    ) {
                        Text(
                            if (clinic.isEmergency) "${clinic.name} · 24hr" else clinic.name,
                            style = type.sansBody,
                        )
                        if (clinic.address.isNotBlank()) {
                            Text(clinic.address, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                        }
                    }
                }
            }
            FieldPair(
                wide = wide,
                first = { m ->
                    KinField(
                        value = name, onValueChange = onName,
                        label = "Clinic Name",
                        modifier = m,
                    )
                },
                second = { m ->
                    KinField(
                        value = phone, onValueChange = onPhone,
                        label = "Clinic Phone",
                        modifier = m,
                    )
                },
            )
            KinField(
                value = address,
                onValueChange = { v ->
                    onAddress(v)
                    debounceJob?.cancel()
                    if (v.length < 3) {
                        addressSuggestions = emptyList()
                    } else {
                        debounceJob = scope.launch {
                            delay(250)
                            try {
                                addressSuggestions = portalApi.mapboxSearch(v, sessionToken)
                                addressLookupError = null
                            } catch (t: Throwable) {
                                addressSuggestions = emptyList()
                                addressLookupError = t.message ?: "Address lookup failed"
                            }
                        }
                    }
                },
                label = "Clinic Address", singleLine = false,
                modifier = Modifier.fillMaxWidth(),
            )
            if (addressLookupError != null) {
                Text(
                    "Lookup error: ${addressLookupError ?: ""}",
                    style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                )
            }
            if (addressSuggestions.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    addressSuggestions.take(5).forEach { s ->
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(KinfolkShapes.cardSmall)
                                .clickable {
                                    scope.launch {
                                        try {
                                            val feature = portalApi.mapboxRetrieve(s.mapboxId, sessionToken)
                                            if (feature != null) {
                                                onAddress(feature.resolvedAddress)
                                            } else {
                                                onAddress(s.fullAddress.ifBlank { s.name })
                                            }
                                            addressSuggestions = emptyList()
                                            sessionToken = newMapboxSessionToken()
                                        } catch (t: Throwable) {
                                            addressLookupError = t.message ?: "Retrieve failed"
                                        }
                                    }
                                }
                                .padding(vertical = KinfolkSpacing.xs, horizontal = KinfolkSpacing.xs),
                        ) {
                            Text(s.fullAddress.ifBlank { s.name }, style = type.sansBody)
                            if (s.placeFormatted.isNotBlank()) {
                                Text(s.placeFormatted, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                            }
                        }
                    }
                }
            }
            // Add-to-shared-list: only offered when the typed clinic is genuinely
            // novel (not already in the catalog). Submits a PENDING entry the
            // operator approves in AuntieOS; the household's own vet fields are
            // saved separately by the screen's Save button regardless.
            if (!clinicAlreadyOnList(name, clinics)) {
                GhostPillButton(
                    label = if (submittingClinic) "Submitting…"
                    else "Add \"${name.trim()}\" to the shared vet list",
                    onClick = {
                        if (!submittingClinic) {
                            submittingClinic = true
                            submitClinicMsg = null
                            scope.launch {
                                try {
                                    val r = portalApi.submitVetClinic(name.trim(), phone.trim(), address.trim())
                                    submitClinicMsg = if (!r.created && !r.pending) {
                                        "That clinic is already on the shared list."
                                    } else {
                                        "Sent to Auntie for approval. It joins the shared list once approved."
                                    }
                                } catch (t: Throwable) {
                                    submitClinicMsg = "Couldn't submit: ${t.message ?: "unknown error"}"
                                } finally {
                                    submittingClinic = false
                                }
                            }
                        }
                    },
                    enabled = !submittingClinic,
                    icon = Icons.Filled.Add,
                    color = KinfolkBrand.KinTeal,
                )
                submitClinicMsg?.let { msg ->
                    Text(msg, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                }
            }
            if (showAfterHours) {
                CardDivider()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("After-hours", style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                    Spacer(Modifier.weight(1f))
                    Box(
                        modifier = Modifier
                            .clip(KinfolkShapes.pill)
                            .background(KinfolkBrand.FamilyPurple.copy(alpha = 0.13f))
                            .padding(horizontal = KinfolkSpacing.s, vertical = 3.dp),
                    ) {
                        Text("SUGGESTION", style = type.sansMeta.copy(color = KinfolkBrand.FamilyPurple))
                    }
                }
                Text(
                    "Where to go if your Kin needs care outside regular clinic hours.",
                    style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                )
                if (afterHoursLocked) {
                    Text(
                        HOME_DETAILS_LOCKED,
                        style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                        modifier = Modifier.testTag("after-hours-locked"),
                    )
                } else {
                    FieldPair(
                        wide = wide,
                        first = { m ->
                            KinField(
                                value = afterHoursName, onValueChange = onAfterHoursName,
                                label = "Emergency Clinic",
                                modifier = m,
                            )
                        },
                        second = { m ->
                            KinField(
                                value = afterHoursPhone, onValueChange = onAfterHoursPhone,
                                label = "Emergency Clinic Phone",
                                modifier = m,
                            )
                        },
                    )
                }
            }
        }
    }
}

/** #829: stored for old clients and the migration only. This screen never sends them. */
internal val LEGACY_EMERGENCY_CONTACT_KEYS = setOf("emergencyContactName", "emergencyContactPhone", "emergencyContactRelation")

/** #873: a save payload. [removeKeys] names each stored row to delete, since an omitted row is kept. */
internal data class CustomFieldEdit(val customFields: List<CustomField>, val removeKeys: List<String>)

/**
 * #873 second review. saveTribeProfile and saveHomeAccess each allow 60 saves an
 * hour per household. Starts with "Save failed" so the status line colours it as
 * a failure. Same text as portal web's PROFILE_SAVE_RATE_LIMITED_MESSAGE.
 */
internal const val PROFILE_SAVE_RATE_LIMITED_MESSAGE =
    "Save failed: this household has saved too many times in the last hour. Wait a little, then save again."

/**
 * True when a callable refused for its rate limit. Callable errors reach this
 * client as a message: the native Android SDK carries the server's message ("Too
 * many attempts. Try again later.", from lib/rateLimit.ts), and the desktop REST
 * client carries the response body with the RESOURCE_EXHAUSTED status. Same
 * approach as `isPermissionDenied`.
 */
internal fun isRateLimited(message: String?): Boolean {
    val m = message?.lowercase() ?: return false
    return "resource-exhausted" in m || "resource_exhausted" in m || "too many attempts" in m
}

/** The page-save status line for a failed saveTribeProfile or saveHomeAccess. */
internal fun profileSaveFailureMessage(t: Throwable): String =
    if (isRateLimited(t.message)) PROFILE_SAVE_RATE_LIMITED_MESSAGE else "Save failed: ${t.message ?: t}"

/**
 * #868: shown in place of the home details (Home Information and the after-hours
 * clinic) when `getMyTribeProfile` says the viewer has no Home access. The server
 * sends no values to such a viewer, so there is nothing to show read-only. Same
 * text as portal web's HOME_DETAILS_LOCKED.
 */
internal const val HOME_DETAILS_LOCKED =
    "Only someone with Home access can see or change the home details. Your primary kinfolk can give you Home access."

/** #868: what became of one half of the page Save. */
internal sealed interface SaveHalf {
    data object Saved : SaveHalf
    data object Skipped : SaveHalf
    data class Failed(val error: Throwable) : SaveHalf
}

/** #868: the page Save's status line, and whether it is a success. */
internal data class PageSaveStatus(val text: String, val ok: Boolean)

/**
 * #868: true when the home access payload would change what was loaded. The page
 * Save calls saveHomeAccess only then. Mirrors `homeAccessEditChanged` in web
 * `api/tribeApi.ts`.
 */
internal fun homeAccessEditChanged(
    loaded: HomeAccess,
    gateCode: String?,
    keyLocation: String?,
    wifiPassword: String?,
    edit: CustomFieldEdit,
    drop: Set<String> = emptySet(),
): Boolean {
    fun stored(v: String?) = v?.takeIf { it.isNotEmpty() }
    if (gateCode != stored(loaded.gateCode)) return true
    if (keyLocation != stored(loaded.keyLocation)) return true
    if (wifiPassword != stored(loaded.wifiPassword)) return true
    if (edit.removeKeys.isNotEmpty()) return true
    return edit.customFields != editCustomFields(loaded.customFields, emptyList(), emptyList(), drop).customFields
}

/**
 * #868: where an error from the row building AROUND the two callables belongs.
 * Both callables catch their own refusal, so anything left is the code that
 * assembles what they send, and it belongs to the half it was assembling for.
 * Without this the status line reads "Saved." over a save that never happened,
 * which is the bug #868 is about, pointing the other way. Mirrors
 * `blameUnfinishedHalf` in web `api/tribeApi.ts`.
 */
internal fun blameUnfinishedHalf(profile: SaveHalf, home: SaveHalf, error: Throwable): Pair<SaveHalf, SaveHalf> = when {
    profile is SaveHalf.Skipped -> SaveHalf.Failed(error) to home
    home is SaveHalf.Skipped -> profile to SaveHalf.Failed(error)
    else -> profile to home
}

/** The reason a half failed, as a sentence that says what to do, with no "Save failed:" in front. */
private fun saveFailureReason(t: Throwable): String =
    if (isRateLimited(t.message)) {
        "this household has saved too many times in the last hour. Wait a little, then save again."
    } else {
        "${(t.message ?: t.toString()).trim().trimEnd('.', ' ')}. Press Save Changes to try again."
    }

/**
 * #868: the page Save's status. The profile half (Family and Vet Clinic) and the
 * home half (Home Information and the after-hours clinic) are separate callables,
 * so one can land while the other is refused. A partial result names what saved
 * and what did not, never starts "Save failed", and is still a failure. Mirrors
 * `pageSaveOutcome` in web `api/tribeApi.ts`.
 */
internal fun pageSaveOutcome(profile: SaveHalf, home: SaveHalf, emergencyContactsDirty: Boolean): PageSaveStatus = when {
    profile is SaveHalf.Failed && home is SaveHalf.Saved -> PageSaveStatus(
        "Home Information and the after-hours clinic saved. Family and Vet Clinic did not save: " +
            "${saveFailureReason(profile.error)} Your edits there are still on this page.",
        ok = false,
    )
    profile is SaveHalf.Failed -> PageSaveStatus(profileSaveFailureMessage(profile.error), ok = false)
    home is SaveHalf.Failed -> PageSaveStatus(
        "Family and Vet Clinic saved. Home Information and the after-hours clinic did not save: " +
            "${saveFailureReason(home.error)} Your edits there are still on this page.",
        ok = false,
    )
    emergencyContactsDirty -> PageSaveStatus(
        "Profile saved. Your Emergency Contacts are not saved yet: use Save Emergency Contacts.",
        ok = true,
    )
    else -> PageSaveStatus("Saved.", ok = true)
}

/**
 * #873. The row a schema field saves, or null when the stored row stays as it is.
 * [value] null means the form never held the key. A value equal to the stored one
 * is untouched. "" over a stored value is a real clear. "" with nothing stored
 * writes no empty row. Mirrors `schemaFieldRow` in web `api/tribeApi.ts`.
 */
internal fun schemaFieldRow(stored: List<CustomField>, key: String, label: String, value: String?): CustomField? {
    if (value == null) return null
    val current = stored.firstOrNull { it.key == key }
    if (current != null) {
        return if (value == current.value) null else CustomField(key = key, label = label.ifBlank { current.label.ifBlank { key } }, value = value)
    }
    return if (value.isEmpty()) null else CustomField(key = key, label = label.ifBlank { key }, value = value)
}

/**
 * #873. The stored rows, in order, with [set] applied by key (a new key is
 * appended), every stored key in [clear] removed and named, and [drop] keys never
 * sent. A stored duplicate key folds into its first position. The full list is
 * sent so the payload is also right against a server that replaces it whole.
 * Mirrors `editCustomFields` in web `api/tribeApi.ts`.
 */
internal fun editCustomFields(
    stored: List<CustomField>,
    set: List<CustomField>,
    clear: Collection<String>,
    drop: Set<String> = emptySet(),
): CustomFieldEdit {
    val latest = LinkedHashMap<String, CustomField>()
    set.forEach { latest[it.key] = it }
    val clearKeys = clear.toSet()
    val placed = mutableSetOf<String>()
    val removed = LinkedHashSet<String>()
    val out = mutableListOf<CustomField>()
    for (row in stored) {
        if (row.key in drop) continue
        if (row.key in clearKeys) { removed += row.key; continue }
        if (!placed.add(row.key)) continue
        out += latest[row.key] ?: row
    }
    for (row in latest.values) {
        if (row.key in placed || row.key in clearKeys || row.key in drop) continue
        out += row
        placed += row.key
    }
    return CustomFieldEdit(out, removed.toList())
}

/** Normalizes a clinic name for case/space-insensitive comparison (mirrors the
 *  submitVetClinic dedupe so the "add to list" button hides for known clinics). */
internal fun normalizeClinicName(name: String): String =
    name.trim().lowercase().replace(Regex("\\s+"), " ")

/** True when [name] already matches a clinic in the shared catalog (or is blank,
 *  meaning there is nothing to add yet). Drives visibility of the "add to shared
 *  list" affordance: we only offer it for a genuinely novel, non-blank name. */
internal fun clinicAlreadyOnList(name: String, clinics: List<VetClinic>): Boolean {
    val n = normalizeClinicName(name)
    if (n.isEmpty()) return true
    return clinics.any { normalizeClinicName(it.name) == n }
}

/**
 * Household members editor. A PRIMARY sees each SECONDARY in their household and
 * toggles that secondary's access, persisting via the `updateSecondaryPermissions`
 * callable. Loads on screen entry (LaunchedEffect, not VM-init). Fail-loud: load
 * and per-member save errors surface inline.
 *
 * Four toggles are shown: "Can edit pets" (kin_edit), "Home access"
 * (home_access), "Direct messaging" (messaging_direct) and "Billing"
 * (billing_full). Billing is here per the operator ruling: "Primary kinfolk is
 * allowed to set the permissions of the secondary, including billing if they
 * want." KinTales stays uneditable because it is always on for everyone, and
 * `messaging_group` is preserved as-is on save.
 */
@Composable
private fun HouseholdMembersCard(kinfolkId: String, portalApi: PortalApi) {
    val type = LocalKinfolkTypography.current
    var members by remember { mutableStateOf<List<com.kinfolk.portal.portal.Member>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // Bumped after a successful save to re-fetch and reflect persisted state.
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(kinfolkId, reloadKey) {
        try {
            members = portalApi.listMembers(kinfolkId)
            loadError = null
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load household members"
        }
    }

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.Groups,
                tint = KinfolkBrand.FamilyPurple,
                title = "Household members",
                sub = "Adjust what each member of your Tribe can see and do.",
            )
            val list = members
            when {
                loadError != null -> Text(
                    loadError!!,
                    style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                )
                list == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.s),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }
                else -> {
                    val secondaries = list.filter { it.role != "PRIMARY" }
                    if (secondaries.isEmpty()) {
                        Text(
                            "No other members yet. Invite a partner, family member, or trusted friend below.",
                            style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                        )
                    } else {
                        secondaries.forEachIndexed { index, member ->
                            if (index > 0) CardDivider()
                            MemberPermissionRow(
                                kinfolkId = kinfolkId,
                                member = member,
                                portalApi = portalApi,
                                onSaved = { reloadKey += 1 },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** One secondary's editable-permissions block: identity line + the three access
 *  toggles + a per-member Save. Save preserves messaging_group as-is. */
@Composable
private fun MemberPermissionRow(
    kinfolkId: String,
    member: com.kinfolk.portal.portal.Member,
    portalApi: PortalApi,
    onSaved: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    // Seed each toggle from the member's current permissions. Keyed on uid so a
    // post-save reload (new Member instances) re-seeds from persisted values.
    var canEditPets by remember(member.uid) { mutableStateOf(member.permissions.kin_edit) }
    var canAccessHome by remember(member.uid) { mutableStateOf(member.permissions.home_access) }
    var canDirectMessage by remember(member.uid) { mutableStateOf(member.permissions.messaging_direct) }
    var canHandleBilling by remember(member.uid) { mutableStateOf(member.permissions.billing_full) }
    var saving by remember(member.uid) { mutableStateOf(false) }
    var msg by remember(member.uid) { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
        val title = member.secondaryLabel?.takeIf { it.isNotBlank() }
            ?: member.invitedEmail?.takeIf { it.isNotBlank() }
            ?: "Member"
        Text(title, style = type.sansBody)
        // Status + (when we have both a label and an email) the email as a subline.
        val subParts = buildList {
            member.invitedEmail?.takeIf { it.isNotBlank() && it != title }?.let { add(it) }
            add(statusLabel(member.status))
        }
        Text(subParts.joinToString(" · "), style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))

        AccessToggleRow(
            label = "Can edit pets",
            value = canEditPets,
            onChange = { canEditPets = it },
        )
        AccessToggleRow(
            label = "Home access (gate code, Wi-Fi, Emergency Contacts)",
            value = canAccessHome,
            onChange = { canAccessHome = it },
            description = HOME_ACCESS_DESCRIPTION,
        )
        AccessToggleRow(
            label = "Direct messaging",
            value = canDirectMessage,
            onChange = { canDirectMessage = it },
        )
        AccessToggleRow(
            label = "Billing (invoices, payment methods)",
            value = canHandleBilling,
            onChange = { canHandleBilling = it },
        )
        KinButton(
            label = if (saving) "Saving…" else "Save",
            onClick = {
                saving = true
                msg = null
                scope.launch {
                    try {
                        portalApi.updateSecondaryPermissions(
                            familyId = kinfolkId,
                            targetUid = member.uid,
                            billingFull = canHandleBilling,
                            messagingDirect = canDirectMessage,
                            // Preserve the secondary's existing group-messaging access:
                            // it is not exposed as a toggle here.
                            messagingGroup = member.permissions.messaging_group,
                            kinEdit = canEditPets,
                            homeAccess = canAccessHome,
                        )
                        msg = "Saved."
                        onSaved()
                    } catch (t: Throwable) {
                        msg = "Save failed: ${t.message ?: t}"
                    } finally {
                        saving = false
                    }
                }
            },
            enabled = !saving,
            modifier = Modifier.fillMaxWidth(),
        )
        msg?.let {
            val ok = it.startsWith("Saved")
            Text(
                it,
                style = type.sansLabel.copy(
                    color = if (ok) KinfolkBrand.KinTeal else KinfolkBrand.SnuggleCoral,
                ),
            )
        }
    }
}

/** Friendly label for a member status string from the callable. */
private fun statusLabel(status: String): String = when (status) {
    "ACTIVE" -> "Active"
    "SUSPENDED" -> "Suspended"
    "INVITED" -> "Invite pending"
    else -> status
}

/** Invite a secondary kinfolk (partner / family / trusted friend) to the Tribe.
 *  Moved here from Account settings; backed by the addSecondaryContact callable. */
@Composable
private fun SecondaryInviteCard(kinfolkId: String, portalApi: PortalApi) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var canEditPets by remember { mutableStateOf(false) }
    var canAccessHome by remember { mutableStateOf(false) }
    var inviting by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.Groups,
                tint = KinfolkBrand.KinTeal,
                title = "Invite a Kinfolk",
                sub = "Add a partner, family member, or trusted friend to your Tribe.",
            )
            KinField(value = email, onValueChange = { email = it }, label = "Email", modifier = Modifier.fillMaxWidth())
            KinField(value = role, onValueChange = { role = it }, label = "Their role (e.g. Co-Parent, Sister)", modifier = Modifier.fillMaxWidth())
            AccessToggleRow(
                label = "Can edit pets",
                value = canEditPets,
                onChange = { canEditPets = it },
            )
            AccessToggleRow(
                label = "Home access (gate code, Wi-Fi, Emergency Contacts)",
                value = canAccessHome,
                onChange = { canAccessHome = it },
                description = HOME_ACCESS_DESCRIPTION,
            )
            KinButton(
                label = if (inviting) "Sending…" else "Send Invite",
                onClick = {
                    inviting = true
                    msg = null
                    scope.launch {
                        try {
                            portalApi.addSecondaryContact(
                                kinfolkId = kinfolkId,
                                invitedEmail = email.trim(),
                                secondaryLabel = role.trim().ifBlank { null },
                                kinEdit = canEditPets,
                                homeAccess = canAccessHome,
                            )
                            email = ""
                            role = ""
                            canEditPets = false
                            canAccessHome = false
                            msg = "Invite sent."
                        } catch (t: Throwable) {
                            msg = "Invite failed: ${t.message ?: t}"
                        } finally {
                            inviting = false
                        }
                    }
                },
                enabled = !inviting && email.contains("@"),
                modifier = Modifier.fillMaxWidth(),
            )
            msg?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.KinTeal)) }
        }
    }
}

/**
 * The household's own contacts: people it can be reached through who hold no
 * portal account at all (#818).
 *
 * WHY THIS SITS UNDER THE INVITE. PR #817 settled the ruling — "a secondary
 * contact does not have to be a portal user. primary kinfolk user will invite a
 * second kinfolk to the household to manage and receive notifications" — and
 * built the three callables for it, then wired only the admin app. The card
 * above is an invite and is right to be: it hands somebody a sign-in. The other
 * pet parent who does not use apps, the neighbour with the key, the daughter who
 * answers the phone had nowhere in the portal to be written down, so the office
 * was told by phone and typed it in.
 *
 * THE TITLE CARRIES THE DISTINCTION. There is no `sub` on the [CardHead] here,
 * per the 2026-09-11 ruling, so the heading says what these people are and the
 * rest of the difference lives where the household is actually deciding
 * something: the hint under the email field, the empty line, and what comes back
 * after a save.
 *
 * DIFF, NOT REBUILD. The form holds a control for every field
 * `saveHouseholdContact` persists (name, label, phone, email) and for nothing
 * else; `createdAt` / `createdBy` are the server's and are never sent. So there
 * is no field this save can write at a Kotlin default, which is the failure
 * `buildKinfolkFromEditState` shipped: a rebuild that drops what the form does
 * not show. An edit seeds all four from the loaded row before anything is typed.
 *
 * NO OFFLINE VOCABULARY HERE, deliberately. #805 / #819 / #824 built the
 * queued/blocked/unknown language on the WEB portal, where React Query pauses a
 * mutation and a button can wear "Saving…" forever. This client calls straight
 * through a coroutine and a dropped request throws, which the catch below states
 * as an error. Inventing a fifth vocabulary for one card would be worse than
 * matching the six cards above it.
 */
@Composable
private fun HouseholdContactsCard(kinfolkId: String, portalApi: PortalApi) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var contacts by remember { mutableStateOf<List<HouseholdContact>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    /** True once the server has said this caller may not keep the list. */
    var denied by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    // The open editor: null closed, "" adding, a contactId editing that row.
    var editingId by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var statusIsError by remember { mutableStateOf(false) }
    /** The row a removal has been asked about but not yet confirmed. */
    var removeTarget by remember { mutableStateOf<HouseholdContact?>(null) }
    var removing by remember { mutableStateOf(false) }

    fun openEditor(contact: HouseholdContact?) {
        editingId = contact?.contactId ?: ""
        name = contact?.name ?: ""
        label = contact?.label ?: ""
        phone = contact?.phone ?: ""
        email = contact?.email ?: ""
        status = null
        statusIsError = false
    }

    fun closeEditor() {
        editingId = null
        name = ""
        label = ""
        phone = ""
        email = ""
    }

    LaunchedEffect(kinfolkId, reloadKey) {
        try {
            contacts = portalApi.listHouseholdContacts(kinfolkId)
            loadError = null
            denied = false
        } catch (t: Throwable) {
            // A refusal is a fact to state, not a failure to report as one.
            denied = isPermissionDenied(t.message)
            loadError = if (denied) null else (t.message ?: "Could not load your contacts")
            contacts = null
        }
    }

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.Phone,
                tint = KinfolkBrand.KinfolkOrange,
                title = "Contacts Without an Account",
            )

            val list = contacts
            when {
                denied -> Text(
                    "Your primary kinfolk keeps this list. Ask them to add or change a contact.",
                    style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                )

                loadError != null -> Text(
                    loadError!!,
                    style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                )

                list == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.s),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }

                else -> {
                    if (list.isEmpty()) {
                        Text(
                            "Nobody is written down yet. A contact is somebody we can phone when we can't reach " +
                                "you. They get no sign-in and see nothing.",
                            style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                        )
                    } else {
                        list.forEachIndexed { index, contact ->
                            if (index > 0) CardDivider()
                            Text(contact.name, style = type.sansLabel.copy(color = KinfolkBrand.Navy))
                            Text(contact.metaLine(), style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
                            if (removeTarget?.contactId == contact.contactId) {
                                Text(
                                    "Remove ${contact.name}? There is no account to suspend, so the row is gone.",
                                    style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                    KinGhostButton(
                                        label = if (removing) "Removing…" else "Remove",
                                        enabled = !removing,
                                        onClick = {
                                            removing = true
                                            status = null
                                            statusIsError = false
                                            scope.launch {
                                                try {
                                                    portalApi.removeHouseholdContact(contact.contactId, kinfolkId)
                                                    removeTarget = null
                                                    reloadKey += 1
                                                } catch (t: Throwable) {
                                                    statusIsError = true
                                                    status = t.message ?: "That did not work."
                                                } finally {
                                                    removing = false
                                                }
                                            }
                                        },
                                    )
                                    KinGhostButton(
                                        label = "Keep",
                                        enabled = !removing,
                                        onClick = { removeTarget = null },
                                    )
                                }
                            } else {
                                // Dead while ANY removal is in flight: one
                                // `removeTarget` is shared by every row, so
                                // switching rows mid-delete would leave the
                                // household watching the wrong one.
                                Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                    KinGhostButton(
                                        label = "Edit",
                                        enabled = !removing,
                                        onClick = { openEditor(contact) },
                                    )
                                    KinGhostButton(
                                        label = "Remove",
                                        enabled = !removing,
                                        onClick = { removeTarget = contact },
                                    )
                                }
                            }
                        }
                    }

                    if (editingId == null) {
                        KinGhostButton(
                            label = "Add a contact",
                            onClick = { openEditor(null) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        CardDivider()
                        KinField(
                            value = name,
                            onValueChange = { name = it.take(CONTACT_NAME_MAX) },
                            label = "Name",
                            fieldTestTag = "contact-name",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = label,
                            onValueChange = { label = it.take(CONTACT_LABEL_MAX) },
                            label = "What they are to your Tribe",
                            fieldTestTag = "contact-label",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Sister, Co-parent, Neighbour. Left empty it reads $DEFAULT_CONTACT_LABEL.",
                            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                        )
                        KinField(
                            value = phone,
                            onValueChange = { phone = it.take(CONTACT_PHONE_MAX) },
                            label = "Phone",
                            fieldTestTag = "contact-phone",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = email,
                            onValueChange = { email = it },
                            label = "Email",
                            fieldTestTag = "contact-email",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Optional, and it invites nobody. An address here is somewhere to reach this person.",
                            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                            KinButton(
                                label = if (saving) "Saving…" else "Save contact",
                                enabled = !saving && name.isNotBlank(),
                                onClick = {
                                    saving = true
                                    status = null
                                    statusIsError = false
                                    val typedName = name.trim()
                                    scope.launch {
                                        try {
                                            val saved = portalApi.saveHouseholdContact(
                                                kinfolkId = kinfolkId,
                                                contactId = editingId?.takeIf { it.isNotBlank() },
                                                name = name,
                                                label = label,
                                                phone = phone,
                                                email = email,
                                            )
                                            status = if (saved.created) {
                                                "$typedName is a contact on your Tribe. No portal account was created."
                                            } else {
                                                "Saved $typedName."
                                            }
                                            closeEditor()
                                            reloadKey += 1
                                        } catch (t: Throwable) {
                                            statusIsError = true
                                            status = t.message ?: "The contact was not saved."
                                        } finally {
                                            saving = false
                                        }
                                    }
                                },
                            )
                            KinGhostButton(
                                label = "Cancel",
                                enabled = !saving,
                                onClick = { closeEditor() },
                            )
                        }
                    }
                }
            }

            status?.let {
                val tone = if (statusIsError) KinfolkBrand.SnuggleCoral else KinfolkBrand.KinTeal
                Text(it, style = type.sansLabel.copy(color = tone))
            }
        }
    }
}

/**
 * #829 review item 11: what Home access grants, word for word portal web's hover
 * text on the same toggle. Shown behind an info tip, never as a subtitle.
 */
internal const val HOME_ACCESS_DESCRIPTION = "Sees and edits the household home details: entry notes and Emergency Contacts."

/** A labelled access toggle used when inviting a secondary kinfolk. The PRIMARY
 *  opts the secondary in to a specific permission (default OFF). Foundation-only
 *  track/thumb switch, mirroring the toggle used elsewhere in the app.
 *
 *  #829 review item 11: a [description] sits behind a [KinInfoTip] beside the
 *  label (a tap opens it), the way portal web shows it on hover; never a
 *  subtitle line (ruling 2026-09-11). */
@Composable
internal fun AccessToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit, description: String? = null) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.card)
            .clickable { onChange(!value) }
            .padding(vertical = KinfolkSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = type.sansBody, modifier = Modifier.weight(1f, fill = false))
            description?.let { com.kinfolk.portal.components.KinInfoTip(it) }
        }
        Box(
            modifier = Modifier
                .size(width = 44.dp, height = 24.dp)
                .clip(CircleShape)
                .background(if (value) KinfolkBrand.KinTeal else Color.White.copy(alpha = 0.18f))
                .border(1.dp, Color.White.copy(alpha = 0.18f), CircleShape)
                .clickable { onChange(!value) },
            contentAlignment = if (value) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Box(
                modifier = Modifier
                    .padding(horizontal = 2.dp)
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(Color.White),
            )
        }
    }
}

@Composable
private fun ContactAuntieCard(portalApi: PortalApi) {
    val type = LocalKinfolkTypography.current
    var contact by remember { mutableStateOf<BusinessContact?>(null) }
    LaunchedEffect(Unit) {
        try {
            contact = portalApi.getBusinessContact()
        } catch (_: Throwable) { /* leave null; card hides */ }
    }
    val c = contact ?: return
    val phone = c.phone
    val email = c.email
    if (phone.isBlank() && email.isBlank()) return

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Contact ${c.name.ifBlank { "Auntie" }}", style = type.heritageSection)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                if (phone.isNotBlank()) {
                    GhostPillButton(
                        label = "Call",
                        onClick = { openExternalUrl("tel:$phone") },
                        icon = Icons.Filled.Phone,
                        modifier = Modifier.weight(1f),
                    )
                    GhostPillButton(
                        label = "Text",
                        onClick = { openExternalUrl("sms:$phone") },
                        icon = Icons.Filled.Sms,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (email.isNotBlank()) {
                    GhostPillButton(
                        label = "Email",
                        onClick = { openExternalUrl("mailto:$email") },
                        icon = Icons.Filled.Email,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}
