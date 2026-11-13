package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.HomeSectionCfg
import com.tribetails.auntieos.web.data.PortalHome
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1987: a Home layout equal to the default is the default. The desktop
 * console's editor writes every row as soon as one value is touched, so a
 * Limit typed and put back used to leave four default-looking rows behind.
 * Same vectors as the server, the React admin and admin Android.
 */
class HomeLayoutDefaultTest {
    private fun row(id: String, enabled: Boolean = true, limit: Int = 0) = HomeSectionCfg(id, enabled, limit)
    private val defaultRows = listOf("liveVisit", "upNext", "tales", "quickStart").map { row(it) }
    private val limitOnly = defaultRows.map { if (it.id == "upNext") it.copy(limit = 2) else it }
    private val customOrder = listOf(row("quickStart"), row("liveVisit"), row("upNext"), row("tales"))

    @Test
    fun `the empty list and the four default rows written out are the default`() {
        assertTrue(isDefaultHomeLayout(emptyList()))
        assertTrue(isDefaultHomeLayout(defaultRows))
    }

    @Test
    fun `a limit, a switch or a changed order is not the default`() {
        assertFalse(isDefaultHomeLayout(limitOnly))
        assertFalse(isDefaultHomeLayout(defaultRows.map { if (it.id == "tales") it.copy(enabled = false) else it }))
        assertFalse(isDefaultHomeLayout(customOrder))
    }

    @Test
    fun `a list with a row it does not know is never called the default`() {
        assertFalse(isDefaultHomeLayout(defaultRows + row("roster")))
        assertFalse(isDefaultHomeLayout(defaultRows + row("somethingNew")))
        assertFalse(isDefaultHomeLayout(defaultRows + row("tales")))
        assertFalse(isDefaultHomeLayout(defaultRows.take(3) + row("")))
        assertFalse(isDefaultHomeLayout(defaultRows.take(3)))
    }

    @Test
    fun `a limit-only change is held as typed`() {
        assertEquals(PortalHome(limitOnly), normalizedPortalHome(PortalHome(limitOnly)))
    }

    @Test
    fun `putting every value back is held as the empty list`() {
        assertEquals(PortalHome(), normalizedPortalHome(PortalHome(defaultRows)))
    }

    @Test
    fun `a stored layout equal to the default opens as the default with nothing to save`() {
        val loaded = normalizedPortalHome(PortalHome(defaultRows))
        assertEquals(PortalHome(), loaded)
        // The panel's draft starts from the same value, so the save bar stays clean.
        assertEquals(loaded, normalizedPortalHome(loaded))
    }

    @Test
    fun `a real custom order and an unknown row are left exactly as they are`() {
        assertEquals(PortalHome(customOrder), normalizedPortalHome(PortalHome(customOrder)))
        val withRoster = PortalHome(defaultRows + row("roster"))
        assertEquals(withRoster, normalizedPortalHome(withRoster))
    }
}
