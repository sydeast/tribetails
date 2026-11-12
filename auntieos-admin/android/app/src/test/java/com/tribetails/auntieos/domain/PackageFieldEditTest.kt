package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2021, a regression of #1593. Discount refused "150" with a message, but every
 * keystroke that parsed had already been priced, so the "15" on the way to "150"
 * stayed as the discount. These tests type one key at a time through
 * [typePackageField] and [typeMaxGap], the functions the screen's fields call, because
 * `parseDiscountPct("150")` on its own was already right and already tested.
 * Mirrors the web `typeIntoFields` and Packages screen tests.
 */
class PackageFieldEditTest {
    private class Quote(val drafts: Map<String, FieldDraft>, val pkg: Package)

    private fun pkg(discountPct: Double = 0.0, buffer: Double = 2.0, id: String = "a") =
        Package(id, "Alpha", listOf(Visit("v", 540, "d2", "Morning")), overnightBufferHours = buffer, discountPct = discountPct)

    private fun fresh(discountPct: Double = 0.0) = Quote(emptyMap(), pkg(discountPct))

    /** Types [text] one key at a time, the way the keyboard feeds the field. */
    private fun type(q: Quote, text: String, field: PackageNumberField = PackageNumberField.DISCOUNT): Quote {
        var state = q
        for (i in 1..text.length) {
            val (drafts, pkg) = typePackageField(state.drafts, state.pkg, field, text.take(i))
            state = Quote(drafts, pkg)
        }
        return state
    }

    /** Select all and type over it: the field goes blank, then the keys arrive. */
    private fun retype(q: Quote, text: String, field: PackageNumberField = PackageNumberField.DISCOUNT): Quote {
        val (drafts, pkg) = typePackageField(q.drafts, q.pkg, field, "")
        return type(Quote(drafts, pkg), text, field)
    }

    private fun leave(q: Quote) = Quote(closeFieldEdits(q.drafts), q.pkg)

    private fun text(q: Quote, field: PackageNumberField = PackageNumberField.DISCOUNT) =
        q.drafts[packageFieldKey(q.pkg.id, field)]?.text

    private fun total(q: Quote): Double =
        pricePackage(q.pkg, PriceContext(days = 3, nights = 2, durations = DEFAULT_DURATIONS, overnightDuration = null)).total

    @Test
    fun aGoodDiscountIsPricedAsItIsTyped() {
        val q = type(fresh(), "20")
        assertEquals(20.0, q.pkg.discountPct, 0.0)
        assertEquals("20", text(q))
        // d2 is $25 a day: $75 for three days, $60 at 20% off.
        assertEquals(60.0, total(q), 0.001)
        assertEquals(12.5, type(fresh(), "12.5").pkg.discountPct, 0.0)
    }

    @Test
    fun oneFiftyPricesAtTheDiscountFromBeforeTheTypingNotAtFifteen() {
        val q = type(fresh(), "150")
        assertEquals("the text stays as typed", "150", text(q))
        assertEquals(0.0, q.pkg.discountPct, 0.0)
        assertEquals(75.0, total(q), 0.001)
        assertEquals(DISCOUNT_REFUSAL, (parseDiscountPct(text(q)!!) as PackageFieldParse.Refused).message)
    }

    @Test
    fun theWalkOneFiftyThenZeroThenTwoFifty() {
        var q = leave(type(fresh(), "150"))
        assertEquals(0.0, q.pkg.discountPct, 0.0)
        q = retype(q, "0")
        assertEquals(0.0, q.pkg.discountPct, 0.0)
        q = leave(retype(q, "250"))
        assertEquals("250", text(q))
        assertEquals(0.0, q.pkg.discountPct, 0.0)
        // "abc" next leaves it alone too.
        q = retype(q, "abc")
        assertEquals(0.0, q.pkg.discountPct, 0.0)
        assertEquals(75.0, total(q), 0.001)
    }

    @Test
    fun oneHundredIsTakenAndOneHundredAndOneIsRefused() {
        assertEquals(100.0, retype(fresh(20.0), "100").pkg.discountPct, 0.0)
        // 101 passes through 1 and 10 and prices at the 20 held before.
        val over = retype(fresh(20.0), "101")
        assertEquals(20.0, over.pkg.discountPct, 0.0)
        assertEquals("101", text(over))
        assertEquals(20.0, retype(fresh(20.0), "100.5").pkg.discountPct, 0.0)
    }

    @Test
    fun zeroAndBlankMeanNoDiscount() {
        assertEquals(0.0, retype(fresh(20.0), "0").pkg.discountPct, 0.0)
        val (drafts, blank) = typePackageField(emptyMap(), pkg(20.0), PackageNumberField.DISCOUNT, "")
        assertEquals(0.0, blank.discountPct, 0.0)
        assertEquals("", drafts[packageFieldKey("a", PackageNumberField.DISCOUNT)]?.text)
    }

    @Test
    fun lettersAMinusAndATrailingLetterAreRefusedBackToTheDiscountHeldBefore() {
        for (bad in listOf("abc", "-20", "15x", "1e2", "10%")) {
            val q = retype(fresh(20.0), bad)
            assertEquals("'$bad' should price at 20", 20.0, q.pkg.discountPct, 0.0)
            assertEquals(bad, text(q))
        }
    }

    @Test
    fun deletingTheBadKeyPricesWhatIsLeft() {
        val bad = type(fresh(), "150")
        val (drafts, fixed) = typePackageField(bad.drafts, bad.pkg, PackageNumberField.DISCOUNT, "15")
        assertEquals(15.0, fixed.discountPct, 0.0)
        assertTrue(drafts.getValue(packageFieldKey("a", PackageNumberField.DISCOUNT)).open)
    }

    @Test
    fun aDiscountLeftAloneIsChosenTwentyThenCloseThenTwoHundredKeepsTwenty() {
        // A phone keeps the field focused through a button tap, so the screen closes the
        // edit on Done and on any other action. After that, 20 is what a refusal keeps.
        val chosen = leave(type(fresh(), "20"))
        val (drafts, after) = typePackageField(chosen.drafts, chosen.pkg, PackageNumberField.DISCOUNT, "200")
        assertEquals(20.0, after.discountPct, 0.0)
        assertEquals(FieldDraft("200", 20.0, true), drafts[packageFieldKey("a", PackageNumberField.DISCOUNT)])
    }

    @Test
    fun withoutACloseTheSameEditGoesOn() {
        val q = type(fresh(), "20")
        val (_, after) = typePackageField(q.drafts, q.pkg, PackageNumberField.DISCOUNT, "200")
        assertEquals(0.0, after.discountPct, 0.0)
    }

    @Test
    fun typingInAnotherFieldClosesThisOne() {
        val first = type(fresh(), "20")
        val other = pkg(id = "b")
        val (drafts, _) = typePackageField(first.drafts, other, PackageNumberField.DISCOUNT, "5")
        assertFalse(drafts.getValue(packageFieldKey("a", PackageNumberField.DISCOUNT)).open)
        assertTrue(drafts.getValue(packageFieldKey("b", PackageNumberField.DISCOUNT)).open)
        val (_, back) = typePackageField(drafts, first.pkg, PackageNumberField.DISCOUNT, "200")
        assertEquals(20.0, back.discountPct, 0.0)
    }

    @Test
    fun closingWithNothingOpenChangesNothing() {
        val none = emptyMap<String, FieldDraft>()
        assertSame(none, closeFieldEdits(none))
        val closed = closeFieldEdits(type(fresh(), "20").drafts)
        assertSame(closed, closeFieldEdits(closed))
    }

    @Test
    fun theBufferKeepsWhatItHeldBeforeTheEdit() {
        val bad = retype(fresh(), "12a", PackageNumberField.BUFFER)
        assertEquals(2.0, bad.pkg.overnightBufferHours, 0.0)
        assertEquals("12a", text(bad, PackageNumberField.BUFFER))
        // Blank is refused for a buffer, and it does not touch the discount.
        val (_, blank) = typePackageField(emptyMap(), pkg(discountPct = 10.0), PackageNumberField.BUFFER, "")
        assertEquals(2.0, blank.overnightBufferHours, 0.0)
        assertEquals(10.0, blank.discountPct, 0.0)
        assertEquals(1.5, retype(fresh(), "1.5", PackageNumberField.BUFFER).pkg.overnightBufferHours, 0.0)
        assertEquals(0.0, retype(fresh(), "0", PackageNumberField.BUFFER).pkg.overnightBufferHours, 0.0)
    }

    @Test
    fun theMaxGapKeepsWhatItHeldBeforeTheEdit() {
        fun typeGap(text: String, start: CoverageRules = DEFAULT_COVERAGE_RULES): Pair<Map<String, FieldDraft>, CoverageRules> {
            var state = typeMaxGap(emptyMap(), start, "")
            for (i in 1..text.length) state = typeMaxGap(state.first, state.second, text.take(i))
            return state
        }
        val (drafts, rules) = typeGap("12a")
        assertEquals(6.0, rules.maxGapHours, 0.0)
        assertEquals("12a", drafts[MAX_GAP_FIELD]?.text)
        assertEquals(4.5, typeGap("4.5").second.maxGapHours, 0.0)
        assertEquals(30.0, typeGap("30").second.maxGapHours, 0.0)
        // Under an hour and a minus sign never move the rule.
        assertEquals(6.0, typeGap("0.5").second.maxGapHours, 0.0)
        assertEquals(6.0, typeGap("-5").second.maxGapHours, 0.0)
        // The pinned visits and the day window ride along untouched.
        assertEquals(DEFAULT_COVERAGE_RULES.pinnedTimes, rules.pinnedTimes)
    }
}
