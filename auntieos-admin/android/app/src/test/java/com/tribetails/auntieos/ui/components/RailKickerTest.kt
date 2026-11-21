package com.tribetails.auntieos.ui.components

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1894: a screen's breadcrumb names the rail section and the rail's name for
 * the screen, the same words the web and desktop consoles use. #1598 fixed the
 * Care Ops screens it named and left literal kickers elsewhere, so Settings,
 * Tribal Intel, Notifications and Templates kept "The Den" and Packages kept
 * "Pricing".
 */
class RailKickerTest {
    @Test fun kickerReadsTheRailSectionAndTitle() {
        assertEquals("Care Ops · Packages", railKicker(RailScreen.PACKAGES))
        assertEquals("More · Settings", railKicker(RailScreen.SETTINGS))
        assertEquals("More · Tribal Intel", railKicker(RailScreen.TRIBAL_INTEL))
        assertEquals("More · Notifications", railKicker(RailScreen.NOTIFICATIONS))
        assertEquals("More · Templates", railKicker(RailScreen.TEMPLATES))
        assertEquals("The Den · Directory", railKicker(RailScreen.DIRECTORY))
    }

    @Test fun noScreenSpellsItsOwnKicker() {
        val root = File("src/main/java")
        assertTrue("run from the app module directory: ${root.absolutePath}", root.isDirectory)
        val literal = Regex("kicker\\s*=\\s*\"(The Den|Care Ops|More) · ")
        val strays = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { f ->
                f.readLines().withIndex()
                    .filter { (_, line) -> literal.containsMatchIn(line) }
                    .map { (i, line) -> "${f.path}:${i + 1}: ${line.trim()}" }
            }
            .toList()
        assertEquals(emptyList<String>(), strays)
    }
}
