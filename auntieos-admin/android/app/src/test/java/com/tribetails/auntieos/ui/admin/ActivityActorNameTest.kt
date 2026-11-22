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
    fun aUidNobodyAnswersToIsNeverShown() {
        // #1818: no uid stands in for a name, before the roster answers or after.
        assertEquals("signed in", rowContext(entry("gone-uid"), names))
        assertEquals("signed in", rowContext(entry("u1")))
        assertEquals("signed in", rowContext(entry("u2"), mapOf("u2" to "e2e-admin@tribetails.com")))
    }

    @Test
    fun theOpenedRecordNamesTheActorWithNoUid() {
        val rows = activityDetailRows(entry("u1"), names = names)
        assertTrue(rows.contains("Actor" to "Syd East"))
        assertFalse(rows.any { it.first == "Actor id" || it.second == "u1" })
        val unknown = activityDetailRows(entry("u9"), names = names)
        assertFalse(unknown.any { it.first == "Actor" || it.first == "Actor id" })
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
    /** #1890: Updated by read a sign-in email and "seed_phase14_schemas". */
    @Test
    fun updatedByIsANameOrAPlainWord() {
        val labels = mapOf("u1" to "Syd East", "u2" to "e2e-admin@tribetails.com")
        assertEquals("Syd East", com.tribetails.auntieos.ui.admin.formschemas.plainUpdatedBy("u1", labels))
        assertEquals("Office", com.tribetails.auntieos.ui.admin.formschemas.plainUpdatedBy("u2", labels))
        assertEquals("Staff", com.tribetails.auntieos.ui.admin.formschemas.plainUpdatedBy("nppJNdMNYJfUigibGKUQj3n4obt2", labels))
        assertEquals("Staff", com.tribetails.auntieos.ui.admin.formschemas.plainUpdatedBy("e2e-admin@tribetails.com", labels))
        assertEquals("Set up", com.tribetails.auntieos.ui.admin.formschemas.plainUpdatedBy("seed_phase14_schemas", labels))
    }
}
