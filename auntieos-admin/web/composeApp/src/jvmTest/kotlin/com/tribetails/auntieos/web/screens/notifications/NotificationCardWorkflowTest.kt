package com.tribetails.auntieos.web.screens.notifications

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #1592: the desktop notification card still printed the transports
 * ("channels: email, sms"), a dispatch-status pill ("dispatched") and a
 * "Dispatched / delivered" stat, three things web dropped under operator ruling
 * R5 (2026-08-03): "workflow (Channels, trigger, and dispatched are activity
 * log not notification)". Android dropped them too. The screen has no UI test
 * harness here, so this reads its source for each of them, plus the developer
 * words ("Catalog-dispatched", "MyTribe functions") its copy carried.
 */
class NotificationCardWorkflowTest {

    private val screen = File("src/commonMain/kotlin/com/tribetails/auntieos/web/screens/notifications/NotificationsScreen.kt")

    /** The source with comments stripped, so a comment that names the old text is not a hit. */
    private fun code(): String {
        assertTrue(screen.isFile, "run from the composeApp project directory: ${screen.absolutePath}")
        return screen.readText()
            .replace(Regex("""/\*[\s\S]*?\*/"""), "")
            .lines()
            .joinToString("\n") { it.substringBefore("//") }
    }

    @Test
    fun theCardPrintsNoTransportsLine() {
        assertTrue("\"channels: " !in code(), "the card still prints the channels line")
        assertTrue("entry.channels" !in code(), "the card still reads the transports")
    }

    @Test
    fun theCardShowsNoDispatchStatusPill() {
        val text = code()
        assertTrue("entry.status" !in text, "the card still shows the dispatch status")
        assertTrue("statusTone(" !in text, "the dispatch-status tone is still drawn")
    }

    @Test
    fun theStatStripCountsDecisionsNotDispatches() {
        val text = code()
        assertTrue("\"Dispatched\"" !in text, "the Dispatched tile is still on the strip")
        assertTrue("\"Needs a decision\"" in text, "the strip lost its decision count")
    }

    @Test
    fun theScreenCopyCarriesNoPipelineWords() {
        val text = code()
        assertTrue("Catalog-dispatched" !in text)
        assertTrue("MyTribe functions" !in text)
    }
}
