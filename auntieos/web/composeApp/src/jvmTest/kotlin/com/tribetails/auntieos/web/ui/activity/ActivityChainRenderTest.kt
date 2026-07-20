package com.tribetails.auntieos.web.ui.activity

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.ChainVerifyResult
import com.tribetails.auntieos.web.screens.activity.ActivityRow
import com.tribetails.auntieos.web.screens.activity.ChainIntegrityPanel
import com.tribetails.auntieos.web.screens.activity.ChainState
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test

/**
 * Slice 9 desktop compose UI test for the Activity-log hash-chain surfaces
 * (spec 22 item 2). Renders the real [ChainIntegrityPanel] and [ActivityRow] and
 * asserts the fail-loud verdict/banners actually render: VERIFIED on a pass,
 * ANOMALY + the loud anomaly banner on a break, CHECK FAILED + the loud error
 * banner on a verify failure; and the per-row seq/hash pill shows "#16 · a1b2c3d4"
 * for a sealed row and the honest "unchained" pill for a legacy row.
 */
@OptIn(ExperimentalTestApi::class)
class ActivityChainRenderTest {

    private fun result(
        ok: Boolean,
        scanned: Int = 16,
        firstSeq: Int? = 1,
        lastSeq: Int? = 16,
        anomalyCode: String? = null,
        anomalySeq: Int? = null,
    ) = ChainVerifyResult(
        ok = ok, scanned = scanned, firstSeq = firstSeq, lastSeq = lastSeq,
        unchainedCount = 0, anomalyCode = anomalyCode, anomalySeq = anomalySeq,
    )

    @Test
    fun panel_verifiedPass_showsVerifiedPill() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ChainIntegrityPanel(entryCount = 16, state = ChainState.Done(result(ok = true)), onReverify = {})
            }
        }
        onNodeWithText("VERIFIED").assertIsDisplayed()
    }

    @Test
    fun panel_anomaly_showsAnomalyPillAndLoudBanner() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ChainIntegrityPanel(
                    entryCount = 16,
                    state = ChainState.Done(result(ok = false, anomalyCode = "ENTRY_HASH_MISMATCH", anomalySeq = 7)),
                    onReverify = {},
                )
            }
        }
        onNodeWithText("ANOMALY").assertIsDisplayed()
        onNodeWithText("Chain anomaly detected").assertIsDisplayed()
    }

    @Test
    fun panel_failed_showsCheckFailedAndLoudErrorBanner() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ChainIntegrityPanel(entryCount = 16, state = ChainState.Failed("permission-denied"), onReverify = {})
            }
        }
        onNodeWithText("CHECK FAILED").assertIsDisplayed()
        onNodeWithText("Could not verify the chain").assertIsDisplayed()
    }

    @Test
    fun panel_verifying_showsVerifyingPill() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ChainIntegrityPanel(entryCount = 0, state = ChainState.Verifying, onReverify = {})
            }
        }
        onNodeWithText("VERIFYING").assertIsDisplayed()
    }

    @Test
    fun row_sealedEntry_showsSeqHashPill() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ActivityRow(
                    entry = ActivityLogEntry(_id = "e1", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = 16, entryHash = "a1b2c3d4e5f6"),
                    onClick = {},
                )
            }
        }
        // AuntieStatusPill mono=true uppercases the label at render time.
        onNodeWithText("#16 · A1B2C3D4").assertIsDisplayed()
    }

    @Test
    fun row_legacyEntry_showsUnchainedPill() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ActivityRow(
                    entry = ActivityLogEntry(_id = "e2", actionType = "LOGIN", status = "SUCCESS", timestamp = "2026-05-27T09:41:00Z", seq = null, entryHash = ""),
                    onClick = {},
                )
            }
        }
        onNodeWithText("UNCHAINED").assertIsDisplayed()
    }
}
