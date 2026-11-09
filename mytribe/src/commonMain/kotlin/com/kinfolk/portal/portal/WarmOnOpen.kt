package com.kinfolk.portal.portal

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.util.attempt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #1504, WARM ON INTENT: wake a save's Cloud Run instance when the household
 * opens the form that will call it. Twin of the web's `lib/warmSave.ts` and
 * `lib/useWarmOnOpen.ts`.
 *
 * Every portal write is its own Cloud Run service with minInstances 0, so the
 * first save of the day pays a cold start. The #1282 warm-up
 * ([PortalWarmup]) wakes the screen READS when the portal opens, and a read
 * shares no instance with its save. So each form fires one call to its own
 * save as it opens; by the time the household presses Save, that instance is
 * up.
 *
 * The payload is exactly `{ "__warm": true }`. `wrapCallable` on the server
 * answers that payload, from a signed-in caller, before the handler runs:
 * nothing is read past the session check, nothing is written, nobody is
 * notified. Any other payload is a real call.
 *
 * SILENT. The call goes through [FunctionsClient.withoutSessionReaction], so a
 * refusal can never sign the household out (the save itself can), and through
 * the untracked client, so it never holds up the #1561 wait for a screen's own
 * reads. It runs inside [attempt]: a failure is printed and dropped, and only
 * cancellation propagates.
 */
enum class WarmableSave(val callable: String) {
    SaveMyAccount("saveMyAccount"),
    SaveTribeProfile("saveTribeProfile"),
    /** The Tribe Profile page's Save writes this half too. */
    SaveHomeAccess("saveHomeAccess"),
    SaveMyNotificationPrefs("saveMyNotificationPrefs"),
    AddBookingNote("addBookingNote"),
    RequestBooking("requestBooking"),
    AddKin("addKin"),
    UpdateKin("updateKin"),
    CreateShareLink("createShareLink"),
    /** The message composer: Polish, and Send beside it. */
    Generate("generate"),
    SendKinfolkMessage("sendKinfolkMessage"),
}

/** The whole warm payload. A real call never sends this shape. */
val WARM_PAYLOAD: JsonObject = buildJsonObject { put("__warm", true) }

/** True for a recorded call that was a warm call, so tests can tell it from a save. */
fun isWarmPayload(payload: JsonObject?): Boolean = payload == WARM_PAYLOAD

/**
 * Fires the warm call for [save] through [fns] with the session reaction taken
 * off. Never throws except for cancellation.
 */
suspend fun warmSave(
    fns: FunctionsClient,
    save: WarmableSave,
    log: (String) -> Unit = { println("[WarmSave] $it") },
): Result<Unit> {
    val outcome = attempt { fns.withoutSessionReaction().call(save.callable, WARM_PAYLOAD); Unit }
    outcome.exceptionOrNull()?.let { log("${save.callable} warm call failed; the save will run cold: ${it.message}") }
    return outcome
}

/** [warmSave] through this API's own client. */
suspend fun PortalApi.warmSave(save: WarmableSave): Result<Unit> = warmSave(functionsClient, save)

/**
 * Warms [save] once when the form holding this composable opens.
 *
 * Place it in the FORM's own composable, not the route: a share link or a
 * booking note form opens on a tap, long after its screen did. Once per open:
 * the flag is remembered, so recomposition never fires again; leaving the form
 * and opening it again is a new open and warms again. [enabled] lets a form
 * that composes before it can save (still loading what it edits) wait until it
 * can; the first composition with [enabled] true is the open.
 */
@Composable
fun WarmOnOpen(api: PortalApi, save: WarmableSave, enabled: Boolean = true) {
    var fired by remember(api, save) { mutableStateOf(false) }
    LaunchedEffect(api, save, enabled) {
        if (!enabled || fired) return@LaunchedEffect
        fired = true
        api.warmSave(save)
    }
}
