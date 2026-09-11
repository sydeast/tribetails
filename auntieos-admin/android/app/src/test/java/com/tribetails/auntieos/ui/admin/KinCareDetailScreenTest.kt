package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.data.model.GpsSummary
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
        // #760's route panel reads the breadcrumb subcollection, so this joins
        // the list above for the reason stated above rather than as
        // boilerplate: left to the relaxed default, `onSuccess` on the returned
        // value throws ClassCastException the moment a session actually
        // resolves, which is every test below that renders a visit.
        coEvery { kinCareRepo.getBreadcrumbs(any()) } returns Result.success(emptyList())
        val notesRepo = mockk<BookingNotesRepository>(relaxed = true)
        every { notesRepo.streamKinfolkFacingNotes(any(), any()) } returns flowOf(emptyList())
        every { notesRepo.streamInternalNotes(any(), any()) } returns flowOf(emptyList())
        rule.setContent {
            AuntieOSTheme {
                KinCareDetailScreen(
                    kinCareId = "vis_ses1",
                    onBack = {},
                    // No household coordinate, so no purple house marker. The
                    // production default answers null under Robolectric anyway
                    // (it catches the uninitialised FirebaseApp), but saying so
                    // here keeps this screen's specs off Firebase by contract
                    // rather than by a caught exception.
                    householdLocation = { null },
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

    /**
     * #754: the Location section used to be OMITTED once the visit was
     * neither active nor carried a `visitRouteId`, so a finished visit that
     * was simply never clocked in with GPS on told the office nothing at all.
     */
    @Test
    fun `a finished visit with no route and no GPS summary names itself never tracked`() {
        val session = KinCareSession(
            id = "vis_ses1",
            kinfolkId = "fam1",
            kinfolkName = "The Osei family",
            status = "COMPLETED",
            arrivedAt = "",
            departedAt = "",
            visitRouteId = "",
            gpsSummary = null,
        )
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.success(session)

        mount(kinCareRepo)

        rule.onNodeWithText(
            "No GPS breadcrumbs were recorded for this Kin Care because it was never tracked.",
        ).assertIsDisplayed()
    }

    /**
     * #754: a `gpsSummary` can exist (distance/duration saved on DEPARTED)
     * with no `visitRouteId` ever set, which is a different true fact from
     * never tracked and must say so rather than reusing that sentence.
     */
    @Test
    fun `a finished visit with a GPS summary but no route to view names itself summary-only`() {
        val session = KinCareSession(
            id = "vis_ses1",
            kinfolkId = "fam1",
            kinfolkName = "The Osei family",
            status = "COMPLETED",
            arrivedAt = "2026-08-19T14:00:00",
            departedAt = "2026-08-19T14:30:00",
            visitRouteId = "",
            gpsSummary = GpsSummary(distanceMeters = 400.0, durationSeconds = 300L),
        )
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.success(session)

        mount(kinCareRepo)

        rule.onNodeWithText(
            "A GPS summary was saved for this Kin Care, but it has no route to view.",
        ).assertIsDisplayed()
    }

    /**
     * #754 regression guard: a session that has not been clocked into yet also
     * has no `arrivedAt`, no `visitRouteId`, and no `gpsSummary` - the same
     * shape as a truly never-tracked finished visit. Without the SCHEDULED /
     * ON_MY_WAY carve-out, "never tracked" would render on a booking that
     * simply has not happened yet.
     */
    @Test
    fun `a scheduled visit says tracking has not started, not never tracked`() {
        val session = KinCareSession(
            id = "vis_ses1",
            kinfolkId = "fam1",
            kinfolkName = "The Osei family",
            status = "SCHEDULED",
            arrivedAt = "",
            departedAt = "",
            visitRouteId = "",
            gpsSummary = null,
        )
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("vis_ses1") } returns Result.success(session)

        mount(kinCareRepo)

        rule.onNodeWithText(
            "Tracking starts once an Auntie clocks in for this Kin Care.",
        ).assertIsDisplayed()
    }
}
