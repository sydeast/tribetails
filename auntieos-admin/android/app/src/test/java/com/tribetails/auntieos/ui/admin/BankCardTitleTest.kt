package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/** #1887: a Template Bank card is titled in words, never with its stored key. */
class BankCardTitleTest {
    @Test fun aTitleThatIsTheStoredKeyReadsAsWords() {
        assertEquals("Account welcome kinfolk", bankCardTitle("account.welcome.kinfolk", "account.welcome.kinfolk"))
        assertEquals("Auth password reset", bankCardTitle("", "auth.password.reset"))
    }

    @Test fun aRealTitleStays() {
        assertEquals("Welcome to MyTribe", bankCardTitle("Welcome to MyTribe", "account.welcome.kinfolk"))
    }
}
