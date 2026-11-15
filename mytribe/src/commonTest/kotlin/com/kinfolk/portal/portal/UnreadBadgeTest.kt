package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint
import com.kinfolk.portal.firebase.FakeFirestoreClient
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import com.kinfolk.portal.firebase.NotificationsSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest

/**
 * #1833: "the bell badge does not count a new notice until the page is
 * reloaded." The count is now live. The case table is the one the server's
 * count (functions/test/recipientNotifications.test.ts) and the web portal's
 * (web/src/lib/unreadBadge.test.ts) are tested with.
 */
class UnreadBadgeTest {

    private fun doc(id: String, fields: Map<String, Any?> = emptyMap()) =
        FirestoreDoc(id, mapOf<String, Any?>("recipientUid" to "u1") + fields)

    private fun tribe(id: Any?) = mapOf("data" to mapOf("kinfolkId" to id))

    /** name, document fields, counted on fam1's bell? */
    private val cases: List<Triple<String, Map<String, Any?>, Boolean>> = listOf(
        Triple("no readAt, no archivedAt, names fam1", tribe("fam1"), true),
        Triple("readAt null", tribe("fam1") + ("readAt" to null), true),
        Triple("readAt set", tribe("fam1") + ("readAt" to 1L), false),
        Triple("archivedAt null (restored)", tribe("fam1") + ("archivedAt" to null), true),
        Triple("archivedAt set", tribe("fam1") + ("archivedAt" to 1L), false),
        Triple("archived and read", tribe("fam1") + ("archivedAt" to 1L) + ("readAt" to 2L), false),
        Triple("names another household", tribe("fam2"), false),
        Triple("older spelling familyId, this household", mapOf("data" to mapOf("familyId" to "fam1")), true),
        Triple("older spelling familyId, another household", mapOf("data" to mapOf("familyId" to "fam2")), false),
        Triple("kinfolkId wins over familyId", mapOf("data" to mapOf("kinfolkId" to "fam1", "familyId" to "fam2")), true),
        Triple("a blank kinfolkId falls through to familyId", mapOf("data" to mapOf("kinfolkId" to "  ", "familyId" to "fam2")), false),
        Triple("a numeric household id", tribe(42L), false),
        Triple("names no household", mapOf("data" to emptyMap<String, Any?>()), true),
        Triple("has no data bag at all", emptyMap(), true),
        Triple("data is not an object", mapOf("data" to "x"), true),
        // #2038: "Undo arrived" withdraws the arrival notice it was wrong about.
        Triple("withdrawn by the office", tribe("fam1") + ("archivedAt" to 1L) + ("withdrawnAt" to 1L), false),
        Triple("withdrawn, its archive stamp cleared", tribe("fam1") + ("archivedAt" to null) + ("withdrawnAt" to 1L), false),
        Triple("withdrawn after it was read", tribe("fam1") + ("readAt" to 1L) + ("archivedAt" to 2L) + ("withdrawnAt" to 2L), false),
        Triple("withdrawnAt null", tribe("fam1") + ("withdrawnAt" to null), true),
    )

    @Test
    fun theSharedCaseTable() {
        for ((name, fields, counted) in cases) {
            val n = countUnreadRows(listOf(badgeRowOf(doc("n1", fields))), "fam1", emptySet())
            assertEquals(if (counted) 1 else 0, n, name)
        }
        val all = cases.mapIndexed { i, c -> badgeRowOf(doc("n$i", c.second)) }
        assertEquals(cases.count { it.third }, countUnreadRows(all, "fam1", emptySet()))
    }

    @Test
    fun aNumericHouseholdIdMatchesItsDigits_asLongOrWholeDouble() {
        assertEquals(1, countUnreadRows(listOf(badgeRowOf(doc("a", tribe(42L)))), "42", emptySet()))
        assertEquals(1, countUnreadRows(listOf(badgeRowOf(doc("a", tribe(42.0)))), "42", emptySet()))
    }

    @Test
    fun looksAtTheSameNumberOfRowsAsTheServer() = assertEquals(100, UNREAD_SCAN_CAP)

    private fun unread(id: String, tribeId: String = "fam1") = BadgeRow(id, unread = true, archived = false, tribeId = tribeId)
    private fun read(id: String) = BadgeRow(id, unread = false, archived = false, tribeId = "fam1")
    private fun UnreadBadge.live(kinfolkId: String? = "fam1") = model.value.liveFor(kinfolkId)

    @Test
    fun waitsUntilTheFirstSnapshot_thenIsLive() {
        val badge = UnreadBadge()
        assertEquals(LiveUnread.Waiting, badge.live())
        badge.onRows(listOf(unread("a"), unread("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
    }

    @Test
    fun goesUpWhenANoticeArrives_withNoReload() {
        val badge = UnreadBadge()
        badge.onRows((1..6).map { unread("n$it") })
        assertEquals(LiveUnread.Live(6), badge.live())
        badge.onRows(listOf(unread("omw")) + (1..6).map { unread("n$it") })
        assertEquals(LiveUnread.Live(7), badge.live())
    }

    @Test
    fun goesDownWhenOneIsReadElsewhere_andToZeroWhenAllAre() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a"), unread("b"), unread("c")))
        badge.onRows(listOf(unread("a"), read("b"), unread("c")))
        assertEquals(LiveUnread.Live(2), badge.live())
        badge.onRows(listOf(read("a"), read("b"), read("c")))
        assertEquals(LiveUnread.Live(0), badge.live())
    }

    /**
     * #2038: "Undo arrived" withdraws the arrival notice. The snapshot that
     * carries the stamp is what moves the bell, with no reload.
     */
    @Test
    fun goesDownWhenTheOfficeWithdrawsAnArrivalNotice_readOrUnread() {
        val badge = UnreadBadge()
        fun row(id: String, extra: Map<String, Any?> = emptyMap()) = badgeRowOf(doc(id, tribe("fam1") + extra))
        badge.onRows(listOf(row("arrived"), row("invoice"), row("seen", mapOf("readAt" to 1L))))
        assertEquals(LiveUnread.Live(2), badge.live())

        badge.onRows(
            listOf(
                row("arrived", mapOf("archivedAt" to 2L, "withdrawnAt" to 2L, "withdrawnReason" to "arrival_undone")),
                row("invoice"),
                row("seen", mapOf("readAt" to 1L, "archivedAt" to 2L, "withdrawnAt" to 2L)),
            ),
        )
        assertEquals(LiveUnread.Live(1), badge.live())
    }

    @Test
    fun aWithdrawnRowTappedAMomentBeforeIsNotCountedTwiceOrHeldBack() {
        val badge = UnreadBadge()
        fun row(id: String, extra: Map<String, Any?> = emptyMap()) = badgeRowOf(doc(id, tribe("fam1") + extra))
        badge.onRows(listOf(row("arrived"), row("invoice")))
        badge.markReadLocally("arrived")
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.onRows(listOf(row("arrived", mapOf("archivedAt" to 2L, "withdrawnAt" to 2L)), row("invoice")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }

    @Test
    fun goesBackUpWhenTheOfficeMarksOneUnread() {
        val badge = UnreadBadge()
        badge.onRows(listOf(read("a")))
        badge.onRows(listOf(unread("a")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }

    @Test
    fun aTapCountsAtOnce_andIsNotCountedTwiceWhenItsSnapshotLands() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a"), unread("b")))
        badge.markReadLocally("a")
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.onRows(listOf(unread("new"), unread("a"), unread("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
        badge.onRows(listOf(unread("new"), read("a"), unread("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
    }

    @Test
    fun forgetsATapOnceTheServerAnswered_soALaterMarkUnreadCounts() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a")))
        badge.markReadLocally("a")
        badge.onRows(listOf(read("a")))
        badge.onRows(listOf(unread("a")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }

    @Test
    fun putsTheRowBackWhenTheReadWasRefused() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a"), unread("b")))
        badge.markReadLocally("a")
        badge.undoLocalRead("a")
        assertEquals(LiveUnread.Live(2), badge.live())
    }

    @Test
    fun countsEachTribeUnderThatTribe_andWaitsWithNoTribe() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a", "fam1"), unread("b", "fam2"), unread("c", "")))
        assertEquals(LiveUnread.Live(2), badge.live("fam1"))
        assertEquals(LiveUnread.Live(2), badge.live("fam2"))
        assertEquals(LiveUnread.Waiting, badge.live(null))
        assertEquals(LiveUnread.Waiting, badge.live(""))
    }

    @Test
    fun revisionMovesOnEverySnapshotAfterTheFirst() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a")))
        assertEquals(0, badge.model.value.revision)
        badge.onRows(listOf(unread("b"), unread("a")))
        assertEquals(1, badge.model.value.revision)
    }

    @Test
    fun resetKeepsNothingOfTheLastSession() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unread("a")))
        badge.markReadLocally("a")
        badge.reset()
        assertEquals(LiveUnread.Waiting, badge.live())
        badge.onRows(listOf(unread("a")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }

    @Test
    fun bellCount_isLiveThenSeeded_andNothingAfterAFailure() {
        assertEquals(7, bellCount(LiveUnread.Live(7), seeded = 6))
        assertEquals(0, bellCount(LiveUnread.Live(0), seeded = 6))
        assertEquals(6, bellCount(LiveUnread.Waiting, seeded = 6))
        assertEquals(0, bellCount(LiveUnread.Waiting, seeded = -3))
        assertEquals(0, bellCount(LiveUnread.Failed, seeded = 6))
    }

    // ---- #2329: a tap the office answered first, and the cache ----
    // The bell undercounted by one until a restart when the office put a
    // tapped notice back on the list before the read reached this device, and
    // an empty cache drew 0 over the count the app opened with.
    private fun unreadAt(id: String, issued: Long? = 100L) = BadgeRow(id, unread = true, archived = false, tribeId = "fam1", issuedAtMs = issued)
    private fun readAt(id: String, issued: Long? = 100L) = BadgeRow(id, unread = false, archived = false, tribeId = "fam1", issuedAtMs = issued)
    @Test
    fun readsTheIssueTimeOffCreatedAt_andNullWhenThereIsNone() {
        assertEquals(1_700_000_000_123L, badgeRowOf(doc("a", mapOf("createdAt" to 1_700_000_000_123L))).issuedAtMs)
        assertEquals(null, badgeRowOf(doc("a")).issuedAtMs)
        assertEquals(null, badgeRowOf(doc("a", mapOf("createdAt" to "yesterday"))).issuedAtMs)
    }
    @Test
    fun aTapThenItsRead_oneLess_andNoJumpInBetween() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        badge.markReadLocally("a")
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.onRows(listOf(readAt("a"), unreadAt("b")))
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.confirmLocalRead("a")
        badge.onRows(listOf(readAt("a"), unreadAt("b")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }
    @Test
    fun aTapTheServerTook_thenASnapshotThatStillReadsUnread_countsTheRowAgain() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        badge.markReadLocally("a")
        badge.confirmLocalRead("a")
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
    }
    @Test
    fun aTapTheServerHasNotAnswered_staysOffTheBellWhileTheRowStillReadsUnread() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        badge.markReadLocally("a")
        badge.onRows(listOf(unreadAt("new"), unreadAt("a"), unreadAt("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
    }
    @Test
    fun theOfficeIssuingTheNoticeAgain_countsItAtOnce_evenBeforeTheServerAnswersTheTap() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("arrived", 100L), unreadAt("b")))
        badge.markReadLocally("arrived")
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.onRows(listOf(unreadAt("arrived", 900L), unreadAt("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
        badge.confirmLocalRead("arrived")
        badge.onRows(listOf(readAt("arrived", 900L), unreadAt("b")))
        assertEquals(LiveUnread.Live(1), badge.live())
    }
    @Test
    fun aTapBeforeTheFeedHeldTheRow_takesTheIssueFromTheFirstSnapshotThatDoes() {
        val badge = UnreadBadge()
        badge.markReadLocally("a")
        badge.onRows(listOf(unreadAt("a", 100L), unreadAt("b")))
        assertEquals(LiveUnread.Live(1), badge.live())
        badge.onRows(listOf(unreadAt("a", 900L), unreadAt("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
    }
    @Test
    fun aRefusedReadStillPutsTheRowBack_answeredOrNot() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        badge.markReadLocally("a")
        badge.undoLocalRead("a")
        badge.confirmLocalRead("a")
        assertEquals(LiveUnread.Live(2), badge.live())
    }
    @Test
    fun anEmptyCachedSnapshotBeforeTheServerAnswered_isNotTaken_soTheBellKeepsItsOpeningCount() {
        val badge = UnreadBadge()
        badge.onRows(emptyList(), fromCache = true)
        assertEquals(LiveUnread.Waiting, badge.live())
        assertEquals(6, bellCount(badge.live(), seeded = 6))
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        assertEquals(LiveUnread.Live(2), badge.live())
        // The server's first answer is the first snapshot taken: nothing to reload for.
        assertEquals(0, badge.model.value.revision)
    }
    @Test
    fun theServerAnsweringWithNothingUnread_isTaken_andIsZero() {
        val badge = UnreadBadge()
        badge.onRows(emptyList(), fromCache = true)
        badge.onRows(emptyList())
        assertEquals(LiveUnread.Live(0), badge.live())
    }
    @Test
    fun onceTheServerAnswered_aCachedSnapshotIsTaken() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a"), unreadAt("b")))
        badge.onRows(listOf(unreadAt("a"), readAt("b")), fromCache = true)
        assertEquals(LiveUnread.Live(1), badge.live())
    }
    @Test
    fun aSnapshotThatChangesNoRow_doesNotReloadTheList() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a")))
        badge.onRows(listOf(unreadAt("a")), fromCache = true)
        assertEquals(0, badge.model.value.revision)
    }
    @Test
    fun aNewSignInWaitsForTheServerAgain() {
        val badge = UnreadBadge()
        badge.onRows(listOf(unreadAt("a")))
        badge.reset()
        badge.onRows(emptyList(), fromCache = true)
        assertEquals(LiveUnread.Waiting, badge.live())
    }
    @Test
    fun followUnreadBadgePassesTheCacheFlagThrough() = runTest(UnconfinedTestDispatcher()) {
        val snapshots = MutableSharedFlow<NotificationsSnapshot>()
        val badge = UnreadBadge()
        val job = launch { followUnreadBadge(Streaming(snapshots), "u1", badge) }
        snapshots.emit(NotificationsSnapshot(emptyList(), fromCache = true))
        assertEquals(LiveUnread.Waiting, badge.live())
        snapshots.emit(NotificationsSnapshot(listOf(doc("a", tribe("fam1"))), fromCache = false))
        assertEquals(LiveUnread.Live(1), badge.live())
        job.cancel()
    }
    // ---- followUnreadBadge: the listener's lifecycle ----

    private class Streaming(private val stream: Flow<NotificationsSnapshot>) : FirestoreClient {
        val asked = mutableListOf<Pair<String, Int>>()
        override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? = null
        override suspend fun listDocuments(collection: String): List<FirestoreDoc> = emptyList()
        override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
        override fun recipientNotificationsStream(recipientUid: String, limit: Int): Flow<NotificationsSnapshot> {
            asked += recipientUid to limit
            return stream
        }
    }

    @Test
    fun followsTheSignedInPersonsNewest100_andCountsEachSnapshot() = runTest(UnconfinedTestDispatcher()) {
        val snapshots = MutableSharedFlow<NotificationsSnapshot>()
        val client = Streaming(snapshots)
        val badge = UnreadBadge()
        val job = launch { followUnreadBadge(client, "u1", badge) }
        assertEquals(listOf("u1" to 100), client.asked)
        assertEquals(LiveUnread.Waiting, badge.live())

        snapshots.emit(NotificationsSnapshot((1..6).map { doc("n$it", tribe("fam1")) }))
        assertEquals(LiveUnread.Live(6), badge.live())
        // The Auntie taps "OMW": a seventh row, no reload.
        snapshots.emit(NotificationsSnapshot(listOf(doc("omw", tribe("fam1"))) + (1..6).map { doc("n$it", tribe("fam1")) }))
        assertEquals(LiveUnread.Live(7), badge.live())
        // Every row marked read at once.
        snapshots.emit(NotificationsSnapshot((listOf("omw") + (1..6).map { "n$it" }).map { doc(it, tribe("fam1") + ("readAt" to 9L)) }))
        assertEquals(LiveUnread.Live(0), badge.live())
        job.cancel()
    }

    @Test
    fun aFailedListenerIsQuietOnScreenAndLogged() = runTest(UnconfinedTestDispatcher()) {
        val logged = mutableListOf<String>()
        val client = Streaming(flow {
            emit(NotificationsSnapshot(listOf(doc("a"))))
            throw IllegalStateException("PERMISSION_DENIED")
        })
        val badge = UnreadBadge()
        followUnreadBadge(client, "u1", badge, log = { logged += it })
        assertEquals(LiveUnread.Failed, badge.live())
        assertEquals(0, bellCount(badge.live(), seeded = 6))
        assertEquals(1, logged.size)
        assertTrue(logged.single().contains("PERMISSION_DENIED"), logged.single())
    }

    @Test
    fun theDenialThatFollowsSignOutIsNeitherShownNorLogged() = runTest(UnconfinedTestDispatcher()) {
        val logged = mutableListOf<String>()
        val client = Streaming(flow { throw IllegalStateException("PERMISSION_DENIED") })
        val badge = UnreadBadge()
        followUnreadBadge(client, "u1", badge, stillSignedIn = { false }, log = { logged += it })
        assertEquals(LiveUnread.Waiting, badge.live())
        assertTrue(logged.isEmpty())
    }

    @Test
    fun aClientWithNoLiveStreamKeepsTheCountTheAppOpenedWith() = runTest(UnconfinedTestDispatcher()) {
        val badge = UnreadBadge()
        followUnreadBadge(FakeFirestoreClient(), "u1", badge)
        assertEquals(LiveUnread.Waiting, badge.live())
        assertEquals(6, bellCount(badge.live(), seeded = 6))
    }
}
