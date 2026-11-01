@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.account

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AccountSettingsScreenTest {

    private fun stubAccount(fake: FakeFunctionsClient) {
        fake.stub("getMyAccount", buildJsonObject {
            put("uid", "u1")
            put("email", "n@x.com")
            put("displayName", "Sydney")
            put("phone", JsonNull)
            put("backupEmail", JsonNull)
            put("backupPhone", JsonNull)
            put("kinfolkIds", buildJsonArray {})
            put("hasPaymentMethod", false)
            put("updatedAtMs", JsonNull)
        })
    }

    @Test
    fun load_rendersAllSections() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Account Settings").assertExists()
        // Profile section (own name + photo). The "Secondary Contact" invite card
        // was removed from Account and moved to the Tribe page.
        onNodeWithText("Profile").assertExists()
        onNodeWithText("First & Last Name *").assertExists()
        onNodeWithText("Profile Photo").assertExists()
        // Quick link over to the household/tribe profile.
        onNodeWithText("Manage your family, home & vet → Tribe profile").assertExists()
        onNodeWithText("Recovery Contacts").assertExists()
        onNodeWithText("Billing Details").assertExists()
        onNodeWithText("Sign Out").assertExists()
        onNodeWithText("n@x.com").assertExists()
    }

    /**
     * #1005: a member without billing access (a SECONDARY the PRIMARY did not
     * grant billing) gets no Billing Details card, no refusal line, and the
     * card on file is never asked for.
     */
    @Test
    fun noBillingAccess_hidesBillingDetails_andNeverAsksForTheCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake), billingAccess = false) }
        waitForIdle()
        onNodeWithText("Account Settings").assertExists()
        onNodeWithText("Billing Details").assertDoesNotExist()
        onNodeWithText("No payment method on file").assertDoesNotExist()
        assertFalse(fake.calls.any { it.first == "getMyPaymentMethod" }, "getMyPaymentMethod must not be called")
    }

    /**
     * D-2026-09-28-BILLING-ACCESS-PAYS (#1036): saved cards follow billing
     * access, not the primary role. A member the server says has billing
     * access (a PRIMARY, or a SECONDARY the PRIMARY granted billing) gets the
     * Billing Details card and the card on file is asked for.
     */
    @Test
    fun billingAccess_drawsBillingDetails_andAsksForTheCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake), billingAccess = true) }
        waitForIdle()
        onNodeWithText("Billing Details").assertExists()
        assertTrue(fake.calls.any { it.first == "getMyPaymentMethod" }, "getMyPaymentMethod must be called")
    }

    @Test
    fun noPaymentMethod_showsCorrectCopy() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No payment method on file").assertExists()
    }

    /** #1306: a stored E.164 number is shown the way a person writes it. */
    @Test
    fun storedPhone_isShownFormatted() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyAccount", buildJsonObject {
            put("uid", "u1")
            put("email", "n@x.com")
            put("displayName", "Sydney")
            put("phone", "+15125550142")
            put("backupEmail", JsonNull)
            put("backupPhone", "5125667512")
            put("kinfolkIds", buildJsonArray {})
            put("hasPaymentMethod", false)
            put("updatedAtMs", JsonNull)
        })
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("account-phone").assertTextContains("(512) 555-0142")
        onNodeWithTag("account-backup-phone").assertTextContains("(512) 566-7512")
    }
    /** #1289: a bad number is caught on the field, in plain words, before Save. */
    @Test
    fun badPhone_isCaughtOnTheField_andSaveIsNotOffered() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().assertIsEnabled()
        onNodeWithTag("account-phone").performTextInput("abc123")
        waitForIdle()
        onNodeWithText("Enter a 10-digit phone number.").assertExists()
        onNodeWithText("Save Changes").performScrollTo().assertIsNotEnabled()
        assertFalse(fake.calls.any { it.first == "saveMyAccount" }, "a bad number must never reach the server")
    }

    @Test
    fun signOut_asksForConfirmationFirst() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        var signedOut = false
        setThemedContent {
            AccountSettingsScreen("The Foster", PortalApi(fake), onSignOut = { signedOut = true })
        }
        waitForIdle()
        // Tapping the button opens the confirm dialog; nothing fires yet.
        // (The button sits at the bottom of a tall scrollable settings form.)
        onNodeWithText("Sign Out").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Sign out of MyTribe?").assertExists()
        assertFalse(signedOut, "Sign out must wait for confirmation")
        // Cancel closes the dialog without signing out.
        onNodeWithText("Cancel").performClick()
        waitForIdle()
        onNodeWithText("Sign out of MyTribe?").assertDoesNotExist()
        assertFalse(signedOut)
        // Confirming actually signs out. With the dialog open there are two
        // "Sign Out" nodes (page button + dialog confirm); the dialog's root
        // is last in traversal order.
        onNodeWithText("Sign Out").performClick()
        waitForIdle()
        val signOutNodes = onAllNodesWithText("Sign Out")
        signOutNodes[signOutNodes.fetchSemanticsNodes().size - 1].performClick()
        waitForIdle()
        assertTrue(signedOut, "Confirming the dialog fires onSignOut")
    }

    @Test
    fun error_rendersErrorMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyAccount", IllegalStateException("auth lookup failed"))
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("auth lookup failed").assertExists()
    }

    /** Mirrors the account schema seeded in scripts/seedDemoKinfolk.ts. */
    private fun stubAccountSchema(fake: FakeFunctionsClient) {
        fake.stub("getFormSchema", buildJsonObject {
            put("id", "account")
            put("name", "Account Settings")
            put("version", 1)
            put("sections", buildJsonArray {
                add(buildJsonObject {
                    put("title", "Profile")
                    put("fields", buildJsonArray {
                        add(buildJsonObject { put("key", "displayName"); put("label", "Display Name"); put("type", "text"); put("required", true) })
                        add(buildJsonObject { put("key", "phone"); put("label", "Phone"); put("type", "phone"); put("required", false) })
                    })
                })
                add(buildJsonObject {
                    put("title", "Recovery")
                    put("fields", buildJsonArray {
                        add(buildJsonObject { put("key", "backupEmail"); put("label", "Backup Email"); put("type", "email"); put("required", false) })
                        add(buildJsonObject { put("key", "backupPhone"); put("label", "Backup Phone"); put("type", "phone"); put("required", false) })
                    })
                })
            })
        })
    }

    @Test
    fun schemaPresent_rendersSchemaDrivenSections() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubAccount(fake)
        stubAccountSchema(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        // Schema renders section titles + a required-marked field label.
        onNodeWithText("Display Name *").assertExists()
        onNodeWithText("Backup Email").assertExists()
        // Typed-save tail (Billing + Sign Out) still renders below the schema form.
        onNodeWithText("Billing Details").assertExists()
        onNodeWithText("Sign Out").assertExists()
    }
}
