package com.kinfolk.portal.util

import java.awt.Desktop
import java.net.URI

/**
 * True only inside `:jvmTest`, set by `mytribe/build.gradle.kts`, which puts
 * `-Dkinfolk.portal.testRuntime=true` on that one Gradle Test task. Same switch
 * `RestHttp` uses for its network guard (#889), and inert for the same reason:
 * a shipped desktop build never sets it.
 */
private val TEST_RUNTIME: Boolean = System.getProperty("kinfolk.portal.testRuntime") == "true"

private fun browseWithDesktop(uri: URI) {
    if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
        Desktop.getDesktop().browse(uri)
    }
}

/**
 * The guard the operator asked for after `./gradlew :jvmTest` opened a Stripe
 * Checkout page in her own browser, and Stripe answered "This link is
 * incomplete" because `cs_test_1` is a test fixture, not a session Stripe ever
 * issued.
 *
 * Refuses OUTSIDE the try/catch on purpose. The old body swallowed every
 * `Throwable`, so a check placed inside it would have been unreachable: the
 * refusal would have been caught and discarded, and this function would have
 * gone on looking like it worked.
 *
 * [browse] is a parameter so the guard's own test can prove the refusal happens
 * BEFORE anything reaches `Desktop`. A test that called the real actual with a
 * real URL to see whether it throws would be the tab this whole thing exists to
 * prevent.
 *
 * WHAT THIS DOES NOT CATCH: a caller that wraps the tap in `catch (t: Throwable)`
 * turns the refusal into an error banner and the suite still passes green.
 * `InvoicesController.startPay` is exactly that shape, which is why it was the
 * call site that leaked. `UrlOpenerSeamGuardTest` is the half that refuses a new
 * unseamed call site at the source, regardless of who catches what.
 */
internal fun openExternalUrlOrRefuse(
    url: String,
    testRuntime: Boolean = TEST_RUNTIME,
    browse: (URI) -> Unit = ::browseWithDesktop,
) {
    check(!testRuntime) {
        "openExternalUrl refused to launch a real browser while :jvmTest is running " +
            "(url=$url). A test reached a production call site with no injectable opener. " +
            "Give that composable or controller an `openUrl: (String) -> Unit = " +
            "{ openExternalUrl(it) }` seam and pass a recording fake from the test."
    }
    try {
        browse(URI(url))
    } catch (_: Throwable) {
        // best-effort; nothing else to do on JVM desktop
    }
}

actual fun openExternalUrl(url: String) {
    openExternalUrlOrRefuse(url)
}
