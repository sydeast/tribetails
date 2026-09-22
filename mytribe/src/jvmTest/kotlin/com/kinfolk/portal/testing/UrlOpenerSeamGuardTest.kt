package com.kinfolk.portal.testing

import com.kinfolk.portal.util.openExternalUrlOrRefuse
import java.io.File
import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Stops `./gradlew :jvmTest` from opening pages in whoever's browser is running
 * the suite.
 *
 * WHAT HAPPENED. `InvoicesController.startPay` called `openExternalUrl` with no
 * seam. `InvoicesControllerTest`'s completed-checkout case stubs `payInvoice`
 * with `checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_1"` and taps
 * pay twice, so every run of the suite handed that fixture URL to
 * `Desktop.getDesktop().browse`: two real tabs, on a Stripe Checkout session
 * that does not exist, which Stripe answered with "This link is incomplete".
 * The suite was green the whole time: the leak was a side effect nothing
 * asserted on.
 *
 * TWO GUARDS, BECAUSE ONE CANNOT COVER BOTH SHAPES.
 *
 *  - The SOURCE SCAN below refuses a new direct `openExternalUrl` call anywhere
 *    in a `*Main` source set. It is the one that would have caught the original
 *    defect, and it catches it at the call site rather than at run time, so it
 *    also covers a call site no test drives YET.
 *
 *  - The RUNTIME GUARD in `UrlOpener.jvm.kt` refuses to browse at all while
 *    `-Dkinfolk.portal.testRuntime=true` (set by build.gradle.kts on exactly
 *    the `:jvmTest` task). It catches a leak the scan cannot see (a call
 *    through an alias, a lambda stored in a field, a future platform actual)
 *    but ONLY when nothing swallows the refusal. `startPay` and
 *    `AccountSettingsScreen`'s card button both wrap their tap in
 *    `catch (t: Throwable)`, so on those two paths the refusal would have
 *    become an error banner and the suite would still have passed green. That
 *    is precisely why the scan exists as well.
 *
 * Package `testing`, not `build`, for the reason `ComposeUiTestSourceSetTest`
 * documents: `mytribe/.gitignore` carries a bare `build/`, which matches at any
 * depth, so a `com.kinfolk.portal.build` package lands in a directory git
 * silently refuses to track.
 */
class UrlOpenerSeamGuardTest {

    // ---------------------------------------------------------------- scan --

    /**
     * The one shape a `*Main` source is allowed to name `openExternalUrl` in: a
     * DECLARED parameter's default, which a caller can override.
     *
     *     openUrl: (String) -> Unit = { openExternalUrl(it) },
     *     openUrl: (String) -> Unit = ::openExternalUrl,
     *
     * The `: (String) -> Unit` is load-bearing, not decoration. Without it the
     * rule also accepts an ARGUMENT that hardwires the real opener at a call
     * site, which is a leak wearing a seam's clothes:
     *
     *     EmergencyContactsCard(kinfolkId, portalApi, openUrl = { openExternalUrl(it) })
     *
     * A test rendering that parent reaches the platform opener through the
     * child, and the parameter it was handed can no longer be overridden.
     */
    private val seamDefault = Regex(
        """:\s*\(String\)\s*->\s*Unit\s*=\s*(\{\s*openExternalUrl\(it\)\s*\}|::openExternalUrl)\s*,?\s*$""",
    )

    private val importLine = Regex("""^import\s""")

    /**
     * True when [line] reaches the platform opener with no way to substitute it.
     *
     * Matches on the bare name, not `openExternalUrl(`, so a function reference
     * (`openUrl = ::openExternalUrl,` at a call site) is classified rather than
     * skipped for want of a paren.
     */
    internal fun isUnseamedCall(line: String): Boolean {
        if (!line.contains("openExternalUrl")) return false
        val trimmed = line.trim()
        if (importLine.containsMatchIn(trimmed)) return false
        // KDoc bodies start with `*`, and both comment forms are prose, not calls.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false
        if (seamDefault.containsMatchIn(line)) return false
        return true
    }

    private fun isSeam(line: String): Boolean =
        line.contains("openExternalUrl") && seamDefault.containsMatchIn(line)

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

    /**
     * Every production source set. `commonMain` holds the screens and
     * controllers; the per-platform ones are swept too so a future
     * `androidMain` screen cannot slip in behind the same hole.
     */
    private fun mainSources(): List<File> =
        File(moduleRoot(), "src").listFiles().orEmpty()
            .filter { it.isDirectory && it.name.endsWith("Main") }
            .flatMap { File(it, "kotlin").walkTopDown().filter { f -> f.isFile && f.extension == "kt" } }
            // The expect/actual declarations themselves. Everything else routes through them.
            .filterNot { it.name.startsWith("UrlOpener") }
            .sortedBy { it.path }

    @Test
    fun noProductionSourceCallsTheOpenerWithoutASeam() {
        val root = moduleRoot()
        val offenders = mainSources().flatMap { file ->
            file.readLines().withIndex()
                .filter { (_, line) -> isUnseamedCall(line) }
                .map { (i, line) -> "  ${file.relativeTo(root).path}:${i + 1}: ${line.trim()}" }
        }

        assertTrue(
            offenders.isEmpty(),
            "These call openExternalUrl directly, so any test that reaches them launches a real " +
                "browser / dialler / mail client on the machine running :jvmTest. Give the " +
                "composable or controller a seam instead:\n" +
                "  openUrl: (String) -> Unit = { openExternalUrl(it) },\n" +
                "then call openUrl(...) at the call site, and pass a recording fake from the test " +
                "(SecureResetScreen and InvoicesController are the worked examples):\n" +
                offenders.joinToString("\n"),
        )
    }

    /**
     * Self-check 1. The scan above passes when nothing is wrong AND when the
     * classifier is broken. This pins the classifier against both mistakes:
     * a violation it must flag, and the four shapes it must not.
     */
    @Test
    fun theClassifierFlagsARealCallAndOnlyARealCall() {
        assertTrue(
            isUnseamedCall("""                if (res.checkoutUrl.isNotBlank()) openExternalUrl(res.checkoutUrl)"""),
            "the exact line this whole fix exists to refuse was not flagged",
        )
        assertTrue(isUnseamedCall("""    onClick = { openExternalUrl("tel:${'$'}phone") },"""))
        assertTrue(isUnseamedCall("""            modifier = Modifier.clickable { openExternalUrl(url) },"""))

        // A seam's clothes without a seam: an ARGUMENT that hardwires the real
        // opener into a child, which the child's own caller can no longer
        // override. Both of these must be flagged.
        assertTrue(
            isUnseamedCall("""        EmergencyContactsCard(kinfolkId, portalApi, openUrl = { openExternalUrl(it) })"""),
            "a call-site argument is not a seam; it pins the platform opener into the child",
        )
        assertTrue(
            isUnseamedCall("""            openUrl = ::openExternalUrl,"""),
            "a function reference passed as an argument reaches the platform opener too",
        )

        assertFalse(isUnseamedCall("""    openUrl: (String) -> Unit = { openExternalUrl(it) },"""))
        assertFalse(isUnseamedCall("""    private val openUrl: (String) -> Unit = ::openExternalUrl,"""))
        assertFalse(isUnseamedCall("""import com.kinfolk.portal.util.openExternalUrl"""))
        assertFalse(isUnseamedCall(""" * [startDownloadPdf]'s openExternalUrl(url) — no callable round-trip,"""))
        assertFalse(isUnseamedCall("""    // openExternalUrl(url) used to live here; see #943's sibling fix."""))
        assertFalse(isUnseamedCall("""    val x = 1"""))

        // A seam is not merely "not a violation"; the tripwire below counts these.
        assertTrue(isSeam("""    openUrl: (String) -> Unit = { openExternalUrl(it) },"""))
        assertTrue(isSeam("""    private val openUrl: (String) -> Unit = ::openExternalUrl,"""))
        assertFalse(isSeam("""                if (url.isNotBlank()) openExternalUrl(url)"""))
        assertFalse(isSeam("""            openUrl = { openExternalUrl(it) },"""))
    }

    /**
     * Self-check 2. A scan over an empty or mis-rooted tree passes vacuously
     * and protects nothing. This fails if the walk stops finding sources, and
     * if the seams it is supposed to be defending disappear.
     */
    @Test
    fun theScanIsActuallyLookingAtTheProductionTree() {
        val files = mainSources()
        assertTrue(files.size > 100, "the walk found only ${files.size} production sources; wrong root?")

        val seams = files.flatMap { f -> f.readLines().filter { isSeam(it) }.map { f.name } }
        assertTrue(
            seams.size >= 6,
            "expected the seams this guard defends (SecureResetScreen x2, AppNavHost, " +
                "AccountSettingsScreen, InvoicesController, EmergencyContactsCard, TribeScreen); " +
                "found ${seams.size}: $seams",
        )

        // The exclusion above must be excluding something that exists, not a stale path.
        val src = File(moduleRoot(), "src")
        assertTrue(
            File(src, "commonMain/kotlin/com/kinfolk/portal/util/UrlOpener.kt").isFile,
            "the expect declaration moved; the UrlOpener exclusion is now hiding an unknown file",
        )
    }

    // ------------------------------------------------------------- runtime --

    @Test
    fun theSharedTestSetupArmedTheRuntimeGuardForThisRun() {
        // Without this, the refusal below is dead code in the one place it matters.
        assertEquals(
            "true",
            System.getProperty("kinfolk.portal.testRuntime"),
            "build.gradle.kts should set this system property on the jvmTest task",
        )
    }

    @Test
    fun theRuntimeGuardRefusesBeforeAnythingReachesDesktop() {
        var reached: URI? = null
        val ex = assertFailsWith<IllegalStateException> {
            openExternalUrlOrRefuse(
                "https://checkout.stripe.com/c/pay/cs_test_1",
                testRuntime = true,
                browse = { reached = it },
            )
        }
        assertTrue(
            ex.message.orEmpty().contains("cs_test_1"),
            "the refusal should name the URL it stopped, got: ${ex.message}",
        )
        assertEquals(null, reached, "the browse action must never run under the test runtime")
    }

    @Test
    fun outsideTheTestRuntimeItStillOpensTheUrlItWasGiven() {
        // The guard has to be inert in a shipped desktop build; a guard that
        // refused everywhere would be a broken Pay button, not a fix.
        var reached: URI? = null
        openExternalUrlOrRefuse(
            "https://checkout.stripe.com/c/pay/cs_live_real",
            testRuntime = false,
            browse = { reached = it },
        )
        assertEquals(URI("https://checkout.stripe.com/c/pay/cs_live_real"), reached)
    }
}
