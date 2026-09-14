@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import com.kinfolk.portal.screens.tribe.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.kinfolk.portal.screens.tribe.EmergencyContactsCard
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #829, operator ruling 2026-09-13: the Emergency Contact explanation opens on a
 * TAP of the info icon, as admin Android's DenInfoTip does. The clock is driven by
 * hand (as in KinLoadingTest) so the tooltip's show animation is stepped
 * explicitly rather than raced by an auto-advancing clock.
 */
class KinInfoTipTest {

    @Test
    fun tappingTheIconShowsTheSentence() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent { KinInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED) }
        mainClock.advanceTimeBy(16L)
        assertTrue(onAllNodesWithText(EMERGENCY_CONTACT_WHO_GETS_CALLED).fetchSemanticsNodes().isEmpty())
        onNodeWithTag(KIN_INFO_TIP_TAG).performClick()
        mainClock.advanceTimeBy(300L)
        onNodeWithText(EMERGENCY_CONTACT_WHO_GETS_CALLED).assertIsDisplayed()
    }

    @Test
    fun theSentenceIsTheSameOneTheAdminClientsShow() {
        // auntieos-admin/src/components/EmergencyContactsEditor.tsx WHO_GETS_CALLED.
        assertEquals("Called only when no kinfolk can be reached. The first one is called first.", EMERGENCY_CONTACT_WHO_GETS_CALLED)
    }

    @Test
    fun theEmergencyContactsCardTitleCarriesTheTip() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray {}); put("canEdit", false); put("legacy", false)
        })
        setThemedContent { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag(KIN_INFO_TIP_TAG).assertIsDisplayed()
    }
}
