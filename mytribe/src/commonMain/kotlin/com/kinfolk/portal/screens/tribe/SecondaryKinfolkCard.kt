package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Groups
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
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.KinInfoTip
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.SecondaryKinfolkDto
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

/**
 * What "Give portal access" hands to the invite card: the person's email (blank
 * when none is on file), their name as the role label, and the person id that
 * rides into `addSecondaryContact`.
 */
internal data class InvitePrefill(val personId: String, val name: String, val email: String)

/** `SECONDARY_KINFOLK_NAME_MAX` in `mytribe/functions/src/portal/secondaryKinfolk.ts`. */
private const val NAME_MAX = 80

internal const val SK_NO_PORTAL_ACCESS = "No portal access"
internal const val SK_INVITED = "Invited"
/** Behind the info tip beside the title (ruling 2026-09-11: no subtitle copy). */
internal const val SK_WHO = "Someone in your household. Adding them sends nothing. Give portal access sends them an invite."

/**
 * Operator rulings 2026-09-27. R1: "SK: contact info optional, portal access
 * optional." Q3: "A Secondary kinfolk can be added to the household but doesn't
 * have portal access unless PK invites them and set access."
 *
 * The primary adds a secondary kinfolk here with a name and, if they like, a
 * phone and an email. That is a person record (`saveSecondaryKinfolk`), never
 * an invite. Portal access comes only from "Give portal access", which fills
 * the invite card below with this person, so the primary sets permissions with
 * the same toggles as any invite.
 *
 * Rows are the people whose access is not ACTIVE; an ACTIVE one is a member and
 * already appears in Household members above. The list is PRIMARY-only on the
 * server; for anyone else the load error is shown, the same way the members
 * card degrades. Saves are pessimistic and show the server's own message.
 */
@Composable
internal fun SecondaryKinfolkCard(
    kinfolkId: String,
    portalApi: PortalApi,
    reloadKey: Int,
    onGivePortalAccess: (InvitePrefill) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<SecondaryKinfolkDto>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var localReload by remember { mutableStateOf(0) }

    // The form: closed, adding (editingId null) or editing one person.
    var formOpen by remember { mutableStateOf(false) }
    var editingId by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var formError by remember { mutableStateOf<String?>(null) }

    var confirmRemove by remember { mutableStateOf<SecondaryKinfolkDto?>(null) }
    var removing by remember { mutableStateOf(false) }
    var rowError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId, reloadKey, localReload) {
        try {
            people = portalApi.listSecondaryKinfolk(kinfolkId)
            loadError = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load your secondary kinfolk."
        }
    }

    fun openForm(p: SecondaryKinfolkDto?) {
        formOpen = true
        editingId = p?.personId
        name = p?.name.orEmpty()
        phone = p?.phone.orEmpty()
        email = p?.email.orEmpty()
        formError = null
    }

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.Groups,
                tint = KinfolkBrand.FamilyPurple,
                title = "Secondary kinfolk",
                actions = { KinInfoTip(SK_WHO) },
            )
            val list = people
            when {
                loadError != null -> Text(loadError!!, style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral))
                list == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.s),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }
                else -> {
                    val shown = list.filter { it.access != "ACTIVE" }
                    shown.forEachIndexed { index, p ->
                        if (index > 0) CardDivider()
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(p.name, style = type.sansBody)
                            listOfNotNull(p.phone, p.email).takeIf { it.isNotEmpty() }?.let {
                                Text(it.joinToString(" · "), style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                            }
                            Text(
                                if (p.access == "INVITED") SK_INVITED else SK_NO_PORTAL_ACCESS,
                                style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                            )
                        }
                        if (confirmRemove?.personId == p.personId) {
                            Text("Remove ${p.name} from your household?", style = type.sansLabel)
                            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                KinGhostButton(
                                    label = if (removing) "Removing…" else "Remove",
                                    enabled = !removing,
                                    onClick = {
                                        removing = true
                                        rowError = null
                                        scope.launch {
                                            try {
                                                portalApi.removeSecondaryKinfolk(kinfolkId, p.personId)
                                                confirmRemove = null
                                                localReload += 1
                                            } catch (c: CancellationException) {
                                                throw c
                                            } catch (t: Throwable) {
                                                rowError = t.message ?: "That did not remove. Try again."
                                            } finally {
                                                removing = false
                                            }
                                        }
                                    },
                                )
                                KinGhostButton(label = "Keep", enabled = !removing, onClick = { confirmRemove = null; rowError = null })
                            }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                KinGhostButton(label = "Edit", enabled = !saving, onClick = { openForm(p) })
                                KinGhostButton(label = "Remove", enabled = !saving, onClick = { confirmRemove = p; rowError = null })
                            }
                            KinGhostButton(
                                label = "Give portal access",
                                onClick = { onGivePortalAccess(InvitePrefill(p.personId, p.name, p.email.orEmpty())) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    rowError?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral)) }

                    if (formOpen) {
                        if (shown.isNotEmpty()) CardDivider()
                        KinField(
                            value = name,
                            onValueChange = { name = it.take(NAME_MAX); formError = null },
                            label = "Name",
                            enabled = !saving,
                            fieldTestTag = "sk-name",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = phone,
                            onValueChange = { phone = it.take(32); formError = null },
                            label = "Phone (optional)",
                            enabled = !saving,
                            fieldTestTag = "sk-phone",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = email,
                            onValueChange = { email = it.take(254); formError = null },
                            label = "Email (optional)",
                            enabled = !saving,
                            fieldTestTag = "sk-email",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                            KinButton(
                                label = if (saving) "Saving…" else "Save",
                                enabled = !saving && name.isNotBlank(),
                                onClick = {
                                    saving = true
                                    formError = null
                                    scope.launch {
                                        try {
                                            portalApi.saveSecondaryKinfolk(
                                                kinfolkId = kinfolkId,
                                                personId = editingId,
                                                name = name,
                                                phone = phone,
                                                email = email,
                                            )
                                            formOpen = false
                                            editingId = null
                                            localReload += 1
                                        } catch (c: CancellationException) {
                                            throw c
                                        } catch (t: Throwable) {
                                            formError = t.message ?: "That did not save. Try again."
                                        } finally {
                                            saving = false
                                        }
                                    }
                                },
                            )
                            KinGhostButton(label = "Cancel", enabled = !saving, onClick = { formOpen = false; editingId = null; formError = null })
                        }
                        formError?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral)) }
                    } else {
                        KinGhostButton(
                            label = "Add secondary kinfolk",
                            onClick = { openForm(null) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

