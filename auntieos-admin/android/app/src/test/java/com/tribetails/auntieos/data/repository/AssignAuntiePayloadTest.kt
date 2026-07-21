package com.tribetails.auntieos.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure encode contract for the assignAuntie callable payload that
 * AuntieRepository.assignAuntie sends. The backend schema is
 * `auntieUid: string | null` (not optional), so the key must be present on an
 * unassign and carry an explicit null. Kept pure so it is testable without
 * Firebase static init.
 */
class AssignAuntiePayloadTest {

    @Test fun `assign payload carries ids and auntie uid`() {
        val p = assignAuntiePayload("fam1", "batch1", "v1", "u1")
        assertEquals("fam1", p["kinfolkId"])
        assertEquals("batch1", p["batchId"])
        assertEquals("v1", p["visitId"])
        assertEquals("u1", p["auntieUid"])
        assertEquals(4, p.size)
    }

    @Test fun `unassign payload keeps auntieUid key with explicit null`() {
        val p = assignAuntiePayload("fam1", "batch1", "v1", null)
        assertTrue(p.containsKey("auntieUid"))
        assertNull(p["auntieUid"])
        assertEquals("v1", p["visitId"])
    }
}
