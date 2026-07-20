package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ChainVerifyResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for [chainVerdictLine] (Phase 11 chain-verify): the one-line
 * verdict must report the real result honestly and never fabricate a pass.
 */
class ChainVerdictLineTest {

    private fun ok(first: Int?, last: Int?, scanned: Int, unchained: Int = 0) =
        ChainVerifyResult(ok = true, scanned = scanned, firstSeq = first, lastSeq = last, unchainedCount = unchained, anomalyCode = null)

    @Test
    fun idlePrompts() {
        assertTrue(chainVerdictLine(ChainVerifyUiState.Idle).contains("Re-verify"))
    }

    @Test
    fun verifiedShowsSeqAndCount() {
        val line = chainVerdictLine(ChainVerifyUiState.Done(ok(first = 1, last = 16, scanned = 16)))
        assertEquals("Chain verified, seq 1..16, 16 scanned, 0 anomalies", line)
    }

    @Test
    fun verifiedNotesLegacyUnchained() {
        val line = chainVerdictLine(ChainVerifyUiState.Done(ok(first = 1, last = 16, scanned = 20, unchained = 4)))
        assertTrue(line.contains("4 legacy unchained"))
    }

    @Test
    fun brokenNamesCode() {
        val broken = ChainVerifyResult(ok = false, scanned = 10, firstSeq = 1, lastSeq = 10, unchainedCount = 0, anomalyCode = "entry_hash_mismatch", anomalySeq = 7)
        val line = chainVerdictLine(ChainVerifyUiState.Done(broken))
        assertTrue(line.startsWith("Chain BROKEN"))
        assertTrue(line.contains("entry_hash_mismatch"))
    }

    @Test
    fun errorSurfacesMessage() {
        assertTrue(chainVerdictLine(ChainVerifyUiState.Error("permission denied")).contains("permission denied"))
    }
}
