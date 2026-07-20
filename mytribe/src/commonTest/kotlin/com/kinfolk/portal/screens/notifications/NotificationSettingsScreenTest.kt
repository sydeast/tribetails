@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.notifications

import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.notifications.NotificationCatalogRepository
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

class NotificationSettingsScreenTest {

    @Test
    fun load_rendersAllSixCategories() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        // Titles are the shipped KINFOLK_CATEGORIES titles. The schedule category
        // shows its relabeled "Schedule Reminders" title because the relabel flag
        // defaults on (D12).
        onNodeWithText("Visit Updates").assertExists()
        onNodeWithText("KinTales").assertExists()
        onNodeWithText("Invoices & Payments").assertExists()
        onNodeWithText("Schedule Reminders").assertExists()
        onNodeWithText("Home & Pets").assertExists()
        onNodeWithText("Newsletters & Community").assertExists()
        onNodeWithText("Save Notification Preferences").assertExists()
    }

    @Test
    fun loaded_showsAllChannelLabels() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        // Each per-channel category renders an Email/SMS/Push row. Marketing is an
        // opt-in category with no per-channel toggles, so the count is one per
        // non-marketing category.
        val emailNodes = onAllNodesWithText("Email").fetchSemanticsNodes().size
        assertTrue(emailNodes >= 5, "expected at least 5 Email labels (one per per-channel category), got $emailNodes")
    }

    @Test
    fun error_rendersErrorMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyNotificationPrefs", IllegalStateException("prefs unavailable"))
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("prefs unavailable").assertExists()
    }

    // D12: the "schedule" category is always relabeled to "Schedule Reminders".
    // Same id/key/prefs.
    @Test
    fun scheduleReminders_showsRelabeledTitle() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        setThemedContent {
            NotificationSettingsScreen("The Foster", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Schedule Reminders").assertExists()
        onNodeWithText(
            "Reminders before upcoming and pending visits on your calendar.",
        ).assertExists()
        onNodeWithText("Upcoming Care").assertDoesNotExist()
    }

    // Run-4 #13: when the business operator LOCKS a delivery channel on, the
    // kinfolk must see it as required-on AND read it as a clear reason, not just
    // an icon. The catalog (getNotificationCatalog) reports the lock via
    // lockedChannels; the screen surfaces it as a "Required by Tribe Tails" line
    // and the chip stays read-only (the dispatcher enforces the lock server-side).
    @Test
    fun lockedChannel_showsRequiredByTribeTailsReason() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        // Business-gated catalog: one Visit key with SMS locked on by the business.
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 1)
            put("categories", buildJsonArray {
                add(buildJsonObject {
                    put("id", "visit")
                    put("title", "Visit Updates")
                    put("description", "Real-time status")
                    put("keys", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "kincare.auntie.on_my_way")
                            put("title", "Auntie On Her Way")
                            put("description", "When your Auntie is en route.")
                            put("allowedChannels", buildJsonArray { add("email"); add("sms"); add("push") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { add("sms") })
                            put("marketingCategory", JsonNull)
                        })
                    })
                })
            })
        })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        // Per-key channel chips (and the lock reason) live in the expanded section.
        onNodeWithText("Visit Updates").performClick()
        waitForIdle()
        onNodeWithText("Required by Tribe Tails (can't be changed here): SMS").assertExists()
    }

    // Notification revamp: when the operator authored a lockReason, the kinfolk
    // reads that reason instead of the generic "Required by Tribe Tails" line.
    @Test
    fun lockReason_showsOperatorReasonInsteadOfDefaultLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 2)
            put("categories", buildJsonArray {
                add(buildJsonObject {
                    put("id", "visit")
                    put("title", "Visit Updates")
                    put("description", "Real-time status")
                    put("keys", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "kincare.auntie.on_my_way")
                            put("title", "Auntie On Her Way")
                            put("description", "When your Auntie is en route.")
                            put("allowedChannels", buildJsonArray { add("email"); add("sms"); add("push") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { add("sms") })
                            put("lockReason", "We text when your Auntie is en route so nobody misses her arrival.")
                            put("marketingCategory", JsonNull)
                        })
                    })
                })
            })
        })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Visit Updates").performClick()
        waitForIdle()
        onNodeWithText("We text when your Auntie is en route so nobody misses her arrival.").assertExists()
        onNodeWithText("Required by Tribe Tails (can't be changed here): SMS").assertDoesNotExist()
    }

    // Notification revamp: always-on keys (e.g. password reset, receipts) now
    // arrive with every channel locked. A category made only of those keys must
    // read as always-on and must NOT offer the "All in category" select-all
    // chips — they would write byCategory with zero effect on the locked chips.
    @Test
    fun fullyLockedCategory_readsAlwaysOn_withoutSelectAllChips() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {})
            put("updatedAtMs", JsonNull)
        })
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 2)
            put("categories", buildJsonArray {
                add(buildJsonObject {
                    put("id", "account")
                    put("title", "Account & Security")
                    put("description", "Notices that keep your account safe.")
                    put("keys", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "auth.password.reset")
                            put("title", "Password Reset")
                            put("description", "Your reset link.")
                            put("allowedChannels", buildJsonArray { add("email") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { add("email") })
                            put("lockReason", JsonNull)
                            put("marketingCategory", JsonNull)
                        })
                        add(buildJsonObject {
                            put("key", "auth.account.locked")
                            put("title", "Account Locked")
                            put("description", "If sign-in gets locked.")
                            put("allowedChannels", buildJsonArray { add("email"); add("sms") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { add("email"); add("sms") })
                            put("lockReason", JsonNull)
                            put("marketingCategory", JsonNull)
                        })
                    })
                })
            })
        })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        // Collapsed card: the select-all row is replaced by an always-on note.
        onNodeWithText("Always on. Required by Tribe Tails.").assertExists()
        onNodeWithText("All in category:").assertDoesNotExist()
        // Expanded: each fully locked key reads as always-on too.
        onNodeWithText("Account & Security").performClick()
        waitForIdle()
        val alwaysOnKeyLines = onAllNodesWithText(
            "Always on. Required by Tribe Tails (can't be changed here).",
        ).fetchSemanticsNodes().size
        assertTrue(alwaysOnKeyLines == 2, "expected both fully locked keys to read always-on, got $alwaysOnKeyLines")
    }
}
