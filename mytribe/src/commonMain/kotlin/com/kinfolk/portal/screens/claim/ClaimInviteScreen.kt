package com.kinfolk.portal.screens.claim

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.auth.ACCOUNT_LOCKED_MESSAGE
import com.kinfolk.portal.auth.AccountLockedException
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.auth.WRONG_CREDENTIALS_MESSAGE
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Invite-claim funnel, reached from the welcome email
 * (`https://kinfolk.tribetails.com/claim?invite=<id>`, hash `#/claim/<id>`,
 * android intent, jvm `--claim=<id>`).
 *
 * Brand-new kinfolk have no account yet, so this screen first previews the
 * invite via the public `getInvitePreview` callable, then walks the
 * [ClaimStep] funnel: create account (set password) or sign in, then
 * `acceptInvite`. Decision logic lives in ClaimFlow.kt (commonTest-covered).
 */
@Composable
fun ClaimInviteScreen(
    inviteId: String,
    functions: FunctionsClient,
    repo: AuthRepository,
    onClaimed: (familyId: String) -> Unit,
    onCancel: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    val authState by repo.state.collectAsState()

    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    var previewError by remember { mutableStateOf<String?>(null) }
    var inFlight by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var signInMode by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    var claimedFamilyId by remember { mutableStateOf("") }
    var acceptedForUid by remember { mutableStateOf<String?>(null) }
    var resetting by remember { mutableStateOf(false) }
    var resetSent by remember { mutableStateOf(false) }

    LaunchedEffect(inviteId) {
        try {
            val raw = functions.call("getInvitePreview", buildJsonObject { put("inviteId", inviteId) })
            preview = InvitePreview(
                status = raw["status"]?.jsonPrimitive?.contentOrNull ?: "not_found",
                invitedEmail = raw["invitedEmail"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                tribeName = raw["tribeName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
        } catch (t: Throwable) {
            previewError = t.message ?: "Could not load this invite. Check your connection and try again."
        }
    }

    suspend fun accept() {
        val payload: JsonObject = buildJsonObject { put("inviteId", inviteId) }
        val raw = functions.call("acceptInvite", payload)
        claimedFamilyId = raw["familyId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        done = true
        onClaimed(claimedFamilyId)
    }

    val step: ClaimStep? = when {
        done -> null
        previewError != null -> null
        preview == null || authState is AuthState.Loading -> ClaimStep.Loading
        else -> stepForPreview(
            preview!!,
            signedIn = authState is AuthState.SignedIn,
            signedInEmail = (authState as? AuthState.SignedIn)?.email,
        )
    }

    // Signed in with the invited email (fresh signup, sign-in, or pre-existing
    // session): accept exactly once per uid.
    LaunchedEffect(step, (authState as? AuthState.SignedIn)?.uid) {
        val uid = (authState as? AuthState.SignedIn)?.uid ?: return@LaunchedEffect
        if (step is ClaimStep.AutoAccept && acceptedForUid != uid && !inFlight) {
            acceptedForUid = uid
            inFlight = true
            try {
                accept()
            } catch (t: Throwable) {
                actionError = t.message ?: "Could not accept invite"
                acceptedForUid = null
            } finally {
                inFlight = false
            }
        }
    }

    Box(
        modifier = Modifier.fillMaxSize().background(KinfolkBrand.Cream),
        contentAlignment = Alignment.Center,
    ) {
        Box(modifier = Modifier.fillMaxSize().background(KinfolkGradients.headerWash))
        GlassCard(
            modifier = Modifier.fillMaxWidth(0.86f).padding(KinfolkSpacing.l),
            contentPadding = PaddingValues(KinfolkSpacing.xl),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                when {
                    done -> {
                        Text("You're in!", style = type.heritageDisplay, textAlign = TextAlign.Center)
                        Text("Welcome to your Tribe.", style = type.sansBody, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(KinfolkSpacing.m))
                        Button(
                            onClick = { onClaimed(claimedFamilyId) },
                            colors = orangeButton(),
                        ) { Text("Enter MyTribe") }
                    }

                    previewError != null -> {
                        Text("Something went sideways", style = type.heritageTitle, textAlign = TextAlign.Center)
                        Text(previewError ?: "", style = type.sansBody, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(KinfolkSpacing.m))
                        Button(
                            onClick = {
                                previewError = null
                                preview = null
                                scope.launch {
                                    try {
                                        val raw = functions.call("getInvitePreview", buildJsonObject { put("inviteId", inviteId) })
                                        preview = InvitePreview(
                                            status = raw["status"]?.jsonPrimitive?.contentOrNull ?: "not_found",
                                            invitedEmail = raw["invitedEmail"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                                            tribeName = raw["tribeName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                                        )
                                    } catch (t: Throwable) {
                                        previewError = t.message ?: "Still couldn't load the invite."
                                    }
                                }
                            },
                            colors = orangeButton(),
                        ) { Text("Try Again") }
                    }

                    step is ClaimStep.InviteInvalid -> {
                        Text("Invite couldn't be opened", style = type.heritageTitle, textAlign = TextAlign.Center)
                        Text(step.message, style = type.sansBody, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(KinfolkSpacing.m))
                        OutlinedButton(onClick = onCancel) { Text("Go to sign in") }
                    }

                    step is ClaimStep.WrongAccount -> {
                        Text("This invite isn't for this account", style = type.heritageTitle, textAlign = TextAlign.Center)
                        Text(
                            "The invite was sent to ${step.invitedEmail}, but you're signed in as ${step.currentEmail}.",
                            style = type.sansBody,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(KinfolkSpacing.m))
                        Button(
                            onClick = { scope.launch { repo.signOut() } },
                            colors = orangeButton(),
                        ) { Text("Sign out and continue") }
                    }

                    step is ClaimStep.CreateAccount -> {
                        ClaimCreateAccount(
                            invitedEmail = step.invitedEmail,
                            tribeName = step.tribeName,
                            signInMode = signInMode,
                            inFlight = inFlight,
                            error = actionError,
                            onToggleMode = {
                                signInMode = !signInMode
                                actionError = null
                            },
                            onSubmit = { password ->
                                actionError = null
                                scope.launch {
                                    inFlight = true
                                    try {
                                        if (signInMode) {
                                            repo.signInWithEmailPassword(step.invitedEmail, password)
                                        } else {
                                            // Client-side signup is project-disabled; the server
                                            // mints the account off the live invite and returns a
                                            // custom token to sign in with.
                                            val raw = functions.call(
                                                "claimInviteSignup",
                                                buildJsonObject {
                                                    put("inviteId", inviteId)
                                                    put("password", password)
                                                },
                                            )
                                            val token = raw["token"]?.jsonPrimitive?.contentOrNull
                                                ?: throw IllegalStateException("No sign-in token returned")
                                            repo.signInWithCustomToken(token)
                                        }
                                        // AutoAccept LaunchedEffect fires on the new session.
                                    } catch (t: Throwable) {
                                        if (!signInMode && isEmailAlreadyInUse(t.message)) {
                                            signInMode = true
                                            actionError = "You already have an account. Enter your password to sign in."
                                        } else if (t is AccountLockedException) {
                                            // #886: names "Forgot password?", which this card now has.
                                            actionError = t.message ?: ACCOUNT_LOCKED_MESSAGE
                                        } else if (signInMode && repo.isCredentialFailure(t)) {
                                            actionError = WRONG_CREDENTIALS_MESSAGE
                                        } else {
                                            actionError = t.message ?: "Could not continue. Try again."
                                        }
                                    } finally {
                                        inFlight = false
                                    }
                                }
                            },
                            resetting = resetting,
                            resetSent = resetSent,
                            // #886: a locked invitee's way out, sent to the invited address
                            // the same way SignInScreen's link sends it.
                            onForgotPassword = {
                                resetSent = false
                                actionError = null
                                scope.launch {
                                    resetting = true
                                    try {
                                        repo.sendPasswordReset(step.invitedEmail)
                                        resetSent = true
                                    } catch (t: Throwable) {
                                        actionError = "Couldn't send reset email. Try again in a moment."
                                    } finally {
                                        resetting = false
                                    }
                                }
                            },
                        )
                    }

                    actionError != null -> {
                        // "Verify your email first" is a step, not a failure, so it
                        // does not get the failure heading. The server's own message
                        // is already actionable and names the address, so it is shown
                        // verbatim under either heading.
                        val needsVerification = isEmailUnverified(actionError)
                        Text(
                            if (needsVerification) "Confirm your email to join" else "Invite couldn't be accepted",
                            style = type.heritageDisplay,
                            textAlign = TextAlign.Center,
                        )
                        Text(actionError ?: "", style = type.sansBody, textAlign = TextAlign.Center)
                        if (needsVerification) {
                            Text(
                                "Your invite stays open in the meantime, so there is nothing to re-request.",
                                style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                                textAlign = TextAlign.Center,
                            )
                        }
                        Spacer(Modifier.height(KinfolkSpacing.m))
                        Button(
                            onClick = {
                                actionError = null
                                scope.launch {
                                    inFlight = true
                                    try {
                                        // Mint a fresh ID token BEFORE retrying. Clicking a
                                        // verification link flips the Firebase user record, but
                                        // the token this session already holds still says
                                        // email_verified false for up to an hour. Without this
                                        // an invitee who really did verify is refused again and
                                        // reads it as a broken link.
                                        repo.refreshIdToken()
                                        accept()
                                    } catch (t: Throwable) {
                                        actionError = t.message ?: "Try again later"
                                    } finally {
                                        inFlight = false
                                    }
                                }
                            },
                            colors = orangeButton(),
                            enabled = !inFlight,
                        ) {
                            Text(
                                when {
                                    inFlight -> "Trying…"
                                    needsVerification -> "I've confirmed it"
                                    else -> "Try Again"
                                },
                            )
                        }
                        OutlinedButton(onClick = onCancel) { Text("Skip for now") }
                    }

                    else -> {
                        Text(
                            if (step is ClaimStep.AutoAccept) "Accepting invite…" else "Opening your invite…",
                            style = type.heritageTitle,
                            textAlign = TextAlign.Center,
                        )
                        CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
                    }
                }
            }
        }
    }
}

/** Create-account (set password) module, with a sign-in mode for returning kinfolk. */
@Composable
private fun ClaimCreateAccount(
    invitedEmail: String,
    tribeName: String,
    signInMode: Boolean,
    inFlight: Boolean,
    error: String?,
    onToggleMode: () -> Unit,
    onSubmit: (password: String) -> Unit,
    resetting: Boolean = false,
    resetSent: Boolean = false,
    onForgotPassword: () -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text(
            if (tribeName.isNotBlank()) "Welcome to the Tribe, $tribeName" else "Welcome to the Tribe",
            style = type.heritageDisplay,
            textAlign = TextAlign.Center,
        )
        Text(
            if (signInMode) "Sign in to claim your invite." else "Set a password to finish creating your account.",
            style = type.sansBody,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(KinfolkSpacing.xs))
        Text(invitedEmail, style = type.sansMeta, textAlign = TextAlign.Center)
        Spacer(Modifier.height(KinfolkSpacing.s))

        ClaimPasswordField(
            value = password,
            onValueChange = { password = it; localError = null },
            label = if (signInMode) "Password" else "Choose a password",
            visible = reveal,
            onToggleVisible = { reveal = !reveal },
        )
        if (!signInMode) {
            ClaimPasswordField(
                value = confirm,
                onValueChange = { confirm = it; localError = null },
                label = "Confirm password",
                visible = reveal,
                onToggleVisible = { reveal = !reveal },
            )
        }

        (localError ?: error)?.let {
            Spacer(Modifier.height(KinfolkSpacing.xs))
            Text(it, style = type.sansBody.copy(color = KinfolkBrand.KinfolkOrange), textAlign = TextAlign.Center)
        }

        Spacer(Modifier.height(KinfolkSpacing.m))
        Button(
            onClick = {
                if (!signInMode) {
                    val problem = validateNewPassword(password, confirm)
                    if (problem != null) {
                        localError = problem
                        return@Button
                    }
                }
                onSubmit(password)
            },
            colors = orangeButton(),
            enabled = !inFlight && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                when {
                    inFlight -> "Working…"
                    signInMode -> "Sign in & join"
                    else -> "Create account & join"
                },
            )
        }
        if (signInMode) {
            // #886: the reset path a locked account's message names. Sent to the
            // invited address, which is the only account this card signs in.
            Text(
                if (resetting) "Sending reset link…" else "Forgot password?",
                style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange),
                modifier = Modifier.clickable(enabled = !resetting && !inFlight, onClick = onForgotPassword),
            )
            if (resetSent) {
                Text("Reset link sent. Check your inbox.", style = type.sansMeta, textAlign = TextAlign.Center)
            }
        }
        Text(
            if (signInMode) "New here? Set a password instead" else "Already have a password? Sign in",
            style = type.sansMeta,
            modifier = Modifier.clickable(onClick = onToggleMode),
        )
    }
}

/**
 * Masked password input matching SignInScreen's KinField look: top label,
 * BasicTextField, focus-glow hairline, tappable eye reveal.
 */
@Composable
private fun ClaimPasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    visible: Boolean,
    onToggleVisible: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()

    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = type.sansMeta.copy(color = if (focused) c.primary else c.navyMuted),
        )
        Spacer(Modifier.height(4.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                cursorBrush = SolidColor(c.primary),
                textStyle = type.sansBody.copy(color = c.navy),
                interactionSource = source,
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier.size(32.dp).clickable(onClick = onToggleVisible),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (visible) "🙈" else "👁",
                    style = type.sansBody.copy(color = c.navyMuted),
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (focused) 1.5.dp else 1.dp)
                .background(if (focused) c.primary else c.navyHairline),
        )
    }
}

@Composable
private fun orangeButton() = ButtonDefaults.buttonColors(
    containerColor = KinfolkBrand.KinfolkOrange,
    contentColor = Color.White,
)
