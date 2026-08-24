package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The visit picker behind the household profile's "New KinTale" (#552).
 *
 * Two things are worth pinning and they are different questions: WHICH QUERY it
 * asks (one household's sessions, not everyone's, filtered on the phone) and WHAT
 * IT DOES WITH THE ANSWER (eligible only, newest first, and a failed read kept
 * distinguishable from an empty one).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NewKinTaleViewModelTest {

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun session(
        id: String,
        status: String = "DEPARTED",
        kinfolkId: String = "kf1",
        startTime: String = "2026-07-16T14:00:00.000Z",
        kinfolkName: String = "The Whitfields",
    ) = KinCareSession(
        id = id,
        kinfolkId = kinfolkId,
        kinfolkName = kinfolkName,
        serviceType = "Dog Walk",
        startTime = startTime,
        status = status,
    )

    // ── the query it asks ────────────────────────────────────────────────────

    @Test
    fun `opened from a profile it asks Firestore for that household only`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(listOf(session("a")))

        NewKinTaleViewModel(repo).load("kf1")

        coVerify(exactly = 1) { repo.getKinCareSessionsForKinfolk("kf1") }
        // Never the whole collection: the operator opened ONE household's profile,
        // and pulling every session to filter on the phone is the read this exists
        // to avoid.
        coVerify(exactly = 0) { repo.getKinCareSessions() }
    }

    @Test
    fun `opened with no household it falls back to every session`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessions() } returns Result.success(listOf(session("a")))

        NewKinTaleViewModel(repo).load("")

        coVerify(exactly = 1) { repo.getKinCareSessions() }
        coVerify(exactly = 0) { repo.getKinCareSessionsForKinfolk(any()) }
    }

    // ── what it does with the answer ─────────────────────────────────────────

    @Test
    fun `only departed and completed visits reach the picker`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(
                session("departed", status = "DEPARTED"),
                session("scheduled", status = "SCHEDULED"),
                session("arrived", status = "ARRIVED"),
                session("completed", status = "COMPLETED"),
                session("cancelled", status = "CANCELLED"),
            ),
        )

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")

        assertEquals(setOf("departed", "completed"), vm.uiState.value.sessions.map { it.id }.toSet())
    }

    @Test
    fun `the most recent visit is offered first, and a session with no date sorts last`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(
                session("older", startTime = "2026-07-01T09:00:00.000Z"),
                session("undated", startTime = ""),
                session("newest", startTime = "2026-08-20T09:00:00.000Z"),
            ),
        )

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")

        assertEquals(listOf("newest", "older", "undated"), vm.uiState.value.sessions.map { it.id })
    }

    @Test
    fun `a household with nothing eligible is empty, not an error`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session("scheduled", status = "SCHEDULED")),
        )

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")

        val state = vm.uiState.value
        assertTrue(state.isEmpty)
        assertNull(state.error)
        assertFalse(state.isLoading)
    }

    @Test
    fun `a failed read is an error with a retry, never an empty list`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns
            Result.failure(IllegalStateException("offline"))

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")

        val state = vm.uiState.value
        assertEquals("Couldn't load visits: offline", state.error)
        // "We could not ask" must not render as "there is nothing to write up".
        assertFalse(state.isEmpty)
        assertTrue(state.sessions.isEmpty())
    }

    @Test
    fun `retry re-asks for the same household, and a transient failure recovers`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returnsMany listOf(
            Result.failure(IllegalStateException("offline")),
            Result.success(listOf(session("a"))),
        )

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")
        assertEquals("Couldn't load visits: offline", vm.uiState.value.error)

        vm.retry()

        assertNull(vm.uiState.value.error)
        assertEquals(listOf("a"), vm.uiState.value.sessions.map { it.id })
        coVerify(exactly = 2) { repo.getKinCareSessionsForKinfolk("kf1") }
    }

    @Test
    fun `the household name comes off the sessions rather than a route argument`() {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session("a", kinfolkName = "The Whitfields")),
        )

        val vm = NewKinTaleViewModel(repo)
        vm.load("kf1")

        assertEquals("The Whitfields", vm.uiState.value.householdName)
        assertEquals(
            "Visits for The Whitfields that have already happened.",
            pickerSubtitle(vm.uiState.value),
        )
    }

    @Test
    fun `the copy holds up before any session has arrived and when none ever will`() {
        val loading = NewKinTaleUiState(isLoading = true, kinfolkId = "kf1")
        assertEquals("Visits for this household that have already happened.", pickerSubtitle(loading))

        val unscoped = NewKinTaleUiState(isLoading = false, kinfolkId = "")
        assertEquals(
            "A KinTale always starts from a visit that has already happened.",
            pickerSubtitle(unscoped),
        )
        assertTrue(emptyMessage(unscoped).startsWith("Nothing has departed or completed yet"))
        assertTrue(emptyMessage(loading).contains("This household"))
    }

    // ── the pure filter, without a ViewModel around it ───────────────────────

    @Test
    fun `eligibleKinTaleSessions is total over an empty list`() {
        assertEquals(emptyList<KinCareSession>(), eligibleKinTaleSessions(emptyList()))
    }
}
