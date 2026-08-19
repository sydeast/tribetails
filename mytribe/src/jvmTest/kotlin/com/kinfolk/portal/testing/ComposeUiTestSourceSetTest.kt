package com.kinfolk.portal.testing

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Guards the split that closed issue #473.
 *
 * A Compose UI test placed in `commonTest` gets collected by the Android
 * unit-test variant, where it cannot run: `runComposeUiTest` on Android needs a
 * real Android runtime, and `./gradlew testDebugUnitTest` gives it the stub
 * `android.jar`, so the test dies on a null `android.os.Build.FINGERPRINT`
 * before it reaches a single assertion. That is how 143 of 524 tests came to
 * fail on a clean checkout without anyone noticing.
 *
 * Compose UI tests therefore live in `src/composeUiTest`, an intermediate source
 * set that only `jvmTest` and `jsTest` refine. This test fails the moment one
 * lands back in `commonTest`, so the wall of red cannot rebuild itself.
 *
 * Package `testing`, not `build`: `mytribe/.gitignore` carries a bare `build/`,
 * which matches at any depth, so a `com.kinfolk.portal.build` package would put
 * this file in a directory git silently refuses to track. It passed locally and
 * was absent from the commit.
 */
class ComposeUiTestSourceSetTest {

    private val composeTestImport = "androidx.compose.ui.test"

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

    @Test
    fun commonTestHoldsNoComposeUiTests() {
        val commonTest = File(moduleRoot(), "src/commonTest")
        val offenders = commonTest.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { it.readText().contains(composeTestImport) }
            .map { it.relativeTo(moduleRoot()).path }
            .sorted()
            .toList()

        assertTrue(
            offenders.isEmpty(),
            "These commonTest files reference $composeTestImport, so the Android unit-test " +
                "variant will collect them and every one will fail on a null Build.FINGERPRINT. " +
                "Move them to src/composeUiTest instead:\n" + offenders.joinToString("\n") { "  $it" },
        )
    }

    @Test
    fun composeUiTestSourceSetIsWhereTheUiTestsActuallyAre() {
        val composeUiTest = File(moduleRoot(), "src/composeUiTest")
        val uiTests = composeUiTest.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { it.readText().contains(composeTestImport) }
            .count()

        // Not a coverage target, a tripwire: if this hits zero the source set has
        // been emptied or renamed and the guard above is protecting nothing.
        assertTrue(uiTests > 0, "src/composeUiTest holds no Compose UI tests any more")
    }
}
