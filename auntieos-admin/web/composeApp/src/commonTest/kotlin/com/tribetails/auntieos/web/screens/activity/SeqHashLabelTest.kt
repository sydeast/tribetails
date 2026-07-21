package com.tribetails.auntieos.web.screens.activity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pure-helper tests for [seqHashLabel] (spec 22 item 2): a sealed entry shows
 * "#seq · hash8"; an unsealed (legacy) entry returns null so the row renders no
 * fabricated hash.
 */
class SeqHashLabelTest {

    @Test
    fun sealedEntryShowsSeqAndShortHash() {
        assertEquals("#16 · a1b2c3d4", seqHashLabel(16, "a1b2c3d4e5f6"))
    }

    @Test
    fun nullSeqReturnsNull() {
        assertNull(seqHashLabel(null, "a1b2c3d4"))
    }

    @Test
    fun sealedEntryWithBlankHashShowsSeqOnly() {
        assertEquals("#3", seqHashLabel(3, ""))
    }
}
