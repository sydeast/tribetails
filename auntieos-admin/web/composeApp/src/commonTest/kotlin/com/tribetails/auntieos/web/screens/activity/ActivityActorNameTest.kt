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
    fun aUidNobodyAnswersToIsShownAsItIs() {
        assertEquals("signed in · gone-uid", rowContext(entry("gone-uid"), names))
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
