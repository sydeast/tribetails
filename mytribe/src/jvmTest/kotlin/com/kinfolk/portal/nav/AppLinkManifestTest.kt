package com.kinfolk.portal.nav

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * #905: the portal Android app's App Link for Firebase email action links has
 * to claim `kinfolk.tribetails.com`, the host every real link uses.
 *
 * It claimed `tribetails.com`, so no reset, verification or email-change link
 * could ever open the app's handler. Nothing in Kotlin could catch that: the
 * host lives in an XML attribute, and the parser has no idea what the manifest
 * says. So this reads the manifest, the way `AppCheckWiringTest` reads
 * `build.gradle.kts`, and fails if the two ever drift apart again.
 */
class AppLinkManifestTest {

    private fun moduleRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "src/commonTest").isDirectory && File(dir, "build.gradle.kts").isFile) {
                return dir
            }
            dir = dir.parentFile
        }
        fail("Could not find the mytribe module root from ${System.getProperty("user.dir")}")
    }

    private val manifest: String by lazy {
        val f = File(moduleRoot(), "src/androidMain/AndroidManifest.xml")
        assertTrue(f.isFile, "Expected src/androidMain/AndroidManifest.xml to exist")
        f.readText()
    }

    /** The whole `<intent-filter>` that carries the action-link paths. */
    private fun actionFilter(): String =
        Regex("<intent-filter[^>]*>(?:(?!</intent-filter>).)*?/account/secure-reset(?:(?!</intent-filter>).)*</intent-filter>", RegexOption.DOT_MATCHES_ALL)
            .find(manifest)?.value
            ?: fail("No intent-filter in the manifest claims /account/secure-reset")

    @Test
    fun theActionLinkClaimsTheHostEveryRealLinkUses() {
        val filter = actionFilter()
        assertTrue(
            filter.contains("""android:host="kinfolk.tribetails.com""""),
            "The email action filter must claim kinfolk.tribetails.com:\n$filter",
        )
    }

    /** The defect: a host no Firebase link is ever sent to. */
    @Test
    fun noIntentFilterClaimsTheBareApexHost() {
        assertTrue(
            !Regex("""android:host="tribetails\.com"""").containsMatchIn(manifest),
            "The manifest still claims the apex host, which no email link uses",
        )
    }

    /** The web page answers at both paths since PR #903, so the app claims both. */
    @Test
    fun bothActionPathsAreClaimed() {
        val filter = actionFilter()
        for (path in listOf("/account/secure-reset", "/account/action")) {
            assertTrue(
                filter.contains("""android:path="$path""""),
                "The email action filter must claim $path:\n$filter",
            )
        }
    }

    /** Without autoVerify the link opens a chooser rather than the app. */
    @Test
    fun theActionFilterAsksForVerification() {
        assertTrue(actionFilter().contains("""android:autoVerify="true""""))
    }

    /**
     * Every https App Link in this manifest is on the portal host. If a second
     * host ever appears it needs its own assetlinks.json, which is a decision,
     * not a typo.
     */
    @Test
    fun everyHttpsAppLinkIsOnThePortalHost() {
        val hosts = Regex("""android:host="([^"]+)"""").findAll(manifest)
            .map { it.groupValues[1] }
            .filter { it.contains('.') }
            .toSet()
        assertEquals(setOf("kinfolk.tribetails.com"), hosts)
    }

    // ── #2401: the address Stripe returns a card payment to ──

    private fun filters(): List<String> =
        Regex("<intent-filter[^>]*>.*?</intent-filter>", RegexOption.DOT_MATCHES_ALL).findAll(manifest).map { it.value }.toList()

    /** The one `<intent-filter>` that claims the https return address. */
    private fun checkoutReturnFilter(): String =
        filters().singleOrNull { it.contains("""android:pathPrefix="/app/invoices/"""") }
            ?: fail("Exactly one intent-filter must claim /app/invoices/")

    @Test
    fun theCheckoutReturnIsClaimedOnThePortalHostOverHttpsAndVerified() {
        val filter = checkoutReturnFilter()
        assertTrue(filter.contains("""android:scheme="https""""), filter)
        assertTrue(filter.contains("""android:host="kinfolk.tribetails.com""""), filter)
        assertTrue(filter.contains("""android:autoVerify="true""""), "Without autoVerify the phone keeps the address in the browser:\n$filter")
        assertTrue(filter.contains("android.intent.action.VIEW"), filter)
        assertTrue(filter.contains("android.intent.category.BROWSABLE"), filter)
        assertTrue(filter.contains("android.intent.category.DEFAULT"), filter)
    }

    /**
     * A filter's `<data>` parts combine: a path added here would be matched
     * against every host and scheme in the filter. So the return address has
     * a filter to itself.
     */
    @Test
    fun theCheckoutReturnFilterClaimsNothingElse() {
        val filter = checkoutReturnFilter()
        assertEquals(1, Regex("""android:(path|pathPrefix|pathPattern)=""").findAll(filter).count(), filter)
        assertEquals(1, Regex("""android:scheme=""").findAll(filter).count(), filter)
        assertEquals(1, Regex("""android:host=""").findAll(filter).count(), filter)
    }

    /**
     * The web portal's own invoice page stays the browser's. Claiming it would
     * pull the web portal's return from Stripe, and every invoice link in an
     * email, into this app for anyone who has it installed.
     */
    @Test
    fun theWebPortalsOwnInvoicePageIsNotClaimed() {
        val claimed = Regex("""android:(?:path|pathPrefix|pathPattern)="([^"]+)"""").findAll(manifest).map { it.groupValues[1] }.toList()
        assertTrue(claimed.none { it.startsWith("/invoices") }, "The manifest must not claim the web portal's /invoices pages: $claimed")
        assertTrue(claimed.none { it == "/" || it == "/app/" || it == "/app" }, "The return claim must stay as narrow as /app/invoices/: $claimed")
    }

    /** The portal's signed-out return page opens the app through this one, which needs no verification. */
    @Test
    fun theAppsOwnSchemeOpensAnInvoiceToo() {
        val own = filters().singleOrNull { it.contains("""android:scheme="mytribe"""") && it.contains("""android:host="invoices"""") }
            ?: fail("Exactly one intent-filter must claim mytribe://invoices")
        assertTrue(own.contains("android.intent.action.VIEW"), own)
        assertTrue(own.contains("android.intent.category.BROWSABLE"), "A browser can only open a BROWSABLE link:\n$own")
        assertTrue(own.contains("android.intent.category.DEFAULT"), own)
        assertTrue(!own.contains("""android:scheme="https""""), "The own-scheme filter must not also claim https:\n$own")
    }

    // ── #2427: the address Stripe returns a card setup to ──
    private fun cardSetupReturnFilter(): String =
        filters().singleOrNull { it.contains("""android:path="/app/account"""") }
            ?: fail("Exactly one intent-filter must claim /app/account")
    @Test
    fun theCardSetupReturnIsClaimedOnThePortalHostOverHttpsAndVerified() {
        val filter = cardSetupReturnFilter()
        assertTrue(filter.contains("""android:scheme="https""""), filter)
        assertTrue(filter.contains("""android:host="kinfolk.tribetails.com""""), filter)
        assertTrue(filter.contains("""android:autoVerify="true""""), "Without autoVerify the phone keeps the address in the browser:\n$filter")
        assertTrue(filter.contains("android.intent.action.VIEW"), filter)
        assertTrue(filter.contains("android.intent.category.BROWSABLE"), filter)
        assertTrue(filter.contains("android.intent.category.DEFAULT"), filter)
        // A filter of its own, so its path is matched against nothing else.
        assertEquals(1, Regex("""android:(path|pathPrefix|pathPattern)=""").findAll(filter).count(), filter)
        assertEquals(1, Regex("""android:scheme=""").findAll(filter).count(), filter)
        assertEquals(1, Regex("""android:host=""").findAll(filter).count(), filter)
    }
    /**
     * The web portal's own Account page, and every email action link under
     * `/account/`, stay the browser's (the two action paths are claimed by
     * exact path in their own filter).
     */
    @Test
    fun theWebPortalsOwnAccountPageIsNotClaimed() {
        val claimed = Regex("""android:(?:path|pathPrefix|pathPattern)="([^"]+)"""").findAll(manifest).map { it.groupValues[1] }.toList()
        val account = claimed.filter { it.startsWith("/account") }
        assertEquals(setOf("/account/secure-reset", "/account/action"), account.toSet(), "Only the two action paths may sit under /account: $claimed")
        assertTrue(claimed.none { it.startsWith("/app/account/") || it == "/app/account/" }, "The card return claim is one exact path: $claimed")
        assertTrue(
            !Regex("""android:pathPrefix="/app/account""").containsMatchIn(manifest),
            "The card return must be an exact path, not a prefix",
        )
    }
    @Test
    fun theAppsOwnSchemeOpensAccountSettingsToo() {
        val own = filters().singleOrNull { it.contains("""android:scheme="mytribe"""") && it.contains("""android:host="account"""") }
            ?: fail("Exactly one intent-filter must claim mytribe://account")
        assertTrue(own.contains("android.intent.action.VIEW"), own)
        assertTrue(own.contains("android.intent.category.BROWSABLE"), "A browser can only open a BROWSABLE link:\n$own")
        assertTrue(own.contains("android.intent.category.DEFAULT"), own)
        assertTrue(!own.contains("""android:scheme="https""""), "The own-scheme filter must not also claim https:\n$own")
    }
    /** `MainActivity` is where every link above is read. */
    @Test
    fun theReturnFiltersBelongToTheMainActivity() {
        val activity = Regex("""<activity\s[^>]*android:name="\.MainActivity".*?</activity>""", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value
            ?: fail("No MainActivity in the manifest")
        assertTrue(activity.contains("""android:pathPrefix="/app/invoices/""""))
        assertTrue(activity.contains("""android:host="invoices""""))
        assertTrue(activity.contains("""android:path="/app/account""""))
        assertTrue(activity.contains("""android:host="account""""))
    }
}
