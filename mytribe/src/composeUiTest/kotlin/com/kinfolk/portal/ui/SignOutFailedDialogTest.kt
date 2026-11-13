@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.ui

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.auth.SIGN_OUT_FAILED
import com.kinfolk.portal.auth.SignOutFailure
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertNull

/**
 * #2140: what the Android shell draws when sign-out was refused, wired the way
 * KinfolkPortalAppGuarded wires it (the dialog shows while
 * [SignOutFailure.message] is set and OK dismisses it).
 */
class SignOutFailedDialogTest {

    @Test
    fun aRefusedSignOut_isSaidInPlainWords_untilDismissed() = runComposeUiTest {
        val failure = SignOutFailure()
        setThemedContent {
            LaunchedEffect(Unit) {
                failure.run(cleanUp = {}, signOut = { throw IllegalStateException("auth backend down") }, reResolve = {})
            }
            failure.message?.let { SignOutFailedDialog(message = it, onDismiss = failure::dismiss) }
        }
        waitForIdle()
        onNodeWithText("Still signed in").assertIsDisplayed()
        onNodeWithText(SIGN_OUT_FAILED).assertIsDisplayed()
        onNodeWithText("auth backend down", substring = true).assertDoesNotExist()

        onNodeWithText("OK").performClick()
        waitForIdle()
        onNodeWithText(SIGN_OUT_FAILED).assertDoesNotExist()
        assertNull(failure.message)
    }

    @Test
    fun aSignOutThatWorked_drawsNoDialog() = runComposeUiTest {
        val failure = SignOutFailure()
        setThemedContent {
            LaunchedEffect(Unit) { failure.run(cleanUp = {}, signOut = {}, reResolve = {}) }
            failure.message?.let { SignOutFailedDialog(message = it, onDismiss = failure::dismiss) }
        }
        waitForIdle()
        onNodeWithText(SIGN_OUT_FAILED).assertDoesNotExist()
    }
}
