package com.tribetails.auntieos.web.screens.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.PasswordResetResult
import com.tribetails.auntieos.web.data.SessionEndedNotice
import com.tribetails.auntieos.web.data.SignInResult
import com.tribetails.auntieos.web.data.platformMountSignInAutofill
import com.tribetails.auntieos.web.data.platformSetSignInAutofillValues
import com.tribetails.auntieos.web.data.platformSubmitSignInAutofill
import com.tribetails.auntieos.web.data.platformUnmountSignInAutofill
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntiePasswordField
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.ui.shaders.meshGradientBackground
import com.tribetails.auntieos.web.ui.shaders.rememberMeshPointer
import kotlinx.coroutines.launch

private const val MISSING_EMAIL_MSG = "Enter your email."
private const val MISSING_PASSWORD_MSG = "Enter your password."
private const val RESET_NEEDS_EMAIL_MSG = "Type your email above first."
/**
 * What each field has to say about itself (#1600). A null is a field that is
 * fine. Shown under the field in a line the form always reserves, replacing the
 * one toast that named both fields and highlighted neither.
 */
internal data class SignInFieldErrors(val email: String? = null, val password: String? = null) {
    val any: Boolean get() = email != null || password != null
}
internal fun signInFieldErrors(email: String, password: String): SignInFieldErrors = SignInFieldErrors(
    email = if (email.isBlank()) MISSING_EMAIL_MSG else null,
    password = if (password.isEmpty()) MISSING_PASSWORD_MSG else null,
)
internal fun resetEmailFieldError(email: String): String? =
    if (email.isBlank()) RESET_NEEDS_EMAIL_MSG else null
@Composable
fun SignInScreen(
    auth: AuthClient,
    onSignedIn: (AuthUser) -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    // Den background: brand-tinted blobs drifting behind the glass card,
    // matching the animated mesh in the sign-in mockup.
    val pointer = rememberMeshPointer()

    var email      by remember { mutableStateOf("") }
    var password   by remember { mutableStateOf("") }
    // 02-sign-in item 2: explicit Email -> Password traversal chain.
    val emailFocus    = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    var loading    by remember { mutableStateOf(false) }
    var resetting  by remember { mutableStateOf(false) }
    var toast      by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    var fieldErrors by remember { mutableStateOf(SignInFieldErrors()) }

    /**
     * Issue #573: why the operator is looking at this screen, when they did not
     * ask to be.
     *
     * A revoked or disabled session is signed out from inside the callable seam
     * (`RevocationAwareCallables`), several layers below anything holding UI
     * state, and `App.kt`'s auth gate then drops the whole app back here on its
     * own. Without this, the console simply vanishes mid-task and a login form
     * appears, which reads as the app having broken rather than as a session
     * having ended.
     *
     * `consume()` clears as it reads, so a recomposition or a later visit to
     * this screen is quiet. Keyed on `Unit`, because the notice belongs to the
     * arrival and not to anything the operator types afterwards.
     */
    LaunchedEffect(Unit) {
        SessionEndedNotice.consume()?.let { toast = it to ToastKind.Error }
    }

    // 02-sign-in item 1: mount the hidden autofill <form> while this screen is shown so
    // a password manager can offer to fill; route fills back into Compose state. No-op
    // on desktop. Keep the DOM inputs in sync as the user types in the canvas fields.
    DisposableEffect(Unit) {
        platformMountSignInAutofill { e, p -> email = e; password = p }
        onDispose { platformUnmountSignInAutofill() }
    }
    LaunchedEffect(email, password) { platformSetSignInAutofillValues(email, password) }

    fun submit() {
        // Enter and the keyboard's Done key bypass the disabled button: one sign-in at a time,
        // and none while a password reset is running.
        if (loading || resetting) return
        val missing = signInFieldErrors(email, password)
        fieldErrors = missing
        if (missing.any) {
            toast = null
            (if (missing.email != null) emailFocus else passwordFocus).requestFocus()
            return
        }
        loading = true
        scope.launch {
            when (val r = auth.signIn(email.trim(), password)) {
                is SignInResult.Ok      -> {
                    if (auth.isCurrentUserAdmin(forceRefresh = true)) {
                        // 02-sign-in item 1: nudge the password manager to SAVE this
                        // (now-validated) credential by submitting the hidden autofill form.
                        platformSetSignInAutofillValues(email.trim(), password)
                        platformSubmitSignInAutofill()
                        onSignedIn(r.user)
                    } else {
                        auth.signOut()
                        toast = "This account does not have admin access." to ToastKind.Error
                        loading = false
                    }
                }
                is SignInResult.Failure -> {
                    toast = r.friendly to ToastKind.Error
                    loading = false
                }
            }
        }
    }

    // #955: through the `requestPasswordReset` callable, like admin web and Android.
    // A refusal carries its own sentence (the per-IP limit, a malformed address,
    // the network); it is never about whether the account exists.
    fun resetPassword() {
        if (loading || resetting) return
        val needsEmail = resetEmailFieldError(email)
        fieldErrors = SignInFieldErrors(email = needsEmail)
        if (needsEmail != null) {
            toast = null
            emailFocus.requestFocus()
            return
        }
        resetting = true
        toast = null
        scope.launch {
            try {
                toast = when (val r = auth.sendPasswordReset(email.trim())) {
                    is PasswordResetResult.Sent -> "Reset link sent. Check your inbox." to ToastKind.Success
                    is PasswordResetResult.Failed -> r.message to ToastKind.Error
                }
            } finally {
                resetting = false
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.background)
            .meshGradientBackground(c, pointer),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 420.dp)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            // Brand mark: large paw in glass circle
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.18f))
                    .border(2.dp, Color.White.copy(alpha = 0.45f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Lucide.PawPrint,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(40.dp),
                )
            }
            Text(
                text  = "AuntieOS",
                style = AuntieTheme.typography.headlineMedium,
                color = Color.White,
            )

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(20.dp))
                    .background(c.surfaceGlass)
                    .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(20.dp))
                    .padding(26.dp),
            ) { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                text  = "Welcome home, Auntie",
                style = AuntieTheme.typography.titleLarge,
                color = c.textPrimary,
            )
            Text(
                text  = "Sign in to keep the Kinfolk taken care of.",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textDim,
            )

            Spacer(Modifier.height(8.dp))

            BottomBorderField(
                value         = email,
                onValueChange = {
                    email = it
                    if (fieldErrors.email != null) fieldErrors = fieldErrors.copy(email = null)
                },
                label         = "Email",
                placeholder   = "you@auntieos.com",
                isError       = fieldErrors.email != null,
                keyboardType  = KeyboardType.Email,
                imeAction     = ImeAction.Next,
                // 02-sign-in items 2/3: one Tab (and soft-keyboard Next) advance
                // Email -> Password.
                fieldFocusRequester = emailFocus,
                nextFocusRequester  = passwordFocus,
                onImeAction         = { passwordFocus.requestFocus() },
            )
            SignInFieldErrorLine(fieldErrors.email)
            // Password field with in-field show / hide reveal toggle.
            // The mockup tagged a show/hide control as a SUGGESTION; the Den
            // AuntiePasswordField provides exactly that reveal affordance.
            AuntiePasswordField(
                value         = password,
                onValueChange = {
                    password = it
                    if (fieldErrors.password != null) fieldErrors = fieldErrors.copy(password = null)
                },
                label         = "Password",
                placeholder   = "••••••••",
                isError       = fieldErrors.password != null,
                imeAction     = ImeAction.Done,
                keyboardActions = KeyboardActions(onDone = { submit() }),
                fieldFocusRequester = passwordFocus,
                modifier      = Modifier.onPreviewKeyEvent { e ->
                    if (e.type == KeyEventType.KeyUp && e.key == Key.Enter) {
                        submit(); true
                    } else false
                },
            )
            SignInFieldErrorLine(fieldErrors.password)

            StatusToast(
                visible = toast != null,
                message = toast?.first.orEmpty(),
                kind    = toast?.second ?: ToastKind.Info,
                onDismiss = { toast = null },
            )

            Spacer(Modifier.height(4.dp))

            PrimaryButton(
                label    = if (loading) "Signing in…" else "Jump back in!",
                onClick  = ::submit,
                loading  = loading,
                modifier = Modifier.fillMaxWidth().height(48.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                GhostButton(
                    label   = if (resetting) "Sending…" else "Forgot password?",
                    onClick = ::resetPassword,
                    enabled = !loading && !resetting,
                )
            }
            } }  // close card Column + Box
        }
    }
}

/**
 * The line under a sign-in field. Always laid out at one line's height, empty
 * or not, so a refusal changes text and colour and never the form's height.
 */
@Composable
private fun SignInFieldErrorLine(message: String?) {
    Text(
        text = message.orEmpty(),
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.error,
        modifier = Modifier.fillMaxWidth().heightIn(min = 18.dp),
    )
}
