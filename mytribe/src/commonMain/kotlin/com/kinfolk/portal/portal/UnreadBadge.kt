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
 * archived means `archivedAt` carries a value (or `withdrawnAt` does: a notice
 * the office took back, #2038), unread means `readAt` does not,
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
    /** Filed away by the reader, or withdrawn by the office. Either way it is not counted. */
    val archived: Boolean,
    /** The household the row names, blank when it names none. */
    val tribeId: String,
    /**
     * #2329: when the row was issued (`createdAt`, epoch ms), null when it
     * carries none. The office putting a notice back on the list (a real
     * arrival after an undone one) stamps it again, which is how a tap on the
     * earlier issue is told apart from it.
     */
    val issuedAtMs: Long? = null,
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
        // #2038: a notice the office took back ("Undo arrived") never counts,
        // whatever its archive stamp reads.
        archived = doc.fields["archivedAt"] != null || doc.fields["withdrawnAt"] != null,
        tribeId = named,
        // The native client hands a Timestamp over as epoch ms.
        issuedAtMs = (doc.fields["createdAt"] as? Number)?.toLong(),
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

/**
 * A row tapped on this device whose read has not shown up in a snapshot yet.
 * [issuedAtMs] is the row's issue as the feed held it at the tap; [issueKnown]
 * is false when the feed did not hold the row yet, and the first snapshot that
 * does fills it in. [answered] is set once `markNotificationRead` came back.
 */
data class LocalTap(val issuedAtMs: Long?, val issueKnown: Boolean, val answered: Boolean = false)
/** The store behind the bell. One per app, owned by the composition root. */
class UnreadBadge {
    /** The feed and the taps not yet answered, as one value so a reader never sees half a change. */
    data class Model(
        val rows: List<BadgeRow>? = null,
        val failed: Boolean = false,
        val taps: Map<String, LocalTap> = emptyMap(),
        /** Snapshots after the first that changed a row: the notifications list reloads when this moves. */
        val revision: Int = 0,
        /** #2329: a snapshot has come from the server at least once since sign-in. */
        val serverAnswered: Boolean = false,
    ) {
        /** The rows tapped here that the bell leaves out. */
        val locallyRead: Set<String> get() = taps.keys
        fun liveFor(kinfolkId: String?): LiveUnread = when {
            failed -> LiveUnread.Failed
            rows == null || kinfolkId.isNullOrBlank() -> LiveUnread.Waiting
            else -> LiveUnread.Live(countUnreadRows(rows, kinfolkId, locallyRead))
        }
    }
    private val _model = MutableStateFlow(Model())
    val model: StateFlow<Model> = _model
    /**
     * A snapshot arrived.
     *
     * A TAP IS LET GO when the snapshot shows its read (the row reads as read,
     * or is gone), and also (#2329) when the row still reads unread but cannot
     * be waiting on the tap any more: the office has issued it again since
     * ([BadgeRow.issuedAtMs] moved), or `markNotificationRead` had already come
     * back before this snapshot and this snapshot is the server's (one from
     * the cache, the connection having dropped, may predate the read).
     * Without those two the office marking a tapped
     * notice unread before the read reached this device left the tap
     * subtracting until the app was restarted.
     *
     * #2329: A SNAPSHOT FROM THE DEVICE'S CACHE BEFORE THE SERVER HAS ANSWERED
     * ONCE IS NOT TAKEN. An empty cache (a fresh install, or an offline start)
     * drew a confident 0 over the count the app opened with. Once the server
     * has answered, a cached snapshot (the connection dropped) holds what the
     * server last said and is taken as usual. The web portal's
     * `lib/unreadBadge.ts` has the same rules.
     *
     * [rowsChanged] is false for a snapshot that changed no row (only where it
     * came from); the open list is not re-read for it.
     */
    fun onRows(rows: List<BadgeRow>, fromCache: Boolean = false, rowsChanged: Boolean = true) = _model.update { old ->
        if (fromCache && !old.serverAnswered) return@update old
        val byId = rows.associateBy { it.id }
        val taps = buildMap {
            for ((id, tap) in old.taps) {
                val row = byId[id] ?: continue
                if (!row.unread || (tap.answered && !fromCache)) continue
                when {
                    !tap.issueKnown -> put(id, tap.copy(issuedAtMs = row.issuedAtMs, issueKnown = true))
                    tap.issuedAtMs == row.issuedAtMs -> put(id, tap)
                }
            }
        }
        old.copy(
            rows = rows,
            failed = false,
            taps = taps,
            revision = if (old.rows == null || !rowsChanged) old.revision else old.revision + 1,
            serverAnswered = old.serverAnswered || !fromCache,
        )
    }
    /** The listener failed. The bell draws no badge from here on. */
    fun onFailed() = _model.update { it.copy(rows = null, failed = true) }
    /** Signed out, or a different person signed in: nothing of the last session is kept. */
    fun reset() = _model.update { Model() }
    /** A row was tapped: it stops counting at once, ahead of the server's answer. */
    fun markReadLocally(id: String) = _model.update { m ->
        if (id in m.taps) return@update m
        val row = m.rows?.firstOrNull { it.id == id }
        m.copy(taps = m.taps + (id to LocalTap(issuedAtMs = row?.issuedAtMs, issueKnown = row != null)))
    }
    /**
     * #2329: the server took the read. The row keeps not counting until the
     * next snapshot, which carries the read (or, if the office marked it
     * unread again in between, carries that, and the row counts again).
     */
    fun confirmLocalRead(id: String) = _model.update { m ->
        val tap = m.taps[id] ?: return@update m
        m.copy(taps = m.taps + (id to tap.copy(answered = true)))
    }
    /** The read was refused: the row counts again, which is the truth. */
    fun undoLocalRead(id: String) = _model.update { it.copy(taps = it.taps - id) }
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
        firestore.recipientNotificationsStream(uid, UNREAD_SCAN_CAP).collect { snapshot ->
            badge.onRows(snapshot.docs.map(::badgeRowOf), fromCache = snapshot.fromCache, rowsChanged = snapshot.rowsChanged)
        }
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        if (!stillSignedIn()) return
        badge.onFailed()
        log("unread count unavailable: ${t::class.simpleName}: ${t.message}")
    }
}
