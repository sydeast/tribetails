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
 * (spec 22 item 2). Renders the real [ChainIntegrityPanel] and [ActivityRow] and
 * asserts the fail-loud verdict + broken banner render: a passing verdict shows
 * "Chain verified...", an in-band anomaly shows "Chain BROKEN..." + the loud
 * "Hash chain integrity broken" banner, and a verify failure surfaces the message.
 * The per-row pill is always on: "#16 · A1B2C3D4" (mono uppercase) for a sealed
 * row, and an "UNCHAINED" pill for a legacy row with no seq.
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
                ChainIntegrityPanel(
                    entryCount = 16,
                    verifyState = ChainVerifyUiState.Done(result(ok = true)),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Chain verified, seq 1..16, 16 scanned, 0 anomalies").assertIsDisplayed()
    }

    @Test
    fun `panel anomaly shows broken verdict and loud banner`() {
        composeRule.setContent {
            AuntieOSTheme {
                ChainIntegrityPanel(
                    entryCount = 16,
                    verifyState = ChainVerifyUiState.Done(result(ok = false, anomalyCode = "entry_hash_mismatch", anomalySeq = 7)),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Chain BROKEN (entry_hash_mismatch)").assertIsDisplayed()
        composeRule.onNodeWithText("Hash chain integrity broken").assertIsDisplayed()
    }

    @Test
    fun `panel error surfaces the message`() {
        composeRule.setContent {
            AuntieOSTheme {
                ChainIntegrityPanel(
                    entryCount = 16,
                    verifyState = ChainVerifyUiState.Error("permission-denied"),
                    onVerify = {},
                )
            }
        }
        composeRule.onNodeWithText("Chain verification failed: permission-denied").assertIsDisplayed()
    }

    @Test
    fun `row sealed entry shows seq hash pill`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e1", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = 16L, entryHash = "a1b2c3d4e5f6"),
                    onClick = {},
                )
            }
        }
        // AuntieStatusPill mono=true uppercases the label at render time.
        composeRule.onNodeWithText("#16 · A1B2C3D4").assertIsDisplayed()
    }

    @Test
    fun `row legacy entry shows unchained pill`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e2", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = null, entryHash = ""),
                    onClick = {},
                )
            }
        }
        composeRule.onNodeWithText("UNCHAINED").assertIsDisplayed()
    }

    @Test
    fun `row sealed entry shows no unchained pill`() {
        composeRule.setContent {
            AuntieOSTheme {
                ActivityRow(
                    entry = ActivityLogEntry(id = "e3", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = 9L, entryHash = "deadbeef00"),
                    onClick = {},
                )
            }
        }
        // Negative: a sealed row shows its seq/hash pill, never the "unchained" pill.
        composeRule.onAllNodesWithText("UNCHAINED").assertCountEquals(0)
    }
}
