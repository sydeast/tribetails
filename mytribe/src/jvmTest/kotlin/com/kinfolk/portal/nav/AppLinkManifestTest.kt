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
}
