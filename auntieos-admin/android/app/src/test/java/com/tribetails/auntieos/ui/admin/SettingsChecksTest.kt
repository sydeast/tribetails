package com.tribetails.auntieos.ui.admin

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.PaymentHandleField
import com.tribetails.auntieos.data.model.paymentDraftOf
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/**
 * #1593: every Settings field rule, against the server's
 * (`mytribe/functions/src/lib/businessSettingsChecks.ts`) and in the server's
 * words. Happy, sad and edge for each: blank, whitespace, negative, letters,
 * and both sides of every boundary.
 */
class SettingsChecksTest {

    // ── Sentences: word for word the server's ──────────────────────────────

    @Test
    fun `the shared sentences are the server's`() {
        assertEquals("Enter an email like name@example.com, or leave it blank.", EMAIL_INVALID)
        assertEquals("Enter a 10-digit phone number, or leave it blank.", PHONE_INVALID)
        assertEquals("Enter a real date as YYYY-MM-DD.", DATE_INVALID)
        assertEquals("That date has passed. Pick today or a later date.", DATE_PAST)
        assertEquals("Enter both an opening and a closing time.", HOURS_RANGE_INVALID)
        assertEquals("The closing time has to be after the opening time.", HOURS_CLOSE_BEFORE_OPEN)
        assertEquals("Every KinCare type needs a name.", KINCARE_NAME_REQUIRED)
        assertEquals("Give the closure a name.", CLOSURE_NAME_REQUIRED)
        assertEquals("Enter a limit of 0 or more, as a whole number. 0 shows everything.", HOME_LIMIT_INVALID)
    }

    // ── Business profile ───────────────────────────────────────────────────

    @Test
    fun `email may be blank, and anything typed has to be an email`() {
        assertNull(businessEmailProblem(""))
        assertNull(businessEmailProblem("   "))
        assertNull(businessEmailProblem("hello@tribetails.com"))
        assertNull(businessEmailProblem("  hello@tribetails.com  "))
        assertEquals(EMAIL_INVALID, businessEmailProblem("hello"))
        assertEquals(EMAIL_INVALID, businessEmailProblem("hello@tribetails"))
        assertEquals(EMAIL_INVALID, businessEmailProblem("a..b@tribetails.com"))
        assertEquals(EMAIL_INVALID, businessEmailProblem("a@tribetails..com"))
        assertEquals(EMAIL_INVALID, businessEmailProblem("a b@tribetails.com"))
        assertEquals(EMAIL_INVALID, businessEmailProblem("a".repeat(250) + "@x.com"))
    }

    @Test
    fun `phone may be blank, and anything typed has to be a US number`() {
        assertNull(businessPhoneProblem(""))
        assertNull(businessPhoneProblem("  "))
        assertNull(businessPhoneProblem("(512) 555-0100"))
        assertNull(businessPhoneProblem("512.555.0100"))
        assertNull(businessPhoneProblem("+1 512 555 0100"))
        assertEquals(PHONE_INVALID, businessPhoneProblem("512-555-010"))
        assertEquals(PHONE_INVALID, businessPhoneProblem("2 512 555 0100"))
        assertEquals(PHONE_INVALID, businessPhoneProblem("512-555-01OO"))
        assertEquals(PHONE_INVALID, businessPhoneProblem("call me"))
    }

    // ── Dates ──────────────────────────────────────────────────────────────

    @Test
    fun `a real date is one the calendar has`() {
        assertTrue(isRealDate("2026-11-09"))
        assertTrue(isRealDate("2028-02-29"))
        assertFalse(isRealDate("2026-02-29"))
        assertFalse(isRealDate("2026-02-30"))
        assertFalse(isRealDate("2026-13-45"))
        assertFalse(isRealDate("2026-00-10"))
        assertFalse(isRealDate("2026-01-00"))
        assertFalse(isRealDate("2026-1-9"))
        assertFalse(isRealDate(" 2026-11-09"))
        assertFalse(isRealDate(""))
    }

    @Test
    fun `a new date is real and not before today`() {
        val today = "2026-11-09"
        assertNull(newDateProblem("2026-11-09", today))
        assertNull(newDateProblem("2027-01-01", today))
        assertEquals(DATE_PAST, newDateProblem("2026-11-08", today))
        assertEquals(DATE_INVALID, newDateProblem("2026-13-45", today))
        assertEquals(DATE_INVALID, newDateProblem("abc", today))
    }

    @Test
    fun `today is read in the business's zone, not the phone's`() {
        // 03:30 UTC on Nov 10 is still Nov 9 in Chicago.
        val clock = Clock.fixed(Instant.parse("2026-11-10T03:30:00Z"), ZoneOffset.UTC)
        assertEquals("2026-11-09", businessTodayIso("America/Chicago", clock))
        assertEquals("2026-11-10", businessTodayIso("Europe/London", clock))
        // Blank falls back to the default zone, the server's fallback.
        assertEquals("2026-11-09", businessTodayIso("", clock))
    }

    // ── Hours ──────────────────────────────────────────────────────────────

    @Test
    fun `hours read as HH-MM, closing after opening`() {
        assertNull(hoursRangeProblem("09:00-17:00"))
        assertNull(hoursRangeProblem("9:00-17:00"))
        assertNull(hoursRangeProblem("00:00-23:59"))
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, hoursRangeProblem("17:00-09:00"))
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, hoursRangeProblem("09:00-09:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem("zz-99"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem("24:00-25:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem("09:60-17:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem("09:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem("09:00-12:00-17:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursRangeProblem(""))
    }

    @Test
    fun `two typed times take the same rule`() {
        assertNull(hoursPairProblem("09:00", "17:00"))
        assertNull(hoursPairProblem(" 9:00 ", "17:00"))
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, hoursPairProblem("17:00", "09:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursPairProblem("", "17:00"))
        assertEquals(HOURS_RANGE_INVALID, hoursPairProblem("09:00", ""))
        assertEquals(HOURS_RANGE_INVALID, hoursPairProblem("9am", "5pm"))
        assertEquals(HOURS_RANGE_INVALID, hoursPairProblem("09:00-10:00", "17:00"))
    }

    // ── KinCare types ──────────────────────────────────────────────────────

    @Test
    fun `a price is blank, or dollars with at most two decimals`() {
        assertNull(priceProblem("Walk", ""))
        assertNull(priceProblem("Walk", "   "))
        assertNull(priceProblem("Walk", "0"))
        assertNull(priceProblem("Walk", "25"))
        assertNull(priceProblem("Walk", "25.5"))
        assertNull(priceProblem("Walk", "25.50"))
        assertNull(priceProblem("Walk", "9999999.99"))
        assertEquals("The price for \"Walk\" cannot be negative.", priceProblem("Walk", "-5"))
        val sentence = "Enter the price for \"Walk\" in dollars, like 25 or 25.50."
        assertEquals(sentence, priceProblem("Walk", "abc"))
        assertEquals(sentence, priceProblem("Walk", "1.234"))
        assertEquals(sentence, priceProblem("Walk", "\$25"))
        assertEquals(sentence, priceProblem("Walk", "25."))
        assertEquals(sentence, priceProblem("Walk", "10000000"))
    }

    @Test
    fun `a length is blank, or whole minutes from 1 to 1440`() {
        assertNull(durationProblem("Walk", ""))
        assertNull(durationProblem("Walk", " "))
        assertNull(durationProblem("Walk", "1"))
        assertNull(durationProblem("Walk", "1440"))
        val sentence = "Enter the length of \"Walk\" in whole minutes, from 1 to 1440."
        assertEquals(sentence, durationProblem("Walk", "0"))
        assertEquals(sentence, durationProblem("Walk", "1441"))
        assertEquals(sentence, durationProblem("Walk", "-30"))
        assertEquals(sentence, durationProblem("Walk", "30.5"))
        assertEquals(sentence, durationProblem("Walk", "thirty"))
        assertEquals(sentence, durationProblem("Walk", "99999999999"))
    }

    @Test
    fun `a stored row cleared to blank is an error, an abandoned add is not`() {
        val rows = listOf(
            KinCareTypeRow("", "", "25", existing = true),
            KinCareTypeRow.BLANK,
        )
        val problems = kinCareRowProblems(rows)
        assertEquals(KINCARE_NAME_REQUIRED, problems[0]?.name)
        assertFalse(problems.containsKey(1))
    }

    @Test
    fun `an added row with a price but no name is an error`() {
        assertEquals(KINCARE_NAME_REQUIRED, kinCareRowProblems(listOf(KinCareTypeRow("  ", "", "25")))[0]?.name)
    }

    @Test
    fun `two rows with the same name, trimmed and in any case, are refused on the second`() {
        val problems = kinCareRowProblems(
            listOf(KinCareTypeRow("Walk", "", "10"), KinCareTypeRow(" walk ", "", "12")),
        )
        assertNull(problems[0])
        assertEquals("Two KinCare types are both called \"walk\".", problems[1]?.name)
    }

    @Test
    fun `each field of a row carries its own sentence`() {
        val problems = kinCareRowProblems(listOf(KinCareTypeRow("Walk", "0", "abc")))[0]!!
        assertNull(problems.name)
        assertEquals("Enter the length of \"Walk\" in whole minutes, from 1 to 1440.", problems.duration)
        assertEquals("Enter the price for \"Walk\" in dollars, like 25 or 25.50.", problems.rate)
    }

    @Test
    fun `a clean rate card has no problems`() {
        val rows = kinCareRows(mapOf("Walk" to "10.00", "Overnight" to ""), mapOf("Walk" to "30"))
        assertTrue(kinCareRowProblems(rows).isEmpty())
        assertNull(kinCareCountProblem(rows))
    }

    @Test
    fun `a long name and a long card are refused`() {
        val long = "x".repeat(81)
        assertEquals(
            "Keep the name \"${"x".repeat(20)}...\" under 80 characters.",
            kinCareRowProblems(listOf(KinCareTypeRow(long, "", "")))[0]?.name,
        )
        assertNull(kinCareRowProblems(listOf(KinCareTypeRow("x".repeat(80), "", "")))[0])
        val many = (1..101).map { KinCareTypeRow("Type $it", "", "") }
        assertEquals("That is more than 100 KinCare types.", kinCareCountProblem(many))
        assertNull(kinCareCountProblem(many.take(100)))
    }

    // ── Payments ───────────────────────────────────────────────────────────

    @Test
    fun `venmo is 5 to 30 letters, numbers, dash or underscore, an @ allowed`() {
        assertNull(venmoHandleProblem(""))
        assertNull(venmoHandleProblem("  "))
        assertNull(venmoHandleProblem("tribe"))
        assertNull(venmoHandleProblem("@tribe-tails_01"))
        assertNull(venmoHandleProblem("a".repeat(30)))
        val sentence = "Enter the Venmo username: 5 to 30 letters, numbers, - or _."
        assertEquals(sentence, venmoHandleProblem("tri"))
        assertEquals(sentence, venmoHandleProblem("a".repeat(31)))
        assertEquals(sentence, venmoHandleProblem("tribe tails"))
        assertEquals(sentence, venmoHandleProblem("@@tribe"))
    }

    @Test
    fun `paypal is up to 20 letters and numbers, an @ allowed`() {
        assertNull(paypalHandleProblem(""))
        assertNull(paypalHandleProblem("tribetails"))
        assertNull(paypalHandleProblem("@TribeTails1"))
        assertNull(paypalHandleProblem("a".repeat(20)))
        val sentence = "Enter the PayPal.Me name: up to 20 letters and numbers."
        assertEquals(sentence, paypalHandleProblem("a".repeat(21)))
        assertEquals(sentence, paypalHandleProblem("tribe-tails"))
        assertEquals(sentence, paypalHandleProblem("paypal.me/tribetails"))
    }

    @Test
    fun `a cashtag is up to 20 letters, numbers or underscore with one letter, the dollar optional`() {
        assertNull(cashappHandleProblem(""))
        assertNull(cashappHandleProblem("\$tribetails"))
        assertNull(cashappHandleProblem("tribe_tails"))
        assertNull(cashappHandleProblem("\$a1"))
        val sentence = "Enter the \$Cashtag: up to 20 letters, numbers or _, with at least one letter."
        assertEquals(sentence, cashappHandleProblem("\$12345"))
        assertEquals(sentence, cashappHandleProblem("a".repeat(21)))
        assertEquals(sentence, cashappHandleProblem("@tribe"))
        assertEquals(sentence, cashappHandleProblem("tribe tails"))
    }

    @Test
    fun `a handle counts while its box is on screen, or when it was changed`() {
        val saved = paymentDraftOf(BusinessSettings(venmoHandle = "bad handle!", cashappHandle = "\$ok"))
        // Venmo is on by default, so its stored bad handle is on screen and flagged.
        assertEquals(
            setOf(PaymentHandleField.VENMO),
            paymentHandleProblems(saved, saved).keys,
        )
        // Switched off and unchanged: not sent, not flagged.
        val venmoOff = saved.copy(options = saved.options + ("venmo" to saved.options.getValue("venmo").copy(enabled = false)))
        assertTrue(paymentHandleProblems(venmoOff, saved).isEmpty())
        // Switched off and changed to something bad: sent, so flagged.
        val cashOffChanged = saved.copy(
            options = venmoOff.options + ("cashapp" to saved.options.getValue("cashapp").copy(enabled = false)),
            handles = saved.handles + (PaymentHandleField.CASHAPP to "\$123"),
        )
        assertEquals(setOf(PaymentHandleField.CASHAPP), paymentHandleProblems(cashOffChanged, saved).keys)
    }

    @Test
    fun `only a changed bad handle holds Save, since an unchanged one is not sent`() {
        val saved = paymentDraftOf(BusinessSettings(venmoHandle = "bad handle!"))
        assertFalse(paymentHandlesBlockSave(saved, saved))
        val badPaypal = saved.copy(handles = saved.handles + (PaymentHandleField.PAYPAL to "paypal.me/x"))
        assertTrue(paymentHandlesBlockSave(badPaypal, saved))
        val goodVenmo = saved.copy(handles = saved.handles + (PaymentHandleField.VENMO to "tribe-tails"))
        assertFalse(paymentHandlesBlockSave(goodVenmo, saved))
        // Whitespace around an unchanged handle is not a change.
        val padded = saved.copy(handles = saved.handles + (PaymentHandleField.VENMO to " bad handle! "))
        assertFalse(paymentHandlesBlockSave(padded, saved))
    }

    // ── Numbers ────────────────────────────────────────────────────────────

    @Test
    fun `a whole number in range, in the server's words`() {
        assertNull(wholeNumberProblem("10", 10, 5000, "metres"))
        assertNull(wholeNumberProblem(" 5000 ", 10, 5000, "metres"))
        assertNull(wholeNumberProblem("0", 0, 480, "minutes"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("9", 10, 5000, "metres"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("5001", 10, 5000, "metres"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("", 10, 5000, "metres"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("-20", 10, 5000, "metres"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("1.5", 10, 5000, "metres"))
        assertEquals("Enter 10 to 5000 metres.", wholeNumberProblem("abc", 10, 5000, "metres"))
        assertEquals("Enter 1 to 24 hours.", wholeNumberProblem("25", 1, 24, "hours"))
    }

    @Test
    fun `an option list, in the server's words and order`() {
        assertNull(optionListProblem("5, 10, 15", "minutes"))
        assertNull(optionListProblem("5,10,,15,", "minutes"))
        assertEquals("List at least one option, in minutes.", optionListProblem("", "minutes"))
        assertEquals("List at least one option, in days.", optionListProblem(" , ", "days"))
        assertEquals(
            "That is more than 12 options. Trim the list.",
            optionListProblem((1..13).joinToString(","), "minutes"),
        )
        assertNull(optionListProblem((1..12).joinToString(","), "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, 0", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, -10", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, ten", "minutes"))
        assertEquals("Every option has to be a whole number above zero.", optionListProblem("5, 7.5", "minutes"))
        assertEquals("10 is listed twice.", optionListProblem("5, 10, 10", "minutes"))
    }

    @Test
    fun `a home limit is a whole number of 0 or more`() {
        assertNull(homeLimitProblem("0"))
        assertNull(homeLimitProblem("3"))
        assertNull(homeLimitProblem(" 12 "))
        assertNull(homeLimitProblem("1000"))
        assertNull(homeLimitProblem("1001"))
        assertEquals(HOME_LIMIT_INVALID, homeLimitProblem("-3"))
        assertEquals(HOME_LIMIT_INVALID, homeLimitProblem("abc"))
        assertEquals(HOME_LIMIT_INVALID, homeLimitProblem("1.5"))
        assertEquals(HOME_LIMIT_INVALID, homeLimitProblem(""))
    }

    // ── Time off ───────────────────────────────────────────────────────────

    @Test
    fun `a one-off closure needs a name and a real date that has not passed`() {
        val today = "2026-11-09"
        assertFalse(closureAddProblems(ClosureRecurrenceKind.ONCE, "Inventory", "2026-12-01", today).any)
        assertEquals(CLOSURE_NAME_REQUIRED, closureAddProblems(ClosureRecurrenceKind.ONCE, " ", "2026-12-01", today).name)
        assertEquals("A name cannot contain |.", closureAddProblems(ClosureRecurrenceKind.ONCE, "Shut|down", "2026-12-01", today).name)
        assertEquals(DATE_INVALID, closureAddProblems(ClosureRecurrenceKind.ONCE, "Inventory", "2026-13-45", today).date)
        assertEquals(DATE_INVALID, closureAddProblems(ClosureRecurrenceKind.ONCE, "Inventory", "2026-02-30", today).date)
        assertEquals(DATE_INVALID, closureAddProblems(ClosureRecurrenceKind.ONCE, "Inventory", "", today).date)
        assertEquals(DATE_PAST, closureAddProblems(ClosureRecurrenceKind.ONCE, "Inventory", "2026-11-01", today).date)
    }

    @Test
    fun `a yearly closure has no typed date to check`() {
        val problems = closureAddProblems(ClosureRecurrenceKind.YEARLY_FIXED, "July 4", "", "2026-11-09")
        assertNull(problems.date)
        assertFalse(problems.any)
        assertEquals(
            CLOSURE_NAME_REQUIRED,
            closureAddProblems(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, "", "", "2026-11-09").name,
        )
    }

    // ── Server refusals ────────────────────────────────────────────────────

    private fun refusal(details: Any?, message: String = "The server sentence."): FirebaseFunctionsException {
        val e = mockk<FirebaseFunctionsException>()
        every { e.details } returns details
        every { e.message } returns message
        return e
    }

    @Test
    fun `a settings refusal is read off the details`() {
        val e = refusal(
            mapOf(
                "code" to "settings_refused",
                "field" to "businessHours",
                "refusals" to listOf(
                    mapOf("field" to "businessHours", "message" to "Mon: $HOURS_CLOSE_BEFORE_OPEN"),
                    mapOf("field" to "businessEmail", "message" to EMAIL_INVALID),
                ),
            ),
            message = "Mon: $HOURS_CLOSE_BEFORE_OPEN",
        )
        assertEquals(SettingsRefusal("businessHours", "Mon: $HOURS_CLOSE_BEFORE_OPEN"), settingsRefusalOf(e))
        assertEquals("Mon: $HOURS_CLOSE_BEFORE_OPEN", settingsSaveFailureText("Failed to save settings", e))
    }

    @Test
    fun `any other failure keeps the screen's own lead-in`() {
        assertNull(settingsRefusalOf(refusal(mapOf("code" to "something_else", "field" to "x"))))
        assertNull(settingsRefusalOf(refusal(null)))
        assertNull(settingsRefusalOf(IllegalStateException("offline")))
        assertNull(settingsRefusalOf(null))
        assertEquals(
            "Failed to save settings: offline",
            settingsSaveFailureText("Failed to save settings", IllegalStateException("offline")),
        )
    }

    @Test
    fun `a refusal with no list falls back to the exception's message`() {
        val e = refusal(mapOf("code" to "settings_refused", "field" to "serviceRates"), message = KINCARE_NAME_REQUIRED)
        assertEquals(SettingsRefusal("serviceRates", KINCARE_NAME_REQUIRED), settingsRefusalOf(e))
    }

    // ── A stored bad value (#1783) ─────────────────────────────────────────
    @Test
    fun `a stored bad value holds Save back only once its field is edited`() {
        // Untouched: the sentence shows (the check still returns it), Save is not held.
        assertFalse(fieldBlocksSave("not an email", "not an email", businessEmailProblem("not an email")))
        // Edited to another bad value: held.
        assertTrue(fieldBlocksSave("not an email!", "not an email", businessEmailProblem("not an email!")))
        // Edited to a good value: free.
        assertFalse(fieldBlocksSave("hello@tribetails.com", "not an email", businessEmailProblem("hello@tribetails.com")))
    }
    @Test
    fun `an untouched text box sends the stored value as it is, an edited one is trimmed`() {
        assertEquals("not an email ", editedText("not an email ", "not an email "))
        assertEquals("hello@tribetails.com", editedText(" hello@tribetails.com ", "not an email "))
    }
    private fun kinCareProblems(vararg rows: KinCareTypeRow) = kinCareRowProblems(rows.toList())
    @Test
    fun `a bad KinCare price holds Save back only when the rates changed`() {
        val bad = kinCareProblems(KinCareTypeRow("Walk", "", "abc", existing = true))
        assertTrue(bad.isNotEmpty())
        // Only the lengths changed: the rates map is not in the save.
        assertFalse(kinCareBlocksSave(bad, null, ratesChanged = false, durationsChanged = true))
        // The rates changed (any row): the whole map is checked.
        assertTrue(kinCareBlocksSave(bad, null, ratesChanged = true, durationsChanged = false))
    }
    @Test
    fun `a bad KinCare length holds Save back only when the lengths changed`() {
        val bad = kinCareProblems(KinCareTypeRow("Walk", "9999", "10", existing = true))
        assertFalse(kinCareBlocksSave(bad, null, ratesChanged = true, durationsChanged = false))
        assertTrue(kinCareBlocksSave(bad, null, ratesChanged = false, durationsChanged = true))
    }
    @Test
    fun `a KinCare name is checked in either map`() {
        val bad = kinCareProblems(KinCareTypeRow("", "30", "10", existing = true))
        assertTrue(kinCareBlocksSave(bad, null, ratesChanged = true, durationsChanged = false))
        assertTrue(kinCareBlocksSave(bad, null, ratesChanged = false, durationsChanged = true))
        assertFalse(kinCareBlocksSave(bad, null, ratesChanged = false, durationsChanged = false))
    }
    @Test
    fun `a stored Home limit below zero reads as bad unless its box holds typed text`() {
        val rows = listOf(
            com.tribetails.auntieos.data.model.PortalHomeSection("upNext", true, -2),
            com.tribetails.auntieos.data.model.PortalHomeSection("tales", true, 5),
        )
        assertEquals(mapOf("upNext" to HOME_LIMIT_INVALID), storedHomeLimitProblems(rows, emptySet()))
        assertEquals(emptyMap<String, String>(), storedHomeLimitProblems(rows, setOf("upNext")))
    }
}
