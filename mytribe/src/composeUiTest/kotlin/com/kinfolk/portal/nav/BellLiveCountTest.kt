@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.nav

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.BadgeRow
import com.kinfolk.portal.portal.UnreadBadge
import com.kinfolk.portal.portal.bellCount
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1833: the header bell follows the live count with no reload. The bell is
 * drawn the way the composition root draws it: the store's model, read for the
 * active tribe, over the count the app opened with.
 */
class BellLiveCountTest {

    private fun unread(id: String, tribeId: String = "fam-1") = BadgeRow(id, unread = true, archived = false, tribeId = tribeId)
    private fun read(id: String) = BadgeRow(id, unread = false, archived = false, tribeId = "fam-1")
    private val six = (1..6).map { unread("n$it") }

    private fun ComposeUiTest.bell(badge: UnreadBadge, seeded: Int) = setThemedContent {
        val model by badge.model.collectAsState()
        BellButton(unread = bellCount(model.liveFor("fam-1"), seeded), onClick = {})
    }

    private fun ComposeUiTest.bellName(): String? =
        onNodeWithTag("bell").fetchSemanticsNode().config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString()

    @Test
    fun showsTheCountTheAppOpenedWithUntilTheFirstSnapshot() = runComposeUiTest {
        bell(UnreadBadge(), seeded = 6)
        waitForIdle()
        onNodeWithTag("bellBadge", useUnmergedTree = true).assertExists()
        onNodeWithText("6", useUnmergedTree = true).assertExists()
        assertEquals("Notifications, 6 unread", bellName())
    }

    @Test
    fun goesFromSixToSevenWhenANoticeArrives_withNoReload() = runComposeUiTest {
        val badge = UnreadBadge()
        bell(badge, seeded = 6)
        badge.onRows(six)
        waitForIdle()
        onNodeWithText("6", useUnmergedTree = true).assertExists()

        badge.onRows(listOf(unread("omw")) + six)
        waitForIdle()
        onNodeWithText("7", useUnmergedTree = true).assertExists()
        onNodeWithText("6", useUnmergedTree = true).assertDoesNotExist()
        assertEquals("Notifications, 7 unread", bellName())
    }

    @Test
    fun goesDownAtATap_andAgainWhenOneIsReadOnAnotherDevice() = runComposeUiTest {
        val badge = UnreadBadge()
        bell(badge, seeded = 6)
        badge.onRows(six)
        badge.markReadLocally("n1")
        waitForIdle()
        onNodeWithText("5", useUnmergedTree = true).assertExists()

        badge.onRows(listOf(read("n1"), read("n2")) + six.drop(2))
        waitForIdle()
        onNodeWithText("4", useUnmergedTree = true).assertExists()
    }

    @Test
    fun drawsNoBadgeOnceAllAreMarkedRead() = runComposeUiTest {
        val badge = UnreadBadge()
        bell(badge, seeded = 6)
        badge.onRows(six)
        badge.onRows(six.map { read(it.id) })
        waitForIdle()
        onNodeWithTag("bellBadge", useUnmergedTree = true).assertDoesNotExist()
        assertEquals("Notifications", bellName())
    }

    @Test
    fun doesNotCountAnotherTribesRow_orAnArchivedOne() = runComposeUiTest {
        val badge = UnreadBadge()
        bell(badge, seeded = 0)
        badge.onRows(listOf(unread("mine"), unread("other", "fam-2"), BadgeRow("gone", unread = true, archived = true, tribeId = "fam-1")))
        waitForIdle()
        onNodeWithText("1", useUnmergedTree = true).assertExists()
    }

    @Test
    fun afterAFailedListenerItDrawsNoBadge_neverTheOldNumber() = runComposeUiTest {
        val badge = UnreadBadge()
        bell(badge, seeded = 6)
        badge.onRows(six)
        badge.onFailed()
        waitForIdle()
        onNodeWithTag("bellBadge", useUnmergedTree = true).assertDoesNotExist()
        onNodeWithText("6", useUnmergedTree = true).assertDoesNotExist()
        assertEquals("Notifications", bellName())
    }
}
