package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.draftFromFields
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.home.reviewTarget
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1563: the KinTales list never read `generated_drafts`, so every draft Home
 * counted was missing from it, and a draft that came from `generate.js` decoded
 * blank because `toObject(Draft)` binds camelCase only. These pin the decode,
 * the Drafts-bucket filter, the row text and the load.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleLogsDraftsTest {

    private val dispatcher = UnconfinedTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(dispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    // ── draftFromFields: both writers' spellings ────────────────────────────

    @Test
    fun `decodes a camelCase n8n-era draft`() {
        val d = draftFromFields(
            "gd1",
            mapOf(
                "status" to "pending",
                "communicationType" to "visit_report",
                "kinfolkId" to "kf1",
                "kinfolkName" to "Robyn",
                "generatedCopy" to "Biscuit had a great walk.",
                "createdOn" to "2026-05-23T22:23:00.000Z",
            ),
        )
        assertEquals("gd1", d.id)
        assertEquals("kf1", d.kinfolkId)
        assertEquals("Robyn", d.kinfolkName)
        assertEquals("Biscuit had a great walk.", d.generatedCopy)
        assertEquals("2026-05-23T22:23:00.000Z", d.createdOn)
        assertFalse(d.isPublished)
    }

    @Test
    fun `decodes a snake_case generate-js draft, which toObject read blank`() {
        val d = draftFromFields(
            "gd2",
            mapOf(
                "status" to "generated",
                "communication_type" to "visit_report",
                "kinfolk_id" to "kf2",
                "kinfolk_name" to "Olivia",
                "generated_copy" to "Mochi napped in the sun.",
                "generated_title" to "A sunny nap",
                "generated_at" to "2026-05-23T22:47:00.000Z",
            ),
        )
        assertEquals("kf2", d.kinfolkId)
        assertEquals("Olivia", d.kinfolkName)
        assertEquals("Mochi napped in the sun.", d.generatedCopy)
        assertEquals("A sunny nap", d.generatedTitle)
        assertEquals("2026-05-23T22:47:00.000Z", d.createdOn)
    }

    @Test
    fun `a blank status reads as pending, and a published draft says so`() {
        assertEquals("pending", draftFromFields("x", emptyMap()).status)
        assertTrue(draftFromFields("x", mapOf("publishedReportId" to "r1")).isPublished)
    }

    // ── the Drafts bucket ───────────────────────────────────────────────────

    @Test
    fun `lists only drafts nobody has sent, newest first`() {
        val drafts = listOf(
            Draft(id = "old", status = "pending", createdOn = "2026-05-01T00:00:00Z"),
            Draft(id = "sent", status = "published", publishedReportId = "r1", createdOn = "2026-05-30T00:00:00Z"),
            Draft(id = "approved", status = "approved", createdOn = "2026-05-29T00:00:00Z"),
            Draft(id = "new", status = "generated", createdOn = "2026-05-23T00:00:00Z"),
        )
        assertEquals(listOf("new", "old"), unsentGeneratedDrafts(drafts).map { it.id })
    }

    @Test
    fun `the row names the type and the date`() {
        val d = Draft(id = "a", communicationType = "visit_report", createdOn = "2026-05-23T22:23:00.000Z")
        assertEquals("visit report · May 23 · 22:23", draftSubmeta(d))
        assertEquals("visit report · Date TBD", draftSubmeta(d.copy(createdOn = "")))
    }

    @Test
    fun `search covers household, type and copy`() {
        val d = Draft(id = "a", kinfolkName = "Robyn", communicationType = "visit_report", generatedCopy = "Biscuit ran")
        assertTrue(matchesDraftSearch(d, "robyn"))
        assertTrue(matchesDraftSearch(d, "visit report"))
        assertTrue(matchesDraftSearch(d, "biscuit"))
        assertFalse(matchesDraftSearch(d, "olivia"))
        assertTrue(matchesDraftSearch(d, "  "))
    }

    // ── the load ────────────────────────────────────────────────────────────

    @Test
    fun `loadGeneratedDrafts fills the Drafts bucket with the unsent drafts`() = runTest(dispatcher) {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getGeneratedDrafts(any()) } returns Result.success(
            listOf(
                Draft(id = "gd1", status = "pending", createdOn = "2026-05-23T00:00:00Z"),
                Draft(id = "gd2", status = "approved", createdOn = "2026-05-24T00:00:00Z"),
            ),
        )
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true), kinCareRepository = mockk<KinCareRepository>())
        vm.loadGeneratedDrafts()
        advanceUntilIdle()
        assertEquals(listOf("gd1"), vm.generatedDrafts.value.map { it.id })
        assertNull(vm.generatedDraftsError.value)
    }

    @Test
    fun `a failed drafts read is reported, never shown as no drafts`() = runTest(dispatcher) {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getGeneratedDrafts(any()) } returns Result.failure(RuntimeException("permission-denied"))
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true), kinCareRepository = mockk<KinCareRepository>())
        vm.loadGeneratedDrafts()
        advanceUntilIdle()
        assertEquals("permission-denied", vm.generatedDraftsError.value)
    }

    // ── Home's button ───────────────────────────────────────────────────────

    @Test
    fun `Home's Review and send opens the newest draft, or nothing when there is none`() {
        assertEquals("gd1", reviewTarget(listOf(Draft(id = "gd1"), Draft(id = "gd2"))))
        assertNull(reviewTarget(emptyList()))
    }
}
