package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinInfoTip
import com.kinfolk.portal.components.KinLoading
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.portal.EmergencyContactDto
import com.kinfolk.portal.portal.EmergencyContactInput
import com.kinfolk.portal.portal.EmergencyContactsResult
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.openExternalUrl
import kotlinx.coroutines.launch

/** The server's own `EMERGENCY_CONTACT_REQUIRED_MESSAGE`, and portal web's prompt. */
private const val REQUIRED = "A household needs at least one Emergency Contact"

/** The #844 sentence, word for word the same on portal web. */
private const val LOCKED = "Only someone with Home access can change the Emergency Contact."

/** `EMERGENCY_CONTACTS_MAX` in `mytribe/functions/src/lib/emergencyContacts.ts`. */
private const val MAX_CONTACTS = 2

/** Same sentence admin web, admin Android, desktop and portal web show. */
const val EMERGENCY_CONTACT_WHO_GETS_CALLED = "Called only when no kinfolk can be reached. The first one is called first."

private val EMPTY_DRAFT = EmergencyContactInput("", "", "")

private fun toDrafts(contacts: List<EmergencyContactDto>): List<EmergencyContactInput> =
    contacts.map { EmergencyContactInput(it.name, it.phone, it.relationship.orEmpty()) }.ifEmpty { listOf(EMPTY_DRAFT) }

/** Digits only, a bare 10-digit US number read as +1, so two spellings of one phone compare equal. */
private fun comparable(p: String) = p.filter(Char::isDigit).let { if (it.length == 10) "1$it" else it }

/**
 * What the card can refuse before dialling. The household-member check stays on
 * the server, whose message is shown as-is.
 */
private fun precheck(drafts: List<EmergencyContactInput>): String? = when {
    drafts.all { it.name.isBlank() && it.phone.isBlank() } -> REQUIRED
    drafts.any { it.name.isBlank() } -> "Each Emergency Contact needs a name."
    drafts.any { it.phone.isBlank() } -> "Each Emergency Contact needs a phone number."
    drafts.size == 2 && comparable(drafts[0].phone) == comparable(drafts[1].phone) -> "The two Emergency Contacts need different phone numbers."
    else -> null
}

/**
 * The household's Emergency Contacts (#829): up to two, the first called first,
 * never messaged, no portal access. Any ACTIVE member reads; only a caller with
 * home_access edits, and everyone else gets the list with the #844 sentence.
 * The twin of portal web's `EmergencyContactsCard.tsx`.
 *
 * ONLY THE CALLABLES. Reads through `listEmergencyContacts`, writes through
 * `saveEmergencyContacts`. The old `emergencyContact*` rows in the profile
 * customFields are not read here, and the profile save never sends them.
 *
 * SENDS ONLY WHAT THE CARD OWNS. The save carries the whole list, and the list is
 * exactly the three fields the card has a control for per slot. `recordedAt` and
 * `updatedAt` are the server's; it keeps them by matching slots, so no field is
 * rebuilt at a default.
 *
 * PESSIMISTIC. While a save is in flight every input and button is disabled and
 * Save reads "Saving…" beside a spinner. A refusal leaves the typing in place
 * under the server's own message. A success seeds the drafts from the reply, so
 * the household sees what was stored (E.164 phones, trimmed names).
 *
 * UNSAVED EDITS. The drafts are compared with the server copy they were seeded
 * from. While they differ the card says "Unsaved changes" and tells the page
 * through [onDirtyChange], because the page's own Save Changes never sends
 * contacts.
 */
@Composable
fun EmergencyContactsCard(
    kinfolkId: String?,
    portalApi: PortalApi,
    onDirtyChange: (Boolean) -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var loaded by remember(kinfolkId) { mutableStateOf<EmergencyContactsResult?>(null) }
    var loadError by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var reloadKey by remember(kinfolkId) { mutableIntStateOf(0) }
    var drafts by remember(kinfolkId) { mutableStateOf(listOf(EMPTY_DRAFT)) }
    /** The server copy the drafts were last seeded from; null until the first load. */
    var baseline by remember(kinfolkId) { mutableStateOf<List<EmergencyContactDto>?>(null) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var messageOk by remember { mutableStateOf(false) }

    val dirty = baseline?.let { drafts != toDrafts(it) } ?: false
    val reportDirty by rememberUpdatedState(onDirtyChange)
    LaunchedEffect(dirty) { reportDirty(dirty) }

    LaunchedEffect(kinfolkId, reloadKey) {
        try {
            val r = portalApi.listEmergencyContacts(kinfolkId)
            loaded = r
            loadError = null
            // A reload never overwrites typing that has not been saved.
            val unsaved = baseline?.let { drafts != toDrafts(it) } ?: false
            if (!unsaved) {
                baseline = r.contacts
                drafts = toDrafts(r.contacts)
            }
        } catch (t: Throwable) {
            loadError = "Couldn't load your Emergency Contacts right now."
        }
    }

    /** Every user edit goes through here, so a stale "Saved." or error never outlives the change it described. */
    fun edit(next: List<EmergencyContactInput>) {
        drafts = next
        message = null
    }

    fun set(i: Int, d: EmergencyContactInput) = edit(drafts.mapIndexed { j, x -> if (j == i) d else x })

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(
                icon = Icons.Filled.Phone,
                tint = KinfolkBrand.SnuggleCoral,
                title = "Emergency Contacts",
                // An info tip, never a subtitle (ruling 2026-09-11), and it opens on
                // a tap (ruling 2026-09-13).
                actions = { KinInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED) },
            )
            val r = loaded
            when {
                loadError != null -> Text(
                    loadError!!,
                    style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                )

                r == null -> KinLoading(
                    text = "Loading Emergency Contacts…",
                    onSync = { reloadKey += 1 },
                )

                !r.canEdit -> {
                    if (r.contacts.isEmpty()) {
                        Text(REQUIRED, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                    } else {
                        r.contacts.forEachIndexed { i, c ->
                            if (i > 0) CardDivider()
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(if (i == 0) "Called first" else "Called second", style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
                                Text(c.name, style = type.sansBody)
                                c.relationship?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted)) }
                                Text(
                                    c.phone,
                                    style = type.sansBody.copy(color = KinfolkBrand.KinTeal),
                                    modifier = Modifier.clickable { openExternalUrl("tel:${c.phone}") },
                                )
                            }
                        }
                    }
                    Text(LOCKED, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))
                }

                else -> {
                    if (r.contacts.isEmpty()) {
                        Text(REQUIRED, style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral))
                    }
                    drafts.forEachIndexed { i, d ->
                        if (i > 0) CardDivider()
                        Text(if (i == 0) "Called first" else "Called second", style = type.sansMeta)
                        KinField(
                            value = d.name,
                            onValueChange = { set(i, d.copy(name = it.take(80))) },
                            label = "Name",
                            enabled = !saving,
                            fieldTestTag = "ec-$i-name",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = d.phone,
                            onValueChange = { set(i, d.copy(phone = it.take(32))) },
                            label = "Phone",
                            enabled = !saving,
                            fieldTestTag = "ec-$i-phone",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinField(
                            value = d.relationship,
                            onValueChange = { set(i, d.copy(relationship = it.take(40))) },
                            label = "Relationship (optional)",
                            enabled = !saving,
                            fieldTestTag = "ec-$i-relationship",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (i > 0 || drafts.size > 1) {
                            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                if (i > 0) {
                                    KinGhostButton(
                                        label = "Call first",
                                        enabled = !saving,
                                        onClick = { edit(listOf(drafts[i]) + drafts.filterIndexed { j, _ -> j != i }) },
                                    )
                                }
                                if (drafts.size > 1) {
                                    KinGhostButton(
                                        label = "Remove",
                                        enabled = !saving,
                                        onClick = { edit(drafts.filterIndexed { j, _ -> j != i }) },
                                    )
                                }
                            }
                        }
                    }
                    if (dirty) {
                        Text("Unsaved changes", style = type.sansLabel.copy(color = KinfolkBrand.KinfolkOrange))
                    }
                    if (drafts.size < MAX_CONTACTS) {
                        KinGhostButton(
                            label = "Add a second Emergency Contact",
                            enabled = !saving,
                            onClick = { edit(drafts + EMPTY_DRAFT) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KinButton(
                            label = if (saving) "Saving…" else "Save Emergency Contacts",
                            enabled = !saving,
                            onClick = {
                                val problem = precheck(drafts)
                                if (problem != null) {
                                    message = problem
                                    messageOk = false
                                } else {
                                    saving = true
                                    message = null
                                    val sent = drafts
                                    scope.launch {
                                        try {
                                            val stored = portalApi.saveEmergencyContacts(kinfolkId, sent)
                                            baseline = stored
                                            drafts = toDrafts(stored)
                                            loaded = loaded?.copy(contacts = stored, legacy = false)
                                            messageOk = true
                                            message = "Saved."
                                        } catch (t: Throwable) {
                                            messageOk = false
                                            message = t.message?.takeIf { it.isNotBlank() }
                                                ?: "The Emergency Contacts were not saved. Try again."
                                        } finally {
                                            saving = false
                                        }
                                    }
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                        if (saving) KinSpinner(size = 20.dp)
                    }
                    message?.let {
                        Text(
                            it,
                            style = type.sansLabel.copy(color = if (messageOk) KinfolkBrand.KinTeal else KinfolkBrand.SnuggleCoral),
                        )
                    }
                }
            }
        }
    }
}
