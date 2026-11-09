package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** #1593: Add secondary kinfolk refuses a bad phone or email before the round trip (desktop). */
class SecondaryKinfolkCheckTest {
    private fun d(name: String = "Rae Park", phone: String = "", email: String = "") =
        SecondaryPersonDraft(name = name, phone = phone, email = email)

    @Test
    fun aNameAloneIsFine() {
        assertNull(secondaryKinfolkDraftError(d()))
    }

    @Test
    fun aBadPhoneOrEmailIsRefusedAtOnce() {
        assertEquals(SECONDARY_PHONE_INVALID, secondaryKinfolkDraftError(d(phone = "12345")))
        assertEquals(SECONDARY_EMAIL_INVALID, secondaryKinfolkDraftError(d(email = "rae@")))
    }

    @Test
    fun aMissingNameComesFirst() {
        assertEquals(SECONDARY_KINFOLK_NAME_REQUIRED, secondaryKinfolkDraftError(d(name = " ", phone = "12345")))
    }

    @Test
    fun aRealPhoneAndEmailPass() {
        assertNull(secondaryKinfolkDraftError(d(phone = "(512) 555-0142", email = "catch@hanasamku.com")))
    }

    @Test
    fun eachFieldCarriesItsOwnRefusal() {
        val errs = secondaryKinfolkFieldErrors(d(name = " ", phone = "12345", email = "rae@"))
        assertEquals(SECONDARY_KINFOLK_NAME_REQUIRED, errs.name)
        assertEquals(SECONDARY_PHONE_INVALID, errs.phone)
        assertEquals(SECONDARY_EMAIL_INVALID, errs.email)
        assertEquals(SecondaryKinfolkFieldErrors(), secondaryKinfolkFieldErrors(d()))
    }
    @Test
    fun aDoubledDotIsRefusedAsTheServerRefusesIt() {
        assertEquals(SECONDARY_EMAIL_INVALID, secondaryKinfolkFieldErrors(d(email = "rae..park@example.com")).email)
    }
    @Test
    fun aServerSentenceMapsToItsField() {
        assertEquals(SECONDARY_PHONE_INVALID, secondaryKinfolkServerFieldErrors(SECONDARY_PHONE_INVALID)?.phone)
        assertEquals(SECONDARY_EMAIL_INVALID, secondaryKinfolkServerFieldErrors(SECONDARY_EMAIL_INVALID)?.email)
        assertNull(secondaryKinfolkServerFieldErrors("That is the primary kinfolk."))
    }
}
