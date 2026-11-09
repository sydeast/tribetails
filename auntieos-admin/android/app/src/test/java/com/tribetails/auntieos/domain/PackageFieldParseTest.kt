package com.tribetails.auntieos.domain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * #1593: Discount 150% priced as 100%, -20% and "abc" as 0, Buffer "abc" as 0, and an End
 * before the Start priced nothing with no reason given. Mirrors the web
 * `parseDiscountPct` / `parseBufferHours` / `dateRangeRefusal` tests.
 */
class PackageFieldParseTest {
    @Test
    fun discountReadsBlankAsNoDiscountAndTakesZeroToOneHundred() {
        assertEquals(PackageFieldParse.Ok(0.0), parseDiscountPct(""))
        assertEquals(PackageFieldParse.Ok(0.0), parseDiscountPct("  "))
        assertEquals(PackageFieldParse.Ok(0.0), parseDiscountPct("0"))
        assertEquals(PackageFieldParse.Ok(12.5), parseDiscountPct(" 12.5 "))
        assertEquals(PackageFieldParse.Ok(100.0), parseDiscountPct("100"))
    }
    @Test
    fun discountRefuses150Minus20AbcAndAnythingNotAPlainNumber() {
        for (bad in listOf("150", "100.5", "-20", "-", "abc", "+5", "1e2", "10%", "1,5", "5.")) {
            assertEquals("'$bad' should be refused", PackageFieldParse.Refused(DISCOUNT_REFUSAL), parseDiscountPct(bad))
        }
        assertEquals("Enter a discount from 0 to 100 percent.", DISCOUNT_REFUSAL)
    }
    @Test
    fun bufferTakesZeroOrMoreHoursWithNoUpperBound() {
        assertEquals(PackageFieldParse.Ok(0.0), parseBufferHours("0"))
        assertEquals(PackageFieldParse.Ok(1.0), parseBufferHours("1"))
        assertEquals(PackageFieldParse.Ok(1.5), parseBufferHours(" 1.5 "))
        assertEquals(PackageFieldParse.Ok(12.0), parseBufferHours("12"))
    }
    @Test
    fun bufferRefusesAbcMinusOneBlankAndAnythingNotAPlainNumber() {
        for (bad in listOf("abc", "-1", "-", "", "  ", "+1", "1e2", "1.", "2h")) {
            assertEquals("'$bad' should be refused", PackageFieldParse.Refused(BUFFER_REFUSAL), parseBufferHours(bad))
        }
        assertEquals("Enter the buffer in hours, 0 or more, like 1 or 1.5.", BUFFER_REFUSAL)
    }
    @Test
    fun anEndBeforeTheStartIsRefused() {
        assertEquals(DATE_ORDER_REFUSAL, dateRangeRefusal("2026-07-05", "2026-07-01"))
        assertEquals("The end date has to be on or after the start date.", DATE_ORDER_REFUSAL)
        // Refused ranges price nothing.
        assertEquals(0, daysBetween("2026-07-05", "2026-07-01"))
    }
    @Test
    fun theSameDayALaterEndAndAnUnsetRangeAreNotRefused() {
        assertNull(dateRangeRefusal("2026-07-01", "2026-07-01"))
        assertNull(dateRangeRefusal("2026-07-01", "2026-07-05"))
        assertNull(dateRangeRefusal("2026-07-01", ""))
        assertNull(dateRangeRefusal("", "2026-07-01"))
    }
    @Test
    fun theQuotePrintsADecimalDiscountAsTypedLikeWeb() {
        val pkg = Package("p1", "Test", listOf(Visit("v", 12 * 60, "d3", "Lunch")), discountPct = 12.5)
        val ctx = PriceContext(days = 1, nights = 0, durations = DEFAULT_DURATIONS, overnightDuration = null)
        val priced = pricePackage(pkg, ctx)
        val text = quoteText(QuoteInput("", "", 1, pkg, priced))
        assertTrue(text, text.contains("Discount (12.5%)"))
    }
}
