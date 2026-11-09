package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.data.SettingsChecks.businessEmailProblem
import com.tribetails.auntieos.web.data.SettingsChecks.businessPhoneProblem
import com.tribetails.auntieos.web.data.SettingsChecks.cashappHandleProblem
import com.tribetails.auntieos.web.data.SettingsChecks.durationProblem
import com.tribetails.auntieos.web.data.SettingsChecks.homeLimitProblem
import com.tribetails.auntieos.web.data.SettingsChecks.homeLimitValue
import com.tribetails.auntieos.web.data.SettingsChecks.hoursRangeProblem
import com.tribetails.auntieos.web.data.SettingsChecks.isRealDate
import com.tribetails.auntieos.web.data.SettingsChecks.kinCareNameProblems
import com.tribetails.auntieos.web.data.SettingsChecks.newDateProblem
import com.tribetails.auntieos.web.data.SettingsChecks.optionListProblem
import com.tribetails.auntieos.web.data.SettingsChecks.paypalHandleProblem
import com.tribetails.auntieos.web.data.SettingsChecks.priceLabel
import com.tribetails.auntieos.web.data.SettingsChecks.priceProblem
import com.tribetails.auntieos.web.data.SettingsChecks.venmoHandleProblem
import com.tribetails.auntieos.web.data.SettingsChecks.weekdayHoursProblem
import com.tribetails.auntieos.web.data.SettingsChecks.wholeNumberProblem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1593: the desktop copy of `businessSettingsChecks.ts`, rule by rule. Happy,
 * sad and edge cases for each. `SettingsChecksServerParityTest` (jvmTest)
 * reads the sentences back against the server file.
 */
class SettingsChecksTest {

    // ── email and phone ──────────────────────────────────────────────────────

    @Test
    fun emailMayBeBlankOrAnEmail() {
        assertNull(businessEmailProblem(""))
        assertNull(businessEmailProblem("   "))
        assertNull(businessEmailProblem("hello@tribetails.com"))
        assertNull(businessEmailProblem("  hello@tribetails.com  "), "trimmed, as the server trims")
    }

    @Test
    fun emailThatDoesNotReadIsRefused() {
        for (bad in listOf("hello", "hello@", "@tribetails.com", "hello@tribetails", "a..b@tribetails.com", "hello@tribetails.c", "a b@tribetails.com")) {
            assertEquals(SettingsChecks.EMAIL_INVALID, businessEmailProblem(bad), bad)
        }
        assertEquals(SettingsChecks.EMAIL_INVALID, businessEmailProblem("a".repeat(250) + "@x.com"), "over 254 characters")
    }

    @Test
    fun phoneMayBeBlankOrTenDigits() {
        assertNull(businessPhoneProblem(""))
        assertNull(businessPhoneProblem("(512) 555-0142"))
        assertNull(businessPhoneProblem("512.555.0142"))
        assertNull(businessPhoneProblem("+1 512 555 0142"))
    }

    @Test
    fun phoneThatDoesNotReadIsRefused() {
        for (bad in listOf("555-0142", "51255501421", "2 512 555 0142", "512-555-O142", "call me", "512555014x")) {
            assertEquals(SettingsChecks.PHONE_INVALID, businessPhoneProblem(bad), bad)
        }
    }

    // ── hours ────────────────────────────────────────────────────────────────

    @Test
    fun hoursReadAsARangeClosingAfterOpening() {
        assertNull(hoursRangeProblem("09:00-17:00"))
        assertNull(hoursRangeProblem("9:00-17:00"))
        assertNull(hoursRangeProblem(" 09:00 - 17:30 "))
        assertNull(hoursRangeProblem("00:00-23:59"))
    }

    @Test
    fun hoursThatDoNotReadAreRefused() {
        for (bad in listOf("", "zz-99", "09:00", "09:00-17:00-18:00", "24:00-25:00", "9-17", "09:60-17:00", "0900-1700")) {
            assertEquals(SettingsChecks.HOURS_RANGE_INVALID, hoursRangeProblem(bad), bad)
        }
    }

    @Test
    fun closingAtOrBeforeOpeningIsRefused() {
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, hoursRangeProblem("17:00-09:00"))
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, hoursRangeProblem("09:00-09:00"))
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, hoursRangeProblem("9:30-09:00"), "compared padded")
    }

    @Test
    fun aBlankWeekdayIsClosed() {
        assertNull(weekdayHoursProblem(""))
        assertNull(weekdayHoursProblem("  "))
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, weekdayHoursProblem("18:00-08:00"))
    }

    // ── dates ────────────────────────────────────────────────────────────────

    @Test
    fun aRealDateIsOneTheCalendarHas() {
        assertTrue(isRealDate("2026-11-09"))
        assertTrue(isRealDate("2028-02-29"), "leap year")
        assertFalse(isRealDate("2026-02-29"))
        assertFalse(isRealDate("2026-02-30"))
        assertFalse(isRealDate("2026-13-45"))
        assertFalse(isRealDate("2026-00-10"))
        assertFalse(isRealDate("2026-04-31"))
        assertFalse(isRealDate("2100-02-29"), "century, not a leap year")
        assertTrue(isRealDate("2000-02-29"), "every 400 years is")
        assertFalse(isRealDate("2026-1-9"))
        assertFalse(isRealDate("11/09/2026"))
    }

    @Test
    fun aNewDateMustBeTodayOrLater() {
        val today = "2026-11-09"
        assertNull(newDateProblem("2026-11-09", today))
        assertNull(newDateProblem("2027-01-01", today))
        assertNull(newDateProblem(" 2027-01-01 ", today))
        assertEquals(SettingsChecks.DATE_PAST, newDateProblem("2026-11-08", today))
        assertEquals(SettingsChecks.DATE_INVALID, newDateProblem("2026-13-45", today))
        assertEquals(SettingsChecks.DATE_INVALID, newDateProblem("", today))
    }

    // ── KinCare types ────────────────────────────────────────────────────────

    @Test
    fun aBlankPriceMeansNoPriceSet() {
        assertNull(priceProblem("Drop-in", ""))
        assertNull(priceProblem("Drop-in", "  "))
        assertEquals(SettingsChecks.NO_PRICE_SET, priceLabel("Drop-in", ""))
    }

    @Test
    fun aPriceIsDollarsWithAtMostTwoDecimals() {
        for (good in listOf("0", "25", "25.5", "25.50", "1234567", "1234567.99")) {
            assertNull(priceProblem("Drop-in", good), good)
        }
        assertEquals("\$25.50", priceLabel("Drop-in", "25.50"))
    }

    @Test
    fun aPriceThatDoesNotReadIsRefused() {
        val sentence = "Enter the price for \"Drop-in\" in dollars, like 25 or 25.50."
        for (bad in listOf("abc", "1.234", "25.", ".5", "\$25", "12345678", "25 dollars", "2,500")) {
            assertEquals(sentence, priceProblem("Drop-in", bad), bad)
            assertNull(priceLabel("Drop-in", bad), "no chip for $bad")
        }
        assertEquals("The price for \"Drop-in\" cannot be negative.", priceProblem("Drop-in", "-5"))
        assertNull(priceLabel("Drop-in", "-5"))
    }

    @Test
    fun aLengthIsBlankOrWholeMinutesFrom1To1440() {
        assertNull(durationProblem("Overnight", ""))
        assertNull(durationProblem("Overnight", "1"))
        assertNull(durationProblem("Overnight", "720"))
        assertNull(durationProblem("Overnight", "1440"))
        val sentence = "Enter the length of \"Overnight\" in whole minutes, from 1 to 1440."
        for (bad in listOf("0", "1441", "-30", "30.5", "abc", "1h")) {
            assertEquals(sentence, durationProblem("Overnight", bad), bad)
        }
    }

    @Test
    fun everyKinCareTypeNeedsADistinctName() {
        assertEquals(listOf(null, null), kinCareNameProblems(listOf("Drop-in", "Overnight")))
        assertEquals(listOf(null, SettingsChecks.KINCARE_NAME_REQUIRED), kinCareNameProblems(listOf("Drop-in", "  ")))
        assertEquals(
            listOf(null, "Two KinCare types are both called \"drop-in\"."),
            kinCareNameProblems(listOf("Drop-in", " drop-in ")),
            "ignoring case and spaces, the later row carries it",
        )
        val long = "x".repeat(81)
        assertEquals(listOf("Keep the name \"${"x".repeat(20)}...\" under 80 characters."), kinCareNameProblems(listOf(long)))
        assertEquals(listOf(null), kinCareNameProblems(listOf("x".repeat(80))))
    }

    // ── numbers ──────────────────────────────────────────────────────────────

    @Test
    fun aWholeNumberInsideItsRange() {
        assertNull(wholeNumberProblem("90", 1, 3650, "days"))
        assertNull(wholeNumberProblem("1", 1, 3650, "days"))
        assertNull(wholeNumberProblem("3650", 1, 3650, "days"))
        assertNull(wholeNumberProblem("0", 0, 480, "minutes"))
        for (bad in listOf("", " ", "0", "3651", "-1", "1.5", "abc")) {
            assertEquals("Enter 1 to 3650 days.", wholeNumberProblem(bad, 1, 3650, "days"), bad)
        }
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("9", 10, 5000, "metres"))
    }

    @Test
    fun anOptionListIsWholeNumbersAboveZeroWithNoRepeats() {
        assertNull(optionListProblem("5, 10, 15", "minutes"))
        assertNull(optionListProblem("30,60,90,", "days"), "a trailing comma is not an entry")
        assertEquals("List at least one option, in minutes.", optionListProblem("", "minutes"))
        assertEquals("List at least one option, in days.", optionListProblem(" , ", "days"))
        assertEquals("That is more than 12 options. Trim the list.", optionListProblem((1..13).joinToString(","), "minutes"))
        assertNull(optionListProblem((1..12).joinToString(","), "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, 0", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, -1", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, 7.5", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("five", "minutes"))
        assertEquals("10 is listed twice.", optionListProblem("5, 10, 10", "minutes"))
    }

    // ── payment handles ──────────────────────────────────────────────────────

    @Test
    fun venmoHandles() {
        assertNull(venmoHandleProblem(""))
        assertNull(venmoHandleProblem("@tribetails"))
        assertNull(venmoHandleProblem("tribe-tails_1"))
        val sentence = "Enter the Venmo username: 5 to 30 letters, numbers, - or _."
        for (bad in listOf("abcd", "@abcd", "x".repeat(31), "tribe tails", "venmo.com/u/tribetails", "tribe!")) {
            assertEquals(sentence, venmoHandleProblem(bad), bad)
        }
    }

    @Test
    fun paypalHandles() {
        assertNull(paypalHandleProblem(""))
        assertNull(paypalHandleProblem("tribetails"))
        assertNull(paypalHandleProblem("@TribeTails2"))
        val sentence = "Enter the PayPal.Me name: up to 20 letters and numbers."
        for (bad in listOf("paypal.me/tribetails", "tribe_tails", "x".repeat(21), "tribe tails")) {
            assertEquals(sentence, paypalHandleProblem(bad), bad)
        }
    }

    @Test
    fun cashtags() {
        assertNull(cashappHandleProblem(""))
        assertNull(cashappHandleProblem("\$tribetails"))
        assertNull(cashappHandleProblem("tribe_tails1"))
        val sentence = "Enter the \$Cashtag: up to 20 letters, numbers or _, with at least one letter."
        for (bad in listOf("\$12345", "1234", "\$" + "x".repeat(21), "tribe-tails", "\$\$tt", "cash.app/tt")) {
            assertEquals(sentence, cashappHandleProblem(bad), bad)
        }
    }

    @Test
    fun theHandleFieldsUseTheirOwnRule() {
        assertNull(PaymentHandleField.PAYPAL.problem(PaymentHandleField.PAYPAL.placeholder), "the placeholder is a legal handle")
        assertNull(PaymentHandleField.VENMO.problem(PaymentHandleField.VENMO.placeholder))
        assertNull(PaymentHandleField.CASHAPP.problem(PaymentHandleField.CASHAPP.placeholder))
        assertEquals(paypalHandleProblem("a.b"), PaymentHandleField.PAYPAL.problem("a.b"))
    }

    // ── MyTribe home limit ───────────────────────────────────────────────────

    @Test
    fun aHomeLimitIsBlankOrAWholeNumberFromZero() {
        assertEquals(0, homeLimitValue(""))
        assertEquals(0, homeLimitValue("0"))
        assertEquals(5, homeLimitValue(" 5 "))
        assertEquals(1000, homeLimitValue("1000"))
        assertEquals(5000, homeLimitValue("5000"))
        assertNull(homeLimitProblem("12"))
        for (bad in listOf("-3", "abc", "1.5", "5 items")) {
            assertNull(homeLimitValue(bad), bad)
            assertEquals("Enter a limit of 0 or more, as a whole number. 0 shows everything.", homeLimitProblem(bad), bad)
        }
    }
}
