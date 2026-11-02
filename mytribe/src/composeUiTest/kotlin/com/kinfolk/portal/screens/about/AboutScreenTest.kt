@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.about

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.config.BusinessPublicCard
import com.kinfolk.portal.config.PUBLIC_HOURS_DAYS
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1411 (the 2026-11-01 ruling on #1399): "About {business}" shows the name,
 * the week's hours, the public number with Call and Text, the privacy policy
 * and the app version, all from the public card the sign-in screen reads
 * (#1321). Nothing on it is invented: a blank name titles the page "About your
 * Auntie", a blank number or URL leaves that part out, a closed day reads
 * "Closed". Twin of the web portal's About.test.tsx.
 */
class AboutScreenTest {

    private val sunnyPaws = BusinessPublicCard(
        name = "Sunny Paws",
        phone = "+15125550142",
        hours = PUBLIC_HOURS_DAYS.associateWith { "" } + mapOf(
            "Monday" to "09:00-17:00",
            "Tuesday" to "09:00-17:00",
            "Wednesday" to "09:00-17:00",
            "Thursday" to "09:00-17:00",
            "Friday" to "09:00-15:00",
        ),
        privacyPolicyUrl = "https://example.test/privacy",
    )

    @Test
    fun titlesThePageWithTheBusinessName() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws, appVersion = "0.3.2", openUrl = {}) }
        waitForIdle()
        onNodeWithText("About Sunny Paws").assertIsDisplayed()
    }

    @Test
    fun saysAboutYourAuntieWhenNoNameIsSet_andInventsNone() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws.copy(name = ""), appVersion = "0.3.2", openUrl = {}) }
        waitForIdle()
        onNodeWithText("About your Auntie").assertIsDisplayed()
        onAllNodesWithText("Tribe Tails", substring = true).assertCountEquals(0)
    }

    @Test
    fun listsAllSevenDaysMondayFirst_aClosedDayReadingClosed() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws, appVersion = "0.3.2", openUrl = {}) }
        waitForIdle()
        PUBLIC_HOURS_DAYS.forEach { day -> onNodeWithTag("about-hours-$day").assertExists() }
        onNodeWithText("Monday").assertIsDisplayed()
        onAllNodesWithText("9:00 AM to 5:00 PM").assertCountEquals(4)
        onNodeWithText("9:00 AM to 3:00 PM").assertExists()
        onAllNodesWithText("Closed").assertCountEquals(2)
        onNodeWithTag("about-hours-Sunday", useUnmergedTree = true).assertExists()
    }

    @Test
    fun showsTheNumberAsTextWithCallAndText_theWayTribeProfileDoes() = runComposeUiTest {
        val opened = mutableListOf<String>()
        setThemedContent { AboutScreen(card = sunnyPaws, appVersion = "0.3.2", openUrl = { opened += it }) }
        waitForIdle()
        onNodeWithTag("about-phone").performScrollTo().assertTextEquals("(512) 555-0142")
        onNodeWithText("Call").performScrollTo().performClick()
        onNodeWithText("Text").performScrollTo().performClick()
        assertEquals(listOf("tel:+15125550142", "sms:+15125550142"), opened)
    }

    @Test
    fun leavesThePhoneSectionOutWhenNoNumberIsSet() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws.copy(phone = ""), appVersion = "0.3.2", openUrl = {}) }
        waitForIdle()
        onNodeWithText("Phone").assertDoesNotExist()
        onNodeWithText("Call").assertDoesNotExist()
        onNodeWithTag("about-phone").assertDoesNotExist()
    }

    @Test
    fun opensThePrivacyPolicyWhenTheUrlIsSet() = runComposeUiTest {
        val opened = mutableListOf<String>()
        setThemedContent { AboutScreen(card = sunnyPaws, appVersion = "0.3.2", openUrl = { opened += it }) }
        waitForIdle()
        onNodeWithTag("about-privacy").performScrollTo().assertTextEquals("Privacy policy").performClick()
        assertEquals(listOf("https://example.test/privacy"), opened)
    }

    @Test
    fun hasNoPrivacyLinkWhenTheUrlIsBlank() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws.copy(privacyPolicyUrl = ""), appVersion = "0.3.2", openUrl = {}) }
        waitForIdle()
        onNodeWithTag("about-privacy").assertDoesNotExist()
        onNodeWithText("Privacy policy").assertDoesNotExist()
        // The version row still earns the card.
        onNodeWithTag("about-version").performScrollTo().assertTextEquals("0.3.2")
    }

    @Test
    fun printsTheAppVersion_andOmitsTheRowWhenTheBuildCarriesNone() = runComposeUiTest {
        setThemedContent { AboutScreen(card = sunnyPaws.copy(privacyPolicyUrl = ""), appVersion = "", openUrl = {}) }
        waitForIdle()
        onNodeWithTag("about-version").assertDoesNotExist()
        onNodeWithText("Version").assertDoesNotExist()
        onNodeWithText("MyTribe").assertDoesNotExist()
    }
}
