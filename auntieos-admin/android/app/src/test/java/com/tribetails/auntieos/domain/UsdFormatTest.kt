package com.tribetails.auntieos.domain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1488: every admin money label groups thousands, matching the portal and the server. */
class UsdFormatTest {
    @Test
    fun `formatUsd groups thousands at the boundaries`() {
        assertEquals("$0.00", formatUsd(0.0))
        assertEquals("$999.99", formatUsd(999.99))
        assertEquals("$1,000.00", formatUsd(1000.0))
        assertEquals("$1,234.50", formatUsd(1234.5))
        assertEquals("-$1,234.50", formatUsd(-1234.5))
        assertEquals("$1,000,000.00", formatUsd(1_000_000.0))
    }
    @Test
    fun `formatUsd rounds half up to the cent and reads non-finite as zero`() {
        assertEquals("$0.01", formatUsd(0.005))
        assertEquals("$12.35", formatUsd(12.345))
        assertEquals("$0.00", formatUsd(Double.NaN))
        assertEquals("$0.00", formatUsd(Double.POSITIVE_INFINITY))
    }
    @Test
    fun `formatUsdCents formats integer cents the same way`() {
        assertEquals("$0.00", formatUsdCents(0L))
        assertEquals("$999.99", formatUsdCents(99_999L))
        assertEquals("$1,000.00", formatUsdCents(100_000L))
        assertEquals("$1,234.50", formatUsdCents(123_450L))
        assertEquals("-$1,234.50", formatUsdCents(-123_450L))
        assertEquals("$1,000,000.00", formatUsdCents(100_000_000L))
    }
    @Test
    fun `groupThousands places a comma every three digits`() {
        assertEquals("0", groupThousands(0L))
        assertEquals("999", groupThousands(999L))
        assertEquals("1,000", groupThousands(1000L))
        assertEquals("12,345", groupThousands(12_345L))
        assertEquals("123,456", groupThousands(123_456L))
        assertEquals("1,234,567", groupThousands(1_234_567L))
        assertEquals("-1,000", groupThousands(-1000L))
    }
    @Test
    fun `usdDigits is the grouped figure without the dollar sign`() {
        assertEquals("1,234.50", usdDigits(1234.5))
        assertEquals("30.00", usdDigits(30.0))
    }
    @Test
    fun `formatUsdCompact drops whole-dollar cents and still groups`() {
        assertEquals("$1,280", formatUsdCompact(1280.0))
        assertEquals("$1,280.50", formatUsdCompact(1280.5))
        assertEquals("$40", formatUsdCompact(40.0))
        assertEquals("$0", formatUsdCompact(0.0))
        assertEquals("-$1,000", formatUsdCompact(-1000.0))
    }
    @Test
    fun `moneyTextMatches finds a grouped amount with or without the comma`() {
        assertTrue(moneyTextMatches("$1,234.50", "$1,234.50"))
        assertTrue(moneyTextMatches("$1,234.50", "1234.50"))
        assertTrue(moneyTextMatches("$1,234.50", "1,234"))
        assertTrue(moneyTextMatches("$1,234.50", "$1234"))
        assertFalse(moneyTextMatches("$1,234.50", "$1,235"))
        assertFalse(moneyTextMatches("$40", ","))
    }
}
