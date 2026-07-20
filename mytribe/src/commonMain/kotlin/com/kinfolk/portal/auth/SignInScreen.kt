package com.kinfolk.portal.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pets
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.error.ErrorEnvelope
import com.kinfolk.portal.error.OpaqueErrorBanner
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.launch

/**
 * Tribe Tails sign-in. Foundation + Kin* primitives only — no M3 visual
 * components. Per `feedback_no_m3.md`: M3 kept ONLY for Text/Icon/DropdownMenu.
 *
 * `socialLinks` is caller-supplied so the screen doesn't fabricate URLs.
 * Default empty → social row hidden. Pass real URLs when known.
 */
@Composable
fun SignInScreen(
    repo: AuthRepository,
    onSignedIn: () -> Unit,
    socialLinks: SignInSocialLinks = SignInSocialLinks(),
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current

    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<ErrorEnvelope?>(null) }
    var inFlight by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf(false) }
    var resetSuccess by remember { mutableStateOf(false) }
    val state by repo.state.collectAsState()

    LaunchedEffect(state) {
        if (state is AuthState.SignedIn) onSignedIn()
    }

    fun submit() {
        if (inFlight) return
        if (email.isBlank() || password.isBlank()) {
            error = ErrorEnvelope.message("Email and password are required.")
            return
        }
        inFlight = true
        error = null
        scope.launch {
            try { repo.signInWithEmailPassword(email, password) }
            catch (t: Throwable) { error = ErrorEnvelope.opaque(t) }
            finally { inFlight = false }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(KinfolkGradients.tribe),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
        ) {
            // Brand mark — paw circle + "MyTribe" wordmark over the operating
            // business tagline. Bundled Material vector (like TabRoute's tab
            // icons) instead of an emoji glyph, which tofu-boxes on web.
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Box(
                    modifier = Modifier
                        .size(96.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.18f))
                        .border(2.dp, Color.White.copy(alpha = 0.45f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Pets,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(44.dp),
                    )
                }
                Text(
                    text = "MyTribe",
                    style = type.heritageTitle.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    text = "by Tribe Tails Pet Care",
                    style = type.sansMeta.copy(color = Color.White.copy(alpha = 0.88f)),
                )
            }

            // Card: email + password + reset + submit
            GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                    Text(
                        text = "Welcome back to your Tribe!",
                        style = type.heritageTitle,
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Center,
                    )
                    KinField(
                        value = email,
                        onValueChange = { email = it },
                        label = "Email Address",
                    )
                    val passwordKeyModifier = Modifier.onPreviewKeyEvent { e ->
                        if (e.type == KeyEventType.KeyUp && e.key == Key.Enter) {
                            submit(); true
                        } else false
                    }
                    // Password is always masked. The show/hide eye affordance
                    // (mockup .pwtoggle) lets the user reveal the field on tap.
                    PasswordField(
                        value = password,
                        onValueChange = { password = it },
                        label = "Password",
                        visible = passwordVisible,
                        onToggleVisible = { passwordVisible = !passwordVisible },
                        showToggle = true,
                        modifier = passwordKeyModifier,
                    )
                    // Forgot-password link — subdued, inline, not a pill CTA.
                    Text(
                        text = if (resetting) "Sending reset link…" else "Forgot password?",
                        style = type.sansMeta.copy(
                            color = if (resetting) c.navyMuted else c.primary,
                            textDecoration = if (resetting) TextDecoration.None else TextDecoration.Underline,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !resetting && !inFlight) {
                                resetSuccess = false
                                if (email.isBlank()) {
                                    error = ErrorEnvelope.message("Type your email above first.")
                                    return@clickable
                                }
                                resetting = true
                                error = null
                                scope.launch {
                                    try {
                                        repo.sendPasswordReset(email)
                                        resetSuccess = true
                                    } catch (t: Throwable) {
                                        error = ErrorEnvelope.message("Couldn't send reset email.")
                                    } finally {
                                        resetting = false
                                    }
                                }
                            },
                        textAlign = TextAlign.Center,
                    )
                    if (resetSuccess) {
                        Text(
                            text = "Reset link sent. Check your inbox.",
                            style = type.sansMeta.copy(color = c.primary),
                            modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center,
                        )
                    }

                    // Submit — gradient pill matching mockup. Always clickable so an
                    // empty submit yields a visible banner, never a silent dead
                    // button (per fail-loud policy). Enter key on password field
                    // also triggers submit via onPreviewKeyEvent above.
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(KinfolkShapes.pill)
                            .background(
                                if (inFlight) KinfolkGradients.orangeToPinkDim
                                else KinfolkGradients.orangeToPink
                            )
                            .clickable(enabled = !inFlight) { submit() }
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (inFlight) "Signing in…" else "Jump back in!",
                            style = type.sansButton.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
                        )
                    }

                    error?.let { OpaqueErrorBanner(it, onDismiss = { error = null }) }

                    // Social row — rendered only when caller provides URLs (fail-loud:
                    // no fake links, no dead clicks)
                    if (socialLinks.hasAny()) {
                        Spacer(Modifier.height(KinfolkSpacing.s))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(c.navyHairline),
                        )
                        Spacer(Modifier.height(KinfolkSpacing.s))
                        Text(
                            text = "FIND THE REST OF THE KINFOLK HERE…",
                            style = type.sansMeta.copy(color = c.navyMuted, fontWeight = FontWeight.SemiBold),
                            modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center,
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m, alignment = Alignment.CenterHorizontally),
                        ) {
                            socialLinks.instagram?.let { SocialIcon("📷", url = it, uri = uriHandler) }
                            socialLinks.facebook?.let { SocialIcon("ƒ", url = it, uri = uriHandler) }
                            socialLinks.chat?.let { SocialIcon("💬", url = it, uri = uriHandler) }
                            socialLinks.community?.let { SocialIcon("❤", url = it, uri = uriHandler) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Password field (mockup .pwtoggle, lines 273-281). Foundation-only to match
 * [KinField]: a top label, a [BasicTextField] that masks with
 * [PasswordVisualTransformation], and a bottom hairline that glows orange on focus.
 * The password is ALWAYS masked; [showToggle] controls whether the tappable eye
 * affordance (which reveals the value while [visible]) is shown. With [showToggle]
 * off the field stays masked and no reveal control renders.
 */
@Composable
private fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    visible: Boolean,
    onToggleVisible: () -> Unit,
    showToggle: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val revealed = visible && showToggle
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()

    Column(modifier = modifier) {
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
                visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = Modifier.weight(1f),
            )
            // Eye affordance: taps flip the reveal for this field only. Only shown
            // when the show-password flag is on; the field is masked regardless.
            if (showToggle) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clickable(onClick = onToggleVisible),
                    contentAlignment = Alignment.Center,
                ) {
                    // Bundled Material vector, not an emoji glyph (tofu on web).
                    Icon(
                        imageVector = if (revealed) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (revealed) "Hide password" else "Show password",
                        tint = c.navyMuted,
                        modifier = Modifier.size(20.dp),
                    )
                }
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
private fun SocialIcon(glyph: String, url: String, uri: androidx.compose.ui.platform.UriHandler) {
    val c = KinfolkTheme.colors
    Box(
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(c.glassSurface)
            .border(1.dp, c.glassBorder, CircleShape)
            .clickable { uri.openUri(url) },
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = KinfolkTheme.typography.sansBody.copy(color = c.primary))
    }
}

/**
 * Caller-supplied social link map. Pass non-null URLs for icons that should
 * render + be clickable. Per `feedback_no_assumptions.md`, do not invent URLs.
 */
data class SignInSocialLinks(
    val instagram: String? = null,
    val facebook: String? = null,
    val chat: String? = null,
    val community: String? = null,
) {
    fun hasAny(): Boolean = listOf(instagram, facebook, chat, community).any { !it.isNullOrBlank() }
}
