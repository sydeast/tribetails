package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.admin.ChainVerifyResult
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Slice 9 Robolectric compose UI test for the Activity-log hash-chain surfaces
 * (spec 22 item 2), redrawn to the mock in #755. Renders the real [ChainBadge]
 * and [ActivityRow] and asserts the fail-loud verdict + broken banner render: a
 * passing verdict shows "Chain verified" over the mono numbers line, an in-band
 * anomaly shows "Chain broken" + the loud "Hash chain integrity broken" banner,
 * and a verify failure surfaces the message. The per-row seq column is always
 * on: "#16" over the first eight characters of the hash for a sealed row, and
 * "legacy" for a row with no seq.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ActivityChainRenderTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun result(ok: Boolean, anomalyCode: String? = null, anomalySeq: Int? = null) =
        ChainVerifyResult(
            ok = ok, scanned = 16, firstSeq = 1, lastSeq = 16, unchainedCount = 0,
            anomalyCode = anomalyCode, anomalySeq = anomalySeq,
        )

    @Test
    fun `panel verified pass shows verified verdict`() {
        composeRule.setContent {
            AuntieOSTheme {
                ChainBadge(
                    verifyState = ChainVerifyUiState.Done(result(ok = true)),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Chain verified").assertIsDisplayed()
        composeRule.onNodeWithText("16 entries · seq 1..16 · 0 anomalies").assertIsDisplayed()
    }

    @Test
    fun `panel anomaly shows broken verdict and loud banner`() {
        composeRule.setContent {
            AuntieOSTheme {
                ChainBadge(
                    verifyState = ChainVerifyUiState.Done(result(ok = false, anomalyCode = "entry_hash_mismatch", anomalySeq = 7)),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Chain broken").assertIsDisplayed()
        composeRule.onNodeWithText("First break at seq 7: entry_hash_mismatch. Scanned 16.").assertIsDisplayed()
        composeRule.onNodeWithText("Hash chain integrity broken").assertIsDisplayed()
    }

    @Test
    fun `panel error surfaces the message`() {
        composeRule.setContent {
            AuntieOSTheme {
                ChainBadge(
                    verifyState = ChainVerifyUiState.Error("permission-denied"),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Verification call failed").assertIsDisplayed()
        composeRule.onNodeWithText("permission-denied").assertIsDisplayed()
    }

    @Test
    fun `row sealed entry shows seq over hash`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e1", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = 16L, entryHash = "a1b2c3d4e5f6"),
                    onClick = {},
                )
            }
        }
        // The mock's seq column: the number, then the first eight of the hash
        // as written on the wire (the hash is a value, so it is not uppercased).
        composeRule.onNodeWithText("#16").assertIsDisplayed()
        composeRule.onNodeWithText("a1b2c3d4").assertIsDisplayed()
        composeRule.onAllNodesWithText("legacy").assertCountEquals(0)
    }

    @Test
    fun `row legacy entry says legacy in the seq column`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e2", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = null, entryHash = ""),
                    onClick = {},
                )
            }
        }
        composeRule.onNodeWithText("legacy").assertIsDisplayed()
    }

    @Test
    fun `row carries no status pill, the tile tone carries a failure`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e3", actionType = "LOGIN", status = "FAILURE", timestamp = "2026-05-27T09:41:00Z", seq = 9L, entryHash = "deadbeef00"),
                    onClick = {},
                )
            }
        }
        // The mock draws no status word on the row; the status is in the
        // opened record, and the coral warning tile marks the failure.
        composeRule.onAllNodesWithText("FAILURE").assertCountEquals(0)
        composeRule.onNodeWithText("Login").assertIsDisplayed()
        composeRule.onNodeWithText("LOGIN").assertIsDisplayed()
    }
}
