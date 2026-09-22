package com.kinfolk.portal.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #905: the portal app parses Firebase email action links the way the web page
 * does (`mytribe/web/src/lib/emailAction.ts`, PR #903).
 *
 * The cases here are the link shapes PR #903's table lists, plus the host and
 * path this issue is about: every real link is on `kinfolk.tribetails.com`, and
 * the manifest used to claim `tribetails.com`, so no link could reach the app.
 */
class EmailActionLinkTest {

    private val base = "https://kinfolk.tribetails.com/account/secure-reset"

    @Test
    fun nativeResetLinkParses() {
        val p = parseEmailActionUrl("$base?mode=resetPassword&oobCode=abc123&apiKey=k&lang=en")
        assertEquals("abc123", p?.oobCode)
        assertEquals("resetPassword", p?.mode)
        assertNull(p?.continueUrl)
    }

    /** #903 routed the page at /account/action too, and the manifest claims both. */
    @Test
    fun theActionPathParsesTheSameWay() {
        val p = parseEmailActionUrl("https://kinfolk.tribetails.com/account/action?mode=verifyEmail&oobCode=v1")
        assertEquals("v1", p?.oobCode)
        assertEquals("verifyEmail", p?.mode)
    }

    /** The defect this issue names: the manifest claimed a host no link uses. */
    @Test
    fun theOldManifestHostIsNotAnActionLink() {
        assertNull(parseEmailActionUrl("https://tribetails.com/account/secure-reset?oobCode=abc"))
    }

    @Test
    fun anotherPathOnTheRightHostIsNotAnActionLink() {
        assertNull(parseEmailActionUrl("https://kinfolk.tribetails.com/claim?invite=i1"))
    }

    @Test
    fun httpIsRefused() {
        assertNull(parseEmailActionUrl("http://kinfolk.tribetails.com/account/action?oobCode=abc"))
    }

    /** The legacy shape: a bare code with no mode is a reset. */
    @Test
    fun aBareCodeIsAReset() {
        val p = parseEmailActionUrl("$base?oobCode=bare1")
        assertEquals("bare1", p?.oobCode)
        assertEquals("resetPassword", p?.mode)
    }

    /**
     * The stale doc URL. It is an action link with no code, so the screen says
     * "This link is incomplete." rather than dropping the reader on sign-in.
     */
    @Test
    fun anActionLinkWithNoCodeKeepsABlankCode() {
        val p = parseEmailActionUrl("$base?source=unauthorized_attempt&email=pat%40household.test")
        assertEquals("", p?.oobCode)
    }

    /**
     * No Firebase link carries an email, and one that did would not be trusted:
     * an `email` param changes nothing about what comes out of the parser.
     */
    @Test
    fun anEmailParamChangesNothing() {
        assertEquals(
            parseEmailActionUrl("$base?oobCode=abc"),
            parseEmailActionUrl("$base?oobCode=abc&email=attacker%40evil.test"),
        )
    }

    @Test
    fun aTrailingSlashStillMatches() {
        assertEquals("s1", parseEmailActionUrl("$base/?oobCode=s1")?.oobCode)
    }

    @Test
    fun theFragmentIsDropped() {
        assertEquals("f1", parseEmailActionUrl("$base?oobCode=f1#/somewhere")?.oobCode)
    }

    @Test
    fun theHostIsComparedWithoutCase() {
        assertEquals("c1", parseEmailActionUrl("https://Kinfolk.TribeTails.com/account/action?oobCode=c1")?.oobCode)
    }

    // ── continueUrl ──────────────────────────────────────────────────────────

    @Test
    fun anAdminContinueUrlSurvives() {
        val p = parseEmailActionUrl(
            "$base?mode=resetPassword&oobCode=a1&continueUrl=https%3A%2F%2Fauntie.tribetails.com%2Fsignin",
        )
        assertEquals("https://auntie.tribetails.com/signin", p?.continueUrl)
        assertEquals(EmailActionAudience.Staff, audienceOf(p?.continueUrl))
    }

    @Test
    fun aPortalContinueUrlSurvives() {
        val p = parseEmailActionUrl(
            "$base?oobCode=a1&continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Fsignin",
        )
        assertEquals("https://kinfolk.tribetails.com/signin", p?.continueUrl)
        assertEquals(EmailActionAudience.Kinfolk, audienceOf(p?.continueUrl))
    }

    /**
     * The `requestPasswordReset` shape. Its continue target is this very page,
     * so following it would loop; it becomes that host's sign-in instead, and
     * the email it carries is dropped with the rest of the query.
     */
    @Test
    fun aContinueUrlBackToThisPageBecomesSignIn() {
        val p = parseEmailActionUrl(
            "$base?oobCode=a1&continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Faccount%2Fsecure-reset" +
                "%3Femail%3Dpat%2540household.test",
        )
        assertEquals("https://kinfolk.tribetails.com/signin", p?.continueUrl)
    }

    @Test
    fun anOffSiteContinueUrlIsDropped() {
        assertNull(safeContinueUrl("https://evil.test/steal"))
        assertNull(safeContinueUrl("https://kinfolk.tribetails.com.evil.test/steal"))
        assertNull(safeContinueUrl("http://kinfolk.tribetails.com/signin"))
        assertNull(safeContinueUrl("javascript:alert(1)"))
        assertNull(safeContinueUrl(null))
        assertNull(safeContinueUrl("   "))
    }

    @Test
    fun aLinkWithNoContinueUrlNamesNoAudience() {
        assertEquals(EmailActionAudience.Unknown, audienceOf(null))
    }

    // ── The web URL a desktop reader is sent to ──────────────────────────────

    @Test
    fun theWebUrlCarriesModeCodeAndContinueTarget() {
        val link = parseEmailActionUrl(
            "$base?mode=resetPassword&oobCode=a+b%26c&continueUrl=https%3A%2F%2Fauntie.tribetails.com%2Fsignin",
        )!!
        assertEquals(
            "https://kinfolk.tribetails.com/account/action" +
                "?mode=resetPassword&oobCode=a%20b%26c" +
                "&continueUrl=https%3A%2F%2Fauntie.tribetails.com%2Fsignin",
            webActionUrl(link),
        )
    }

    @Test
    fun theWebUrlOfABareLinkStaysBare() {
        val link = parseEmailActionUrl("$base?oobCode=plain")!!
        assertEquals(
            "https://kinfolk.tribetails.com/account/action?mode=resetPassword&oobCode=plain",
            webActionUrl(link),
        )
    }

    // ── Error codes ─────────────────────────────────────────────────────────

    /**
     * Android's native codes, the web SDK's and Identity Toolkit REST's all have
     * to land on the same reader-facing answer, because all three backends serve
     * this one screen.
     */
    @Test
    fun everyPlatformsExpiredCodeIsExpired() {
        for (code in listOf("ERROR_EXPIRED_ACTION_CODE", "auth/expired-action-code", "EXPIRED_OOB_CODE")) {
            assertEquals(CodeProblem.Expired, codeProblemOf(code), code)
        }
    }

    @Test
    fun everyPlatformsUsedOrGarbledCodeIsInvalid() {
        for (code in listOf(
            "ERROR_INVALID_ACTION_CODE", "auth/invalid-action-code", "INVALID_OOB_CODE",
            "ERROR_USER_DISABLED", "auth/user-disabled", "USER_DISABLED",
            "ERROR_USER_NOT_FOUND", "auth/user-not-found", "EMAIL_NOT_FOUND",
        )) {
            assertEquals(CodeProblem.Invalid, codeProblemOf(code), code)
        }
    }

    /** A weak password is not a problem with the code, so it must not blank the form. */
    @Test
    fun aWeakPasswordIsNotACodeProblem() {
        assertNull(codeProblemOf("auth/weak-password"))
        assertNull(codeProblemOf(null))
        for (code in listOf("ERROR_WEAK_PASSWORD", "auth/weak-password", "WEAK_PASSWORD : short")) {
            assertEquals(true, isWeakPasswordCode(code), code)
        }
        assertEquals(false, isWeakPasswordCode("INVALID_OOB_CODE"))
    }
}
