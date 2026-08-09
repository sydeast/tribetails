package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.encodeTagDefs
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The inline tag promotion on a profile writes ONE vocabulary key.
 *
 * This save re-reads the settings doc before writing, which made the stale
 * window small - but not zero, and it still sent all ~46 fields of the union.
 * With the diff it sends the one vocabulary the operator actually grew, so the
 * OTHER vocabulary, the calendar id and the payment handles are untouched no
 * matter what landed between the read and the write.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TagVocabSaveTest {

    private val vip = TagDef(
        name = "VIP",
        color = TagColor(token = "accent", css = "var(--color-accent)"),
        icon = "*",
    )
    private val slowPay = TagDef(
        name = "Slow pay",
        color = TagColor(token = "warn", css = "var(--color-warn)"),
        icon = "",
    )

    private val stored = BusinessSettings(
        calendarSyncId = "old@group.calendar.google.com",
        venmoHandle = "@old-venmo",
        householdTags = encodeTagDefs(listOf(vip)),
        petTags = encodeTagDefs(listOf(slowPay)),
    )

    @Test
    fun `promoting a household tag writes only the household vocabulary`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)

        val grown = listOf(vip, TagDef(name = "Winter", color = TagColor("info", "var(--color-info)"), icon = ""))
        saveTagVocab(repo, TagScope.HOUSEHOLD, grown)

        assertEquals(setOf("householdTags"), changes.captured.keys)
        assertEquals(encodeTagDefs(grown), changes.captured["householdTags"])
        assertFalse(
            "the pet vocabulary belongs to the other panel: ${changes.captured}",
            changes.captured.containsKey("petTags"),
        )
    }

    /**
     * The concurrent case: a payment handle changed on the React admin between
     * this screen's last read and this write. A vocabulary save must not carry it.
     */
    @Test
    fun `promoting a tag does not revert a payment handle edited on the web`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)

        saveTagVocab(repo, TagScope.PET, listOf(slowPay, vip))

        assertEquals(setOf("petTags"), changes.captured.keys)
    }

    /**
     * Fail-loud is the existing contract: `ProfileTagsSection` turns the throw
     * into a reverted chip plus a banner. The message is asserted, not just the
     * type, so this cannot pass on an incidental mock or framework exception.
     */
    @Test
    fun `a rejected vocabulary write still throws the server's reason`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns
            Result.failure(RuntimeException("permission denied"))

        val thrown = runCatching { saveTagVocab(repo, TagScope.HOUSEHOLD, listOf(vip, slowPay)) }
            .exceptionOrNull()
        assertEquals("permission denied", thrown?.message)
    }

    /** Re-saving the same vocabulary changes nothing, so nothing is written. */
    @Test
    fun `saving an unchanged vocabulary writes nothing`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)

        // No stub for updateBusinessSettingsFields: a call would fail the test as
        // an unmocked invocation, which is exactly the assertion.
        saveTagVocab(repo, TagScope.HOUSEHOLD, listOf(vip))
    }
}
