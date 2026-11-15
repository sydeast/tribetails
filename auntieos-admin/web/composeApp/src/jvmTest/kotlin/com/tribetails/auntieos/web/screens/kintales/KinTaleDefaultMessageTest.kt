package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleTemplate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2050 on the desktop console: a KinTale template's "Default message to
 * kinfolk" opens a new tale's message, once. It used to appear only in the
 * live preview, which previewed words that were never sent.
 *
 * A new tale that holds only that message has nothing of the Auntie's in it,
 * so a save she did not ask for writes no draft.
 */
class KinTaleDefaultMessageTest {

    private val message = "Thanks for having us today!"
    private val session = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinfolkName = "The Whitfields",
        kinIds = listOf("k1", "k2"),
        serviceType = "Dog Walk",
        startTime = "2026-11-10T15:00:00.000Z",
        status = "DEPARTED",
    )
    private val walks = KinTaleTemplate(_id = "tpl_walk", name = "Dog Walk recap", defaultEmailMessage = message)

    @Test
    fun aNewTaleOpensWithTheTemplatesDefaultMessage() {
        val tale = scaffoldReport(session, walks)
        assertEquals(message, tale.bodyCopy)
        assertEquals("", tale.title)
        assertEquals("tpl_walk", tale.templateId)
        assertEquals("DRAFT", tale.status)
        assertEquals("", tale._id)
    }

    @Test
    fun noMessageABlankOneAndTheBuiltInAllOpenAnEmptyNote() {
        assertEquals("", scaffoldReport(session, walks.copy(defaultEmailMessage = "")).bodyCopy)
        assertEquals("", scaffoldReport(session, walks.copy(defaultEmailMessage = "  \n ")).bodyCopy)
        assertEquals("", scaffoldReport(session, DefaultKinTaleTemplate.template).bodyCopy)
    }

    @Test
    fun theMessageIsKeptAsTyped() {
        val markup = "Hi <img src=x onerror=alert(1)> <b>there</b>\nSee you Thursday."
        assertEquals(markup, walks.copy(defaultEmailMessage = markup).defaultMessageForNewTale())
    }

    @Test
    fun aTaleHoldingOnlyItsDefaultMessageIsUntouched() {
        val started = scaffoldReport(session, walks)
        assertTrue(isUntouchedNewTale(started, started))
        assertTrue(isUntouchedNewTale(started.copy(), started))
    }

    @Test
    fun anythingTheAuntieAddsOrChangesMakesItHers() {
        val started = scaffoldReport(session, walks)
        assertFalse(isUntouchedNewTale(started.copy(title = "Park day"), started))
        assertFalse(isUntouchedNewTale(started.copy(bodyCopy = "Biscuit found a stick."), started))
        assertFalse(isUntouchedNewTale(started.copy(bodyCopy = ""), started))
        assertFalse(
            isUntouchedNewTale(
                started.copy(fieldResponses = mapOf("k1|fed" to FieldResponse(fieldKey = "fed", kinId = "k1", boolValue = true))),
                started,
            ),
        )
    }

    @Test
    fun aSavedTaleAndAReopenedDraftAreNeverUntouched() {
        val started = scaffoldReport(session, walks)
        // Saved once: it has an id, and every later save is a real update.
        assertFalse(isUntouchedNewTale(started.copy(_id = "r1"), started))
        // Reopened (#2040): there is no starting point to compare to.
        assertFalse(isUntouchedNewTale(started, null))
    }
}
