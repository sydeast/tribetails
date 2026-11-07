package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #1593: Add secondary kinfolk refuses a bad phone or email before the round trip. */
class SecondaryKinfolkCheckTest {
    @Test
    fun aNameAloneIsFine() {
        assertNull(secondaryKinfolkDraftError("Rae Park", "", ""))
    }

    @Test
    fun aBadPhoneOrEmailIsRefusedAtOnce() {
        assertEquals(SECONDARY_PHONE_INVALID, secondaryKinfolkDraftError("Rae Park", "12345", ""))
        assertEquals(SECONDARY_EMAIL_INVALID, secondaryKinfolkDraftError("Rae Park", "", "rae@"))
        assertEquals(SECONDARY_PHONE_INVALID, secondaryKinfolkDraftError("Rae Park", "call me", "rae@"))
    }

    @Test
    fun aMissingNameComesFirst() {
        assertEquals(MembersRepository.SECONDARY_KINFOLK_NAME_REQUIRED, secondaryKinfolkDraftError(" ", "12345", "rae@"))
    }

    @Test
    fun aRealPhoneAndEmailPass() {
        assertNull(secondaryKinfolkDraftError("Rae Park", "(512) 555-0142", "catch@hanasamku.com"))
    }
}
