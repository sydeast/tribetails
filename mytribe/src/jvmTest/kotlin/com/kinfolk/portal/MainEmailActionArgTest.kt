package com.kinfolk.portal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #905: desktop lands on the same email action page and the same contract as
 * web and Android.
 *
 * Desktop has no link handler, so the link arrives as an argument. The old
 * parsing required BOTH `--secure-reset-oob=` and `--secure-reset-email=`, and
 * dropped the link entirely when the address was missing, which is every real
 * Firebase link. It also carried that address into the screen as the account,
 * which is exactly what PR #903 stopped trusting.
 */
class MainEmailActionArgTest {

    @Test
    fun aWholeLinkParsesIntoModeCodeAndContinueTarget() {
        val p = emailActionArg(
            arrayOf(
                "--email-link=https://kinfolk.tribetails.com/account/action" +
                    "?mode=resetPassword&oobCode=abc123" +
                    "&continueUrl=https%3A%2F%2Fauntie.tribetails.com%2Fsignin",
            ),
        )
        assertEquals("abc123", p?.oobCode)
        assertEquals("resetPassword", p?.mode)
        assertEquals("https://auntie.tribetails.com/signin", p?.continueUrl)
    }

    @Test
    fun aVerifyLinkKeepsItsMode() {
        val p = emailActionArg(
            arrayOf("--email-link=https://kinfolk.tribetails.com/account/secure-reset?mode=verifyEmail&oobCode=v1"),
        )
        assertEquals("verifyEmail", p?.mode)
    }

    /** A link on some other host is not an email action link, and is not guessed at. */
    @Test
    fun aLinkThatIsNotAnActionLinkIsRefused() {
        assertNull(emailActionArg(arrayOf("--email-link=https://evil.test/account/action?oobCode=abc")))
    }

    /** The older argument still works, and no longer needs an address beside it. */
    @Test
    fun theOldCodeArgumentWorksWithNoAddress() {
        val p = emailActionArg(arrayOf("--secure-reset-oob=abc123"))
        assertEquals("abc123", p?.oobCode)
        assertEquals("resetPassword", p?.mode)
    }

    /** An address passed beside it is ignored; the account comes from the code. */
    @Test
    fun anAddressArgumentIsIgnored() {
        assertEquals(
            emailActionArg(arrayOf("--secure-reset-oob=abc123")),
            emailActionArg(arrayOf("--secure-reset-oob=abc123", "--secure-reset-email=attacker@evil.test")),
        )
    }

    @Test
    fun theWholeLinkWinsOverTheOlderArgument() {
        val p = emailActionArg(
            arrayOf(
                "--secure-reset-oob=old",
                "--email-link=https://kinfolk.tribetails.com/account/action?oobCode=new",
            ),
        )
        assertEquals("new", p?.oobCode)
    }

    @Test
    fun nothingPassedIsNothingRead() {
        assertNull(emailActionArg(arrayOf("--claim=i1")))
        assertNull(emailActionArg(arrayOf("--email-link=")))
        assertNull(emailActionArg(emptyArray()))
    }
}
