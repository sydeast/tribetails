package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * #1833: the bell's unread count, kept live.
 *
 * The badge used to be `getMyHome.unreadNotifications`, read once per tribe
 * when the app opened, then adjusted by the notifications list while it was on
 * screen. A notice that arrived afterwards was listed (the list is read fresh
 * when the bell is tapped) and never counted. The count now follows one
 * listener on the signed-in person's own `notifications` rows
 * ([FirestoreClient.recipientNotificationsStream]), and this file is what the
 * shell reads it from. The web portal's `lib/unreadBadge.ts` is the same
 * design, rule for rule.
 *
 * ONE OWNER FOR THE NUMBER. The count is derived, never stored: the unread
 * rows in the latest snapshot, minus the rows tapped on this device whose read
 * has not come back from the server yet. Nothing decrements a number, so a tap
 * cannot be counted twice when its snapshot lands.
 *
 * THE PREDICATES ARE THE SERVER'S (functions/src/lib/recipientNotifications.ts):
 * archived means `archivedAt` carries a value, unread means `readAt` does not,
 * and a row naming another household (`data.kinfolkId`, or the older
 * `data.familyId`) belongs to that tribe's bell. A row that names none is
 * counted under every tribe. One case table tests all three (UnreadBadgeTest).
 */

/** The newest rows the count looks at. Same number as the server's UNREAD_SCAN_CAP. */
const val UNREAD_SCAN_CAP = 100

/** What the count needs from one `notifications/{id}` row, and nothing else. */
data class BadgeRow(
    val id: String,
    val unread: Boolean,
    val archived: Boolean,
    /** The household the row names, blank when it names none. */
    val tribeId: String,
)

private fun idOf(v: Any?): String = when (v) {
    is String -> v.trim()
    // The native SDK hands integers back as Long, and a whole Double is the same id.
    is Long, is Int -> v.toString()
    is Double -> if (v.isFinite() && v == v.toLong().toDouble()) v.toLong().toString() else if (v.isFinite()) v.toString() else ""
    else -> ""
}

fun badgeRowOf(doc: FirestoreDoc): BadgeRow {
    val bag = doc.fields["data"] as? Map<*, *>
    val named = if (bag == null) "" else idOf(bag["kinfolkId"]).ifEmpty { idOf(bag["familyId"]) }
    return BadgeRow(
        id = doc.id,
        unread = doc.fields["readAt"] == null,
        archived = doc.fields["archivedAt"] != null,
        tribeId = named,
    )
}

/** Unread, not archived, about this tribe (or about none), and not already tapped here. */
fun countUnreadRows(rows: List<BadgeRow>, kinfolkId: String, locallyRead: Set<String>): Int =
    rows.count { row ->
        row.unread && !row.archived &&
            (row.tribeId.isEmpty() || row.tribeId == kinfolkId) &&
            row.id !in locallyRead
    }

/**
 * What the bell knows right now.
 * - [Waiting]: no snapshot yet (or no tribe to count for). The shell shows the
 *   count `getMyHome` loaded with.
 * - [Live]: the count, current.
 * - [Failed]: the listener failed. The shell shows no badge instead of an old number.
 */
sealed interface LiveUnread {
    data object Waiting : LiveUnread
    data class Live(val count: Int) : LiveUnread
    data object Failed : LiveUnread
}

/**
 * The number the bell draws: the live count once there is one, the count the
 * app opened with until then, and 0 (no badge) after a failed listener.
 */
fun bellCount(live: LiveUnread, seeded: Int): Int = when (live) {
    is LiveUnread.Live -> live.count
    LiveUnread.Failed -> 0
    LiveUnread.Waiting -> seeded.coerceAtLeast(0)
}

/** The store behind the bell. One per app, owned by the composition root. */
class UnreadBadge {
    /** The feed and the taps not yet answered, as one value so a reader never sees half a change. */
    data class Model(
        val rows: List<BadgeRow>? = null,
        val failed: Boolean = false,
        val locallyRead: Set<String> = emptySet(),
        /** Snapshots after the first: the notifications list reloads when this moves. */
        val revision: Int = 0,
    ) {
        fun liveFor(kinfolkId: String?): LiveUnread = when {
            failed -> LiveUnread.Failed
            rows == null || kinfolkId.isNullOrBlank() -> LiveUnread.Waiting
            else -> LiveUnread.Live(countUnreadRows(rows, kinfolkId, locallyRead))
        }
    }

    private val _model = MutableStateFlow(Model())
    val model: StateFlow<Model> = _model

    /** A snapshot arrived. Taps the server has now answered (the row reads as read, or is gone) are forgotten. */
    fun onRows(rows: List<BadgeRow>) = _model.update { old ->
        val stillUnread = rows.filter { it.unread }.map { it.id }.toSet()
        old.copy(
            rows = rows,
            failed = false,
            locallyRead = old.locallyRead intersect stillUnread,
            revision = if (old.rows == null) old.revision else old.revision + 1,
        )
    }

    /** The listener failed. The bell draws no badge from here on. */
    fun onFailed() = _model.update { it.copy(rows = null, failed = true) }

    /** Signed out, or a different person signed in: nothing of the last session is kept. */
    fun reset() = _model.update { Model() }

    /** A row was tapped: it stops counting at once, ahead of the server's answer. */
    fun markReadLocally(id: String) = _model.update { it.copy(locallyRead = it.locallyRead + id) }

    /** The read was refused: the row counts again, which is the truth. */
    fun undoLocalRead(id: String) = _model.update { it.copy(locallyRead = it.locallyRead - id) }
}

/**
 * Feeds [badge] from the signed-in person's own rows until cancelled.
 *
 * A FAILED LISTENER IS QUIET ON SCREEN AND LOUD IN THE LOG, the same ruling as
 * the admin rail's count: the bell draws no badge instead of an old number,
 * there is no banner, and [log] gets the failure so a bell that never shows a
 * badge can be diagnosed. The notifications list stays the place that reports
 * its own failed load. A denial that arrives because the session just ended is
 * expected ([stillSignedIn] is false by then) and is neither shown nor logged.
 */
suspend fun followUnreadBadge(
    firestore: FirestoreClient,
    uid: String,
    badge: UnreadBadge,
    stillSignedIn: () -> Boolean = { true },
    log: (String) -> Unit = { println("[Bell] $it") },
) {
    try {
        firestore.recipientNotificationsStream(uid, UNREAD_SCAN_CAP).collect { docs ->
            badge.onRows(docs.map(::badgeRowOf))
        }
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        if (!stillSignedIn()) return
        badge.onFailed()
        log("unread count unavailable: ${t::class.simpleName}: ${t.message}")
    }
}
