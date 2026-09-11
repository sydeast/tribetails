package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
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
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.SessionEndedNotice
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntiePasswordField
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.theme.BrandCream
import kotlinx.coroutines.launch

/**
 * The copy on this screen is the mock's (`ui-ideas/auntieos-sign-in-2026-05-27.html`),
 * which reproduces the wasm SignInScreen.kt verbatim. The web screen carries
 * the same strings; the admin gate line comes up from the repository so the
 * three read as one.
 */
private const val MISSING_MSG = "Email and password are required."
private const val RESET_NEEDS_EMAIL_MSG = "Type your email above first."
private const val RESET_SENT_MSG = "Reset link sent. Check your inbox."

/**
 * Sign in, laid out as the mock draws it (#755): the paw mark in a glass disc,
 * the wordmark, then one glass card holding the greeting, two bottom-rule
 * fields, the full-width primary and a ghost at the right. No top bar: the
 * scaffold is here for the mesh ground and the IME inset only.
 */
@Composable
fun AdminLoginScreen(
    repository: AuntieRepository,
    onLoginSuccess: () -> Unit
) {
    val scope = rememberCoroutineScope()
    val c = AuntieTheme.colors
    var email       by remember { mutableStateOf("") }
    var password    by remember { mutableStateOf("") }
    var loading     by remember { mutableStateOf(false) }
    var resetting   by remember { mutableStateOf(false) }
    var error       by remember { mutableStateOf<String?>(null) }
    var resetSent   by remember { mutableStateOf(false) }

    /**
     * Issue #573: why the operator is looking at this screen, when they did not
     * ask to be.
     *
     * A revoked or disabled session is signed out from inside the callable seam
     * (`awaitCallable`), several layers below anything holding UI state, and
     * `AuntieNavHost` then drops the whole app back here on its own because
     * `authStateFlow()` went null. Without this the console simply vanishes
     * mid-task and a login form appears, which reads as the app having broken
     * rather than as a session having ended.
     *
     * `consume()` clears as it reads, so a recomposition or a later visit to
     * this screen is quiet. Keyed on `Unit`, because the notice belongs to the
     * arrival and not to anything the operator types afterwards.
     */
    LaunchedEffect(Unit) {
        SessionEndedNotice.consume()?.let { error = it }
    }

    fun submit() {
        if (loading || resetting) return
        if (email.isBlank() || password.isBlank()) {
            error = MISSING_MSG
            return
        }
        error = null
        resetSent = false
        loading = true
        scope.launch {
            repository.signInAdmin(email, password)
                .onSuccess { onLoginSuccess() }
                .onFailure { error = it.message ?: "Sign-in failed." }
            loading = false
        }
    }

    // The mock's ghost control sends the reset straight away, to the email
    // typed above, with no confirm step. The web screen and the wasm one do the
    // same, so the modal this used to open is gone.
    fun resetPassword() {
        if (loading || resetting) return
        if (email.isBlank()) {
            error = RESET_NEEDS_EMAIL_MSG
            return
        }
        error = null
        resetSent = false
        resetting = true
        scope.launch {
            repository.sendPasswordReset(email)
                .onSuccess { resetSent = true }
                .onFailure { error = it.message ?: "Couldn't send reset email." }
            resetting = false
        }
    }

    AuntieScreenScaffold(imePaddingEnabled = true) {
        // Centred while the stage fits, scrollable once the keyboard leaves
        // less room than the stage needs: the scroll column is held to at
        // least the viewport height so Arrangement.Center still has a height
        // to centre within.
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .padding(horizontal = 20.dp, vertical = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(
                    modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    // Brand mark: the paw in a 96dp glass disc. Cream at 16% and 42%
                    // is the mock's white on the navy, through the brand constant
                    // rather than a literal.
                    Box(
                        modifier = Modifier
                            .size(96.dp)
                            .clip(CircleShape)
                            .background(BrandCream.copy(alpha = 0.16f))
                            .border(2.dp, BrandCream.copy(alpha = 0.42f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Lucide.PawPrint,
                            contentDescription = null,
                            tint = BrandCream,
                            modifier = Modifier.size(42.dp),
                        )
                    }
                    Text(
                        text = "AuntieOS",
                        style = AuntieTheme.typography.displayMedium,
                        color = BrandCream,
                    )

                    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(start = 26.dp, top = 26.dp, end = 26.dp, bottom = 22.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                // 24 is the mock's card heading, a step under the
                                // hero band's 28 and between two ramp sizes.
                                Text(
                                    text = "Welcome home, Auntie",
                                    style = AuntieTheme.typography.headlineLarge.copy(fontSize = 24.sp),
                                    color = c.textPrimary,
                                )
                                Text(
                                    text = "Sign in to keep the Kinfolk taken care of.",
                                    style = AuntieTheme.typography.bodyMedium,
                                    color = c.textDim,
                                )
                            }

                            // One line each, no title: the mock's toasts carry only
                            // the message and the tone does the rest.
                            error?.let { message ->
                                AuntieBanner(tone = AuntieBannerTone.Error) {
                                    Text(message, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                                }
                            }
                            if (resetSent) {
                                AuntieBanner(tone = AuntieBannerTone.Info) {
                                    Text(RESET_SENT_MSG, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                                }
                            }

                            // Autofill content types so Google Password Manager can
                            // fill and save. Email -> Password traversal is the
                            // platform's own ImeAction.Next behaviour, which moves
                            // focus to the next focusable, and the password input is
                            // the next one in layout order.
                            BottomBorderField(
                                value         = email,
                                onValueChange = { email = it },
                                label         = "Email",
                                placeholder   = "you@auntieos.com",
                                modifier      = Modifier.fillMaxWidth(),
                                keyboardType  = KeyboardType.Email,
                                imeAction     = ImeAction.Next,
                                fieldModifier = Modifier.semantics {
                                    contentType = ContentType.EmailAddress + ContentType.Username
                                },
                            )
                            AuntiePasswordField(
                                value           = password,
                                onValueChange   = { password = it },
                                label           = "Password",
                                placeholder     = "••••••••",
                                modifier        = Modifier.fillMaxWidth(),
                                imeAction       = ImeAction.Done,
                                keyboardActions = KeyboardActions(onDone = { submit() }),
                                fieldModifier   = Modifier.semantics { contentType = ContentType.Password },
                            )

                            Spacer(Modifier.height(2.dp))

                            PrimaryButton(
                                label    = if (loading) "Signing in..." else "Jump back in!",
                                onClick  = { submit() },
                                modifier = Modifier.fillMaxWidth().height(48.dp),
                                enabled  = !loading && !resetting,
                                loading  = loading,
                            )

                            // The mock's ghost is bare text at the right, dim until
                            // pressed, so it is the text control rather than the
                            // filled GhostButton.
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.End,
                            ) {
                                AuntieTextBtn(
                                    onClick      = { resetPassword() },
                                    enabled      = !loading && !resetting,
                                    contentColor = c.textDim,
                                ) {
                                    Text(
                                        text  = if (resetting) "Sending..." else "Forgot password?",
                                        style = AuntieTheme.typography.titleSmall,
                                        color = c.textDim,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
