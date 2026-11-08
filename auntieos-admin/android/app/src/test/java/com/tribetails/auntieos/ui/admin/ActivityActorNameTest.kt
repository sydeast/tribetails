package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.ui.admin.formschemas.updatedByLabels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1592: the Activity Log and Form Schemas name a person, not their uid. */
class ActivityActorNameTest {
    private val names = mapOf("u1" to "Syd East")

    private fun entry(actorId: String) = ActivityLogEntry(
        id = "a1",
        timestamp = "2026-11-05T21:32:52Z",
        actionType = "LOGIN",
        description = "signed in",
        status = "SUCCESS",
    ).also { it.actorId = actorId }

    @Test
    fun theRowNamesTheActor() {
        assertEquals("signed in · Syd East", rowContext(entry("u1"), names))
    }

    @Test
    fun aUidNobodyAnswersToIsShownAsItIs() {
        assertEquals("signed in · gone-uid", rowContext(entry("gone-uid"), names))
    }

    @Test
    fun theOpenedRecordNamesTheActorAndKeepsTheUid() {
        val rows = activityDetailRows(entry("u1"), names = names)
        assertTrue(rows.contains("Actor" to "Syd East"))
        assertTrue(rows.contains("Actor id" to "u1"))
        val unknown = activityDetailRows(entry("u9"), names = names)
        assertTrue(unknown.contains("Actor" to "u9"))
        assertFalse(unknown.any { it.first == "Actor id" })
    }

    @Test
    fun theActorCanBeFoundByName() {
        assertTrue(matchesQuery(entry("u1"), "syd", names))
        assertFalse(matchesQuery(entry("u1"), "syd"))
    }

    @Test
    fun formSchemasNameTheEditorAheadOfTheRosterEmail() {
        val labels = updatedByLabels(
            emailByUid = mapOf("u1" to "office address", "u2" to "roster-only address"),
            staffNames = names,
        )
        assertEquals("Syd East", labels["u1"])
        assertEquals("roster-only address", labels["u2"])
    }
}
