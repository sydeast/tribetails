package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ChainVerifyResult
import com.tribetails.auntieos.web.data.WriteResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 9 integration test for [chainStateFrom]: the mapper the ActivityLog screen
 * uses to turn the verifyActivityLogChain callable result into the [ChainState] the
 * Hash-chain panel renders. Covers the three branches the panel splits on:
 *   - Ok(ok=true)  -> Done(ok)      => panel shows VERIFIED
 *   - Ok(ok=false) -> Done(anomaly) => panel shows ANOMALY + the loud anomaly banner
 *   - Err          -> Failed(msg)   => panel shows CHECK FAILED + the loud error banner
 * This proves the fail-loud anomaly/error paths can never collapse to a fake pass.
 */
class ActivityChainStateTest {

    private fun result(
        ok: Boolean,
        scanned: Int = 16,
        firstSeq: Int? = 1,
        lastSeq: Int? = 16,
        anomalyCode: String? = null,
        anomalySeq: Int? = null,
    ) = ChainVerifyResult(
        ok = ok,
        scanned = scanned,
        firstSeq = firstSeq,
        lastSeq = lastSeq,
        unchainedCount = 0,
        anomalyCode = anomalyCode,
        anomalySeq = anomalySeq,
    )

    @Test
    fun okPassMapsToDoneVerified() {
        val state = chainStateFrom(WriteResult.Ok(result(ok = true)))
        assertTrue(state is ChainState.Done)
        assertTrue((state as ChainState.Done).r.ok)
    }

    @Test
    fun okWithAnomalyMapsToDoneNotOk() {
        val r = result(ok = false, anomalyCode = "ENTRY_HASH_MISMATCH", anomalySeq = 7)
        val state = chainStateFrom(WriteResult.Ok(r))
        assertTrue(state is ChainState.Done)
        val done = state as ChainState.Done
        assertTrue(!done.r.ok)
        assertEquals("ENTRY_HASH_MISMATCH", done.r.anomalyCode)
        assertEquals(7, done.r.anomalySeq)
    }

    @Test
    fun errMapsToFailedAndPreservesMessage() {
        val state = chainStateFrom(WriteResult.Err("permission-denied"))
        assertTrue(state is ChainState.Failed)
        assertEquals("permission-denied", (state as ChainState.Failed).msg)
    }
}
