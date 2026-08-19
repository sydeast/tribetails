package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingNotesRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #446: this screen used to resolve its visit by reading every
 * `kin_care_sessions` doc and scanning for the matching id. These tests pin
 * the by-id fetch (`KinCareRepository.getKinCareSession`, never
 * `getKinCareSessions`) and the three states it must produce, mirroring
 * `useDocById` on web (PR #432, `lib/firestore.ts`): opening, not available
 * (covers both a missing doc and one denied by Firestore rules - the sandbox
 * "not yours to see" case), and a genuine read error with Retry.
 *
 * Every entry point (`KinCareSessionsScreen.onOpenDetail` from both the
 * AuntieTime tab and Admin Data, and the `booking` notification deep link via
 * `sessionIdForVisit`) lands here with nothing but a flat session id, so one
 * successful-load test through the same `kinCareId` contract those callers
 * use covers all three - see `Navigation.kt`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class KinCareDetailScreenTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun mount(
        kinCareRepo: KinCareRepository,
        repo: AuntieRepository = mockk(relaxed = true),
    ) {
        // Explicit, not relaxed-default: `Result<T>` is a value class and the
        // relaxed default is not a return value these call sites can safely
        // unwrap. Harmless to set even on the not-found/error tests, which
        // never reach these calls (guarded by `s != null` in the screen).
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getKinByIds(any()) } returns Result.success(emptyMap())
        coEvery { repo.get411ByKinIds(any()) } returns Result.success(emptyMap())
        coEvery { kinCareRepo.getReportsForSession(any()) } returns Result.success(emptyList())
        val notesRepo = mockk<BookingNotesRepository>(relaxed = true)
        every { notesRepo.streamKinfolkFacingNotes(any(), any()) } returns flowOf(emptyList())
        every { notesRepo.streamInternalNotes(any(), any()) } returns flowOf(emptyList())
        rule.setContent {
            AuntieOSTheme {
                KinCareDetailScreen(
                    kinCareId = "vis_ses1",
                    onBack = {},
                    repo = repo,
                    kinCareRepo = kinCareRepo,
                    notesRepo = notesRepo,
                )
            }
        }
        rule.waitForIdle()
    }

    /**
     * The AuntieTime tab, the Admin Data > Kin Care Sessions list, and the
     * `booking` notification deep link all pass the same flat session id
     * into this screen; this proves that contract resolves to a real visit
     * via the by-id fetch, not the collection scan it replaces.
     */
    @Test
    fun `an entry point's session id fetches by id and renders the visit`() {
        val session = KinCareSession(
            id = "vis_ses1",
            kinfolkId = "fam1",
            kinfolkName = "The Wrens",
            serviceType = "Dog walk",
            startTime = "2026-08-19T14:00:00",
            endTime = "2026-08-19T14:30:00",
        )
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.success(session)
        coEvery { kinCareRepo.getKinCareSessions() } throws AssertionError(
            "must fetch by id, not scan the whole collection"
        )

        mount(kinCareRepo)

        rule.onNodeWithText("The Wrens").assertIsDisplayed()
        rule.onNodeWithText("Dog walk · Aug 19 · 14:00 - 14:30").assertIsDisplayed()
    }

    @Test
    fun `a session id with no document shows the not-available copy, not an empty screen`() {
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.success(null)

        mount(kinCareRepo)

        rule.onNodeWithText(
            "This Kin Care isn't available to open. A visit gets its own record " +
                "only once the request is approved, so a request still waiting on " +
                "you has none yet. Otherwise it may have been cancelled or removed.",
        ).assertIsDisplayed()
    }

    /**
     * A sandbox test admin opening a session outside their scope gets
     * PERMISSION_DENIED straight from the Firestore rule, not a missing doc.
     * `useDocById` folds that into the same "not available" answer rather
     * than a rules error, so this screen must too - a distinct scary error
     * here would turn the deep link into an existence oracle.
     */
    @Test
    fun `a session this caller may not see shows the same not-available copy, not an error`() {
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val denied = mockk<FirebaseFirestoreException>()
        every { denied.code } returns FirebaseFirestoreException.Code.PERMISSION_DENIED
        every { denied.message } returns "PERMISSION_DENIED"
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.failure(denied)

        mount(kinCareRepo)

        rule.onNodeWithText(
            "This Kin Care isn't available to open. A visit gets its own record " +
                "only once the request is approved, so a request still waiting on " +
                "you has none yet. Otherwise it may have been cancelled or removed.",
        ).assertIsDisplayed()
    }

    @Test
    fun `a genuine read failure gets its own error message and a Retry, and retry re-fetches`() {
        val session = KinCareSession(id = "vis_ses1", kinfolkId = "fam1", kinfolkName = "The Devlins")
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        var attempt = 0
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } answers {
            attempt += 1
            if (attempt == 1) Result.failure(RuntimeException("Network unreachable"))
            else Result.success(session)
        }

        mount(kinCareRepo)

        rule.onNodeWithText("Network unreachable").assertIsDisplayed()
        rule.onNodeWithText("Retry").assertIsDisplayed()
        rule.onNodeWithText(
            "This Kin Care isn't available to open. A visit gets its own record " +
                "only once the request is approved, so a request still waiting on " +
                "you has none yet. Otherwise it may have been cancelled or removed.",
        ).assertDoesNotExist()

        rule.onNodeWithText("Retry").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("The Devlins").assertIsDisplayed()
        rule.onNodeWithText("Network unreachable").assertDoesNotExist()
    }
}
