package com.tribetails.auntieos.web.screens.schedule
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.overridableScheduleRefusal
/** One reschedule send. [override] is set only when the operator chose "Move anyway" (#1154). */
data class RescheduleAttempt(
    val sessionId: String,
    val startTime: String,
    val endTime: String,
    val override: ScheduleOverride? = null,
)
sealed class RescheduleOutcome {
    object Done : RescheduleOutcome()
    /** The server's own sentence, plus the override it lets the operator take, or null when there is none. */
    data class Refused(val message: String, val offer: ScheduleOverride?) : RescheduleOutcome()
}
/**
 * Sends [attempt] and reads the refusal. A closed day, an unknown code and a refusal of an attempt that already
 * carried an override all offer nothing, so the same override is never put to the operator twice.
 */
suspend fun FirestoreClient.rescheduleOutcome(attempt: RescheduleAttempt): RescheduleOutcome =
    when (val r = rescheduleBooking(attempt.sessionId, attempt.startTime, attempt.endTime, attempt.override)) {
        is WriteResult.Ok -> RescheduleOutcome.Done
        is WriteResult.Err -> RescheduleOutcome.Refused(
            r.message,
            if (attempt.override == null) overridableScheduleRefusal(r.code) else null,
        )
    }
