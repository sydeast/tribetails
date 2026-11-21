package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BookingNote
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.datetime.TimeZone
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #2227: the console's visit sheet lists the visit's kinfolk-facing notes, says
 * plainly when they could not be read and offers Try again, and says so when
 * the visit has no booking request to read them from.
 */
@OptIn(ExperimentalTestApi::class)
class BookingDetailModalKinfolkNotesRenderTest {

    private val session = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinfolkName = "The Wrens",
        kinCareBatchId = "b1",
        kinCareVisitId = "v1",
    )

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun has(text: String, test: androidx.compose.ui.test.ComposeUiTest) =
        test.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theSheetListsTheHouseholdsAndTheOfficesNotes() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolkFacingNotes = mapOf(
            "kf1/b1/v1" to listOf(
                BookingNote(_id = "n1", authorRole = "kinfolk", body = "Side gate code changed", createdAtMs = 1L),
                BookingNote(_id = "request-accepted", authorRole = "admin", body = "See you Tuesday", createdAtMs = 2L),
            ),
        )
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingDetailModal(session = session, onDismiss = {}, client = FirestoreClient(), zone = TimeZone.of("America/Chicago"))
            }
        }
        waitUntil(timeoutMillis = 10_000) { has("Side gate code changed", this) }
        assert(has("See you Tuesday", this))
        assert(!has("No kinfolk-facing notes yet.", this))
    }

    @Test
    fun aFailedReadSaysSoAndTryAgainReadsAgain() = runDesktopComposeUiTest {
        // No fixture and nobody signed in: the real read fails at its token check.
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingDetailModal(session = session, onDismiss = {}, client = FirestoreClient(), zone = TimeZone.of("America/Chicago"))
            }
        }
        waitUntil(timeoutMillis = 10_000) { has(KINFOLK_NOTES_FAILED, this) }
        assert(!has("No kinfolk-facing notes yet.", this)) { "a failed read must not read as no notes" }
        // Plain words: the old "Could not load notes: <transport message>" line is gone.
        // (Other panels on the sheet fail at the same token check and keep their own copy.)
        assert(onAllNodesWithText("Could not load notes:", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())

        JvmFirestoreFixtures.kinfolkFacingNotes = mapOf(
            "kf1/b1/v1" to listOf(BookingNote(_id = "n1", authorRole = "kinfolk", body = "Back again")),
        )
        onNodeWithTag(NOTES_LOAD_RETRY_TAG, useUnmergedTree = true).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { has("Back again", this) }
        assert(!has(KINFOLK_NOTES_FAILED, this))
    }

    @Test
    fun aVisitWithNoBookingRequestSaysItHasNoNotesToShow() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingDetailModal(
                    session = session.copy(kinCareBatchId = null, kinCareVisitId = null),
                    onDismiss = {},
                    client = FirestoreClient(),
                    zone = TimeZone.of("America/Chicago"),
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) { has(KINFOLK_NOTES_NO_RECORD, this) }
        assert(!has("No kinfolk-facing notes yet.", this))
        assert(!has(KINFOLK_NOTES_FAILED, this))
    }
}
