package com.tribetails.auntieos.web.ui.components
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.PersonAccess
import com.tribetails.auntieos.web.data.SecondaryPerson
import com.tribetails.auntieos.web.data.SecondaryPersonDraft
import com.tribetails.auntieos.web.screens.directory.SecondaryKinfolkContent
import com.tribetails.auntieos.web.screens.directory.SecondaryKinfolkDialog
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * The desktop "Secondary kinfolk" panel (operator rulings 2026-09-27, Q3 and
 * Q4): people listed with their access state, Add, Edit and Remove, and no
 * invite control, because only the primary can invite a secondary kinfolk.
 */
@OptIn(ExperimentalTestApi::class)
class SecondaryKinfolkRenderTest {
    private val people = listOf(
        SecondaryPerson("p1", "Sam Lee", "+18055550177", null, PersonAccess.NONE, null),
        SecondaryPerson("p2", "Jo Park", null, "jo@example.com", PersonAccess.INVITED, null),
        SecondaryPerson("p3", "Ann Doe", null, null, PersonAccess.ACTIVE, "u9"),
    )
    @Test
    fun listsEveryPersonWithTheirAccessStateAndNoInviteControl() = runDesktopComposeUiTest {
        var added = 0
        var edited: SecondaryPerson? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                SecondaryKinfolkContent(people, null, {}, { added++ }, { edited = it }, {})
            }
        }
        onNodeWithText("Sam Lee").assertIsDisplayed()
        onNodeWithText("No portal access").assertIsDisplayed()
        onNodeWithText("Invited").assertIsDisplayed()
        // No members screen on desktop, so an ACTIVE person shows here too.
        onNodeWithText("Portal access").assertIsDisplayed()
        assertEquals(3, onAllNodesWithText("Edit").fetchSemanticsNodes().size)
        assertEquals(3, onAllNodesWithText("Remove").fetchSemanticsNodes().size)
        for (text in listOf("Invite", "Give portal access", "Send invite")) {
            assertTrue(onAllNodesWithText(text).fetchSemanticsNodes().isEmpty(), text)
        }
        onNodeWithText("Add secondary kinfolk").performClick()
        assertEquals(1, added)
        onAllNodesWithText("Edit")[1].performClick()
        assertEquals("p2", edited?.personId)
    }
    @Test
    fun aFailedReadIsNamedNeverAnEmptyHousehold() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                SecondaryKinfolkContent(null, "listSecondaryKinfolk failed: permission-denied", {}, {}, {}, {})
            }
        }
        onNodeWithText("listSecondaryKinfolk failed: permission-denied").assertIsDisplayed()
        assertTrue(onAllNodesWithText("No secondary kinfolk on this household yet.").fetchSemanticsNodes().isEmpty())
    }
    @Test
    fun theDialogSaysNoInviteIsSentAndShowsTheServerRefusal() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                SecondaryKinfolkDialog(
                    draft = SecondaryPersonDraft(name = "Rae Park"),
                    saving = false,
                    error = "That is the household's Emergency Contact. An Emergency Contact is someone outside the household.",
                    onChange = {}, onSave = {}, onCancel = {},
                )
            }
        }
        onNodeWithText("Add secondary kinfolk").assertIsDisplayed()
        onNodeWithText("No invite is sent. Only their primary can give them portal access.").assertIsDisplayed()
        onNodeWithText("That is the household's Emergency Contact. An Emergency Contact is someone outside the household.").assertIsDisplayed()
    }
}
