package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.screens.admin.formschemas.updatedByLabel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1592: the Activity Log and Form Schemas name a person, not their uid. */
class ActivityActorNameTest {
    private val names = mapOf("u1" to "Syd East")

    private fun entry(actorId: String) = ActivityLogEntry(
        description = "signed in",
        actionType = "LOGIN",
        status = "SUCCESS",
        actorId = actorId,
    )

    @Test
    fun theRowNamesTheActor() {
        assertEquals("signed in · Syd East", rowContext(entry("u1"), names))
    }

    @Test
    fun aUidNobodyAnswersToIsNeverShown() {
        // #1818: no uid or sign-in email stands in for a name.
        assertEquals("signed in", rowContext(entry("gone-uid"), names))
        assertEquals("signed in", rowContext(entry("u1")))
        assertEquals("signed in", rowContext(entry("u2"), mapOf("u2" to "e2e-admin@tribetails.com")))
        assertFalse(activityDetailRows(entry("gone-uid"), names = names).any { it.first == "Actor" || it.first == "Actor id" })
        assertTrue(activityDetailRows(entry("u1"), names = names).contains("Actor" to "Syd East"))
    }

    @Test
    fun theActorCanBeFoundByName() {
        assertTrue(matchesQuery(entry("u1"), "syd", names))
        assertFalse(matchesQuery(entry("u1"), "syd"))
    }

    @Test
    fun formSchemasNameTheEditor() {
        assertEquals("Syd East", updatedByLabel("u1", names))
        assertEquals("seed_phase14_schemas", updatedByLabel("seed_phase14_schemas", names))
    }
}
