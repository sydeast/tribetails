package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareSession

/**
 * The five nodes of the "Visit lifecycle" stepper the Kin Care detail draws,
 * per `ui-ideas/auntieos-kincare-detail-2026-05-27.html`. Pure, so the moods
 * are pinned by a JVM test without a Compose runtime (the compose-pure-helper
 * convention this package already follows). The web twin is `lifecycleSteps`
 * in `src/screens/SessionDetail.tsx`.
 */
enum class LifecycleMood { Done, Now, Todo }

data class LifecycleStep(
    val status: String,
    val name: String,
    val mood: LifecycleMood,
    /** The raw ISO stamp on the record, or "" when the step has none. */
    val stamp: String,
)

/** In visit order. CANCELLED is the absence of a visit and gets no node; the hero pill names it. */
internal val LIFECYCLE_STEP_ORDER: List<Pair<String, String>> = listOf(
    "SCHEDULED" to "Scheduled",
    "ON_MY_WAY" to "On my way",
    "ARRIVED" to "Arrived",
    "DEPARTED" to "Departed",
    "COMPLETED" to "Completed",
)

/**
 * A step is DONE when its own timestamp is on the record, NOW when it is the
 * state the visit is in, TODO otherwise. Done is read from the stamp and never
 * from "every step before the current one": a visit the office completed from
 * Bookings without a clock-out has `completedAt` and no `departedAt`, and
 * lighting Departed on that visit would say someone clocked out of it.
 * SCHEDULED is the one step with no stamp on the record (the session document
 * is the scheduling), so it is NOW while the visit waits and DONE the moment
 * anything else has happened to it.
 */
internal fun lifecycleSteps(s: KinCareSession): List<LifecycleStep> =
    lifecycleSteps(
        status = s.status,
        onMyWayAt = s.onMyWayAt,
        arrivedAt = s.arrivedAt,
        departedAt = s.departedAt,
        completedAt = s.completedAt,
    )

internal fun lifecycleSteps(
    status: String,
    onMyWayAt: String?,
    arrivedAt: String?,
    departedAt: String?,
    completedAt: String?,
): List<LifecycleStep> {
    val current = status.uppercase()
    val stamps = mapOf(
        "ON_MY_WAY" to onMyWayAt.orEmpty(),
        "ARRIVED" to arrivedAt.orEmpty(),
        "DEPARTED" to departedAt.orEmpty(),
        "COMPLETED" to completedAt.orEmpty(),
    )
    return LIFECYCLE_STEP_ORDER.map { (code, name) ->
        val stamp = stamps[code].orEmpty().trim()
        val mood = when {
            code == current -> LifecycleMood.Now
            code == "SCHEDULED" || stamp.isNotBlank() -> LifecycleMood.Done
            else -> LifecycleMood.Todo
        }
        LifecycleStep(status = code, name = name, mood = mood, stamp = stamp)
    }
}

/**
 * How far the progress bar runs, as a fraction of the distance between the
 * first and last node: to the last node that is not still to come.
 */
internal fun lifecycleProgress(steps: List<LifecycleStep>): Float {
    if (steps.size < 2) return 0f
    var last = 0
    steps.forEachIndexed { i, step -> if (step.mood != LifecycleMood.Todo) last = i }
    return last.toFloat() / (steps.size - 1)
}
