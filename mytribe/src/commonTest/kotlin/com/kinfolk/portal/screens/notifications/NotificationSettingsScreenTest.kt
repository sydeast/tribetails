@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.notifications

import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.notifications.NotificationCatalogRepository
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
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

    // I3: a failed load used to leave the editor and the Save button live with
    // all three maps EMPTY. Saving from there does not mean "no change" — the
    // Firestore SDK puts an explicitly sent empty map into the update mask, so
    // one click wiped the kinfolk's whole preference document. The save path
    // has to be unreachable until the prefs actually arrived. Web is safe by
    // construction: prefs.isError short-circuits to <LaunchError>.
    @Test
    fun failedLoad_leavesNoWayToSaveOverTheStoredPreferences() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyNotificationPrefs", IllegalStateException("prefs unavailable"))
        fake.stub("saveMyNotificationPrefs", buildJsonObject { put("ok", true) })
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText("prefs unavailable").assertExists()
        onNodeWithText("Save Notification Preferences").assertDoesNotExist()
        // The editor itself is gone too, so there is nothing to edit into the
        // empty state either.
        onNodeWithText("Marketing Opt-Ins").assertDoesNotExist()
        onNodeWithText("Visit Updates").assertDoesNotExist()
        assertTrue(
            fake.calls.none { it.first == "saveMyNotificationPrefs" },
            "a failed load must never reach the save callable",
        )
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
    // kinfolk must see it pinned on AND read a clear reason, not just an icon.
    // The catalog (getNotificationCatalog) reports the lock via lockedChannels;
    // the screen surfaces it as a "Set by Tribe Tails Pet Care" line and the chip
    // stays read-only (the dispatcher enforces the lock server-side).
    //
    // #451: the line names who decides. It does not say "always on", which the
    // operator can falsify at any time by switching the row off in the gate.
    @Test
    fun lockedChannel_showsSetByTribeTailsReason() = runComposeUiTest {
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
        onNodeWithText("Set by Tribe Tails Pet Care, can't be changed here: SMS").assertExists()
    }

    // Notification revamp: when the operator authored a lockReason, the kinfolk
    // reads that reason instead of the stock "Set by Tribe Tails Pet Care" line.
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
        onNodeWithText("Set by Tribe Tails Pet Care, can't be changed here: SMS").assertDoesNotExist()
    }

    // Notification revamp: always-on keys (e.g. password reset, receipts) now
    // arrive with every channel locked. A category made only of those keys must
    // say so and must NOT offer the "All in category" select-all chips — they
    // would write byCategory with zero effect on the locked chips.
    //
    // #451: what it says is "Set by Tribe Tails Pet Care. Can't be changed
    // here." and never "Always on". The catalog's alwaysEnabled flag is
    // advisory (ruling #7, warn-but-allow-off), so the operator can switch any
    // of these rows off; a household told "Always on" about a row that is off
    // has been told something false. This test pins both halves: the honest
    // sentence is present, and the old promise is gone.
    @Test
    fun fullyLockedCategory_saysWhoDecides_withoutSelectAllChips() = runComposeUiTest {
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
        // Collapsed card: the select-all row is replaced by the honest note.
        onNodeWithText("Set by Tribe Tails Pet Care. Can't be changed here.").assertExists()
        onNodeWithText("All in category:").assertDoesNotExist()
        onNodeWithText("Always on. Required by Tribe Tails.").assertDoesNotExist()
        // Expanded: each fully locked key carries the same sentence (3 in all:
        // the category note plus one per key), and none of them says "always".
        onNodeWithText("Account & Security").performClick()
        waitForIdle()
        val honestLines = onAllNodesWithText(
            "Set by Tribe Tails Pet Care. Can't be changed here.",
        ).fetchSemanticsNodes().size
        assertTrue(honestLines == 3, "expected the category note plus both key lines, got $honestLines")
        val oldPromise = onAllNodesWithText(
            "Always on. Required by Tribe Tails (can't be changed here).",
        ).fetchSemanticsNodes().size
        assertTrue(oldPromise == 0, "the always-on promise came back on $oldPromise key lines")
    }

    // ---- task 27a: override revert + category-control semantics ----
    //
    // One "visit" category, two keys: kincare.auntie.on_my_way (push/email/
    // sms, all toggleable) and kincare.checkin.push_only (push only, exists
    // purely so a save can prove it was left untouched). Category defaults:
    // push on, email on, sms off — matching web's NotificationSettings.test.tsx
    // BASE_PREFS fixture so both clients pin the same scenario.

    private fun stubVisitPrefs(fake: FakeFunctionsClient) {
        fake.stub("getMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {
                put("byCategory", buildJsonObject {
                    put("visit", buildJsonObject {
                        put("push", true)
                        put("email", true)
                        put("sms", false)
                    })
                })
            })
            put("updatedAtMs", JsonNull)
        })
    }

    private fun stubVisitCatalog(fake: FakeFunctionsClient) {
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 2)
            put("categories", buildJsonArray {
                add(buildJsonObject {
                    put("id", "visit")
                    put("title", "Visit Updates")
                    put("description", "Check ins and visit notices.")
                    put("keys", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "kincare.auntie.on_my_way")
                            put("title", "Auntie On The Way")
                            put("description", "When your Auntie is en route.")
                            put("allowedChannels", buildJsonArray { add("push"); add("email"); add("sms") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { })
                            put("marketingCategory", JsonNull)
                        })
                        add(buildJsonObject {
                            put("key", "kincare.checkin.push_only")
                            put("title", "Live Check-In")
                            put("description", "A live ping the moment your Auntie checks in.")
                            put("allowedChannels", buildJsonArray { add("push") })
                            put("required", buildJsonArray { })
                            put("lockedChannels", buildJsonArray { })
                            put("marketingCategory", JsonNull)
                        })
                    })
                })
            })
        })
    }

    private fun savedByKey(fake: FakeFunctionsClient) =
        fake.calls.last { it.first == "saveMyNotificationPrefs" }
            .second?.get("prefs")?.jsonObject?.get("byKey")?.jsonObject

    @Test
    fun perKeyOverride_toggledBackToInheritedValue_clearsTheOverrideEntirely() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisitPrefs(fake)
        stubVisitCatalog(fake)
        fake.stub("saveMyNotificationPrefs", buildJsonObject { put("ok", true) })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Visit Updates").performClick() // expand to reach per-key chips
        waitForIdle()

        // sms inherits false from the category default.
        onNodeWithTag("perkey-chip-kincare.auntie.on_my_way-sms").performClick() // override: true
        waitForIdle()
        onNodeWithTag("perkey-chip-kincare.auntie.on_my_way-sms").performClick() // undo: back to false
        waitForIdle()

        onNodeWithText("Save Notification Preferences").performClick()
        waitForIdle()

        assertNull(
            savedByKey(fake)?.get("kincare.auntie.on_my_way"),
            "reverting to the inherited value must clear the override, not pin an explicit duplicate of it",
        )
    }

    @Test
    fun perKeyOverride_toDifferentValue_stillWritesAnExplicitOverride() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisitPrefs(fake)
        stubVisitCatalog(fake)
        fake.stub("saveMyNotificationPrefs", buildJsonObject { put("ok", true) })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Visit Updates").performClick()
        waitForIdle()

        onNodeWithTag("perkey-chip-kincare.auntie.on_my_way-sms").performClick() // false -> true, diverges from category
        waitForIdle()

        onNodeWithText("Save Notification Preferences").performClick()
        waitForIdle()

        val override = savedByKey(fake)?.get("kincare.auntie.on_my_way")?.jsonObject
        assertEquals(true, override?.get("sms")?.jsonPrimitive?.booleanOrNull)
    }

    @Test
    fun save_omitsByKeyEntriesForKeysNeverTouched() = runComposeUiTest {
        // PR27's review noted this is code-correct but untested: only the key
        // a kinfolk actually clicked should ever appear in the saved byKey map.
        val fake = FakeFunctionsClient()
        stubVisitPrefs(fake)
        stubVisitCatalog(fake)
        fake.stub("saveMyNotificationPrefs", buildJsonObject { put("ok", true) })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Visit Updates").performClick()
        waitForIdle()

        onNodeWithTag("perkey-chip-kincare.auntie.on_my_way-push").performClick() // touch exactly one key/channel

        onNodeWithText("Save Notification Preferences").performClick()
        waitForIdle()

        val byKey = savedByKey(fake)
        assertEquals(setOf("kincare.auntie.on_my_way"), byKey?.keys)
        assertNull(byKey?.get("kincare.checkin.push_only"))
    }

    @Test
    fun categoryChannelChip_doesNotClearExistingPerKeyOverrides() = runComposeUiTest {
        // Task 27a defect #2: this row used to remove() every key's byKey
        // entry in the category on every click. byKey always wins over
        // byCategory, so a category change must only affect keys nobody has
        // overridden.
        val fake = FakeFunctionsClient()
        stubVisitPrefs(fake)
        stubVisitCatalog(fake)
        fake.stub("saveMyNotificationPrefs", buildJsonObject { put("ok", true) })
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Visit Updates").performClick()
        waitForIdle()

        onNodeWithTag("perkey-chip-kincare.auntie.on_my_way-sms").performClick() // override: sms true
        waitForIdle()
        onNodeWithTag("catchip-visit-sms").performClick() // flip the category's sms default
        waitForIdle()

        onNodeWithText("Save Notification Preferences").performClick()
        waitForIdle()

        val override = savedByKey(fake)?.get("kincare.auntie.on_my_way")?.jsonObject
        assertEquals(
            true,
            override?.get("sms")?.jsonPrimitive?.booleanOrNull,
            "the category control must not clear a deliberate per-key override",
        )
    }

    @Test
    fun categoryCard_explainsThatPerKeyOverridesSurviveTheCategoryControl() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisitPrefs(fake)
        stubVisitCatalog(fake)
        val catalog = NotificationCatalogRepository(fake)
        setThemedContent { NotificationSettingsScreen("The Foster", PortalApi(fake), catalog) }
        waitForIdle()
        onNodeWithText("Keys below with their own channel choice won't change when you flip this.").assertExists()
    }
}
