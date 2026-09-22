@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.claim

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.auth.ACCOUNT_LOCKED_MESSAGE
import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.AuthProviderId
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.auth.SignInFailureKind
import com.kinfolk.portal.auth.WRONG_CREDENTIALS_MESSAGE
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #886: a returning invitee who signs in on the claim card. A locked account
 * gets the locked message AND a working "Forgot password?" on this card (the
 * message names it), and a wrong password gets the plain wrong-credentials line
 * rather than the SDK's text.
 */
private class ClaimRefusingBackend(
    private val failure: Throwable,
    private val kind: SignInFailureKind,
) : AuthBackend {
    val resets = mutableListOf<String>()
    override fun classifySignInFailure(t: Throwable): SignInFailureKind = kind
    override suspend fun currentUser(): AuthState = AuthState.SignedOut
    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn = throw failure
    override suspend fun signInWithCustomToken(token: String) = AuthState.SignedIn("u", null, null)
    override suspend fun sendMagicLink(email: String) = Unit
    override suspend fun signInWithMagicLink(email: String, link: String) = AuthState.SignedIn("u", email, null)
    override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
        AuthState.SignedIn("u", null, null)
    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) = AuthState.SignedIn("u", null, null)
    override suspend fun signOut() = Unit
    override suspend fun sendPasswordReset(email: String, continueUrl: String?) {
        resets += email
    }
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
}

class ClaimInviteLockedTest {

    private fun ComposeUiTest.signInOnClaimCard(backend: ClaimRefusingBackend) {
        val fake = FakeFunctionsClient()
        fake.stub(
            "getInvitePreview",
            buildJsonObject {
                put("status", "valid")
                put("invitedEmail", "kin@example.com")
                put("tribeName", "The Parkers")
            },
        )
        val repo = AuthRepository(backend)
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Already have a password? Sign in").performClick()
        waitForIdle()
        onAllNodes(hasSetTextAction())[0].performTextInput("right-password")
        onNodeWithText("Sign in & join").performClick()
        waitForIdle()
    }

    @Test
    fun aLockedInvitee_seesTheLockedMessage_andTheResetLinkOnThisCardWorks() = runComposeUiTest {
        val backend = ClaimRefusingBackend(RuntimeException("This account is locked."), SignInFailureKind.Locked)
        signInOnClaimCard(backend)

        onNodeWithText(ACCOUNT_LOCKED_MESSAGE).assertExists()
        onNodeWithText("Forgot password?").assertExists().assertHasClickAction().performClick()
        waitForIdle()

        assertEquals(listOf("kin@example.com"), backend.resets)
        onNodeWithText("Reset link sent. Check your inbox.").assertExists()
    }

    @Test
    fun aWrongPassword_onTheClaimCard_showsThePlainWrongCredentialsLine() = runComposeUiTest {
        signInOnClaimCard(
            ClaimRefusingBackend(RuntimeException("Firebase: Error (auth/invalid-credential)."), SignInFailureKind.Credentials),
        )
        onNodeWithText(WRONG_CREDENTIALS_MESSAGE).assertExists()
        onNodeWithText("Firebase: Error (auth/invalid-credential).").assertDoesNotExist()
    }

    @Test
    fun theResetLink_isOnlyOnTheSignInModeCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "getInvitePreview",
            buildJsonObject {
                put("status", "valid")
                put("invitedEmail", "kin@example.com")
                put("tribeName", "The Parkers")
            },
        )
        val repo = AuthRepository(ClaimRefusingBackend(RuntimeException("unused"), SignInFailureKind.Other))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        // Creating a new account has no password to forget.
        onNodeWithText("Create account & join").assertExists()
        onNodeWithText("Forgot password?").assertDoesNotExist()
    }
}
