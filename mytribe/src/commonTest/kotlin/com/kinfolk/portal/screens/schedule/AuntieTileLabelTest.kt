package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.VisitStage
import kotlin.test.Test
import kotlin.test.assertEquals

/** #1836: a completed visit the office worked itself read as if nobody had been assigned yet. */
class AuntieTileLabelTest {
    @Test
    fun theAuntieOnRecordIsNamed() {
        assertEquals("Maya", auntieTileLabel("Maya", VisitStage.Completed))
        assertEquals("Maya", auntieTileLabel("Maya", VisitStage.Confirmed))
    }

    @Test
    fun aCompletedVisitWithNoNameReadsYourAuntie() {
        assertEquals("Your Auntie", auntieTileLabel(null, VisitStage.Completed))
        assertEquals("Your Auntie", auntieTileLabel("  ", VisitStage.Completed))
    }

    @Test
    fun declinedAndNotYetStartedKeepTheirWords() {
        assertEquals("Not assigned", auntieTileLabel(null, VisitStage.Declined))
        assertEquals("Pending", auntieTileLabel(null, VisitStage.Confirmed))
        assertEquals("Pending", auntieTileLabel(null, VisitStage.Requested))
    }
}
