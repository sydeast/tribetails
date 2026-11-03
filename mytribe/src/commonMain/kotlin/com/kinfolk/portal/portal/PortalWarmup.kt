package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.screens.schedule.bookingDateKey
import com.kinfolk.portal.screens.schedule.bookingHorizonEnd
import com.kinfolk.portal.screens.tribe.GALLERY_CARD_PAGE
import com.kinfolk.portal.util.attempt
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.datetime.LocalDate

/**
 * #1282, option B: warm the screen reads when the portal opens.
 *
 * Every portal callable is its own Cloud Run service with minInstances 0 (nine
 * warm ones aside), so the FIRST open of a screen pays a cold start per
 * callable it reads: Invoices measured 13 s on prod on 2026-11-01, Notification
 * settings and Tribe Profile 10-14 s, the booking wizard 9 s, Add Kin 5-13 s.
 * The second open is fast.
 *
 * Once the shell has the home payload for a tribe, this fires every one of
 * those screens' reads together, the same callables with the same arguments
 * the screens use (page sizes, the booking horizon), so each screen's first
 * open lands on an instance that is already up. Android keeps no query cache,
 * so warm instances are the whole benefit here; the answers are dropped.
 *
 * THE MONEY GATE (#1005). `getMyInvoices`, `getAccountCreditHistory` and
 * `getMyPaymentMethod` refuse a member without billing access, and the server
 * says who has it on `getMyHome.billingAccess`. The home payload is therefore
 * the input, not the kinfolk id: the money reads fire only when it says yes.
 *
 * SILENT. Each read runs inside [attempt], so a failure is a [Result] and
 * nothing propagates; a cancelled shell still cancels. The shell hands this
 * class the platform client with the session reaction taken off
 * ([FunctionsClient.withoutSessionReaction]), so a refusal here can never be
 * the thing that signs the household out; the screen's own read is.
 *
 * NOT HERE: saves (#1504) are a separate issue. `getMyKin` (#1282) and
 * `getVetClinics` (#1503) are not warmed: both are direct Firestore reads on
 * this platform, so there is no instance to wake.
 */
class PortalWarmup(
    private val fns: FunctionsClient,
    firestore: FirestoreClient? = null,
) {
    private val api = PortalApi(fns, firestore)

    /** One read's name and how it went. */
    data class Outcome(val name: String, val result: Result<Unit>)

    /**
     * Fires the fan-out for [home]'s tribe. Returns when every read has
     * settled; never throws except for cancellation.
     */
    suspend fun run(home: MyHomeResult, today: LocalDate): List<Outcome> = coroutineScope {
        val k = home.kinfolkId
        val horizonEnd = bookingHorizonEnd(today)
        val reads = mutableListOf<Pair<String, suspend () -> Unit>>(
            // Account
            "getMyAccount" to { api.getMyAccount() },
            "getFormSchema:account" to { api.getFormSchema("account") },
            // Notification settings
            "getNotificationCatalog" to { fns.call("getNotificationCatalog", null) },
            "getMyNotificationPrefs" to { api.getMyNotificationPrefs() },
            // Tribe Profile (and the Tribe hub's home-info card)
            "getMyTribeProfile" to { api.getMyTribeProfile(k) },
            "getFormSchema:tribeProfile" to { api.getFormSchema("tribeProfile") },
            "getFormSchema:homeAccess" to { api.getFormSchema("homeAccess") },
            "getBusinessContact" to { api.getBusinessContact() },
            "listMembers" to { api.listMembers(k) },
            // Booking wizard
            "getServiceCatalog" to { api.getServiceCatalog(k) },
            "getBusinessClosures" to { api.getBusinessClosures(bookingDateKey(today), bookingDateKey(horizonEnd)) },
            "getBookingPolicy" to { api.getBookingPolicy() },
            // Schedule
            "getMyVisits" to { api.getMyVisits(k, limit = SCHEDULE_VISITS_LIMIT) },
            // Tribe hub photo strip
            "getMyKinPhotos" to { api.getMyKinPhotos(kinfolkId = k, limit = GALLERY_CARD_PAGE) },
            // Add Kin
            "getFormSchema:kinProfile" to { api.getFormSchema("kinProfile") },
            "getBreeds" to { api.getBreeds() },
        )
        if (home.billingAccess) {
            reads += "getMyInvoices" to { api.getMyInvoices(k) }
            reads += "getAccountCreditHistory" to { api.getAccountCreditHistory(k) }
            reads += "getMyPaymentMethod" to { api.getMyPaymentMethod(k) }
        }
        reads.map { (name, read) -> async { Outcome(name, attempt { read() }) } }.awaitAll()
    }

    companion object {
        /** ScheduleScreen's page: `getMyVisits(kinfolkId, limit = 10)`. */
        const val SCHEDULE_VISITS_LIMIT = 10
        /**
         * The shell's gate: which home payload, if any, a run may use. The
         * shell writes a FALLBACK `MyHomeResult` when `getMyHome` fails and
         * records the failure in `homeError`; that payload's `billingAccess`
         * is the default, not an answer, so it warms nothing. Pure, so the
         * rule is tested without a Compose runtime.
         */
        fun warmupPayload(home: MyHomeResult?, homeError: String?): MyHomeResult? =
            if (home == null || homeError != null) null else home
    }
}
