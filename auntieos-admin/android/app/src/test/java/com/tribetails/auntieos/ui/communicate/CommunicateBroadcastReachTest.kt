package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import com.tribetails.auntieos.domain.broadcastSummaryLine
import com.tribetails.auntieos.domain.channelLabel
import com.tribetails.auntieos.domain.decodeRecentSends
import com.tribetails.auntieos.domain.engagementSummary
import com.tribetails.auntieos.domain.SendCounts
import io.mockk.coEvery
import io.mockk.coVerify
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
 * #1610 on Android: the broadcast confirm with a pre-send count, the By status
 * picker, merge fields refused before Review, one subject on a generated
 * email, and Recent listing broadcasts and Inbox replies.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateBroadcastReachTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    private fun ready(body: String = "Hi {{firstName}},"): CommunicateViewModel {
        val vm = CommunicateViewModel(repo = repo)
        vm.setBcChannels(setOf(BroadcastChannel.Email))
        vm.setBcSubject("Holiday hours")
        vm.setBcBody(body)
        return vm
    }

    private val preview = BroadcastAudiencePreview(targeted = 12, withEmail = 10, withPhone = 11, withApp = 4, withoutFirstName = 2)

    @Test fun `Review opens a confirm with the count, and sends nothing yet`() = runTest(testDispatcher) {
        coEvery { repo.previewBroadcastAudience(any(), any()) } returns Result.success(preview)
        val vm = ready()
        vm.requestBroadcast()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertTrue(s.bcConfirmOpen)
        assertEquals(BroadcastReachState.Ready(preview), s.bcReach)
        assertTrue(reachLine(preview).startsWith("12 kinfolk match this audience"))
        assertTrue(reachLine(preview).contains("2 have no first name on file and will read \"Kinfolk\""))
        coVerify(exactly = 0) { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) }
    }

    @Test fun `a count that fails to load says so and keeps the confirm open`() = runTest(testDispatcher) {
        coEvery { repo.previewBroadcastAudience(any(), any()) } returns Result.failure(RuntimeException("unavailable"))
        val vm = ready()
        vm.requestBroadcast()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.bcConfirmOpen)
        assertEquals(BroadcastReachState.Failed("unavailable"), vm.uiState.value.bcReach)
    }

    @Test fun `a merge field a broadcast cannot fill is refused before Review`() = runTest(testDispatcher) {
        val vm = ready(body = "Hi {{firstname}}, {{kinName}} says hi")
        vm.requestBroadcast()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.bcConfirmOpen)
        assertTrue(vm.uiState.value.broadcastError!!.contains("Remove or fix: firstname, kinName."))
        coVerify(exactly = 0) { repo.previewBroadcastAudience(any(), any()) }
    }

    @Test fun `Send now from the confirm closes it and sends`() = runTest(testDispatcher) {
        coEvery { repo.previewBroadcastAudience(any(), any()) } returns Result.success(preview)
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult("b1", 12, emptyMap()))
        val vm = ready()
        vm.requestBroadcast()
        advanceUntilIdle()
        vm.sendBroadcast()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.bcConfirmOpen)
        coVerify(exactly = 1) { repo.broadcastMessage(any(), any(), any(), any(), "Hi {{firstName}},", any()) }
    }

    @Test fun `the server's refusal reads as a sentence`() {
        assertEquals(
            "The message has merge fields a broadcast cannot fill (firstname). Nothing was sent.",
            broadcastErrorText("INVALID_ARGUMENT: unsupported_merge_fields: firstname"),
        )
    }

    @Test fun `By status is picked from the Directory list, in its order`() {
        assertEquals(listOf("active", "prospect", "inactive"), BROADCAST_STATUS_OPTIONS)
        var t = toggleBroadcastStatus("", "inactive", true)
        t = toggleBroadcastStatus(t, "active", true)
        assertEquals("active, inactive", t)
        assertEquals("inactive", toggleBroadcastStatus(t, "active", false))
    }

    @Test fun `merge field rules mirror the server`() {
        assertEquals(emptyList<String>(), unsupportedMergeFields("Hi {{firstName}} {{ lastName }} {{kinfolkName}} {{business}}"))
        assertEquals(listOf("firstname", "kinName", "{{#if paid}}", "{{/if}}"), unsupportedMergeFields("Hi {{firstname}}", "{{kinName}} {{#if paid}}x{{/if}}"))
        assertEquals(listOf("}}"), unsupportedMergeFields("oops }} here"))
        assertNull(mergeFieldBlocker("Hi", "Hi {{firstName}}"))
        assertEquals("Kinfolk", KINFOLK_NAME_STAND_IN)
    }

    @Test fun `a generated Subject line leaves the body`() {
        assertEquals(SubjectSplit("Big day", "Hi Dana"), splitSubjectLine("Subject: Big day\n\nHi Dana"))
        assertEquals(SubjectSplit("Big day", "Hi"), splitSubjectLine("**Subject:** Big day\nHi"))
        assertEquals(SubjectSplit("", "Hi, the subject: today"), splitSubjectLine("Hi, the subject: today"))
    }

    @Test fun `Recent decodes broadcasts and Inbox replies`() {
        val sends = decodeRecentSends(
            mapOf(
                "sends" to listOf(
                    mapOf("id" to "broadcast_b1", "kind" to "broadcast", "channel" to "broadcast", "recipientRedacted" to "All active kinfolk",
                        "subject" to "Holiday hours", "sentAtMs" to 300L, "recipientCount" to 12, "channels" to listOf("email", "sms")),
                    mapOf("id" to "reply_kf1", "kind" to "reply", "channel" to "message", "recipientRedacted" to "Dre East",
                        "sentAtMs" to 200L, "preview" to "See you Tuesday"),
                ),
            ),
        )
        assertEquals("12 kinfolk · Email, Text", broadcastSummaryLine(sends[0]))
        assertEquals("Broadcast", channelLabel(sends[0].channel))
        assertEquals("Inbox reply", channelLabel(sends[1].channel))
        assertEquals("See you Tuesday", sends[1].preview)
        assertEquals("Sent", engagementSummary("message", SendCounts(0, 0, 0, 0, 0)))
    }

    @Test fun `the reach reply decodes, and a reply with no count is refused`() {
        assertEquals(
            preview,
            decodeBroadcastAudiencePreview(mapOf("targeted" to 12, "withEmail" to 10, "withPhone" to 11, "withApp" to 4, "withoutFirstName" to 2)),
        )
        assertNull(decodeBroadcastAudiencePreview(mapOf("ok" to true)))
    }
}
