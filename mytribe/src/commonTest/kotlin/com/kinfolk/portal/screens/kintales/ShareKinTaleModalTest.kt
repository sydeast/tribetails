@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kintales

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Covers the one gap this modal shipped with: revoke (PR23, P2 ruling).
 * `revokeShareLink` is deployed and PortalApi.revokeShareLink already
 * exists — this is its first caller. Create/passcode/expiry submit
 * behavior predates this task and isn't re-covered here.
 */
class ShareKinTaleModalTest {

    private fun stubCreate(fake: FakeFunctionsClient, shareId: String = "share-1") {
        fake.stub(
            "createShareLink",
            buildJsonObject {
                put("shareId", shareId)
                put("shareUrl", "https://kinfolk.tribetails.com/share/$shareId")
            },
        )
    }

    @Test
    fun revoke_confirmThenFire_callsRevokeShareLinkWithTheCreatedShareId_andStopsOfferingTheDeadUrl() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubCreate(fake)
        fake.stub("revokeShareLink", buildJsonObject { put("ok", true) })

        setThemedContent {
            ShareKinTaleModal(
                familyId = "fam1",
                kinTaleId = "t1",
                portalApi = PortalApi(fake),
                onDismiss = {},
            )
        }
        waitForIdle()
        onNodeWithText("Generate Link").performClick()
        waitForIdle()
        onNodeWithText("https://kinfolk.tribetails.com/share/share-1").assertIsDisplayed()

        // Revoke link -> confirm step, no call fired yet
        onNodeWithText("Revoke link").performClick()
        waitForIdle()
        onNodeWithText("Yes, revoke").assertIsDisplayed()
        assertTrue(
            fake.calls.none { it.first == "revokeShareLink" },
            "revokeShareLink must not fire before the confirm step is accepted",
        )

        onNodeWithText("Yes, revoke").performClick()
        waitForIdle()

        val revokeCall = fake.calls.last { it.first == "revokeShareLink" }
        assertEquals("share-1", revokeCall.second?.get("shareId")?.jsonPrimitive?.contentOrNull)
        onNodeWithText("This link no longer works.").assertIsDisplayed()
        onNodeWithText("Copy Link").assertDoesNotExist()
        onNodeWithText("https://kinfolk.tribetails.com/share/share-1").assertDoesNotExist()
    }

    @Test
    fun revoke_serverError_showsMessageAndDoesNotClaimTheLinkIsDead() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubCreate(fake)
        fake.stubError("revokeShareLink", IllegalStateException("share not found"))

        setThemedContent {
            ShareKinTaleModal(
                familyId = "fam1",
                kinTaleId = "t1",
                portalApi = PortalApi(fake),
                onDismiss = {},
            )
        }
        waitForIdle()
        onNodeWithText("Generate Link").performClick()
        waitForIdle()

        onNodeWithText("Revoke link").performClick()
        waitForIdle()
        onNodeWithText("Yes, revoke").performClick()
        waitForIdle()

        onNodeWithText("share not found").assertIsDisplayed()
        onNodeWithText("This link no longer works.").assertDoesNotExist()
        onNodeWithText("Copy Link").assertIsDisplayed()
        onNodeWithText("https://kinfolk.tribetails.com/share/share-1").assertIsDisplayed()
    }
}
