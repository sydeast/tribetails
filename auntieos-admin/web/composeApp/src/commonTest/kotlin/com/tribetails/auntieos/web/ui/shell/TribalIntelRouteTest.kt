package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals

/** Tribal Intel rename (Decision 3): new slug is canonical, old slug still resolves. */
class TribalIntelRouteTest {

    @Test
    fun newSlugIsCanonical() {
        assertEquals("#/tribal-intel", routeToHash(Route(Destination.TrainingDocs)))
        assertEquals(Destination.TrainingDocs, parseHash("#/tribal-intel").dest)
    }

    @Test
    fun oldTrainingDocsSlugStillResolves() {
        assertEquals(Destination.TrainingDocs, parseHash("#/training-docs").dest)
    }
}
