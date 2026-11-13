package com.tribetails.auntieos.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2163, operator ruling 2026-11-13: "auntie user level cannot see templates
 * or business settings".
 *
 * The Android admin admits only the admin claim at sign-in today, so there is
 * no Auntie path into this app yet. The Settings routes already sit behind
 * `AdminGate`; Templates did not, so the two owner screens disagreed about
 * their own boundary. This pins them alike, and pins KinTale templates as NOT
 * gated, since that screen stays hers.
 *
 * A source scan rather than a Compose test because the property is "which
 * composable wraps this route's content" in `Navigation.kt`, and the nav host
 * cannot be stood up in a unit test without the whole app graph.
 */
class OwnerScreenGateTest {

    @Test
    fun templates_route_sits_behind_the_admin_gate() {
        assertTrue(
            "Screen.Templates must render inside AdminGate, the same as Settings (#2163)",
            routeBlock("Screen.Templates.route").contains("AdminGate("),
        )
    }

    /** Positive control: the scan finds the gate where it has always been. */
    @Test
    fun settings_routes_are_still_gated() {
        assertTrue(routeBlock("Screen.AdminSettings.route").contains("AdminGate("))
        assertTrue(routeBlock("Screen.AccountSettings.route").contains("AdminGate("))
    }

    @Test
    fun kintale_templates_stays_ungated() {
        assertFalse(
            "KinTale templates stays reachable for an Auntie (#2163)",
            routeBlock("Screen.KinTaleTemplates.route").contains("AdminGate("),
        )
    }

    /**
     * The source of one `composable(<route>) { ... }` block in Navigation.kt,
     * from its opening line to the next `composable(`.
     */
    private fun routeBlock(route: String): String {
        val source = navigationSource()
        val opener = "composable($route)"
        val start = source.indexOf(opener)
        assertTrue("Navigation.kt declares no `$opener`. If it moved, update this test.", start >= 0)
        val next = source.indexOf("composable(", start + opener.length)
        return if (next < 0) source.substring(start) else source.substring(start, next)
    }

    private fun navigationSource(): String {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "app/src/main/java/com/tribetails/auntieos/ui/Navigation.kt")
            if (candidate.isFile) return candidate.readText()
            dir = dir.parentFile
        }
        throw AssertionError(
            "Could not find app/src/main/.../ui/Navigation.kt above ${File("").absolutePath}. " +
                "This test reads the real source and cannot run without it.",
        )
    }
}
