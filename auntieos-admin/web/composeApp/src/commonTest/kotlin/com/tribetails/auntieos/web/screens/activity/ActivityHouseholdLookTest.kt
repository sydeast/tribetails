package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.activityDescriptionWords
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1839. A look at a household read as "Operator crosstenant access", its key
 * in capitals, a red flag and a line of ids. Since operator ruling 2026-11-12
 * only an Auntie's looks write it, in words; the rows stored before then still
 * show, in plain words and without the warning. Same cases as the web
 * (`ActivityLog.test.tsx`) and Android.
 */
class ActivityHouseholdLookTest {
    private val names = mapOf("aunt-uid" to "Jane Rivers", "owner-uid" to "Syd East")
    private val household = "Xk29fLq0aBcD3eFgH1jK"

    private fun look(description: String, actorId: String, status: String = "SUCCESS") = ActivityLogEntry(
        _id = "l1",
        timestamp = "2026-11-10T05:24:00Z",
        actionType = "OPERATOR_CROSSTENANT_ACCESS",
        description = description,
        status = status,
        actorId = actorId,
        targetId = household,
    )

    private val auntieLook = look("Jane Rivers looked at Kinfolk Dre East", "aunt-uid")
    private val storedLook = look("OPERATOR_CROSSTENANT_ACCESS uid=owner-uid target=$household", "owner-uid")

    @Test
    fun theTitleIsPlainAndTheKeyIsNotShown() {
        assertEquals("Household opened", activityTitle("OPERATOR_CROSSTENANT_ACCESS"))
        assertFalse(activityShowsCode("OPERATOR_CROSSTENANT_ACCESS"))
        // Every other kind keeps its humanized key and its code, unchanged.
        assertEquals("Kincare arrived", activityTitle("KINCARE_ARRIVED"))
        assertTrue(activityShowsCode("KINCARE_ARRIVED"))
        assertFalse(activityShowsCode(""))
    }

    @Test
    fun anAuntiesLookReadsAsTheServersWordsWithNoIdAndNoSecondName() {
        assertEquals("Jane Rivers looked at Kinfolk Dre East", rowContext(auntieLook, names))
    }

    @Test
    fun aStoredLookReadsAsWordsWithThePersonsNameAndNoIds() {
        val line = rowContext(storedLook, names)
        assertEquals("Opened a household · Syd East", line)
        assertFalse(line.contains(household))
        assertFalse(line.contains("uid="))
        assertFalse(line.contains("OPERATOR"))
    }

    @Test
    fun aStoredLookNeverNamesThePersonByEmailOrUid() {
        // The roster labels a staff member with no name by her sign-in email.
        assertEquals("Opened a household", rowContext(storedLook, mapOf("owner-uid" to "e2e-admin@tribetails.com")))
        // Before the roster answers, the row would otherwise print the uid.
        assertEquals("Opened a household", rowContext(storedLook, emptyMap()))
    }

    @Test
    fun aLookIsNeverRedUnlessItFailed() {
        assertEquals(AuntieStatusTone.Neutral, rowTone("OPERATOR_CROSSTENANT_ACCESS", "SUCCESS"))
        assertEquals(AuntieStatusTone.Error, rowTone("OPERATOR_CROSSTENANT_ACCESS", "FAILURE"))
        // The Admin chip's own events keep its tone.
        assertEquals(AuntieStatusTone.Error, rowTone("PERM_GRANTED", "SUCCESS"))
        // It still files under Admin, so the filter does not lose it.
        assertEquals(ActivityCategory.Admin, activityCategoryOf("OPERATOR_CROSSTENANT_ACCESS"))
    }

    @Test
    fun aLookIsFoundByItsPlainTitle() {
        assertTrue(matchesQuery(auntieLook, "household opened", names))
        assertTrue(matchesQuery(storedLook, "opened a household", names))
    }

    @Test
    fun theStoredBareKeyReadsAsWords() {
        assertEquals("Opened a household", activityDescriptionWords("OPERATOR_CROSSTENANT_ACCESS uid=u1 target=$household"))
        assertEquals("Opened a household", activityDescriptionWords("OPERATOR_CROSSTENANT_ACCESS"))
    }
}
