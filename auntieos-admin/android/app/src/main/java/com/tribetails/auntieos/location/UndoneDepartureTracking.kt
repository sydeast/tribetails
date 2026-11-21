package com.tribetails.auntieos.location

import android.content.Context
import android.content.Intent
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.model.VisitRoute
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * #2338: an undone departure resumes GPS on the phone that was tracking the
 * visit, and only there.
 *
 * Departed stops [LocationTrackingService] and saves the route. For the few
 * minutes "Undo departed" is offered (#2250) this phone remembers the visit
 * it was tracking (a [Parked] marker, kept in preferences so it outlives the
 * process) and checks the visit. When it reads Arrived again, the service
 * starts again with [LocationTrackingService.ACTION_RESUME_ROUTE]: the route's
 * first part is read back from the breadcrumbs and the same `visit_routes`
 * document is kept, so the next Departed saves one route, and one
 * `gpsSummary`, for the whole visit.
 *
 * The device that taps Undo is often not the one at the house (the owner at a
 * desk can undo an Auntie's tap), so the undo itself starts nothing anywhere:
 * a phone with no marker for the visit never resumes it.
 *
 * NO WINDOW LIVES HERE. How long the undo is offered is the server's
 * (`functions/src/lib/visitLifecycle.ts#UNDO_DEPARTED_WINDOW_MS`), read off the
 * visit as `undoDepartedUntil`. [PARK_CAP_MS] only bounds how long the phone
 * keeps checking a visit that carries no such stamp.
 */
object UndoneDepartureTracking {
    data class Parked(
        val sessionId: String,
        val kinfolkId: String,
        val routeId: String,
        val parkedAtMs: Long,
    )

    enum class Decision { RESUME, WAIT, DROP }

    /** The longest the phone keeps checking a visit with no `undoDepartedUntil`. */
    const val PARK_CAP_MS: Long = 30 * 60_000L

    /** Past `undoDepartedUntil`, for an undo the server accepted on the last second. */
    const val PARK_GRACE_MS: Long = 60_000L

    /** How often the parked visit is read while the phone waits. */
    private const val CHECK_EVERY_MS: Long = 15_000L

    private const val PREFS = "undone_departure_tracking"
    private const val K_SESSION = "sessionId"
    private const val K_KINFOLK = "kinfolkId"
    private const val K_ROUTE = "routeId"
    private const val K_AT = "parkedAtMs"

    /**
     * PURE. What the parked phone does with the visit as it reads now.
     *
     * @param status the visit's status, or null when it could not be read
     *        (gone, or no signal): the phone keeps waiting, up to the cap.
     * @param trackingNow this phone is already tracking a visit (the next one,
     *        clocked into inside the undo window). A resume would wipe that
     *        route, so the wait ends instead.
     */
    fun decide(
        parked: Parked,
        status: String?,
        undoDepartedUntil: String?,
        nowMs: Long,
        trackingNow: Boolean = false,
    ): Decision {
        if (nowMs - parked.parkedAtMs > PARK_CAP_MS) return Decision.DROP
        val s = status?.trim()?.uppercase() ?: return Decision.WAIT
        return when (s) {
            // Only asked at the undo: right after Departed the stop may not have
            // landed yet, and the wait must not end on that.
            "ARRIVED" -> if (trackingNow) Decision.DROP else Decision.RESUME
            "DEPARTED", "COMPLETED" -> {
                val until = untilMs(undoDepartedUntil)
                if (until != null && nowMs > until + PARK_GRACE_MS) Decision.DROP else Decision.WAIT
            }
            // Cancelled, moved back to Scheduled or On my way, or anything else:
            // not an undone departure.
            else -> Decision.DROP
        }
    }

    /** `undoDepartedUntil` (ISO, UTC) in ms, or null when absent or unreadable. */
    fun untilMs(raw: String?): Long? {
        val v = raw?.trim().orEmpty()
        if (v.isEmpty()) return null
        return runCatching { Instant.parse(v).toEpochMilli() }.getOrNull()
    }

    /**
     * PURE. The route's first part, read back from the breadcrumbs, in time
     * order and halved the way [LocationTrackingService] halves a route that
     * grows past [maxPoints].
     */
    fun seedPoints(crumbs: List<LocationPoint>, maxPoints: Int): List<LocationPoint> {
        var pts = crumbs.sortedBy { it.timestamp }
        while (pts.size > maxPoints) pts = pts.filterIndexed { i, _ -> i % 2 == 0 }
        return pts
    }

    /**
     * PURE. The route the resumed service carries: the saved one kept whole
     * (its id, start and arrival), with the departure and end cleared because
     * the visit is under way again. A route that could not be read starts a
     * fresh shell for the same visit, under the parked [routeId] when there is
     * one, so a failed read never writes a second `visit_routes` document.
     */
    fun resumedRoute(
        saved: VisitRoute?,
        sessionId: String,
        kinfolkId: String,
        nowIso: String,
        routeId: String = "",
    ): VisitRoute {
        val keptId = saved?.id?.takeIf { it.isNotBlank() } ?: routeId
        return saved?.copy(id = keptId, departureTime = "", endTime = "")
            ?: VisitRoute(id = routeId, kinCareSessionId = sessionId, kinfolkId = kinfolkId, startTime = nowIso)
    }

    fun park(context: Context, parked: Parked) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(K_SESSION, parked.sessionId)
            .putString(K_KINFOLK, parked.kinfolkId)
            .putString(K_ROUTE, parked.routeId)
            .putLong(K_AT, parked.parkedAtMs)
            .apply()
    }

    fun parked(context: Context): Parked? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = p.getString(K_SESSION, null)?.takeIf { it.isNotBlank() } ?: return null
        return Parked(id, p.getString(K_KINFOLK, "").orEmpty(), p.getString(K_ROUTE, "").orEmpty(), p.getLong(K_AT, 0L))
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }

    @Volatile private var watching: Job? = null

    /**
     * Check the parked visit until it resumes or the wait ends. Safe to call
     * any number of times (Home calls it on every load, so a marker that
     * outlived the process is picked up again); one check runs at a time.
     *
     * A start the system refuses (an app in the background on Android 12 and
     * later) keeps the marker, and the next Home load tries again while the
     * visit is still Arrived. Until then the card shows no live route here.
     */
    fun watch(context: Context) {
        val app = context.applicationContext
        if (parked(app) == null) return
        if (watching?.isActive == true) return
        watching = AuntieOSApp.instance.appScope.launch {
            while (true) {
                val parked = parked(app) ?: return@launch
                val session = AuntieOSApp.instance.kinCareRepository.getKinCareSession(parked.sessionId).getOrNull()
                when (
                    decide(
                        parked,
                        session?.status,
                        session?.undoDepartedUntil,
                        System.currentTimeMillis(),
                        trackingNow = LocationTrackingService.isTracking.value,
                    )
                ) {
                    Decision.DROP -> {
                        clear(app)
                        return@launch
                    }
                    Decision.RESUME -> {
                        if (resume(app, parked)) clear(app)
                        return@launch
                    }
                    Decision.WAIT -> delay(CHECK_EVERY_MS)
                }
            }
        }
    }

    private fun resume(context: Context, parked: Parked): Boolean = try {
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_RESUME_ROUTE
            putExtra(LocationTrackingService.EXTRA_SESSION_ID, parked.sessionId)
            putExtra(LocationTrackingService.EXTRA_KINFOLK_ID, parked.kinfolkId)
            putExtra(LocationTrackingService.EXTRA_ROUTE_ID, parked.routeId)
        }
        context.startForegroundService(intent)
        true
    } catch (e: Exception) {
        AuntieLog.w("Could not resume GPS after Undo departed on ${parked.sessionId}: ${e.message}")
        false
    }
}
