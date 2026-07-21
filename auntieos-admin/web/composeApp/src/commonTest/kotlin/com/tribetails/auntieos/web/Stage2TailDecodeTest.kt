package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.BatchBookingResult
import com.tribetails.auntieos.web.data.computeUnboundCatalogKeys
import com.tribetails.auntieos.web.data.decodeBatchBookingResult
import com.tribetails.auntieos.web.data.decodeCatalogKeys
import com.tribetails.auntieos.web.data.summarizeBatchResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

/**
 * Stage 2 tail Step 1: pure decoders + compute helpers shared by web (Wasm) and
 * desktop (JVM). No platform/callable dependency, so these run in commonTest.
 */
class Stage2TailDecodeTest {

    // ---- decodeBatchBookingResult ----
    @Test
    fun decodesBatchResultWithFailures() {
        val r = decodeBatchBookingResult(
            """{"ok":true,"action":"REJECT","updated":4,"failed":[{"id":"a","error":"gone"},{"id":"b","error":"x"}]}""",
        )
        assertEquals("REJECT", r.action)
        assertEquals(4, r.updated)
        assertEquals(2, r.failedCount)
        assertEquals("a", r.failed[0].id)
        assertEquals("gone", r.failed[0].error)
    }

    @Test
    fun decodesBatchResultMissingFieldsToSafeEmpties() {
        val r = decodeBatchBookingResult("""{"ok":true}""")
        assertEquals("", r.action)
        assertEquals(0, r.updated)
        assertEquals(0, r.failedCount)
    }

    @Test
    fun batchResultMalformedThrows() {
        assertFails { decodeBatchBookingResult("not-json{") }
    }

    // ---- decodeCatalogKeys ----
    @Test
    fun decodesCatalogKeys() {
        assertEquals(listOf("x.y", "z"), decodeCatalogKeys("""{"keys":["x.y","z"]}"""))
    }

    @Test
    fun catalogKeysMissingDecodesToEmpty() {
        assertEquals(emptyList(), decodeCatalogKeys("""{}"""))
    }

    @Test
    fun catalogKeysMalformedThrows() {
        assertFails { decodeCatalogKeys("not-json{") }
    }

    // ---- computeUnboundCatalogKeys ----
    @Test
    fun computesUnboundKeysSortedAndDeduped() {
        val unbound = computeUnboundCatalogKeys(
            allCatalogKeys = listOf("b.key", "a.key", "c.key", "a.key"),
            boundKeys = setOf("a.key"),
        )
        assertEquals(listOf("b.key", "c.key"), unbound)
    }

    @Test
    fun allBoundYieldsEmpty() {
        val unbound = computeUnboundCatalogKeys(
            allCatalogKeys = listOf("a", "b"),
            boundKeys = setOf("a", "b"),
        )
        assertEquals(emptyList(), unbound)
    }

    @Test
    fun nothingBoundReturnsEverythingSorted() {
        val unbound = computeUnboundCatalogKeys(
            allCatalogKeys = listOf("z", "m", "a"),
            boundKeys = emptySet(),
        )
        assertEquals(listOf("a", "m", "z"), unbound)
    }

    // ---- summarizeBatchResult ----
    @Test
    fun summarizesCleanResult() {
        assertEquals("3 updated", summarizeBatchResult(BatchBookingResult("APPROVE", 3, emptyList())))
    }

    @Test
    fun summarizesPartialFailure() {
        val r = decodeBatchBookingResult(
            """{"ok":true,"action":"CANCEL","updated":1,"failed":[{"id":"a","error":"e"}]}""",
        )
        assertEquals("1 updated, 1 failed", summarizeBatchResult(r))
    }
}
