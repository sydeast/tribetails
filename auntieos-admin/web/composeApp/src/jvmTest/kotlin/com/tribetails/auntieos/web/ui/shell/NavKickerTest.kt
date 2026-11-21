package com.tribetails.auntieos.web.ui.shell

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1894: a screen's breadcrumb names the rail section and the rail's name for
 * the screen. #1598 fixed the Care Ops screens it named and left a literal
 * kicker on the rest, which then disagreed with the sidebar (Settings, Tribal
 * Intel, Notifications and Templates said "The Den" under a rail that files
 * them under More).
 */
class NavKickerTest {
    @Test fun kickerReadsTheRailSectionAndTitle() {
        assertEquals("More · Settings", navKicker(Destination.Settings))
        assertEquals("More · Tribal Intel", navKicker(Destination.TrainingDocs))
        assertEquals("More · Notifications", navKicker(Destination.Notifications))
        assertEquals("More · Templates", navKicker(Destination.Templates))
        assertEquals("Care Ops · Invoices", navKicker(Destination.Invoices))
        assertEquals("The Den · Directory", navKicker(Destination.Directory))
    }

    @Test fun noScreenSpellsItsOwnKicker() {
        val root = File("src/commonMain/kotlin")
        assertTrue(root.isDirectory, "run from the composeApp project directory: ${root.absolutePath}")
        val literal = Regex("\"(The Den|THE DEN|Care Ops|CARE OPS|More|MORE) · ")
        val strays = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { f ->
                f.readLines().withIndex()
                    .filter { (_, line) -> literal.containsMatchIn(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//") }
                    .map { (i, _) -> "${f.path}:${i + 1}" }
            }
            .toList()
        assertEquals(emptyList(), strays)
    }
}
