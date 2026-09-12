package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ChainVerifyResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for [chainVerdict] and [chainVerdictLine] (Phase 11
 * chain-verify, redrawn for the mock's badge in #755): the bold word and the
 * mono line under it must report the real result honestly and never fabricate
 * a pass. The line is word for word the web badge's, so both clients say one
 * thing about one chain.
 */
class ChainVerdictLineTest {

    private fun ok(first: Int?, last: Int?, scanned: Int, unchained: Int = 0) =
        ChainVerifyResult(ok = true, scanned = scanned, firstSeq = first, lastSeq = last, unchainedCount = unchained, anomalyCode = null)

    @Test
    fun idleAndLoadingSayVerifying() {
        assertEquals("Verifying the chain", chainVerdict(ChainVerifyUiState.Idle))
        assertEquals("Verifying the chain", chainVerdict(ChainVerifyUiState.Loading))
        assertEquals("Walking the SHA-256 chain server-side.", chainVerdictLine(ChainVerifyUiState.Loading))
    }

    @Test
    fun verifiedShowsSeqAndCount() {
        val state = ChainVerifyUiState.Done(ok(first = 1, last = 16, scanned = 16))
        assertEquals("Chain verified", chainVerdict(state))
        assertEquals("16 entries · seq 1..16 · 0 anomalies", chainVerdictLine(state))
    }

    @Test
    fun verifiedNotesLegacyUnchained() {
        val line = chainVerdictLine(ChainVerifyUiState.Done(ok(first = 1, last = 16, scanned = 20, unchained = 4)))
        assertEquals("20 entries · seq 1..16 · 0 anomalies · 4 legacy outside the chain", line)
    }

    @Test
    fun verifiedWithNoRangeLeavesTheRangeOut() {
        val line = chainVerdictLine(ChainVerifyUiState.Done(ok(first = null, last = null, scanned = 0)))
        assertEquals("0 entries · 0 anomalies", line)
    }

    @Test
    fun brokenNamesSeqAndCode() {
        val broken = ChainVerifyResult(ok = false, scanned = 10, firstSeq = 1, lastSeq = 10, unchainedCount = 0, anomalyCode = "entry_hash_mismatch", anomalySeq = 7)
        val state = ChainVerifyUiState.Done(broken)
        assertEquals("Chain broken", chainVerdict(state))
        assertEquals("First break at seq 7: entry_hash_mismatch. Scanned 10.", chainVerdictLine(state))
    }

    @Test
    fun errorSurfacesMessage() {
        val state = ChainVerifyUiState.Error("permission denied")
        assertEquals("Verification call failed", chainVerdict(state))
        assertTrue(chainVerdictLine(state).contains("permission denied"))
    }
}
