package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-helper tests for [seqHashLabel] (spec 22 item 2), mirroring the web
 * SeqHashLabelTest: a sealed entry shows "#seq · hash8"; an unsealed (legacy)
 * entry returns null so the row renders no fabricated hash.
 */
class SeqHashLabelTest {

    @Test
    fun sealedEntryShowsSeqAndShortHash() {
        assertEquals("#16 · a1b2c3d4", seqHashLabel(16L, "a1b2c3d4e5f6"))
    }

    @Test
    fun nullSeqReturnsNull() {
        assertNull(seqHashLabel(null, "a1b2c3d4"))
    }

    @Test
    fun sealedEntryWithBlankHashShowsSeqOnly() {
        assertEquals("#3", seqHashLabel(3L, ""))
    }
}
