package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1009. Plain state-object tests for [SaveConfirmationHostState] - no
 * composition needed, since `mutableStateOf`'s snapshot system reads and
 * writes fine outside one. [SaveConfirmationHostRenderTest] covers the
 * Compose surface ([SaveConfirmationHost] itself, and that a message survives
 * the composable that raised it being swapped out).
 */
class SaveConfirmationHostStateTest {

    @Test
    fun `show sets the message and kind`() {
        val state = SaveConfirmationHostState()

        state.show("Saved Ada Lovelace.")

        assertEquals("Saved Ada Lovelace.", state.message)
        assertEquals(ToastKind.Success, state.kind)
    }

    @Test
    fun `show trims the message`() {
        val state = SaveConfirmationHostState()

        state.show("  Saved Ada Lovelace.  ")

        assertEquals("Saved Ada Lovelace.", state.message)
    }

    @Test
    fun `show with a blank message is a no-op - an empty confirmation is a call-site bug, not something to render`() {
        val state = SaveConfirmationHostState()

        state.show("   ")

        assertNull(state.message)
    }

    @Test
    fun `dismiss clears the message`() {
        val state = SaveConfirmationHostState()
        state.show("Saved Ada Lovelace.")

        state.dismiss()

        assertNull(state.message)
    }

    @Test
    fun `every show advances the token, even for identical text`() {
        val state = SaveConfirmationHostState()

        state.show("Saved.")
        val firstToken = state.token
        state.show("Saved.")
        val secondToken = state.token

        // The host's auto-dismiss timer is keyed on this token, not on the
        // message text, precisely so two saves that land on the exact same
        // wording each still get their own full dismiss window rather than the
        // second being read as a no-op repeat of the first's unfinished timer.
        assertEquals(firstToken + 1, secondToken)
    }

    @Test
    fun `a second show before dismiss replaces the message and kind`() {
        val state = SaveConfirmationHostState()
        state.show("Saved Ada Lovelace.")

        state.show("Ada Lovelace is archived.")

        assertEquals("Ada Lovelace is archived.", state.message)
    }
}
