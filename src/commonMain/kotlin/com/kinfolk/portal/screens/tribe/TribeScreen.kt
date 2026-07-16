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
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.SchemaFormRenderer
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.config.BusinessContact
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.CustomField
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.portal.MapboxSuggestion
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeProfileResult
import com.kinfolk.portal.portal.VetClinic
import com.kinfolk.portal.portal.newMapboxSessionToken
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
    // Emergency contact (a person to reach if we can't reach you), stored in the
    // profile customFields under stable keys — no backend change needed.
    var emergencyName by remember { mutableStateOf("") }
    var emergencyPhone by remember { mutableStateOf("") }
    var emergencyRelation by remember { mutableStateOf("") }

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
        emergencyName     = seededVet["emergencyContactName"].orEmpty()
        emergencyPhone    = seededVet["emergencyContactPhone"].orEmpty()
        emergencyRelation = seededVet["emergencyContactRelation"].orEmpty()

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
            if (hs != null) {
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
                afterHoursName = afterHoursVetName,
                afterHoursPhone = afterHoursVetPhone,
                onAfterHoursName = { afterHoursVetName = it },
                onAfterHoursPhone = { afterHoursVetPhone = it },
                wide = wide,
            )

            // Emergency contact — a person to reach if we can't reach you.
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    CardHead(
                        icon = Icons.Filled.Phone,
                        tint = KinfolkBrand.SnuggleCoral,
                        title = "Emergency Contact",
                        sub = "Who your Auntie calls if we can't reach you during a visit.",
                    )
                    FieldPair(
                        wide = wide,
                        first = { m -> KinField(value = emergencyName, onValueChange = { emergencyName = it }, label = "Contact Name", modifier = m) },
                        second = { m -> KinField(value = emergencyPhone, onValueChange = { emergencyPhone = it }, label = "Contact Phone", modifier = m) },
                    )
                    KinField(
                        value = emergencyRelation,
                        onValueChange = { emergencyRelation = it },
                        label = "Relationship (e.g. Neighbor, Sister)",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            // Household members: edit an existing secondary's permissions.
            HouseholdMembersCard(kinfolkId = kinfolkId, portalApi = portalApi)

            // Secondary Kinfolk invite — moved here from Account settings.
            SecondaryInviteCard(kinfolkId = kinfolkId, portalApi = portalApi)

            if (status != null) {
                val ok = status!!.startsWith("Saved")
                val statusColor = if (ok) KinfolkBrand.KinTeal else KinfolkBrand.SnuggleCoral
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
                        try {
                            // Build vet clinic customFields (always, regardless of schema mode).
                            val vetFields = buildList {
                                if (vetName.isNotBlank()) add(CustomField(key = "vetClinicName",    label = "Vet Clinic",        value = vetName.trim()))
                                if (vetPhone.isNotBlank()) add(CustomField(key = "vetClinicPhone",   label = "Vet Clinic Phone",  value = vetPhone.trim()))
                                if (vetAddress.isNotBlank()) add(CustomField(key = "vetClinicAddress", label = "Vet Clinic Address", value = vetAddress.trim()))
                                if (emergencyName.isNotBlank()) add(CustomField(key = "emergencyContactName", label = "Emergency Contact", value = emergencyName.trim()))
                                if (emergencyPhone.isNotBlank()) add(CustomField(key = "emergencyContactPhone", label = "Emergency Contact Phone", value = emergencyPhone.trim()))
                                if (emergencyRelation.isNotBlank()) add(CustomField(key = "emergencyContactRelation", label = "Emergency Contact Relation", value = emergencyRelation.trim()))
                            }
                            // Profile save — schema-driven path overrides static fields when schema present.
                            if (profileSchema != null) {
                                val schemaFields = profileSchema!!.sections.flatMap { it.fields }
                                val displayFromSchema = profileValues["displayName"]?.trim().orEmpty().ifBlank { displayName.trim() }
                                val rest = schemaFields
                                    .filter { it.key != "displayName" }
                                    .map { f ->
                                        CustomField(
                                            key = f.key,
                                            label = f.label,
                                            value = profileValues[f.key].orEmpty(),
                                        )
                                    }
                                portalApi.saveTribeProfile(
                                    kinfolkId = kinfolkId,
                                    displayName = displayFromSchema,
                                    customFields = mergeVetFields(rest, vetFields),
                                )
                            } else {
                                portalApi.saveTribeProfile(
                                    kinfolkId = kinfolkId,
                                    displayName = displayName.trim(),
                                    customFields = mergeVetFields(profileFields, vetFields),
                                )
                            }
                            // After-hours emergency vet customFields, persisted into the
                            // HomeAccess store under stable keys (gated; empty list when off).
                            val afterHoursFields = buildList {
                                if (afterHoursVetName.isNotBlank()) add(CustomField(key = "afterHoursVetName", label = "After-hours Clinic", value = afterHoursVetName.trim()))
                                if (afterHoursVetPhone.isNotBlank()) add(CustomField(key = "afterHoursVetPhone", label = "After-hours Phone", value = afterHoursVetPhone.trim()))
                            }
                            // Home access save — schema-driven path same pattern.
                            if (homeSchema != null) {
                                val schemaFields = homeSchema!!.sections.flatMap { it.fields }
                                val gc = homeValues["gateCode"]?.trim()?.ifBlank { null } ?: gateCode.trim().ifBlank { null }
                                val kl = homeValues["keyLocation"]?.trim()?.ifBlank { null } ?: keyLocation.trim().ifBlank { null }
                                val wf = homeValues["wifiPassword"]?.trim()?.ifBlank { null } ?: wifi.trim().ifBlank { null }
                                val rest = schemaFields
                                    .filter { it.key != "gateCode" && it.key != "keyLocation" && it.key != "wifiPassword" }
                                    .map { f ->
                                        CustomField(
                                            key = f.key,
                                            label = f.label,
                                            value = homeValues[f.key].orEmpty(),
                                        )
                                    }
                                portalApi.saveHomeAccess(
                                    kinfolkId = kinfolkId,
                                    gateCode = gc,
                                    keyLocation = kl,
                                    wifiPassword = wf,
                                    customFields = mergeAfterHoursFields(rest, afterHoursFields, keep = true),
                                )
                            } else {
                                portalApi.saveHomeAccess(
                                    kinfolkId = kinfolkId,
                                    gateCode = gateCode.trim().ifBlank { null },
                                    keyLocation = keyLocation.trim().ifBlank { null },
                                    wifiPassword = wifi.trim().ifBlank { null },
                                    customFields = mergeAfterHoursFields(accessFields, afterHoursFields, keep = true),
                                )
                            }
                            status = "Saved."
                        } catch (t: Throwable) {
                            status = "Save failed: ${t.message ?: t}"
                        } finally {
                            saving = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
                enabled = !saving && displayName.isNotBlank(),
            )
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

// ---- Brand building blocks (per mockup .cardhead / .grid2 / .addfield) ----

/** Icon-in-tinted-tile card header with serif title + muted sub line. */
@Composable
private fun CardHead(
    icon: ImageVector,
    tint: Color,
    title: String,
    sub: String,
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
            Text(sub, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
        }
        actions()
    }
}

@Composable
private fun CardDivider() {
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
    val ownedElsewhere = setOf("afterHoursVetName", "afterHoursVetPhone")
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

private fun mergeVetFields(base: List<CustomField>, vet: List<CustomField>): List<CustomField> {
    val reservedKeys = setOf(
        "vetClinicName", "vetClinicPhone", "vetClinicAddress",
        "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation",
    )
    return base.filter { it.key !in reservedKeys } + vet
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
 * Merges after-hours emergency vet fields into the HomeAccess customFields.
 * When [keep] is true (flag on) the two reserved keys are replaced with the
 * freshly edited values. When false (flag off) the base list is returned
 * unchanged so any previously saved after-hours values are never deleted.
 */
private fun mergeAfterHoursFields(
    base: List<CustomField>,
    afterHours: List<CustomField>,
    keep: Boolean,
): List<CustomField> {
    if (!keep) return base
    val reservedKeys = setOf("afterHoursVetName", "afterHoursVetPhone")
    return base.filter { it.key !in reservedKeys } + afterHours
}

/**
 * Household members editor. A PRIMARY sees each SECONDARY in their household and
 * toggles that secondary's access, persisting via the `updateSecondaryPermissions`
 * callable. Loads on screen entry (LaunchedEffect, not VM-init). Fail-loud: load
 * and per-member save errors surface inline.
 *
 * Only the three operator-relevant toggles are shown: "Can edit pets" (kin_edit),
 * "Home access" (home_access), "Direct messaging" (messaging_direct). Billing and
 * KinTales are intentionally NOT editable here (billing is PRIMARY-only; kintales
 * is always-on), and `messaging_group` is preserved as-is on save.
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
            label = "Home access (gate code, Wi-Fi)",
            value = canAccessHome,
            onChange = { canAccessHome = it },
        )
        AccessToggleRow(
            label = "Direct messaging",
            value = canDirectMessage,
            onChange = { canDirectMessage = it },
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
                label = "Home access (gate code, Wi-Fi)",
                value = canAccessHome,
                onChange = { canAccessHome = it },
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

/** A labelled access toggle used when inviting a secondary kinfolk. The PRIMARY
 *  opts the secondary in to a specific permission (default OFF). Foundation-only
 *  track/thumb switch, mirroring the toggle used elsewhere in the app. */
@Composable
private fun AccessToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
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
        Text(label, style = type.sansBody, modifier = Modifier.weight(1f))
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
