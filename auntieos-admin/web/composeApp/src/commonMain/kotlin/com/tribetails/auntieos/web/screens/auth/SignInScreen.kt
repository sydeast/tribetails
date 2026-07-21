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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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

    // 02-sign-in item 1: mount the hidden autofill <form> while this screen is shown so
    // a password manager can offer to fill; route fills back into Compose state. No-op
    // on desktop. Keep the DOM inputs in sync as the user types in the canvas fields.
    DisposableEffect(Unit) {
        platformMountSignInAutofill { e, p -> email = e; password = p }
        onDispose { platformUnmountSignInAutofill() }
    }
    LaunchedEffect(email, password) { platformSetSignInAutofillValues(email, password) }

    fun submit() {
        if (email.isBlank() || password.isBlank()) {
            toast = "Email and password are required." to ToastKind.Error
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

    fun resetPassword() {
        if (email.isBlank()) {
            toast = "Type your email above first." to ToastKind.Error
            return
        }
        resetting = true
        scope.launch {
            val ok = auth.sendPasswordReset(email.trim())
            toast = (if (ok) "Reset link sent. Check your inbox." else "Couldn't send reset email.") to
                    (if (ok) ToastKind.Success else ToastKind.Error)
            resetting = false
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
                onValueChange = { email = it },
                label         = "Email",
                placeholder   = "you@auntieos.com",
                keyboardType  = KeyboardType.Email,
                imeAction     = ImeAction.Next,
                // 02-sign-in items 2/3: one Tab (and soft-keyboard Next) advance
                // Email -> Password.
                fieldFocusRequester = emailFocus,
                nextFocusRequester  = passwordFocus,
                onImeAction         = { passwordFocus.requestFocus() },
            )
            // Password field with in-field show / hide reveal toggle.
            // The mockup tagged a show/hide control as a SUGGESTION; the Den
            // AuntiePasswordField provides exactly that reveal affordance.
            AuntiePasswordField(
                value         = password,
                onValueChange = { password = it },
                label         = "Password",
                placeholder   = "••••••••",
                imeAction     = ImeAction.Done,
                fieldFocusRequester = passwordFocus,
                modifier      = Modifier.onPreviewKeyEvent { e ->
                    if (e.type == KeyEventType.KeyUp && e.key == Key.Enter) {
                        submit(); true
                    } else false
                },
            )

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
                    enabled = !resetting,
                )
            }
            } }  // close card Column + Box
        }
    }
}
