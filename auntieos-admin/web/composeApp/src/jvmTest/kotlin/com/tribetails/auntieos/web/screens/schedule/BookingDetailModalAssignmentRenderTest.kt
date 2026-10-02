package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareAssignment
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.datetime.TimeZone
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #898: a failed one-shot read of the assignment doc used to leave
 * assignedUid/assignedName at their initial null, which the row rendered as
 * "Unassigned" -- indistinguishable from a booking that genuinely has nobody
 * assigned. With no [JvmFirestoreFixtures.kinCareAssignments] entry the read
 * hits the token check (no signed-in user in a jvm test) and fails, which is
 * what this test seeds.
 */
@OptIn(ExperimentalTestApi::class)
class BookingDetailModalAssignmentRenderTest {

    private val session = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinCareBatchId = "b1",
        kinCareVisitId = "v1",
    )

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun aFailedAssignmentReadShowsCouldntCheckNotUnassigned() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingDetailModal(session = session, onDismiss = {}, client = FirestoreClient(), zone = TimeZone.of("America/Chicago"))
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Couldn't check the assignment", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assert(onAllNodesWithText("Unassigned", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "a failed assignment read must not read as genuinely unassigned"
        }

        // Retry recovers once the read can answer.
        JvmFirestoreFixtures.kinCareAssignments = mapOf("kf1/b1/v1" to KinCareAssignment())
        onNodeWithTag(ASSIGN_LOAD_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Unassigned", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assert(onAllNodesWithText("Couldn't check the assignment", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }
}
