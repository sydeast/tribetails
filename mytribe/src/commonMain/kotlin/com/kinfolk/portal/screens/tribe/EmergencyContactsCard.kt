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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** `EMERGENCY_CONTACTS_MAX` and the field limits in `mytribe/functions/src/lib/emergencyContacts.ts`. */
private const val MAX_CONTACTS = 2
private const val NAME_MAX = 80
private const val PHONE_MAX = 32
private const val RELATIONSHIP_MAX = 40

// #829 review item 4: the server's own wording, word for word, so a refusal reads
// the same whether this pre-check or the callable caught it.
private const val REQUIRED = "A household needs at least one Emergency Contact."
private const val NAME_REQUIRED = "An Emergency Contact needs a name."
private const val PHONE_REQUIRED = "An Emergency Contact needs a phone number."
private const val NAME_TOO_LONG = "An Emergency Contact's name can be at most $NAME_MAX characters."
private const val PHONE_TOO_LONG = "An Emergency Contact's phone number can be at most $PHONE_MAX characters."
private const val RELATIONSHIP_TOO_LONG = "A relationship can be at most $RELATIONSHIP_MAX characters."
private const val SAME_PHONE = "The two Emergency Contacts need different phone numbers."

/** The #844 sentence, word for word the same on portal web. */
private const val LOCKED = "Only someone with Home access can change the Emergency Contact."

/**
 * #829 review item 12: what a member without Home access reads when the household
 * has none. Read-only, naming who can fix it; the same sentence as portal web.
 */
private const val NONE_READ_ONLY = "No Emergency Contact on file. Someone with Home access can add one."

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
    drafts.any { it.name.isBlank() } -> NAME_REQUIRED
    drafts.any { it.phone.isBlank() } -> PHONE_REQUIRED
    drafts.any { it.name.trim().length > NAME_MAX } -> NAME_TOO_LONG
    drafts.any { it.phone.trim().length > PHONE_MAX } -> PHONE_TOO_LONG
    drafts.any { it.relationship.trim().length > RELATIONSHIP_MAX } -> RELATIONSHIP_TOO_LONG
    drafts.size == 2 && comparable(drafts[0].phone) == comparable(drafts[1].phone) -> SAME_PHONE
    else -> null
}

/**
 * #829 review item 14: the drafts say what the server copy says, compared trimmed,
 * as the save trims them and as every other client compares, so a stray space is
 * never an unsaved change.
 */
private fun sameDrafts(a: List<EmergencyContactInput>, b: List<EmergencyContactInput>): Boolean =
    a.size == b.size && a.zip(b).all { (x, y) ->
        x.name.trim() == y.name.trim() && x.phone.trim() == y.phone.trim() && x.relationship.trim() == y.relationship.trim()
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
    // Keyed on the household like everything above, so a busy Save or a message
    // from one household is never shown on another.
    var saving by remember(kinfolkId) { mutableStateOf(false) }
    var message by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var messageOk by remember(kinfolkId) { mutableStateOf(false) }
    /** The household on screen now, read by a save when its reply lands. */
    val currentKinfolkId by rememberUpdatedState(kinfolkId)

    val dirty = baseline?.let { !sameDrafts(drafts, toDrafts(it)) } ?: false
    val reportDirty by rememberUpdatedState(onDirtyChange)
    LaunchedEffect(dirty) { reportDirty(dirty) }

    LaunchedEffect(kinfolkId, reloadKey) {
        try {
            val r = portalApi.listEmergencyContacts(kinfolkId)
            // Seeds unconditionally. A load only runs before the card has drafts:
            // the first read, tap to sync while still loading, and Try again after
            // a failure. None of those has typing on screen to protect.
            loaded = r
            loadError = null
            baseline = r.contacts
            drafts = toDrafts(r.contacts)
        } catch (c: CancellationException) {
            throw c
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
                loadError != null -> Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text(
                        loadError!!,
                        style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                    )
                    // Not a dead end: clearing the error puts the loading cue back
                    // (with its own tap to sync) while the read runs again.
                    KinGhostButton(
                        label = "Try again",
                        onClick = {
                            loadError = null
                            reloadKey += 1
                        },
                    )
                }

                r == null -> KinLoading(
                    text = "Loading Emergency Contacts…",
                    onSync = { reloadKey += 1 },
                )

                // #829 review item 12: none on file and no Home access. One read-only
                // sentence saying who can add one, not the editor's prompt.
                !r.canEdit && r.contacts.isEmpty() ->
                    Text(NONE_READ_ONLY, style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted))

                !r.canEdit -> {
                    run {
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
                                when {
                                    // With none on file the prompt above already says
                                    // this; a second copy under Save reads as an echo.
                                    // Kept when the server holds contacts and the
                                    // household cleared them, where no prompt shows.
                                    problem == REQUIRED && r.contacts.isEmpty() -> message = null

                                    problem != null -> {
                                        message = problem
                                        messageOk = false
                                    }

                                    else -> {
                                        saving = true
                                        message = null
                                        val sent = drafts
                                        val sentFor = kinfolkId
                                        scope.launch {
                                            val stored = try {
                                                portalApi.saveEmergencyContacts(sentFor, sent)
                                            } catch (c: CancellationException) {
                                                throw c
                                            } catch (t: Throwable) {
                                                // Dropped if the household changed while it was away.
                                                if (currentKinfolkId == sentFor) {
                                                    messageOk = false
                                                    message = t.message?.takeIf { it.isNotBlank() }
                                                        ?: "The Emergency Contacts were not saved. Try again."
                                                    saving = false
                                                }
                                                return@launch
                                            }
                                            // A reply for a household no longer on screen is
                                            // not applied: it would seed another household's
                                            // slots and say "Saved." about them.
                                            if (currentKinfolkId != sentFor) return@launch
                                            baseline = stored
                                            drafts = toDrafts(stored)
                                            loaded = loaded?.copy(contacts = stored, legacy = false)
                                            messageOk = true
                                            message = "Saved."
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
