package com.tribetails.auntieos.ui.admin

import com.google.firebase.Timestamp
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.repository.BookingNotesRepository.BookingNote
import com.tribetails.auntieos.data.repository.StaffMember
import com.tribetails.auntieos.data.repository.answerNotesFromVisit
import com.tribetails.auntieos.data.repository.noteMillis
import com.tribetails.auntieos.data.repository.sortKinfolkNotes
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Date

/**
 * #2265, #2227: the reads on the KinCare detail end in an answer: the list,
 * a plain failure the screen offers Try again on, or (for a read that never
 * answers) a failure after the time limit. Virtual time, so the limit is real
 * and the test is instant.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinCareDetailReadsTest {

    @Test
    fun `#2265 the sent KinTales come back newest first and drafts stay out`() = runTest {
        val got = loadVisitTales({
            Result.success(
                listOf(
                    KinCareReport(id = "old", status = "SENT", sentAt = "2026-08-01T10:00:00Z"),
                    KinCareReport(id = "draft", status = "DRAFT", createdAt = "2026-08-03T10:00:00Z"),
                    KinCareReport(id = "new", status = "sent", sentAt = "2026-08-02T10:00:00Z"),
                ),
            )
        })
        assertEquals(listOf("new", "old"), (got as VisitTalesState.Ready).tales.map { it.id })
    }

    @Test
    fun `#2265 a refused read is a failure, never an empty list`() = runTest {
        val got = loadVisitTales({ Result.failure(RuntimeException("FAILED_PRECONDITION")) })
        assertEquals(VisitTalesState.Failed, got)
    }

    @Test
    fun `#2265 a read that never answers is a failure after the time limit`() = runTest {
        val got = loadVisitTales({ awaitCancellation() })
        assertEquals(VisitTalesState.Failed, got)
        assertEquals(VISIT_READ_TIMEOUT_MS, testScheduler.currentTime)
    }

    @Test
    fun `#2227 notes states go Loading then Ready`() = runTest {
        val notes = listOf(BookingNote(id = "n1", body = "Hi"))
        val got = kinfolkNotesStates(flowOf(Result.success(notes))).toList()
        assertEquals(listOf(KinfolkNotesState.Loading, KinfolkNotesState.Ready(notes)), got)
    }

    @Test
    fun `#2227 a failed notes read ends on Failed`() = runTest {
        val got = kinfolkNotesStates(
            flow {
                emit(Result.failure<List<BookingNote>>(RuntimeException("PERMISSION_DENIED")))
                awaitCancellation()
            },
        ).toList()
        assertEquals(listOf(KinfolkNotesState.Loading, KinfolkNotesState.Failed), got)
    }

    @Test
    fun `#2227 a notes read with no first answer ends on Failed after the time limit`() = runTest {
        val got = kinfolkNotesStates(flow<Result<List<BookingNote>>> { awaitCancellation() }).toList()
        assertEquals(listOf(KinfolkNotesState.Loading, KinfolkNotesState.Failed), got)
        assertEquals(VISIT_READ_TIMEOUT_MS, testScheduler.currentTime)
    }

    @Test
    fun `#2227 later answers keep the list live`() = runTest {
        val a = listOf(BookingNote(id = "a"))
        val b = listOf(BookingNote(id = "a"), BookingNote(id = "b"))
        val got = kinfolkNotesStates(flow { emit(Result.success(a)); emit(Result.success(b)) }).toList()
        assertEquals(listOf(KinfolkNotesState.Loading, KinfolkNotesState.Ready(a), KinfolkNotesState.Ready(b)), got)
    }

    @Test
    fun `#2227 the Accept and Decline notes on the visit become office notes, blanks left out`() {
        val at = Timestamp(Date(5_000L))
        val got = answerNotesFromVisit(
            mapOf(
                "requestAcceptNote" to "  See you Tuesday ",
                "requestAcceptedAt" to at,
                "requestAcceptedBy" to "u-owner",
                "requestDeclineNote" to "   ",
            ),
        )
        assertEquals(
            listOf(BookingNote(id = "request-accepted", authorUid = "u-owner", authorRole = "admin", body = "See you Tuesday", createdAtMs = 5_000L)),
            got,
        )
        assertEquals(emptyList<BookingNote>(), answerNotesFromVisit(null))
    }

    @Test
    fun `#2227 a note's time reads from a Timestamp, ISO text or a number, and nothing else`() {
        assertEquals(7_000L, noteMillis(Timestamp(Date(7_000L))))
        assertEquals(1_794_945_900_000L, noteMillis("2026-11-17T20:05:00Z"))
        assertEquals(1_794_945_900_000L, noteMillis("2026-11-17T14:05:00-06:00"))
        assertEquals(42L, noteMillis(42L))
        assertNull(noteMillis(null))
        assertNull(noteMillis("not a date"))
    }

    @Test
    fun `#2227 notes sort oldest first and an unstamped one goes to the top`() {
        val got = sortKinfolkNotes(
            listOf(BookingNote(id = "late", createdAtMs = 9L), BookingNote(id = "pending", createdAtMs = null), BookingNote(id = "early", createdAtMs = 1L)),
        )
        assertEquals(listOf("pending", "early", "late"), got.map { it.id })
    }

    @Test
    fun `#2227 a staff note is named by its writer, never by an email or a role`() {
        val staff = listOf(
            StaffMember(uid = "u1", displayName = "Syd", email = null),
            StaffMember(uid = "u2", displayName = "catch@hanasamku.com", email = null),
        )
        assertEquals("Syd", kinfolkNoteAuthorLabel(BookingNote(authorUid = "u1", authorRole = "admin"), staff))
        assertEquals("Staff", kinfolkNoteAuthorLabel(BookingNote(authorUid = "u2", authorRole = "admin"), staff))
        assertEquals("Staff", kinfolkNoteAuthorLabel(BookingNote(authorUid = "u9", authorRole = "admin"), staff))
        assertEquals("Kinfolk", kinfolkNoteAuthorLabel(BookingNote(authorRole = "kinfolk"), staff))
        assertEquals("Unknown", kinfolkNoteAuthorLabel(BookingNote(authorRole = ""), staff))
    }
}
