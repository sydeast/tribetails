@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.claim

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.AuthProviderId
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.auth.SIGN_OUT_FAILED
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/** Backend whose currentUser is fixed; password calls echo a signed-in state. */
private class ClaimFakeBackend(
    private val current: AuthState,
    private val onSignOut: suspend () -> Unit = {},
) : AuthBackend {
    override suspend fun currentUser(): AuthState = current
    override suspend fun signInWithEmailPassword(email: String, password: String) =
        AuthState.SignedIn("u-signin", email, null)
    override suspend fun signInWithCustomToken(token: String) =
        AuthState.SignedIn("u-new", "kin@example.com", null)
    override suspend fun sendMagicLink(email: String) = Unit
    override suspend fun signInWithMagicLink(email: String, link: String) =
        AuthState.SignedIn("u-magic", email, null)
    override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
        AuthState.SignedIn("u-idp", null, null)
    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) =
        AuthState.SignedIn("u-otp", null, null)
    override suspend fun signOut() = onSignOut()
    override suspend fun sendPasswordReset(email: String) = Unit
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
}

private fun validPreviewStub(fake: FakeFunctionsClient, email: String = "kin@example.com") {
    fake.stub(
        "getInvitePreview",
        buildJsonObject {
            put("status", "valid")
            put("invitedEmail", email)
            put("tribeName", "The Parkers")
        },
    )
}

class ClaimInviteScreenTest {

    @Test
    fun signedInMatchingEmail_autoAccepts_callsOnClaimed() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake)
        fake.stub("acceptInvite", buildJsonObject { put("familyId", "demo-1") })
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedIn("u1", "kin@example.com", null)))
        var claimedFamilyId: String? = null
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(
                inviteId = "inv-1",
                functions = fake,
                repo = repo,
                onClaimed = { claimedFamilyId = it },
                onCancel = {},
            )
        }
        waitForIdle()
        onNodeWithText("You're in!").assertIsDisplayed()
        assertEquals("demo-1", claimedFamilyId)
    }

    @Test
    fun signedOut_showsCreateAccountModuleWithLockedEmail() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake)
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedOut))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Welcome to the Tribe, The Parkers").assertIsDisplayed()
        onNodeWithText("kin@example.com").assertIsDisplayed()
        onNodeWithText("Create account & join").assertIsDisplayed()
        onNodeWithText("Already have a password? Sign in").assertIsDisplayed()
    }

    @Test
    fun signedInDifferentEmail_showsWrongAccountWithSignOut() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake)
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedIn("op", "auntie@tribetails.com", null)))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("This invite isn't for this account").assertIsDisplayed()
        onNodeWithText("Sign out and continue").assertIsDisplayed()
    }

    /** #2140: a refused sign-out used to throw into a bare launch and say nothing. */
    @Test
    fun wrongAccount_signOutRefused_saysSoAndLeavesTheButtonUsable() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake, email = "pawsome@hanasamku.com")
        var attempts = 0
        val repo = AuthRepository(
            ClaimFakeBackend(AuthState.SignedIn("op", "catch@hanasamku.com", null)) {
                attempts += 1
                throw IllegalStateException("auth/network-request-failed")
            },
        )
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Sign out and continue").performClick()
        waitForIdle()
        onNodeWithText(SIGN_OUT_FAILED).assertIsDisplayed()
        onNodeWithText("auth/network-request-failed", substring = true).assertDoesNotExist()
        onNodeWithText("This invite isn't for this account").assertIsDisplayed()
        onNodeWithText("Sign out and continue").assertIsEnabled().performClick()
        waitForIdle()
        assertEquals(2, attempts)
    }
    @Test
    fun wrongAccount_signOut_showsAWaitWhileItRuns() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake, email = "pawsome@hanasamku.com")
        val gate = CompletableDeferred<Unit>()
        var attempts = 0
        val repo = AuthRepository(
            ClaimFakeBackend(AuthState.SignedIn("op", "catch@hanasamku.com", null)) {
                attempts += 1
                gate.await()
            },
        )
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Sign out and continue").performClick()
        waitForIdle()
        onNodeWithText("Signing out…").assertIsDisplayed().assertIsNotEnabled().performClick()
        waitForIdle()
        assertEquals(1, attempts)
        onNodeWithText(SIGN_OUT_FAILED).assertDoesNotExist()
        gate.complete(Unit)
        waitForIdle()
    }
    @Test
    fun expiredInvite_showsTerminalMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getInvitePreview", buildJsonObject { put("status", "expired") })
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedOut))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Invite couldn't be opened").assertIsDisplayed()
        onNodeWithText("This invite has expired. Ask Auntie to send a fresh one.").assertIsDisplayed()
    }

    @Test
    fun acceptFailure_rendersFailureCardAndAllowsRetry() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake)
        fake.stubError("acceptInvite", IllegalStateException("invite expired"))
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedIn("u1", "kin@example.com", null)))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-bad", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Invite couldn't be accepted").assertIsDisplayed()
        onNodeWithText("invite expired").assertIsDisplayed()
        onNodeWithText("Try Again").assertIsDisplayed()
        onNodeWithText("Skip for now").assertIsDisplayed()
    }

    @Test
    fun success_showsEnterMyTribeCta() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        validPreviewStub(fake)
        fake.stub("acceptInvite", buildJsonObject { put("familyId", "demo-1") })
        val repo = AuthRepository(ClaimFakeBackend(AuthState.SignedIn("u1", "kin@example.com", null)))
        setThemedContent {
            LaunchedEffect(Unit) { repo.refresh() }
            ClaimInviteScreen(inviteId = "inv-1", functions = fake, repo = repo, onClaimed = {}, onCancel = {})
        }
        waitForIdle()
        onNodeWithText("Enter MyTribe").assertIsDisplayed()
    }
}
