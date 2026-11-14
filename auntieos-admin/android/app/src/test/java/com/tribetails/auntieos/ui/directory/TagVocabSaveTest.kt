package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.TagChange
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagListsAfterChange
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.paletteColor
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2204 / #2205: "add to your tags" on a profile sends the ONE name.
 *
 * It used to re-read the settings and write the panel's whole list back. A
 * panel whose list had not loaded (or had failed to load) sent a list of one
 * and wiped every other tag; a panel left open put back a tag deleted
 * elsewhere and dropped one added elsewhere. Now the name goes to
 * `changeBusinessTags`, which adds it to the list as stored.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TagVocabSaveTest {

    private val vip = TagDef(name = "VIP", color = TagColor(token = "accent", css = "var(--color-accent)"), icon = "*")
    private val slowPay = TagDef(name = "Slow pay", color = TagColor(token = "warn", css = "var(--color-warn)"), icon = "")
    private val winter = TagDef(name = "Winter", color = paletteColor("teal"), icon = "")

    @Test
    fun `adding a household tag sends one add for that name, never a list`() = runTest {
        val repo = mockk<AuntieRepository>()
        val sent = slot<List<TagChange>>()
        coEvery { repo.changeBusinessTags(capture(sent)) } returns
            Result.success(TagListsAfterChange(listOf(vip, winter), listOf(slowPay)))

        val stored = addTagToVocab(repo, TagScope.HOUSEHOLD, "Winter")

        assertEquals(listOf(TagChange(TagChange.ADD, TagScope.HOUSEHOLD, "Winter", paletteColor("teal"), "")), sent.captured)
        assertEquals(listOf(vip, winter), stored)
        coVerify(exactly = 0) { repo.updateBusinessSettingsFields(any(), any()) }
        coVerify(exactly = 0) { repo.getBusinessSettings() }
    }

    /**
     * #2204: the panel's list never had to load for this to be safe. Even if it
     * shows nothing, only the name travels and the server keeps every stored tag.
     */
    @Test
    fun `an add made on a panel that never loaded cannot replace the list`() = runTest {
        val repo = mockk<AuntieRepository>()
        val sent = slot<List<TagChange>>()
        coEvery { repo.changeBusinessTags(capture(sent)) } returns
            Result.success(TagListsAfterChange(emptyList(), listOf(slowPay, vip, winter)))

        val stored = addTagToVocab(repo, TagScope.PET, "Winter")

        assertEquals(1, sent.captured.size)
        assertEquals(TagScope.PET, sent.captured.single().scope)
        assertEquals(listOf(slowPay, vip, winter), stored)
    }

    @Test
    fun `the answer is that scope's list as stored, tags added elsewhere included`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.changeBusinessTags(any()) } returns
            Result.success(TagListsAfterChange(listOf(vip, slowPay, winter), emptyList()))
        assertEquals(listOf("VIP", "Slow pay", "Winter"), addTagToVocab(repo, TagScope.HOUSEHOLD, "Winter").map { it.name })
    }

    /**
     * Fail-loud is the existing contract: `ProfileTagsSection` turns the throw
     * into a reverted list plus a banner. The message is asserted, not just the
     * type, so this cannot pass on an incidental mock or framework exception.
     */
    @Test
    fun `a refused add throws the server's reason`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.changeBusinessTags(any()) } returns
            Result.failure(RuntimeException("A \"VIP\" tag already exists."))

        val thrown = runCatching { addTagToVocab(repo, TagScope.HOUSEHOLD, "vip") }.exceptionOrNull()
        assertEquals("A \"VIP\" tag already exists.", thrown?.message)
    }

    @Test
    fun `only the owner may add to the tag list, and an unknown answer is a no`() = runTest {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.isCurrentUserOwner() } returns Result.success(true)
        assertTrue(canAddToTagVocab(repo))
        coEvery { repo.isCurrentUserOwner() } returns Result.success(false)
        assertFalse(canAddToTagVocab(repo))
        coEvery { repo.isCurrentUserOwner() } returns Result.failure(IllegalStateException("no token"))
        assertFalse(canAddToTagVocab(repo))
    }
}
