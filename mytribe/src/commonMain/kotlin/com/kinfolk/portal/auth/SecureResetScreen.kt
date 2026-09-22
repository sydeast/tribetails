package com.kinfolk.portal.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import com.kinfolk.portal.util.SecureResetParams
import com.kinfolk.portal.util.openExternalUrl

/**
 * The portal app's Firebase email action handler (#905), on the contract the
 * portal web page has carried since PR #903.
 *
 * The project has one email action URL, so every Firebase auth email opens this
 * screen: password resets from every client, email verification, email-change
 * confirmations and email-change rollbacks. Staff land here too, so the copy
 * never assumes a household.
 *
 * What changed from the screen this replaces:
 *
 * - It no longer trusts an `email` query param. The address shown is the one
 *   the verified code belongs to, read with [EmailActionAuth.readActionCode].
 * - A normal reset sets the password through the auth SDK and files NO security
 *   incident. The old screen filed one for every link that reached it, which is
 *   the defect #903 fixed on web.
 * - "I did not ask for this reset" is an explicit choice on the form, and only
 *   that choice calls `confirmSecureReset`.
 * - Expired, used and invalid codes each say which one they are and offer to
 *   send a new link. A network failure offers a retry.
 *
 * Every decision lives in [SecureResetController]; this file renders its
 * [ActionPhase].
 *
 * @param onSignIn Takes the reader to the app's own sign-in screen. Used for a
 *                 link that continues to the portal, and for the household half
 *                 of a link that names no audience.
 */
@Composable
fun SecureResetScreen(
    oobCode: String,
    repo: AuthRepository,
    onSignIn: () -> Unit,
    mode: String = EmailAction.MODE_RESET,
    continueUrl: String? = null,
    fetcher: SecureResetFetcher = remember { makeSecureResetFetcher() },
    openUrl: (String) -> Unit = { openExternalUrl(it) },
) {
    val auth = remember(repo) { repo.emailActionAuth() }
    SecureResetScreen(
        // The allowlist runs here, not only in parseEmailActionUrl. A
        // `navDeepLink<SecureResetRoute>` builds this route straight off the raw
        // query string, so on Android the route can reach the screen without
        // ever passing through the parser, carrying whatever `continueUrl` the
        // link named. Sanitising at the receiver means there is no way in that
        // skips it.
        link = SecureResetParams(
            oobCode = oobCode,
            mode = mode,
            continueUrl = safeContinueUrl(continueUrl),
        ),
        auth = auth,
        fetcher = fetcher,
        onSignIn = onSignIn,
        openUrl = openUrl,
    )
}

/** The injectable form. Tests drive this one with a fake [EmailActionAuth]. */
@Composable
fun SecureResetScreen(
    link: SecureResetParams,
    auth: EmailActionAuth,
    fetcher: SecureResetFetcher,
    onSignIn: () -> Unit,
    openUrl: (String) -> Unit = { openExternalUrl(it) },
) {
    val scope = rememberCoroutineScope()
    val controller = remember(link.oobCode, link.mode) {
        SecureResetController(link = link, auth = auth, fetcher = fetcher, scope = scope)
    }
    LaunchedEffect(controller) { controller.load() }

    Box(modifier = Modifier.fillMaxSize().background(KinfolkGradients.tribe)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
        ) {
            Wordmark()
            ActionBody(controller, onSignIn, openUrl)
            Text(
                text = "Cared for by Tribe Tails Pet Care",
                style = KinfolkTheme.typography.sansMeta.copy(color = Color.White.copy(alpha = 0.72f)),
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ActionBody(
    controller: SecureResetController,
    onSignIn: () -> Unit,
    openUrl: (String) -> Unit,
) {
    when (val phase = controller.phase) {
        ActionPhase.Checking -> Busy("Checking your link…")

        ActionPhase.Incomplete -> Notice(
            title = "This link is incomplete.",
            body = "Open the link from your email again. If it still does not work, ask for a new one " +
                "from the sign-in screen.",
        )

        ActionPhase.Unsupported, ActionPhase.Mismatch -> Notice(
            title = "This link can't be completed here.",
            body = "Go back to the app or site where you started and try again from there.",
        )

        ActionPhase.NotOnThisDevice -> NotOnThisDevice(controller, openUrl)

        is ActionPhase.Problem -> when {
            phase.problem == CodeProblem.Unreachable -> Unreachable(controller)
            controller.mode == EmailAction.MODE_RESET -> ExpiredReset(controller, phase.problem)
            else -> Notice(
                title = if (phase.problem == CodeProblem.Expired) {
                    "This link has expired."
                } else {
                    "This link has already been used or is not valid."
                },
                body = "Go back to where you started and ask for a new link.",
            )
        }

        is ActionPhase.ResetReady -> ResetForm(controller, phase.email)

        is ActionPhase.EmailReady -> EmailApply(controller, phase.email)

        is ActionPhase.ResetDone -> Success(
            title = if (phase.secured) "Your account is secured." else "Your password is updated.",
            note = if (phase.secured) {
                "Your new password is set, and Tribe Tails has been alerted to look into the reset " +
                    "you did not ask for."
            } else {
                null
            },
            signInLabel = "Sign in with your new password",
            controller = controller,
            onSignIn = onSignIn,
            openUrl = openUrl,
        )

        is ActionPhase.EmailDone -> EmailDone(controller, phase.email, onSignIn, openUrl)
    }
}

// ── Reset ────────────────────────────────────────────────────────────────────

@Composable
private fun ResetForm(controller: SecureResetController, email: String) {
    val type = KinfolkTheme.typography
    val c = KinfolkTheme.colors
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    val secure = controller.intent == ResetIntent.Secure

    Card {
        if (secure) {
            AlertBanner(
                title = "Secure your account",
                body = "Someone may be trying to get into your account. Set a new password now, and " +
                    "Tribe Tails will be alerted to look into it.",
            )
        } else {
            Text(
                text = "Set a new password",
                style = type.heritageTitle,
                modifier = Modifier.testTag("reset-heading"),
            )
            Text(
                text = "For $email",
                style = type.sansMeta.copy(color = c.navyMuted, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.testTag("reset-account"),
            )
        }

        Spacer(Modifier.height(KinfolkSpacing.s))
        MaskedField(
            value = newPassword,
            onValueChange = { newPassword = it; controller.clearFormError() },
            label = "New password",
            visible = reveal,
            onToggleVisible = { reveal = !reveal },
            enabled = !controller.busy,
            testTag = "new-password",
        )
        MaskedField(
            value = confirmPassword,
            onValueChange = { confirmPassword = it; controller.clearFormError() },
            label = "Confirm new password",
            visible = reveal,
            onToggleVisible = { reveal = !reveal },
            enabled = !controller.busy,
            testTag = "confirm-password",
        )
        controller.formError?.let { ProblemText(it, "form-error") }
        controller.serverError?.let { ProblemText(it, "server-error") }

        Spacer(Modifier.height(KinfolkSpacing.s))
        PrimaryButton(
            label = when {
                controller.busy && secure -> "Securing…"
                controller.busy -> "Saving…"
                secure -> "Secure my account"
                else -> "Set new password"
            },
            busy = controller.busy,
            enabled = !controller.busy,
            testTag = "reset-submit",
            onClick = { controller.submit(newPassword, confirmPassword) },
        )
        // The only door to confirmSecureReset. A normal reset files no incident,
        // so this has to be a choice the reader makes on purpose.
        TextLink(
            label = if (secure) "Go back" else "I did not ask for this reset",
            enabled = !controller.busy,
            testTag = "intent-toggle",
            onClick = { controller.toggleIntent() },
        )
    }
}

/** An expired or used reset link, with the address box that sends a fresh one. */
@Composable
private fun ExpiredReset(controller: SecureResetController, problem: CodeProblem) {
    val expired = problem == CodeProblem.Expired
    var email by remember { mutableStateOf("") }

    Card {
        AlertBanner(
            title = if (expired) {
                "This reset link has expired."
            } else {
                "This reset link has already been used or is not valid."
            },
            body = if (expired) {
                "Reset links only work for a short time. Enter your email and we will send a new one."
            } else {
                "Each reset link works once. Enter your email and we will send a new one."
            },
        )
        Spacer(Modifier.height(KinfolkSpacing.s))

        if (controller.resend == SendState.Sent) {
            Text(
                text = "A new link is on its way. Check your inbox, and open the newest email.",
                style = KinfolkTheme.typography.sansBody,
                modifier = Modifier.testTag("resend-sent"),
            )
        } else {
            PlainField(
                value = email,
                onValueChange = { email = it; controller.clearResendState() },
                label = "Email address",
                enabled = controller.resend != SendState.Sending,
                testTag = "resend-email",
            )
            when (controller.resend) {
                SendState.Missing -> ProblemText("Type the email you sign in with.", "resend-problem")
                SendState.Failed -> ProblemText("We couldn't send a new link. Try again in a moment.", "resend-problem")
                else -> Unit
            }
            Spacer(Modifier.height(KinfolkSpacing.s))
            PrimaryButton(
                label = if (controller.resend == SendState.Sending) "Sending…" else "Send a new link",
                busy = controller.resend == SendState.Sending,
                enabled = controller.resend != SendState.Sending,
                testTag = "resend-submit",
                onClick = { controller.sendNewLink(email) },
            )
        }
    }
}

// ── Verify, change and recover ───────────────────────────────────────────────

@Composable
private fun EmailApply(controller: SecureResetController, email: String?) {
    val type = KinfolkTheme.typography
    val c = KinfolkTheme.colors
    Card {
        Text(
            text = when {
                controller.isRecover -> "Restore your sign-in email"
                controller.isChange -> "Confirm your new sign-in email"
                else -> "Confirm your email address"
            },
            style = type.heritageTitle,
            modifier = Modifier.testTag("email-heading"),
        )
        if (email != null) {
            Text(
                text = if (controller.isRecover) "Change it back to $email" else "For $email",
                style = type.sansMeta.copy(color = c.navyMuted, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.testTag("email-account"),
            )
        }
        controller.serverError?.let { ProblemText(it, "server-error") }
        Spacer(Modifier.height(KinfolkSpacing.s))
        PrimaryButton(
            label = when {
                controller.busy -> "Saving…"
                controller.isRecover -> "Restore my sign-in email"
                else -> "Confirm this email address"
            },
            busy = controller.busy,
            enabled = !controller.busy,
            testTag = "email-apply",
            onClick = { controller.apply() },
        )
    }
}

@Composable
private fun EmailDone(
    controller: SecureResetController,
    email: String?,
    onSignIn: () -> Unit,
    openUrl: (String) -> Unit,
) {
    val type = KinfolkTheme.typography
    val title = when {
        controller.isRecover -> "Your sign-in email is back to ${email ?: "what it was"}."
        controller.isChange -> "Your sign-in email is now ${email ?: "updated"}."
        else -> "Your email address is confirmed."
    }
    Card {
        SuccessBox(title)
        if (controller.isRecover && email != null) {
            Spacer(Modifier.height(KinfolkSpacing.s))
            Text(
                text = "If you did not change your email, someone else may have. Reset your password now.",
                style = type.sansBody,
            )
            if (controller.recoveryReset == SendState.Sent) {
                Text(
                    text = "A reset link is on its way. Check your inbox.",
                    style = type.sansBody,
                    modifier = Modifier.testTag("recovery-reset-sent"),
                )
            } else {
                Spacer(Modifier.height(KinfolkSpacing.s))
                PrimaryButton(
                    label = if (controller.recoveryReset == SendState.Sending) {
                        "Sending…"
                    } else {
                        "Send me a password reset link"
                    },
                    busy = controller.recoveryReset == SendState.Sending,
                    enabled = controller.recoveryReset != SendState.Sending,
                    testTag = "recovery-reset",
                    onClick = { controller.sendRecoveryReset() },
                )
                if (controller.recoveryReset == SendState.Failed) {
                    ProblemText("We couldn't send the reset link. Try again in a moment.", "recovery-reset-problem")
                }
            }
        }
        SignInLinks(controller.continueUrl, "Go to sign in", onSignIn, openUrl)
    }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/** Desktop: no way to check a code here, so nothing is set and nothing is filed. */
@Composable
private fun NotOnThisDevice(controller: SecureResetController, openUrl: (String) -> Unit) {
    Card {
        AlertBanner(
            title = "Open this link in a web browser.",
            body = "This app can't finish email links. The same link works in a browser, on this " +
                "computer or on your phone.",
        )
        Spacer(Modifier.height(KinfolkSpacing.s))
        PrimaryButton(
            label = "Open it in my browser",
            busy = false,
            enabled = true,
            testTag = "open-in-browser",
            onClick = { openUrl(controller.webUrl) },
        )
    }
}

@Composable
private fun Unreachable(controller: SecureResetController) {
    Card {
        AlertBanner(
            title = "We couldn't check this link.",
            body = "Check your connection, then try again. The link itself may still be fine.",
        )
        Spacer(Modifier.height(KinfolkSpacing.s))
        PrimaryButton(
            label = "Try again",
            busy = false,
            enabled = true,
            testTag = "retry",
            onClick = { controller.retry() },
        )
    }
}

@Composable
private fun Success(
    title: String,
    note: String?,
    signInLabel: String,
    controller: SecureResetController,
    onSignIn: () -> Unit,
    openUrl: (String) -> Unit,
) {
    Card {
        SuccessBox(title)
        if (note != null) {
            Spacer(Modifier.height(KinfolkSpacing.s))
            Text(text = note, style = KinfolkTheme.typography.sansBody)
        }
        SignInLinks(controller.continueUrl, signInLabel, onSignIn, openUrl)
    }
}

/**
 * Where to go next.
 *
 * A link that names a continue target already said whose account this is, so it
 * gets one link. A bare link cannot tell a household from staff (the verified
 * code carries only an email), so both sign-ins are offered, each named. The
 * portal's own sign-in is a screen in this app; the staff one is a web address.
 */
@Composable
private fun SignInLinks(
    continueUrl: String?,
    label: String,
    onSignIn: () -> Unit,
    openUrl: (String) -> Unit,
) {
    Spacer(Modifier.height(KinfolkSpacing.s))
    when (audienceOf(continueUrl)) {
        EmailActionAudience.Staff ->
            TextLink(label, enabled = true, testTag = "staff-sign-in") { openUrl(continueUrl!!) }
        EmailActionAudience.Kinfolk ->
            TextLink(label, enabled = true, testTag = "portal-sign-in") { onSignIn() }
        EmailActionAudience.Unknown -> {
            TextLink("Household sign-in", enabled = true, testTag = "portal-sign-in") { onSignIn() }
            TextLink("Staff sign-in", enabled = true, testTag = "staff-sign-in") {
                openUrl(EmailAction.STAFF_SIGN_IN_URL)
            }
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(KinfolkSpacing.m),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
        ) { content() }
    }
}

@Composable
private fun Wordmark() {
    Text(
        text = "Tribe Tails",
        style = KinfolkTheme.typography.heritageTitle.copy(
            color = Color.White,
            fontWeight = FontWeight.SemiBold,
        ),
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun Busy(label: String) {
    Card {
        Row(
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = KinfolkBrand.KinfolkOrange,
                strokeWidth = 2.dp,
            )
            Text(text = label, style = KinfolkTheme.typography.sansBody)
        }
    }
}

@Composable
private fun Notice(title: String, body: String) {
    Card { AlertBanner(title, body) }
}

@Composable
private fun AlertBanner(title: String, body: String) {
    val type = KinfolkTheme.typography
    val c = KinfolkTheme.colors
    val alert = KinfolkBrand.SnuggleCoral
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(alert.copy(alpha = 0.10f), KinfolkShapes.cardSmall)
            .border(1.dp, alert.copy(alpha = 0.35f), KinfolkShapes.cardSmall)
            .padding(KinfolkSpacing.m),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text(text = "🛡", style = type.sansBody)
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                Text(
                    text = title,
                    style = type.heritageSection.copy(color = alert),
                    modifier = Modifier.testTag("notice-title"),
                )
                Text(text = body, style = type.sansBody.copy(color = c.navySoft))
            }
        }
    }
}

@Composable
private fun SuccessBox(title: String) {
    val type = KinfolkTheme.typography
    Row(
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(KinfolkBrand.KinfolkOrange.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = "✓", style = type.sansBody.copy(color = KinfolkBrand.KinfolkOrange))
        }
        Text(
            text = title,
            style = type.heritageSection,
            modifier = Modifier.testTag("success-title"),
        )
    }
}

@Composable
private fun ProblemText(message: String, testTag: String) {
    Text(
        text = message,
        style = KinfolkTheme.typography.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
        modifier = Modifier.testTag(testTag),
    )
}

@Composable
private fun PrimaryButton(
    label: String,
    busy: Boolean,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.pill)
            .background(
                if (enabled) {
                    KinfolkGradients.orangeToPink
                } else {
                    SolidColor(KinfolkBrand.KinfolkOrange.copy(alpha = 0.45f))
                },
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 14.dp)
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    color = Color.White,
                    strokeWidth = 2.dp,
                )
            }
            Text(
                text = label,
                style = KinfolkTheme.typography.sansButton.copy(
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                ),
            )
        }
    }
}

@Composable
private fun TextLink(label: String, enabled: Boolean, testTag: String, onClick: () -> Unit) {
    Text(
        text = label,
        style = KinfolkTheme.typography.sansMeta.copy(color = KinfolkBrand.KinfolkOrange),
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick).testTag(testTag),
    )
}

/** Masked input matching ClaimInviteScreen's field: top label, reveal eye, hairline. */
@Composable
private fun MaskedField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    visible: Boolean,
    onToggleVisible: () -> Unit,
    enabled: Boolean,
    testTag: String,
) {
    Field(label = label, testTag = testTag) { source, textStyle, cursor ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                enabled = enabled,
                cursorBrush = cursor,
                textStyle = textStyle,
                interactionSource = source,
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = Modifier.weight(1f).testTag("$testTag-input"),
            )
            Box(
                modifier = Modifier.size(32.dp).clickable(onClick = onToggleVisible),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (visible) "🙈" else "👁",
                    style = KinfolkTheme.typography.sansBody.copy(color = KinfolkTheme.colors.navyMuted),
                )
            }
        }
    }
}

@Composable
private fun PlainField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    testTag: String,
) {
    Field(label = label, testTag = testTag) { source, textStyle, cursor ->
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            enabled = enabled,
            cursorBrush = cursor,
            textStyle = textStyle,
            interactionSource = source,
            modifier = Modifier.fillMaxWidth().testTag("$testTag-input"),
        )
    }
}

@Composable
private fun Field(
    label: String,
    testTag: String,
    content: @Composable (
        source: MutableInteractionSource,
        textStyle: TextStyle,
        cursor: SolidColor,
    ) -> Unit,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    Column(modifier = Modifier.fillMaxWidth().testTag(testTag)) {
        Text(text = label, style = type.sansMeta.copy(color = c.navyMuted))
        Spacer(Modifier.height(4.dp))
        content(source, type.sansBody.copy(color = c.navy), SolidColor(c.primary))
        Spacer(Modifier.height(6.dp))
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(c.navyHairline))
    }
}

/**
 * Returns the platform's user-agent string for the incident audit record.
 * On web this is the browser UA; on Android/JVM returns a descriptive stub.
 */
expect fun platformUserAgent(): String
