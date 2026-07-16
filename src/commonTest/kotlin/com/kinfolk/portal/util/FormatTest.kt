package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals

class FormatTest {

    @Test
    fun `formatUsd zero`() {
        assertEquals("$0.00", formatUsd(0.0))
    }

    @Test
    fun `formatUsd basic two decimals`() {
        assertEquals("$1.50", formatUsd(1.50))
    }

    @Test
    fun `formatUsd thousands separator`() {
        assertEquals("$1,234.56", formatUsd(1234.56))
    }

    @Test
    fun `formatUsd large value`() {
        assertEquals("$1,000,000.00", formatUsd(1_000_000.0))
    }

    @Test
    fun `formatUsd negative`() {
        assertEquals("-$50.00", formatUsd(-50.0))
    }

    @Test
    fun `formatUsd rounds to nearest cent`() {
        assertEquals("$0.10", formatUsd(0.099))
        assertEquals("$1.00", formatUsd(0.999))
    }
}
