package com.tribetails.auntieos.web.ui.shell

import com.tribetails.auntieos.web.screens.admin.TemplatesTab
import com.tribetails.auntieos.web.screens.admin.templatesTabFromSlug
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Template Bank + Assignment merged into one two-tab destination (Decision 2).
 * The new "templates" slug is canonical; both legacy standalone slugs still
 * resolve, carrying the tab they used to land on.
 */
class TemplatesRouteTest {

    @Test
    fun newSlugIsCanonical() {
        assertEquals("#/templates", routeToHash(Route(Destination.Templates)))
        assertEquals(Destination.Templates, parseHash("#/templates").dest)
    }

    @Test
    fun assignmentTabRoundTrips() {
        val r = Route(Destination.Templates, detailId = "assignment")
        assertEquals("#/templates/assignment", routeToHash(r))
        val parsed = parseHash("#/templates/assignment")
        assertEquals(Destination.Templates, parsed.dest)
        assertEquals("assignment", parsed.detailId)
    }

    @Test
    fun legacyTemplateBankSlugResolvesToBankTab() {
        val r = parseHash("#/template-bank")
        assertEquals(Destination.Templates, r.dest)
        assertEquals(TemplatesTab.Bank, templatesTabFromSlug(r.detailId))
    }

    @Test
    fun legacyTemplateAssignmentSlugResolvesToAssignmentTab() {
        val r = parseHash("#/template-assignment")
        assertEquals(Destination.Templates, r.dest)
        assertEquals(TemplatesTab.Assignment, templatesTabFromSlug(r.detailId))
    }

    @Test
    fun unknownSlugDefaultsToBank() {
        assertEquals(TemplatesTab.Bank, templatesTabFromSlug(null))
        assertEquals(TemplatesTab.Bank, templatesTabFromSlug("nonsense"))
    }
}
