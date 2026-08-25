package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import com.tribetails.auntieos.ui.theme.AuntieTheme
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.SessionEndedNotice
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.PrimaryButton
import kotlinx.coroutines.launch

@Composable
fun AdminLoginScreen(
    repository: AuntieRepository,
    onLoginSuccess: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var email            by remember { mutableStateOf("") }
    var password         by remember { mutableStateOf("") }
    var showForgotPassword by remember { mutableStateOf(false) }
    var loading          by remember { mutableStateOf(false) }
    var error            by remember { mutableStateOf<String?>(null) }
    var resetStatus      by remember { mutableStateOf<String?>(null) }

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

    // 02-sign-in items 1/2: explicit Email -> Password traversal + autofill content types
    // so Google Password Manager can fill/save.
    val emailFocus    = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }

    fun submit() {
        if (loading) return
        if (email.isBlank() || password.isBlank()) {
            error = "Email and password are required."
            return
        }
        error = null
        resetStatus = null
        loading = true
        scope.launch {
            repository.signInAdmin(email, password)
                .onSuccess { onLoginSuccess() }
                .onFailure { error = it.message ?: "Sign-in failed." }
            loading = false
        }
    }

    AuntieScreenScaffold(title = "Admin Login", imePaddingEnabled = true) {
    Column(
        modifier              = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement   = Arrangement.Center,
        horizontalAlignment   = Alignment.CenterHorizontally
    ) {
        AuntieField(
            value           = email,
            onValueChange   = { email = it },
            label           = "Email",
            modifier        = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
            fieldModifier   = Modifier
                .focusRequester(emailFocus)
                .focusProperties { next = passwordFocus }
                .semantics { contentType = ContentType.EmailAddress + ContentType.Username },
        )
        Spacer(modifier = Modifier.height(16.dp))

        AuntieField(
            value                = password,
            onValueChange        = { password = it },
            label                = "Password",
            visualTransformation = PasswordVisualTransformation(),
            modifier             = Modifier.fillMaxWidth(),
            keyboardOptions      = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions      = KeyboardActions(onDone = { submit() }),
            fieldModifier        = Modifier
                .focusRequester(passwordFocus)
                .semantics { contentType = ContentType.Password },
        )
        Spacer(modifier = Modifier.height(24.dp))

        PrimaryButton(
            label    = "Login",
            onClick  = { submit() },
            modifier = Modifier.fillMaxWidth(),
            enabled  = !loading,
            loading  = loading,
        )

        AuntieTextBtn(onClick = { showForgotPassword = true }) {
            Text("Forgot Password?")
        }

        if (error != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(error!!, color = AuntieTheme.colors.error)
        }
        if (resetStatus != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(resetStatus!!, color = Color(0xFF2E7D32))
        }
    }
    }

    if (showForgotPassword) {
        AuntieModal(
            onDismissRequest = { showForgotPassword = false },
            title            = "Reset Password",
            confirmButton    = {
                AuntieTextBtn(
                    onClick = {
                        if (loading) return@AuntieTextBtn
                        error = null
                        loading = true
                        scope.launch {
                            repository.sendPasswordReset(email)
                                .onSuccess {
                                    resetStatus = "Password reset link sent."
                                    showForgotPassword = false
                                }
                                .onFailure { error = it.message ?: "Password reset failed." }
                            loading = false
                        }
                    }
                ) { Text("Send") }
            },
            dismissButton = {
                AuntieTextBtn(onClick = { showForgotPassword = false }) { Text("Cancel") }
            }
        ) {
            Text("Send a password reset link to the email entered on this screen.")
        }
    }
}
